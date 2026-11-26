/**
 * Pure metrics helper for the agent_assistant_tool_calls reader
 * (app/actions/admin/agent-assistant-tool-calls.ts). Kept out of that
 * "use server" file because every export there is a public HTTP endpoint and
 * must be async (CLAUDE.md §4) — a plain sync helper does not belong in one.
 */
export function percentile95(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(sortedAsc.length * 0.95) - 1)
  return sortedAsc[Math.max(0, idx)]
}
