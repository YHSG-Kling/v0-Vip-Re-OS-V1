// lib/compliance/team-checklist-carry.ts
//
// A TEAM'S REQUIRED-DOCUMENT CHECKLIST FOLLOWS THE TEAM (wave 145, lane 145H — owner ruling 21, 2026-10-27:
// "Teams required document checklist should follow the team.").
//
// THE GAP (lane 144I Still open 4). The adoption rail (lib/kernel/brokerage-transfer.ts) moves a TEAM into an adopting
// brokerage with the same id, and since wave 144 its form PACKETS follow it (brokerage_form_library.team_id). Its
// CHECKLIST did not: `brokerage_required_documents` is policy, and the rail's header keeps policy with the archived
// source — so a team that joined lost every requirement it had, and its rules sat in a tenant its members can no
// longer read.
//
// THE RULE THIS FILE APPLIES (no new subsystem — it writes the ONE checklist table, through the same versioned history
// every rule edit uses):
//   · WHAT FOLLOWS: the source tenant's rules SCOPED TO THE MOVED TEAM (scope_type 'team', scope_id = the team id), and
//     — when the source was the team's OWN workspace (an independent team adopted as a team: target_role team_lead) —
//     that workspace's brokerage-level rules, which were the team's checklist. Each lands in the TARGET as a TEAM rule
//     (scope_type 'team', scope_id = the same team id), so in the adopting brokerage it is the team's requirement.
//   · HISTORY IS KEPT: the source rows are never updated or deleted (historical policy evidence — a closed deal's
//     checklist fingerprint still names them). The copy records its origin in `carried_from_rule_id` (m869) and its
//     own first version in tenant_policy_versions (`required_document:<id>`), with the reason.
//   · CONFLICTS RESOLVE TOWARD THE MANDATORY RULE: a carried team rule can add or tighten, never loosen, the adopting
//     brokerage's own rules or a cited state requirement — enforced where every checklist is decided
//     (lib/compliance/required-documents.ts resolveRequiredDocuments, the wave-145 floor).
//   · NEVER ACROSS TENANTS BY ACCIDENT: rows are READ only from the named source, for the named team(s), and WRITTEN
//     only into the named target. A template form that did not move with the team (a brokerage-level packet of the
//     source — its licence stays there, wave 144I) is NOT pointed at across tenants: the copy carries no template and
//     the result names it. A cited STATE requirement is carried as the team's policy with its source kept for
//     reference, NOT as an attested state requirement — the attestation was another tenant's compliance approver's,
//     so the adopting brokerage's compliance approver re-attests it (the result lists them).
//   · VOCABULARY: a rule naming a contract type / representation the adopting brokerage's vocabulary does not hold is
//     refused by the m847 admission trigger (23514). It is HELD — not copied, not rewritten — and named for a human.
//   · IDEMPOTENT: one copy per (target, team, origin rule) — the m869 partial unique index; a re-run counts them as
//     already carried. Before m869 is applied the carry REFUSES (the copy could not be made idempotent).
//
// CALLERS: the adoption rail's membership step (lane 145A — named in lane 145H's Outside-lane, right after the team's
// packets follow it) and the "carry this team's checklist" door for a team that already joined
// (app/actions/compliance/manage-required-docs.ts carryJoinedTeamChecklist). Both pass the tenant they resolved
// themselves; nothing here comes from a body.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** The columns a carried rule copies verbatim (everything that defines WHAT is required; never ids / audit columns). */
const CARRIED_RULE_COLUMNS = [
  "classification", "deal_type", "state_code", "is_required", "block_on_missing", "description",
  "required_stage", "financing_kind", "contract_subtype", "representation",
] as const

export interface CarryTeamChecklistInput {
  sourceBrokerageId: string
  targetBrokerageId: string
  /** The team(s) that moved — same ids in the target. */
  teamIds: readonly string[]
  /** true when the source was the team's own workspace: its brokerage-level rules are the team's checklist. */
  includeWorkspaceRules: boolean
  /** users.id recorded on created_by and on the policy version. */
  actorUserId: string
  /** Why (the transfer request id, or the door) — written into each rule's first policy version. */
  reason: string
}

export interface CarryTeamChecklistResult {
  ok: true
  carried: number
  alreadyCarried: number
  /** An equivalent team rule already exists in the target (same document, side, state and dimensions). */
  equivalentExists: number
  /** Not copied — a human decides (the adopting vocabulary lacks a term the rule names, or the insert was refused). */
  held: Array<{ ruleId: string; classification: string; reason: string }>
  /** Copied without its template: the template stayed with the source (a brokerage-level packet). */
  templatesDropped: Array<{ ruleId: string; classification: string }>
  /** Copied as team policy; a compliance approver in the target re-attests the state requirement it cited. */
  reattestation: Array<{ ruleId: string; classification: string; stateCode: string | null; sourceUrl: string | null }>
}

const isMissingColumn = (e: { code?: string } | null | undefined) => !!e && (e.code === "42703" || e.code === "PGRST204")

/** A team in this brokerage that JOINED through a completed adoption — the authority for carrying its checklist. */
export interface JoinedTeam {
  teamId: string
  teamName: string | null
  transferRequestId: string
  sourceBrokerageId: string
  /** The team lead was adopted AS a team lead — the source workspace was the team's own (its rules were the team's). */
  workspaceWasTheTeams: boolean
  completedAt: string | null
}

/**
 * The teams of `brokerageId` (resolved by the CALLER from its session) that joined through a COMPLETED adoption: the
 * transfer's target is this brokerage and its subject is the team's lead (teams.team_lead_id). That consented,
 * completed transfer is what authorizes reading the source tenant's rules for the team — nothing else does.
 */
export async function listJoinedTeams(svc: Svc, brokerageId: string, onlyTeamId?: string): Promise<{ ok: true; teams: JoinedTeam[] } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no brokerage" }
  let tq = svc.from("teams").select("id, name, team_lead_id, brokerage_id").eq("brokerage_id", brokerageId).is("deleted_at", null)
  if (onlyTeamId) tq = tq.eq("id", onlyTeamId)
  const { data: teams, error: tErr } = await tq
  if (tErr) return { ok: false, error: `teams could not be read: ${tErr.message}` }
  const leads = ((teams ?? []) as Array<{ id: string; name: string | null; team_lead_id: string | null }>).filter((t) => !!t.team_lead_id)
  if (leads.length === 0) return { ok: true, teams: [] }
  const { data: reqs, error: rErr } = await svc
    .from("brokerage_transfer_requests")
    .select("id, source_brokerage_id, target_brokerage_id, subject_user_id, target_role, status, completed_at")
    .eq("target_brokerage_id", brokerageId)
    .eq("status", "completed")
    .in("subject_user_id", leads.map((t) => t.team_lead_id as string))
  if (rErr) return { ok: false, error: `adoptions could not be read: ${rErr.message}` }
  const out: JoinedTeam[] = []
  for (const t of leads) {
    const mine = ((reqs ?? []) as Array<{ id: string; source_brokerage_id: string; subject_user_id: string; target_role: string | null; completed_at: string | null }>)
      .filter((r) => r.subject_user_id === t.team_lead_id && r.source_brokerage_id && r.source_brokerage_id !== brokerageId)
      .sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))[0]
    if (!mine) continue
    out.push({
      teamId: t.id, teamName: t.name ?? null, transferRequestId: mine.id, sourceBrokerageId: mine.source_brokerage_id,
      workspaceWasTheTeams: mine.target_role === "team_lead", completedAt: mine.completed_at ?? null,
    })
  }
  return { ok: true, teams: out }
}

/** The dimension signature two rules must share to be "the same requirement" (null = any). */
function signature(r: Record<string, unknown>): string {
  return ["classification", "deal_type", "state_code", "required_stage", "financing_kind", "contract_subtype", "representation"]
    .map((c) => String(r[c] ?? "")).join("|")
}

/**
 * Carry the moved team(s)' required-document rules from the source tenant into the target (see the header). Reads the
 * error of every query; a refused read refuses the carry (nothing half-done is reported as done).
 */
export async function carryTeamChecklistRules(
  svc: Svc,
  input: CarryTeamChecklistInput,
): Promise<CarryTeamChecklistResult | { ok: false; error: string }> {
  const { sourceBrokerageId: source, targetBrokerageId: target, actorUserId } = input
  const teamIds = [...new Set((input.teamIds ?? []).filter(Boolean))]
  if (!source || !target || source === target) return { ok: false, error: "a carry needs two different brokerages" }
  if (teamIds.length === 0) return { ok: false, error: "no team to carry a checklist for" }
  if (!actorUserId) return { ok: false, error: "no actor recorded for the carry" }

  // Every moved team must now belong to the TARGET — the carry never writes a team rule for a team in another tenant.
  const { data: teams, error: teamErr } = await svc.from("teams").select("id, brokerage_id").in("id", teamIds)
  if (teamErr) return { ok: false, error: `the team(s) could not be read: ${teamErr.message}` }
  const inTarget = new Set(((teams ?? []) as Array<{ id: string; brokerage_id: string | null }>).filter((t) => t.brokerage_id === target).map((t) => t.id))
  const strays = teamIds.filter((id) => !inTarget.has(id))
  if (strays.length) return { ok: false, error: `team(s) ${strays.join(", ")} are not in the adopting brokerage — nothing was carried` }

  // THE SOURCE RULES — the team's own, and (for the team's own workspace) the workspace-level ones. star select: the
  // m806 / m847 columns may be absent on an older database, and a select naming one is refused whole.
  const { data: teamRules, error: trErr } = await svc
    .from("brokerage_required_documents").select("*")
    .eq("brokerage_id", source).eq("scope_type", "team").in("scope_id", teamIds)
  if (trErr) return { ok: false, error: `the team's rules could not be read: ${trErr.message}` }
  let workspaceRules: Array<Record<string, unknown>> = []
  if (input.includeWorkspaceRules) {
    const { data, error } = await svc
      .from("brokerage_required_documents").select("*")
      .eq("brokerage_id", source).eq("scope_type", "brokerage").eq("scope_id", source)
    if (error) return { ok: false, error: `the team workspace's rules could not be read: ${error.message}` }
    workspaceRules = (data ?? []) as Array<Record<string, unknown>>
  }
  // (origin rule, the team it lands on)
  const plan: Array<{ origin: Record<string, unknown>; teamId: string }> = [
    ...((teamRules ?? []) as Array<Record<string, unknown>>).map((origin) => ({ origin, teamId: String(origin.scope_id) })),
    ...workspaceRules.flatMap((origin) => teamIds.map((teamId) => ({ origin, teamId }))),
  ]
  const result: CarryTeamChecklistResult = { ok: true, carried: 0, alreadyCarried: 0, equivalentExists: 0, held: [], templatesDropped: [], reattestation: [] }
  if (plan.length === 0) return result

  // What the target already holds for these teams: carried copies (idempotency) and equivalent rules (no duplicate).
  const { data: existing, error: exErr } = await svc
    .from("brokerage_required_documents").select("*")
    .eq("brokerage_id", target).eq("scope_type", "team").in("scope_id", teamIds)
  if (exErr) return { ok: false, error: `the adopting brokerage's team rules could not be read: ${exErr.message}` }
  const existingRows = (existing ?? []) as Array<Record<string, unknown>>
  if (existingRows.length > 0 && !("carried_from_rule_id" in existingRows[0])) {
    return { ok: false, error: "the checklist carry needs migration m869 (carried_from_rule_id) — nothing was carried" }
  }
  const carriedKey = new Set(existingRows.filter((r) => r.carried_from_rule_id).map((r) => `${r.scope_id}|${r.carried_from_rule_id}`))
  const equivalentKey = new Set(existingRows.map((r) => `${r.scope_id}|${signature(r)}`))

  // Template forms the origin rules name: kept only when the form now lives in the TARGET (a team packet that moved).
  const formIds = [...new Set(plan.map((p) => p.origin.template_form_id).filter((v): v is string => typeof v === "string" && !!v))]
  const formInTarget = new Set<string>()
  if (formIds.length) {
    const { data: forms, error: fErr } = await svc.from("brokerage_form_library").select("id, brokerage_id").in("id", formIds)
    if (fErr) return { ok: false, error: `the rules' template forms could not be read: ${fErr.message}` }
    for (const f of (forms ?? []) as Array<{ id: string; brokerage_id: string | null }>) if (f.brokerage_id === target) formInTarget.add(f.id)
  }

  const { appendTenantPolicyVersion, requiredDocumentPolicyKey, requiredDocumentPolicyValue } = await import("@/lib/kernel/tenant-policy")
  for (const { origin, teamId } of plan) {
    const ruleId = String(origin.id)
    const classification = String(origin.classification ?? "")
    if (carriedKey.has(`${teamId}|${ruleId}`)) { result.alreadyCarried++; continue }
    if (equivalentKey.has(`${teamId}|${signature(origin)}`)) { result.equivalentExists++; continue }

    const row: Record<string, unknown> = {
      brokerage_id: target, scope_type: "team", scope_id: teamId,
      created_by: actorUserId, carried_from_rule_id: ruleId, carried_at: new Date().toISOString(),
    }
    for (const c of CARRIED_RULE_COLUMNS) if (origin[c] !== undefined && origin[c] !== null) row[c] = origin[c]
    if (row.is_required === undefined) row.is_required = true
    const template = typeof origin.template_form_id === "string" ? origin.template_form_id : null
    if (template && formInTarget.has(template)) row.template_form_id = template
    else if (template) result.templatesDropped.push({ ruleId, classification })
    if (origin.legal_basis === "state_requirement") {
      // Carried as the TEAM's policy; the citation is kept for reference, the attestation is the target's to give.
      if (typeof origin.source_url === "string") row.source_url = origin.source_url
      if (typeof origin.source_title === "string") row.source_title = origin.source_title
      result.reattestation.push({ ruleId, classification, stateCode: (origin.state_code as string | null) ?? null, sourceUrl: (origin.source_url as string | null) ?? null })
    }

    const { data: inserted, error: insErr } = await svc.from("brokerage_required_documents").insert(row).select("*")
    if (insErr) {
      if (isMissingColumn(insErr)) return { ok: false, error: "the checklist carry needs migration m869 (carried_from_rule_id) — nothing further was carried" }
      if (insErr.code === "23505") { result.alreadyCarried++; continue }
      const why = insErr.code === "23514"
        ? `the adopting brokerage's vocabulary does not hold a term this rule names (${insErr.message}) — add the term under Required documents → Vocabulary, or re-create the rule`
        : `the copy was refused: ${insErr.message}`
      result.held.push({ ruleId, classification, reason: why })
      // A held state requirement is not "to re-attest" — it was not copied.
      result.reattestation = result.reattestation.filter((r) => !(r.ruleId === ruleId))
      continue
    }
    const made = ((inserted ?? []) as Array<Record<string, unknown>>)[0]
    if (!made?.id) { result.held.push({ ruleId, classification, reason: "the copy was not confirmed (no row came back)" }); continue }
    result.carried++
    equivalentKey.add(`${teamId}|${signature(made)}`)
    carriedKey.add(`${teamId}|${ruleId}`)
    // THE RULE'S HISTORY starts in the target with its origin named. The rule has landed: a version that cannot be
    // recorded is logged, never reported as a failed carry.
    const v = await appendTenantPolicyVersion(svc, {
      brokerageId: target, policyKey: requiredDocumentPolicyKey(String(made.id)),
      value: requiredDocumentPolicyValue(made), previous: null,
      actor: { type: "user", userId: actorUserId, reason: `carried with team ${teamId} from workspace ${source} (origin rule ${ruleId}) — ${input.reason}`.slice(0, 500) },
    })
    if (!v.ok) console.error(`[team-checklist-carry] policy version not recorded for carried rule ${String(made.id)}: ${v.error}`)
  }
  return result
}
