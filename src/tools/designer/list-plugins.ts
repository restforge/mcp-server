import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerListPlugins(server: McpServer): void {
  server.registerTool(
    'designer_list_plugins',
    {
      title: 'List Designer Plugins',
      description: `List the RESTForge Designer frontend plugins available in the current environment, by running restforge-designer plugins list. Each plugin defines a frontend tech stack / template the designer can generate against.

USE WHEN:
- The user asks which designer plugins are available, or wants the catalog of frontend templates
- The user asks things like "plugin apa yang tersedia", "daftar plugin designer", "list frontend plugins", "what designer plugins do I have", "tampilkan plugin frontend", "which frontend templates can I use"
- Before initialising a project or generating frontend code, to choose which plugin to target
- The user mentions designer plugins generically and wants an overview

DO NOT USE FOR:
- Inspecting the metadata, schema, or fields of ONE specific plugin -> use 'designer_inspect_plugin'
- Validating a UDF payload against a plugin -> use 'designer_validate_payload'
- Previewing the files a payload would generate -> use 'designer_preview_files'

This tool wraps the RESTForge Designer CLI command: restforge-designer plugins list [--plugins-dir=<pluginsDir>], run in the given cwd.
The CLI prints a table of available plugins (auto-detected, or from --plugins-dir when supplied). It does not modify any file and does not require a license.

Preconditions:
- The 'restforge-designer' binary must be installed and reachable on PATH. This tool pre-checks that by running
  'restforge-designer --version'; if the binary is missing, the response will surface that as a non-error precondition.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "list the available plugins", "inspect a plugin", "generate the frontend code").
- Speak in plain language. Summarise the plugins (names, count); do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        pluginsDir: z
          .string()
          .min(1)
          .optional()
          .describe('Override path to the plugins folder. When omitted, the binary auto-detects the plugins directory.'),
      },
      annotations: {
        title: 'List Designer Plugins',
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ cwd, pluginsDir }) => {
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
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- The user needs to install RESTForge Designer (and ensure it is on the system PATH) before the available plugins can be listed.
- When explaining to the user, say something like "the RESTForge Designer tool isn't installed or isn't on your PATH yet — please install it and try again". Do not mention internal tool names.
- Once it is installed, retry listing the plugins.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Forward only the arguments the user supplied. per §3.5 / D6
      const args = ['plugins', 'list'];
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
              text: `Listing Designer plugins did not complete — the command crashed or timed out.

Working directory: ${projectCwd}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}

--- stderr ---
${result.stderr}
--- end stderr ---

For the assistant:
- The Designer CLI did not finish (likely a crash or timeout), so there is no plugin list to report.
- Tell the user the list could not be retrieved and offer to retry. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4 — unexpected crash/timeout
        };
      }

      // D7: single response for ANY real exit code. A non-zero exit is an actionable
      // negative verdict (e.g. plugins directory not found) to relay, not a failure.
      const stderrBlock = result.stderr
        ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Listing Designer plugins ran.

Working directory: ${projectCwd}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- The Designer CLI ran to completion. Read the CLI output above and classify the result:
  (a) Positive result — the output is a table of available plugins. Summarise the plugins in plain language (names and how many) and, if the user is choosing one, suggest inspecting a specific plugin for its details.
  (b) Actionable negative verdict — no plugins were found, or the plugins directory override could not be resolved. These are legitimate results to RELAY to the user, not tool malfunctions. Explain the situation (e.g. the plugins folder is empty or the override path is wrong) and offer next steps.
- A non-zero exit code here means the CLI reported a negative verdict (case b), NOT that the tool failed. Never tell the user "the tool failed" for case (b).
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
