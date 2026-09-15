import type { SidebarSection } from "./sidebar-sections.js";

/**
 * Host settings reach the store from the renderer over IPC and from the desktop over the
 * coordinator's RPC, so neither their shape nor their element types are guaranteed. The stores
 * themselves assume well-typed input: `setPinnedAgentIds` spreads its argument, and
 * `SidebarSections.normalize` calls `.trim()` on every id, so a malformed payload either throws
 * from deep inside normalization — abandoning the rest of a batched update half-applied — or
 * persists nonsense such as a bare string exploded into one agent id per character.
 *
 * These parsers reject a whole field rather than salvaging part of it. A caller that gets `null`
 * keeps whatever is already stored, which is the same shape `parseAgentModel` uses on the
 * Electron edge for models.
 */
export function parseAgentIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const id = entry.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function parseSidebarSectionList(value: unknown): SidebarSection[] | null {
  if (!Array.isArray(value)) return null;
  const sections: SidebarSection[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry == null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") return null;
    if (record.isCollapsed !== undefined && typeof record.isCollapsed !== "boolean") return null;
    const agentIds = parseAgentIdList(record.agentIds);
    if (agentIds == null) return null;
    sections.push({ id: record.id, name: record.name, agentIds, ...(record.isCollapsed === undefined ? {} : { isCollapsed: record.isCollapsed }) });
  }
  return sections;
}
