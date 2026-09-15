# Bot Mode compared with Hermes Agent

Grok Bot 0.18 already had a **named-agent roster**, sidebar sections, automations
(`/routines`), and groups with a six-member cap. Hermes Agent's Bot Mode is a
UI over isolated **profiles**. This reconstruction now treats those two ideas as
the same primitive on the local side.

## What is the same?

| Concern | Grok Bot (this repo) | Hermes Bot Mode |
| --- | --- | --- |
| A bot is a durable specialist | Named agent / local `BotProfile` | Hermes profile under `~/.hermes/profiles/` |
| Roster + hide | Sidebar roster, hidden chats | Bots pane, hide/unhide |
| Sections | `SidebarSections` ("Unassigned") | User-made folders |
| Standing instructions | Agent description / local `description` | `SOUL.md` |
| Model / provider pin | Per-bot `provider` + `modelId`, else inherit Router | Per-bot model pin, else launch profile |
| Groups | `GROUP_MAX_MEMBERS = 6` | 2–6 members, max 3 serial rounds |
| Routines | Host automations / cron | `[bot:]` cron jobs |
| Mentions | Composer `@` chips | `@slug` resolved against the live roster |

## What was missing here (and is now local)

Hermes Bot Mode is explicit about delivery, failure, and isolation. The
reconstructed router was a single global provider with weak failure handling.

This branch adds a local Bot Mode layer that does **not** invent a second
runtime:

- **Roster** in `settings.json` (`botRoster`), also edited from Settings → Bots
- **`message_agent`** on routed turns (Codex / OpenRouter tools and the Claude
  MCP bridge) with attributed, fire-and-forget delivery
- **Typed failure reasons** (`[reason:provider_rate_limit] …`) matching Hermes'
  delivery codes
- **Retry once**, and only for transient reasons (rate limit, 5xx, timeout,
  overflow, runtime offline). Auth, quota, and missing config never retry
- **Idempotent sends** via `clientNonce` / `idempotencyKey`
- **Group planner** with the same hard caps Hermes documents (3 rounds, 10
  messages per send). A teammate reply that addresses `@user` settles the
  round instead of continuing the loop
- **Intentional silence** (`[SILENT]`, `NO_REPLY`) so a teammate can pass
- **Box sync** so a roster edited on the Mac is written through
  `syncHostSettingsToBox` (the coordinator otherwise reads a different
  `settings.json` inside the remote / local-Docker box)

Cross-machine `hermes peer`, warm backend slots, and gateway-owned room drivers
are still Hermes-only. Grok Bot's remote box / local Docker sandbox is the
execution host; Hermes profiles stay on the machine that owns them.

## How to use it

1. Open **Settings → Bots** (reconstructed frontend or the patched shipped
   Settings registry).
2. Create a specialist: name, title, standing instructions, optional provider
   pin.
3. Talk to that agent. Routed providers receive the teammate roster and the
   `message_agent` tool.
4. `@mention` another bot or have the model call `message_agent`. Delivery is
   queued into the target's canonical transcript.

CLI-equivalent thinking, if you are used to Hermes:

| Hermes | Grok Bot reconstructed |
| --- | --- |
| `hermes -p chat` | Open that bot's conversation |
| `~/.hermes/profiles/<name>/` | `settings.json` → `botRoster` + per-agent transcript |
| `hermes peer dm` | Local `message_agent` (same machine) |
