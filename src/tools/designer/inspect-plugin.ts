import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerInspectPlugin(server: McpServer): void {
  server.registerTool(
    'designer_inspect_plugin',
    {
      title: 'Inspect Designer Plugin',
      description: `Inspect the metadata of a single RESTForge Designer frontend plugin (its schema, fields, components, and configuration), by running restforge-designer plugins inspect for a given plugin id.

USE WHEN:
- The user asks for the details, metadata, schema, or fields of one specific designer plugin
- The user asks things like "detail plugin X", "metadata plugin", "schema plugin designer", "apa isi plugin vanilla-js-auth", "what's inside the vanilla-js-auth plugin", "tampilkan field plugin frontend ini", "show me the structure of plugin <id>"
- Before authoring a UDF payload for a plugin, to learn which fields and components that plugin expects
- The user names a specific plugin id and wants to understand what it provides

DO NOT USE FOR:
- Listing ALL available plugins -> use 'designer_list_plugins'
- Validating a UDF payload against a plugin -> use 'designer_validate_payload'
- Previewing the files a payload would generate -> use 'designer_preview_files'
- The authoritative catalog of UDF structure and rules (valid field types, required appConfig fields, enums, limits) -> use 'designer_get_udf_catalog'

This tool wraps the RESTForge Designer CLI command: restforge-designer plugins inspect --plugin=<plugin> [--plugins-dir=<pluginsDir>], run in the given cwd.
The CLI resolves the named plugin (auto-detected, or from --plugins-dir) and prints its metadata. It does not modify any file and does not require a license.

IMPORTANT — identity, not UDF structure:
- This tool returns the IDENTITY/metadata of ONE plugin (its declared schema, fields, components, configuration). It is NOT the authoritative source of UDF structure and authoring rules. Do NOT infer the valid UDF field types, required appConfig fields, enums, or limits from this plugin metadata.
- For the authoritative UDF structure and rules, use 'designer_get_udf_catalog' (serialized from the designer's own validator constants). Use plugin inspection to learn what a SPECIFIC plugin provides; use the catalog to learn the UDF rules that apply across the designer.

Preconditions:
- The 'restforge-designer' binary must be installed and reachable on PATH. This tool pre-checks that by running
  'restforge-designer --version'; if the binary is missing, the response will surface that as a non-error precondition.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "inspect the plugin", "list the available plugins", "generate the frontend code").
- Speak in plain language. Summarise the plugin metadata; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        plugin: z
          .string()
          .min(1)
          .describe('The plugin id to inspect (e.g. vanilla-js-auth)'),
        pluginsDir: z
          .string()
          .min(1)
          .optional()
          .describe('Override path to the plugins folder. When omitted, the binary auto-detects the plugins directory.'),
      },
      annotations: {
        title: 'Inspect Designer Plugin',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, plugin, pluginsDir }) => {
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
Plugin: ${plugin}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- The user needs to install RESTForge Designer (and ensure it is on the system PATH) before a plugin can be inspected.
- When explaining to the user, say something like "the RESTForge Designer tool isn't installed or isn't on your PATH yet — please install it and try again". Do not mention internal tool names.
- Once it is installed, retry inspecting the plugin.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. per §3.5 / D6
      const args = ['plugins', 'inspect', `--plugin=${plugin}`];
      if (pluginsDir) args.push(`--plugins-dir=${pluginsDir}`);

      const result = await execProcess('restforge-designer', args, {
        cwd: projectCwd,
        timeout: 15_000,
      });

      // D7: read-only tool. Pre-flight confirmed the binary spawns, so only an
      // unexpected crash/timeout (no real exit code -> -1) is a real error.
      if (result.exitCode === -1) {
        return {
          content: [
            {
              type: 'text',
              text: `Inspecting the Designer plugin did not complete — the command crashed or timed out.

Working directory: ${projectCwd}
Plugin: ${plugin}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}

--- stderr ---
${result.stderr}
--- end stderr ---

For the assistant:
- The Designer CLI did not finish (likely a crash or timeout), so there is no plugin metadata to report.
- Tell the user the inspection could not be completed and offer to retry. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4 — unexpected crash/timeout
        };
      }

      // D7: single response for ANY real exit code. A non-zero exit (e.g. the plugin id
      // does not exist) is an actionable negative verdict to relay, not a tool failure.
      const stderrBlock = result.stderr
        ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Inspecting the Designer plugin ran.

Working directory: ${projectCwd}
Plugin: ${plugin}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- The Designer CLI ran to completion. Read the CLI output above and classify the result:
  (a) Positive result — the output is the plugin's metadata (its schema, fields, components). Summarise it in plain language so the user understands what the plugin expects, and offer the next step (e.g. author or validate a payload for it).
  (b) Actionable negative verdict — the named plugin id does not exist, or the plugins directory override could not be resolved. These are legitimate results to RELAY to the user, not tool malfunctions. Tell the user the plugin id was not found (note: a "plugin not found" verdict often comes with a non-zero exit code, which is expected here) and suggest listing the available plugins to pick a valid id.
- A non-zero exit code here means the CLI reported a negative verdict (case b), NOT that the tool failed. Never tell the user "the tool failed" for case (b).
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
