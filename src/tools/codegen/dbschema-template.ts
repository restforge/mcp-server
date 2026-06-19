import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

// Build a short human-readable description of what was requested, for the labeled
// facts block. Keeps the success response self-describing without re-listing every
// raw flag. Mirrors the "labeled facts" convention of the sibling dbschema tools.
function describeRequest(args: {
  domain?: string;
  table?: string;
  category?: string;
  pattern?: string;
  section?: string;
  hasSdf?: boolean;
  noSdf?: boolean;
  show?: boolean;
  example?: boolean;
  lang?: string;
  generate?: boolean;
  schemaPath?: string;
  force?: boolean;
  listDomains?: boolean;
  listCategories?: boolean;
  listSections?: boolean;
  stats?: boolean;
  format?: string;
}): string {
  const parts: string[] = [];
  if (args.generate) parts.push(`generate template '${args.table ?? '(missing table)'}' to '${args.schemaPath ?? '(missing path)'}'`);
  else if (args.show) parts.push(`show template '${args.table ?? '(missing table)'}'${args.example ? ' with example data' : ''}`);
  else if (args.stats) parts.push('collection statistics');
  else if (args.listDomains) parts.push('list domains');
  else if (args.listCategories) parts.push('list categories');
  else if (args.listSections) parts.push('list sections');
  else parts.push('list/browse templates');

  const filters: string[] = [];
  if (args.domain) filters.push(`domain=${args.domain}`);
  if (args.table && !args.show && !args.generate) filters.push(`table=${args.table}`);
  if (args.category) filters.push(`category=${args.category}`);
  if (args.pattern) filters.push(`pattern=${args.pattern}`);
  if (args.section) filters.push(`section=${args.section}`);
  if (args.hasSdf) filters.push('has-sdf');
  if (args.noSdf) filters.push('no-sdf');
  if (filters.length > 0) parts.push(`filters: ${filters.join(', ')}`);
  if (args.lang) parts.push(`lang=${args.lang}`);
  if (args.format) parts.push(`format=${args.format}`);
  if (args.force) parts.push('force=overwrite');
  return parts.join('; ');
}

export function registerCodegenDbschemaTemplate(server: McpServer): void {
  server.registerTool(
    'codegen_dbschema_template',
    {
      title: 'Browse / Preview / Generate Schema Templates',
      description: `Access the RESTForge Schema Reference collection (87 ready-made templates spanning 30+ domains: ERP, finance, inventory, e-commerce, CRM, HR, POS, and more) by wrapping restforge schema template. Use it to browse and filter the catalog, preview a template's SDF or SQL, look up the available domains/categories/sections, and scaffold real schema files for common business tables (e.g. sales_order, inventory, customer_invoice) instead of starting from an empty skeleton.

FOUR MODES:
- LIST / BROWSE (default, no show/generate/utility flag): returns a filtered catalog of templates. Combine filters: domain (csv), table (wildcard glob like "sales*"), category, pattern, section, hasSdf, noSdf.
- SHOW (show=true, needs a SPECIFIC table name — no wildcard): prints the template's schema. lang=sdf (default) prints the dbschema-kit factory function; lang=sql prints raw DDL. example=true adds a sample-data section (only meaningful together with show).
- GENERATE (generate=true, needs a SPECIFIC table AND path): writes the template to the filesystem. A master-detail template writes TWO files (e.g. sales_order.js + sales_order_item.js). force=true overwrites existing destination files; without force the CLI refuses to overwrite.
- UTILITY (stats / listDomains / listCategories / listSections): collection statistics and the lookup lists that feed the filters above.

PLATFORM DEPENDENCY (important): this feature is backed by a native binary (sdf-tools.exe) that is currently WINDOWS-ONLY. On a non-Windows host, or if the binary is missing from the installed package, the CLI exits with code 3 and this tool reports that the template collection is unavailable on this platform — that is NOT a user error. In that case, author the SDF by hand (ground it with 'codegen_get_dbschema_catalog') or reverse-engineer it from an existing database with 'codegen_dbschema_introspect'.

USE WHEN:
- The user asks for an example schema, a starter for a common table, or "what tables/templates are available"
- Pertanyaan dalam bentuk: "ada template schema untuk sales order nggak?", "buatkan schema inventory dari template", "contoh schema invoice", "template apa saja untuk domain ERP", "scaffold tabel pelanggan dari contoh"
- The user wants to scaffold a real, fleshed-out table (sales_order, product, customer, journal_entry, ...) rather than the minimal id/code/name/is_active skeleton from 'codegen_dbschema_init'
- Exploring the catalog by domain/category/pattern, or doing SDF gap analysis (noSdf=true)
- The user wants to preview a template's SDF or SQL before committing it to a file

DO NOT USE FOR:
- Creating a minimal empty starter file (id/code/name/is_active only) -> use 'codegen_dbschema_init'
- Editing an existing schema file -> use Edit/Write tools directly
- Reverse-engineering SDF from a live database -> use 'codegen_dbschema_introspect'
- Validating a schema file -> use 'codegen_dbschema_validate'
- Generating DDL from an already-authored SDF -> use 'codegen_dbschema_generate_ddl'
- Looking up defineModel syntax / field types / constraints -> use 'codegen_get_dbschema_catalog'

This tool runs: npx restforge schema template [filters/mode flags] in the given cwd. Boolean flags (show, generate, stats, hasSdf, noSdf, example, force, listDomains, listCategories, listSections) are sent as bare flags only when true; string/enum flags (domain, table, category, pattern, section, lang, path, format) are sent as --flag=value when supplied.

OUTPUT: the tool relays the CLI's text output as-is; it does not parse it. The native binary's --format=json is honoured by the list/stats/listDomains/listCategories/listSections modes (machine-readable JSON text) but NOT by show (which always prints schema code) or generate (which prints a written-files summary). Pass format=json only when you specifically want the JSON form of a list/utility result; otherwise the default human-readable text is easier to summarise.

CLI constraints (the CLI enforces these; this tool does not pre-validate, it forwards and relays the CLI's own error):
- show and generate require a specific table name (no wildcard).
- generate requires path.
- example is only meaningful together with show.
- force only matters with generate (overwrite existing files).
- master-detail templates generate two files.

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The template feature requires the Windows-only sdf-tools.exe binary shipped with the package (exit 3 otherwise — see PLATFORM DEPENDENCY).

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "browse the schema templates", "preview the sales order template", "scaffold the table from a template").
- Speak in plain language. Summarise list/stats output (counts, the templates relevant to the user's task); do not paste the entire table or JSON unless the user explicitly asks.
- For generate: confirm the files that were written and their paths (a master-detail template creates two files). Suggest validating the generated schema next.
- For the Windows-only exit 3 case: explain plainly that the ready-made template collection is not available on this platform, then offer the alternatives (author the SDF by hand with the catalog as reference, or reverse-engineer from an existing database). Do not present it as a failure of the user's request.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must contain node_modules/@restforgejs/platform)'),
        // Filters (list/browse).
        domain: z
          .string()
          .min(1)
          .optional()
          .describe('Filter by domain, comma-separated (e.g. "erp" or "erp,finance"). Look up valid values via listDomains.'),
        table: z
          .string()
          .min(1)
          .optional()
          .describe('For list: wildcard glob filter on table name (e.g. "sales*", "*_invoice"). For show/generate: the EXACT template/table name (no wildcard).'),
        category: z
          .enum(['master-data', 'transactional'])
          .optional()
          .describe('Filter by category.'),
        pattern: z
          .enum(['single-table', 'master-detail'])
          .optional()
          .describe('Filter by pattern. master-detail templates generate two files on generate.'),
        section: z
          .string()
          .min(1)
          .optional()
          .describe('Filter by section code. Look up valid values via listSections.'),
        hasSdf: z
          .boolean()
          .optional()
          .describe('When true, only templates that already have an SDF version. Sent as --has-sdf.'),
        noSdf: z
          .boolean()
          .optional()
          .describe('When true, only templates without an SDF version (gap analysis). Sent as --no-sdf.'),
        // Display (show).
        show: z
          .boolean()
          .optional()
          .describe('When true, print the template schema. Requires a specific table name (no wildcard).'),
        example: z
          .boolean()
          .optional()
          .describe('When true, include a sample-data section. Only meaningful together with show.'),
        lang: z
          .enum(['sdf', 'sql'])
          .optional()
          .describe('Schema language for show/generate: sdf (default, the dbschema-kit factory function) or sql (raw DDL).'),
        // Generate.
        generate: z
          .boolean()
          .optional()
          .describe('When true, write the template to the filesystem. Requires a specific table name AND schemaPath. WRITES FILES.'),
        schemaPath: z
          .string()
          .min(1)
          .optional()
          .describe('Destination directory (or file) for generate, relative to cwd or absolute.'),
        force: z
          .boolean()
          .optional()
          .describe('When true, overwrite existing destination files during generate. Without it, the CLI refuses to overwrite. Sent as --force.'),
        // Utility.
        listDomains: z
          .boolean()
          .optional()
          .describe('When true, list all available domains. Sent as --list-domains.'),
        listCategories: z
          .boolean()
          .optional()
          .describe('When true, list all template categories. Sent as --list-categories.'),
        listSections: z
          .boolean()
          .optional()
          .describe('When true, list all sections with their category. Sent as --list-sections.'),
        stats: z
          .boolean()
          .optional()
          .describe('When true, show collection statistics (counts per category, pattern, domain, section).'),
        format: z
          .enum(['table', 'plain', 'json'])
          .optional()
          .describe('Output format: table (default), plain, or json. json is honoured by list/stats/list* modes only, not by show/generate.'),
      },
      annotations: {
        title: 'Browse / Preview / Generate Schema Templates',
        destructiveHint: false, // generate writes new files; force overwrites, but it never drops database data
        idempotentHint: false,  // generate writes to the filesystem; output also depends on the live catalog state
      },
    },
    async ({
      cwd,
      domain,
      table,
      category,
      pattern,
      section,
      hasSdf,
      noSdf,
      show,
      example,
      lang,
      generate,
      schemaPath,
      force,
      listDomains,
      listCategories,
      listSections,
      stats,
      format,
    }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: @restforgejs/platform must be present in node_modules. per §3.4
      try {
        await access(join(projectCwd, 'node_modules', '@restforgejs', 'platform'));
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the RESTForge package is not installed in this project.

Project path: ${projectCwd}
Expected location: node_modules/@restforgejs/platform

For the assistant:
- The user needs to install the RESTForge package before the schema template collection can be used.
- Suggest installing the package first, then retry.
- When explaining to the user, say something like "the RESTForge package isn't installed yet — should I install it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the flags that were supplied. Booleans become bare flags when
      // true (mirrors the platform forwarder buildBinaryArgs: BOOLEAN_FLAGS only when
      // === true); string/enum flags become --flag=value. CLI flag names are
      // kebab-case (--has-sdf, --no-sdf, --list-domains, ...). per §3.5
      const cliArgs = ['restforge', 'schema', 'template'];
      if (domain !== undefined) cliArgs.push(`--domain=${domain}`);
      if (table !== undefined) cliArgs.push(`--table=${table}`);
      if (category !== undefined) cliArgs.push(`--category=${category}`);
      if (pattern !== undefined) cliArgs.push(`--pattern=${pattern}`);
      if (section !== undefined) cliArgs.push(`--section=${section}`);
      if (hasSdf === true) cliArgs.push('--has-sdf');
      if (noSdf === true) cliArgs.push('--no-sdf');
      if (show === true) cliArgs.push('--show');
      if (example === true) cliArgs.push('--example');
      if (lang !== undefined) cliArgs.push(`--lang=${lang}`);
      if (generate === true) cliArgs.push('--generate');
      if (schemaPath !== undefined) cliArgs.push(`--schema-path=${schemaPath}`);
      if (force === true) cliArgs.push('--force');
      if (listDomains === true) cliArgs.push('--list-domains');
      if (listCategories === true) cliArgs.push('--list-categories');
      if (listSections === true) cliArgs.push('--list-sections');
      if (stats === true) cliArgs.push('--stats');
      if (format !== undefined) cliArgs.push(`--format=${format}`);

      const requestSummary = describeRequest({
        domain,
        table,
        category,
        pattern,
        section,
        hasSdf,
        noSdf,
        show,
        example,
        lang,
        generate,
        schemaPath,
        force,
        listDomains,
        listCategories,
        listSections,
        stats,
        format,
      });

      const result = await execProcess(
        'npx',
        cliArgs,
        {
          cwd: projectCwd,
          timeout: 30_000, // native binary; list/show/stats are fast, generate writes a couple of files
          env: { NODE_ENV: 'production' },
          stripFinalNewline: true,
        }
      );

      // Branch: exit 3 — the template feature is unavailable on this platform. NOT a
      // user error: the CLI returns exit 3 when the host is non-Windows OR the
      // sdf-tools.exe binary is missing from the installed package (template.js:185-200). per §3.4
      if (result.exitCode === 3) {
        return {
          content: [
            {
              type: 'text',
              text: `The schema template collection is unavailable on this platform.

Project path: ${projectCwd}
Requested: ${requestSummary}
Command: ${result.command}
Exit code: 3

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- This is NOT a mistake by the user and NOT a bug in the request. The template feature is backed by a native binary (sdf-tools.exe) that currently only runs on Windows; exit 3 means either the host is not Windows, or the binary is missing from the installed package.
- Do not retry the same call — it will fail again on this host. Instead, offer the alternatives:
  * Author the schema by hand: look up the defineModel syntax, field types, and constraints (the schema catalog is the ground truth), then create the file and validate it.
  * Reverse-engineer the schema from an existing database table, if one already exists.
- Explain plainly to the user that the ready-made template collection is not available on this platform, then propose one of the alternatives above. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch: exit 1 (binary spawn failure) / exit 2 (usage error) / any other
      // non-zero — a real error. Relay full output plus likely causes. per §3.4
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to run the schema template command.

Project path: ${projectCwd}
Requested: ${requestSummary}
Command: ${result.command}
Exit code: ${result.exitCode}

--- CLI output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end CLI output ---

For the assistant:
- Tell the user that the template command did not complete successfully.
- Summarise the most likely cause from the CLI output in plain language. Common causes:
  * Usage error (exit 2) — an invalid flag combination. Recall the CLI constraints: show/generate need a specific table name (no wildcard); generate also needs path; example only works with show; an unknown enum value for category/pattern/lang/format is rejected.
  * Binary spawn failure (exit 1) — sdf-tools.exe could not be launched; suggest re-checking the installed package integrity.
  * For generate specifically: the destination file already exists and force was not set (the CLI refuses to overwrite) — suggest a different path or passing force=true after confirming with the user.
  * Unknown command 'schema template' — the installed RESTForge version may be older than this CLI subcommand; suggest upgrading the package.
- Do not paste the raw stdout/stderr unless the user explicitly asks. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Branch: success (exit 0) — relay the CLI text output as-is. The output shape
      // varies by mode (table/plain/json for list/stats; schema code for show; a
      // written-files summary for generate); the tool does not parse it. per §3.5
      const generated = generate === true;
      return {
        content: [
          {
            type: 'text',
            text: `Schema template command completed successfully.

Project path: ${projectCwd}
Requested: ${requestSummary}
${format ? `Format: ${format}\n` : ''}
--- CLI output ---
${result.stdout}
--- end CLI output ---

For the assistant:
${generated
  ? `- Confirm to the user which files were written and their paths — the CLI output above lists each generated file. A master-detail template writes two files (the master plus its detail/line table).
- Suggest opening the generated file(s) and then validating the schema as a sanity check (without naming the internal tool).
- The generated schema is a real, fleshed-out starting point from the reference collection, not an empty skeleton; the user may still want to adjust field names/sizes to their exact domain.`
  : show === true
    ? `- This is a preview only; nothing was written to the filesystem.
- Read the schema above and summarise it in plain language if the user asked a question. If they want to keep it, offer to generate it to a file (which would write the actual file).`
    : `- Read the output above and summarise it for the user (e.g. how many templates matched, the ones relevant to their task, or the requested list/statistics).
- Do not paste the entire table or JSON if it is long; surface only what the user needs. If they then want a specific template, offer to preview it (show) or scaffold it to a file (generate).`}
- Match the user's language.`,
          },
        ],
      };
    }
  );
}
