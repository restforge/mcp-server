import { z } from 'zod';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerDesignerInitProject(server: McpServer): void {
  server.registerTool(
    'designer_init_project',
    {
      title: 'Init Designer Project',
      description: `Initialise a new frontend project from an existing RESTForge Designer plugin, by running restforge-designer init. This WRITES a new project scaffold (config + structure) to disk, ready for generating frontend code.

USE WHEN:
- The user asks to start/initialise a new frontend project based on a designer plugin
- The user asks things like "init project frontend baru", "scaffold aplikasi dari plugin designer", "mulai project frontend dengan plugin X", "init a new frontend project", "set up a designer project from plugin <id>", "buat project frontend dari plugin"
- The user has a plugin id in mind and wants the project skeleton (app config, auth settings, ports) created from it

DO NOT USE FOR:
- Generating frontend code from an existing UDF payload -> use 'designer_generate'
- Creating a brand new custom plugin from a template -> use 'designer_scaffold_plugin'
- Listing or inspecting available plugins -> use 'designer_list_plugins' / 'designer_inspect_plugin'

This tool wraps the RESTForge Designer CLI command: restforge-designer init --plugin=<plugin> --output=<output> [optional flags], run in the given cwd.
The --plugin and --output flags are always sent so the binary never drops into interactive prompt mode. Optional flags (app name/code, API URLs, auth settings, port, idle timeout, no-auth, overwrite, plugins dir) are forwarded only when supplied.

Preconditions:
- The 'restforge-designer' binary must be installed and reachable on PATH. This tool pre-checks that by running
  'restforge-designer --version'; if the binary is missing, the response will surface that as a non-error precondition.

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "initialise the frontend project", "generate the frontend code", "scaffold a new plugin").
- Speak in plain language. Confirm what was created and where; do not paste raw CLI output unless the user explicitly asks.
- When a precondition is not met, frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the working directory where the binary is run'),
        plugin: z
          .string()
          .min(1)
          .describe('The plugin id to initialise the project from (e.g. vanilla-js-basic). Required.'),
        output: z
          .string()
          .min(1)
          .describe('Path to the output folder where the project will be created (relative to cwd or absolute). Required.'),
        appName: z
          .string()
          .min(1)
          .optional()
          .describe('Human-readable application name for the project.'),
        appCode: z
          .string()
          .min(1)
          .optional()
          .describe('Short application code/identifier for the project.'),
        apiBaseUrl: z
          .string()
          .min(1)
          .optional()
          .describe('Base URL of the backend API the frontend will call.'),
        authAppCode: z
          .string()
          .min(1)
          .optional()
          .describe('Application code used for authentication.'),
        authApiUrl: z
          .string()
          .min(1)
          .optional()
          .describe('Base URL of the authentication API.'),
        port: z
          .number()
          .int()
          .min(1024)
          .max(65535)
          .optional()
          .describe('Dev server port for the project (1024-65535).'),
        idleTimeout: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Idle timeout in seconds for the project.'),
        noAuth: z
          .boolean()
          .optional()
          .describe('When true, initialise the project without authentication.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('When true, overwrite the output directory if it already exists.'),
        pluginsDir: z
          .string()
          .min(1)
          .optional()
          .describe('Override path to the plugins folder. When omitted, the binary auto-detects the plugins directory.'),
      },
      annotations: {
        title: 'Init Designer Project',
        destructiveHint: false, // creates a new project; overwrites only when overwrite=true is supplied
        idempotentHint: false,  // each call attempts to create/initialise a project
      },
    },
    async ({
      cwd,
      plugin,
      output,
      appName,
      appCode,
      apiBaseUrl,
      authAppCode,
      authApiUrl,
      port,
      idleTimeout,
      noAuth,
      overwrite,
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
Plugin: ${plugin}
Output: ${output}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Probe command: ${probe.command}
Exit code: ${probe.exitCode}

For the assistant:
- The user needs to install RESTForge Designer (and ensure it is on the system PATH) before a project can be initialised.
- When explaining to the user, say something like "the RESTForge Designer tool isn't installed or isn't on your PATH yet — please install it and try again". Do not mention internal tool names.
- Once it is installed, retry initialising the project.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      // Always send the required flags (--plugin, --output) so the binary never drops
      // into interactive prompt mode. Forward optional flags only when supplied. per §3.5 / D6
      const args = ['init', `--plugin=${plugin}`, `--output=${output}`];
      if (appName) args.push(`--app-name=${appName}`);
      if (appCode) args.push(`--app-code=${appCode}`);
      if (apiBaseUrl) args.push(`--api-base-url=${apiBaseUrl}`);
      if (authAppCode) args.push(`--auth-app-code=${authAppCode}`);
      if (authApiUrl) args.push(`--auth-api-url=${authApiUrl}`);
      if (port !== undefined) args.push(`--port=${port}`);
      if (idleTimeout !== undefined) args.push(`--idle-timeout=${idleTimeout}`);
      if (noAuth) args.push('--no-auth');
      if (overwrite) args.push('--overwrite');
      if (pluginsDir) args.push(`--plugins-dir=${pluginsDir}`);

      const result = await execProcess('restforge-designer', args, {
        cwd: projectCwd,
        timeout: 60_000,
      });

      // D9: write tool. A non-zero exit (incl. -1 crash/timeout) means the init did not
      // complete cleanly — the project may be missing or partial, so the model needs to
      // recover -> isError: true.
      if (result.exitCode !== 0) {
        const stderrBlock = result.stderr
          ? `\n--- stderr ---\n${result.stderr}\n--- end stderr ---\n`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Initialising the Designer project did not complete.

Working directory: ${projectCwd}
Plugin: ${plugin}
Output: ${output}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- The init did not finish successfully, so the project may not exist or may be partial. Read the CLI output above and explain the most likely cause to the user in plain language. Common causes:
  * The output directory already exists and overwrite was not enabled — suggest retrying with overwrite, or choosing a different output path.
  * The plugin id does not exist — suggest listing the available plugins to pick a valid id.
  * The chosen plugin does not support init — soft note: not every plugin supports the 'init' feature. If the CLI says something like "does not support the init feature", suggest picking a plugin that does (the available plugins can be listed to find one). Do not hardcode or assert a permanent list of which plugins support init — treat it as something to confirm from the current plugin list rather than a fixed claim.
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
            text: `Designer project initialised successfully.

Working directory: ${projectCwd}
Plugin: ${plugin}
Output: ${output}
Plugins dir: ${pluginsDir ?? 'auto-detect'}
Command: ${result.command}
Exit code: ${result.exitCode}

--- stdout ---
${result.stdout}
--- end stdout ---
${stderrBlock}
For the assistant:
- Confirm to the user that the frontend project was initialised. Mention the plugin and the output location in plain language.
- Suggest the next step: author or supply a UDF payload and then generate the frontend code into the project. The usual flow is validate the payload, preview the files, then generate.
- Do not paste the raw CLI output unless the user explicitly asks. Do not mention internal tool names. Match the user's language.`,
          },
        ],
      };
    }
  );
}
