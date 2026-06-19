import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerValidatePayload(server: McpServer): void {
  server.registerTool(
    'designer_validate_payload',
    {
      title: 'Validate Designer Payload',
      description: `Validate a frontend UI Definition File (UDF) payload against the schema of the RESTForge Designer plugin it targets, by running restforge-designer validate.

USE WHEN:
- The user asks to validate, check, or verify a frontend designer payload / UI definition (UDF) file
- The user asks things like "validasi UDF", "cek payload frontend", "is this UI definition valid", "validate designer payload", "apakah payload UDF benar", "check the frontend payload against the plugin schema"
- Before previewing or generating frontend code from a UDF, to confirm the payload is structurally valid against the plugin schema
- The user mentions a designer/frontend payload JSON and wants to know whether it conforms to the plugin it targets
- Routine pre-generation sanity check on a UDF file

DO NOT USE FOR:
- Validating a backend RDF payload against the database schema -> use 'codegen_validate_payload'
- Validating an SDF (database schema definition) -> use 'codegen_dbschema_validate'
- Validating raw SQL -> use 'codegen_validate_sql'
- Generating the frontend code itself (this only validates, it does not write files)

This tool wraps the RESTForge Designer CLI command: restforge-designer validate --payload=<payload> [--plugins-dir=<pluginsDir>], run in the given cwd.
The CLI reads the UDF payload JSON, resolves the target plugin (auto-detected or from --plugins-dir), and reports whether
the payload is valid against that plugin's schema, listing structural errors when it is not. It does not modify any file and
does not require a license.

Cross-reference (grounding & on-ramp):
- Before authoring or validating a UDF, ground its shape (valid field types, required appConfig fields, enums, limits) against the designer's own rules via 'designer_get_udf_catalog' — that catalog is the authoritative source of UDF structure.
- If no UDF payload exists yet but the user has a backend RDF, the natural on-ramp is 'codegen_migrate_payload' (converts an RDF into a split UDF set); validate that output here.
- Canonical UDF flow: codegen_migrate_payload -> designer_get_udf_catalog -> designer_validate_payload -> designer_preview_files -> designer_generate.

Preconditions:
- The 'restforge-designer' binary must be installed and reachable on PATH. This tool pre-checks that by running
  'restforge-designer --version'; if the binary is missing, the response will surface that as a non-error precondition.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "validate the UI definition", "preview the generated files", "generate the frontend code").
- Speak in plain language. Summarise the result; do not paste raw CLI output unless the user explicitly asks.
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
        title: 'Validate Designer Payload',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, payload, pluginsDir }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: the restforge-designer binary must be reachable on PATH.
      // Treated as a non-error precondition per the authoring guide §3.4. The probe
      // distinguishes "binary missing" (precondition) from "binary ran and reported
      // something" (which falls through to the real execution below).
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
- The user needs to install RESTForge Designer (and ensure it is on the system PATH) before a frontend payload can be validated.
- When explaining to the user, say something like "the RESTForge Designer tool isn't installed or isn't on your PATH yet — please install it and try again". Do not mention internal tool names.
- Once it is installed, retry validating the payload.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. The plugins directory is
      // auto-detected by the binary when --plugins-dir is omitted. per §3.5
      const args = ['validate', `--payload=${payload}`];
      if (pluginsDir) args.push(`--plugins-dir=${pluginsDir}`);

      const result = await execProcess('restforge-designer', args, {
        cwd: projectCwd,
        timeout: 30_000,
      });

      // D7: this is a read-only tool. The pre-flight already confirmed the binary
      // spawns, so an unexpected crash/timeout (no real exit code -> -1) is the only
      // real error here -> isError: true. Any genuine exit code is a verdict to relay.
      if (result.exitCode === -1) {
        return {
          content: [
            {
              type: 'text',
              text: `Designer payload validation did not complete — the command crashed or timed out.

Working directory: ${projectCwd}
Payload: ${payload}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}

--- stderr ---
${result.stderr}
--- end stderr ---

For the assistant:
- The Designer CLI did not finish (likely a crash or timeout), so there is no validation verdict to report.
- Tell the user the check could not be completed and offer to retry. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4 — unexpected crash/timeout
        };
      }

      // D7: single response for ANY real exit code (success branch no longer split on
      // result.success). A non-zero exit means the CLI reported an actionable negative
      // verdict (invalid payload, plugin/file not found), which is a legitimate result
      // to relay — NOT a tool failure. The model classifies from the fenced output.
      const stderrBlock = result.stderr
        ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Designer payload validation ran.

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
  (a) Positive result — the payload is VALID against the target plugin schema. Confirm this in plain language and suggest the next step: preview the files that would be generated from this payload, or generate the frontend code. Describe steps by what they do.
  (b) Actionable negative verdict — the payload is INVALID (the output lists structural errors), or the payload file was not found, or the target plugin / plugins directory could not be resolved. These are legitimate results to RELAY to the user, not tool malfunctions. Summarise the concrete problems (which fields, components, or paths are wrong) and offer to re-check after the user fixes them.
- A non-zero exit code here means the CLI reported a negative verdict (case b), NOT that the tool failed. Never tell the user "the tool failed" for case (b).
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
