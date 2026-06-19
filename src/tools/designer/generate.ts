import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerGenerate(server: McpServer): void {
  server.registerTool(
    'designer_generate',
    {
      title: 'Generate Designer Frontend',
      description: `Generate frontend code from a UI Definition File (UDF) payload, by running restforge-designer generate. This WRITES the generated frontend files to disk.

USE WHEN:
- The user asks to generate / build the frontend application from a UDF payload
- The user asks things like "generate aplikasi frontend dari UDF", "build frontend dari payload", "generate satu page/form" (scope=form), "generate the frontend code", "build the frontend from this UI definition", "generate frontend designer"
- The user has a valid UDF payload and wants the real frontend files produced (not just a preview)
- The user wants to generate a single page/form rather than the whole app (use scope=form with the page id)

DO NOT USE FOR:
- Previewing which files would be generated WITHOUT writing them -> use 'designer_preview_files'
- Validating that the UDF payload is structurally correct -> use 'designer_validate_payload'
- Initialising a new project from a plugin -> use 'designer_init_project'
- Creating a new custom plugin from a template -> use 'designer_scaffold_plugin'

This tool wraps the RESTForge Designer CLI command: restforge-designer generate --payload=<payload> --output=<output> [optional flags], run in the given cwd.
The --payload and --output flags are always sent so the binary never drops into interactive prompt mode. Optional flags (plugin override, overwrite, scope, page, skip shared, plugins dir) are forwarded only when supplied; the binary defaults to scope 'app' when --scope is omitted.
The recommended flow is read-before-write (§5.3): validate the payload, then preview the files, then generate.

Cross-reference (grounding & on-ramp):
- Before authoring or generating from a UDF, ground its shape (valid field types, required appConfig fields, enums, limits) against the designer's own rules via 'designer_get_udf_catalog' — the authoritative source of UDF structure.
- If no UDF payload exists yet but the user has a backend RDF, the on-ramp is 'codegen_migrate_payload' (RDF -> split UDF set); validate and preview it before generating.
- Canonical UDF flow: codegen_migrate_payload -> designer_get_udf_catalog -> designer_validate_payload -> designer_preview_files -> designer_generate.

Preconditions:
- The 'restforge-designer' binary must be installed and reachable on PATH. This tool pre-checks that by running
  'restforge-designer --version'; if the binary is missing, the response will surface that as a non-error precondition.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "generate the frontend code", "validate the UI definition", "preview the generated files").
- Speak in plain language. Confirm what was generated and where; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        payload: z
          .string()
          .min(1)
          .describe('Path to the UDF payload JSON file (relative to cwd or absolute). Required.'),
        output: z
          .string()
          .min(1)
          .describe('Path to the output folder where the frontend files will be written (relative to cwd or absolute). Required.'),
        plugin: z
          .string()
          .min(1)
          .optional()
          .describe('Override the plugin id taken from the payload.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('When true, overwrite existing files in the output directory.'),
        scope: z
          .enum(['app', 'form'])
          .optional()
          .describe('What to generate: the whole app or a single form/page. When omitted, the binary defaults to "app".'),
        page: z
          .string()
          .min(1)
          .optional()
          .describe('The page/form id to generate, used with scope "form".'),
        skipShared: z
          .boolean()
          .optional()
          .describe('When true, skip generating the shared/common files.'),
        pluginsDir: z
          .string()
          .min(1)
          .optional()
          .describe('Override path to the plugins folder. When omitted, the binary auto-detects the plugins directory.'),
      },
      annotations: {
        title: 'Generate Designer Frontend',
        destructiveHint: false, // writes generated files; overwrites only when overwrite=true is supplied
        idempotentHint: false,  // each call regenerates files
      },
    },
    async ({
      cwd,
      payload,
      output,
      plugin,
      overwrite,
      scope,
      page,
      skipShared,
      pluginsDir,
    }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: the restforge-designer binary must be reachable on PATH.
      // Treated as a non-error precondition per the authoring guide §3.4.
      const probe = await execProcess('restforge-designer', ['--version'], {
        cwd: projectCwd,
        timeout: 10_000,
      });
      if (!probe.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the RESTForge Designer command-line tool is not installed or not on PATH.

Working directory: ${projectCwd}
Payload: ${payload}
Output: ${output}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- The user needs to install RESTForge Designer (and ensure it is on the system PATH) before frontend code can be generated.
- When explaining to the user, say something like "the RESTForge Designer tool isn't installed or isn't on your PATH yet — please install it and try again". Do not mention internal tool names.
- Once it is installed, retry generating the frontend code.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Always send the required flags (--payload, --output) so the binary never drops
      // into interactive prompt mode. Forward optional flags only when supplied; --scope
      // is omitted to keep the binary's "app" default. per §3.5 / D6
      const args = ['generate', `--payload=${payload}`, `--output=${output}`];
      if (plugin) args.push(`--plugin=${plugin}`);
      if (overwrite) args.push('--overwrite');
      if (scope) args.push(`--scope=${scope}`);
      if (page) args.push(`--page=${page}`);
      if (skipShared) args.push('--skip-shared');
      if (pluginsDir) args.push(`--plugins-dir=${pluginsDir}`);

      const result = await execProcess('restforge-designer', args, {
        cwd: projectCwd,
        timeout: 120_000,
      });

      // D9: write tool. A non-zero exit (incl. -1 crash/timeout) means generation did not
      // complete cleanly — files may be missing or partial, so the model needs to recover
      // -> isError: true.
      if (result.exitCode !== 0) {
        const stderrBlock = result.stderr
          ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Generating the frontend code did not complete.

Working directory: ${projectCwd}
Payload: ${payload}
Output: ${output}
Scope: ${scope ?? 'app (default)'}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- The generation did not finish successfully, so the output files may be missing or partial. Read the CLI output above and explain the most likely cause to the user in plain language. Common causes:
  * The UDF payload is invalid — suggest validating the payload first to pinpoint the structural errors, then retry.
  * The payload relies on 'extends' / 'include' references — soft note: if the same payload passes validation but generation fails with an appConfig/plugin error (e.g. the plugin or app config "not found"), the payload may use 'extends' / 'include' that generate does not appear to merge the way validation does. As a possible workaround, suggest a self-contained payload (inline appConfig and pages) or an already-merged file. This is a tentative hint, not a guaranteed rule — do not state it as certain or tie it to a specific version.
  * The payload file path is wrong / the file was not found — suggest checking the path.
  * The plugin id in the payload (or the plugins directory) could not be resolved — suggest listing the available plugins.
  * The output directory already exists and overwrite was not enabled — suggest retrying with overwrite, or choosing a different output path.
  * Exit code -1 — the command crashed or timed out; offer to retry.
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
            },
          ],
          isError: true, // per §3.4 / D9 — write did not complete
        };
      }

      // D9: success — exit 0. Labeled facts + fenced raw output per §3.5.
      const stderrBlock = result.stderr
        ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Frontend code generated successfully.

Working directory: ${projectCwd}
Payload: ${payload}
Output: ${output}
Scope: ${scope ?? 'app (default)'}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- Confirm to the user that the frontend code was generated. Mention the output location and the scope (whole app, or a single page/form) in plain language.
- Summarise what was produced from the CLI output (how many files, what kind) rather than pasting it.
- Suggest a sensible next step, e.g. running or inspecting the generated frontend.
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
