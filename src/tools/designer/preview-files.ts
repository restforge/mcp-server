import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerPreviewFiles(server: McpServer): void {
  server.registerTool(
    'designer_preview_files',
    {
      title: 'Preview Designer Files',
      description: `Preview (dry-run) the frontend files that the RESTForge Designer would generate from a UI Definition File (UDF) payload, by running restforge-designer preview. This lists what would be produced WITHOUT writing anything to disk.

USE WHEN:
- The user asks which files would be generated, or wants a dry-run before generating frontend code
- The user asks things like "file apa yang akan di-generate", "preview output frontend designer", "dry-run generate", "what files will the designer produce", "tunjukkan hasil generate tanpa menulis file", "preview the designer output"
- Before actually generating the frontend code, to inspect the planned output and confirm it looks right
- The user mentions a designer/frontend UDF payload and wants to see the resulting file layout first

DO NOT USE FOR:
- Validating that a UDF payload is structurally correct against the plugin schema -> use 'designer_validate_payload'
- Actually generating and writing the frontend files (preview is read-only; the real generation tool writes files)
- Listing the available designer plugins -> use 'designer_list_plugins'
- Inspecting one plugin's metadata -> use 'designer_inspect_plugin'

This tool wraps the RESTForge Designer CLI command: restforge-designer preview --payload=<payload> [--plugins-dir=<pluginsDir>], run in the given cwd.
The CLI reads the UDF payload JSON, resolves the target plugin (auto-detected or from --plugins-dir), and prints the list of files it would generate. It does not modify any file and does not require a license.

Cross-reference (grounding & on-ramp):
- To ground the UDF shape before previewing or editing it (valid field types, required appConfig fields, enums, limits), use 'designer_get_udf_catalog' — the authoritative source of UDF structure.
- If the UDF does not exist yet but a backend RDF does, the on-ramp is 'codegen_migrate_payload' (RDF -> split UDF set), then validate and preview that output.
- Canonical UDF flow: codegen_migrate_payload -> designer_get_udf_catalog -> designer_validate_payload -> designer_preview_files -> designer_generate.

Preconditions:
- The 'restforge-designer' binary must be installed and reachable on PATH. This tool pre-checks that by running
  'restforge-designer --version'; if the binary is missing, the response will surface that as a non-error precondition.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "preview the generated files", "validate the UI definition", "generate the frontend code").
- Speak in plain language. Summarise the planned file list; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        payload: z
          .string()
          .min(1)
          .describe('Path to the UDF payload JSON file (relative to cwd or absolute)'),
        pluginsDir: z
          .string()
          .min(1)
          .optional()
          .describe('Override path to the plugins folder. When omitted, the binary auto-detects the plugins directory.'),
      },
      annotations: {
        title: 'Preview Designer Files',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, payload, pluginsDir }) => {
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
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- The user needs to install RESTForge Designer (and ensure it is on the system PATH) before the generated files can be previewed.
- When explaining to the user, say something like "the RESTForge Designer tool isn't installed or isn't on your PATH yet — please install it and try again". Do not mention internal tool names.
- Once it is installed, retry the preview.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. per §3.5 / D6
      const args = ['preview', `--payload=${payload}`];
      if (pluginsDir) args.push(`--plugins-dir=${pluginsDir}`);

      const result = await execProcess('restforge-designer', args, {
        cwd: projectCwd,
        timeout: 30_000,
      });

      // D7: read-only tool. Pre-flight confirmed the binary spawns, so only an
      // unexpected crash/timeout (no real exit code -> -1) is a real error.
      if (result.exitCode === -1) {
        return {
          content: [
            {
              type: 'text',
              text: `Designer preview did not complete — the command crashed or timed out.

Working directory: ${projectCwd}
Payload: ${payload}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}

--- stderr ---
${result.stderr}
--- end stderr ---

For the assistant:
- The Designer CLI did not finish (likely a crash or timeout), so there is no preview to report.
- Tell the user the preview could not be completed and offer to retry. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4 — unexpected crash/timeout
        };
      }

      // D7: single response for ANY real exit code. A non-zero exit is an actionable
      // negative verdict (invalid payload, plugin/file not found) to relay, not a failure.
      const stderrBlock = result.stderr
        ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Designer preview ran.

Working directory: ${projectCwd}
Payload: ${payload}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- The Designer CLI ran to completion. Read the CLI output above and classify the result:
  (a) Positive result — the output lists the files that would be generated. Summarise the planned files in plain language (how many, what kinds) and offer the next step: generate the frontend code for real.
  (b) Actionable negative verdict — the payload is invalid, the payload file was not found, or the target plugin / plugins directory could not be resolved. These are legitimate results to RELAY to the user, not tool malfunctions. Summarise the concrete problem (which path or field is wrong) and offer to retry after the user fixes it; validating the payload first can help pinpoint structural errors.
- A non-zero exit code here means the CLI reported a negative verdict (case b), NOT that the tool failed. Never tell the user "the tool failed" for case (b).
- Soft note: if preview fails with an appConfig/plugin error (e.g. the plugin or app config "not found") while the SAME payload passes validation, the payload may rely on 'extends' / 'include' references that preview does not appear to merge the way validation does. As a possible workaround, suggest pointing the preview at a self-contained payload (inline appConfig and pages) or an already-merged file. This is a tentative hint, not a guaranteed rule — do not state it as certain or tie it to a specific version.
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
