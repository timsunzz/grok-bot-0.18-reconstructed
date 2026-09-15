// A plugin server that is failing every call will keep failing for the rest of the turn, and a
// routed tool loop will happily spend all of its steps rediscovering that — each step a paid
// provider request. After a few consecutive failures the breaker answers for the server instead,
// in words that tell the model to stop rather than to try once more.
//
// "Nothing reached the plugin" and "the plugin rejected the call" need different fixes, so the
// refusal keeps them apart: conflating them sends the model to the user when the real problem is
// its own arguments.

export const ROUTED_TOOL_BREAKER_THRESHOLD = 3;
export const ROUTED_TOOL_BREAKER_COOLDOWN_MS = 60_000;

export type RoutedToolFailureKind = "unreachable" | "rejected";

type ServerState = { failures: number; everUnreachable: boolean; openedAtMs: number | null };

export type RoutedToolBreaker = {
  // Non-null is the text to answer the model with instead of dispatching the call.
  refusal(server: string): string | null;
  recordSuccess(server: string): void;
  recordFailure(server: string, kind: RoutedToolFailureKind): void;
};

export function createRoutedToolBreaker(options?: {
  readonly threshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}): RoutedToolBreaker {
  const threshold = Math.max(1, options?.threshold ?? ROUTED_TOOL_BREAKER_THRESHOLD);
  const cooldownMs = Math.max(0, options?.cooldownMs ?? ROUTED_TOOL_BREAKER_COOLDOWN_MS);
  const now = options?.now ?? Date.now;
  const states = new Map<string, ServerState>();
  const stateOf = (server: string): ServerState => {
    const existing = states.get(server);
    if (existing != null) return existing;
    const created: ServerState = { failures: 0, everUnreachable: false, openedAtMs: null };
    states.set(server, created);
    return created;
  };

  return {
    refusal(server) {
      const state = states.get(server);
      if (state?.openedAtMs == null) return null;
      const remainingMs = state.openedAtMs + cooldownMs - now();
      // The cooldown has elapsed, so the next call probes the server for real: it either
      // succeeds and clears the breaker, or fails and re-arms the cooldown.
      if (remainingMs <= 0) return null;
      const pause = `Paused for about ${Math.ceil(remainingMs / 1_000)}s.`;
      return state.everUnreachable
        ? `Grok Bot could not reach the "${server}" plugin on the last ${state.failures} calls. ${pause} Do not call it again: continue without it, or tell the person it is unavailable.`
        : `The "${server}" plugin rejected the last ${state.failures} calls — it answered every time, so see the error each call returned. ${pause} Do not repeat the same call: change the arguments or take a different approach.`;
    },
    recordSuccess(server) {
      states.delete(server);
    },
    recordFailure(server, kind) {
      const state = stateOf(server);
      state.failures += 1;
      if (kind === "unreachable") state.everUnreachable = true;
      if (state.failures >= threshold) state.openedAtMs = now();
    },
  };
}
