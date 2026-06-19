import { execa, type ExecaError } from 'execa';

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  /**
   * Environment variables for the subprocess. Merged with parent process env
   * via spread: { ...process.env, ...options.env }. Use this to suppress
   * tooling banners (e.g. NODE_ENV: 'production') or pass tool-specific config.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether to strip the trailing newline from stdout/stderr. Default true
   * (matches execa default). Set to false when byte-perfect passthrough is
   * required (e.g. CLI commands that output template files where the final
   * newline matters).
   */
  stripFinalNewline?: boolean;
}

/**
 * Execute subprocess dengan structured result. Tidak throw — selalu return result.
 * Cocok untuk wrapping CLI calls seperti npm, npx, restforge.
 */
export async function execProcess(
  command: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const { cwd = process.cwd(), timeout = 60_000, env, stripFinalNewline = true } = options;
  const fullCommand = `${command} ${args.join(' ')}`;

  // Merge env: parent env first, custom env overrides
  const mergedEnv = env ? { ...process.env, ...env } : undefined;

  try {
    const result = await execa(command, args, {
      cwd,
      timeout,
      reject: false,
      stripFinalNewline,
      ...(mergedEnv ? { env: mergedEnv } : {}),
    });
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
      command: fullCommand,
    };
  } catch (error) {
    const e = error as ExecaError;
    return {
      success: false,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? e.message,
      exitCode: e.exitCode ?? -1,
      command: fullCommand,
    };
  }
}
