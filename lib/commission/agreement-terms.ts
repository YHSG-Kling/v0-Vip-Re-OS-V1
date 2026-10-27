// lib/commission/agreement-terms.ts — EFFECTIVE-DATED AGREEMENT TERMS (wave 143, lane 143C).
//
// Owner ruling (2026-10-23): "The SIGNED contracts for teams and agents are kept on record so agreed
// percentages, fees and residual payouts stay true … Calculations use the agreement applicable to the
// transaction's period — never today's percentage on a historic deal."
//
// WHAT WAS WRONG AT HEAD (measured, 21da8e4e):
//   · agent_commission_profiles is ONE mutable row per agent (UNIQUE agent_id; agent-profile.ts upserts it in
//     place). getDefaultCommissionStructure read it `is_active = true` — whatever it says TODAY — so editing an
//     agent's split rewrote every deal still to be calculated, whatever period the deal belongs to.
//   · stage 08 judged the team's `terms_effective_date`, the agent's negotiated term and the team-member splits
//     against the WALL CLOCK, not the deal's period.
//   · nothing recorded WHICH agreement a calculation applied (commission_calculations.engine_inputs, a live jsonb
//     column, had no engine writer), so "the percentage we paid on" was unprovable after the fact.
//
// SURVIVORS EXTENDED, nothing replaced (CLAUDE.md §1):
//   · agent terms   — agent_commission_profiles stays THE current-terms row every writer already uses. m812 adds
//     the append-only history it never had (agent_commission_profile_versions), written by a DB trigger so EVERY
//     writer (agent-profile.ts, users.ts, provisioning, the SQL editor) is covered with no app change.
//   · team terms    — team_commission_profiles (UNIQUE team_id + effective_date) existed live with no reader and no
//     writer. m812 gives it the missing writer (a trigger on `teams`) and this module its missing reader.
//   · signed record — contract_signatures (commission_agreement / team_agreement, esign_status fully_signed,
//     field_values) is the signed ledger; it is READ here and cited, never copied.
//   · revenue share — agent_relationships.effective_from/to is already dated and judged on close_date
//     (stage 09, wave 107); it is the model this module follows.
//
// THE DATE A DEAL IS JUDGED ON: transactions.close_date — the same date stage 09 and economic-graph already judge
// on. A deal with no close date yet (a preview) falls to estimated_close_date, then contract_date, then today, and
// the SOURCE is returned so the evidence says which one decided. VERIFIED FROM: lib/commission/waterfall/09-revenue-share.ts
// (wave 107 ruling) — no universal legal rule exists: some brokerage agreements bind the split at contract
// ratification instead. That choice is per-brokerage policy; it is recorded under "Still open" in the lane notes,
// not invented here.
//
// PURE where it can be; the two loaders at the bottom take the service client as a parameter and READ every { error }
// (CLAUDE.md §3). The rule functions are module-private on purpose: the only ways in are the loaders, the engine stages
// that call them, and the small pure helpers the product reaches (agreementAsOf, memberInEffectOn, diffTerms) -
// test:agreement-waterfall proves the rules THROUGH the loaders against the in-memory client, so no export exists only
// for a proof (scripts/orphan-export-guard.ts counts those).

//
// WAVE 145 (lane 145C; owner rulings 3/4, 2026-10-27: "the agreement dictates the money structure … an executed change applies
// from its effective date"): the signed agreement of record is now the one IN FORCE BY ITS EFFECTIVE DATE (m858
// contract_signatures.effective_date; the execution date only stands in — SAID — until a finance admin records it), amendments
// included (lib/agreements/agent-agreements.ts agreementInForce). The resolution also says whether the terms in force were
// VERIFIED against that executed agreement (m858 agent_commission_profiles.agreement_signature_id, copied into every m812
// version's terms) — `governance` — and the engine HOLDS a FINAL when the executed paper states a term that disagrees with the
// stored one (lib/commission/engine.ts): a stated contradiction is never posted as money.

import type { createServiceClient } from "@/lib/supabase/service"
import { agreementInForce, type AgentAgreementRow } from "@/lib/agreements/agent-agreements"

type Svc = ReturnType<typeof createServiceClient>

/** A calendar date as YYYY-MM-DD. Lexicographic comparison is chronological for this shape. */
export type Ymd = string

export type AgreementAsOfSource = "close_date" | "estimated_close_date" | "contract_date" | "today_fallback"

const YMD = /^\d{4}-\d{2}-\d{2}/

function ymdOrNull(v: unknown): Ymd | null {
  return typeof v === "string" && YMD.test(v) ? v.slice(0, 10) : null
}

/** PURE — the date a deal's agreement is judged on, and which column decided. */
export function agreementAsOf(
  txn: { close_date?: unknown; estimated_close_date?: unknown; contract_date?: unknown } | null | undefined,
  today: Ymd,
): { date: Ymd; source: AgreementAsOfSource } {
  const close = ymdOrNull(txn?.close_date)
  if (close) return { date: close, source: "close_date" }
  const est = ymdOrNull(txn?.estimated_close_date)
  if (est) return { date: est, source: "estimated_close_date" }
  const contract = ymdOrNull(txn?.contract_date)
  if (contract) return { date: contract, source: "contract_date" }
  return { date: today, source: "today_fallback" }
}

// ─── Agent terms ────────────────────────────────────────────────────────────

/** One append-only row of agent_commission_profile_versions (m812). `terms` is the profile row minus its identity columns. */
export interface AgentTermsVersion {
  id?: string
  effective_from: Ymd
  terms: Record<string, unknown>
  recorded_at?: string | null
}

/**
 * PURE — the version in force on `asOf`: the latest effective_from <= asOf (ties broken by the later recorded_at).
 * `before_first_version` means the deal predates every recorded version; the EARLIEST one is returned and the caller
 * says so — it is the best knowledge of what applied before history began, and it is never silently the newest.
 */
function pickVersionAsOf<T extends { effective_from: Ymd; recorded_at?: string | null }>(
  rows: ReadonlyArray<T>,
  asOf: Ymd,
): { row: T; basis: "in_effect" | "before_first_version" } | null {
  if (rows.length === 0) return null
  const byRecency = (a: T, b: T) =>
    a.effective_from === b.effective_from
      ? String(b.recorded_at ?? "").localeCompare(String(a.recorded_at ?? ""))
      : b.effective_from.localeCompare(a.effective_from)
  const inEffect = rows.filter((r) => r.effective_from <= asOf).sort(byRecency)
  if (inEffect.length > 0) return { row: inEffect[0], basis: "in_effect" }
  const earliest = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from) || byRecency(b, a))[0]
  return { row: earliest, basis: "before_first_version" }
}

export type AgreementSource = "version" | "version_before_history" | "live_profile" | "none"

export interface AgentTermsResolution {
  /** The profile-shaped terms to price the deal with. null = no agreement terms on record for the period. */
  terms: Record<string, unknown> | null
  source: AgreementSource
  versionId: string | null
  effectiveFrom: Ymd | null
  asOf: Ymd
  asOfSource: AgreementAsOfSource
  /** Everything the resolver noticed — printed, stored in engine_inputs, never silent. */
  findings: string[]
  /** The signed commission_agreement of record on the as-of date (cited, not copied). WAVE 145: in force by its EFFECTIVE date
   *  (m858), amendments included; `effectiveDate` is null while only the execution date is known. */
  signedAgreement: { id: string; fullyExecutedAt: string; documentUrl: string | null; effectiveDate?: string | null; amends?: string | null } | null
  /** Terms the signed form states under a canonical term key that differ from what the engine applied. */
  signedFieldMismatches: Array<{ key: string; signed: number; applied: number }>
  /**
   * WAVE 145 (owner ruling 4) — were the terms in force VERIFIED against the executed agreement in force?
   *   verified               the version's terms name that agreement (m858 agreement_signature_id)
   *   unverified             an executed agreement governs, the terms do not name it (a human must verify them against it)
   *   no_executed_agreement  no executed commission agreement is on record for the date (the brokerage's terms stand alone)
   */
  governance?: "verified" | "unverified" | "no_executed_agreement"
  /** The agreement the terms in force were verified against (null = never verified). */
  termsVerifiedAgainst?: string | null
}

/** Identity / bookkeeping columns that are not terms. */
const PROFILE_IDENTITY_KEYS = ["id", "agent_id", "brokerage_id", "created_at", "effective_date"] as const

/** PURE — a live profile row as a terms object (identity columns removed). */
function termsFromProfileRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const k of PROFILE_IDENTITY_KEYS) delete out[k]
  return out
}

/** The numeric term keys a signed agreement form may state under their canonical (column) name. */
const SIGNED_COMPARABLE_KEYS = [
  "split_percent", "cap_amount", "transaction_fee_value", "desk_fee_value", "technology_fee_value",
  "eo_fee_value", "royalty_value", "referral_value", "residual_value", "team_override_percent",
] as const

function numFromForm(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v !== "string") return null
  const n = Number(v.replace(/[$,%\s]/g, ""))
  return v.trim() !== "" && Number.isFinite(n) ? n : null
}

/**
 * PURE — where the signed agreement's form states a term under a canonical key, compare it with the term the engine
 * applied. Keys the brokerage named differently are NOT interpreted (the form's fields are tenant-defined); this
 * surfaces a disagreement for a human, it never overrides a stored term and never edits a signed document.
 */
function compareSignedFieldsToTerms(
  fieldValues: unknown,
  terms: Record<string, unknown> | null,
): Array<{ key: string; signed: number; applied: number }> {
  if (!terms || !fieldValues || typeof fieldValues !== "object") return []
  const out: Array<{ key: string; signed: number; applied: number }> = []
  for (const key of SIGNED_COMPARABLE_KEYS) {
    if (!(key in (fieldValues as Record<string, unknown>))) continue
    const signed = numFromForm((fieldValues as Record<string, unknown>)[key])
    const applied = numFromForm(terms[key])
    if (signed === null || applied === null) continue
    if (Math.abs(signed - applied) > 0.005) out.push({ key, signed, applied })
  }
  return out
}

type SignedRow = { id: string; esign_status?: string | null; fully_signed_at?: string | null; document_url?: string | null; field_values?: unknown; effective_date?: string | null; amends_contract_signature_id?: string | null; contract_type?: string | null }

/**
 * PURE — the FULLY SIGNED agreement IN FORCE on `asOf` (wave 145: by its recorded EFFECTIVE date — m858 — with the execution date
 * standing in, said, until one is recorded; an executed amendment is in force from its own effective date). The rows are one
 * contract family (the loader filters), so the shared rule in lib/agreements/agent-agreements.ts decides.
 */
function signedAgreementAsOf(
  rows: ReadonlyArray<SignedRow>,
  asOf: Ymd,
): { id: string; fullyExecutedAt: string; documentUrl: string | null; fieldValues: unknown; effectiveDate: string | null; amends: string | null; findings: string[] } | null {
  const usable = rows.filter((r) => typeof r.fully_signed_at === "string")
  const family = Array.from(new Set(usable.map((r) => r.contract_type ?? "commission_agreement")))
  const pick = agreementInForce(usable.map((r) => ({ ...r, contract_type: r.contract_type ?? "commission_agreement", agent_id: null, brokerage_id: null }) as AgentAgreementRow), family, asOf)
  if (!pick) return null
  const r = pick.row as AgentAgreementRow
  return {
    id: r.id, fullyExecutedAt: String(r.fully_signed_at), documentUrl: r.document_url ?? null, fieldValues: r.field_values,
    effectiveDate: pick.basis === "effective_date" ? pick.from : null, amends: r.amends_contract_signature_id ?? null, findings: pick.findings,
  }
}

/**
 * PURE — resolve an agent's terms for the deal's period.
 * Order: the version in force → (deal predates all history) the earliest version → the live profile (history table
 * unavailable or empty for this agent) → none. An INACTIVE agreement in force prices as no agreement, exactly as the
 * `is_active = true` read did before.
 */
function resolveAgentTerms(input: {
  versions: ReadonlyArray<AgentTermsVersion>
  liveProfile: Record<string, unknown> | null
  versionsAvailable: boolean
  asOf: { date: Ymd; source: AgreementAsOfSource }
  signedRows?: ReadonlyArray<SignedRow>
}): AgentTermsResolution {
  const findings: string[] = []
  const pick = pickVersionAsOf(input.versions, input.asOf.date)
  let terms: Record<string, unknown> | null = null
  let source: AgreementSource = "none"
  let versionId: string | null = null
  let effectiveFrom: Ymd | null = null

  if (pick) {
    terms = pick.row.terms
    source = pick.basis === "in_effect" ? "version" : "version_before_history"
    versionId = pick.row.id ?? null
    effectiveFrom = pick.row.effective_from
    if (pick.basis === "before_first_version") {
      findings.push(`no agreement version was in force on ${input.asOf.date}; the earliest recorded (effective ${pick.row.effective_from}) applies`)
    }
  } else if (input.liveProfile) {
    terms = termsFromProfileRow(input.liveProfile)
    source = "live_profile"
    findings.push(input.versionsAvailable
      ? "no agreement history is recorded for this agent — the live profile applies"
      : "agreement history is unavailable (m812 not applied) — the live profile applies")
  } else {
    findings.push("no commission agreement terms are on record for this agent")
  }

  if (terms && terms.is_active === false) {
    findings.push("the agreement in force is inactive — priced as no agreement")
    terms = null
  }

  const signed = signedAgreementAsOf(input.signedRows ?? [], input.asOf.date)
  if (signed) findings.push(...signed.findings)
  const mismatches = signed ? compareSignedFieldsToTerms(signed.fieldValues, terms) : []
  if (mismatches.length > 0) {
    findings.push(`the signed agreement states ${mismatches.map((m) => `${m.key} ${m.signed}`).join(", ")} but the engine applied ${mismatches.map((m) => `${m.key} ${m.applied}`).join(", ")} — a finance admin must reconcile the profile to the signed document`)
  }

  // WAVE 145 (owner ruling 4): did a human verify the terms in force against the executed agreement in force?
  const verifiedAgainst = terms && typeof terms.agreement_signature_id === "string" ? (terms.agreement_signature_id as string) : null
  const governance: AgentTermsResolution["governance"] = !signed ? "no_executed_agreement" : verifiedAgainst === signed.id ? "verified" : "unverified"
  if (governance === "unverified") {
    findings.push(verifiedAgainst
      ? `the terms in force were verified against agreement ${verifiedAgainst}, but the executed agreement in force on ${input.asOf.date} is ${signed!.id}${signed!.amends ? ` (an amendment of ${signed!.amends})` : ""} — a finance admin verifies the terms against it`
      : `an executed agreement (${signed!.id}) governs on ${input.asOf.date}, but the terms in force were never verified against it — a finance admin verifies them (Financials → Commission agreements)`)
  }

  return {
    terms,
    source,
    versionId,
    effectiveFrom,
    asOf: input.asOf.date,
    asOfSource: input.asOf.source,
    findings,
    signedAgreement: signed ? { id: signed.id, fullyExecutedAt: signed.fullyExecutedAt, documentUrl: signed.documentUrl, effectiveDate: signed.effectiveDate, amends: signed.amends } : null,
    signedFieldMismatches: mismatches,
    governance,
    termsVerifiedAgainst: verifiedAgainst,
  }
}

/**
 * PURE — what changed between two consecutive versions of an agent's terms (the CHANGE HISTORY the owner asks for:
 * "agent split, brokerage split, team leader share, team fees, transaction fees, referral payouts, residual payouts,
 * revenue sharing, other fees, change history"). Keys only in one side count as a change from/to null. Order is stable.
 */
export function diffTerms(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Array<{ key: string; from: unknown; to: unknown }> {
  const keys = Array.from(new Set([...Object.keys(prev ?? {}), ...Object.keys(next)])).sort()
  const norm = (v: unknown) => (v === undefined || v === "" ? null : v)
  return keys
    .map((key) => ({ key, from: norm(prev?.[key]), to: norm(next[key]) }))
    .filter((c) => JSON.stringify(c.from) !== JSON.stringify(c.to))
}

// ─── Team terms ─────────────────────────────────────────────────────────────

/** One row of team_commission_profiles (UNIQUE team_id + effective_date) as the trigger on `teams` writes it (m812). */
export interface TeamTermsVersion {
  effective_date: Ymd
  team_split_type?: string | null
  team_split_value?: unknown
  cap_amount?: unknown
  is_active?: boolean | null
  created_at?: string | null
}

export interface TeamTermsResolution {
  splitType: "percent" | "flat"
  splitValue: number
  capAmount: number | null
  source: "version" | "live_team"
  effectiveFrom: Ymd | null
  /** The agent's signed team_agreement of record on the deal's date (contract_signatures; cited, never copied). Wave 145: in
   *  force by its recorded effective date (m858), amendments included. */
  signedAgreement?: { id: string; fullyExecutedAt: string; documentUrl: string | null; effectiveDate?: string | null; amends?: string | null } | null
  /** m812 trigger-written on the governing version row: the team's fee schedule, per-member overrides, and when it was recorded. */
  teamFees?: Record<string, unknown> | null
  memberOverrides?: Record<string, unknown> | null
  recordedAt?: string | null
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * PURE — the TEAM's standing terms for the deal's period, or null when the team has no terms in force that day.
 * Unlike an agent's terms, a team's override stays INERT before its first effective date (the standing rule the
 * stage always had: isAgreementEffective). Versions win; the live `teams` row is the fallback while history is
 * unavailable or empty, judged on the same date.
 */
function resolveTeamTermsAsOf(input: {
  versions: ReadonlyArray<TeamTermsVersion>
  liveTeam: { team_split_type?: unknown; team_split_percent?: unknown; team_split_value?: unknown; cap_amount?: unknown; terms_effective_date?: unknown } | null
  asOf: Ymd
}): TeamTermsResolution | null {
  const active = input.versions
    .filter((v) => v.is_active !== false && v.effective_date <= input.asOf)
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date))
  const v = active[0]
  if (v) {
    return {
      splitType: v.team_split_type === "flat" ? "flat" : "percent",
      splitValue: numOrNull(v.team_split_value) ?? 0,
      capAmount: numOrNull(v.cap_amount),
      source: "version",
      effectiveFrom: v.effective_date,
    }
  }
  if (input.versions.length > 0) return null // history exists and none of it is in force yet: the team's terms start later
  const t = input.liveTeam
  if (!t) return null
  const from = ymdOrNull(t.terms_effective_date)
  if (from && from > input.asOf) return null
  const splitType = t.team_split_type === "flat" ? "flat" : "percent"
  return {
    splitType,
    splitValue: (splitType === "flat" ? numOrNull(t.team_split_value) : numOrNull(t.team_split_percent)) ?? 0,
    capAmount: numOrNull(t.cap_amount),
    source: "live_team",
    effectiveFrom: from,
  }
}

/**
 * PURE — is a team_members row part of the team on `asOf`? A dated row is judged on its window (so a member who has
 * since left still counts on a deal from their period, and one who has not yet started does not); an undated row
 * keeps the is_active reading it always had.
 */
export function memberInEffectOn(
  m: { effective_from?: unknown; effective_to?: unknown; is_active?: unknown },
  asOf: Ymd,
): boolean {
  const from = ymdOrNull(m.effective_from)
  const to = ymdOrNull(m.effective_to)
  if (!from && !to) return m.is_active !== false
  if (from && from > asOf) return false
  if (to && to < asOf) return false
  return true
}

// ─── Loaders (service client passed in; every { error } read) ────────────────

/** A missing history table / column (migration not yet applied) — the one refusal that degrades to the live row, SAID. */
export function isHistoryUnavailable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  const m = String(error.message ?? "").toLowerCase()
  return error.code === "42P01" || error.code === "PGRST205" || error.code === "42703" || error.code === "PGRST204" ||
    m.includes("does not exist") || m.includes("schema cache")
}

/** The agent's agreement for the deal's period: versions + live profile + the signed record, resolved by the pure rule. */
export async function loadAgentAgreementAsOf(
  svc: Svc,
  args: { brokerageId: string; agentId: string; asOf: { date: Ymd; source: AgreementAsOfSource } },
): Promise<AgentTermsResolution> {
  const [versionsRes, liveRes, signedRes] = await Promise.all([
    svc.from("agent_commission_profile_versions")
      .select("id, effective_from, terms, recorded_at")
      .eq("agent_id", args.agentId)
      .eq("brokerage_id", args.brokerageId),
    svc.from("agent_commission_profiles")
      .select("*")
      .eq("agent_id", args.agentId)
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle(),
    // select("*"): m858's effective_date / amends_contract_signature_id arrive when applied and are simply absent before —
    // naming them would turn "not applied yet" into a refused read (CLAUDE.md §3, PGRST204's sibling 42703).
    // WAVE 145: the money terms live in the commission agreement; a brokerage that uses ONE combined paper has only the
    // independent-contractor agreement — it is read as the agreement of record only when no commission agreement exists.
    svc.from("contract_signatures")
      .select("*")
      .eq("agent_id", args.agentId)
      .eq("brokerage_id", args.brokerageId)
      .in("contract_type", ["commission_agreement", "independent_contractor"])
      .eq("esign_status", "fully_signed")
      .order("fully_signed_at", { ascending: false })
      .limit(50),
  ])
  const unavailable = isHistoryUnavailable(versionsRes.error)
  if (versionsRes.error && !unavailable) {
    // A refused history read must not silently price today's percentage on a historic deal.
    throw new Error(`[agreement-terms] agent agreement history read refused: ${versionsRes.error.message}`)
  }
  if (liveRes.error) throw new Error(`[agreement-terms] agent commission profile read refused: ${liveRes.error.message}`)
  const signedAll = signedRes.error ? [] : ((signedRes.data ?? []) as SignedRow[])
  const commissionPaper = signedAll.filter((r) => (r.contract_type ?? "commission_agreement") === "commission_agreement")
  const resolution = resolveAgentTerms({
    versions: unavailable ? [] : ((versionsRes.data ?? []) as AgentTermsVersion[]),
    liveProfile: (liveRes.data ?? null) as Record<string, unknown> | null,
    versionsAvailable: !unavailable,
    asOf: args.asOf,
    signedRows: commissionPaper.length > 0 ? commissionPaper : signedAll.filter((r) => r.contract_type === "independent_contractor"),
  })
  if (signedRes.error) resolution.findings.push(`the signed agreement of record could not be read (${signedRes.error.message}) — not cited`)
  else if (!resolution.signedAgreement) resolution.findings.push("no fully signed commission agreement is on record for this agent on the deal's date")
  return resolution
}

/**
 * The team's standing terms for the deal's period (versions, else the live team row) plus the producing agent's SIGNED
 * team_agreement of record on that date (contract_signatures: contract_type 'team_agreement', the agent + the team) —
 * "the signed contracts for teams and agents are kept on record so agreed percentages stay true" (owner, 2026-10-23).
 * The signed record is cited in the calculation's evidence; it is never parsed into money.
 */
export async function loadTeamTermsAsOf(
  svc: Svc,
  args: { brokerageId: string; teamId: string; agentId: string; asOf: Ymd; liveTeam: Parameters<typeof resolveTeamTermsAsOf>[0]["liveTeam"] },
): Promise<TeamTermsResolution | null> {
  const [versionsRes, signedRes] = await Promise.all([
    svc.from("team_commission_profiles")
      .select("effective_date, team_split_type, team_split_value, cap_amount, is_active, created_at, team_fees_json, member_overrides_json, recorded_at")
      .eq("team_id", args.teamId)
      .eq("brokerage_id", args.brokerageId),
    svc.from("contract_signatures")
      .select("*")
      .eq("team_id", args.teamId)
      .eq("agent_id", args.agentId)
      .eq("brokerage_id", args.brokerageId)
      .eq("contract_type", "team_agreement")
      .eq("esign_status", "fully_signed")
      .order("fully_signed_at", { ascending: false })
      .limit(25),
  ])
  const unavailable = isHistoryUnavailable(versionsRes.error)
  if (versionsRes.error && !unavailable) throw new Error(`[agreement-terms] team terms history read refused: ${versionsRes.error.message}`)
  const terms = resolveTeamTermsAsOf({ versions: unavailable ? [] : ((versionsRes.data ?? []) as TeamTermsVersion[]), liveTeam: args.liveTeam, asOf: args.asOf })
  if (!terms) return null
  // A refused read of the signed record is evidence lost, not money lost: the terms still price the deal.
  const signed = signedRes.error ? null : signedAgreementAsOf((signedRes.data ?? []) as SignedRow[], args.asOf)
  // The version row that governs (m812 trigger-written): its team fees / member overrides / recorded_at ride on the
  // resolution so the waterfall and the agreements page read what the trigger wrote (wave 143 integration).
  const governingRow = (unavailable ? [] : ((versionsRes.data ?? []) as Array<Record<string, unknown>>))
    .filter((r) => typeof r.effective_date === "string" && (r.effective_date as string) <= args.asOf)
    .sort((x, y) => String(y.effective_date).localeCompare(String(x.effective_date)))[0] ?? null
  return {
    ...terms,
    signedAgreement: signed ? { id: signed.id, fullyExecutedAt: signed.fullyExecutedAt, documentUrl: signed.documentUrl, effectiveDate: signed.effectiveDate, amends: signed.amends } : null,
    teamFees: (governingRow?.team_fees_json as Record<string, unknown> | null | undefined) ?? null,
    memberOverrides: (governingRow?.member_overrides_json as Record<string, unknown> | null | undefined) ?? null,
    recordedAt: (governingRow?.recorded_at as string | null | undefined) ?? null,
  }
}
