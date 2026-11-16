# To-Do List (Web + CLI)

Projeto da avaliação prática de Git e GitHub. Lista de tarefas com Web (React), API (NestJS) e banco (SQLite), tudo rodando exclusivamente por **Docker Compose**.

**Pré-requisitos no host:** apenas Docker e Docker Compose, além de navegador e terminal.

## Arquivos de produção

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Toda a Web (HTML, CSS e React via CDN embutidos): login, cadastro/edição, tabela, busca avançada e exportação CSV |
| `api.ts` | API NestJS: endpoints, autenticação e logs da API |
| `db.ts` | Acesso ao SQLite e logs da camada de banco |
| `cli.ts` | CLI: fala só com a API (`/api/cli/*`), nunca com o banco (issues #7, #8 e #9) |
| `README.md` | Execução e documentação de cada issue |

---

## Issue #1: Estrutura Web (início, login, logs e testes)

### Como iniciar a Web

```bash
docker compose up --build
```

Quando os logs mostrarem `API escutando na porta 3000`, abra **http://localhost:3000** no navegador.

Para parar: `Ctrl+C` (ou `docker compose down`).

Os dados ficam no volume `db-data`; para zerar tudo use:

```bash
docker compose down -v
```

### Usuário inicial e configuração

Existe um único usuário inicial, criado automaticamente na primeira execução. Ele é configurado por variáveis de ambiente (sem senha real no repositório):

| Variável | Padrão (só desenvolvimento) | Para que serve |
|---|---|---|
| `APP_USER` | `admin` | Nome do usuário inicial |
| `APP_PASSWORD` | `admin123` | Senha do usuário inicial (guardada com hash scrypt + salt) |
| `TOKEN_SECRET` | valor de exemplo no compose | Segredo que assina os tokens de login |

Para trocar, copie `.env.example` para `.env`, edite e suba de novo:

```bash
cp .env.example .env
docker compose up --build
```

Se o volume já existe, o usuário não é recriado. Use `docker compose down -v` para começar do zero.

### Como fazer login

**Pela tela:** abra http://localhost:3000, informe usuário e senha e clique em **Entrar**. Credenciais erradas mostram uma mensagem de erro (a API responde HTTP 401).

**Pela API:**

```bash
# healthcheck (público)
curl http://localhost:3000/api/web/health

# login: devolve {"token": "...", "username": "admin"}
curl -X POST http://localhost:3000/api/web/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# rota protegida: exige o token; sem ele (ou inválido) responde 401
curl http://localhost:3000/api/web/me \
  -H "Authorization: Bearer TOKEN"
```

---

## Issue #2: Cadastro e Edição de Tarefas (Web)

Nesta etapa foi implementado o cadastro e edição de tarefas (records) persistidos no SQLite com validação de campos e mensagens de erro na interface e na API.

### Campos do Formulário (5 campos, 4 obrigatórios)

| Campo | Tipo | Validação / Regras | Obrigatório |
|---|---|---|:---:|
| `title` | Texto | Entre 3 e 100 caracteres | **Sim** |
| `description` | Texto longo | Entre 3 e 500 caracteres | **Sim** |
| `category` | Seleção/Texto | Entre 2 e 50 caracteres (Ex: Trabalho, Estudo, Pessoal, Projetos, Geral) | **Sim** |
| `priority` | Seleção | Valores permitidos: `baixa`, `media` ou `alta` | **Sim** |
| `due_date` | Data | Formato `AAAA-MM-DD` válido | Não |

### Validações e Tratamento de Erros

- **Campos obrigatórios ou inválidos:** a API rejeita requisições com código **HTTP 400 (Bad Request)** e retorna um objeto contendo a lista de erros em `errors`:
  ```json
  {
    "message": "Dados inválidos",
    "errors": [
      "Título deve ter entre 3 e 100 caracteres",
      "Prioridade deve ser baixa, media ou alta"
    ]
  }
  ```
- **Na Web (`index.html`):** formulário valida antes do envio e exibe um alerta destacado com a lista de correções necessárias.
- **Autenticação:** todas as operações de cadastro e edição exigem token Bearer válido, respondendo **HTTP 401** caso contrário.
- **Registro não encontrado:** edição em ID inexistente responde **HTTP 404 (Not Found)**.

### Endpoints da Issue #2

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| POST | `/api/web/records` | Bearer token | Cadastra uma nova tarefa (retorna HTTP 201) |
| PUT | `/api/web/records/{id}` | Bearer token | Atualiza todos os dados de uma tarefa existente (retorna HTTP 200) |
| GET | `/api/web/records/{id}` | Bearer token | Consulta uma tarefa específica pelo identificador (retorna HTTP 200) |
| GET | `/api/web/records` | Bearer token | Lista as tarefas cadastradas (retorna HTTP 200) |

### Exemplos via cURL

```bash
# 1. Obter o token de autenticação
TOKEN=$(curl -s -X POST http://localhost:3000/api/web/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 2. Criar uma nova tarefa (POST /api/web/records)
curl -X POST http://localhost:3000/api/web/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Preparar apresentação",
    "description": "Gravar vídeo com os ciclos de integração e worktrees",
    "category": "Estudo",
    "priority": "alta",
    "due_date": "2026-11-20"
  }'

# 3. Editar a tarefa criada (PUT /api/web/records/1)
curl -X PUT http://localhost:3000/api/web/records/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "title": "Preparar apresentação do vídeo",
    "description": "Revisar roteiro e gravar apresentação",
    "category": "Projetos",
    "priority": "media",
    "due_date": "2026-11-22"
  }'

# 4. Exemplo de rejeição por validação (HTTP 400)
curl -X POST http://localhost:3000/api/web/records \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title": "ab"}'
```

---

## Issue #3: Listagem e Exclusão de Tarefas (Web)

Nesta etapa foi implementada a visualização das tarefas em tabela dinâmica e a funcionalidade de exclusão unitária e em lote, com carregamento direto do banco de dados SQLite ao abrir a página.

### Recursos da Interface Web (`index.html`)

- **Tabela com 4 campos visíveis principais:**
  1. **Título:** nome da tarefa acompanhado da descrição.
  2. **Categoria:** badge identificador da categoria (Trabalho, Estudo, Pessoal, etc.).
  3. **Prioridade:** badge estilizado e colorido por nível (`baixa`, `media`, `alta`).
  4. **Prazo:** data de vencimento formatada ou indicação de sem prazo.
- **Paginação de 5 em 5 itens:** exibe 5 registros por página, com botões "Anterior", "Próxima", contador de páginas e total geral de tarefas.
- **Ordenação dinâmica:** cabeçalhos da tabela clicáveis permitindo alternar entre ordenação crescente (▲) e decrescente (▼) por Título, Categoria, Prioridade, Prazo e ID.
- **Seleção e Exclusão:**
  - Checkbox de seleção por linha e checkbox "selecionar todos" no cabeçalho.
  - Barra de ações com botão "Excluir Selecionadas" para remoção em lote.
  - Botão individual "Excluir" por linha com confirmação antes da remoção.
- **Carregamento inicial:** dados carregados automaticamente do banco ao autenticar ou abrir a página com sessão ativa.

### Endpoints da Issue #3

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/web/records?page=1&limit=5&sort=id&order=desc` | Bearer token | Retorna registros paginados (5 itens/pág) e ordenados |
| DELETE | `/api/web/records/{id}` | Bearer token | Exclui uma tarefa do banco SQLite (HTTP 200; 404 se inexistente) |

### Exemplos via cURL

```bash
# 1. Listar tarefas paginadas (página 1, 5 itens, ordenadas por título)
curl -s "http://localhost:3000/api/web/records?page=1&limit=5&sort=title&order=asc" \
  -H "Authorization: Bearer $TOKEN"

# 2. Excluir uma tarefa por ID (DELETE /api/web/records/1)
curl -s -X DELETE http://localhost:3000/api/web/records/1 \
  -H "Authorization: Bearer $TOKEN"

# 3. Tentativa de exclusão de ID inexistente (retorna HTTP 404)
curl -s -X DELETE http://localhost:3000/api/web/records/99999 \
  -H "Authorization: Bearer $TOKEN"
```

---

## Issue #7: Estrutura CLI (comandos, token Bearer e logs)

A CLI (`cli.ts`) é um arquivo único que só conversa com a API por HTTP, nos endpoints próprios `/api/cli/*`. Ela **nunca** acessa o banco. Roda em contêiner, sem instalar nada no host.

### Como usar a CLI

```bash
# ajuda e lista de subcomandos
docker compose run --rm cli help

# healthcheck (público); sobe a API automaticamente se ela ainda não estiver rodando
docker compose run --rm cli health

# obtém o token Bearer e imprime só o token
docker compose run --rm cli token

# comando protegido: informe o token pela opção --token ou pela variável TODO_TOKEN
docker compose run --rm cli whoami --token SEU_TOKEN
```

Para guardar o token entre os comandos, use a variável de ambiente `TODO_TOKEN` (o Compose repassa ao contêiner da CLI). Na primeira vez rode `docker compose build` antes, para a saída do build não se misturar ao token:

```bash
# Linux / macOS / Git Bash
export TODO_TOKEN=$(docker compose run --rm -T cli token)
docker compose run --rm cli whoami

# PowerShell
$env:TODO_TOKEN = docker compose run --rm -T cli token
docker compose run --rm cli whoami
```

Sem token, ou com token inválido, a API responde **HTTP 401** e a CLI imprime `Erro HTTP 401` em stderr e sai com código 1.

### Subcomandos e opções

| Subcomando | Endpoint | Autenticação | O que faz |
|---|---|---|---|
| `help` | (nenhum) | não | Mostra a ajuda (também `-h` / `--help`) |
| `health` | `GET /api/cli/health` | pública | Imprime `{"status":"ok"}` |
| `token` | `POST /api/cli/token` | credenciais no corpo | Imprime o token Bearer |
| `whoami` | `GET /api/cli/me` | Bearer token | Imprime o usuário dono do token |

| Opção | Variável de ambiente | Padrão |
|---|---|---|
| `--api-url <url>` | `API_URL` | `http://app:3000` no Compose (`http://localhost:3000` fora dele) |
| `-u, --username <u>` | `CLI_USER` | `APP_USER` do Compose (`admin`) |
| `-p, --password <p>` | `CLI_PASSWORD` | `APP_PASSWORD` do Compose |
| `--token <token>` | `TODO_TOKEN` | vazio |

Códigos de saída: `0` sucesso, `1` erro da API ou de conexão, `2` uso incorreto (comando ou opção desconhecidos, credenciais ausentes). Prefira as variáveis de ambiente a `--password`, que fica visível no histórico do shell.

### Endpoints desta issue

| Método | Rota | Autenticação | Resposta |
|---|---|---|---|
| GET | `/api/cli/health` | pública | 200 `{"status":"ok"}` |
| POST | `/api/cli/token` | usuário e senha no corpo JSON | 200 `{"token":"...","username":"admin"}`; 401 se as credenciais forem inválidas |
| GET | `/api/cli/me` | Bearer token da CLI | 200 `{"username":"admin"}`; 401 sem token válido |

Esses endpoints são independentes dos `/api/web/*`: o token da CLI é emitido com audiência `cli` e **não vale** nos endpoints da Web (e o token da Web não vale nos da CLI). A consulta do usuário usa `Db.findCliUser`, própria da CLI.

### Logs da CLI

Cada chamada gera logs com `"client":"cli"`, na camada `api` e, quando acessa o banco (`token`), também na camada `db` com o **mesmo `request_id`**. Senhas e tokens nunca são registrados.

```bash
docker compose logs --no-log-prefix app | grep '"client":"cli"'
```

Exemplo do `token` (duas linhas, mesmo `request_id`):

```json
{"timestamp":"2026-11-15T23:58:28.855Z","level":"INFO","layer":"db","client":"cli","operation":"select_cli_user","status":"success","request_id":"7e0bb815-...","message":"Usuário da CLI encontrado"}
{"timestamp":"2026-11-15T23:58:28.905Z","level":"INFO","layer":"api","client":"cli","operation":"token","status":"success","request_id":"7e0bb815-...","message":"Token da CLI emitido"}
```

Falhas de autenticação aparecem como `WARN` (`operation` `token` ou `authenticate`). `health` só gera log na camada `api`, pois não acessa o banco.

---

## Issue #4: Busca Avançada (Web)

Barra de filtros acima da tabela. Os filtros se **combinam** (E lógico), a consulta é **assíncrona** (a tabela se atualiza sem recarregar a página) e o botão **Limpar filtros** volta à listagem completa.

### Como usar na tela

1. Entre em http://localhost:3000 (`docker compose up --build`) e faça login.
2. No cartão **Busca avançada**, preencha um ou mais filtros. A busca é enviada à API 300 ms depois da última alteração, volta para a página 1 e mantém paginação e ordenação.
3. A tabela mostra "Resultados da busca (N)". Se nada corresponder, aparece uma mensagem pedindo para ajustar ou limpar os filtros.
4. **Limpar filtros** zera todos os campos e recarrega a listagem completa.

### Filtros

| Filtro | Parâmetro | Como funciona |
|---|---|---|
| Texto | `q` | Procura no título **ou** na descrição, sem diferenciar maiúsculas; `%` e `_` valem como caracteres comuns. Até 100 caracteres |
| Categoria | `category` | Igualdade exata, sem diferenciar maiúsculas. Até 50 caracteres |
| Prioridade | `priority` | `baixa`, `media` ou `alta` |
| Prazo de | `due_from` | Prazo maior ou igual à data (`AAAA-MM-DD`) |
| Prazo até | `due_to` | Prazo menor ou igual à data (`AAAA-MM-DD`) |

Filtro vazio equivale a filtro ausente. Com filtro de prazo, tarefas **sem prazo** não aparecem. Os parâmetros `page`, `limit`, `sort` e `order` funcionam como na listagem; a página pedida nunca passa da última.

### Endpoint da Issue #4

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/web/records/search` | Bearer token | Busca com filtros combináveis. Devolve `{ items, total, page, limit, totalPages }` (HTTP 200); HTTP 400 com a lista `errors` se algum filtro for inválido; HTTP 401 sem token válido |

A rota `search` é declarada **antes** de `/api/web/records/{id}` para que o Nest não trate "search" como um identificador.

### Exemplos via cURL

```bash
# Obter o token (veja a seção da Issue #2)
TOKEN=$(curl -s -X POST http://localhost:3000/api/web/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# Texto + categoria + prioridade
curl "http://localhost:3000/api/web/records/search?q=relat&category=Estudo&priority=alta" \
  -H "Authorization: Bearer $TOKEN"

# Intervalo de prazo, ordenado pelo prazo
curl "http://localhost:3000/api/web/records/search?due_from=2026-12-01&due_to=2026-12-31&sort=due_date&order=asc" \
  -H "Authorization: Bearer $TOKEN"

# Filtro inválido: HTTP 400 {"message":"Filtros inválidos","errors":[...]}
curl -i "http://localhost:3000/api/web/records/search?priority=urgente" \
  -H "Authorization: Bearer $TOKEN"

# Sem token: HTTP 401
curl -i "http://localhost:3000/api/web/records/search?q=teste"
```

### Logs da busca

A busca gera uma linha na camada `api` e outra na camada `db`, com o **mesmo `request_id`**. O log do banco informa quais filtros foram usados (só os nomes, nunca os valores) e a página devolvida:

```bash
docker compose logs --no-log-prefix app | grep '"operation":"search_records"'
```

```json
{"timestamp":"2026-11-16T01:00:00.000Z","level":"INFO","layer":"db","client":"web","operation":"search_records","status":"success","request_id":"3f5c...","message":"2 registro(s) encontrado(s) (filtros: q, priority; página 1 de 1)"}
{"timestamp":"2026-11-16T01:00:00.001Z","level":"INFO","layer":"api","client":"web","operation":"search_records","status":"success","request_id":"3f5c...","message":"Busca retornou 2 registro(s) de 2"}
```

Filtros inválidos geram `WARN` na camada `api` (nesse caso não há acesso ao banco). Tokens e senhas nunca são registrados.

---

## Issue #9: Listagem e Exclusão pela CLI

Comandos `list` e `delete` na CLI (`cli.ts`). Como todos os comandos, eles só falam com a API, nos endpoints próprios `/api/cli/*`; a CLI **nunca** acessa o banco. O que a CLI lista ou exclui é o mesmo que a Web mostra.

### Como usar

Todos os comandos abaixo exigem o token da CLI, pela opção `--token` ou pela variável `TODO_TOKEN` (veja a seção da Issue #7).

```bash
# obtém o token e guarda em TODO_TOKEN (Linux / macOS / Git Bash; no PowerShell use $env:TODO_TOKEN = ...)
export TODO_TOKEN=$(docker compose run --rm -T cli token)

# lista a primeira página (5 tarefas, da mais recente para a mais antiga)
docker compose run --rm cli list

# segunda página, 10 por página, ordenada pelo título de A a Z
docker compose run --rm cli list --page 2 --limit 10 --sort title --order asc

# exclui a tarefa de ID 7
docker compose run --rm cli delete --id 7
```

Exemplo de saída do `list`:

```text
ID  PRIORIDADE  CATEGORIA  PRAZO       TÍTULO
12  alta        Estudo     2026-12-30  Preparar apresentação
9   baixa       Pessoal    -           Comprar café
Página 1 de 2 (total: 7)
```

Sem tarefas, a saída é `Nenhuma tarefa encontrada.` seguida do resumo. O `delete` imprime `Tarefa #7 excluída com sucesso.`.

### Comandos e opções

| Comando | Endpoint | O que faz |
|---|---|---|
| `list` | `GET /api/cli/records` | Lista as tarefas com paginação e ordenação |
| `delete` | `DELETE /api/cli/records/{id}` | Exclui a tarefa do ID informado |

| Opção | Vale para | Padrão | Descrição |
|---|---|---|---|
| `--page <n>` | `list` | `1` | Página (inteiro maior que zero). Se passar da última, a API devolve a última |
| `--limit <n>` | `list` | `5` | Tarefas por página, de 1 a 100 |
| `--sort <campo>` | `list` | `id` | `id`, `title`, `category`, `priority`, `due_date` ou `created_at` |
| `--order <asc\|desc>` | `list` | `desc` | Direção da ordenação |
| `-i, --id <id>` | `delete` | (obrigatória) | ID da tarefa (inteiro maior que zero) |
| `--token <token>` | `list`, `delete` | `TODO_TOKEN` | Token Bearer da CLI |

As opções também aceitam o formato `--opção=valor`. A ordenação por `priority` é alfabética (`alta`, `baixa`, `media`) e, em empate, vale o `id`. Com ordenação por `due_date` crescente, tarefas sem prazo vêm primeiro.

Códigos de saída: `0` sucesso; `1` erro da API (401, 404, 400) ou de conexão; `2` uso incorreto (por exemplo, `delete` sem um `--id` válido). Nos erros 400 da listagem, a CLI mostra o motivo de cada parâmetro inválido.

### Endpoints da Issue #9

| Método | Rota | Autenticação | Resposta |
|---|---|---|---|
| GET | `/api/cli/records` | Bearer token da CLI | 200 `{ items, total, page, limit, totalPages }`; 400 com a lista `errors` se `page`, `limit`, `sort` ou `order` forem inválidos; 401 sem token válido |
| DELETE | `/api/cli/records/{id}` | Bearer token da CLI | 200 `{ message, id }`; 400 se o ID não for inteiro positivo; 401 sem token válido; 404 se a tarefa não existir |

Os endpoints e as consultas SQL da CLI (`Db.listCliRecords` e `Db.deleteCliRecord`) são próprios; o token da Web não vale nessas rotas. As alterações feitas pela CLI aparecem na Web e vice-versa, porque os dois usam a mesma tabela `records`.

### Logs da Issue #9

Cada comando gera uma linha na camada `api` e outra na camada `db`, com o **mesmo `request_id`** e `"client":"cli"`. Tokens nunca são registrados.

```bash
docker compose logs --no-log-prefix app | grep -E '"operation":"(list_records|list_cli_records|delete_record|delete_cli_record)"' | grep '"client":"cli"'
```

```json
{"timestamp":"2026-11-16T03:00:00.000Z","level":"INFO","layer":"db","client":"cli","operation":"delete_cli_record","status":"success","request_id":"8a1e...","message":"Registro 7 excluído"}
{"timestamp":"2026-11-16T03:00:00.001Z","level":"INFO","layer":"api","client":"cli","operation":"delete_record","status":"success","request_id":"8a1e...","message":"Registro 7 excluído com sucesso"}
```

Parâmetros ou ID inválidos geram `WARN` apenas na camada `api` (não há acesso ao banco); tarefa inexistente gera `WARN` nas duas camadas.

---


## Issue #5: Exportação CSV (Web)

Funcionalidade de exportação de tarefas para arquivo CSV (`.csv`) com base nos filtros atualmente aplicados na busca avançada:
- **Botão na interface Web:** Botão **📥 Exportar CSV** localizado na barra de busca avançada;
- **Endpoint dedicado:** `GET /api/web/records/export` com headers `Content-Type: text/csv; charset=utf-8` e `Content-Disposition: attachment; filename="tarefas.csv"`;
- **Escopo completo:** Exporta **todos os resultados filtrados**, não apenas a página atual de 5 itens. Se nenhum filtro estiver ativo, exporta todos os registros cadastrados;
- **Padrão RFC 4180:** Todos os campos são devidamente formatados e valores com aspas duplas (`"`), vírgulas (`,`) ou quebras de linha são envolvidos em aspas e tratados (`""`).

### Campos do CSV

O arquivo exportado contém a linha de cabeçalho seguida das linhas de dados:
```csv
id,title,description,category,priority,due_date,created_at,updated_at
```

### Endpoint da Issue #5

| Método | Rota | Autenticação | Descrição |
|---|---|---|---|
| GET | `/api/web/records/export` | Bearer token (Web) | Exporta tarefas em CSV (com query params de filtro opcionais: `q`, `category`, `priority`, `due_from`, `due_to`) |

### Exemplos via cURL

```bash
# Obter o token
TOKEN=$(curl -s -X POST http://localhost:3000/api/web/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# Exportar todos os registros (sem filtros)
curl -i "http://localhost:3000/api/web/records/export" \
  -H "Authorization: Bearer $TOKEN" \
  -o tarefas.csv

# Exportar com filtros combinados (ex.: categoria e prioridade)
curl -i "http://localhost:3000/api/web/records/export?category=Estudo&priority=alta" \
  -H "Authorization: Bearer $TOKEN" \
  -o tarefas_estudo_alta.csv

# Sem token: responde HTTP 401
curl -i "http://localhost:3000/api/web/records/export"
```

### Logs da exportação CSV

Gera logs estruturados correlacionados entre a API e o banco com o mesmo `request_id`:

```bash
docker compose logs --no-log-prefix app | grep '"operation":"export_csv"'
```

```json
{"timestamp":"2026-11-16T02:20:00.000Z","level":"INFO","layer":"db","client":"web","operation":"export_csv","status":"success","request_id":"c4b2...","message":"4 registro(s) exportado(s) para CSV (filtros: category, priority)"}
{"timestamp":"2026-11-16T02:20:00.001Z","level":"INFO","layer":"api","client":"web","operation":"export_csv","status":"success","request_id":"c4b2...","message":"Exportação CSV gerada com 4 registro(s)"}
```

Filtros inválidos geram `WARN` na camada `api` com HTTP 400. Tokens e senhas nunca são registrados.

---

---

## Issue #10: Busca Avançada pela CLI

Implementação do comando `search` para realizar buscas avançadas de tarefas pela CLI, utilizando o endpoint próprio `/api/cli/records/search`. Os filtros podem ser combinados e seguem as mesmas regras da busca avançada Web (Issue #4).

### Como usar

Todos os comandos exigem um token Bearer da CLI, informado por `--token` ou pela variável `TODO_TOKEN`.

```bash
# Busca por texto no título ou descrição
docker compose run --rm cli search --q relatorio

# Combina texto, categoria e prioridade
docker compose run --rm cli search --q relatorio --category Estudo --priority alta

# Busca por intervalo de prazo
docker compose run --rm cli search --due-from 2026-12-01 --due-to 2026-12-31

# Combina filtros com paginação e ordenação
docker compose run --rm cli search --category Trabalho --page 2 --limit 10 --sort title --order asc

# Informa o token diretamente
docker compose run --rm cli search --q relatorio --token SEU_TOKEN
```

### Filtros e opções

| Opção CLI | Parâmetro da API | Descrição |
|---|---|---|
| `--q <texto>` | `q` | Procura no título ou na descrição |
| `--category <categoria>` | `category` | Filtra por categoria exata |
| `--priority <prioridade>` | `priority` | Filtra por `baixa`, `media` ou `alta` |
| `--due-from <data>` | `due_from` | Prazo inicial (`YYYY-MM-DD`) |
| `--due-to <data>` | `due_to` | Prazo final (`YYYY-MM-DD`) |
| `--page <n>` | `page` | Página dos resultados (padrão 1) |
| `--limit <n>` | `limit` | Resultados por página, de 1 a 100 (padrão 5) |
| `--sort <campo>` | `sort` | Ordenação por `id`, `title`, `category`, `priority`, `due_date` ou `created_at` |
| `--order <asc\|desc>` | `order` | Direção da ordenação (padrão `desc`) |

Os filtros são combinados por lógica **E**. Opções vazias equivalem a filtros ausentes. A busca retorna os resultados paginados e ordenados no mesmo formato da listagem.

### Endpoint da Issue #10

| Método | Rota | Autenticação | Resposta |
|---|---|---|---|
| GET | `/api/cli/records/search` | Bearer token da CLI | 200 `{ items, total, page, limit, totalPages }`; 400 com a lista `errors` se algum filtro for inválido; 401 sem token válido |

A implementação reutiliza `Db.searchRecords`, compartilhando a lógica de consulta com a busca Web, mas registra a origem como `client: "cli"`. A CLI continua acessando exclusivamente a API REST, sem conexão direta com o banco.

### Logs da busca

Cada busca gera logs na camada `api` e, quando consulta o banco, na camada `db`, com `client: "cli"` e o mesmo `request_id`.

```bash
docker compose logs --no-log-prefix app | grep '"operation":"search_records"' | grep '"client":"cli"'
```

Filtros inválidos geram `WARN` na camada `api` e retornam HTTP 400. Tokens nunca são registrados nos logs.

## Issue #6 — Dashboard de Indicadores (Web)

O Dashboard fornece uma visualização agregada e em tempo real do estado das tarefas no sistema To-Do, consumindo métricas computadas diretamente no banco SQLite através da API REST.

### Indicadores e Gráficos

O Dashboard apresenta 3 indicadores visuais com dados reais:

1. **Cumprimento de Prazo (Status de Entrega)**:
   - **Em dia / No prazo**: Tarefas cuja data de entrega (`due_date`) é igual ou posterior ao dia de hoje (ou tarefas sem prazo de vencimento definido).
   - **Atrasadas**: Tarefas cuja data limite (`due_date`) é anterior à data de hoje (`YYYY-MM-DD`).
   - Mostra o total de tarefas e as barras proporcionais com contagem e percentual.

2. **Distribuição por Prioridade**:
   - Quantidade e proporção de tarefas classificadas em **Alta**, **Média** e **Baixa** prioridade.
   - Permite identificar gargalos de tarefas críticas no fluxo de trabalho.

3. **Distribuição por Categoria**:
   - Quantidade e proporção de tarefas agrupadas por cada categoria existente cadastrada no banco.
   - Permite visualizar o equilíbrio de tarefas entre diferentes áreas (ex: Trabalho, Estudos, Pessoal).

### Atualização dos Indicadores

Os valores do dashboard são mantidos sincronizados através de:
- Carregamento automático ao entrar na tela inicial da aplicação web.
- Botão interativo **🔄 Recarregar**, que efetua uma nova chamada ao endpoint `GET /api/web/dashboard`.
- Atualização reativa sempre que uma tarefa for adicionada, editada ou excluída na interface.

### Endpoint da API

| Método | Rota | Autenticação | Resposta de Sucesso | Erros |
|---|---|---|---|---|
| `GET` | `/api/web/dashboard` | Bearer token (`aud: "web"`) | `200 OK` com payload JSON contendo `total`, `byStatus`, `byPriority` e `byCategory` | `401 Unauthorized` se o token estiver ausente, expirado ou for destinado a outro cliente |

#### Exemplo de Resposta JSON:

```json
{
  "total": 5,
  "byStatus": {
    "em_dia": 4,
    "atrasada": 1
  },
  "byPriority": {
    "baixa": 1,
    "media": 2,
    "alta": 2
  },
  "byCategory": [
    { "category": "Trabalho", "count": 3 },
    { "category": "Estudos", "count": 2 }
  ]
}
```

#### Exemplo de Chamada via cURL:

```bash
# Obter métricas do dashboard via Web API
curl -X GET http://localhost:3000/api/web/dashboard \
  -H "Authorization: Bearer $WEB_TOKEN"
```

### Logs Estruturados e Correlação

A consulta ao dashboard gera logs estruturados no padrão JSON em stdout com correlação de `request_id` entre as camadas `api` e `db`:

```json
{"timestamp":"2026-11-16T01:00:00.000Z","level":"INFO","layer":"db","client":"web","operation":"dashboard_stats","status":"success","request_id":"c6f3e1b0-...","message":"Estatísticas do dashboard recuperadas com sucesso"}
{"timestamp":"2026-11-16T01:00:00.005Z","level":"INFO","layer":"api","client":"web","operation":"dashboard_stats","status":"success","request_id":"c6f3e1b0-...","message":"Dashboard carregado com 5 registros"}
```

---

## Logs e Correlação

Cada operação gera **uma linha JSON por evento** no stdout, uma na camada `api` e outra na camada `db` (quando acessa o banco), com o **mesmo `request_id`**:

```bash
docker compose logs app
docker compose logs -f app
docker compose logs --no-log-prefix app | grep -E '"operation":"(create_record|insert_record|update_record)"'
```

Campos: `timestamp` (ISO 8601 UTC), `level` (`INFO`/`WARN`/`ERROR`), `layer` (`api`/`db`), `client` (`web`/`cli`), `operation`, `status` (`success`/`error`), `request_id` e `message`.

Exemplo de logs de criação correlacionados:

```json
{"timestamp":"2026-11-14T21:30:00.000Z","level":"INFO","layer":"db","client":"web","operation":"insert_record","status":"success","request_id":"550e8400...","message":"Registro 1 inserido com sucesso"}
{"timestamp":"2026-11-14T21:30:00.015Z","level":"INFO","layer":"api","client":"web","operation":"create_record","status":"success","request_id":"550e8400...","message":"Registro 1 criado com sucesso"}
```

---

## Testes e Cobertura de Código

Execução integral via contêiner Docker:

```bash
docker compose run --rm test
```

Roda o Jest dentro do contêiner e afere a cobertura. A execução **exige 100% de cobertura de linhas** nos arquivos de produção existentes (`api.ts`, `db.ts` e `cli.ts`).

---

## Estrutura de Apoio

`Dockerfile`, `docker-compose.yml`, `package.json`, `tsconfig.json`, `jest.config.js`, `tests/*.spec.ts`, `.gitignore`, `.dockerignore`, `.env.example` e `.github/PULL_REQUEST_TEMPLATE.md` são arquivos auxiliares (infraestrutura, configuração, testes e template de PR).
