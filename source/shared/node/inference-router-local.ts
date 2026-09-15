import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface LocalInferenceCliStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly executablePath: string | null;
}

export function isUsableExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Reject group/other-writable credential files; follow a symlink to a regular file. */
export function isSafeCredentialFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function firstExecutable(candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate != null && candidate.length > 0 && isUsableExecutable(candidate)) return candidate;
  }
  return null;
}

function pathCandidates(name: string): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, name));
}

export function resolveCodexCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CODEX_PATH, join(home, ".local", "bin", "codex"), join(home, ".codex", "bin", "codex"), ...pathCandidates("codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
}

export function resolveClaudeCodeCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CLAUDE_CODE_PATH, join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), ...pathCandidates("claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
}

export function resolveCodexAuthPath(): string {
  return join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
}

function hasUsableCodexLogin(path: string): boolean {
  if (!isSafeCredentialFile(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return parsed.auth_mode === "chatgpt"
      && typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0
      && typeof parsed.tokens?.refresh_token === "string" && parsed.tokens.refresh_token.length > 0
      && typeof parsed.tokens?.id_token === "string" && parsed.tokens.id_token.length > 0
      && typeof parsed.tokens?.account_id === "string" && parsed.tokens.account_id.length > 0;
  } catch { return false; }
}

export function getLocalInferenceCliStatus(): { readonly codex: LocalInferenceCliStatus; readonly "claude-code": LocalInferenceCliStatus } {
  const home = homedir();
  const codexPath = resolveCodexCliPath();
  const claudePath = resolveClaudeCodeCliPath();
  const codexAuthPath = resolveCodexAuthPath();
  const hasCodexAuthFile = existsSync(codexAuthPath);
  const hasCodexLogin = hasUsableCodexLogin(codexAuthPath);
  return {
    // Codex inference is a Grok Bot-owned HTTP transport authenticated by the
    // existing Codex login. The CLI binary is not in the request path.
    codex: { installed: hasCodexAuthFile, authenticated: hasCodexLogin, executablePath: codexPath },
    "claude-code": { installed: claudePath != null, authenticated: isSafeCredentialFile(join(home, ".claude", ".credentials.json")) || (process.env.ANTHROPIC_API_KEY?.length ?? 0) > 0, executablePath: claudePath },
  };
}
