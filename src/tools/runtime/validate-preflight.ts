import { z } from 'zod';
import { access, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

interface PreflightResult {
  config_validation: {
    ran: boolean;
    success: boolean;
    cli_command: string;
    cli_exit_code: number;
    cli_stdout: string;
    cli_stderr: string;
  };
  pid_file: {
    path: string;
    exists: boolean;
    pid: number | null;
    process_alive: boolean | null;
  };
  port_check: {
    requested: boolean;
    port: number | null;
    available: boolean | null;
  };
  warnings: string[];
  errors: string[];
}

async function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveFn) => {
    const tester = createServer()
      .once('error', () => resolveFn(false))
      .once('listening', () => {
        tester.close(() => resolveFn(true));
      })
      .listen(port);
  });
}

function isProcessAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ESRCH') return false;
    if (e.code === 'EPERM') return true;
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.substring(0, n) + '...' : s;
}

export function registerRuntimeValidatePreflight(server: McpServer): void {
  server.registerTool(
    'runtime_validate_preflight',
    {
      title: 'Validate RESTForge Runtime Preflight',
      description: `Run a runtime preflight check before generating a launcher. Wraps 'npx restforge validate --config=<config>' (license + database + redis/kafka) and additionally inspects: (1) .restforge/server.pid to detect a possibly-running server, (2) optional local port availability via Node net binding.

USE WHEN:
- Before invoking 'runtime_generate_launcher' — to verify the project is ready to launch
- The user asks "is this ready to run?", "preflight check", "cek apakah server bisa dijalankan"
- After changing config or installing a new license — to verify everything still works
- The user reports the server fails to start — to identify the failing component

DO NOT USE FOR:
- Validating ONLY the config (license/database) without runtime context -> use 'setup_validate_config'
- Listing or reading config values -> use 'setup_read_env'
- Generating launcher files -> use 'runtime_generate_launcher'

This tool runs: npx restforge validate --config=<config> in the given cwd, plus filesystem checks (PID file, optional port).

Preconditions:
- The project must have @restforgejs/platform installed in node_modules.
- The config file must exist in the config/ folder.

PRESENTATION GUIDANCE:
- Match the user's language.
- Never mention internal tool names.
- Summarise by component: license, database, optional redis/kafka, PID file presence, port availability.
- Do not echo license keys, passwords, or full connection URIs from the CLI output.
- Preflight failure is informational, not a blocker. The user can still proceed to generate the launcher (with a warning recorded).
- Port check is best-effort: a "free" result on this machine does not guarantee the port is free for the eventual server bind address (which may differ).`,
      inputSchema: {
        cwd: z.string().min(1).describe('Absolute path of the project folder root'),
        config: z
          .string()
          .min(1)
          .default('db-connection.env')
          .describe('Config file name in the config/ folder (default: db-connection.env)'),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Port to check availability (optional). When set, the tool tries to bind locally to detect if the port is free.'),
      },
      annotations: {
        title: 'Validate Runtime Preflight',
        readOnlyHint: true,
        idempotentHint: false,
      },
    },
    async ({ cwd, config, port }) => {
      const projectCwd = resolve(cwd);

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
- The user needs to install the RESTForge package before runtime preflight can run.
- Suggest installing the package first, then retry preflight.
- Match the user's language. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      const result: PreflightResult = {
        config_validation: {
          ran: false,
          success: false,
          cli_command: '',
          cli_exit_code: -1,
          cli_stdout: '',
          cli_stderr: '',
        },
        pid_file: { path: '', exists: false, pid: null, process_alive: null },
        port_check: {
          requested: port !== undefined,
          port: port ?? null,
          available: null,
        },
        warnings: [],
        errors: [],
      };

      const cliResult = await execProcess(
        'npx',
        ['restforge', 'validate', `--config=${config}`],
        { cwd: projectCwd, timeout: 30_000 }
      );
      result.config_validation = {
        ran: true,
        success: cliResult.success,
        cli_command: cliResult.command,
        cli_exit_code: cliResult.exitCode,
        cli_stdout: truncate(cliResult.stdout || '', 500),
        cli_stderr: truncate(cliResult.stderr || '', 500),
      };
      if (!cliResult.success) {
        result.warnings.push(
          'Config validation did not pass — see config_validation.cli_stderr for details.'
        );
      }

      const pidPath = join(projectCwd, '.restforge', 'server.pid');
      result.pid_file.path = pidPath;
      try {
        const raw = await readFile(pidPath, 'utf8');
        const pid = parseInt(raw.trim(), 10);
        result.pid_file.exists = true;
        if (Number.isFinite(pid) && pid > 0) {
          result.pid_file.pid = pid;
          result.pid_file.process_alive = isProcessAlive(pid);
          if (result.pid_file.process_alive === true) {
            result.warnings.push(
              `A server appears to be already running with PID ${pid}. Stop it first or it may conflict on the port.`
            );
          }
        } else {
          result.warnings.push('PID file exists but contains an invalid value.');
        }
      } catch {
        result.pid_file.exists = false;
      }

      if (port !== undefined) {
        result.port_check.available = await checkPortAvailable(port);
        if (result.port_check.available === false) {
          result.warnings.push(`Port ${port} is already in use on this machine.`);
        }
      }

      const envelope = result;
      const prettyJson = JSON.stringify(envelope, null, 2);
      const allPassed = result.config_validation.success && result.warnings.length === 0;
      const summary = allPassed
        ? 'Runtime preflight passed: config valid, no PID file conflict, port available.'
        : 'Runtime preflight completed with warnings — see details below.';

      const pidFileSummary = result.pid_file.exists
        ? `exists (pid=${result.pid_file.pid}, alive=${result.pid_file.process_alive})`
        : 'absent';
      const portSummary = result.port_check.requested
        ? result.port_check.available
          ? 'yes'
          : 'no'
        : '(not checked)';

      return {
        content: [
          {
            type: 'text',
            text: `${summary}

Project path: ${projectCwd}
Config: ${config}
Port checked: ${port ?? '(not requested)'}
Config validation: ${result.config_validation.success ? 'OK' : 'FAILED'}
PID file: ${pidFileSummary}
Port available: ${portSummary}
Warnings: ${result.warnings.length}

--- Preflight Result (JSON) ---
${prettyJson}
--- end Preflight Result (JSON) ---

For the assistant:
- ${
              allPassed
                ? 'All preflight checks passed. The user can proceed to generate the launcher.'
                : 'Some checks reported warnings. Summarise them in plain language to the user. The user can still choose to proceed (the launcher will be generated regardless).'
            }
- Config validation runs the same checks as the standalone validator: license, database connection, and any enabled feature dependencies (redis, kafka).
- PID file check inspects .restforge/server.pid: if a process is alive, warn the user that another server may be running.
- Port check is best-effort: it tries to bind locally to the port. A port may still be in use by another machine on the same address — this only checks the local machine.
- Do not echo full CLI stdout/stderr unless explicitly asked. Do not echo license keys or credentials.
- Match the user's language. Do not mention internal tool names.`,
          },
        ],
        isError: false,
      };
    }
  );
}
