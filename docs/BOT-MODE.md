# Grok Bot agents vs Hermes Agent Bot Mode

This reconstruction already has a multi-agent core: each on-disk agent is one
forever conversation, `SendToAgent` is the peer DM tool, and
`GroupChatOrchestrator` drives rooms. Hermes Agent's Bot Mode is a desktop
roster over isolated profiles. The two products overlap, but they are not the
same primitive.

## What is the same

| Concern | Hermes Bot Mode | Grok Bot 0.18 |
| --- | --- | --- |
| Persistent specialist | Profile under `~/.hermes/profiles/<bot>/` | Agent directory + `store.db` + `profile.json` |
| Peer DM | `message_agent` | `SendToAgent` |
| Group rooms | 2–6 members, 3 rounds | `GROUP_MAX_MEMBERS = 6`, `GROUP_MAX_ROUNDS = 3` |
| Hide without deleting | Display-only hide | `hiddenFromSidebar` |
| Recurring work | Routines / `hermes cron` | Per-agent automations |
| Outside chat | Messaging gateway | Slack/Discord *channels* (still coming soon) |

## What was different, and what this branch changes

Hermes Bot Mode's robustness is a **delivery protocol**: typed failure codes,
at-most-once retry, refuse-when-unreadable, and retain-the-delivery-id. Grok
Bot had the product surface but treated damaged state as empty and dropped
dequeued inbound work.

| Hermes behavior | Previous Grok Bot gap | Change in this branch |
| --- | --- | --- |
| Typed `[reason:…]` codes | Free-text channel/A2A errors | Shared `delivery-reasons` classifier on A2A, channels, and group-member failures |
| Retry once, only if transient | Channel wake said “never retry”; group member failures were silent passes | Auth/quota/config never retry; transient codes may retry once; failed member turns post a room notice |
| `unknown-durability` ≠ dispatch | `admitSend` treated a damaged ledger as a new send | `PromptAcceptanceUnknownDurabilityError` refuses the retry |
| Do not drop dequeued work | A2A/channel inbound deleted the queue, then returned on session-open failure | Same requeue pattern as channel-failure wakes |
| Hard conversation cap | GC throw/skip let the turn proceed over the cap | Always throw `SandConversationTooLargeError` when still over |
| Hidden bots still `@mention`able | Composer autocomplete skipped hidden agents | Hidden agents stay in `@` suggestions |
| Combined 6-seat rooms | Local and remote member lists each capped at 6 (up to 12) | Combined roster cap of 6 |
| Ambiguous `@alice` | First-token handle matched the first Alice | Only unique handles resolve |

This is not a Hermes clone. There is no Bots pane, no `message_agent` protocol
injection, no Desktop courier, and no `hermes peer` gateway. The work stays
inside Grok Bot's existing agent, channel, and router pipes.

## Routed inference robustness

The reconstructed router is the other hot path. It now:

- refuses to persist over a damaged or unknown-schema transcript;
- serializes the whole multi-agent store, not just per-agent model turns;
- ACKs `sendPrompt` only after validating input and canonicalizing `clientNonce`;
- treats a repeated nonce as an idempotent no-op;
- writes success and failure onto the same assistant id, keeping streamed text;
- merges local routed turns even when the remote tail is malformed;
- accepts Codex `auth.json` that is user-owned after a `0600` repair (including a
  symlink to a regular file);
- frames Codex SSE on both `\n\n` and `\r\n\r\n`;
- parses Claude MCP tool arguments that arrive as JSON strings and keeps a
  stable `toolCallId`.

## What still cannot run here

The packaged desktop app is macOS / Apple Silicon plus Node 26.5. This Linux
environment can run the Node test suite and typecheck, not `npm run package`
or the Electron UI.
