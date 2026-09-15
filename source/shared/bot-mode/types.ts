import { MAX_AGENTS_PER_USER } from "../agents/agents.js";
import { isSandInferenceProvider, type SandInferenceProvider } from "../inference-router.js";

export const BOT_MODE_SCHEMA_VERSION = 1 as const;
export const BOT_GROUP_MAX_MEMBERS = 6;
export const BOT_GROUP_MIN_MEMBERS = 2;
export const BOT_GROUP_MAX_ROUNDS = 3;
export const BOT_GROUP_MAX_MESSAGES_PER_SEND = 10;
export const BOT_ROSTER_MAX = MAX_AGENTS_PER_USER;
export const BOT_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/;
export const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const BOT_FAILURE_REASONS = [
  "provider_auth_or_access",
  "provider_quota_limit",
  "provider_rate_limit",
  "provider_server_error",
  "context_overflow",
  "missing_config",
  "model_unavailable",
  "runtime_offline",
  "queued_expired",
  "delivery_timeout",
  "target_busy",
  "unknown",
] as const;

export type BotFailureReason = (typeof BOT_FAILURE_REASONS)[number];

export const TRANSIENT_BOT_FAILURES = new Set<BotFailureReason>([
  "provider_rate_limit",
  "provider_server_error",
  "context_overflow",
  "runtime_offline",
  "delivery_timeout",
]);

export const INTENTIONAL_SILENCE_TOKENS = ["[SILENT]", "NO_REPLY", "[NO_REPLY]", "SILENT"] as const;

export interface BotProfile {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provider?: SandInferenceProvider;
  readonly modelId?: string;
  readonly sectionId?: string;
}

export interface BotGroup {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BotRoster {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly bots: readonly BotProfile[];
  readonly groups: readonly BotGroup[];
}

export interface BotDelivery {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly fromBotId: string;
  readonly toBotId: string;
  readonly message: string;
  readonly status: "queued" | "settled" | "failed";
  readonly createdAt: string;
  readonly reason?: BotFailureReason;
  readonly error?: string;
}

export function emptyBotRoster(): BotRoster {
  return { schemaVersion: BOT_MODE_SCHEMA_VERSION, enabled: true, bots: [], groups: [] };
}

export function isBotFailureReason(value: unknown): value is BotFailureReason {
  return typeof value === "string" && (BOT_FAILURE_REASONS as readonly string[]).includes(value);
}

export function isBotProfileRecord(value: unknown): value is BotProfile {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !BOT_ID_PATTERN.test(record.id)) return false;
  if (typeof record.slug !== "string" || !BOT_SLUG_PATTERN.test(record.slug)) return false;
  if (typeof record.name !== "string" || record.name.trim().length === 0) return false;
  if (typeof record.title !== "string") return false;
  if (typeof record.description !== "string") return false;
  if (typeof record.hidden !== "boolean") return false;
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return false;
  if (record.provider !== undefined && !isSandInferenceProvider(record.provider)) return false;
  if (record.modelId !== undefined && (typeof record.modelId !== "string" || record.modelId.trim().length === 0)) return false;
  if (record.sectionId !== undefined && (typeof record.sectionId !== "string" || record.sectionId.trim().length === 0)) return false;
  return true;
}
