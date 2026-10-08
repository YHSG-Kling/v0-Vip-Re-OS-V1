// lib/voice-admin/assistant-reach.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE WHOLE TEAM AT THEIR FINGERTIPS, 24/7 — the built-in assistant's REACH MATRIX (wave 138E).
//
// There is ONE assistant. It has two front-ends that already share one dispatcher
// (lib/voice/team-commands.ts — the ElevenLabs spoken admin at
// app/api/agent-assistant/tool-call/route.ts and the internal voice/text command route)
// plus the kernel voice lane (lib/voice-admin/plan-voice-command.ts). Nothing here is a
// second assistant. This module DERIVES, from registries that already exist, which
// governed door reaches each of the 13 tenant managers:
//
//   speak    the kernel voice lane — a catalogue capability the manager owns with spoken
//            phrases (VOICE_PHRASES → buildVoicePlan: authorization → operability →
//            confirmation, dispatched as a manager signal on the egress).
//   tool     an assistant tool attributed to the manager (VOICE_TOOL_MANAGER, or the
//            custom-teammate attribution TEAM_COMMAND_MANAGER) — the tool-call route's
//            authority check + declared gates run first.
//   skill    a built-in manager skill (MANAGER_SKILLS, one per catalogue capability) the
//            assistant may REQUEST through run_skill → runSkill: entitlement + metering +
//            the owner's authority rung + withActionLedger + one bounded delegation per
//            capability that a human accepts. Never a direct execution.
//   explain  manager_status — "what are you working on, and why": the manager's open
//            delegations (pendingDelegationsFor) and its completed work with rationale
//            (loadManagerActivity). Every seat has it; it reads, it never acts.
//
// A manager with no COMMAND door (speak / tool / skill) must carry a NAMED reason in
// ASSISTANT_COMMAND_EXEMPT; a reason on a manager that now HAS a door is stale and the
// proof fails on it (the rule, not a waypoint — a capability another lane adds lands in
// the matrix by derivation, and the exemption must then go).
//
// PURE — no I/O. The proof (scripts/voice-kernel-surface-simulator.ts) census-checks it.
// ─────────────────────────────────────────────────────────────────────────────

import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import type { AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { voiceCapabilities, humanManager, VOICE_NEVER_SPOKEN } from "./kernel-command-surface"
import { voiceTools, VOICE_TOOL_MANAGER } from "@/lib/voice/tool-registry"
import { TEAM_COMMAND_MANAGER } from "@/lib/kernel/ai-teammates"
import { MANAGER_SKILLS, SKILL_RISK_ORDER, type SkillDeclaration } from "@/lib/kernel/skill-registry"
import type { ToolRiskClass } from "@/lib/ai-isa/persona-tool-policy"

/**
 * The highest risk class the assistant may REQUEST by voice/chat. READ, LOW_RISK_WRITE and
 * COMMUNICATION ride runSkill's own gates (and a communication still meets the send gate);
 * FINANCIAL, LEGAL and IRREVERSIBLE never start from a spoken sentence — the same restraint
 * as VOICE_NEVER_SPOKEN, applied by RISK so a marketplace skill cannot route around it.
 */
const ASSISTANT_SKILL_RISK_CEILING: ToolRiskClass = "COMMUNICATION"

/** PURE: may the assistant request this skill? null = yes; otherwise the spoken reason. */
export function assistantSkillRefusal(d: Pick<SkillDeclaration, "risk_class" | "required_capabilities">): string | null {
  const rank = SKILL_RISK_ORDER.indexOf(d.risk_class)
  if (rank < 0 || rank > SKILL_RISK_ORDER.indexOf(ASSISTANT_SKILL_RISK_CEILING)) {
    return `it is a ${String(d.risk_class).toLowerCase().replace(/_/g, " ")} skill — that starts from the Missions card, never a spoken request`
  }
  const never = d.required_capabilities.filter((c) => (VOICE_NEVER_SPOKEN as readonly string[]).includes(c))
  if (never.length) return `it needs ${never.join(", ").replace(/_/g, " ")}, which moves money, writes the books or changes a deal's legal stage — never by voice`
  return null
}

/** The manager the assistant files a run_skill request AS. The voice surface's accountable manager is
 *  operations (MAINTENANCE_DOMAINS.voice_kernel_command_surface → cron_manager); runSkill refuses a manager
 *  running its own skill, so when operations owns the skill the Data Steward (the on-the-record keeper,
 *  lib/voice/voice-bus.ts voiceBusRoute) files it instead. */
export function assistantRequestingManager(owner: ManagerKey): ManagerKey {
  return owner === "cron_manager" ? "data_steward" : "cron_manager"
}

/** Managers with no command door, and WHY. Explain is still open to them. */
const ASSISTANT_COMMAND_EXEMPT: Readonly<Partial<Record<ManagerKey, string>>> = Object.freeze({
  cron_manager: "operations — the heartbeat, loop health and recovery are the system's own (os-health decideRecovery); a tenant user asks what it is doing, never commands it",
})

interface AssistantReachRow {
  manager: ManagerKey
  label: string
  speak: AppCapability[]
  tools: string[]
  skills: string[]
  explain: true
  commandable: boolean
  exempt: string | null
}

/** PURE: the reach matrix — manager × assistant door, derived from the registries (no hand-kept list). */
export function assistantReachMatrix(): AssistantReachRow[] {
  const spoken = voiceCapabilities()
  const toolOwner = (name: string): ManagerKey | null =>
    (VOICE_TOOL_MANAGER as Readonly<Record<string, ManagerKey>>)[name] ?? TEAM_COMMAND_MANAGER[name] ?? null
  return (Object.keys(MANAGERS) as ManagerKey[]).map((m) => {
    const speak = spoken.filter((v) => v.manager === m).map((v) => v.capability)
    const tools = Object.keys(voiceTools).filter((t) => toolOwner(t) === m)
    const skills = MANAGER_SKILLS.filter((s) => s.manager_owner === m && assistantSkillRefusal(s) === null).map((s) => s.name)
    const commandable = speak.length + tools.length + skills.length > 0
    return { manager: m, label: MANAGERS[m].label, speak, tools, skills, explain: true as const, commandable, exempt: ASSISTANT_COMMAND_EXEMPT[m] ?? null }
  })
}

/** PURE: the matrix's two defects — a manager with no command door and no named reason, and a reason on a
 *  manager that now HAS a door (stale). Read by manager_status's team answer (lib/voice/team-commands.ts). */
export function reachGaps(rows: readonly AssistantReachRow[]): { unreachable: ManagerKey[]; staleExempt: ManagerKey[] } {
  return {
    unreachable: rows.filter((r) => !r.commandable && !r.exempt).map((r) => r.manager),
    staleExempt: rows.filter((r) => r.commandable && !!r.exempt).map((r) => r.manager),
  }
}

// ─── naming a manager in free speech ─────────────────────────────────────────
/** Extra spoken names beyond the registry label / key / humanManager title. Conservative, multi-word where a
 *  single word would collide with ordinary speech ("finance" is fine; "data" alone is not). */
const MANAGER_ALIASES: Readonly<Partial<Record<ManagerKey, readonly string[]>>> = Object.freeze({
  ai_isa: ["isa", "inside sales"],
  deal_coordinator: ["transaction coordinator", "deal desk", "closing coordinator"],
  shopping_agent: ["buyer agent", "buyer manager"],
  listing_concierge: ["listing manager", "listings manager"],
  sphere_of_influence: ["sphere", "past client manager"],
  campaign_orchestrator: ["campaign manager", "marketing manager", "marketing"],
  asset_manager: ["media manager", "video manager"],
  ads_manager: ["ads", "ad manager", "paid ads"],
  data_steward: ["data steward"],
  recruiting_manager: ["recruiting", "recruiter"],
  compliance_officer: ["compliance"],
  finance_manager: ["finance", "finance desk"],
  cron_manager: ["operations", "ops"],
})

function managerNames(m: ManagerKey): string[] {
  return [MANAGERS[m].label, m.replace(/_/g, " "), humanManager(m).replace(/^your\s+/, ""), ...(MANAGER_ALIASES[m] ?? [])]
    .map((s) => s.toLowerCase().trim()).filter(Boolean)
}

/** PURE: which manager does this text name? Longest name wins (so "campaign manager" beats "manager");
 *  null when none — the caller asks rather than guessing. */
export function matchManagerInText(text: string): ManagerKey | null {
  const t = ` ${(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `
  let best: { m: ManagerKey; len: number } | null = null
  for (const m of Object.keys(MANAGERS) as ManagerKey[]) {
    for (const n of managerNames(m)) {
      if (t.includes(` ${n} `) && (!best || n.length > best.len)) best = { m, len: n.length }
    }
  }
  return best?.m ?? null
}

// ─── the spoken answer ───────────────────────────────────────────────────────
interface PendingWork { status: string; requested_capability: string; objective: string; requesting_manager: string; deadline: string | null }
interface DoneWork { action: string; detail: string | null; status: string; whenISO: string }

/** PURE: "what is <manager> working on, and why" — open work first, then the latest completed work WITH its
 *  rationale, then what the asker may command. Unreadable sources are SAID, never rendered as "nothing". */
export function composeManagerStatus(m: ManagerKey, pending: readonly PendingWork[], done: readonly DoneWork[], refused: readonly string[]): string {
  const who = humanManager(m).replace(/^your\s+/, "Your ")
  const parts: string[] = []
  if (pending.length === 0) parts.push(`${who} has no open delegations.`)
  else {
    const top = pending[0]
    parts.push(`${who} has ${pending.length} open ${pending.length === 1 ? "item" : "items"}. First: ${top.requested_capability.replace(/_/g, " ")} for ${humanManager(top.requesting_manager as ManagerKey)} — ${top.objective.slice(0, 140)} (${top.status.toLowerCase()}${top.deadline ? `, due ${top.deadline.slice(0, 10)}` : ""}).`)
  }
  if (done.length > 0) {
    const last = done[0]
    parts.push(`Most recently it ${last.action}${last.detail ? ` — because ${last.detail.slice(0, 160)}` : ""}.`)
  }
  const row = assistantReachMatrix().find((r) => r.manager === m)
  if (row) {
    const can = [...row.speak.map((c) => c.replace(/_/g, " ")), ...row.tools.map((t) => t.replace(/_/g, " "))].slice(0, 3)
    if (can.length) parts.push(`You can ask me to ${can.join(", ")}${row.skills.length ? `, or request one of its ${row.skills.length} skills` : ""}.`)
    else if (row.skills.length) parts.push(`You can request one of its ${row.skills.length} skills — say "run skill" and the name.`)
    else if (row.exempt) parts.push(`It takes no commands from here: ${row.exempt.split(" — ")[0]}.`)
  }
  if (refused.length) parts.push(`I could not read part of its record (${refused.join("; ").slice(0, 160)}), so this may be incomplete.`)
  return parts.join(" ")
}

/** PURE: the whole bench at once — open items per manager, busiest first. */
export function composeTeamStatus(pending: readonly { assigned_manager: string }[], refused: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const p of pending) counts.set(p.assigned_manager, (counts.get(p.assigned_manager) ?? 0) + 1)
  const busy = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const head = busy.length === 0
    ? "No manager has an open delegation right now."
    : `Open work: ${busy.map(([k, n]) => `${humanManager(k as ManagerKey).replace(/^your\s+/, "")} ${n}`).join(", ")}.`
  const tail = refused.length ? ` I could not read part of the board (${refused.join("; ").slice(0, 160)}).` : ""
  return `${head} Ask about one by name — "what is the ads manager working on?"${tail}`
}

/** Spoken skill name → registry name ("anniversary note and gift" → "anniversary_note_and_gift"). */
export function skillNameFromSpeech(s: string): string {
  return (s ?? "").toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/\s+skill$/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}
