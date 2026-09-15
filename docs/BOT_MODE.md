# Bot-mode（无界面 headless）与 Desktop 模式对比

本项目原本只有 Desktop 模式：Electron 主进程 + coordinator + host/gateway +
已打包的 polished renderer。本次新增 `npm run bot-mode`（`scripts/bot-mode.mjs`
+ `source/node-agent-coordinator/bot-mode.ts`），用于与常见 hermes-agent
风格的 `bot-mode` 对齐：同一个推理路由，两种运行形态。

## 相同点

- 同一个 provider 路由：`cursor`（桌面专属）、`claude-code`、`codex`、`openrouter`，
  同一个 `GROK_ROUTER_SYSTEM_PROMPT`，同一个 8 步工具循环上限。
- 同一个转录持久化：`inference-router-transcript.json`，`schemaVersion: 2`，
  `t{turn}u / t{turn}s0` ID，单 agent 保留最近 200 条，`richText` 透传。
- 同一个设置与用量账本：`SandSettingsStore` 的 `inferenceProvider` 与
  `recordInferenceUsage`，bot-mode 只是换了一个 `dataDir`
 （默认 `~/.grok-bot-bot-mode`，可用 `SAND_BOT_DATA_DIR` 或 `--data-dir` 覆盖）。
- 同一个每 agent `sendPrompt` 串行队列，避免并发 turn 互相覆盖。

## 不同点

| 维度 | Desktop 模式 | Bot-mode（本次新增） |
| --- | --- | --- |
| 入口 | Electron + coordinator + host | `node scripts/bot-mode.mjs --prompt ...`，无 Electron |
| Roster/远端 | 真实 gateway `listAgents` / transcript tail | stub：单 agent roster，远端 tail 为空，本地即权威 |
| 工具 | 完整 Grok Bot MCP 插件（`listRoutedMcpTools` / `executeRoutedMcpTool`） | `listRoutedMcpTools` 为空，`executeRoutedMcpTool` 直接 fail-closed，提示无桌面插件 |
| 事件 | 推送给 renderer（transcript/agents SSE） | 收集为内存 `events[]`，CLI 以 JSONL 输出到 stdout |
| 交互 | 流式打字、reaction、activity pulse | 一次性返回 `assistantText`，reaction 仍可经 router API 切换 |
| Box | 远端 box / 本地 Docker 二选一 | 无 box：纯路由文本，不启动 gateway/host/docker |

## 本次顺带修复的鲁棒性问题（bot-mode 与桌面共用）

- `inference-router` 错误条目曾用 `t${Date.now()}s0`，会把墙钟时间误作 turn
  号导致后续 turn 序号爆炸；现改为 `t-error-{ts}-{rand}`，不再命中 turn 正则。
- transcript store 的 load→persist 曾无锁，并发 turn/reaction 会丢条目；
  现加进程内串行链，`persist` 失败会清理临时文件。
- transcript tail 的 `limit` 无上界；现钳制到最多 500 条。
- `routed-mcp-bridge` 的 body 拼接、notification（无 id 回 202）、未知 method
 （回 JSON-RPC `-32601`）、超时/keepAlive 均已补齐。
- Codex 凭证缺失/损坏曾抛裸 `ENOENT`/JSON 错误；现转义为“去 `codex login`”
  友好错误；`config.toml` 解析忽略 `#` 注释；401 刷新加 singleflight；
  路由文本加 120s 超时与空回复 fail-closed。
- `SandSettingsStore.persist` 改用 `pid.uuid.tmp` + `O_EXCL` + `fsync` +
  失败清理，避免多进程互相覆盖与残留临时文件。
- `acquireHostLock` 在 5 次尝试后曾无条件覆写存活锁；现直接抛错 fail-closed。
- `gateway-server` 的 bridge 非 JSON 回 400、超大 body 回 413（此前统一 500）。

## 运行

```sh
npm run bot-mode -- --prompt "hello" --agent bot --provider codex
npm run bot-mode -- --prompt "hello" --provider openrouter --json
```

`cursor` provider 需要桌面会话，bot-mode 会直接拒绝并提示切换到
`claude-code` / `codex` / `openrouter`。OpenRouter 需要 `OPENROUTER_API_KEY`
（环境变量或桌面 secrets 桥）。
