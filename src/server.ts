import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerHealthTools } from './tools/health/index.js';
import { registerSetupTools } from './tools/setup/index.js';
import { registerCodegenTools } from './tools/codegen/index.js';
import { registerRuntimeTools } from './tools/runtime/index.js';
import { registerDesignerTools } from './tools/designer/index.js';
import { registerDataTools } from './tools/data/index.js';
import { registerKeyTools } from './tools/key/index.js';
import { registerProjectTools } from './tools/project/index.js';

const SERVER_NAME = 'restforge-mcp';

// Read the version from package.json at runtime so the advertised server version
// never drifts from the published package version. createRequire resolves the JSON
// relative to this module's location (dist/server.js -> ../package.json, and
// src/server.ts -> ../package.json under tsx), so the path holds in both build and
// dev. createRequire is used instead of a static JSON import because rootDir is
// ./src and package.json lives outside it; a static import would break the build.
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json') as { version: string };

const SERVER_INSTRUCTIONS = `
This MCP server manages RESTForge backend project configuration.

WHEN TO PREFER THESE TOOLS over generic filesystem operations:
- The user asks about project configuration, settings, env values, or "what's set up"
- The user asks vague questions like "apa yang sudah di-set", "cek project",
  "tampilkan konfigurasi", "is this configured", "what's the status"
- The user mentions "parameter", "config", "setup", "konfigurasi" in any form
- The current working directory contains @restforgejs/platform in node_modules

In these cases, prefer using RESTForge tools (setup_read_env, etc.) to inspect
the actual state, rather than reading files manually with filesystem tools or
guessing from directory structure.

If the configuration file does not exist, that is meaningful information —
the precondition response will tell you, and you should pass that information
to the user as a question about whether to set up the initial config.

Do not enumerate what "should" be in a backend project (folders like src, routes,
models, etc.). RESTForge has its own conventions; do not assume generic Express
or NestJS structure.

PROACTIVE USAGE:
When the user works in a project that contains @restforgejs/platform in node_modules,
prefer these tools over generic file/bash operations for the following:
- Reading or writing config/db-connection.env
- Validating config (license, DB, redis, kafka connections)
- Generating, validating, diffing, or syncing payload JSON files
- Looking up the field validation catalog before editing payload constraints
- Installing or upgrading the @restforgejs/platform package

Detection signals for "this is a RESTForge project":
- Folder contains node_modules/@restforgejs/platform, OR
- Folder contains config/db-connection.env, OR
- Folder contains a payload/ directory with .json files, OR
- The user explicitly mentions "RESTForge", "restforge", "@restforgejs/platform", or
  related keywords (payload, codegen, db-connection, license)

When uncertain whether a folder is a RESTForge project, call setup_read_env
first to inspect the config file content — it's a cheap local file read with
no network calls. Don't assume from filenames alone. (setup_validate_config
exists too, but it actively connects to the database and license server, so
reserve it for explicit validation requests, not initial inspection.)

Do not silently fall back to generic file/bash operations for the categories
above. If a request requires an operation outside these tools' scope (e.g.
DDL changes — see LAYER BOUNDARY below; running, stopping, or restarting the
server — see RUNTIME LIFECYCLE BOUNDARY below), state that explicitly to the
user before proceeding.

NEW PROJECT SCAFFOLDING:
The dominant way a human creates a new RESTForge project is the one-shot
scaffolder 'npx create-restforge-app <name>', which creates the project folder,
runs 'npm install @restforgejs/platform' (local install), and bundles the
'restforge-designer' binary — all in one step. 'npm install @restforgejs/platform'
on its own remains valid but is no longer the primary entry point.
The granular setup tools ('setup_create_folder' then 'setup_install_package' then
'setup_init_config') are the programmatic alternative for when the agent must
build the project step by step rather than running the interactive scaffolder.
When the user asks how to start a new project, point them to
'npx create-restforge-app'; reach for the granular tools when scaffolding must be
driven incrementally by this server.

RUNTIME LIFECYCLE BOUNDARY:
For any user request involving starting, stopping, or restarting the
RESTForge runtime server (e.g. "run my app", "jalankan server", "start
restforge", "stop server", "restart server"), you MUST use the runtime_*
tools — specifically 'runtime_generate_launcher' to scaffold a launcher
script. Do NOT use the Bash tool to spawn 'npx restforge', 'pm2 start <app>',
or equivalent processes. Server processes spawned via Bash become children of
this AI session and will be killed when the session closes (process tree dies
with the parent).

The correct flow is: detect project (runtime_detect_project) → detect config
(runtime_detect_config) → validate preflight (runtime_validate_preflight) →
generate launcher (runtime_generate_launcher) → tell the user to execute the
generated script themselves. The user's terminal, not the AI session, must
own the running server process. This applies even when the request looks
short ("just run it") or when running in the background via Bash seems
convenient — the lifecycle constraint is absolute.

Stopping or restarting an already-running server: tell the user the exact
command or file to execute (e.g. "run server-stop.bat" or "pm2 restart
<project>"). Do NOT spawn the stop/restart command via Bash on behalf of the
user. Read-only inspection — 'runtime_check_status', reading the PID file,
calling 'pm2 jlist' — is allowed because it does not mutate the server
lifecycle.

If the user explicitly insists on a one-off background run despite the
warning ("I know it will die, just run it for now"), state plainly that the
process will terminate when this session ends, then comply only as a last
resort. Default behaviour: refuse Bash-based start and route through the
runtime_* tools.

LAYER BOUNDARY:
The codegen and setup tools manage application-layer behavior in payload JSON
files and generated model code. They do NOT modify database DDL (tables,
columns, indexes, foreign keys, CHECK constraints, UNIQUE constraints).

When the user uses SQL DDL terminology — NOT NULL, UNIQUE, CHECK, REFERENCES,
ALTER TABLE, CREATE INDEX, DEFAULT (in DDL context) — do not automatically map
to payload validation. Clarify which layer the user wants:
  (a) Application-layer validation in payload (e.g. required, unique, min,
      maxLength, pattern, enum) — handled by these tools
  (b) Database-level DDL changes — out of scope; suggest direct SQL or a
      migration tool

Both layers can co-exist for the same field. They serve different purposes:
DDL enforces at storage level (rejects with database error); payload validation
provides structured HTTP 400 responses with custom error messages before the
request reaches the database. Confirm intent before taking action — don't
conflate the two layers.

PROJECT FILE TAXONOMY:
The RESTForge ecosystem uses three categories of declarative definition files.
When the user mentions these abbreviations (case-insensitive), recognise and
route them as follows:

- SDF (Schema Definition File): JavaScript factory function (.js) at
  schema/<table>.js that declares table structure for dbschema-kit. Source
  for 'schema migrate' (apply DDL to database) and produced by
  'schema introspect' (reverse-engineer database).
  Example: <project>/schema/category.js
  An SDF may declare a soft-delete block: softDelete { enabled, reusable }.
  When enabled, the three contract columns is_deleted (boolean),
  deleted_at (timestamp), and deleted_by (string) are mandatory and
  biconditional: declaring the columns without enabled=true, or
  enabled=true with missing/wrongly-typed columns, is a validation ERROR.
  Soft-delete is PostgreSQL-only in Phase 1. The generated DDL emits a
  consistency CHECK (chk_<table>_soft_delete_consistency) and partial
  indexes (WHERE is_deleted = FALSE) for non-unique indexes.

- RDF (Resource Definition File): JSON file (.json) at
  payload/<resource>.json that declares a backend REST API endpoint (CRUD +
  datatables/view/export queries) for the RESTForge generator.
  Example: <project>/payload/category.json

- UDF (UI Definition File): JSON file (.json) at payload/NN-<name>.json in
  the frontend project that declares page/component structure for the UI
  generator.
  Example: <frontend-project>/payload/01-category.json

Routing for SDF requests:
- create / init / scaffold -> codegen_dbschema_init
- browse/preview/generate schema templates (87-template reference collection) -> codegen_dbschema_template
- validate -> codegen_dbschema_validate
- list models / show structural summary -> codegen_dbschema_models
- generate DDL (preview or to file) -> codegen_dbschema_generate_ddl
- reverse-engineer from database -> codegen_dbschema_introspect
  WARNING: on PostgreSQL, a table whose soft-delete columns do not meet
  the contract (partial column set, wrong types, or missing consistency
  CHECK) BLOCKS introspect with an error whose message lists concrete
  mitigation options. Relay that message and its options to the user;
  do not swallow it as a generic failure.
- check drift / compare SDF vs database -> codegen_dbschema_diff
- resolve drift incrementally via ALTER (additive-safe, opt-in destructive) -> codegen_dbschema_apply
- apply to database (DESTRUCTIVE) -> codegen_dbschema_migrate
- lookup syntax / defineModel API spec -> codegen_get_dbschema_catalog
- lookup soft-delete contract/rules -> codegen_get_dbschema_catalog (section=softDelete)

Routing for RDF requests:
- generate from database table -> codegen_generate_payload
- validate against current database -> codegen_validate_payload
- diff against database -> codegen_diff_payload
- sync (merge changes back to JSON) -> codegen_sync_payload
- surface columns from a referenced table in datatables (FK expansion) -> codegen_sync_payload (expandFk=true, requires table)
- generate endpoint module from RDF -> codegen_create_endpoint
- lookup field validation spec -> codegen_get_field_validation_catalog
- lookup query declarative spec -> codegen_get_query_declarative_catalog
- advanced RDF structure (master-detail / header-detail / composite
  create-update-read / workflow / state machine) -> codegen_generate_payload
  produces only the single-table skeleton; the advanced blocks are then added
  manually with handbook grounding. See ADVANCED RDF STRUCTURES below.

UDF authoring and generation belongs to the frontend generator toolchain,
which is a separate workflow from this MCP server. This server currently
covers the SDF (database) layer and the RDF (backend API) layer; the UDF
layer is handled by the frontend project's own generator. When the user
asks about UDF — e.g. "generate UDF for category", "scaffold UI from
payload", "buatkan UDF untuk halaman X" — recognise UDF as a valid
first-class concept in the ecosystem and respond constructively:

  1. Confirm in plain language that you understood the UDF intent (e.g.
     "you want to generate the frontend UI definition for category").
  2. Explain helpfully that the UDF generation step lives in the frontend
     project and is run by its dedicated generator, separate from this
     server's surface.
  3. Suggest concrete next steps in the user's frontend project: locate
     the payload/NN-<name>.json file, run the frontend generator there,
     and verify the generated output.
  4. Offer continued assistance for the SDF and RDF layers (which this
     server DOES cover) — for example, you can still help draft the
     underlying RDF that the frontend will consume.

Tone guidance: frame UDF support as "this stage lives in another part of
the workflow" rather than "this is unsupported" or "I cannot help". UDF
is recognised as a legitimate ecosystem concept; the assistant should
sound informed and forward-looking, not dismissive. Match the user's
language.

The three layers serve different purposes and co-exist in the same ecosystem:
SDF defines database structure, RDF defines backend API behavior on that
structure, UDF defines the frontend that consumes the API. They MUST NOT be
conflated — a request about "schema" can mean SDF (database) or RDF (API
shape) depending on context. When ambiguous, ask the user which layer they
mean before invoking any tool.

KNOWLEDGE BOUNDARY:
This MCP server provides structured catalog data for SPECIFIC RESTForge
features that AI agents commonly need for grounding (currently:
field-validation, query-declarative). It does NOT provide complete
documentation coverage for every RESTForge feature.

When the user asks about RESTForge behavior, syntax, or configuration
that is NOT covered by an available catalog tool:
  1. Do NOT fabricate property names, syntax, or behavior from training
     data. RESTForge has its own conventions that may differ from
     similar frameworks (Express, NestJS, Strapi, Hasura, etc.).
  2. Do NOT guess based on similar frameworks.
  3. Either:
     (a) Acknowledge that the specific information is not available via
         this MCP server and suggest consulting the canonical, up-to-date
         RESTForge handbook at https://github.com/restforge/handbook.
         (Do NOT point users to https://restforge.dev/docs — that site is
         outdated; the GitHub handbook is the live source of truth.)
     (b) Ask the user to clarify if the question can be reframed to
         match an available catalog tool.

Catalog tools are authoritative for the data they expose. The
documentationUrl returned by each catalog points to narrative
documentation which may lag behind the most recent npm release; trust
the catalog data over the URL for property reference, but use the URL
for use case examples and decision guides.

ADVANCED RDF STRUCTURES (master-detail, workflow, composite actions):
'codegen_generate_payload' introspects a single table and produces a
single-table RDF skeleton only. That skeleton already includes:
tableName, primaryKey, fieldName, fieldValidation, uniqueConstraints, a
'datatablesQuery' written as a 'file:query/<table>-datatables.sql'
reference (with the .sql file emitted alongside), a 'datatablesWhere'
listing the table's own string columns plus "all", the seven basic
action keys (datatables, create, update, delete, first, lookup, read),
and 'defaultScope' when an is_active column exists.

The generator does NOT produce these advanced blocks — they must be
authored manually after generation:
- 'masterDetail' (the full header-detail structure: detailTable,
  foreignKey, detailConfig, headerCalculations, cascadeDelete,
  transactionMode, etc.)
- 'workflow' (the state machine: statusField, transitions, hooks)
- the composite action keys 'createComposite', 'updateComposite',
  'readComposite', and 'workflow' inside the 'action' block (the
  generator writes only the seven basic keys; these are never emitted)
- join columns in 'datatablesWhere' that come from a joined table (the
  generator only lists the base table's own columns)

Grounding for the manual augmentation (do NOT fabricate property names
or structure from training data — consistent with the KNOWLEDGE
BOUNDARY above):
- For the 'file:' query convention (e.g. when writing
  'masterDetail.detailConfig.detailQuery' as a 'file:' reference), use
  'codegen_get_query_declarative_catalog'. Note: the base
  'datatablesQuery' is ALREADY emitted as a 'file:' reference by the
  generator — do not re-add it manually; the catalog applies only to
  additional advanced queries you author.
- For 'masterDetail', 'workflow', and the composite/workflow action
  semantics there is NO live catalog. Consult the canonical RESTForge
  handbook: 'catalogs/rdf/master-detail.md', 'catalogs/rdf/workflow.md',
  and 'catalogs/rdf/file-reference.md'.
- Join columns from a referenced table (e.g. surfacing supplier_name /
  category_name in datatables) are added by 'codegen_sync_payload' with
  expandFk=true (requires a single table): it builds a JOIN from the table's
  foreign keys, writes query/<table>-join.sql, and repoints
  datatablesQuery/viewQuery at it. Pass fkColumns ('table.column,table.column')
  to pick specific display columns, or omit it to auto-resolve per FK. Do NOT
  hand-edit the JSON via Bash for this.

After augmenting the payload, run 'codegen_validate_payload' to verify
the result still aligns with the current database schema.

DESIGNER (FRONTEND) DOMAIN:
The codegen/setup/runtime tools above all wrap the backend CLI
('restforge', the @restforgejs/platform package). A separate family of
tools — the 'designer_*' tools — wraps a DIFFERENT command-line tool
invoked as 'npx restforge-designer' (the RESTForge Designer frontend
generator). Its binary is bundled inside the @restforgejs/platform
package, so 'npx restforge-designer' works once the platform is installed
(e.g. after 'npx create-restforge-app'); a separate install is no longer
required. Keep the two straight: backend payload/schema/API work goes
through the 'restforge' tools; frontend application work goes through the
'designer_*' tools.

Prefer the 'designer_*' tools when the user wants to:
- Generate, validate, or preview a FRONTEND application (not a backend
  API) from a UI Definition File (UDF) payload
- Work with a frontend/designer PLUGIN (list, inspect, scaffold) — plugin
  ids look like 'vanilla-js-basic', 'vanilla-js-auth', 'vanilla-js-custom'
- Initialise a new frontend project from a designer plugin
- Phrases like "generate frontend", "build the UI from this payload",
  "generate aplikasi frontend", "preview file frontend", "buat project
  frontend dari plugin", "validate UDF", or any mention of
  "restforge-designer", "designer", "rfd", or "frontend generation"

Detection signals that this is RESTForge Designer (frontend) work:
- RESTForge Designer is available via 'npx restforge-designer' (bundled in
  @restforgejs/platform; alias 'rfd' when a standalone build is on PATH)
- The user mentions UDF (UI Definition File), frontend generation, or a
  designer plugin ('vanilla-js-*')
- A frontend project folder with a UDF payload (payload/NN-<name>.json
  in the frontend project) is in play

Boundaries for the designer domain:
- The 'designer_*' tools wrap the 'npx restforge-designer' command, a tool
  SEPARATE from the backend 'restforge' CLI (both binaries ship inside the
  @restforgejs/platform package). They are not interchangeable; do not
  route a backend RDF/SDF request to a 'designer_*' tool, or a UDF/frontend
  request to a 'codegen_*' tool.
- RESTForge Designer no longer has a license mechanism (activate,
  deactivate, license status/migrate, and the global --license flag were
  all removed from the binary). The 'designer_*' tools run license-free.
- If 'npx restforge-designer' cannot run (the @restforgejs/platform package
  is not installed in the project folder), the designer tools return a
  non-error precondition; relay it as a setup step (create the project with
  'npx create-restforge-app', or install @restforgejs/platform), not a
  failure.

Canonical UDF flow (frontend authoring):
The designer tools compose into one coherent path. When the user wants to
build or generate a frontend UDF, route along this flow:

  codegen_migrate_payload -> designer_get_udf_catalog ->
  designer_validate_payload -> designer_preview_files -> designer_generate

- CREATING a UDF — START HERE (firm rule): the FIRST path to produce a UDF
  is ALWAYS 'codegen_migrate_payload'. RESTForge is backend-first; a UDF is
  normally DERIVED from an existing backend payload (RDF), not written by
  hand. 'codegen_migrate_payload' converts an existing RDF into a split
  multi-file UDF set (this verb belongs to the backend 'restforge' CLI, so it
  lives in the codegen domain even though its output is a UDF).
  - Do NOT hand-author a UDF from scratch (writing the JSON yourself) when a
    backend RDF payload exists. Convert it with 'codegen_migrate_payload'
    first, then refine the generated UDF.
  - Author a UDF from scratch (grounded by 'designer_get_udf_catalog') ONLY
    when there is genuinely no backend RDF to migrate from. If unsure whether
    an RDF exists, ask the user or look for the backend 'payload/' directory
    BEFORE hand-authoring.
- Grounding: the authoritative structure and rules of a UDF (valid field
  types, required appConfig fields, enums, limits, dashboard widget/chart/
  data-source options) come from 'designer_get_udf_catalog', which is
  serialized from the designer's own validator constants. Use it BEFORE
  authoring or editing a UDF.
- Do NOT guess the UDF structure from plugin metadata. 'designer_inspect_plugin'
  returns the IDENTITY of one plugin, not the UDF authoring rules; for those,
  use the catalog tool.
- Then validate ('designer_validate_payload'), preview
  ('designer_preview_files'), and finally generate ('designer_generate'),
  pointing those at the aggregator UDF file, not the page fragments.

INTERACTIVE COMMANDS — knowledge only, NOT wrapped as tools:
Some restforge commands are interactive and are intentionally NOT exposed as
tools. When the user asks about them, EXPLAIN what they do and give the exact
command for the user to run themselves in their terminal — this server cannot
drive the interactive prompts.

- 'fast-track' — command: npx restforge fast-track --project=<name> --schema-path=<dir> [--config=<file>] [--license=<KEY>] [--overwrite]
  Purpose: a single interactive flow that scaffolds a full REST API (and
  optionally the frontend app) from an SDF. It does NOT add new generation
  logic; it ORCHESTRATES the existing restforge steps in order: write env (init
  if needed) -> validate --auto-create-db -> config set-default -> schema
  migrate -> payload generate -> payload sync --expand-fk -> endpoint create,
  then (if frontend scope) migrate RDF->UDF -> designer generate, and finally
  writes a server-start launcher.
  Interactive prompts: license + DB params, a scope menu (1 = REST API only,
  2 = REST API + frontend), and a confirmation. Because of these prompts it
  cannot be invoked by this server.
  How to help the user:
  * When the user wants the FASTEST path from an SDF to a running app, tell them
    to run the command above in their terminal and walk them through the prompts
    (license, database, scope choice, confirm).
  * '--overwrite' is DESTRUCTIVE (drops tables and regenerates) — warn before
    suggesting it.
  * If the user prefers a non-interactive / step-by-step path, the same pipeline
    can be reproduced with the individual tools: schema migrate -> generate
    payload -> sync payload (expand FK) -> create endpoint, then (frontend)
    codegen_migrate_payload -> designer validate/preview/generate. Offer this as
    the automatable alternative to fast-track.
`.trim();

export async function startServer(): Promise<void> {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  registerHealthTools(server, SERVER_VERSION);
  registerSetupTools(server);
  registerCodegenTools(server);
  registerRuntimeTools(server);
  registerDesignerTools(server);
  registerDataTools(server);
  registerKeyTools(server);
  registerProjectTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
