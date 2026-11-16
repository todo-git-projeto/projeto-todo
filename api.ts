import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  Delete,
  DynamicModule,
  ExecutionContext,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  INestApplication,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  Db,
  LogEvent,
  logEvent,
  PaginatedRecords,
  RECORD_SORT_FIELDS,
  RecordFilters,
  RecordInput,
  RecordRow,
  verifyPassword,
} from './db';

const TOKEN_TTL_SECONDS = 3600;

/** Quem pode usar o token: o login da Web ou o token da CLI. */
export type TokenAudience = 'web' | 'cli';
const VALID_PRIORITIES = ['baixa', 'media', 'alta'] as const;

export interface AppConfig {
  port: number;
  dbPath: string;
  user: string;
  password: string;
  secret: string;
}

/** Lê a configuração das variáveis de ambiente (os padrões servem só para desenvolvimento). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/app.db',
    user: env.APP_USER ?? 'admin',
    password: env.APP_PASSWORD ?? 'admin123',
    secret: env.TOKEN_SECRET ?? randomBytes(32).toString('hex'),
  };
}

export interface WebRequest {
  requestId: string;
  user?: string;
  headers: Record<string, string | undefined>;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function apiLog(
  requestId: string,
  level: LogEvent['level'],
  operation: string,
  status: LogEvent['status'],
  message: string,
  client: LogEvent['client'] = 'web',
): void {
  logEvent({ level, layer: 'api', client, operation, status, request_id: requestId, message });
}

/** Valida os campos do formulário/corpo da requisição de cadastro e edição de registros. */
export function validateRecordInput(body: unknown): {
  valid: boolean;
  errors: string[];
  data?: RecordInput;
} {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Corpo da requisição deve ser um objeto JSON'] };
  }

  const raw = body as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const category = typeof raw.category === 'string' ? raw.category.trim() : '';
  const priority = typeof raw.priority === 'string' ? raw.priority.trim().toLowerCase() : '';
  const dueDateRaw = raw.due_date;

  // 1. Título (obrigatório, 3-100 caracteres)
  if (!title) {
    errors.push('Título é obrigatório');
  } else if (title.length < 3 || title.length > 100) {
    errors.push('Título deve ter entre 3 e 100 caracteres');
  }

  // 2. Descrição (obrigatória, 3-500 caracteres)
  if (!description) {
    errors.push('Descrição é obrigatória');
  } else if (description.length < 3 || description.length > 500) {
    errors.push('Descrição deve ter entre 3 e 500 caracteres');
  }

  // 3. Categoria (obrigatória, 2-50 caracteres)
  if (!category) {
    errors.push('Categoria é obrigatória');
  } else if (category.length < 2 || category.length > 50) {
    errors.push('Categoria deve ter entre 2 e 50 caracteres');
  }

  // 4. Prioridade (obrigatória, baixa | media | alta)
  if (!priority) {
    errors.push('Prioridade é obrigatória');
  } else if (!VALID_PRIORITIES.includes(priority as (typeof VALID_PRIORITIES)[number])) {
    errors.push('Prioridade deve ser baixa, media ou alta');
  }

  // 5. Data de vencimento (opcional; se informada deve ter formato YYYY-MM-DD válido)
  let cleanDueDate: string | null = null;
  if (dueDateRaw !== undefined && dueDateRaw !== null && String(dueDateRaw).trim() !== '') {
    const dateStr = String(dueDateRaw).trim();
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateStr) || isNaN(Date.parse(dateStr))) {
      errors.push('Data de vencimento deve estar no formato AAAA-MM-DD');
    } else {
      cleanDueDate = dateStr;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    data: {
      title,
      description,
      category,
      priority,
      due_date: cleanDueDate,
    },
  };
}

/** Confere formato AAAA-MM-DD e se a data existe no calendário (rejeita, por exemplo, 2026-02-31). */
function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Issue #4: valida e normaliza os filtros da busca avançada (query string). Filtro vazio equivale a ausente. */
export function validateSearchFilters(query: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
  filters: RecordFilters;
} {
  const errors: string[] = [];
  const filters: RecordFilters = {};

  const read = (name: string): string => {
    const value = query[name];
    if (value === undefined) return '';
    if (typeof value !== 'string') {
      errors.push(`Filtro ${name} deve ser informado uma única vez`);
      return '';
    }
    return value.trim();
  };

  const q = read('q');
  if (q.length > 100) errors.push('Texto da busca deve ter no máximo 100 caracteres');
  else if (q) filters.q = q;

  const category = read('category');
  if (category.length > 50) errors.push('Categoria deve ter no máximo 50 caracteres');
  else if (category) filters.category = category;

  const priority = read('priority').toLowerCase();
  if (priority && !VALID_PRIORITIES.includes(priority as (typeof VALID_PRIORITIES)[number])) {
    errors.push('Prioridade deve ser baixa, media ou alta');
  } else if (priority) filters.priority = priority;

  for (const name of ['due_from', 'due_to'] as const) {
    const date = read(name);
    if (date && !isRealDate(date)) errors.push(`Filtro ${name} deve ser uma data válida no formato AAAA-MM-DD`);
    else if (date) filters[name] = date;
  }
  if (filters.due_from && filters.due_to && filters.due_from > filters.due_to) {
    errors.push('Prazo inicial não pode ser posterior ao prazo final');
  }

  return { valid: errors.length === 0, errors, filters };
}

/**
 * Issue #9: valida e normaliza os parâmetros da listagem da CLI (page, limit, sort, order).
 * Parâmetro ausente ou vazio usa o padrão; valor inválido gera erro (a CLI mostra o motivo).
 */
export function parseCliListOptions(query: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
  options: { page: number; limit: number; sort: string; order: string };
} {
  const errors: string[] = [];

  const read = (name: string): string | undefined => {
    const value = query[name];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') {
      errors.push(`Parâmetro ${name} deve ser informado uma única vez`);
      return undefined;
    }
    return value.trim();
  };

  const toInteger = (name: string, label: string, fallback: number, max?: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < 1 || (max !== undefined && value > max)) {
      errors.push(
        max === undefined
          ? `${label} deve ser um número inteiro maior que zero`
          : `${label} deve ser um número inteiro de 1 a ${max}`,
      );
      return fallback;
    }
    return value;
  };

  const page = toInteger('page', 'Página', 1);
  const limit = toInteger('limit', 'Limite', 5, 100);

  let sort = 'id';
  const rawSort = read('sort');
  if (rawSort !== undefined) {
    if ((RECORD_SORT_FIELDS as readonly string[]).includes(rawSort)) sort = rawSort;
    else errors.push(`Ordenação deve ser um destes campos: ${RECORD_SORT_FIELDS.join(', ')}`);
  }

  let order = 'desc';
  const rawOrder = read('order')?.toLowerCase();
  if (rawOrder !== undefined) {
    if (rawOrder === 'asc' || rawOrder === 'desc') order = rawOrder;
    else errors.push('Direção da ordenação deve ser asc ou desc');
  }

  return { valid: errors.length === 0, errors, options: { page, limit, sort, order } };
}


/** Issue #5: formata valor individual para campo CSV seguindo a RFC 4180. */
export function formatCsvField(val: unknown): string {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  return `"${str.replace(/"/g, '""')}"`;
}

/** Issue #5: converte lista de tarefas em conteúdo CSV no padrão RFC 4180. */
export function formatRecordsCsv(records: RecordRow[]): string {
  const headers = ['id', 'title', 'description', 'category', 'priority', 'due_date', 'created_at', 'updated_at'];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push([
      r.id,
      formatCsvField(r.title),
      formatCsvField(r.description),
      formatCsvField(r.category),
      formatCsvField(r.priority),
      r.due_date ? formatCsvField(r.due_date) : '""',
      formatCsvField(r.created_at),
      formatCsvField(r.updated_at),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Gera um request_id por requisição; o mesmo valor é repassado ao banco para correlacionar os logs. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: WebRequest, res: { setHeader(name: string, value: string): void }, next: () => void): void {
    req.requestId = randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  }
}

@Injectable()
export class AuthService {
  constructor(
    @Inject('DB') private readonly db: Db,
    @Inject('TOKEN_SECRET') private readonly secret: string,
  ) {}

  /**
   * Token assinado (HMAC-SHA256) no formato `payload.assinatura`, com expiração.
   * O campo `aud` separa os tokens da Web e da CLI: um não vale no endpoint do outro.
   */
  sign(username: string, ttlSeconds = TOKEN_TTL_SECONDS, audience: TokenAudience = 'web'): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ sub: username, exp, aud: audience })).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  /** Retorna o usuário dono do token, ou null se o token for inválido, expirado ou de outro cliente. */
  verify(token: string, audience: TokenAudience = 'web'): string | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.signature(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const { sub, exp, aud } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if ((aud ?? 'web') !== audience) return null;
    return exp > Math.floor(Date.now() / 1000) ? sub : null;
  }

  login(username: unknown, password: unknown, requestId: string): { token: string; username: string } {
    const user = this.db.findUserByUsername(String(username), requestId, 'web');
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      apiLog(requestId, 'WARN', 'login', 'error', 'Falha de autenticação: credenciais inválidas');
      throw new UnauthorizedException('Usuário ou senha inválidos');
    }
    apiLog(requestId, 'INFO', 'login', 'success', 'Login realizado com sucesso');
    return { token: this.sign(user.username), username: user.username };
  }

  /** Issue #7: emite o token Bearer da CLI (POST /api/cli/token), com consulta e logs próprios da CLI. */
  issueCliToken(username: unknown, password: unknown, requestId: string): { token: string; username: string } {
    const user = this.db.findCliUser(String(username), requestId);
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      apiLog(requestId, 'WARN', 'token', 'error', 'Falha de autenticação: credenciais inválidas', 'cli');
      throw new UnauthorizedException('Usuário ou senha inválidos');
    }
    apiLog(requestId, 'INFO', 'token', 'success', 'Token da CLI emitido', 'cli');
    return { token: this.sign(user.username, TOKEN_TTL_SECONDS, 'cli'), username: user.username };
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

/** Protege rotas: exige `Authorization: Bearer <token>`; caso contrário responde 401. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<WebRequest>();
    const header = req.headers['authorization'] ?? '';
    const user = this.auth.verify(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!user) {
      apiLog(req.requestId, 'WARN', 'authenticate', 'error', 'Falha de autenticação: token ausente ou inválido');
      throw new UnauthorizedException();
    }
    req.user = user;
    return true;
  }
}

/** Protege as rotas da CLI: exige `Authorization: Bearer <token da CLI>`; caso contrário responde 401. */
@Injectable()
export class CliAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<WebRequest>();
    const header = req.headers['authorization'] ?? '';
    const user = this.auth.verify(header.startsWith('Bearer ') ? header.slice(7) : '', 'cli');
    if (!user) {
      apiLog(
        req.requestId,
        'WARN',
        'authenticate',
        'error',
        'Falha de autenticação: token ausente ou inválido',
        'cli',
      );
      throw new UnauthorizedException();
    }
    req.user = user;
    return true;
  }
}

@Controller('api/web')
export class WebController {
  constructor(
    private readonly auth: AuthService,
    @Inject('DB') private readonly db: Db,
  ) {}

  @Get('health')
  health(@Req() req: WebRequest): { status: string } {
    apiLog(req.requestId, 'INFO', 'health', 'success', 'Healthcheck respondeu');
    return { status: 'ok' };
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginBody, @Req() req: WebRequest): { token: string; username: string } {
    return this.auth.login(body.username, body.password, req.requestId);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: WebRequest): { username: string } {
    apiLog(req.requestId, 'INFO', 'me', 'success', 'Sessão validada');
    return { username: req.user as string };
  }

  /** Issue #2: Cadastro de novo registro via Web (POST /api/web/records). */
  @Post('records')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AuthGuard)
  createRecord(@Body() body: unknown, @Req() req: WebRequest): RecordRow {
    const validation = validateRecordInput(body);
    if (!validation.valid || !validation.data) {
      apiLog(req.requestId, 'WARN', 'create_record', 'error', 'Falha de validação ao criar registro');
      throw new BadRequestException({ message: 'Dados inválidos', errors: validation.errors });
    }

    const record = this.db.createRecord(validation.data, req.requestId, 'web');
    apiLog(req.requestId, 'INFO', 'create_record', 'success', `Registro ${record.id} criado com sucesso`);
    return record;
  }

  /** Issue #2: Edição de registro existente via Web (PUT /api/web/records/{id}). */
  @Put('records/:id')
  @UseGuards(AuthGuard)
  updateRecord(
    @Param('id') idParam: string,
    @Body() body: unknown,
    @Req() req: WebRequest,
  ): RecordRow {
    const id = Number(idParam);
    if (isNaN(id) || id <= 0) {
      apiLog(req.requestId, 'WARN', 'update_record', 'error', 'ID de registro inválido');
      throw new BadRequestException('ID de registro deve ser um número positivo');
    }

    const validation = validateRecordInput(body);
    if (!validation.valid || !validation.data) {
      apiLog(req.requestId, 'WARN', 'update_record', 'error', 'Falha de validação ao atualizar registro');
      throw new BadRequestException({ message: 'Dados inválidos', errors: validation.errors });
    }

    const updated = this.db.updateRecord(id, validation.data, req.requestId, 'web');
    if (!updated) {
      apiLog(req.requestId, 'WARN', 'update_record', 'error', `Registro ${id} não encontrado`);
      throw new NotFoundException(`Registro ${id} não encontrado`);
    }

    apiLog(req.requestId, 'INFO', 'update_record', 'success', `Registro ${id} atualizado com sucesso`);
    return updated;
  }

  /**
   * Issue #4: busca avançada (GET /api/web/records/search). Declarada ANTES de `records/:id`,
   * senão o Nest trataria "search" como um id.
   */
  @Get('records/search')
  @UseGuards(AuthGuard)
  searchRecords(@Query() query: Record<string, unknown>, @Req() req: WebRequest): PaginatedRecords {
    const validation = validateSearchFilters(query);
    if (!validation.valid) {
      apiLog(req.requestId, 'WARN', 'search_records', 'error', 'Filtros de busca inválidos');
      throw new BadRequestException({ message: 'Filtros inválidos', errors: validation.errors });
    }

    const result = this.db.searchRecords(
      validation.filters,
      {
        page: Number(query.page),
        limit: Number(query.limit),
        sort: typeof query.sort === 'string' ? query.sort : undefined,
        order: typeof query.order === 'string' ? query.order : undefined,
      },
      req.requestId,
      'web',
    );
    apiLog(
      req.requestId,
      'INFO',
      'search_records',
      'success',
      `Busca retornou ${result.items.length} registro(s) de ${result.total}`,
    );
    return result;
  }


  /**
   * Issue #5: exportação de registros em CSV (GET /api/web/records/export).
   * Declarada antes de `records/:id` para não ser interpretada como id.
   * Exporta todos os resultados filtrados (ou todos sem filtros), não limitada à página atual.
   */
  @Get('records/export')
  @UseGuards(AuthGuard)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="tarefas.csv"')
  exportRecordsCsv(@Query() query: Record<string, unknown>, @Req() req: WebRequest): string {
    const validation = validateSearchFilters(query);
    if (!validation.valid) {
      apiLog(req.requestId, 'WARN', 'export_csv', 'error', 'Filtros de busca inválidos para exportação CSV');
      throw new BadRequestException({ message: 'Filtros inválidos', errors: validation.errors });
    }

    const records = this.db.exportRecordsCsv(validation.filters, req.requestId, 'web');
    const csv = formatRecordsCsv(records);
    apiLog(
      req.requestId,
      'INFO',
      'export_csv',
      'success',
      `Exportação CSV gerada com ${records.length} registro(s)`,
    );
    return csv;
  }

  /** Consulta de registro específico por id (suporte ao formulário de edição). */
  @Get('records/:id')
  @UseGuards(AuthGuard)
  getRecord(@Param('id') idParam: string, @Req() req: WebRequest): RecordRow {
    const id = Number(idParam);
    if (isNaN(id) || id <= 0) {
      apiLog(req.requestId, 'WARN', 'select_record', 'error', 'ID de registro inválido');
      throw new BadRequestException('ID de registro deve ser um número positivo');
    }

    const record = this.db.findRecordById(id, req.requestId, 'web');
    if (!record) {
      apiLog(req.requestId, 'WARN', 'select_record', 'error', `Registro ${id} não encontrado`);
      throw new NotFoundException(`Registro ${id} não encontrado`);
    }

    apiLog(req.requestId, 'INFO', 'select_record', 'success', `Registro ${id} consultado`);
    return record;
  }

  /** Issue #3: Listagem paginada e ordenada com 5 itens por página para a Web (GET /api/web/records). */
  @Get('records')
  @UseGuards(AuthGuard)
  listRecords(
    @Query('page') pageParam: string | undefined,
    @Query('limit') limitParam: string | undefined,
    @Query('sort') sortParam: string | undefined,
    @Query('order') orderParam: string | undefined,
    @Req() req: WebRequest,
  ): PaginatedRecords {
    const result = this.db.listRecordsPaginated(
      {
        page: pageParam ? Number(pageParam) : 1,
        limit: limitParam ? Number(limitParam) : 5,
        sort: sortParam,
        order: orderParam,
      },
      req.requestId,
      'web',
    );
    apiLog(req.requestId, 'INFO', 'list_records', 'success', `${result.items.length} registro(s) consultado(s)`);
    return result;
  }

  /** Issue #3: Exclusão de registro via Web (DELETE /api/web/records/{id}). */
  @Delete('records/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  deleteRecord(@Param('id') idParam: string, @Req() req: WebRequest): { message: string; id: number } {
    const id = Number(idParam);
    if (isNaN(id) || id <= 0) {
      apiLog(req.requestId, 'WARN', 'delete_record', 'error', 'ID de registro inválido');
      throw new BadRequestException('ID de registro deve ser um número positivo');
    }

    const deleted = this.db.deleteRecord(id, req.requestId, 'web');
    if (!deleted) {
      apiLog(req.requestId, 'WARN', 'delete_record', 'error', `Registro ${id} não encontrado`);
      throw new NotFoundException(`Registro ${id} não encontrado`);
    }

    apiLog(req.requestId, 'INFO', 'delete_record', 'success', `Registro ${id} excluído com sucesso`);
    return { message: 'Registro excluído com sucesso', id };
  }
}

/** Issue #7 e #8: endpoints exclusivos da CLI (`/api/cli/*`), separados dos endpoints da Web. */
@Controller('api/cli')
export class CliController {
  constructor(
    private readonly auth: AuthService,
    @Inject('DB') private readonly db: Db,
  ) {}

  @Get('health')
  health(@Req() req: WebRequest): { status: string } {
    apiLog(req.requestId, 'INFO', 'health', 'success', 'Healthcheck da CLI respondeu', 'cli');
    return { status: 'ok' };
  }

  @Post('token')
  @HttpCode(200)
  token(@Body() body: LoginBody, @Req() req: WebRequest): { token: string; username: string } {
    return this.auth.issueCliToken(body?.username, body?.password, req.requestId);
  }

  @Get('me')
  @UseGuards(CliAuthGuard)
  me(@Req() req: WebRequest): { username: string } {
    apiLog(req.requestId, 'INFO', 'me', 'success', 'Sessão da CLI validada', 'cli');
    return { username: req.user as string };
  }

  /** Issue #8: Cadastro de novo registro via CLI. */
  @Post('records')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(CliAuthGuard)
  createRecord(@Body() body: unknown, @Req() req: WebRequest): RecordRow {
    const validation = validateRecordInput(body);

    if (!validation.valid || !validation.data) {
      apiLog(req.requestId, 'WARN', 'create_record', 'error', 'Falha de validação ao criar registro', 'cli');
      throw new BadRequestException({ message: 'Dados inválidos', errors: validation.errors });
    }

    const record = this.db.createRecord(validation.data, req.requestId, 'cli');

    apiLog(req.requestId, 'INFO', 'create_record', 'success', `Registro ${record.id} criado com sucesso`, 'cli');

    return record;
  }

  /** Issue #8: Edição de registro existente via CLI. */
  @Put('records/:id')
  @UseGuards(CliAuthGuard)
  updateRecord(
    @Param('id') idParam: string,
    @Body() body: unknown,
    @Req() req: WebRequest,
  ): RecordRow {
    const id = Number(idParam);

    if (isNaN(id) || id <= 0) {
      apiLog(req.requestId, 'WARN', 'update_record', 'error', 'ID de registro inválido', 'cli');
      throw new BadRequestException('ID de registro deve ser um número positivo');
    }

    const validation = validateRecordInput(body);

    if (!validation.valid || !validation.data) {
      apiLog(req.requestId, 'WARN', 'update_record', 'error', 'Falha de validação ao atualizar registro', 'cli');
      throw new BadRequestException({ message: 'Dados inválidos', errors: validation.errors });
    }

    const updated = this.db.updateRecord(id, validation.data, req.requestId, 'cli');

    if (!updated) {
      apiLog(req.requestId, 'WARN', 'update_record', 'error', `Registro ${id} não encontrado`, 'cli');
      throw new NotFoundException(`Registro ${id} não encontrado`);
    }

    apiLog(req.requestId, 'INFO', 'update_record', 'success', `Registro ${id} atualizado com sucesso`, 'cli');

    return updated;
  }

  /** Issue #9: listagem paginada e ordenada via CLI (GET /api/cli/records), com consulta própria da CLI. */
  @Get('records')
  @UseGuards(CliAuthGuard)
  listRecords(@Query() query: Record<string, unknown>, @Req() req: WebRequest): PaginatedRecords {
    const parsed = parseCliListOptions(query);

    if (!parsed.valid) {
      apiLog(req.requestId, 'WARN', 'list_records', 'error', 'Parâmetros de listagem inválidos', 'cli');
      throw new BadRequestException({ message: 'Parâmetros inválidos', errors: parsed.errors });
    }

    const result = this.db.listCliRecords(parsed.options, req.requestId);

    apiLog(
      req.requestId,
      'INFO',
      'list_records',
      'success',
      `Listagem retornou ${result.items.length} registro(s) de ${result.total}`,
      'cli',
    );

    return result;
  }

  /** Issue #9: exclusão por identificador via CLI (DELETE /api/cli/records/{id}). */
  @Delete('records/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CliAuthGuard)
  deleteRecord(@Param('id') idParam: string, @Req() req: WebRequest): { message: string; id: number } {
    const id = Number(idParam);

    if (!Number.isInteger(id) || id <= 0) {
      apiLog(req.requestId, 'WARN', 'delete_record', 'error', 'ID de registro inválido', 'cli');
      throw new BadRequestException('ID de registro deve ser um número inteiro positivo');
    }

    if (!this.db.deleteCliRecord(id, req.requestId)) {
      apiLog(req.requestId, 'WARN', 'delete_record', 'error', `Registro ${id} não encontrado`, 'cli');
      throw new NotFoundException(`Registro ${id} não encontrado`);
    }

    apiLog(req.requestId, 'INFO', 'delete_record', 'success', `Registro ${id} excluído com sucesso`, 'cli');

    return { message: 'Registro excluído com sucesso', id };
  }
}


/** Entrega a página inicial (index.html). */
@Controller()
export class PageController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  index(): string {
    return readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  }
}

@Module({})
export class AppModule implements NestModule {
  static register(db: Db, secret: string): DynamicModule {
    return {
      module: AppModule,
      controllers: [WebController, CliController, PageController],
      providers: [
        { provide: 'DB', useValue: db },
        { provide: 'TOKEN_SECRET', useValue: secret },
        AuthService,
        AuthGuard,
        CliAuthGuard,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

/** Sobe a aplicação: abre o SQLite, cria o usuário inicial e começa a escutar. */
export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<INestApplication> {
  const config = loadConfig(env);
  const db = new Db(config.dbPath);
  db.seedUser(config.user, config.password);
  const app = await NestFactory.create(AppModule.register(db, config.secret), { logger: false });
  await app.listen(config.port);
  logEvent({
    level: 'INFO',
    layer: 'api',
    client: 'web',
    operation: 'startup',
    status: 'success',
    request_id: 'startup',
    message: `API escutando na porta ${config.port}`,
  });
  return app;
}
