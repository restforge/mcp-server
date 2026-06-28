import { z } from 'zod';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

export function registerSetupInstallPackage(server: McpServer): void {
  server.registerTool(
    'setup_install_package',
    {
      title: 'Install @restforgejs/platform Package',
      description: `Install the @restforgejs/platform package into the project's node_modules via npm.

USE WHEN:
- The user wants to install RESTForge (@restforgejs/platform) into a project
- The project folder exists but does not yet have @restforgejs/platform in node_modules
- Setting up a new project before the configuration stage
- Updating @restforgejs/platform to a specific tag or version
- The user says things like "install restforge", "tambahkan @restforgejs/platform",
  "pasang package restforge", "set up the package", "siapkan project ini",
  "upgrade @restforgejs/platform", "ganti versi restforge"

DO NOT USE FOR:
- Creating a new project folder -> use 'setup_create_folder'
- Generating config skeleton -> use 'setup_init_config'
- Filling in credentials -> use 'setup_write_env'
- Validating the configuration -> use 'setup_validate_config'

SCAFFOLDING NOTE:
The dominant way to create a new RESTForge project is the one-shot scaffolder
'npx create-restforge-app <name>', which makes the folder, runs
'npm install @restforgejs/platform' (local), and bundles the designer binary in a
single step. This 'setup_install_package' tool (and 'setup_create_folder' /
'setup_init_config') are the GRANULAR, programmatic alternative — use them when the
agent must build the project step by step rather than running the interactive
scaffolder. 'npm install @restforgejs/platform' remains valid but is no longer the
primary entry point.

In the granular flow this tool sits in the middle of the new-project setup chain:
typically run after 'setup_create_folder' creates the project folder, and before
'setup_init_config' which generates the configuration skeleton. 'setup_init_config'
will return a precondition message if this tool has not been run first. // per §5.2

This tool runs: npm install @restforgejs/platform@<version> in the given cwd (local install, not global).
Default version is "beta" because RESTForge is currently a public pre-release. Use "latest" once stable, or a specific version (e.g. "1.2.3").

PRESENTATION GUIDANCE:
- Match the user's language. If the user writes in Indonesian, respond in Indonesian.
- Never mention internal tool names in the reply to the user. Describe actions by what they do (e.g. "create the project folder", "generate the initial config", "fill in the credentials").
- Speak in plain language. Summarise the result; do not paste raw npm output unless the user explicitly asks.
- When a precondition is not met (e.g. the project folder is missing), frame it as a question or next-step suggestion rather than an error.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder (must exist before this tool runs)'),
        version: z
          .string()
          .default('beta')
          .describe('npm version or tag: "beta" (default), "latest", or a specific version (e.g. "1.2.3")'),
      },
      annotations: {
        title: 'Install @restforgejs/platform',
        readOnlyHint: false,
        idempotentHint: true,
      },
    },
    async ({ cwd, version }) => {
      const projectCwd = resolve(cwd);

      // Precondition check: the project folder must exist.
      // Treated as a non-error precondition per the authoring guide §3.4.
      try {
        await access(projectCwd);
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: the project folder does not exist yet.

Project path: ${projectCwd}

For the assistant:
- The user is trying to install the RESTForge package into a folder that has not been created yet.
- Suggest creating the project folder first, then retry the installation.
- When explaining to the user, say something like "the project folder isn't there yet — should I create it first?". Do not mention internal tool names.`,
            },
          ],
          isError: false, // per §3.4
        };
      }

      const result = await execProcess(
        'npm',
        ['install', `@restforgejs/platform@${version}`],
        { cwd: projectCwd, timeout: 180_000 }
      );

      // CLI failure: real error per §3.4; structured per §3.5.
      if (!result.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to install the RESTForge package.

Project path: ${projectCwd}
Requested version: ${version}
Command: ${result.command}
Exit code: ${result.exitCode}

--- npm output ---
stdout:
${result.stdout}

stderr:
${result.stderr}
--- end npm output ---

For the assistant:
- Tell the user that the installation did not complete successfully.
- Summarise the likely cause from the npm output in plain language (network, registry, version not found, peer dependency); do not paste the raw stdout/stderr unless the user explicitly asks.
- Offer to retry once the underlying issue is resolved. Do not mention internal tool names.`,
            },
          ],
          isError: true, // per §3.4
        };
      }

      // Success: one-line summary + labeled facts + fenced raw output per §3.5.
      return {
        content: [
          {
            type: 'text',
            text: `RESTForge package installed successfully.

Project path: ${projectCwd}
Installed version: @restforgejs/platform@${version}
Install location: node_modules/@restforgejs/platform

--- npm output ---
${result.stdout}
--- end npm output ---

For the assistant:
- Confirm to the user that the RESTForge package is installed in this project.
- Suggest the next step in plain words: generating the initial configuration skeleton (config and payload templates) so the project can be configured.
- Keep the reply concise. Do not paste the raw npm output unless the user explicitly asks. Do not mention internal tool names.`,
          },
        ],
      };
    }
  );
}
