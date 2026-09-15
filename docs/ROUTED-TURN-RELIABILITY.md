# Routed turn reliability

A routed turn is one exchange the coordinator runs against a provider the
desktop app does not own: a local Codex login, a local Claude Code login, or
OpenRouter over the network. It has no server-side transcript to resume from, no
checkpoint, and no supervisor. Whatever the turn is going to promise about
failure has to be enforced locally, in
`source/node-agent-coordinator/inference-router.ts` and the two shared modules it
leans on.

## What a routed turn guarantees

**Every failure carries a code.** `source/shared/routed-turn-failure.ts` holds a
closed vocabulary of reasons. A failure is classified before it reaches a
transcript, stored as a `failureReason` field on the reply and reported as
`[reason: <code>] Router error: <original text>`, so a surface can branch on the
code without parsing prose while the person still reads the provider's own
sentence. Classification prefers what the provider client recorded — an HTTP
status on the error — over what can be scraped out of prose, because prose gets
reworded.

**A prompt runs once, and a failed prompt can be sent again.** A resubmission
carries the `clientNonce` of the submission it repeats; a prompt that has already
been *answered* under that nonce is acknowledged without running the turn again.
A prompt whose turn failed is not: resending it is how a person retries, and the
desktop's resend reuses the nonce. A reused nonce carrying different text always
runs, because dropping a real message is worse than an extra turn.

**A turn that has stopped moving ends.** What every routed provider request
carries is a bound on *silence*, not on duration: three minutes with nothing at
all from the provider (`SAND_ROUTED_IDLE_TIMEOUT_MS` to change it), and it aborts
the request rather than only abandoning it. Without one, a provider that stopped
answering without closing its socket left the turn pending for the life of the
process — and because the coordinator runs one routed turn per agent at a time,
that turn swallowed every later prompt for that agent. A total-duration cap would
have traded that for a new failure, since a turn that reasons at length and then
works through eight tool steps is working. So anything the provider sends resets
the window, down to a reasoning delta the transports otherwise keep to
themselves, and so does a plugin call running on the provider's behalf. The same
deadline covers the host's own agent turns, not just the coordinator's routed
ones. It is deliberately not an `AbortError` or `TimeoutError`, because those are
how a cancelled turn arrives and a cancelled turn is never retried.

**At most one retry, and only when a retry could change the answer.** Rate
limits, server errors, unreachable providers and malformed streams are retried
once. Missing credentials, an uninstalled provider, expired auth, exhausted
quota, context overflow, a hit step limit, an invalid request and a cancelled
turn are not: a second attempt would only spend another provider request. The
retried attempt resumes the same turn — it rewrites that turn's assistant entry
rather than appending a second one, and it never renumbers the turn.

**A turn that already applied something is never retried.** Routed turns execute
plugin tools for up to eight steps before the provider stream can die, and
nothing rolls those calls back. Tool execution for both transports funnels
through one function that marks the turn the moment a write-capable call is
*dispatched* — not when it returns, because a write whose transport died on the
way back may still have landed. The retry gate reads that mark alongside the
reason, and the transcript says so, because the useful next step is checking what
took effect rather than sending the same request again.

**The provider sets the pace, and only one layer retries.** A refusal carrying
`Retry-After` is honoured rather than guessed at; retrying before the reset only
re-trips it. The wait is jittered so concurrent turns do not resynchronise on the
same instant, and a wait longer than a foreground turn can hide (30s) fails with
its reason instead of stalling behind a sleep nobody can see or cancel.
`Retry-After: 0` is treated as absent so it cannot hot-loop the provider that just
refused us. Where the router retries — the coordinator's routed turns — the AI
SDK's own two retries are turned off, since they run back to back inside a single
attempt, before any header is read, and would make one rate-limited turn cost six
provider requests. The host's agent turns have no router retry above them, so
there the SDK keeps its own.

**A broken plugin stops costing steps.** After three consecutive failures, a
per-plugin breaker answers tool calls itself for a minute, then lets exactly one
probe through. Its refusal distinguishes a plugin nothing could reach from a
plugin that answered every time and rejected the call, because those need
different fixes from the model.

Regression coverage: `tests/routed-turn-failure.test.mjs`,
`tests/routed-turn-recovery.test.mjs`, `tests/routed-turn-side-effects.test.mjs`,
`tests/routed-tool-breaker.test.mjs`,
`tests/routed-provider-side-channels.test.mjs`,
`tests/routed-mcp-bridge-abort.test.mjs`.

## Compared with Hermes Agent's Bot Mode

Several rules above were adopted after reading Bot Mode in
[`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) at
commit `69fd61b`. The comparison is worth recording because the two systems look
alike from a distance — both are Electron desktop agents over a local backend
with many model providers — and the interesting parts are where they diverge.

Bot Mode is not a headless run mode or a chat-platform integration; those are
separate Hermes subsystems. It is a multi-agent layer: a Hermes profile becomes a
named Bot with its own persistent chat, pinned model and memory, and Bots message
each other. So the overlap with Grok Bot is the reliability substrate underneath,
not the feature.

**What both do the same way, arrived at independently.** A closed vocabulary of
failure reason codes, carried ahead of the human text as `[reason: …]`, with an
explicitly enumerated retryable subset. Deliberately shallow retries: one re-run,
never a fresh conversation, and never for auth, quota or configuration. Local
tool trust annotations derived from whether a call can write. A single-flight
guard so two submissions for the same conversation cannot run concurrently.

**What Hermes does that Grok Bot now does too.** Refusing to re-execute when the
outcome of the first attempt is unknown. Hermes states the rule three separate
times — a live-delivery mailbox whose claims never expire, MCP write-capable
calls that are not replayed after a transport died mid-call, and a delivery
ledger that labels an ambiguous redelivery rather than hiding it. Grok Bot's
routed retry was gated on the failure class alone, even though the app's own
Cursor-path runner already weighed the progress an attempt had made
(`shouldRetryTurnAttempt` in `source/host/runner/transient-stream-error.ts`). It
now weighs the same thing. Likewise the per-server tool breaker: Hermes added one
after watching a model burn ninety iterations against a dead MCP server, and the
routed tool loop had the same shape of hole.

**Where the two genuinely differ.**

- *Routing.* Hermes traverses a declarative fallback chain and advances it only
  when a classified error says to; there is no cost, latency or capability
  scoring. Grok Bot's router is a deliberate provider choice a person makes and
  sees, with usage recorded per provider. Neither is a policy router, and they
  are not solving the same problem: Hermes is choosing a survivor, Grok Bot is
  honouring a preference.
- *Unit of work.* A Hermes bot turn is an OS process — `hermes -p <profile> chat
  -c "Bot Chat" …` — whose stdout is the reply. That buys crash isolation and a
  cross-process `flock` for free, and costs a process per turn. A routed turn is
  a function call inside the coordinator, so its single-flight guard is an
  in-process promise queue: cheaper, and correct only because one coordinator
  owns the routed transcript.
- *Scope.* There is no agent-to-agent messaging here to need Hermes' mailbox,
  envelope TTLs, room driver or bot-loop guard. Those exist because two Hermes
  profiles replying to each other never stop on their own.

**What was left alone on purpose.** Hermes retries a context overflow after
compaction shrinks the transcript — "the one sanctioned context mutation".
Routed turns have no compaction pass, so the same retry would resend the same
oversized prompt; `context_overflow` stays non-retryable until there is something
for the second attempt to do differently. Hermes' cross-process turn lock is also
a silent no-op on Windows, which is a reminder that a lock is only as good as the
platform it is claimed on rather than something to copy.

Hermes' weakest area by its own structure is observability: correlated redacted
logs, but line-oriented text, no metrics and no tracing across a topology that
crosses two gateways and a relay. Grok Bot inherits OpenTelemetry from the
shipped app, so the routed path's gap is narrower — but it is still worth saying
that nothing above emits a span today.

## What is still not guaranteed

- Nothing bounds a turn's total duration, only its silences, and the retried
  attempt gets a fresh window of its own. A provider that keeps talking without
  finishing is not something this stops.
- The breaker's state lives in one turn's closure. A plugin that fails every call
  is rediscovered by the next turn, which is deliberate — a person who fixes a
  plugin should not have to wait out a cooldown — but it means the first few
  calls of each turn can still be spent on a server that is down.
- Read-only classification is inferred from a tool's name and description, not
  declared by the plugin. A tool whose name reads like a query but writes is
  treated as replayable.
- Nothing here emits a span or a metric, so the retry, pacing and breaker
  decisions are visible only in the transcript entry they produce.
