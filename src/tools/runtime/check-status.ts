import { z } from 'zod';
import { access, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execProcess } from '../../lib/exec.js';

type SummaryState = 'running' | 'http_unreachable' | 'dead_pid' | 'not_running' | 'unknown';

interface StatusResult {
  cwd: string;
  requested_mode: 'auto' | 'host' | 'pm2';
  detected_mode: 'host' | 'pm2' | 'none';
  pid_file: {
    path: string;
    exists: boolean;
    pid: number | null;
    process_alive: boolean | null;
  };
  port_check: {
    checked: boolean;
    port: number | null;
    in_use: boolean | null;
  };
  pm2: {
    checked: boolean;
    cli_available: boolean;
    apps_total: number;
    project_app: {
      name: string;
      pid: number;
      status: string;
      uptime_ms: number | null;
      restart_count: number;
    } | null;
  };
  http_check: {
    requested: boolean;
    url: string | null;
    status_code: number | null;
    response_time_ms: number | null;
    error: string | null;
  };
  summary: {
    is_running: boolean;
    state: SummaryState;
    description: string;
  };
}

interface Pm2App {
  name?: string;
  pid?: number;
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
  };
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

async function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolveFn) => {
    const tester = createNetServer()
      .once('error', () => resolveFn(true))
      .once('listening', () => {
        tester.close(() => resolveFn(false));
      })
      .listen(port, host);
  });
}

async function probeHttp(
  url: string,
  timeoutMs: number
): Promise<{ status_code: number | null; response_time_ms: number | null; error: string | null }> {
  return new Promise((resolveFn) => {
    const start = Date.now();
    let settled = false;
    const finish = (val: { status_code: number | null; response_time_ms: number | null; error: string | null }): void => {
      if (settled) return;
      settled = true;
      resolveFn(val);
    };
    try {
      const req = httpRequest(url, { method: 'GET' }, (res) => {
        const elapsed = Date.now() - start;
        res.resume();
        res.on('end', () => finish({ status_code: res.statusCode ?? null, response_time_ms: elapsed, error: null }));
        res.on('error', (err) => finish({ status_code: null, response_time_ms: elapsed, error: err.message }));
      });
      req.on('error', (err) => finish({ status_code: null, response_time_ms: null, error: err.message }));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('timeout'));
      });
      req.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ status_code: null, response_time_ms: null, error: msg });
    }
  });
}

function parsePm2Apps(stdout: string): Pm2App[] {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) return parsed as Pm2App[];
    return [];
  } catch {
    return [];
  }
}

function findProjectApp(apps: Pm2App[], projectName: string): Pm2App | null {
  return apps.find((a) => a.name === projectName) ?? null;
}

export function registerRuntimeCheckStatus(server: McpServer): void {
  server.registerTool(
    'runtime_check_status',
    {
      title: 'Check RESTForge Server Status',
      description: `Check whether the RESTForge Server is currently running. Inspects (in order): (1) .restforge/server.pid file (legacy launchers), (2) port-based detection — tries to bind to the configured port; if the bind fails the port is in use and a host-mode server is presumed running, (3) PM2 process list via 'pm2 jlist', (4) optional HTTP health endpoint probe.

USE WHEN:
- The user asks "is the server running?", "apakah server jalan?", "cek status server", "server saya kenapa tidak respond"
- After running the launcher (server-start.bat or equivalent) — to confirm the server actually came up
- Before invoking other tools that talk to the running server — to verify it's reachable
- The user reports the server appears to be down — to diagnose stale PID file vs PM2 app issue vs not started

DO NOT USE FOR:
- Generating launcher files -> use 'runtime_generate_launcher'
- Validating preflight before starting -> use 'runtime_validate_preflight'
- Starting or stopping the server -> the user runs server-start.bat / server-stop.bat themselves
- Calling specific business endpoints to test functionality -> out of scope; this only checks server liveness

Detection modes:
- 'auto' (default): try host mode first (PID file then port-based), fall back to pm2 mode
- 'host': only inspect .restforge/server.pid and the port (skip PM2 entirely)
- 'pm2': only inspect 'pm2 jlist' output (skip PID file and port). Requires 'project' parameter to locate the right app.

Note on host-mode detection:
- Current launcher scripts (generated by 'runtime_generate_launcher') do NOT write .restforge/server.pid. Detection therefore relies primarily on the port-based bind probe — pass 'port' to enable it. The PID-file path is still inspected for backward compatibility with launchers generated by older versions.
- The port probe binds locally on host_address (default 127.0.0.1). If the server binds to a different interface, pass host_address accordingly. A port shown 'in use' confirms a process is listening, but does not guarantee it is the RESTForge server.

Optional HTTP health probe: if 'health_path' is set, the tool performs an HTTP GET against http://<host_address>:<port><health_path> and reports status code + response time. Without health_path, only process liveness is checked.

Preconditions:
- The cwd folder must exist.
- For host mode port-based detection: 'port' must be provided.
- For pm2 mode: PM2 must be installed and running on the user machine.
- For HTTP probe: 'port' must be provided alongside 'health_path'.

PRESENTATION GUIDANCE:
- Match the user's language.
- Never mention internal tool names.
- Summarise the state in one sentence: running, dead_pid (stale), http_unreachable (process up but endpoint dead), or not_running.
- For 'dead_pid': suggest the user run the stop launcher (or 'pm2 delete' for PM2 mode) to clean up before starting again.
- For 'http_unreachable': process is alive but the HTTP probe failed — usually a config mismatch (wrong port or path) or server still booting. Suggest re-trying after a moment or checking server logs.
- For 'not_running': the server isn't currently running. Suggest generating a launcher (if not already done) and asking the user to execute it.
- Do not echo the JSON envelope unless explicitly asked.
- The HTTP probe targets the local machine by default (127.0.0.1). If the server binds to a different address (SERVER_ADDRESS in .env), the user can pass host_address to override.`,
      inputSchema: {
        cwd: z
          .string()
          .min(1)
          .describe('Absolute path of the project folder root (must contain .restforge/ if host mode was used)'),
        mode: z
          .enum(['auto', 'host', 'pm2'])
          .default('auto')
          .describe('Detection mode. auto = try host first, fallback to pm2. host = only check PID file. pm2 = only check pm2 list.'),
        project: z
          .string()
          .min(1)
          .optional()
          .describe('Project name (e.g. mini-inventory). Required for pm2 mode to find the specific app in pm2 list. Optional for host mode (only used in summary text).'),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe('Port the server should be listening on. Required if health_path is set.'),
        host_address: z
          .string()
          .min(1)
          .default('127.0.0.1')
          .describe('Host or IP for the HTTP health check (default 127.0.0.1).'),
        health_path: z
          .string()
          .optional()
          .describe('If set, perform an HTTP GET against http://<host_address>:<port><health_path> and report the result. If omitted, no HTTP probe is performed.'),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(30000)
          .default(3000)
          .describe('HTTP probe timeout in milliseconds (default 3000).'),
      },
      annotations: {
        title: 'Check Server Status',
        readOnlyHint: true,
        idempotentHint: false,
      },
    },
    async ({ cwd, mode, project, port, host_address, health_path, timeout_ms }) => {
      const projectCwd = resolve(cwd);

      // === Branch A: Precondition check ===
      try {
        await access(projectCwd);
      } catch {
        return {
          content: [
            {
              type: 'text',
              text: `Precondition not met: cwd does not exist.

Project path: ${projectCwd}

For the assistant:
- The user pointed to a folder that does not exist on this machine.
- Suggest verifying the path or asking the user to navigate to the correct project root first.
- Match the user's language. Do not mention internal tool names.`,
            },
          ],
          isError: false,
        };
      }

      // === Validate health_path requires port ===
      if (health_path !== undefined && port === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid input: health_path is set but port is not provided. HTTP health check requires a port.

For the assistant:
- Ask the user which port the server is listening on, then retry with both health_path and port.`,
            },
          ],
          isError: false,
        };
      }

      const result: StatusResult = {
        cwd: projectCwd,
        requested_mode: mode,
        detected_mode: 'none',
        pid_file: {
          path: join(projectCwd, '.restforge', 'server.pid'),
          exists: false,
          pid: null,
          process_alive: null,
        },
        port_check: {
          checked: false,
          port: port ?? null,
          in_use: null,
        },
        pm2: {
          checked: false,
          cli_available: false,
          apps_total: 0,
          project_app: null,
        },
        http_check: {
          requested: health_path !== undefined,
          url: null,
          status_code: null,
          response_time_ms: null,
          error: null,
        },
        summary: {
          is_running: false,
          state: 'unknown',
          description: '',
        },
      };

      // === Step 1: Host mode check ===
      // Primary: PID file (legacy launchers from older runtime_generate_launcher).
      // Fallback: port-based detection (current launchers no longer write a PID file).
      if (mode === 'auto' || mode === 'host') {
        try {
          const raw = await readFile(result.pid_file.path, 'utf8');
          const pid = parseInt(raw.trim(), 10);
          result.pid_file.exists = true;
          if (Number.isFinite(pid) && pid > 0) {
            result.pid_file.pid = pid;
            result.pid_file.process_alive = isProcessAlive(pid);
            if (result.pid_file.process_alive === true) {
              result.detected_mode = 'host';
            } else if (result.pid_file.process_alive === false) {
              // stale PID file
              result.summary.state = 'dead_pid';
            }
          }
        } catch {
          // file missing — leave defaults
        }

        // Port-based fallback: only if host not yet detected and port was provided.
        if (result.detected_mode === 'none' && port !== undefined) {
          result.port_check.checked = true;
          const inUse = await isPortInUse(port, host_address);
          result.port_check.in_use = inUse;
          if (inUse) {
            result.detected_mode = 'host';
          }
        }
      }

      // === Step 2: PM2 fallback (if not detected as host) ===
      const tryPm2 = mode === 'pm2' || (mode === 'auto' && result.detected_mode === 'none');
      if (tryPm2) {
        result.pm2.checked = true;
        const pm2Result = await execProcess('pm2', ['jlist'], { timeout: 10_000 });
        if (pm2Result.success) {
          result.pm2.cli_available = true;
          const apps = parsePm2Apps(pm2Result.stdout);
          result.pm2.apps_total = apps.length;
          if (project !== undefined) {
            const matched = findProjectApp(apps, project);
            if (matched && matched.pid !== undefined && matched.pm2_env !== undefined) {
              const status = matched.pm2_env.status ?? 'unknown';
              const uptime = matched.pm2_env.pm_uptime;
              const uptimeMs = status === 'online' && typeof uptime === 'number' ? Date.now() - uptime : null;
              result.pm2.project_app = {
                name: matched.name ?? project,
                pid: matched.pid,
                status,
                uptime_ms: uptimeMs,
                restart_count: matched.pm2_env.restart_time ?? 0,
              };
              if (status === 'online') {
                result.detected_mode = 'pm2';
              } else if (result.detected_mode === 'none') {
                result.summary.state = 'dead_pid';
              }
            }
          }
        } else {
          result.pm2.cli_available = false;
          if (mode === 'pm2') {
            // Mode pm2 explicit: real error
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to query PM2: pm2 command not available or returned an error.

Project path: ${projectCwd}
Command: ${pm2Result.command}
Exit code: ${pm2Result.exitCode}
stderr: ${pm2Result.stderr || '(empty)'}

For the assistant:
- The user requested PM2 mode but PM2 is not installed (or pm2 jlist failed).
- Suggest installing PM2 globally first: npm install -g pm2.
- Or, if the user is using host mode instead, retry with mode='host' or mode='auto'.
- Match the user's language. Do not mention internal tool names.`,
                },
              ],
              isError: true,
            };
          }
          // mode='auto': silently continue
        }
      }

      // === Step 3: HTTP health check (optional) ===
      if (
        result.http_check.requested &&
        port !== undefined &&
        health_path !== undefined &&
        result.detected_mode !== 'none'
      ) {
        const url = `http://${host_address}:${port}${health_path.startsWith('/') ? health_path : '/' + health_path}`;
        result.http_check.url = url;
        const probe = await probeHttp(url, timeout_ms);
        result.http_check.status_code = probe.status_code;
        result.http_check.response_time_ms = probe.response_time_ms;
        result.http_check.error = probe.error;
      }

      // === Step 4: Determine final summary state ===
      if (result.detected_mode === 'host' || result.detected_mode === 'pm2') {
        if (result.http_check.requested) {
          if (
            result.http_check.status_code !== null &&
            result.http_check.status_code >= 200 &&
            result.http_check.status_code < 300
          ) {
            result.summary.state = 'running';
            result.summary.is_running = true;
            result.summary.description = `Server running in ${result.detected_mode} mode and HTTP health check returned ${result.http_check.status_code}.`;
          } else {
            result.summary.state = 'http_unreachable';
            result.summary.is_running = false;
            result.summary.description = `Server process exists in ${result.detected_mode} mode but HTTP health check failed (${result.http_check.error ?? `status ${result.http_check.status_code}`}).`;
          }
        } else {
          result.summary.state = 'running';
          result.summary.is_running = true;
          const detectionSource =
            result.detected_mode === 'host'
              ? result.pid_file.process_alive === true
                ? 'PID file points to a live process'
                : `port ${result.port_check.port ?? '?'} is in use`
              : 'PM2 app is online';
          result.summary.description = `Server process detected in ${result.detected_mode} mode (${detectionSource}; HTTP probe not requested).`;
        }
      } else if (result.summary.state === 'dead_pid') {
        result.summary.is_running = false;
        result.summary.description = result.pid_file.exists
          ? `PID file exists at ${result.pid_file.path} but the process is no longer alive (stale).`
          : result.pm2.project_app
            ? `PM2 app '${result.pm2.project_app.name}' is not online (status=${result.pm2.project_app.status}).`
            : 'A previous server instance is no longer alive.';
      } else {
        result.summary.state = 'not_running';
        result.summary.is_running = false;
        result.summary.description = 'No running server detected (no PID file and no matching PM2 app).';
      }

      const prettyJson = JSON.stringify(result, null, 2);
      const labeledFacts = [
        `Project path: ${result.cwd}`,
        `Requested mode: ${result.requested_mode}`,
        `Detected mode: ${result.detected_mode}`,
        `PID file: ${result.pid_file.exists ? `exists (pid=${result.pid_file.pid}, alive=${result.pid_file.process_alive})` : 'absent'}`,
        `Port check: ${result.port_check.checked ? `port ${result.port_check.port} ${result.port_check.in_use ? 'in use' : 'free'}` : 'not checked'}`,
        `PM2 checked: ${result.pm2.checked ? `yes (cli_available=${result.pm2.cli_available}, apps_total=${result.pm2.apps_total})` : 'no'}`,
        `HTTP check: ${
          result.http_check.requested
            ? `requested → ${result.http_check.url ?? '(no url)'} → ${result.http_check.status_code ?? `error: ${result.http_check.error ?? 'n/a'}`}`
            : 'not requested'
        }`,
        `State: ${result.summary.state}`,
        `Is running: ${result.summary.is_running}`,
      ].join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `${result.summary.description}

${labeledFacts}

--- Status Result (JSON) ---
${prettyJson}
--- end Status Result (JSON) ---

For the assistant:
- Summarise the running state in plain language.
- If state='running': confirm to the user that the server is up. If HTTP check was performed, mention it returned 2xx and the response time.
- If state='http_unreachable': tell the user the process exists but the HTTP endpoint did not respond — suggest checking the server logs or that the health_path/port matches the actual config.
- If state='dead_pid': tell the user there's a stale PID file (or PM2 app in non-online state). Suggest cleaning up by running the stop launcher (or 'pm2 delete' for PM2 mode), then starting the server again.
- If state='not_running': tell the user no server is currently running. Suggest generating a launcher (if not already done) and running it.
- Do not paste the JSON unless the user explicitly asks. Do not mention internal tool names.
- Match the user's language.`,
          },
        ],
        isError: false,
      };
    }
  );
}
