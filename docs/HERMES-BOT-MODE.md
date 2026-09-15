# Grok Bot router vs Hermes Agent Bot Mode

This reconstruction is a single-user macOS desktop agent with an inference
router. [Hermes Agent Bot Mode](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/bot-mode.md)
is a multi-profile roster: each Bot is an isolated Hermes profile with its own
chat, model, memory, skills, routines, and avatar. Bots can sit in group rooms
and message each other.

The two products are not the same primitive. The useful comparison is the
**turn runner**: how a conversation admits work, isolates history, survives
provider failure, and refuses to loop.

## What is the same

| Concern | Hermes Bot Mode | Grok Bot router |
| --- | --- | --- |
| Serial turns per conversation | Session turn lease keyed by resolved session id | Per-`agentId` promise queue plus a serialized transcript write chain |
| Durable transcript | Session database with rewind/repair | `inference-router-transcript.json` with atomic replace |
| Tool ceiling | Room/member caps and max turns | `maxSteps` / `maxTurns` of 8, plus a repeated-call guard |
| Typed failures | `reason` codes on delivery and retries | `Router error [reason]: …` using the same reason family |
| Transient retry | Retry once for rate limit, 5xx, timeout, offline | Same: auth/quota/config never auto-retry |
| Streaming + in-place settle | Stream consumer updates the live turn | Assistant deltas reuse `tNs0`; failures update that row instead of appending a second id |
| Activity while working | Roster "active now" / heartbeat | Local `currentActivity: thinking` pulse until the turn settles |

## What stays different

Hermes Bot Mode is a **fleet UI over profiles**:

- a Bots roster, canonical forever-chats, hide/unhide, sections
- per-bot model/skills/MCP/SOUL, routines (`cron` namespaced `[bot:<name>]`)
- group rooms with serial member rounds, `@mentions`, `@user` escalation
- `message_agent` DMs, Desktop relay, `hermes peer`, loop guard on bot-authored inbound
- warm backend slots and idle reap

Grok Bot remains a **desktop shell + router**:

- one user-facing agent, four inference backends (Cursor, Claude Code, Codex, OpenRouter)
- shipped renderer, reconstructed main/host/coordinator
- MCP plugins already connected to Grok Bot, not a Bot roster
- optional local Docker box instead of the remote sandbox

This project does not grow a second agent roster. That would be a different
product and would fight the checksum-pinned UI.

## What we adopted

The router now borrows the Bot Mode *discipline*, not the roster:

1. **Turn lease / write mutex** — transcript append, upsert, and reactions share one write chain so a reaction cannot drop an in-flight turn.
2. **Sequential ids** — failures use `tNs0` for that turn. `Date.now()` ids are rejected on reload so a crash cannot jump the counter into the billions.
3. **Stall timeout** — each provider call has an abortable budget (`SAND_ROUTER_TURN_TIMEOUT_MS`, default 180s).
4. **Typed retry** — 429/5xx/timeout/offline retry once; 401/quota/missing config do not.
5. **Loop guards** — repeated identical tool+args are blocked; a sliding-window guard drops prompt storms (`SAND_ROUTER_TURN_GUARD_*`).
6. **Readiness before spend** — missing Claude/Codex/OpenRouter credentials fail in-transcript after the user row is stored.
7. **MCP bridge hygiene** — discover tools on first `tools/call`, reject oversize bodies, return JSON-RPC method errors.

## What we deliberately did not copy

- Multi-bot roster, group rooms, and agent-to-agent DMs
- Auto-retry of context overflow via compaction (no compressor in this tree)
- 5s fail-closed lease wait (a desktop follow-up should queue behind a long Codex turn, not bounce)
- Bot-authored inbound cooldowns of 20 events / 5 minutes (this router is one human, not two bots ping-ponging)
