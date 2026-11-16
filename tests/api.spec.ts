import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, AuthService, bootstrap, loadConfig, validateRecordInput } from '../api';
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
});
