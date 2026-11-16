import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  AppModule,
  AuthService,
  bootstrap,
  loadConfig,
  parseCliListOptions,
  validateRecordInput,
  validateSearchFilters,
  formatCsvField,
  formatRecordsCsv,
} from '../api';
import { Db } from '../db';

let written: string[];
let db: Db;
let app: INestApplication;
let auth: AuthService;
let validToken: string;

const logs = () => written.map((line) => JSON.parse(line));

beforeAll(async () => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  db = new Db(':memory:');
  db.seedUser('admin', 'segredo123');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(db, 'chave-de-teste')],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  auth = moduleRef.get(AuthService);
  validToken = auth.sign('admin');
  jest.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  db.close();
});

beforeEach(() => {
  written = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/web/health', () => {
  it('responde 200 sem autenticação e devolve o request_id no cabeçalho', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(logs()[0]).toMatchObject({ layer: 'api', client: 'web', operation: 'health', status: 'success' });
  });
});

describe('GET /', () => {
  it('entrega a página inicial', async () => {
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('To-Do List');
  });
});

describe('POST /api/web/login', () => {
  it('autentica o usuário inicial e correlaciona os logs da API e do banco', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'admin', password: 'segredo123' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('admin');
    expect(typeof res.body.token).toBe('string');

    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'login');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'select_user');
    expect(apiLog).toMatchObject({ status: 'success', level: 'INFO', client: 'web', request_id: requestId });
    expect(dbLog).toMatchObject({ status: 'success', client: 'web', request_id: requestId });
  });

  it('não expõe senha nem token nos logs', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'admin', password: 'segredo123' });
    const everything = written.join('');
    expect(everything).not.toContain('segredo123');
    expect(everything).not.toContain(res.body.token);
  });

  it('responde 401 com senha errada e registra WARN', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'admin', password: 'errada' });
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.layer === 'api' && l.operation === 'login')).toMatchObject({
      level: 'WARN',
      status: 'error',
    });
    expect(written.join('')).not.toContain('errada');
  });

  it('responde 401 com usuário inexistente', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'ninguem', password: 'segredo123' });
    expect(res.status).toBe(401);
  });

  it('responde 401 quando o corpo vem vazio', async () => {
    const res = await request(app.getHttpServer()).post('/api/web/login');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/web/me', () => {
  it('responde 401 sem token', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/me');
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.operation === 'authenticate')).toMatchObject({ level: 'WARN', status: 'error' });
  });

  it('responde 401 com token malformado', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/me').set('Authorization', 'Bearer abc');
    expect(res.status).toBe(401);
  });

  it('responde 401 com assinatura de tamanho diferente', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/me').set('Authorization', 'Bearer abc.def');
    expect(res.status).toBe(401);
  });

  it('responde 401 com assinatura adulterada de mesmo tamanho', async () => {
    const token = auth.sign('admin');
    const last = token.slice(-1) === 'A' ? 'B' : 'A';
    const res = await request(app.getHttpServer())
      .get('/api/web/me')
      .set('Authorization', `Bearer ${token.slice(0, -1)}${last}`);
    expect(res.status).toBe(401);
  });

  it('responde 401 com token expirado', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/web/me')
      .set('Authorization', `Bearer ${auth.sign('admin', -10)}`);
    expect(res.status).toBe(401);
  });

  it('responde 200 com token válido', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/web/me')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'admin' });
  });
});

describe('validateRecordInput', () => {
  it('rejeita corpos nulos ou não objetos', () => {
    expect(validateRecordInput(null).valid).toBe(false);
    expect(validateRecordInput('texto').valid).toBe(false);
  });

  it('rejeita títulos curtos, longos ou ausentes', () => {
    expect(validateRecordInput({ description: 'abc', category: 'cat', priority: 'baixa' }).errors).toContain(
      'Título é obrigatório',
    );
    expect(
      validateRecordInput({ title: 'ab', description: 'desc', category: 'cat', priority: 'baixa' }).errors,
    ).toContain('Título deve ter entre 3 e 100 caracteres');
    expect(
      validateRecordInput({ title: 'a'.repeat(101), description: 'desc', category: 'cat', priority: 'baixa' }).errors,
    ).toContain('Título deve ter entre 3 e 100 caracteres');
  });

  it('rejeita descrição curta, longa ou ausente', () => {
    expect(validateRecordInput({ title: 'titulo', category: 'cat', priority: 'baixa' }).errors).toContain(
      'Descrição é obrigatória',
    );
    expect(
      validateRecordInput({ title: 'titulo', description: 'ab', category: 'cat', priority: 'baixa' }).errors,
    ).toContain('Descrição deve ter entre 3 e 500 caracteres');
    expect(
      validateRecordInput({ title: 'titulo', description: 'a'.repeat(501), category: 'cat', priority: 'baixa' }).errors,
    ).toContain('Descrição deve ter entre 3 e 500 caracteres');
  });

  it('rejeita categoria inválida ou ausente', () => {
    expect(validateRecordInput({ title: 'titulo', description: 'desc', priority: 'baixa' }).errors).toContain(
      'Categoria é obrigatória',
    );
    expect(
      validateRecordInput({ title: 'titulo', description: 'desc', category: 'x', priority: 'baixa' }).errors,
    ).toContain('Categoria deve ter entre 2 e 50 caracteres');
    expect(
      validateRecordInput({ title: 'titulo', description: 'desc', category: 'c'.repeat(51), priority: 'baixa' }).errors,
    ).toContain('Categoria deve ter entre 2 e 50 caracteres');
  });

  it('rejeita prioridade ausente ou fora do enum permitido', () => {
    expect(validateRecordInput({ title: 'titulo', description: 'desc', category: 'cat' }).errors).toContain(
      'Prioridade é obrigatória',
    );
    expect(
      validateRecordInput({ title: 'titulo', description: 'desc', category: 'cat', priority: 'urgente' }).errors,
    ).toContain('Prioridade deve ser baixa, media ou alta');
  });

  it('rejeita formato de data de vencimento inválido', () => {
    expect(
      validateRecordInput({
        title: 'titulo',
        description: 'desc',
        category: 'cat',
        priority: 'alta',
        due_date: '31/12/2026',
      }).errors,
    ).toContain('Data de vencimento deve estar no formato AAAA-MM-DD');

    expect(
      validateRecordInput({
        title: 'titulo',
        description: 'desc',
        category: 'cat',
        priority: 'alta',
        due_date: '2026-99-99',
      }).errors,
    ).toContain('Data de vencimento deve estar no formato AAAA-MM-DD');
  });

  it('aceita dados válidos com data ou sem data', () => {
    const withDate = validateRecordInput({
      title: 'Minha Tarefa',
      description: 'Descrição completa',
      category: 'Estudo',
      priority: 'alta',
      due_date: '2026-12-31',
    });
    expect(withDate.valid).toBe(true);
    expect(withDate.data?.due_date).toBe('2026-12-31');

    const withoutDate = validateRecordInput({
      title: 'Minha Tarefa',
      description: 'Descrição completa',
      category: 'Estudo',
      priority: 'alta',
      due_date: '   ',
    });
    expect(withoutDate.valid).toBe(true);
    expect(withoutDate.data?.due_date).toBeNull();
  });
});

describe('POST /api/web/records (Cadastro)', () => {
  it('rejeita requisições sem autenticação com HTTP 401', async () => {
    const res = await request(app.getHttpServer()).post('/api/web/records').send({ title: 'Teste' });
    expect(res.status).toBe(401);
  });

  it('rejeita dados inválidos com HTTP 400 e lista os erros', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/records')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ title: 'a' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it('cria uma nova tarefa com HTTP 201 e correlaciona logs de api e db', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/records')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        title: 'Configurar Docker',
        description: 'Configurar compose para os testes',
        category: 'DevOps',
        priority: 'alta',
        due_date: '2026-11-30',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('Configurar Docker');
    expect(res.body.category).toBe('DevOps');

    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'create_record');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'insert_record');

    expect(apiLog).toMatchObject({
      status: 'success',
      client: 'web',
      request_id: requestId,
    });
    expect(dbLog).toMatchObject({
      status: 'success',
      client: 'web',
      request_id: requestId,
    });
  });
});

describe('PUT /api/web/records/:id (Edição)', () => {
  let createdId: number;

  beforeEach(async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/records')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        title: 'Tarefa para Edição',
        description: 'Descrição prévia',
        category: 'Trabalho',
        priority: 'media',
      });
    createdId = res.body.id;
  });

  it('rejeita com HTTP 401 sem autenticação', async () => {
    const res = await request(app.getHttpServer()).put(`/api/web/records/${createdId}`).send({});
    expect(res.status).toBe(401);
  });

  it('rejeita com HTTP 400 para ID inválido', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/web/records/abc')
      .set('Authorization', `Bearer ${validToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejeita com HTTP 400 para dados inválidos', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/web/records/${createdId}`)
      .set('Authorization', `Bearer ${validToken}`)
      .send({ title: '' });
    expect(res.status).toBe(400);
  });

  it('retorna HTTP 404 para ID inexistente', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/web/records/999999')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        title: 'Titulo Valido',
        description: 'Descricao Valida',
        category: 'Trabalho',
        priority: 'baixa',
      });
    expect(res.status).toBe(404);
  });

  it('atualiza a tarefa com sucesso com HTTP 200 e correlaciona logs', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/web/records/${createdId}`)
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        title: 'Tarefa Editada com Sucesso',
        description: 'Nova descrição atualizada',
        category: 'Estudo',
        priority: 'alta',
        due_date: '2026-12-25',
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdId);
    expect(res.body.title).toBe('Tarefa Editada com Sucesso');
    expect(res.body.priority).toBe('alta');
    expect(res.body.due_date).toBe('2026-12-25');

    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'update_record' && l.status === 'success');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'update_record' && l.status === 'success');
    expect(apiLog).toMatchObject({ request_id: requestId, client: 'web' });
    expect(dbLog).toMatchObject({ request_id: requestId, client: 'web' });
  });
});

describe('GET /api/web/records e /api/web/records/:id (issue #3)', () => {
  it('exige autenticação nas rotas de consulta', async () => {
    const resList = await request(app.getHttpServer()).get('/api/web/records');
    expect(resList.status).toBe(401);

    const resItem = await request(app.getHttpServer()).get('/api/web/records/1');
    expect(resItem.status).toBe(401);
  });

  it('lista registros de forma paginada e ordenada com HTTP 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/web/records?page=1&limit=5&sort=id&order=desc')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(5);
    expect(res.body.total).toBeDefined();
    expect(res.body.totalPages).toBeDefined();
  });

  it('busca registro por ID com HTTP 200 e trata 404 e 400', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/web/records')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        title: 'Buscar Por ID',
        description: 'Descricao da busca',
        category: 'Projetos',
        priority: 'baixa',
      });

    const res = await request(app.getHttpServer())
      .get(`/api/web/records/${created.body.id}`)
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Buscar Por ID');

    const notFound = await request(app.getHttpServer())
      .get('/api/web/records/888888')
      .set('Authorization', `Bearer ${validToken}`);
    expect(notFound.status).toBe(404);

    const badId = await request(app.getHttpServer())
      .get('/api/web/records/invalido')
      .set('Authorization', `Bearer ${validToken}`);
    expect(badId.status).toBe(400);
  });
});

describe('DELETE /api/web/records/:id (Exclusão - issue #3)', () => {
  let createdId: number;

  beforeEach(async () => {
    const res = await request(app.getHttpServer())
      .post('/api/web/records')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        title: 'Tarefa Para Exclusao',
        description: 'Sera deletada no teste',
        category: 'Geral',
        priority: 'baixa',
      });
    createdId = res.body.id;
  });

  it('rejeita com HTTP 401 sem autenticação', async () => {
    const res = await request(app.getHttpServer()).delete(`/api/web/records/${createdId}`);
    expect(res.status).toBe(401);
  });

  it('rejeita com HTTP 400 para ID inválido', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/web/records/abc')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(400);

    const resNeg = await request(app.getHttpServer())
      .delete('/api/web/records/-5')
      .set('Authorization', `Bearer ${validToken}`);
    expect(resNeg.status).toBe(400);
  });

  it('retorna HTTP 404 para ID inexistente', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/web/records/999999')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(404);
  });

  it('exclui registro existente com HTTP 200 e logs correlacionados', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/web/records/${createdId}`)
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Registro excluído com sucesso');
    expect(res.body.id).toBe(createdId);

    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'delete_record' && l.status === 'success');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'delete_record' && l.status === 'success');
    expect(apiLog).toMatchObject({ request_id: requestId, client: 'web' });
    expect(dbLog).toMatchObject({ request_id: requestId, client: 'web' });

    // Verifica que não é mais encontrado
    const check = await request(app.getHttpServer())
      .get(`/api/web/records/${createdId}`)
      .set('Authorization', `Bearer ${validToken}`);
    expect(check.status).toBe(404);
  });
});

describe('validateSearchFilters (issue #4)', () => {
  it('aceita consulta sem filtros', () => {
    expect(validateSearchFilters({})).toEqual({ valid: true, errors: [], filters: {} });
  });

  it('normaliza os valores (trim, prioridade em minúsculas) e ignora filtros vazios', () => {
    const result = validateSearchFilters({
      q: '  relatório ',
      category: ' Estudo ',
      priority: 'ALTA',
      due_from: '2026-12-01',
      due_to: '',
    });
    expect(result).toEqual({
      valid: true,
      errors: [],
      filters: { q: 'relatório', category: 'Estudo', priority: 'alta', due_from: '2026-12-01' },
    });
  });

  it('rejeita prioridade fora de baixa, media e alta', () => {
    const result = validateSearchFilters({ priority: 'urgente' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Prioridade deve ser baixa, media ou alta']);
  });

  it.each(['01/12/2026', '2026-13-01', '2026-02-31', 'abc'])('rejeita data inválida %s', (value) => {
    const result = validateSearchFilters({ due_from: value, due_to: value });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('due_from');
    expect(result.errors[1]).toContain('due_to');
  });

  it('rejeita prazo inicial posterior ao final', () => {
    const result = validateSearchFilters({ due_from: '2026-12-31', due_to: '2026-12-01' });
    expect(result.errors).toEqual(['Prazo inicial não pode ser posterior ao prazo final']);
  });

  it('rejeita texto com mais de 100 caracteres e categoria com mais de 50', () => {
    const result = validateSearchFilters({ q: 'a'.repeat(101), category: 'b'.repeat(51) });
    expect(result.errors).toEqual([
      'Texto da busca deve ter no máximo 100 caracteres',
      'Categoria deve ter no máximo 50 caracteres',
    ]);
  });

  it('rejeita filtro repetido (valor que não é texto)', () => {
    const result = validateSearchFilters({ q: ['a', 'b'] });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Filtro q deve ser informado uma única vez']);
  });
});

describe('GET /api/web/records/search (busca avançada - issue #4)', () => {
  const search = (query: string) =>
    request(app.getHttpServer()).get(`/api/web/records/search${query}`).set('Authorization', `Bearer ${validToken}`);

  const create = async (data: Record<string, unknown>) => {
    const res = await request(app.getHttpServer())
      .post('/api/web/records')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ description: 'Descrição padrão', ...data });
    expect(res.status).toBe(201);
    return res.body;
  };

  beforeAll(async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await create({ title: 'LupaAlfa um', category: 'Estudo', priority: 'alta', due_date: '2026-12-01' });
    await create({ title: 'LupaAlfa dois', category: 'Trabalho', priority: 'baixa', due_date: '2026-12-15' });
    await create({ title: 'LupaBeta', category: 'Estudo', priority: 'alta', due_date: '2027-01-10' });
    await create({ title: 'LupaGama', category: 'Estudo', priority: 'alta' });
    await create({ title: 'Cem por cento', description: 'Meta de 100% concluída_ok', category: 'Geral', priority: 'media' });
    jest.restoreAllMocks();
  });

  const titles = (res: { body: { items: { title: string }[] } }) => res.body.items.map((i) => i.title).sort();

  it('responde 401 sem token e registra WARN', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/records/search?q=Lupa');
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.operation === 'authenticate')).toMatchObject({ level: 'WARN', status: 'error' });
  });

  it('responde 401 com token inválido', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/web/records/search')
      .set('Authorization', 'Bearer abc.def');
    expect(res.status).toBe(401);
  });

  it('não confunde "search" com um id (a rota é anterior a records/:id)', async () => {
    const res = await search('');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ page: 1, limit: 5 }));
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('sem filtros devolve todos os registros paginados', async () => {
    const res = await search('?limit=100');
    expect(res.body.total).toBeGreaterThanOrEqual(5);
    expect(res.body.items.length).toBe(res.body.total);
  });

  it('filtra por texto no título ou na descrição, sem diferenciar maiúsculas', async () => {
    const byTitle = await search('?q=Lupaalfa');
    expect(titles(byTitle)).toEqual(['LupaAlfa dois', 'LupaAlfa um']);
    const byDescription = await search(`?q=${encodeURIComponent('Meta de')}`);
    expect(titles(byDescription)).toEqual(['Cem por cento']);
  });

  it('trata % e _ do texto como caracteres comuns, não como curingas', async () => {
    expect(titles(await search('?q=100%25'))).toEqual(['Cem por cento']);
    expect(titles(await search(`?q=${encodeURIComponent('ída_ok')}`))).toEqual(['Cem por cento']);
    expect((await search('?q=%25')).body.total).toBe(1);
    expect((await search('?q=_')).body.total).toBe(1);
  });

  it('filtra por categoria (sem diferenciar maiúsculas) e por prioridade', async () => {
    expect(titles(await search('?q=Lupa&category=estudo'))).toEqual(['LupaAlfa um', 'LupaBeta', 'LupaGama']);
    expect(titles(await search('?q=Lupa&priority=baixa'))).toEqual(['LupaAlfa dois']);
  });

  it('combina texto, categoria e prioridade (E lógico)', async () => {
    const res = await search('?q=LupaAlfa&category=Estudo&priority=alta');
    expect(titles(res)).toEqual(['LupaAlfa um']);
    expect(res.body.total).toBe(1);
    expect((await search('?q=LupaAlfa&category=Trabalho&priority=alta')).body.total).toBe(0);
  });

  it('filtra por intervalo de prazo, deixando de fora registros sem prazo', async () => {
    const range = await search('?q=Lupa&due_from=2026-12-01&due_to=2026-12-31');
    expect(titles(range)).toEqual(['LupaAlfa dois', 'LupaAlfa um']);
    expect(titles(await search('?q=Lupa&due_to=2026-12-10'))).toEqual(['LupaAlfa um']);
    expect(titles(await search('?q=Lupa&due_from=2027-01-01'))).toEqual(['LupaBeta']);
  });

  it('combina os cinco filtros', async () => {
    const res = await search('?q=Alfa&category=Estudo&priority=alta&due_from=2026-12-01&due_to=2026-12-01');
    expect(titles(res)).toEqual(['LupaAlfa um']);
  });

  it('pagina e ordena o resultado filtrado', async () => {
    const first = await search('?q=Lupa&limit=2&page=1&sort=title&order=asc');
    expect(first.body).toMatchObject({ total: 4, page: 1, limit: 2, totalPages: 2 });
    expect(first.body.items.map((i: { title: string }) => i.title)).toEqual(['LupaAlfa dois', 'LupaAlfa um']);
    const second = await search('?q=Lupa&limit=2&page=2&sort=title&order=asc');
    expect(second.body.items.map((i: { title: string }) => i.title)).toEqual(['LupaBeta', 'LupaGama']);
  });

  it('nunca devolve página além da última', async () => {
    const res = await search('?q=Lupa&limit=2&page=99');
    expect(res.body.page).toBe(2);
    expect(res.body.items).toHaveLength(2);
  });

  it('devolve lista vazia, mas com 200, quando nada corresponde', async () => {
    const res = await search('?q=nao-existe-xyz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0, page: 1, totalPages: 1 });
  });

  it('responde 400 com a lista de erros quando os filtros são inválidos', async () => {
    const res = await search('?priority=urgente&due_from=2026-02-31&due_to=abc');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Filtros inválidos');
    expect(res.body.errors).toHaveLength(3);
    expect(logs().find((l) => l.operation === 'search_records')).toMatchObject({
      layer: 'api',
      level: 'WARN',
      status: 'error',
    });
  });

  it('responde 400 com filtro repetido e com intervalo invertido', async () => {
    expect((await search('?q=a&q=b')).status).toBe(400);
    expect((await search('?due_from=2026-12-31&due_to=2026-12-01')).status).toBe(400);
  });

  it('correlaciona os logs da API e do banco com o mesmo request_id e não expõe o token', async () => {
    const res = await search('?q=LupaAlfa&priority=alta');
    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'search_records');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'search_records');
    expect(apiLog).toMatchObject({ level: 'INFO', status: 'success', client: 'web', request_id: requestId });
    expect(dbLog).toMatchObject({ level: 'INFO', status: 'success', client: 'web', request_id: requestId });
    expect(dbLog.message).toContain('filtros: q, priority');
    expect(written.join('')).not.toContain(validToken);
  });
});

describe('loadConfig', () => {
  it('usa os padrões de desenvolvimento', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 3000, dbPath: './data/app.db', user: 'admin', password: 'admin123' });
    expect(config.secret).toHaveLength(64);
  });

  it('lê as variáveis de ambiente', () => {
    expect(
      loadConfig({ PORT: '8080', DB_PATH: '/x/y.db', APP_USER: 'u', APP_PASSWORD: 'p', TOKEN_SECRET: 's' }),
    ).toEqual({ port: 8080, dbPath: '/x/y.db', user: 'u', password: 'p', secret: 's' });
  });
});

describe('bootstrap', () => {
  it('sobe a aplicação, cria o usuário inicial e permite login', async () => {
    const server = await bootstrap({
      PORT: '0',
      DB_PATH: ':memory:',
      APP_USER: 'u',
      APP_PASSWORD: 'p',
      TOKEN_SECRET: 's',
    });
    const res = await request(server.getHttpServer())
      .post('/api/web/login')
      .send({ username: 'u', password: 'p' });
    expect(res.status).toBe(200);
    expect(logs().some((l) => l.operation === 'startup' && l.status === 'success')).toBe(true);
    await server.close();
  });
});

describe('CLI (issue #7): GET /api/cli/health', () => {
  it('responde 200 sem autenticação e registra o log com client cli', async () => {
    const res = await request(app.getHttpServer()).get('/api/cli/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(logs()[0]).toMatchObject({
      layer: 'api',
      client: 'cli',
      operation: 'health',
      status: 'success',
      request_id: res.headers['x-request-id'],
    });
  });
});

describe('CLI (issue #7): POST /api/cli/token', () => {
  it('emite o token e correlaciona os logs da API e do banco com o mesmo request_id', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ username: 'admin', password: 'segredo123' });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('admin');
    expect(typeof res.body.token).toBe('string');

    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'token');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'select_cli_user');
    expect(apiLog).toMatchObject({ level: 'INFO', status: 'success', client: 'cli', request_id: requestId });
    expect(dbLog).toMatchObject({ level: 'INFO', status: 'success', client: 'cli', request_id: requestId });
  });

  it('não expõe senha nem token nos logs', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ username: 'admin', password: 'segredo123' });
    const everything = written.join('');
    expect(everything).not.toContain('segredo123');
    expect(everything).not.toContain(res.body.token);
  });

  it('responde 401 com senha errada e registra WARN sem expor a senha', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ username: 'admin', password: 'errada' });
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.layer === 'api' && l.operation === 'token')).toMatchObject({
      level: 'WARN',
      status: 'error',
      client: 'cli',
    });
    expect(written.join('')).not.toContain('errada');
  });

  it('responde 401 com usuário inexistente', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ username: 'ninguem', password: 'segredo123' });
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.operation === 'select_cli_user')?.message).toContain('não encontrado');
  });

  it('responde 401 quando o corpo vem vazio', async () => {
    const res = await request(app.getHttpServer()).post('/api/cli/token');
    expect(res.status).toBe(401);
  });
});

describe('CLI (issue #7): GET /api/cli/me', () => {
  it('aceita o token emitido para a CLI', async () => {
    const issued = await request(app.getHttpServer())
      .post('/api/cli/token')
      .send({ username: 'admin', password: 'segredo123' });
    written = [];
    const res = await request(app.getHttpServer())
      .get('/api/cli/me')
      .set('Authorization', `Bearer ${issued.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'admin' });
    expect(logs().find((l) => l.operation === 'me')).toMatchObject({ client: 'cli', status: 'success' });
  });

  it('responde 401 sem token e registra WARN', async () => {
    const res = await request(app.getHttpServer()).get('/api/cli/me');
    expect(res.status).toBe(401);
    expect(logs().find((l) => l.operation === 'authenticate')).toMatchObject({
      level: 'WARN',
      status: 'error',
      client: 'cli',
    });
  });

  it('responde 401 com token inválido', async () => {
    const res = await request(app.getHttpServer()).get('/api/cli/me').set('Authorization', 'Bearer abc.def');
    expect(res.status).toBe(401);
  });

  it('responde 401 com token expirado', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/cli/me')
      .set('Authorization', `Bearer ${auth.sign('admin', -10, 'cli')}`);
    expect(res.status).toBe(401);
  });

  it('rejeita o token da Web (audiência diferente)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/cli/me')
      .set('Authorization', `Bearer ${validToken}`);
    expect(res.status).toBe(401);
  });

  it('o token da CLI não vale nos endpoints da Web', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/web/me')
      .set('Authorization', `Bearer ${auth.sign('admin', 3600, 'cli')}`);
    expect(res.status).toBe(401);
  });


describe('CLI (issue #8): POST /api/cli/records (Cadastro)', () => {
  const cliToken = () => auth.sign('admin', 3600, 'cli');

  it('rejeita requisições sem autenticação com HTTP 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/records')
      .send({ title: 'Teste' });

    expect(res.status).toBe(401);
  });

  it('rejeita dados inválidos com HTTP 400 e registra log da CLI', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/records')
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({ title: 'a' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();

    expect(logs().find((l) => l.layer === 'api' && l.operation === 'create_record'))
      .toMatchObject({ level: 'WARN', status: 'error', client: 'cli' });
  });

  it('cria uma tarefa com HTTP 201 e correlaciona logs da API e do banco', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/records')
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({
        title: 'Tarefa criada pela CLI',
        description: 'Cadastro realizado pelo terminal',
        category: 'Desenvolvimento',
        priority: 'alta',
        due_date: '2026-12-30',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('Tarefa criada pela CLI');

    const requestId = res.headers['x-request-id'];

    expect(logs().find((l) => l.layer === 'api' && l.operation === 'create_record'))
      .toMatchObject({ status: 'success', client: 'cli', request_id: requestId });

    expect(logs().find((l) => l.layer === 'db' && l.operation === 'insert_record'))
      .toMatchObject({ status: 'success', client: 'cli', request_id: requestId });
  });
});

describe('CLI (issue #8): PUT /api/cli/records/:id (Edição)', () => {
  const cliToken = () => auth.sign('admin', 3600, 'cli');
  let createdId: number;

  beforeEach(async () => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/records')
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({
        title: 'Tarefa para editar via CLI',
        description: 'Descrição inicial',
        category: 'Trabalho',
        priority: 'media',
      });

    createdId = res.body.id;
  });

  it('rejeita requisições sem autenticação com HTTP 401', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/cli/records/${createdId}`)
      .send({});

    expect(res.status).toBe(401);
  });

  it('rejeita ID inválido com HTTP 400', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/cli/records/abc')
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('rejeita dados inválidos com HTTP 400', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/cli/records/${createdId}`)
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({ title: '' });

    expect(res.status).toBe(400);
  });

  it('retorna HTTP 404 para registro inexistente', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/cli/records/999999')
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({
        title: 'Título válido',
        description: 'Descrição válida',
        category: 'Trabalho',
        priority: 'baixa',
      });

    expect(res.status).toBe(404);
  });

  it('atualiza a tarefa com HTTP 200 e correlaciona os logs', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/cli/records/${createdId}`)
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({
        title: 'Tarefa editada pela CLI',
        description: 'Descrição atualizada pelo terminal',
        category: 'Estudo',
        priority: 'alta',
        due_date: '2026-12-25',
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdId);
    expect(res.body.title).toBe('Tarefa editada pela CLI');

    const requestId = res.headers['x-request-id'];

    expect(logs().find((l) => l.layer === 'api' && l.operation === 'update_record'))
      .toMatchObject({ status: 'success', client: 'cli', request_id: requestId });

    expect(logs().find((l) => l.layer === 'db' && l.operation === 'update_record'))
      .toMatchObject({ status: 'success', client: 'cli', request_id: requestId });
  });
});


describe('formatCsvField e formatRecordsCsv (issue #5)', () => {
  it('escapa aspas duplas e envolve valores em aspas conforme RFC 4180', () => {
    expect(formatCsvField(null)).toBe('""');
    expect(formatCsvField(undefined)).toBe('""');
    expect(formatCsvField('Simples')).toBe('"Simples"');
    expect(formatCsvField('Com "aspas"')).toBe('"Com ""aspas"""');
    expect(formatCsvField('Com, vírgula')).toBe('"Com, vírgula"');
  });

  it('formata lista de registros no formato CSV completo', () => {
    const records = [
      {
        id: 1,
        title: 'Tarefa 1',
        description: 'Desc com "aspas"',
        category: 'Trabalho',
        priority: 'alta',
        due_date: '2026-12-31',
        created_at: '2026-11-15T00:00:00Z',
        updated_at: '2026-11-15T00:00:00Z',
      },
      {
        id: 2,
        title: 'Tarefa 2',
        description: 'Sem prazo',
        category: 'Geral',
        priority: 'baixa',
        due_date: null,
        created_at: '2026-11-15T00:00:00Z',
        updated_at: '2026-11-15T00:00:00Z',
      },
    ];

    const csv = formatRecordsCsv(records);
    expect(csv).toContain('id,title,description,category,priority,due_date,created_at,updated_at');
    expect(csv).toContain('1,"Tarefa 1","Desc com ""aspas""","Trabalho","alta","2026-12-31"');
    expect(csv).toContain('2,"Tarefa 2","Sem prazo","Geral","baixa",""');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('GET /api/web/records/export (exportação CSV - issue #5)', () => {
  const exportCsv = (query = '') =>
    request(app.getHttpServer())
      .get(`/api/web/records/export${query}`)
      .set('Authorization', `Bearer ${validToken}`);

  beforeEach(() => {
    written = [];
  });

  it('responde HTTP 401 sem token de autenticação', async () => {
    const res = await request(app.getHttpServer()).get('/api/web/records/export');
    expect(res.status).toBe(401);
  });

  it('responde HTTP 401 com token inválido', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/web/records/export')
      .set('Authorization', 'Bearer token-invalido');
    expect(res.status).toBe(401);
  });

  it('responde HTTP 400 quando filtros de busca são inválidos e emite log WARN', async () => {
    const res = await exportCsv('?priority=invalida&due_from=data-invalida');
    expect(res.status).toBe(400);
    const body = JSON.parse(res.text);
    expect(body.message).toBe('Filtros inválidos');
    expect(body.errors.length).toBeGreaterThanOrEqual(1);

    const warnLog = logs().find((l) => l.layer === 'api' && l.operation === 'export_csv');
    expect(warnLog).toMatchObject({
      layer: 'api',
      level: 'WARN',
      status: 'error',
    });
  });

  it('exporta todos os registros em CSV sem filtros com headers corretos e correlação de logs', async () => {
    const res = await exportCsv();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="tarefas.csv"');

    const csv = res.text;
    expect(csv).toContain('id,title,description,category,priority,due_date,created_at,updated_at');
    expect(csv).toContain('LupaAlfa um');

    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'export_csv');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'export_csv');

    expect(apiLog).toMatchObject({
      layer: 'api',
      client: 'web',
      operation: 'export_csv',
      status: 'success',
      request_id: requestId,
    });
    expect(dbLog).toMatchObject({
      layer: 'db',
      client: 'web',
      operation: 'export_csv',
      status: 'success',
      request_id: requestId,
    });
  });

  it('exporta apenas registros filtrados com parâmetros de busca', async () => {
    const res = await exportCsv('?q=LupaAlfa&category=Estudo');
    expect(res.status).toBe(200);
    expect(res.text).toContain('LupaAlfa um');
    expect(res.text).not.toContain('LupaAlfa dois');
    expect(res.text).not.toContain('Cem por cento');
  });
});

});

describe('parseCliListOptions (issue #9)', () => {
  it('usa os padrões quando os parâmetros faltam ou vêm vazios', () => {
    const defaults = { page: 1, limit: 5, sort: 'id', order: 'desc' };
    expect(parseCliListOptions({})).toEqual({ valid: true, errors: [], options: defaults });
    expect(parseCliListOptions({ page: '', limit: '', sort: '', order: '' }).options).toEqual(defaults);
  });

  it('aceita e normaliza valores válidos', () => {
    const result = parseCliListOptions({ page: '2', limit: ' 10 ', sort: 'title', order: 'ASC' });
    expect(result).toEqual({
      valid: true,
      errors: [],
      options: { page: 2, limit: 10, sort: 'title', order: 'asc' },
    });
  });

  it.each([
    [{ page: '0' }, 'Página deve ser um número inteiro maior que zero'],
    [{ page: '-1' }, 'Página deve ser um número inteiro maior que zero'],
    [{ page: '1.5' }, 'Página deve ser um número inteiro maior que zero'],
    [{ page: 'abc' }, 'Página deve ser um número inteiro maior que zero'],
    [{ limit: '0' }, 'Limite deve ser um número inteiro de 1 a 100'],
    [{ limit: '101' }, 'Limite deve ser um número inteiro de 1 a 100'],
    [{ sort: 'drop' }, 'Ordenação deve ser um destes campos: id, title, category, priority, due_date, created_at'],
    [{ order: 'up' }, 'Direção da ordenação deve ser asc ou desc'],
    [{ page: ['1', '2'] }, 'Parâmetro page deve ser informado uma única vez'],
  ])('rejeita %j', (query, message) => {
    const result = parseCliListOptions(query as Record<string, unknown>);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([message]);
  });

  it('acumula todos os erros e mantém os padrões nos campos inválidos', () => {
    const result = parseCliListOptions({ page: '0', limit: '500', sort: 'x', order: 'y' });
    expect(result.errors).toHaveLength(4);
    expect(result.options).toEqual({ page: 1, limit: 5, sort: 'id', order: 'desc' });
  });
});

describe('CLI (issue #9): GET /api/cli/records (Listagem)', () => {
  // Banco e aplicação próprios, para o conteúdo ser conhecido e os resultados exatos.
  let listApp: INestApplication;
  let listDb: Db;
  let cliToken: string;
  let webToken: string;

  const get = (query = '') =>
    request(listApp.getHttpServer()).get(`/api/cli/records${query}`).set('Authorization', `Bearer ${cliToken}`);
  const ids = (res: { body: { items: { id: number }[] } }) => res.body.items.map((i) => i.id);
  const titles = (res: { body: { items: { title: string }[] } }) => res.body.items.map((i) => i.title);

  beforeAll(async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    listDb = new Db(':memory:');
    listDb.seedUser('admin', 'segredo123');
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(listDb, 'chave-da-listagem')],
    }).compile();
    listApp = moduleRef.createNestApplication();
    await listApp.init();
    const listAuth = moduleRef.get(AuthService);
    cliToken = listAuth.sign('admin', 3600, 'cli');
    webToken = listAuth.sign('admin');
    const seed: [string, string, string, string | null][] = [
      ['Delta', 'Trabalho', 'alta', '2026-12-10'],
      ['Alfa', 'Estudo', 'baixa', null],
      ['Charlie', 'Estudo', 'media', '2026-12-01'],
      ['Bravo', 'Geral', 'alta', '2026-12-20'],
      ['Echo', 'Pessoal', 'baixa', '2026-12-05'],
      ['Foxtrot', 'Projetos', 'media', '2026-12-15'],
      ['Golf', 'Trabalho', 'alta', null],
    ];
    for (const [title, category, priority, due_date] of seed) {
      listDb.createRecord({ title, description: 'Descrição', category, priority, due_date }, 'seed', 'cli');
    }
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await listApp.close();
    listDb.close();
  });

  it('responde 401 sem token, com token inválido e com o token da Web', async () => {
    const server = listApp.getHttpServer();
    expect((await request(server).get('/api/cli/records')).status).toBe(401);
    expect((await request(server).get('/api/cli/records').set('Authorization', 'Bearer abc.def')).status).toBe(401);
    expect((await request(server).get('/api/cli/records').set('Authorization', `Bearer ${webToken}`)).status).toBe(401);
    expect(logs().find((l) => l.operation === 'authenticate')).toMatchObject({ client: 'cli', level: 'WARN' });
  });

  it('lista 5 por página, do mais recente para o mais antigo, com os totais', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 7, page: 1, limit: 5, totalPages: 2 });
    expect(ids(res)).toEqual([7, 6, 5, 4, 3]);
    expect((await get('?page=2')).body.items.map((i: { id: number }) => i.id)).toEqual([2, 1]);
  });

  it('ordena por título, categoria, prioridade, prazo e data de criação nas duas direções', async () => {
    expect(titles(await get('?sort=title&order=asc&limit=3'))).toEqual(['Alfa', 'Bravo', 'Charlie']);
    expect(titles(await get('?sort=title&order=desc&limit=2'))).toEqual(['Golf', 'Foxtrot']);
    expect(titles(await get('?sort=category&order=asc&limit=2'))).toEqual(['Alfa', 'Charlie']);
    expect(titles(await get('?sort=priority&order=asc&limit=3'))).toEqual(['Delta', 'Bravo', 'Golf']);
    expect(titles(await get('?sort=due_date&order=asc&limit=3'))).toEqual(['Alfa', 'Golf', 'Charlie']);
    expect(ids(await get('?sort=created_at&order=asc&limit=3'))).toEqual([1, 2, 3]);
  });

  it('aceita limit até 100 e nunca devolve página além da última', async () => {
    const all = await get('?limit=100');
    expect(all.body).toMatchObject({ total: 7, limit: 100, totalPages: 1 });
    expect(all.body.items).toHaveLength(7);
    const beyond = await get('?page=99');
    expect(beyond.body.page).toBe(2);
    expect(ids(beyond)).toEqual([2, 1]);
  });

  it('trata parâmetros vazios como ausentes', async () => {
    const res = await get('?page=&limit=&sort=&order=');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 5 });
  });

  it('responde 400 com a lista de erros quando os parâmetros são inválidos', async () => {
    const res = await get('?page=0&limit=101&sort=drop&order=up');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Parâmetros inválidos');
    expect(res.body.errors).toHaveLength(4);
    expect(logs().find((l) => l.layer === 'api' && l.operation === 'list_records')).toMatchObject({
      level: 'WARN',
      status: 'error',
      client: 'cli',
    });
    expect((await get('?page=1&page=2')).status).toBe(400);
  });

  it('devolve o mesmo que a Web para os mesmos parâmetros', async () => {
    const web = await request(listApp.getHttpServer())
      .get('/api/web/records?page=1&limit=5&sort=title&order=asc')
      .set('Authorization', `Bearer ${webToken}`);
    const cli = await get('?page=1&limit=5&sort=title&order=asc');
    expect(ids(cli)).toEqual(ids(web));
    expect(cli.body.total).toBe(web.body.total);
  });

  it('correlaciona os logs da API e do banco e não expõe o token', async () => {
    const res = await get('?page=2&limit=3');
    const requestId = res.headers['x-request-id'];
    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'list_records');
    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'list_cli_records');
    expect(apiLog).toMatchObject({ level: 'INFO', status: 'success', client: 'cli', request_id: requestId });
    expect(dbLog).toMatchObject({ level: 'INFO', status: 'success', client: 'cli', request_id: requestId });
    expect(dbLog.message).toContain('página 2 de 3');
    expect(written.join('')).not.toContain(cliToken);
  });
});


describe('CLI (issue #10): GET /api/cli/records/search (Busca avançada)', () => {
  let searchApp: INestApplication;
  let searchDb: Db;
  let cliToken: string;
  let webToken: string;

  const get = (query = '') =>
    request(searchApp.getHttpServer())
      .get(`/api/cli/records/search${query}`)
      .set('Authorization', `Bearer ${cliToken}`);

  const titles = (res: { body: { items: { title: string }[] } }) =>
    res.body.items.map((item) => item.title).sort();

  beforeAll(async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    searchDb = new Db(':memory:');
    searchDb.seedUser('admin', 'segredo123');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(searchDb, 'chave-da-busca-cli')],
    }).compile();

    searchApp = moduleRef.createNestApplication();
    await searchApp.init();

    const searchAuth = moduleRef.get(AuthService);
    cliToken = searchAuth.sign('admin', 3600, 'cli');
    webToken = searchAuth.sign('admin');

    const seed: [string, string, string, string | null][] = [
      ['Delta', 'Trabalho', 'alta', '2026-12-10'],
      ['Alfa', 'Estudo', 'baixa', '2026-12-15'],
      ['Charlie', 'Estudo', 'alta', '2026-12-01'],
      ['Bravo', 'Geral', 'media', '2026-12-20'],
      ['Echo', 'Estudo', 'alta', null],
      ['Foxtrot', 'Trabalho', 'baixa', '2027-01-10'],
    ];

    for (const [title, category, priority, due_date] of seed) {
      searchDb.createRecord(
        {
          title: `BuscaCLI ${title}`,
          description: `Descrição ${title}`,
          category,
          priority,
          due_date,
        },
        `seed-${title}`,
        'cli',
      );
    }
  });

  afterAll(async () => {
    await searchApp.close();
    searchDb.close();
    jest.restoreAllMocks();
  });

  it('responde 401 sem token, com token inválido e com token da Web', async () => {
    const server = searchApp.getHttpServer();

    expect((await request(server).get('/api/cli/records/search')).status).toBe(401);

    expect(
      (
        await request(server)
          .get('/api/cli/records/search')
          .set('Authorization', 'Bearer abc.def')
      ).status,
    ).toBe(401);

    expect(
      (
        await request(server)
          .get('/api/cli/records/search')
          .set('Authorization', `Bearer ${webToken}`)
      ).status,
    ).toBe(401);
  });

  it('retorna todos os registros paginados sem filtros', async () => {
    const res = await get('?limit=100');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6);
    expect(res.body.items).toHaveLength(6);
  });

  it('filtra por texto, categoria e prioridade', async () => {
    const res = await get('?q=BuscaCLI&category=Estudo&priority=alta');

    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(['BuscaCLI Charlie', 'BuscaCLI Echo']);
    expect(res.body.total).toBe(2);
  });

  it('combina filtros de prazo e texto', async () => {
    const res = await get(
      '?q=BuscaCLI&due_from=2026-12-01&due_to=2026-12-31',
    );

    expect(res.status).toBe(200);
    expect(titles(res)).toEqual([
      'BuscaCLI Alfa',
      'BuscaCLI Bravo',
      'BuscaCLI Charlie',
      'BuscaCLI Delta',
    ]);
    expect(res.body.total).toBe(4);
  });

  it('aplica paginação e ordenação', async () => {
    const res = await get('?q=BuscaCLI&sort=title&order=asc&page=2&limit=2');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 6,
      page: 2,
      limit: 2,
      totalPages: 3,
    });
    expect(titles(res)).toEqual(['BuscaCLI Charlie', 'BuscaCLI Delta']);
  });

  it('responde 400 para filtros inválidos e registra log da CLI', async () => {
    const res = await get('?priority=urgente');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Filtros inválidos');
    expect(res.body.errors).toBeDefined();

    expect(
      logs().find((l) => l.layer === 'api' && l.operation === 'search_records'),
    ).toMatchObject({
      level: 'WARN',
      status: 'error',
      client: 'cli',
    });
  });

  it('correlaciona os logs da API e do banco com o mesmo request_id', async () => {
    const res = await get('?q=BuscaCLI&priority=alta');
    const requestId = res.headers['x-request-id'];

    const apiLog = logs().find(
      (l) => l.layer === 'api' && l.operation === 'search_records',
    );
    const dbLog = logs().find(
      (l) => l.layer === 'db' && l.operation === 'search_records',
    );

    expect(apiLog).toMatchObject({
      level: 'INFO',
      status: 'success',
      client: 'cli',
      request_id: requestId,
    });

    expect(dbLog).toMatchObject({
      level: 'INFO',
      status: 'success',
      client: 'cli',
      request_id: requestId,
    });
  });
});


describe('CLI (issue #9): DELETE /api/cli/records/:id (Exclusão)', () => {
  const cliToken = () => auth.sign('admin', 3600, 'cli');
  const create = async (title: string): Promise<number> => {
    const res = await request(app.getHttpServer())
      .post('/api/cli/records')
      .set('Authorization', `Bearer ${cliToken()}`)
      .send({ title, description: 'Descrição', category: 'Geral', priority: 'baixa' });
    expect(res.status).toBe(201);
    return res.body.id;
  };
  const remove = (id: number | string, token: string | null = cliToken()) => {
    const req = request(app.getHttpServer()).delete(`/api/cli/records/${id}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('responde 401 sem token e com o token da Web, sem excluir nada', async () => {
    const id = await create('Não pode ser excluída');
    expect((await remove(id, null)).status).toBe(401);
    expect((await remove(id, validToken)).status).toBe(401);
    const still = await request(app.getHttpServer())
      .get(`/api/web/records/${id}`)
      .set('Authorization', `Bearer ${validToken}`);
    expect(still.status).toBe(200);
  });

  it.each(['abc', '0', '-3', '1.5'])('responde 400 para o id inválido %s', async (badId) => {
    const res = await remove(badId);
    expect(res.status).toBe(400);
    expect(logs().find((l) => l.layer === 'api' && l.operation === 'delete_record')).toMatchObject({
      level: 'WARN',
      status: 'error',
      client: 'cli',
    });
  });

  it('responde 404 para id inexistente e correlaciona os logs de erro', async () => {
    const res = await remove(999999);
    expect(res.status).toBe(404);
    const requestId = res.headers['x-request-id'];
    expect(logs().find((l) => l.layer === 'api' && l.operation === 'delete_record')).toMatchObject({
      level: 'WARN',
      status: 'error',
      request_id: requestId,
    });
    expect(logs().find((l) => l.layer === 'db' && l.operation === 'delete_cli_record')).toMatchObject({
      level: 'WARN',
      status: 'error',
      client: 'cli',
      request_id: requestId,
    });
  });

  it('exclui a tarefa, correlaciona os logs e ela some da Web', async () => {
    const id = await create('Tarefa a excluir pela CLI');
    written = [];
    const res = await remove(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Registro excluído com sucesso', id });

    const requestId = res.headers['x-request-id'];
    expect(logs().find((l) => l.layer === 'api' && l.operation === 'delete_record')).toMatchObject({
      level: 'INFO',
      status: 'success',
      client: 'cli',
      request_id: requestId,
    });
    expect(logs().find((l) => l.layer === 'db' && l.operation === 'delete_cli_record')).toMatchObject({
      level: 'INFO',
      status: 'success',
      client: 'cli',
      request_id: requestId,
    });
    expect(written.join('')).not.toContain(cliToken());

    const onWeb = await request(app.getHttpServer())
      .get(`/api/web/records/${id}`)
      .set('Authorization', `Bearer ${validToken}`);
    expect(onWeb.status).toBe(404);
    expect((await remove(id)).status).toBe(404);
  });
});


describe('GET /api/web/dashboard', () => {
  it('exige autenticação Web e rejeita requisição sem token ou com token de outro público', async () => {
    const unauth = await request(app.getHttpServer()).get('/api/web/dashboard');
    expect(unauth.status).toBe(401);

    const cliToken = auth.sign('admin', 3600, 'cli');
    const wrongAud = await request(app.getHttpServer())
      .get('/api/web/dashboard')
      .set('Authorization', `Bearer ${cliToken}`);
    expect(wrongAud.status).toBe(401);
  });

  it('retorna os indicadores do banco com sucesso e correlaciona os logs com request_id', async () => {
    written = [];
    const res = await request(app.getHttpServer())
      .get('/api/web/dashboard')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('byStatus');
    expect(res.body).toHaveProperty('byPriority');
    expect(res.body).toHaveProperty('byCategory');
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.byStatus.em_dia).toBe('number');
    expect(typeof res.body.byStatus.atrasada).toBe('number');

    const requestId = res.headers['x-request-id'];
    expect(requestId).toBeTruthy();

    const dbLog = logs().find((l) => l.layer === 'db' && l.operation === 'dashboard_stats');
    expect(dbLog).toMatchObject({
      level: 'INFO',
      layer: 'db',
      client: 'web',
      operation: 'dashboard_stats',
      status: 'success',
      request_id: requestId,
    });

    const apiLog = logs().find((l) => l.layer === 'api' && l.operation === 'dashboard_stats');
    expect(apiLog).toMatchObject({
      level: 'INFO',
      layer: 'api',
      client: 'web',
      operation: 'dashboard_stats',
      status: 'success',
      request_id: requestId,
    });
    expect(written.join('')).not.toContain(validToken);
  });
});
