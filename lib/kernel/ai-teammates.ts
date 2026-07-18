// lib/kernel/ai-teammates.ts
// ─────────────────────────────────────────────────────────────────────────────
// TENANT AI TEAMMATES — pure validation + composition for tenant-chartered AI
// teammates (tenant_ai_teammates). A teammate is the tenant's OWN identity on
// top of a built-in manager from the canonical registry ("Maya — Luxury
// Listings Concierge" on the Marketing Manager): a name, a role title, a
// charter, and focus tags. This module is PURE (client/test-safe — only type
// and const imports from the read-only registry): the action layer owns auth,
// tier limits, and the earned-autonomy clamp; draft composers call
// composeTeammateContext to thread the charter into their prompts.
//
// AUTONOMY IS EARNED, NEVER DECLARED — the honest rule mirrored from the
// autonomy-ratchet system (lib/documents/autonomy-ratchet.ts):
//   · draft_only     — always allowed (the teammate only ever drafts).
//   · approved_send  — always allowed (every send still clears the human
//                      approval queue; this IS the OS's default rail).
//   · autonomous     — allowed ONLY where the tenancy has at least one
//                      earned-autonomy grant on the ledger that governs the
//                      teammate's base manager's domain (managed_agents.config
//                      doc_kernel_grants / marketing_grants). Naming a
//                      teammate never loosens a gate the tenant hasn't earned.

import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

// ─── VOCABULARY (matches the tenant_ai_teammates CHECK constraints) ──────────

export const TEAMMATE_AUTONOMY_LEVELS = ["draft_only", "approved_send", "autonomous"] as const
export type TeammateAutonomy = (typeof TEAMMATE_AUTONOMY_LEVELS)[number]

export const TEAMMATE_STATUSES = ["active", "paused", "retired"] as const
export type TeammateStatus = (typeof TEAMMATE_STATUSES)[number]

export const TEAMMATE_AUTONOMY_LABELS: Record<TeammateAutonomy, string> = {
  draft_only:    "Drafts only",
  approved_send: "Sends after your approval",
  autonomous:    "Acts on earned grants",
}

// ─── LIMITS ──────────────────────────────────────────────────────────────────

export const TEAMMATE_NAME_MIN = 2
export const TEAMMATE_NAME_MAX = 60
export const TEAMMATE_ROLE_TITLE_MIN = 2
export const TEAMMATE_ROLE_TITLE_MAX = 80
export const TEAMMATE_CHARTER_MIN = 12
export const TEAMMATE_CHARTER_MAX = 2000
export const TEAMMATE_MAX_FOCUS_TAGS = 8
export const TEAMMATE_FOCUS_TAG_MAX = 40

/**
 * Custom-teammate cap per subscription tier — same shape as the seat matrix
 * (lib/kernel/tier-role-matrix.ts): null = unlimited; unknown/legacy tiers
 * fail OPEN to the brokerage behavior so an unbackfilled tenant isn't bricked.
 */
export const TIER_TEAMMATE_LIMITS: Record<string, number | null> = {
  solo_agent:     1,
  team:           3,
  brokerage:      null,
  multi_location: null,
}

export function teammateLimitForTier(tier: string | null | undefined): number | null {
  if (tier && tier in TIER_TEAMMATE_LIMITS) return TIER_TEAMMATE_LIMITS[tier]
  return null // fail open (legacy tier) — mirrors seatLimitForTier
}

// ─── VALIDATION ──────────────────────────────────────────────────────────────

export interface TeammateInput {
  name: string
  roleTitle: string
  baseManagerKey: string
  charter: string
  focusTags?: string[] | null
  autonomy?: string | null
}

export interface NormalizedTeammate {
  name: string
  roleTitle: string
  baseManagerKey: ManagerKey
  charter: string
  focusTags: string[]
  autonomy: TeammateAutonomy
}

export type TeammateValidation =
  | { ok: true; value: NormalizedTeammate }
  | { ok: false; errors: string[] }

export function isManagerKey(key: string): key is ManagerKey {
  return key in MANAGERS
}

/** PURE: trim + validate a teammate charter form. Returns every problem at
 *  once (form UX), never a partial normalization. */
export function validateTeammateInput(input: TeammateInput): TeammateValidation {
  const errors: string[] = []

  const name = (input.name ?? "").trim().replace(/\s+/g, " ")
  if (name.length < TEAMMATE_NAME_MIN || name.length > TEAMMATE_NAME_MAX) {
    errors.push(`Name must be ${TEAMMATE_NAME_MIN}–${TEAMMATE_NAME_MAX} characters.`)
  }

  const roleTitle = (input.roleTitle ?? "").trim().replace(/\s+/g, " ")
  if (roleTitle.length < TEAMMATE_ROLE_TITLE_MIN || roleTitle.length > TEAMMATE_ROLE_TITLE_MAX) {
    errors.push(`Role title must be ${TEAMMATE_ROLE_TITLE_MIN}–${TEAMMATE_ROLE_TITLE_MAX} characters.`)
  }

  const baseManagerKey = (input.baseManagerKey ?? "").trim()
  if (!isManagerKey(baseManagerKey)) {
    errors.push("Base manager must be one of the built-in AI managers.")
  }

  const charter = (input.charter ?? "").trim()
  if (charter.length < TEAMMATE_CHARTER_MIN || charter.length > TEAMMATE_CHARTER_MAX) {
    errors.push(`Charter must be ${TEAMMATE_CHARTER_MIN}–${TEAMMATE_CHARTER_MAX} characters — say what this teammate owns and how it should sound.`)
  }

  const focusTags = (input.focusTags ?? [])
    .map((t) => (t ?? "").trim())
    .filter((t) => t.length > 0)
  if (focusTags.length > TEAMMATE_MAX_FOCUS_TAGS) {
    errors.push(`At most ${TEAMMATE_MAX_FOCUS_TAGS} focus tags.`)
  }
  if (focusTags.some((t) => t.length > TEAMMATE_FOCUS_TAG_MAX)) {
    errors.push(`Each focus tag must be ≤ ${TEAMMATE_FOCUS_TAG_MAX} characters.`)
  }

  const autonomyRaw = (input.autonomy ?? "draft_only").trim()
  if (!(TEAMMATE_AUTONOMY_LEVELS as readonly string[]).includes(autonomyRaw)) {
    errors.push(`Autonomy must be one of: ${TEAMMATE_AUTONOMY_LEVELS.join(", ")}.`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      name,
      roleTitle,
      baseManagerKey: baseManagerKey as ManagerKey,
      charter,
      focusTags: Array.from(new Set(focusTags)),
      autonomy: autonomyRaw as TeammateAutonomy,
    },
  }
}

// ─── THE EARNED-AUTONOMY CLAMP ───────────────────────────────────────────────

/**
 * WHERE a base manager's earned-autonomy evidence lives — the SAME grant
 * ledgers the autonomy ratchet writes (lib/documents/autonomy-ratchet.ts
 * grantTargetForShape routes deadline shapes to deal_coordinator.
 * doc_kernel_grants and marketing shapes to campaign_orchestrator.
 * marketing_grants). Managers with no ratchetable domain return null — for
 * them 'autonomous' is never grantable by construction. PURE.
 */
export function grantLedgerForManager(
  baseManagerKey: ManagerKey,
): { agentKind: string; configKey: string } | null {
  if (baseManagerKey === "deal_coordinator") {
    return { agentKind: "deal_coordinator", configKey: "doc_kernel_grants" }
  }
  if (baseManagerKey === "campaign_orchestrator" || baseManagerKey === "marketing_agent") {
    return { agentKind: "campaign_orchestrator", configKey: "marketing_grants" }
  }
  return null
}

export interface AutonomyClamp {
  autonomy: TeammateAutonomy
  clamped: boolean
  reason: string | null
}

/**
 * PURE: clamp a requested autonomy to what the tenancy has EARNED.
 * `earnedShapes` is the number of granted shapes on the base manager's grant
 * ledger (0 when the manager has no ledger). 'autonomous' requires ≥ 1 earned
 * grant; draft_only / approved_send always stand (approved_send is the
 * human-approval rail itself — nothing sends without the queue).
 */
export function clampTeammateAutonomy(
  requested: TeammateAutonomy,
  baseManagerKey: ManagerKey,
  earnedShapes: number,
): AutonomyClamp {
  if (requested !== "autonomous" || earnedShapes > 0) {
    return { autonomy: requested, clamped: false, reason: null }
  }
  const label = MANAGERS[baseManagerKey].label
  const ledger = grantLedgerForManager(baseManagerKey)
  return {
    autonomy: "approved_send",
    clamped: true,
    reason: ledger
      ? `Autonomy is earned, not declared — your team has no earned-autonomy grants in the ${label}'s domain yet, so this teammate starts at "sends after your approval". Grants earned on the feed unlock it.`
      : `The ${label}'s domain has no earned-autonomy ladder — this teammate runs at "sends after your approval" (every send clears your approval queue).`,
  }
}

// ─── CHARTER → PROMPT CONTEXT ────────────────────────────────────────────────

export interface TeammateForContext {
  name: string
  roleTitle: string
  charter: string
  focusTags: string[] | null
  baseManagerKey: string
}

/**
 * PURE: render one teammate's charter as a prompt block for draft composition.
 * Injected by the central brand-voice prompt builder (lib/ai-isa/
 * brand-voice-prompt.ts) so drafts in the teammate's domain genuinely carry
 * the tenant's charter — identity, mandate, and focus.
 */
export function composeTeammateContext(t: TeammateForContext): string {
  const base = isManagerKey(t.baseManagerKey) ? MANAGERS[t.baseManagerKey] : null
  const lines: string[] = [
    `You are working as "${t.name}", this brokerage's ${t.roleTitle}${base ? ` (their custom AI teammate built on the ${base.label} — ${base.domain})` : ""}.`,
    `Your charter from the brokerage: ${t.charter}`,
  ]
  const tags = (t.focusTags ?? []).filter(Boolean)
  if (tags.length > 0) lines.push(`Priority focus areas: ${tags.join(", ")}.`)
  lines.push(`Stay inside this charter — it narrows your mandate, it never overrides compliance, consent, or Fair Housing rules.`)
  return lines.join("\n")
}

// ─── COMMAND → DOMAIN ATTRIBUTION ────────────────────────────────────────────

/**
 * Which team commands land squarely in ONE manager's domain — used by the
 * dispatcher (lib/voice/team-commands.ts) to attribute the response to the
 * tenant's custom teammate for that domain. Commands that fan across the
 * whole bench (team_query, area_query, morning_standup, ask_guidance,
 * quarterly_review, standup_action) are deliberately absent: attributing a
 * bench-wide answer to one persona would be dishonest.
 */
export const TEAM_COMMAND_MANAGER: Record<string, ManagerKey> = {
  voice_followup:   "sphere_of_influence",
  start_marketing:  "campaign_orchestrator",
  cut_promo:        "marketing_agent",
  find_properties:  "shopping_agent",
  kernel_proposals: "deal_coordinator",
  kernel_resolve:   "deal_coordinator",
}

/** PURE: the spoken/typed attribution line — the teammate answers by name. */
export function formatTeammateAttribution(
  teammate: { name: string; roleTitle: string },
  spoken: string,
): string {
  return `${teammate.name}, your ${teammate.roleTitle}, on it: ${spoken}`
}
