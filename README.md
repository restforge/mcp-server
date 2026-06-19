# @restforgejs/mcp-server

MCP (Model Context Protocol) server for the RESTForge Platform. Exposes RESTForge capabilities to AI Agents (Claude Desktop, Cursor, Claude CLI, and other MCP clients) so agents can operate RESTForge through natural language without manually invoking CLI commands.

> **Scope Notice:** This MCP server is a thin orchestrator that exposes RESTForge Platform commands to AI agents via the Model Context Protocol. It is not a generic MCP framework, an API testing tool, an API client, or an HTTP request proxy. Its tools strictly invoke RESTForge Platform CLI commands; it does not consume or test arbitrary third-party APIs.

## Requirements

- Node.js >= 20
- npm >= 9
- For full setup workflow: PostgreSQL / MySQL / Oracle, RESTForge license key

## Access & License

This MCP server package (`@restforgejs/mcp-server`) is distributed under the **MIT License** and may be installed and inspected freely.

The MCP server orchestrates the **RESTForge Platform** (`@restforgejs/platform`), which is **commercial software currently in closed evaluation**. Full workflow execution (setup validation, code generation, runtime launch) requires a valid RESTForge license key.

License key acquisition:

- **Early Access Program** — Limited slots for volunteer evaluators. Apply at [restforge.dev](https://restforge.dev)
- **Commercial Trial** — Coming soon. Register interest at [restforge.dev](https://restforge.dev)
- **Commercial License** — Available upon general release

Without a valid license key, MCP tools that depend on the platform runtime (e.g. `setup_validate_config`, `codegen_*`, `runtime_*`) will return authentication errors.

## Installation

```bash
npm install -g @restforgejs/mcp-server
```

After installation, the `restforge-mcp` command is available in PATH.

## Quick Start

### 1. Verify Install

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | restforge-mcp
```

Output should list 39 tools across the `health_*`, `setup_*`, `codegen_*`, and `runtime_*` domains.

### 2. Register with MCP Client

**Claude CLI** (user scope, applies to all projects):

```bash
claude mcp add --transport stdio --scope user restforge -- restforge-mcp
```

**Cursor** (`.cursor/mcp.json` in project root):

```json
{
  "mcpServers": {
    "restforge": {
      "command": "restforge-mcp"
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "restforge": {
      "command": "restforge-mcp"
    }
  }
}
```

### 3. Use via Natural Language

In your AI client chat, type prompts like:

> Setup a new RESTForge project at `d:/projects/api-test` with PostgreSQL on localhost:5432, license `XXXX-XXXX-XXXX-XXXX`

> Generate a CRUD endpoint for the `customer` table

> Start my RESTForge project (the agent generates a launcher script for the user to execute)

The agent orchestrates the appropriate tools to fulfill the request end-to-end.

## Available Tools

39 tools organized by domain. AI agents call these via the MCP protocol; end users do not invoke them directly.

### Health Domain (1 tool)

| Tool | Description |
|------|-------------|
| `health_ping` | Smoke test MCP transport. Returns `pong` + ISO timestamp + server version |

### Setup Domain (9 tools)

| Tool | Description |
|------|-------------|
| `setup_create_folder` | Create a new project folder for RESTForge |
| `setup_install_package` | Install `@restforgejs/platform` into the project's `node_modules` via npm |
| `setup_init_config` | Generate skeleton config and sample payloads via `restforge init` |
| `setup_write_env` | Write `config/db-connection.env` with license, server, and database settings |
| `setup_read_env` | Read current values from `config/db-connection.env` |
| `setup_update_env` | Update individual fields in `config/db-connection.env` |
| `setup_validate_config` | Validate license and connections to database, redis, and kafka |
| `setup_get_config_schema` | Get JSON schema of all 63 parameters available in `db-connection.env` |
| `setup_get_init_template` | Get raw `db-connection.env` template content |

### Codegen Domain (23 tools)

Live database introspection:

| Tool | Description |
|------|-------------|
| `codegen_list_tables` | List all tables in the project's database (live introspection) |
| `codegen_describe_table` | Describe columns, primary key, and foreign keys of a specific table |

Schema-as-code (dbschema-kit / SDF):

| Tool | Description |
|------|-------------|
| `codegen_dbschema_init` | Create a new dbschema-kit schema definition skeleton file (minimal starter) |
| `codegen_dbschema_template` | Browse, preview, and generate from the Schema Reference collection (87 templates across 30+ domains) |
| `codegen_dbschema_validate` | Validate dbschema-kit definition files (single-model structure + cross-model FK checks) |
| `codegen_dbschema_models` | List dbschema-kit models with a structural summary (fields, keys, indexes, relations) |
| `codegen_dbschema_introspect` | Reverse-engineer an existing database into dbschema-kit definition files |
| `codegen_dbschema_generate_ddl` | Generate dialect-specific DDL (CREATE TABLE/INDEX, optional DROP) from dbschema-kit files |
| `codegen_dbschema_migrate` | Apply dbschema-kit files to a live database (load → validate → DDL → apply; DESTRUCTIVE with `drop=true`) |
| `codegen_dbschema_diff` | Detect schema drift between dbschema-kit files and the live database (read-only, bidirectional) |
| `codegen_dbschema_apply` | Resolve schema drift to the live database via incremental `ALTER` (additive-only by default; opt-in destructive) |

Payload, scaffolding, and SQL:

| Tool | Description |
|------|-------------|
| `codegen_generate_payload` | Generate payload JSON from a database table |
| `codegen_validate_payload` | Validate payload JSON structure and constraints |
| `codegen_validate_dashboard_payload` | Validate dashboard payload structure |
| `codegen_diff_payload` | Diff payload JSON against the database schema |
| `codegen_sync_payload` | Sync payload JSON with the database schema |
| `codegen_create_endpoint` | Scaffold an endpoint module from a payload spec |
| `codegen_create_dashboard` | Scaffold a dashboard module from a payload spec |
| `codegen_validate_sql` | Validate a SELECT or WITH (CTE) SQL statement via EXPLAIN against the live database |

Grounding catalogs:

| Tool | Description |
|------|-------------|
| `codegen_get_field_validation_catalog` | Get the field validation catalog (for grounding payload constraints) |
| `codegen_get_query_declarative_catalog` | Get the query declarative catalog (for grounding query JSON) |
| `codegen_get_dashboard_catalog` | Get the dashboard widget catalog (for grounding dashboard config) |
| `codegen_get_dbschema_catalog` | Get the dbschema (SDF) catalog: model options, field types, and the soft-delete contract (for grounding schema definition files) |

### Runtime Domain (6 tools)

| Tool | Description |
|------|-------------|
| `runtime_detect_project` | Scan `src/modules/*.js` to list project names |
| `runtime_detect_config` | Scan `config/*.env` to list available config files |
| `runtime_validate_preflight` | Validate config + check PID file + check port availability before launch |
| `runtime_check_launcher_exists` | Check if launcher files (`server-start.bat`/`.sh`, `ecosystem.config.js`) exist in the project root |
| `runtime_generate_launcher` | Generate `server-start.bat`/`.sh` + `server-stop.bat`/`.sh` (and `ecosystem.config.js` for PM2 mode) |
| `runtime_check_status` | Detect if the server is running (host or PM2 mode) with optional HTTP health probe |

> **Runtime principle**: AI agents never start, stop, or restart the server directly. The runtime tools only generate launcher scripts that the user executes themselves, so the running server lives independently of the AI session.

## Compatibility

This MCP server works with any MCP client that supports the stdio transport, including but not limited to:

- Claude Desktop
- Claude CLI (Claude Code)
- Cursor
- Windsurf
- Cline (VS Code extension)
- Continue (VS Code/JetBrains extension)
- Zed

The model used (Claude, GPT, Gemini, etc.) depends on the client configuration. Tool selection accuracy is best with frontier models that have mature tool-calling support.

## Repository

- Source: [https://github.com/restforge/mcp-server](https://github.com/restforge/mcp-server)
- Issues: [https://github.com/restforge/mcp-server/issues](https://github.com/restforge/mcp-server/issues)

## License

MIT — see [LICENSE.md](LICENSE.md).
