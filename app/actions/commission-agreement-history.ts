"use server"

/**
 * app/actions/commission-agreement-history.ts — THE CHANGE HISTORY OF AGENT / TEAM COMMISSION TERMS (wave 143, lane 143C).
 *
 * Owner (2026-10-23): "The SIGNED contracts for teams and agents are kept on record so agreed percentages, fees and
 * residual payouts stay true … agent split, brokerage split, team leader share, team fees, transaction fees, referral
 * payouts, residual payouts, revenue sharing, other fees, change history."
 *
 * This is the USER DOOR of the history lib/commission/agreement-terms.ts reads and the m812 triggers write: a finance admin
 * sees, per agent, every version of the terms (what changed, effective from when, recorded when) beside the signed
 * agreements of record (commission_agreement / independent_contractor / team_agreement) — and per team, the standing terms
 * history. READ-ONLY: history is written by the database trigger and nothing here (or anywhere in app code) writes it.
 *
 * Gate first, then the service client: the caller is a brokerage FINANCE ADMIN (isBrokerageFinanceAdmin — the books'
 * roster, CLAUDE.md §4), the tenant is the SESSION's brokerage, never a parameter. Fail closed: an unauthenticated or
 * non-finance caller gets a refusal, not an empty list. Every { error } is read; a missing history table (m812 not yet
 * applied) is reported as `historyAvailable: false`, not as "no history".
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { diffTerms, isHistoryUnavailable } from "@/lib/commission/agreement-terms"

export interface AgreementHistoryVersion {
  id: string
  effectiveFrom: string
  recordedAt: string | null
  terms: Record<string, unknown>
  /** What this version changed relative to the one before it (the first version lists every term as set). */
  changes: Array<{ key: string; from: unknown; to: unknown }>
}
export interface SignedAgreementOfRecord {
  id: string
  contractType: string
  fullyExecutedAt: string
  documentUrl: string | null
  teamId: string | null
}
export interface AgreementHistoryAgent {
  agentId: string
  name: string
  versions: AgreementHistoryVersion[]
  signed: SignedAgreementOfRecord[]
}
export interface AgreementHistoryTeam {
  teamId: string
  name: string
  versions: Array<{ effectiveDate: string; splitType: string | null; splitValue: number | null; capAmount: number | null; recordedAt: string | null }>
}

export async function listCommissionAgreementHistoryAction(): Promise<
  | { ok: true; historyAvailable: boolean; agents: AgreementHistoryAgent[]; teams: AgreementHistoryTeam[] }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { ok: false, error: "Unauthorized" }
  if (!isBrokerageFinanceAdmin({ user_type: ctx.userType })) return { ok: false, error: "Forbidden" }
  const brokerageId = ctx.brokerageId
  const svc = createServiceClient()

  const [versionsRes, teamVersionsRes, signedRes] = await Promise.all([
    svc.from("agent_commission_profile_versions")
      .select("id, agent_id, effective_from, terms, recorded_at")
      .eq("brokerage_id", brokerageId)
      .order("effective_from", { ascending: true })
      .limit(2000),
    svc.from("team_commission_profiles")
      .select("team_id, effective_date, team_split_type, team_split_value, cap_amount, created_at")
      .eq("brokerage_id", brokerageId)
      .order("effective_date", { ascending: true })
      .limit(1000),
    svc.from("contract_signatures")
      .select("id, agent_id, team_id, contract_type, fully_signed_at, document_url")
      .eq("brokerage_id", brokerageId)
      .eq("esign_status", "fully_signed")
      .in("contract_type", ["commission_agreement", "independent_contractor", "team_agreement"])
      .order("fully_signed_at", { ascending: false })
      .limit(1000),
  ])

  const historyAvailable = !isHistoryUnavailable(versionsRes.error)
  if (versionsRes.error && historyAvailable) return { ok: false, error: `Could not read the terms history: ${versionsRes.error.message}` }
  if (signedRes.error) return { ok: false, error: `Could not read the signed agreements: ${signedRes.error.message}` }
  const teamHistoryAvailable = !isHistoryUnavailable(teamVersionsRes.error)
  if (teamVersionsRes.error && teamHistoryAvailable) return { ok: false, error: `Could not read the team terms history: ${teamVersionsRes.error.message}` }

  const versionRows = historyAvailable ? ((versionsRes.data ?? []) as Array<{ id: string; agent_id: string; effective_from: string; terms: Record<string, unknown> | null; recorded_at: string | null }>) : []
  const signedRows = (signedRes.data ?? []) as Array<{ id: string; agent_id: string | null; team_id: string | null; contract_type: string; fully_signed_at: string | null; document_url: string | null }>
  const teamRows = teamHistoryAvailable ? ((teamVersionsRes.data ?? []) as Array<{ team_id: string; effective_date: string; team_split_type: string | null; team_split_value: number | string | null; cap_amount?: number | string | null; created_at: string | null }>) : []

  const agentIds = Array.from(new Set([...versionRows.map((v) => v.agent_id), ...signedRows.map((s) => s.agent_id).filter((x): x is string => !!x)]))
  const teamIds = Array.from(new Set(teamRows.map((t) => t.team_id)))
  const [agentsRes, teamsRes] = await Promise.all([
    agentIds.length
      ? svc.from("agents").select("id, users(first_name, last_name)").eq("brokerage_id", brokerageId).in("id", agentIds)
      : Promise.resolve({ data: [], error: null }),
    teamIds.length
      ? svc.from("teams").select("id, name").eq("brokerage_id", brokerageId).in("id", teamIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (agentsRes.error) return { ok: false, error: `Could not read the agents: ${agentsRes.error.message}` }
  if (teamsRes.error) return { ok: false, error: `Could not read the teams: ${teamsRes.error.message}` }

  const nameOf = new Map<string, string>()
  for (const a of (agentsRes.data ?? []) as any[]) {
    const u = Array.isArray(a.users) ? a.users[0] : a.users
    nameOf.set(a.id, [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || "Agent")
  }
  const teamName = new Map<string, string>((teamsRes.data ?? []).map((t: any) => [t.id as string, (t.name as string) ?? "Team"]))

  const agents: AgreementHistoryAgent[] = agentIds.map((agentId) => {
    const mine = versionRows.filter((v) => v.agent_id === agentId).sort((a, b) => a.effective_from.localeCompare(b.effective_from) || String(a.recorded_at ?? "").localeCompare(String(b.recorded_at ?? "")))
    const versions: AgreementHistoryVersion[] = mine.map((v, i) => ({
      id: v.id,
      effectiveFrom: v.effective_from,
      recordedAt: v.recorded_at,
      terms: v.terms ?? {},
      changes: diffTerms(i === 0 ? null : (mine[i - 1].terms ?? {}), v.terms ?? {}),
    }))
    const signed = signedRows
      .filter((s) => s.agent_id === agentId && s.fully_signed_at)
      .map((s) => ({ id: s.id, contractType: s.contract_type, fullyExecutedAt: s.fully_signed_at as string, documentUrl: s.document_url, teamId: s.team_id }))
    return { agentId, name: nameOf.get(agentId) ?? "Agent", versions, signed }
  }).sort((a, b) => a.name.localeCompare(b.name))

  const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v))
  const teams: AgreementHistoryTeam[] = teamIds.map((teamId) => ({
    teamId,
    name: teamName.get(teamId) ?? "Team",
    versions: teamRows.filter((t) => t.team_id === teamId).map((t) => ({
      effectiveDate: t.effective_date, splitType: t.team_split_type, splitValue: num(t.team_split_value), capAmount: num(t.cap_amount), recordedAt: t.created_at,
    })),
  })).sort((a, b) => a.name.localeCompare(b.name))

  return { ok: true, historyAvailable, agents, teams }
}
