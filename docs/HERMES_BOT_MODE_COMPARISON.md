# Hermes Agent Bot Mode comparison

This comparison uses the public Hermes Agent Bot Mode documentation as of
2026-09-15. Grok Bot and Hermes use different names, but many of their runtime
primitives overlap.

| Capability | This project | Hermes Agent Bot Mode |
| --- | --- | --- |
| Stable specialist identity | Agent directory with `profile.json`, persona, memory, model, skills, and avatar metadata | A Bot is an isolated Hermes profile |
| Persistent conversation | Each agent owns a durable transcript and session database | Each Bot owns a canonical, persistent Bot Chat |
| Scheduled work | Per-agent automations and routines | Per-profile cron jobs shown as Routines |
| Direct coordination | `SendToAgent`, asynchronous wake-up, attribution, images, and optional priority interruption | `message_agent`, asynchronous delivery receipts, and bot-to-bot protocol injection |
| Group deliberation | Persistent groups, mentions, pass semantics, 3-round and 10-turn caps | Persistent group rooms, mentions, pass semantics, 3-round and 10-message caps |
| Remote collaboration | Shared rooms and cross-user remote agent references | Multi-gateway desktop relay and headless `hermes peer` |
| CLI/UI parity | Desktop-first reconstructed runtime; no equivalent profile CLI is documented | Profiles and routines have first-class CLI parity |
| Delivery durability | Transcript persistence exists, but direct-message admission is currently process-local | Durable ingress, delivery IDs and receipts are stored on disk |
| Failure contract | Internal structured `SandError` registry; `SendToAgent` still returns human-readable acknowledgements | End-to-end typed bot delivery reasons |

## Reliability improvement in this repository

Direct agent messages used to be removed from the in-memory queue before the
recipient session was resolved. A temporary storage/session-open error therefore
lost an accepted message silently. The queue now restores the whole batch,
preserves priority ordering relative to messages that arrived concurrently, and
leaves it available for a later revival attempt. A genuinely deleted agent is
still treated as terminal.

This closes the most immediate loss window, but it does not make admission
durable across a host crash. Reaching Hermes-style delivery semantics would
require a small write-ahead inbox per target agent with:

1. a caller-provided or generated idempotency key;
2. persisted `queued`, `settled`, and terminal-failure receipts;
3. bounded expiry and replay after restart; and
4. a typed public failure reason instead of parsing acknowledgement text.

That should extend the existing transcript/pending-wake stores rather than add a
second Bot-specific runtime. Agents already are the stable specialist primitive
in this project, just as profiles are in Hermes.

Source: [Hermes Agent Bot Mode documentation](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode).
