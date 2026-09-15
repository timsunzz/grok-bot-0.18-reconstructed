import { spawn } from "node:child_process";

export const NONINTERACTIVE_RUN_STDIO = Object.freeze([
  "ignore",
  "inherit",
  "inherit",
]);

/**
 * Build steps here shell out to system tools that can block indefinitely rather than fail:
 * `hdiutil detach` waits on a busy volume, `codesign` waits on a stalled network for its trust
 * material. Without a deadline the build hangs with no output and no indication of which command
 * is stuck, which in CI means burning the whole job. The default is generous enough for the
 * slowest legitimate step (a native rebuild) and can be raised per call.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

export function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? NONINTERACTIVE_RUN_STDIO,
    detached: options.detached ?? false,
    shell: false,
  });
}

/**
 * Kills a child that overran its deadline and stops it from holding the event loop open. A killed
 * child's piped stdio keeps the loop alive until it closes, which for a process that ignores
 * SIGKILL-adjacent cleanup can be indefinitely, so the streams are torn down explicitly.
 */
function abandon(child) {
  try { child.kill("SIGKILL"); } catch {}
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try { stream?.destroy(); } catch {}
  }
  try { child.unref(); } catch {}
}

function withDeadline(child, command, timeoutMs, reject) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return () => {};
  const timer = setTimeout(() => {
    abandon(child);
    reject(new Error(`${command} did not finish within ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

export async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, options);
    const clear = withDeadline(child, command, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, reject);
    child.once("error", (error) => { clear(); reject(error); });
    child.once("exit", (code, signal) => {
      clear();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`));
    });
  });
}

export async function capture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const clear = withDeadline(child, command, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, reject);
    child.once("error", (error) => { clear(); reject(error); });
    child.once("exit", (code, signal) => {
      clear();
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}: ${stderr.trim()}`));
    });
  });
}
