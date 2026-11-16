import { FetchFn, parseArgs, run, USAGE } from '../cli';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

interface Captured {
  out: string[];
  err: string[];
  io: { out(t: string): void; err(t: string): void };
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t) } };
}

/** Resposta falsa da API: só o que a CLI usa (`ok`, `status` e `json()`). */
function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function csvReply(status: number, csv: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => csv,
    json: async () => ({}),
  } as unknown as Response;
}

describe('parseArgs', () => {
  it('separa o comando das opções (--nome valor, --nome=valor e atalhos)', () => {
    expect(parseArgs(['token', '--api-url', 'http://x', '-u', 'ana', '--password=s3', '-p', 'z'])).toEqual({
      command: 'token',
      flags: { 'api-url': 'http://x', username: 'ana', password: 'z' },
      help: false,
    });
  });

  it('reconhece -h e --help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['health', '--help']).help).toBe(true);
  });

  it('sem argumentos o comando é vazio', () => {
    expect(parseArgs([]).command).toBe('');
  });

  it('acusa opção desconhecida', () => {
    expect(parseArgs(['health', '--foo']).error).toBe('Opção desconhecida: --foo');
  });

  it('acusa opção sem valor', () => {
    expect(parseArgs(['token', '--username']).error).toBe('A opção --username exige um valor');
  });
});

describe('run: ajuda e uso incorreto', () => {
  it.each([[[]], [['help']], [['health', '--help']], [['-h']]])('mostra a ajuda para %j', async (argv) => {
    const c = capture();
    const fetchFn = jest.fn();
    expect(await run(argv, {}, c.io, fetchFn as unknown as FetchFn)).toBe(0);
    expect(c.out).toEqual([USAGE]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('lista os subcomandos na ajuda', () => {
    for (const command of ['help', 'health', 'token', 'whoami']) expect(USAGE).toContain(command);
  });

  it('retorna 2 para comando desconhecido', async () => {
    const c = capture();
    expect(await run(['voar'], {}, c.io, jest.fn() as unknown as FetchFn)).toBe(2);
    expect(c.err[0]).toBe('Comando desconhecido: voar');
  });

  it('retorna 2 para opção inválida', async () => {
    const c = capture();
    expect(await run(['health', '--x'], {}, c.io, jest.fn() as unknown as FetchFn)).toBe(2);
    expect(c.err[0]).toBe('Opção desconhecida: --x');
  });
});

describe('run: health', () => {
  it('chama GET /api/cli/health sem token e imprime a resposta', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { status: 'ok' }));
    const code = await run(['health'], { API_URL: 'http://api:3000/' }, c.io, fetchFn);
    expect(code).toBe(0);
    expect(c.out).toEqual(['{"status":"ok"}']);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://api:3000/api/cli/health');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('a opção --api-url vence a variável API_URL e o padrão é localhost', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { status: 'ok' }));
    await run(['health', '--api-url', 'http://outra:1'], { API_URL: 'http://api:3000' }, capture().io, fetchFn);
    expect(fetchFn.mock.calls[0][0]).toBe('http://outra:1/api/cli/health');
    await run(['health'], {}, capture().io, fetchFn);
    expect(fetchFn.mock.calls[1][0]).toBe('http://localhost:3000/api/cli/health');
  });

  it('retorna 1 e escreve em stderr quando a API responde erro', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(503, { message: 'indisponível' }));
    expect(await run(['health'], {}, c.io, fetchFn)).toBe(1);
    expect(c.err).toEqual(['Erro HTTP 503 - indisponível']);
  });

  it('retorna 1 quando não consegue conectar à API', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockRejectedValue(new Error('fetch failed'));
    expect(await run(['health'], { API_URL: 'http://api:3000' }, c.io, fetchFn)).toBe(1);
    expect(c.err[0]).toBe('Não foi possível conectar à API em http://api:3000: fetch failed');
  });
});

describe('run: token', () => {
  it('envia usuário e senha a POST /api/cli/token e imprime só o token', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { token: 'abc.def', username: 'ana' }));
    const code = await run(['token', '-u', 'ana', '-p', 'senha'], {}, c.io, fetchFn);
    expect(code).toBe(0);
    expect(c.out).toEqual(['abc.def']);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/cli/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ username: 'ana', password: 'senha' });
  });

  it('usa CLI_USER e CLI_PASSWORD quando as opções não são informadas', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { token: 't' }));
    await run(['token'], { CLI_USER: 'env-user', CLI_PASSWORD: 'env-pass' }, capture().io, fetchFn);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ username: 'env-user', password: 'env-pass' });
  });

  it('retorna 2 sem chamar a API quando faltam credenciais', async () => {
    const c = capture();
    const fetchFn = jest.fn();
    expect(await run(['token', '-u', 'ana'], {}, c.io, fetchFn as unknown as FetchFn)).toBe(2);
    expect(c.err[0]).toContain('CLI_USER/CLI_PASSWORD');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('retorna 1 com credenciais inválidas e não imprime a senha', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(401, { message: 'Usuário ou senha inválidos' }));
    expect(await run(['token', '-u', 'ana', '-p', 'segredo-errado'], {}, c.io, fetchFn)).toBe(1);
    expect(c.err).toEqual(['Erro HTTP 401 - Usuário ou senha inválidos']);
    expect(c.out.join('') + c.err.join('')).not.toContain('segredo-errado');
  });
});

describe('run: whoami (rota protegida)', () => {
  it('envia o Bearer token da opção --token', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { username: 'ana' }));
    expect(await run(['whoami', '--token', 'tok'], { TODO_TOKEN: 'outro' }, c.io, fetchFn)).toBe(0);
    expect(c.out).toEqual(['{"username":"ana"}']);
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/me');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('lê o token da variável TODO_TOKEN', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { username: 'ana' }));
    await run(['whoami'], { TODO_TOKEN: 'do-ambiente' }, capture().io, fetchFn);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer do-ambiente');
  });

  it('sem token ainda chama a API (que responde 401) e retorna 1', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(401, { message: 'Unauthorized' }));
    expect(await run(['whoami'], { TODO_TOKEN: '' }, c.io, fetchFn)).toBe(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(c.err).toEqual(['Erro HTTP 401 - Unauthorized']);
  });

  it('tolera resposta de erro sem JSON', async () => {
    const c = capture();
    const bad = { ok: false, status: 502, json: async () => Promise.reject(new Error('html')) } as unknown as Response;
    expect(await run(['whoami'], {}, c.io, jest.fn().mockResolvedValue(bad))).toBe(1);
    expect(c.err).toEqual(['Erro HTTP 502']);
  });
});

describe('run: padrões', () => {
  it('usa process.env, stdout/stderr e fetch globais quando nada é injetado', async () => {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(reply(200, { status: 'ok' }));
    expect(await run(['health'])).toBe(0);
    expect(await run(['voar'])).toBe(2);
    expect(out).toHaveBeenCalledWith('{"status":"ok"}\n');
    expect(err).toHaveBeenCalledWith('Comando desconhecido: voar\n');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

describe('run: create (cadastro de tarefa)', () => {
  const args = [
    'create',
    '--title', 'Minha tarefa',
    '--description', 'Descrição da tarefa',
    '--category', 'Trabalho',
    '--priority', 'alta',
  ];

  it('cadastra uma tarefa e envia os dados para a API com Bearer token', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(201, { id: 10, title: 'Minha tarefa' }));

    expect(await run([...args, '--due-date', '2026-12-30'], { TODO_TOKEN: 'token-teste' }, c.io, fetchFn)).toBe(0);

    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/records');
    expect(fetchFn.mock.calls[0][1].method).toBe('POST');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer token-teste');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      title: 'Minha tarefa',
      description: 'Descrição da tarefa',
      category: 'Trabalho',
      priority: 'alta',
      due_date: '2026-12-30',
    });
    expect(c.out).toEqual(['{"id":10,"title":"Minha tarefa"}']);
  });

  it('aceita token pela opção --token e permite cadastro sem data', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(201, { id: 11 }));
    const c = capture();

    expect(await run([...args, '--token', 'token-manual'], {}, c.io, fetchFn)).toBe(0);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer token-manual');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).not.toHaveProperty('due_date');
  });

  it('retorna 2 quando não informa token', async () => {
    const c = capture();
    const fetchFn = jest.fn();

    expect(await run(args, {}, c.io, fetchFn)).toBe(2);
    expect(c.err[0]).toContain('TODO_TOKEN');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('retorna 2 quando faltam campos obrigatórios', async () => {
    const c = capture();
    const fetchFn = jest.fn();

    expect(await run(['create', '--token', 'abc', '--title', 'Teste'], {}, c.io, fetchFn)).toBe(2);
    expect(c.err[0]).toContain('--description');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('retorna 1 quando a API rejeita o cadastro', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(400, { message: 'Dados inválidos' }));

    expect(await run([...args, '--token', 'abc'], {}, c.io, fetchFn)).toBe(1);
    expect(c.err).toEqual(['Erro HTTP 400 - Dados inválidos']);
  });
});

describe('run: update (edição de tarefa)', () => {
  const args = [
    'update',
    '--id', '10',
    '--title', 'Tarefa atualizada',
    '--description', 'Descrição atualizada',
    '--category', 'Estudo',
    '--priority', 'media',
  ];

  it('atualiza uma tarefa e envia PUT para a API', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { id: 10, title: 'Tarefa atualizada' }));

    expect(await run([...args, '--due-date', '2026-12-25'], { TODO_TOKEN: 'token-teste' }, c.io, fetchFn)).toBe(0);

    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/records/10');
    expect(fetchFn.mock.calls[0][1].method).toBe('PUT');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer token-teste');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({
      title: 'Tarefa atualizada',
      description: 'Descrição atualizada',
      category: 'Estudo',
      priority: 'media',
      due_date: '2026-12-25',
    });
    expect(c.out).toEqual(['{"id":10,"title":"Tarefa atualizada"}']);
  });

  it('retorna 2 quando o ID não é informado ou é inválido', async () => {
    const c = capture();
    const fetchFn = jest.fn();

    expect(await run([
      'update',
      '--token', 'abc',
      '--title', 'Teste',
      '--description', 'Descrição',
      '--category', 'Trabalho',
      '--priority', 'baixa',
    ], {}, c.io, fetchFn)).toBe(2);

    expect(c.err[0]).toContain('--id');
    expect(fetchFn).not.toHaveBeenCalled();

    c.err.length = 0;

    expect(await run([...args.slice(0, 1), '--id', 'abc', ...args.slice(3), '--token', 'abc'], {}, c.io, fetchFn)).toBe(2);
    expect(c.err[0]).toContain('ID válido');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('retorna 1 quando a API rejeita a edição', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(404, { message: 'Registro não encontrado' }));

    expect(await run([...args, '--token', 'abc'], {}, c.io, fetchFn)).toBe(1);
    expect(c.err).toEqual(['Erro HTTP 404 - Registro não encontrado']);
  });
});
});


describe('run: search (busca avançada)', () => {
  const page = (items: unknown[]) =>
    reply(200, { items, total: items.length, page: 1, limit: 5, totalPages: 1 });

  it('chama o endpoint de busca sem filtros', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(page([]));

    expect(await run(['search', '--token', 'abc'], {}, c.io, fetchFn)).toBe(0);

    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/records/search');
    expect(fetchFn.mock.calls[0][1].method).toBe('GET');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer abc');
    expect(c.out[0]).toContain('Nenhuma tarefa encontrada.');
  });

  it('envia todos os filtros, paginação e ordenação com os nomes esperados pela API', async () => {
    const fetchFn = jest.fn().mockResolvedValue(page([]));

    await run([
      'search',
      '--q', 'relatório',
      '--category', 'Trabalho',
      '--priority', 'alta',
      '--due-from', '2026-12-01',
      '--due-to', '2026-12-31',
      '--page', '2',
      '--limit', '10',
      '--sort', 'title',
      '--order', 'asc',
      '--token', 'abc',
    ], {}, capture().io, fetchFn);

    const url = new URL(fetchFn.mock.calls[0][0]);

    expect(url.pathname).toBe('/api/cli/records/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'relatório',
      category: 'Trabalho',
      priority: 'alta',
      due_from: '2026-12-01',
      due_to: '2026-12-31',
      page: '2',
      limit: '10',
      sort: 'title',
      order: 'asc',
    });
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer abc');
  });

  it('usa o token da variável TODO_TOKEN', async () => {
    const fetchFn = jest.fn().mockResolvedValue(page([]));

    await run(['search'], { TODO_TOKEN: 'token-env' }, capture().io, fetchFn);

    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer token-env');
  });

  it('retorna 1 quando a API rejeita a busca', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(
      reply(400, { message: 'Filtros inválidos' }),
    );

    expect(await run(['search', '--priority', 'urgente', '--token', 'abc'], {}, c.io, fetchFn)).toBe(1);
    expect(c.err).toEqual(['Erro HTTP 400 - Filtros inválidos']);
  });

  it('retorna 1 quando não há token e a API responde 401', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(
      reply(401, { message: 'Unauthorized' }),
    );

    expect(await run(['search'], { TODO_TOKEN: '' }, c.io, fetchFn)).toBe(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(c.err).toEqual(['Erro HTTP 401 - Unauthorized']);
  });
});


describe('run: list (listagem paginada e ordenada)', () => {
  const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
    reply(200, { items, total: items.length, page: 1, limit: 5, totalPages: 1, ...extra });

  it('chama GET /api/cli/records com o Bearer token e sem query quando não há opções', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(page([]));

    expect(await run(['list'], { TODO_TOKEN: 'token-teste' }, c.io, fetchFn)).toBe(0);
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/records');
    expect(fetchFn.mock.calls[0][1].method).toBe('GET');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer token-teste');
  });

  it('envia page, limit, sort e order na query string', async () => {
    const fetchFn = jest.fn().mockResolvedValue(page([]));

    await run(['list', '--page', '2', '--limit=10', '--sort', 'title', '--order', 'asc', '--token', 'abc'], {}, capture().io, fetchFn);
    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/cli/records');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', limit: '10', sort: 'title', order: 'asc' });
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer abc');
  });

  it('mostra a tabela com as colunas alinhadas e o resumo da página', async () => {
    const c = capture();
    const items = [
      { id: 12, title: 'Preparar apresentação', category: 'Estudo', priority: 'alta', due_date: '2026-12-30' },
      { id: 9, title: 'Comprar café', category: 'Pessoal', priority: 'baixa', due_date: null },
    ];
    const fetchFn = jest.fn().mockResolvedValue(page(items, { total: 7, page: 2, totalPages: 2 }));

    expect(await run(['list', '--token', 'abc'], {}, c.io, fetchFn)).toBe(0);
    expect(c.out).toEqual([
      [
        'ID  PRIORIDADE  CATEGORIA  PRAZO       TÍTULO',
        '12  alta        Estudo     2026-12-30  Preparar apresentação',
        '9   baixa       Pessoal    -           Comprar café',
        'Página 2 de 2 (total: 7)',
      ].join('\n'),
    ]);
  });

  it('avisa quando não há tarefas', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(page([], { totalPages: 1 }));

    expect(await run(['list', '--token', 'abc'], {}, c.io, fetchFn)).toBe(0);
    expect(c.out).toEqual(['Nenhuma tarefa encontrada.\nPágina 1 de 1 (total: 0)']);
  });

  it('trata resposta sem a lista de itens como página vazia', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { total: 0, page: 1, totalPages: 1 }));

    expect(await run(['list', '--token', 'abc'], {}, c.io, fetchFn)).toBe(0);
    expect(c.out[0]).toContain('Nenhuma tarefa encontrada.');
  });

  it('sem token ainda chama a API, que responde 401, e retorna 1', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(401, { message: 'Unauthorized' }));

    expect(await run(['list'], { TODO_TOKEN: '' }, c.io, fetchFn)).toBe(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(c.err).toEqual(['Erro HTTP 401 - Unauthorized']);
  });

  it('mostra os motivos quando a API rejeita os parâmetros', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(
      reply(400, { message: 'Parâmetros inválidos', errors: ['Limite deve ser um número inteiro de 1 a 100', 'Direção da ordenação deve ser asc ou desc'] }),
    );

    expect(await run(['list', '--limit', '500', '--order', 'up', '--token', 'abc'], {}, c.io, fetchFn)).toBe(1);
    expect(c.err).toEqual([
      'Erro HTTP 400 - Parâmetros inválidos: Limite deve ser um número inteiro de 1 a 100; Direção da ordenação deve ser asc ou desc',
    ]);
  });
});

describe('run: delete (exclusão por identificador)', () => {
  it('envia DELETE para /api/cli/records/{id} com o Bearer token e confirma a exclusão', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(200, { message: 'Registro excluído com sucesso', id: 7 }));

    expect(await run(['delete', '--id', '7'], { TODO_TOKEN: 'token-teste' }, c.io, fetchFn)).toBe(0);
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/records/7');
    expect(fetchFn.mock.calls[0][1].method).toBe('DELETE');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer token-teste');
    expect(c.out).toEqual(['Tarefa #7 excluída com sucesso.']);
  });

  it('aceita o atalho -i e o token pela opção --token', async () => {
    const fetchFn = jest.fn().mockResolvedValue(reply(200, {}));

    expect(await run(['delete', '-i', '3', '--token', 'manual'], {}, capture().io, fetchFn)).toBe(0);
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:3000/api/cli/records/3');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer manual');
  });

  it.each([[[]], [['--id', 'abc']], [['--id', '0']], [['--id', '-2']], [['--id', '1.5']]])(
    'retorna 2 sem chamar a API quando o ID é inválido (%j)',
    async (flags) => {
      const c = capture();
      const fetchFn = jest.fn();

      expect(await run(['delete', ...flags, '--token', 'abc'], {}, c.io, fetchFn as unknown as FetchFn)).toBe(2);
      expect(c.err).toEqual(['Informe o ID da tarefa a excluir usando --id.']);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('retorna 1 quando a tarefa não existe', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(404, { message: 'Registro 99 não encontrado' }));

    expect(await run(['delete', '--id', '99', '--token', 'abc'], {}, c.io, fetchFn)).toBe(1);
    expect(c.err).toEqual(['Erro HTTP 404 - Registro 99 não encontrado']);
    expect(c.out).toEqual([]);
  });

  it('sem token a API responde 401 e a CLI retorna 1', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(reply(401, { message: 'Unauthorized' }));

    expect(await run(['delete', '--id', '4'], { TODO_TOKEN: '' }, c.io, fetchFn)).toBe(1);
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(c.err).toEqual(['Erro HTTP 401 - Unauthorized']);
  });
});


describe('run: export (exportação CSV - issue #11)', () => {
  const outputPath = join(tmpdir(), 'todo-cli-export-issue11.csv');

  afterEach(async () => {
    await unlink(outputPath).catch(() => undefined);
  });

  it('exporta o CSV usando GET e salva no caminho informado', async () => {
    const c = capture();
    const csv = 'id,title,description\n1,Tarefa teste,Descrição\n';
    const fetchFn = jest.fn().mockResolvedValue(csvReply(200, csv));

    expect(
      await run(
        ['export', '--output', outputPath, '--token', 'token-teste'],
        {},
        c.io,
        fetchFn,
      ),
    ).toBe(0);

    expect(fetchFn.mock.calls[0][0]).toBe(
      'http://localhost:3000/api/cli/records/export',
    );
    expect(fetchFn.mock.calls[0][1].method).toBe('GET');
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer token-teste',
    );

    expect(await readFile(outputPath, 'utf8')).toBe(csv);
    expect(c.out).toEqual([`CSV exportado com sucesso: ${outputPath}`]);
    expect(c.err).toEqual([]);
  });

  it('envia os filtros combinados na query string', async () => {
    const fetchFn = jest.fn().mockResolvedValue(
      csvReply(200, 'id,title\n'),
    );

    await run(
      [
        'export',
        '--q', 'comprar café',
        '--category', 'Pessoal',
        '--priority', 'alta',
        '--due-from', '2026-11-01',
        '--due-to', '2026-11-30',
        '--output', outputPath,
        '--token', 'abc',
      ],
      {},
      capture().io,
      fetchFn,
    );

    const url = new URL(fetchFn.mock.calls[0][0]);

    expect(url.pathname).toBe('/api/cli/records/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'comprar café',
      category: 'Pessoal',
      priority: 'alta',
      due_from: '2026-11-01',
      due_to: '2026-11-30',
    });
  });

  it('retorna erro quando a API rejeita a autenticação', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(
      reply(401, { message: 'Unauthorized' }),
    );

    expect(
      await run(['export'], { TODO_TOKEN: '' }, c.io, fetchFn),
    ).toBe(1);

    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(c.err).toEqual(['Erro HTTP 401 - Unauthorized']);
  });

  it('exibe os motivos quando a API rejeita os filtros', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(
      reply(400, {
        message: 'Filtros inválidos',
        errors: ['Prioridade inválida'],
      }),
    );

    expect(
      await run(['export', '--priority', 'urgente'], {}, c.io, fetchFn),
    ).toBe(1);

    expect(c.err).toEqual([
      'Erro HTTP 400 - Filtros inválidos: Prioridade inválida',
    ]);
  });

  it('retorna erro quando não consegue salvar o arquivo', async () => {
    const c = capture();
    const fetchFn = jest.fn().mockResolvedValue(
      csvReply(200, 'id,title\n'),
    );

    const invalidPath = join(
      tmpdir(),
      'pasta-inexistente-issue11',
      'tarefas.csv',
    );

    expect(
      await run(
        ['export', '--output', invalidPath, '--token', 'abc'],
        {},
        c.io,
        fetchFn,
      ),
    ).toBe(1);

    expect(c.err[0]).toContain(
      `Não foi possível salvar o arquivo ${invalidPath}:`,
    );
  });
});

describe('run: ajuda lista os comandos das issues #9, #10 e #11', () => {
  it('menciona list, delete, search, export e suas opções', () => {
    for (const text of [
      'list',
      'delete',
      'search',
      'export',
      '--q',
      '--category',
      '--priority',
      '--due-from',
      '--due-to',
      '--page',
      '--limit',
      '--sort',
      '--order',
      '--output',
    ]) {
      expect(USAGE).toContain(text);
    }
  });
});