// lib/transactions/cda-closing-policy.ts — THE CLOSING-MONEY POLICY, PURE (wave 142, lane 142C).
//
// Owner rulings this module holds as code (2026-10-18):
//   · CDA (owner): "available ONLY when brokerage settings say the brokerage uses CDA
//     (brokerages.offers_cda, cda_onboarding_at, non_cda_payout_default exist live)". Disabled → no
//     mandatory CDA, no auto-generation, NOTHING BLOCKS CLOSING; the brokerage-received-commission +
//     agent payout flow applies.
//   · PRELIMINARY HUD / CD: "the TITLE COMPANY supplies it … attach to the transaction with versioning
//     … discrepancies → documented correction request → revised official statement → version retained →
//     waterfall reconciled → broker reviews. AI may identify/explain discrepancies, never fabricate
//     values; never alter the title company's document." — and the broker cannot approve a CDA on
//     unresolved inaccurate figures.
//   · DEADLINE: "signed approved CDA reaches title before/at scheduled closing (tenant timezone;
//     earlier brokerage/title requirements win) — reminders + immediate escalation".
//   · DELIVERY: "title on the Deal Team → authorized title portal inbox with evidence; title outside →
//     existing configured outbound email … with tracked status; never duplicate delivery on retry."
//   · FILL: "the AGENT fills the CDA MANUALLY from the approved CDA form in platform Media; AI MUST NOT
//     FILL THE CDA (it may explain waterfall figures when asked)."
//
// SURVIVORS this sits beside (none replaced): lib/transactions/cda-signing-policy.ts (who may approve /
// broker-sign / send), cda-delivery-policy.ts (approved-but-unsent escalation), cda-template-fields.ts
// (the agent-filled form — money never pre-filled), lib/commission/cda-discrepancy.ts (contract vs CDA).
// This file is the PURE half the server actions (app/actions/cda-portal.ts), the deadline reaper
// (lib/transactions/cda-delivery-reaper.ts) and the proof (scripts/cda-closing-flow-guard.ts) share.
// No model; every function is deterministic over the inputs it is handed. ONE exception (§1c, wave 152 lane 152H):
// loadEffectiveCdaModes reads the policy history through the CALLER's client — it imports nothing, so the client
// components that import this module's pure half reach no server module.

import { timeZoneForState } from "@/lib/fatigue/after-hours"

// ─── 1. CDA MODE — the brokerage setting is the ONE switch ──────────────────────────────────────

/** THE FILL RULE, as data the proof and the UI copy read: the agent types the money; AI only explains. */
export const CDA_FILL_RULE = { agentFills: true, aiFills: false, aiMayExplainFigures: true } as const

export interface CdaModeVerdict {
  mode: "cda" | "no_cda"
  /** A CDA is part of this brokerage's closing (offers_cda = true). */
  cdaRequired: boolean
  /** Never true: a missing CDA never blocks a closing — the no-CDA brokerage pays out after receipt. */
  blocksClosing: false
  /** The no-CDA payout default (brokerages.non_cda_payout_default); null in CDA mode. */
  payoutMethodDefault: "direct_deposit" | "check" | null
  reason: "offers_cda" | "no_cda_declared" | "cda_not_declared"
}

/**
 * PURE — does this brokerage use a CDA? `offers_cda` TRUE → CDA mode. FALSE → the no-CDA flow.
 * NULL (never answered at onboarding) → the no-CDA flow with reason `cda_not_declared`: the owner's
 * rule is "CDA exists ONLY when brokerage settings say so", so an undeclared setting never manufactures
 * a mandatory CDA. (At HEAD the CDA page defaulted `?? true` while finalizeCommissionAtClose defaulted
 * `?? false` — two answers to one question; this is the one answer both now read.)
 */
export function resolveCdaMode(input: { offersCda: boolean | null | undefined; nonCdaPayoutDefault?: string | null }): CdaModeVerdict {
  if (input.offersCda === true) {
    return { mode: "cda", cdaRequired: true, blocksClosing: false, payoutMethodDefault: null, reason: "offers_cda" }
  }
  const def = input.nonCdaPayoutDefault === "check" ? "check" : "direct_deposit"
  return {
    mode: "no_cda",
    cdaRequired: false,
    blocksClosing: false,
    payoutMethodDefault: def,
    reason: input.offersCda === false ? "no_cda_declared" : "cda_not_declared",
  }
}

// ─── 1b. THE PAYOUT GATE — a brokerage SETTING (wave 144, lane 144D; owner ruling 8) ─────────────────
//
// Owner (2026-10-25): "Payout gate is a brokerage SETTING: either pay out at closing (CDA authorizes the permitted
// closing-time distribution) or pay out when the brokerage receives the final commission and then pays the agent/team.
// Approval, payout initiation and verified receipt are separate states … no fabricated paid status."
// The setting is brokerages.commission_payout_timing (m850), beside offers_cda — the brokerage's other closing-money switch.
// UNDECLARED (NULL / pre-m850) IS "AFTER RECEIPT": the funds-received gate (lib/commission/ledger-sync.ts payoutFundsGate) is
// the fail-closed default, and a closing-time release is never inferred from offers_cda alone (a CDA brokerage may still
// have title pay the brokerage the whole commission). AT CLOSING needs a CDA brokerage: without offers_cda the setting is
// reported and the receipt gate applies.

export const COMMISSION_PAYOUT_TIMINGS = ["at_closing_per_cda", "after_brokerage_receipt"] as const
export type CommissionPayoutTiming = (typeof COMMISSION_PAYOUT_TIMINGS)[number]

export const COMMISSION_PAYOUT_TIMING_LABEL: Record<CommissionPayoutTiming, string> = {
  at_closing_per_cda: "At closing — title disburses the agent's share as the broker-signed CDA authorizes",
  after_brokerage_receipt: "After the brokerage receives the commission — then the brokerage pays the agent / team",
}

export interface PayoutTimingVerdict {
  timing: CommissionPayoutTiming
  declared: boolean
  finding: string | null
}

/** PURE — which payout gate this brokerage runs. */
export function resolvePayoutTiming(input: { offersCda: boolean | null | undefined; payoutTiming: unknown }): PayoutTimingVerdict {
  if (input.payoutTiming === "at_closing_per_cda") {
    if (input.offersCda === true) return { timing: "at_closing_per_cda", declared: true, finding: null }
    return {
      timing: "after_brokerage_receipt",
      declared: true,
      finding: "the brokerage chose closing-time payout but does not use a CDA (offers_cda is not true) — nothing authorizes a closing-time distribution, so the brokerage-receipt gate applies",
    }
  }
  if (input.payoutTiming === "after_brokerage_receipt") return { timing: "after_brokerage_receipt", declared: true, finding: null }
  return { timing: "after_brokerage_receipt", declared: false, finding: null }
}

// ─── 1c. THE EFFECTIVE CDA POLICY — a brokerage that changes its CDA policy (wave 152, lane 152H) ────────────────────────
//
// Owner (wave 152, verbatim): "if a brokerage changes their policy from a no cda to now using cda can turn the setting to opt in."
// Directive 152H: "Read current effective policy at relevant transaction milestones … do not silently and retroactively impose a CDA
// on an already-completed transaction … Changing the CDA setting is not a substitute for correct Closing Disclosure or settlement review."
//
// THE SETTING STAYS THE ONE SWITCH (brokerages.offers_cda, read by resolveCdaMode above — never renamed, no opt-in product). This
// section answers WHICH value of that switch governs a given deal. Every audited change of the setting (app/actions/brokerage-cda-
// setup.ts setBrokerageCdaSettingAction: finance admin, brokerage-wide scope, reason, ledgered) appends a version of `cda_policy` to the
// ONE tenant policy history (lib/kernel/tenant-policy.ts appendTenantPolicyVersion → tenant_policy_versions, append-only since m696)
// carrying { offers_cda, non_cda_payout_default, effective_at, scope }. A deal is governed by the value in force WHEN IT OPENED
// (transactions.created_at), unless a finance admin switched that ONE deal (closing_disclosure_agreement.field_values.cda_mode_switch,
// written only by switchDealCdaModeAction, ledgered). Each milestone reader hands `governing` to resolveCdaMode.
//
// THE TREATMENT MATRIX — the SAFE DEFAULT proposed to the owner (lane 152H notes, "Owner decisions"):
//   deal at the change            no CDA → CDA (opt in)                         CDA → no CDA (opt out)
//   opened after the change       CDA required: the agent fills it, compliance  closes without a CDA on the smallest honest
//                                 approves, the broker signs, title receives it proof — compliance and settlement still checked
//   in progress, opened before    keeps NO CDA unless a finance admin switches  keeps its CDA unless a finance admin switches it
//                                 the deal to a CDA                             off (refused once approved / signed / with title)
//   closed / funded / lost        never given a CDA (no switch accepted)        keeps the CDA it closed with (no switch accepted)
// Nothing here creates, fills, generates or signs a CDA (CDA_FILL_RULE): a switch to CDA opens the deal's row for the AGENT to fill.
// No compliance, settlement or Closing Disclosure gate reads the CDA mode, so changing it never clears one of those holds.

/** The tenant_policy_versions stream that records every change of the brokerage's CDA setting (registered in lib/kernel/tenant-policy.ts). */
export const CDA_POLICY_KEY = "cda_policy" as const

/** One version's value: the setting as saved, the instant it took effect (the save instant — never back-dated) and its scope. */
interface CdaPolicyValue {
  offers_cda: boolean | null
  non_cda_payout_default: "direct_deposit" | "check" | null
  effective_at: string | null
  /** The setting governs the whole brokerage — every office and team inherits it; no office carries its own. */
  scope: "brokerage"
}

/** PURE — the value a cda_policy version carries, from the brokerage columns as they stand (before or after a change). */
export function cdaPolicyValue(
  row: { offers_cda?: boolean | null; non_cda_payout_default?: string | null } | null | undefined,
  effectiveAt: string | null,
): CdaPolicyValue {
  const offers = row?.offers_cda === true ? true : row?.offers_cda === false ? false : null
  const def = row?.non_cda_payout_default === "check" ? "check" : row?.non_cda_payout_default === "direct_deposit" ? "direct_deposit" : null
  return { offers_cda: offers, non_cda_payout_default: def, effective_at: effectiveAt, scope: "brokerage" }
}

/** A finance admin's switch of ONE deal, as switchDealCdaModeAction stores it on the deal's CDA row. */
interface DealCdaSwitch {
  mode: "cda" | "no_cda"
  by: string
  at: string
  reason: string
  from: "cda" | "no_cda" | null
  policy_version: number | null
}

/** A reason is "a few words" — the same floor the delivery re-send asks for. */
const CDA_CHANGE_REASON_MIN = 5

/** PURE — a stored switch, or null when absent / incomplete (a switch without who, when and why does not govern). */
function readDealCdaSwitch(fieldValues: unknown): DealCdaSwitch | null {
  const fv = fieldValues && typeof fieldValues === "object" ? (fieldValues as Record<string, unknown>) : null
  const s = fv?.cda_mode_switch
  if (!s || typeof s !== "object") return null
  const r = s as Record<string, unknown>
  if (r.mode !== "cda" && r.mode !== "no_cda") return null
  if (typeof r.by !== "string" || !r.by || typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null
  if (typeof r.reason !== "string" || r.reason.trim().length < CDA_CHANGE_REASON_MIN) return null
  return {
    mode: r.mode, by: r.by, at: r.at, reason: r.reason.trim(),
    from: r.from === "cda" || r.from === "no_cda" ? r.from : null,
    policy_version: typeof r.policy_version === "number" ? r.policy_version : null,
  }
}

/** transactions.created_at is `timestamp without time zone` (UTC by the database default) — a zone-less value is read as UTC. */
function instantMs(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null
  const s = raw.trim()
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}Z`
  const ms = Date.parse(zoned)
  return Number.isNaN(ms) ? null : ms
}

const dayOf = (raw: string | null | undefined): string => { const ms = instantMs(raw ?? null); return ms == null ? "an unknown date" : new Date(ms).toISOString().slice(0, 10) }
const modeWords = (m: "cda" | "no_cda") => (m === "cda" ? "CDA" : "no-CDA")

interface EffectiveCdaMode extends CdaModeVerdict {
  /** The policy value that governs — the input a milestone reader hands to resolveCdaMode (the ONE switch). */
  governing: { offersCda: boolean | null; nonCdaPayoutDefault: string | null }
  basis: "deal_switch" | "policy_when_opened" | "current_policy"
  /** The mode in force when the deal opened (null for the brokerage-level reading). */
  openedUnder: "cda" | "no_cda" | null
  /** What a deal opened right now gets. */
  current: "cda" | "no_cda"
  /** The cda_policy version this reading rests on (0 = the value before any recorded change, or none recorded). */
  policyVersion: number
  differsFromCurrent: boolean
  dealSwitch: DealCdaSwitch | null
  /** The live setting disagrees with the last recorded version: it was changed outside the audited door, at an unknown time. */
  unrecordedChange: boolean
  /** Plain words for the agent / TC / finance admin. */
  explanation: string
}

type HistoryStep = { version: number; value: CdaPolicyValue; previous: CdaPolicyValue; effectiveMs: number | null; created_at: string | null }

function historySteps(history: ReadonlyArray<{ version: number; value: unknown; previous: unknown; created_at?: string | null }>): HistoryStep[] {
  const asValue = (v: unknown): CdaPolicyValue | null => {
    if (!v || typeof v !== "object" || !("offers_cda" in (v as Record<string, unknown>))) return null
    const r = v as Record<string, unknown>
    return cdaPolicyValue({ offers_cda: r.offers_cda as boolean | null, non_cda_payout_default: r.non_cda_payout_default as string | null }, typeof r.effective_at === "string" ? r.effective_at : null)
  }
  const steps: HistoryStep[] = []
  for (const row of history) {
    const value = asValue(row.value)
    if (!value || !Number.isInteger(row.version)) continue
    steps.push({
      version: row.version, value, previous: asValue(row.previous) ?? cdaPolicyValue(null, null),
      effectiveMs: instantMs(value.effective_at) ?? instantMs(row.created_at ?? null), created_at: row.created_at ?? null,
    })
  }
  return steps.sort((a, b) => a.version - b.version)
}

/**
 * PURE — which value of the brokerage's CDA setting governs (the deal, or — with no deal — a deal opened now). The setting's history
 * decides an in-progress deal: the value in force when it opened, unless a finance admin switched that one deal. A deal opened after
 * the last recorded change follows the live setting. No recorded change at all → the live setting (today's behaviour, unchanged).
 */
function resolveEffectiveCdaMode(input: {
  live: { offersCda: boolean | null | undefined; nonCdaPayoutDefault?: string | null }
  history: ReadonlyArray<{ version: number; value: unknown; previous: unknown; created_at?: string | null }>
  deal?: { openedAt?: string | null } | null
  dealSwitch?: unknown
}): EffectiveCdaMode {
  const live = { offersCda: input.live.offersCda === true ? true : input.live.offersCda === false ? false : null, nonCdaPayoutDefault: input.live.nonCdaPayoutDefault ?? null }
  const current = resolveCdaMode(live).mode
  const steps = historySteps(input.history)
  const latest = steps.length ? steps[steps.length - 1] : null
  const unrecordedChange = !!latest && resolveCdaMode({ offersCda: latest.value.offers_cda }).mode !== current
  const sw = input.deal ? readDealCdaSwitch(input.dealSwitch) : null
  const build = (governing: EffectiveCdaMode["governing"], basis: EffectiveCdaMode["basis"], openedUnder: EffectiveCdaMode["openedUnder"], policyVersion: number, explanation: string): EffectiveCdaMode => {
    const verdict = resolveCdaMode(governing)
    return { ...verdict, governing, basis, openedUnder, current, policyVersion, differsFromCurrent: verdict.mode !== current, dealSwitch: sw, unrecordedChange, explanation }
  }
  const unrecordedNote = unrecordedChange ? " The setting was changed outside CDA settings, so when that change took effect is not on record." : ""

  if (!input.deal) {
    return build(live, "current_policy", null, latest?.version ?? 0, `Your brokerage's ${modeWords(current)} policy applies to new deals.${unrecordedNote}`)
  }

  // The policy in force when the deal opened.
  let openedGoverning: EffectiveCdaMode["governing"] = live
  let basis: EffectiveCdaMode["basis"] = "current_policy"
  let version = latest?.version ?? 0
  const why = steps.length === 0 ? "no change of the CDA policy is on record" : "the deal's opening time is unknown"
  const openedMs = instantMs(input.deal.openedAt ?? null)
  if (openedMs != null && steps.length > 0) {
    let idx = -1
    for (let i = 0; i < steps.length; i++) { const e = steps[i].effectiveMs; if (e != null && e <= openedMs) idx = i }
    basis = "policy_when_opened"
    if (idx === steps.length - 1) { openedGoverning = live; version = steps[idx].version }
    else if (idx >= 0) { openedGoverning = { offersCda: steps[idx].value.offers_cda, nonCdaPayoutDefault: steps[idx].value.non_cda_payout_default }; version = steps[idx].version }
    else { openedGoverning = { offersCda: steps[0].previous.offers_cda, nonCdaPayoutDefault: steps[0].previous.non_cda_payout_default }; version = 0 }
  }
  const openedUnder = resolveCdaMode(openedGoverning).mode

  if (sw) {
    return build({ offersCda: sw.mode === "cda", nonCdaPayoutDefault: live.nonCdaPayoutDefault }, "deal_switch", openedUnder, sw.policy_version ?? version,
      `A finance admin switched this deal to ${sw.mode === "cda" ? "use a CDA" : "close without a CDA"} on ${dayOf(sw.at)} ("${sw.reason}").`)
  }
  if (basis === "policy_when_opened" && openedUnder !== current) {
    return build(openedGoverning, basis, openedUnder, version,
      `This deal opened on ${dayOf(input.deal.openedAt)} under your brokerage's ${modeWords(openedUnder)} policy, so it ${openedUnder === "cda" ? "still uses a CDA" : "closes without a CDA"}. The ${modeWords(current)} policy applies to deals opened after the change; a finance admin can switch this deal in CDA settings.${unrecordedNote}`)
  }
  return build(openedGoverning, basis, openedUnder, version,
    basis === "policy_when_opened" ? `This deal follows your brokerage's ${modeWords(openedUnder)} policy.${unrecordedNote}` : `This deal follows your brokerage's current ${modeWords(openedUnder)} policy (${why}).${unrecordedNote}`)
}

/** PURE — may this change of the brokerage's setting be saved, and with what recorded reason? */
export function decideCdaPolicyChange(input: {
  before: { offersCda: boolean | null | undefined; nonCdaPayoutDefault?: string | null }
  next: { offersCda: boolean; nonCdaPayoutDefault?: string | null }
  reason?: string | null
  /** Deals not yet closed / lost — the ones whose treatment a mode change touches. */
  openDeals: number
}): { ok: true; changed: boolean; modeChanged: boolean; firstAnswer: boolean; reason: string } | { ok: false; error: "reason_required"; message: string } {
  const beforeOffers = input.before.offersCda === true ? true : input.before.offersCda === false ? false : null
  const nextPayout = input.next.offersCda ? null : input.next.nonCdaPayoutDefault === "check" ? "check" : "direct_deposit"
  const changed = beforeOffers !== input.next.offersCda || (input.before.nonCdaPayoutDefault ?? null) !== nextPayout
  const modeChanged = resolveCdaMode({ offersCda: beforeOffers }).mode !== resolveCdaMode({ offersCda: input.next.offersCda }).mode
  const firstAnswer = beforeOffers === null
  const reason = String(input.reason ?? "").trim()
  if (modeChanged && (!firstAnswer || input.openDeals > 0) && reason.length < CDA_CHANGE_REASON_MIN) {
    return { ok: false, error: "reason_required", message: "Say in a few words why your CDA policy is changing. The reason is saved with the change. Deals already in progress keep the policy they opened under." }
  }
  return { ok: true, changed, modeChanged, firstAnswer, reason: reason || (firstAnswer ? "first answer to the CDA policy question" : modeChanged ? "CDA policy changed" : "no-CDA payout default updated") }
}

/** PURE — may a finance admin switch ONE deal to (or away from) a CDA? A closed deal never changes; a signed CDA is never dropped here. */
export function decideDealCdaSwitch(input: {
  effective: Pick<EffectiveCdaMode, "mode">
  target: "cda" | "no_cda"
  dealStatus: string | null | undefined
  cdaRow: { status?: string | null; broker_approved_at?: string | null; sent_to_title_at?: string | null; uses_cda?: boolean | null } | null
  reason: string | null | undefined
}): { ok: true } | { ok: false; error: string; message: string } {
  const status = String(input.dealStatus ?? "").toLowerCase()
  if (["closed", "funded", "lost", "archived"].includes(status)) {
    return { ok: false, error: "deal_completed", message: "This deal is no longer in progress. A completed deal keeps the closing it had — a CDA is never added (or removed) afterward." }
  }
  if (input.target !== "cda" && input.target !== "no_cda") return { ok: false, error: "mode_invalid", message: "Choose CDA or no CDA for this deal." }
  if (input.effective.mode === input.target) {
    return { ok: false, error: "already_in_mode", message: input.target === "cda" ? "This deal already uses a CDA." : "This deal already closes without a CDA." }
  }
  if (String(input.reason ?? "").trim().length < CDA_CHANGE_REASON_MIN) {
    return { ok: false, error: "reason_required", message: "Say in a few words why this deal's CDA treatment is changing. The reason is saved with the change." }
  }
  const row = input.cdaRow
  if (input.target === "no_cda" && row && row.uses_cda !== false && (String(row.status ?? "").toLowerCase() === "approved" || !!row.broker_approved_at || !!row.sent_to_title_at)) {
    return { ok: false, error: "cda_already_authorized", message: "This deal's CDA is already approved, signed or with the title company, so it stays the payout authorization. To stop using it, cancel it in the deal's CDA workflow first." }
  }
  return { ok: true }
}

/** The client shape the one reader needs — the caller's own (session or service, after its gate). Any supabase-js client fits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the supabase-js query builder (its `from` is an overloaded generic)
type PolicyReadClient = { from: (...args: any[]) => any }

/**
 * THE ONE READER of the effective CDA policy (I/O through the caller's client; the tenant is the caller's verified brokerage). Reads the
 * brokerage setting (unless the caller already read it — `live`), the cda_policy history, and each deal's opening time + switch.
 * FAIL CLOSED: any refused read returns `{ ok: false }` with its reason — a caller never guesses a mode. A deal outside this brokerage
 * is absent from `deals` (the caller treats absence as unreadable).
 */
export async function loadEffectiveCdaModes(
  client: PolicyReadClient,
  input: { brokerageId: string; transactionIds?: ReadonlyArray<string>; live?: { offersCda: boolean | null | undefined; nonCdaPayoutDefault?: string | null } | null },
): Promise<
  | { ok: true; current: EffectiveCdaMode; deals: Record<string, EffectiveCdaMode & { status: string | null; openedAt: string | null }>; history: Array<{ version: number; value: CdaPolicyValue; previous: CdaPolicyValue; created_at: string | null; changed_by: string | null; reason: string | null }> }
  | { ok: false; error: string }
> {
  if (!input.brokerageId) return { ok: false, error: "no brokerage" }
  let live = input.live ?? null
  if (!live) {
    const { data: brk, error } = await client.from("brokerages").select("offers_cda, non_cda_payout_default").eq("id", input.brokerageId).maybeSingle()
    if (error) return { ok: false, error: `the brokerage's CDA setting could not be read (${error.message})` }
    if (!brk) return { ok: false, error: "brokerage not found" }
    live = { offersCda: (brk as { offers_cda?: boolean | null }).offers_cda ?? null, nonCdaPayoutDefault: (brk as { non_cda_payout_default?: string | null }).non_cda_payout_default ?? null }
  }
  const { data: versions, error: vErr } = await client
    .from("tenant_policy_versions")
    .select("version, value, previous, created_at, changed_by, reason")
    .eq("brokerage_id", input.brokerageId)
    .eq("policy_key", CDA_POLICY_KEY)
    .order("version", { ascending: true })
  if (vErr) return { ok: false, error: `the CDA policy history could not be read (${vErr.message})` }
  const rawHistory = (versions ?? []) as Array<{ version: number; value: unknown; previous: unknown; created_at: string | null; changed_by: string | null; reason: string | null }>
  const current = resolveEffectiveCdaMode({ live, history: rawHistory })
  const deals: Record<string, EffectiveCdaMode & { status: string | null; openedAt: string | null }> = {}
  const ids = Array.from(new Set((input.transactionIds ?? []).filter((id) => typeof id === "string" && id)))
  if (ids.length) {
    const [txRes, cdaRes] = await Promise.all([
      client.from("transactions").select("id, created_at, status").eq("brokerage_id", input.brokerageId).in("id", ids),
      client.from("closing_disclosure_agreement").select("transaction_id, field_values").eq("brokerage_id", input.brokerageId).in("transaction_id", ids),
    ])
    if (txRes.error) return { ok: false, error: `the deal could not be read (${txRes.error.message})` }
    if (cdaRes.error) return { ok: false, error: `the deal's CDA record could not be read (${cdaRes.error.message})` }
    const switchByTx = new Map<string, unknown>()
    for (const r of (cdaRes.data ?? []) as Array<{ transaction_id: string; field_values: unknown }>) if (readDealCdaSwitch(r.field_values)) switchByTx.set(r.transaction_id, r.field_values)
    for (const t of (txRes.data ?? []) as Array<{ id: string; created_at: string | null; status: string | null }>) {
      deals[t.id] = { ...resolveEffectiveCdaMode({ live, history: rawHistory, deal: { openedAt: t.created_at }, dealSwitch: switchByTx.get(t.id) }), status: t.status ?? null, openedAt: t.created_at ?? null }
    }
  }
  const history = historySteps(rawHistory).map((s) => {
    const r = rawHistory.find((x) => x.version === s.version)
    return { version: s.version, value: s.value, previous: s.previous, created_at: s.created_at, changed_by: r?.changed_by ?? null, reason: r?.reason ?? null }
  })
  return { ok: true, current, deals, history }
}

// ─── 2. THE PRELIMINARY STATEMENT (HUD / ALTA / CD) — versions, comparison, review state ──────────

/**
 * The two doc_type spellings the live rows carry for the title company's preliminary statement:
 * app/actions/cda-portal.ts writes `preliminary_closing_disclosure`; the title portal
 * (app/portal/title/[transactionId]/document-upload.tsx "Preliminary HUD/ALTA") writes
 * `settlement_statement`. One artifact, two spellings (CLAUDE.md §6) — read as ONE family here;
 * the DB value is not renamed this wave (no column/data rename — reported in the lane notes).
 */
export const PRELIMINARY_STATEMENT_DOC_TYPES = ["preliminary_closing_disclosure", "settlement_statement"] as const

function isPreliminaryStatementDocType(docType: string | null | undefined): boolean {
  return !!docType && (PRELIMINARY_STATEMENT_DOC_TYPES as readonly string[]).includes(docType)
}

/** PURE — the version number the NEXT statement upload takes: one more than the statements on file. */
export function nextPreliminaryStatementVersion(existing: ReadonlyArray<{ doc_type?: string | null }>): number {
  return existing.filter((d) => isPreliminaryStatementDocType(d.doc_type)).length + 1
}

/** The figures a statement and the waterfall can both state. Null/undefined = not stated. */
export interface StatementFigures {
  sales_price?: number | null
  gross_commission?: number | null
  agent_net?: number | null
  brokerage_net?: number | null
  seller_credits?: number | null
  closing_costs?: number | null
}

const COMPARABLE_FIELDS = ["sales_price", "gross_commission", "agent_net", "brokerage_net", "seller_credits", "closing_costs"] as const
type ComparableField = (typeof COMPARABLE_FIELDS)[number]

export interface PreliminaryDiscrepancy {
  field: ComparableField
  statement: number
  expected: number
  /** statement − expected, in dollars. */
  delta: number
  deltaPct: number
  severity: "warning" | "blocker"
}

/**
 * PURE — IDENTIFY discrepancies between the title company's statement and the executed contract +
 * waterfall. Compares ONLY the fields both sides state; a figure either side lacks is listed as
 * `unverifiable`, never fabricated as $0. Thresholds mirror lib/commission/cda-discrepancy.ts
 * (≥ $50 and ≥ 1% is a discrepancy; ≥ 5% is a blocker).
 */
export function comparePreliminaryStatementFigures(
  statement: StatementFigures,
  expected: StatementFigures,
  opts?: { minDollar?: number; tolerancePct?: number; blockerPct?: number },
): { discrepancies: PreliminaryDiscrepancy[]; compared: ComparableField[]; unverifiable: ComparableField[] } {
  const minDollar = opts?.minDollar ?? 50
  const tolerancePct = opts?.tolerancePct ?? 1
  const blockerPct = opts?.blockerPct ?? 5
  const discrepancies: PreliminaryDiscrepancy[] = []
  const compared: ComparableField[] = []
  const unverifiable: ComparableField[] = []
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
  for (const field of COMPARABLE_FIELDS) {
    const s = statement?.[field]
    const e = expected?.[field]
    if (!finite(s) || !finite(e)) { unverifiable.push(field); continue }
    compared.push(field)
    const diff = Math.abs(s - e)
    if (diff < minDollar) continue
    const deltaPct = e === 0 ? 100 : Math.round((diff / Math.abs(e)) * 1000) / 10
    if (deltaPct < tolerancePct) continue
    discrepancies.push({ field, statement: Math.round(s), expected: Math.round(e), delta: Math.round(s - e), deltaPct, severity: deltaPct >= blockerPct ? "blocker" : "warning" })
  }
  return { discrepancies, compared, unverifiable }
}

/** PURE — a plain-language line per discrepancy (what to say to title). Numbers only; nothing invented. */
export function describePreliminaryDiscrepancies(items: ReadonlyArray<PreliminaryDiscrepancy>): string[] {
  const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US")}`
  return items.map((d) =>
    `${d.field.replace(/_/g, " ")}: the statement shows ${money(d.statement)}; the executed contract / waterfall expects ${money(d.expected)} (${d.delta >= 0 ? "+" : "−"}${money(d.delta)}, ${d.deltaPct}%${d.severity === "blocker" ? " — must be corrected before approval" : ""}).`,
  )
}

export type PreliminaryReviewStatus = "pending_review" | "correction_requested" | "reviewed"

/** The review state the CDA row carries in field_values.preliminary_statement (one spelling). */
export interface PreliminaryStatementReview {
  status: PreliminaryReviewStatus
  /** The statement version under review (1 = the first upload). */
  version: number
  document_id: string | null
  received_at: string | null
  /** The discrepancies documented at the last correction request (empty when none). */
  items: PreliminaryDiscrepancy[]
  requested_at: string | null
  requested_by: string | null
  /** How the correction request reached title (recorded, never assumed). */
  delivery: { route: "portal" | "email" | "none"; recipient: string | null; message_id: string | null; at: string } | null
  reviewed_at: string | null
  reviewed_by: string | null
  note: string | null
  /** Every prior version's terminal state, oldest first — a corrected statement never erases its history. */
  history: Array<{ version: number; document_id: string | null; status: PreliminaryReviewStatus; at: string }>
}

/** PURE — a (revised) statement arrived: a new version opens for review; the prior version is retained in history. */
export function reviewOnNewStatementVersion(
  prior: PreliminaryStatementReview | null | undefined,
  next: { version: number; documentId: string | null; at: string },
): PreliminaryStatementReview {
  const history = [...(prior?.history ?? [])]
  if (prior && prior.version !== next.version) {
    history.push({ version: prior.version, document_id: prior.document_id, status: prior.status, at: next.at })
  }
  return {
    status: "pending_review",
    version: next.version,
    document_id: next.documentId,
    received_at: next.at,
    items: [],
    requested_at: null,
    requested_by: null,
    delivery: null,
    reviewed_at: null,
    reviewed_by: null,
    note: null,
    history,
  }
}

/** PURE — the agent / TC documented discrepancies and asked title for a corrected statement. */
export function reviewOnCorrectionRequested(
  prior: PreliminaryStatementReview,
  req: { items: PreliminaryDiscrepancy[]; by: string; at: string; delivery: PreliminaryStatementReview["delivery"]; note?: string | null },
): PreliminaryStatementReview {
  return { ...prior, status: "correction_requested", items: req.items, requested_at: req.at, requested_by: req.by, delivery: req.delivery, note: req.note ?? prior.note }
}

/** PURE — the figures were reconciled against the executed contract + waterfall; the version is reviewed. */
export function reviewOnConfirmed(prior: PreliminaryStatementReview, by: string, at: string, note?: string | null): PreliminaryStatementReview {
  return { ...prior, status: "reviewed", reviewed_at: at, reviewed_by: by, note: note ?? prior.note }
}

/** PURE — THE APPROVAL GATE on the figures: a correction is outstanding → the broker cannot approve. */
export function cdaFigureGate(review: PreliminaryStatementReview | null | undefined): { ok: boolean; error?: "preliminary_statement_correction_pending" } {
  if (review && review.status === "correction_requested") return { ok: false, error: "preliminary_statement_correction_pending" }
  return { ok: true }
}

/** PURE — read the review object off a CDA's field_values (any shape; absent → null). */
export function preliminaryReviewOf(fieldValues: Record<string, unknown> | null | undefined): PreliminaryStatementReview | null {
  const v = fieldValues?.preliminary_statement
  if (!v || typeof v !== "object") return null
  const r = v as Partial<PreliminaryStatementReview>
  if (r.status !== "pending_review" && r.status !== "correction_requested" && r.status !== "reviewed") return null
  return {
    status: r.status,
    version: typeof r.version === "number" ? r.version : 1,
    document_id: r.document_id ?? null,
    received_at: r.received_at ?? null,
    items: Array.isArray(r.items) ? (r.items as PreliminaryDiscrepancy[]) : [],
    requested_at: r.requested_at ?? null,
    requested_by: r.requested_by ?? null,
    delivery: r.delivery ?? null,
    reviewed_at: r.reviewed_at ?? null,
    reviewed_by: r.reviewed_by ?? null,
    note: r.note ?? null,
    history: Array.isArray(r.history) ? (r.history as PreliminaryStatementReview["history"]) : [],
  }
}

// ─── 3. THE DEADLINE — signed approved CDA at title before/at the scheduled closing (tenant zone) ──

/** Reminders fire at these hours-before-deadline; escalation at CDA_DEADLINE_ESCALATE_HOURS or less. */
export const CDA_DEADLINE_REMINDER_HOURS = [48, 24] as const
export const CDA_DEADLINE_ESCALATE_HOURS = 12
/** A date-only closing date means "at the closing table" — the deadline is this local hour that day. */
export const CLOSING_DAY_DEADLINE_LOCAL_HOUR = 9
export const TIME_ZONE_FALLBACK = "UTC"

/**
 * PURE — the tenant's zone. brokerages carries no timezone column at HEAD (measured:
 * scripts/schema-snapshot.ts — timezone lives on calendar_events / contacts / global_settings /
 * open_house_events only), so the zone derives from the brokerage's STATE through the one existing
 * state→zone table (lib/fatigue/after-hours.ts timeZoneForState); unknown → UTC, SAID in `source`.
 */
export function resolveTenantTimeZone(input: { state?: string | null; explicitZone?: string | null }): { zone: string; source: "explicit" | "brokerage_state" | "fallback" } {
  if (input.explicitZone && isUsableZone(input.explicitZone)) return { zone: input.explicitZone, source: "explicit" }
  const byState = timeZoneForState(input.state)
  if (byState) return { zone: byState, source: "brokerage_state" }
  return { zone: TIME_ZONE_FALLBACK, source: "fallback" }
}

function isUsableZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true } catch { return false }
}

function localPartsAt(instantMs: number, zone: string): { y: number; m: number; d: number; h: number; min: number } | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    const parts: Record<string, string> = {}
    for (const p of f.formatToParts(new Date(instantMs))) parts[p.type] = p.value
    const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day), h = Number(parts.hour), min = Number(parts.minute)
    if (![y, m, d, h, min].every(Number.isFinite)) return null
    return { y, m, d, h: h === 24 ? 0 : h, min }
  } catch {
    return null
  }
}

/** The UTC instant at which the wall clock in `zone` reads y-m-d h:00 (two passes absorb a DST edge). */
function zonedInstant(y: number, m: number, d: number, h: number, zone: string): number | null {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0)
  const lp = localPartsAt(guess, zone)
  if (!lp) return null
  const offset = Date.UTC(lp.y, lp.m - 1, lp.d, lp.h, lp.min) - guess
  let result = guess - offset
  const lp2 = localPartsAt(result, zone)
  if (lp2) {
    const offset2 = Date.UTC(lp2.y, lp2.m - 1, lp2.d, lp2.h, lp2.min) - result
    if (offset2 !== offset) result = guess - offset2
  }
  return result
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * PURE — WHEN the signed approved CDA must be at title. The title company's scheduled closing wins,
 * then the transaction's close date, then its estimate. A DATE-ONLY value is read as the closing day
 * at CLOSING_DAY_DEADLINE_LOCAL_HOUR in the tenant's zone (the table opens in the morning; a CDA that
 * arrives that afternoon is late); a full timestamp is taken as given. An EARLIER brokerage / title
 * requirement (hours before closing) wins by subtraction. No source → no deadline, said.
 *
 * AN EARLIER ANTICIPATED CLOSING (wave 149, lane 149G — owner ruling 17 / C33): under "on or before" the deal may close
 * BEFORE the contract's date, and a proposed earlier day moves only `estimated_close_date` (lib/transactions/closing-dates.ts
 * — the contract's `close_date` is never overwritten by a proposal). Without a title appointment, the EARLIER of the two
 * therefore governs — the CDA must be at the table for the day the deal may actually close; a LATER estimate never pushes
 * the deadline past the contract's day (that needs an executed extension, which moves close_date itself).
 */
export function resolveClosingDeadline(input: {
  closingScheduledDate?: string | null
  closeDate?: string | null
  estimatedCloseDate?: string | null
  timeZone: string
  earlierCutoffHours?: number | null
}): { dueAt: string | null; basis: "closing_scheduled_date" | "close_date" | "estimated_close_date" | "none"; dateOnly: boolean } {
  const read = (raw: string | null | undefined): { ms: number; dateOnly: boolean } | null => {
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) return null
    if (DATE_ONLY_RE.test(value)) {
      const [y, m, d] = value.split("-").map(Number)
      const ms = zonedInstant(y, m, d, CLOSING_DAY_DEADLINE_LOCAL_HOUR, input.timeZone)
      return ms == null ? null : { ms, dateOnly: true }
    }
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : { ms: parsed, dateOnly: false }
  }
  const cutoff = typeof input.earlierCutoffHours === "number" && Number.isFinite(input.earlierCutoffHours) && input.earlierCutoffHours > 0 ? input.earlierCutoffHours : 0
  const out = (basis: "closing_scheduled_date" | "close_date" | "estimated_close_date", v: { ms: number; dateOnly: boolean }) =>
    ({ dueAt: new Date(v.ms - cutoff * 3_600_000).toISOString(), basis, dateOnly: v.dateOnly })
  const scheduled = read(input.closingScheduledDate)
  if (scheduled) return out("closing_scheduled_date", scheduled)
  const close = read(input.closeDate), estimate = read(input.estimatedCloseDate)
  if (close && estimate && estimate.ms < close.ms) return out("estimated_close_date", estimate)
  if (close) return out("close_date", close)
  if (estimate) return out("estimated_close_date", estimate)
  return { dueAt: null, basis: "none", dateOnly: false }
}

export type CdaDeadlineState = "not_applicable" | "delivered" | "no_deadline" | "ok" | "reminder_48h" | "reminder_24h" | "escalate" | "overdue"

/** The notification type each actionable state writes (idempotent per CDA + type); null = nothing to send. */
export const CDA_DEADLINE_NOTIFICATION: Record<CdaDeadlineState, string | null> = {
  not_applicable: null,
  delivered: null,
  no_deadline: null,
  ok: null,
  reminder_48h: "cda_deadline_48h",
  reminder_24h: "cda_deadline_24h",
  escalate: "cda_deadline_escalated",
  overdue: "cda_deadline_overdue",
}

/** PURE — where an open CDA stands against its deadline. */
export function cdaDeadlineVerdict(input: {
  dueAt: string | null
  now: Date
  sentToTitleAt?: string | null
  status?: string | null
  usesCda?: boolean | null
}): { state: CdaDeadlineState; hoursRemaining: number | null; escalates: boolean } {
  const status = (input.status ?? "").toLowerCase()
  if (input.usesCda === false || status === "cancelled" || status === "rejected") return { state: "not_applicable", hoursRemaining: null, escalates: false }
  if (input.sentToTitleAt) return { state: "delivered", hoursRemaining: null, escalates: false }
  if (!input.dueAt) return { state: "no_deadline", hoursRemaining: null, escalates: false }
  const due = Date.parse(input.dueAt)
  if (Number.isNaN(due)) return { state: "no_deadline", hoursRemaining: null, escalates: false }
  const hours = Math.round(((due - input.now.getTime()) / 3_600_000) * 10) / 10
  if (hours < 0) return { state: "overdue", hoursRemaining: hours, escalates: true }
  if (hours <= CDA_DEADLINE_ESCALATE_HOURS) return { state: "escalate", hoursRemaining: hours, escalates: true }
  if (hours <= CDA_DEADLINE_REMINDER_HOURS[1]) return { state: "reminder_24h", hoursRemaining: hours, escalates: false }
  if (hours <= CDA_DEADLINE_REMINDER_HOURS[0]) return { state: "reminder_48h", hoursRemaining: hours, escalates: false }
  return { state: "ok", hoursRemaining: hours, escalates: false }
}

// ─── 4. DELIVERY — the portal inbox when title is on the deal team, else the configured email ──────

/**
 * PURE — how the signed CDA (or a correction request) reaches title. "Title on the Deal Team" is a
 * title_company_users row for THIS transaction with a users account (the title portal's identity —
 * lib/kernel/portal-auth.ts requireTitleActor; deal_team_members holds no title rows at HEAD, see the
 * tombstone in lib/transactions/role-guard.ts). Outside → the verified title email through the existing
 * outbound email integration. A requested route the facts cannot honour is refused by name.
 */
export function cdaDeliveryRoute(input: {
  titlePortalUserId?: string | null
  titleEmail?: string | null
  requested?: "portal" | "email" | null
}): { route: "portal" | "email" | "none"; reason: string } {
  const hasPortal = !!input.titlePortalUserId
  const email = (input.titleEmail ?? "").trim()
  const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  if (input.requested === "portal") return hasPortal ? { route: "portal", reason: "title_on_deal_team" } : { route: "none", reason: "title_not_on_deal_team" }
  if (input.requested === "email") return hasEmail ? { route: "email", reason: "verified_title_email" } : { route: "none", reason: "title_email_missing_or_invalid" }
  if (hasPortal) return { route: "portal", reason: "title_on_deal_team" }
  if (hasEmail) return { route: "email", reason: "verified_title_email" }
  return { route: "none", reason: "no_title_recipient" }
}

/** PURE — a delivery already recorded is never repeated on retry; an explicit re-send needs a reason. */
export function deliveryIdempotency(input: {
  sentToTitleAt?: string | null
  sentRecipient?: string | null
  recipient: string
  resend?: boolean
  resendReason?: string | null
}): { ok: boolean; error?: "already_delivered"; resend: boolean } {
  if (!input.sentToTitleAt) return { ok: true, resend: false }
  if (input.resend === true && (input.resendReason ?? "").trim().length >= 5) return { ok: true, resend: true }
  return { ok: false, error: "already_delivered", resend: false }
}

// ─── 5. CLOSING WITHOUT A CDA — THE SMALLEST HONEST CLOSING PROOF (wave 151, lane 151K) ──────────────────────────────────────
//
// Owner (wave 151, binding): "L6 finish — if the brokerage doesn't use CDAs (their settings), then it can close without a CDA."
// Directive: "the smallest honest closing proof: final settlement/closing record plus authorized brokerage receipt/attestation and
// transaction compliance status, with the actual source actor and payment evidence. Do not force artificial CDA, pre-fill an agent
// form via AI, bypass approved disbursement or assert funds received solely because a Closing date exists. Keep CLOSED / PAYOUT
// PENDING and existing once-only payment holds intact."
//
// This is a READING of evidence that already exists on the survivors — it writes nothing and gates nothing:
//   · the final settlement / closing record: the title company's final statement on the document kernel
//     (closing_disclosure_agreement.final_cd_document_id / documents classified closing_disclosure — the same documents
//     lib/transactions/closing-compliance.ts loadSettlement compares) with who uploaded it;
//   · the authorized brokerage receipt: agent_commissions.deposit_received_at / deposit_received_by (lib/commission/
//     reconcile-tracking.ts recordCommissionDepositReceived — a finance admin's act) and the payment states the ledger derives
//     (lib/commission/ledger-sync.ts deriveCommissionPaymentState); NEVER status 'closed' or a closing date;
//   · the transaction compliance status: compliance_passed_at + the open blocking compliance rows;
//   · the payout holds as they stand: the funds-received gate (payoutFundsGate) and the lifetime hold (CLOSED / PAYOUT PENDING).
// `fundsReceived` is derived from the receipt evidence ALONE: a closed deal with a closing date and no recorded receipt reads
// "not received". A CDA row the no-CDA path created for the payout PREFERENCE (uses_cda false) is not a CDA and is never required.

export const NO_CDA_CLOSING_PROOF_RULE = {
  /** A CDA is never an unconditional closing requirement (resolveCdaMode.blocksClosing is `false` in both modes). */
  cdaNeverRequiredToClose: true,
  /** Funds are received when, and only when, a person recorded the brokerage's receipt — never because a closing date exists. */
  fundsReceivedOnlyFromReceiptEvidence: true,
  /** Nothing here fills a CDA, creates one, or releases a payout; the holds (payoutFundsGate, CLOSED / PAYOUT PENDING) stand. */
  writesNothing: true,
} as const

export interface NoCdaClosingProofInput {
  cdaMode: CdaModeVerdict
  transaction: { status: string | null | undefined; close_date?: string | null; actual_close_date?: string | null; compliance_passed_at?: string | null }
  /** The title company's final settlement / closing record on file, with the actor who put it there (null = none yet). */
  finalSettlement: { documentId: string; uploadedAt: string | null; uploadedBy: string | null; uploadedByType: string | null } | null
  /** The brokerage's receipt of the commission, as the ledger recorded it (one row per agent commission on the deal). */
  commissions: Array<{ id: string; status: string | null; deposit_received_at?: string | null; deposit_received_by?: string | null; paid_at?: string | null; payment_received_at?: string | null; reconciled_at?: string | null; payment_initiated_at?: string | null }>
  /** Open BLOCKING compliance rows (fail / pending / needs_review) on the deal. */
  openBlockingCompliance: number
  /** The lifetime hold activity ("CLOSED / PAYOUT PENDING") is open on the deal. */
  lifetimeHoldOpen: boolean
}

export interface NoCdaClosingProof {
  mode: "cda" | "no_cda"
  /** Never true: the proof is informational; it never blocks a close (the owner's ruling). */
  blocksClosing: false
  closed: boolean
  settlement: { status: "on_file" | "missing"; documentId: string | null; actor: string | null; at: string | null }
  receipt: { status: "recorded" | "not_recorded" | "no_commission_row"; by: string | null; at: string | null; basis: string }
  /** Derived from the receipt evidence ALONE (NO_CDA_CLOSING_PROOF_RULE). */
  fundsReceived: boolean
  compliance: { status: "passed" | "open_blocking" | "not_passed"; passedAt: string | null; openBlocking: number }
  payout: { state: "no_commission_row" | "held_funds_not_received" | "releasable_after_receipt" | "initiated" | "recorded" | "received" | "reconciled"; lifetimeHold: "open" | "none"; detail: string }
  /** What the proof still lacks, in words a TC or finance admin acts on. Empty = the smallest honest proof is complete. */
  missing: string[]
}

/** PURE — the no-CDA closing proof over the evidence that exists. In CDA mode it says so and reads the same facts (nothing is forced). */
export function noCdaClosingProof(input: NoCdaClosingProofInput): NoCdaClosingProof {
  const status = String(input.transaction.status ?? "").toLowerCase()
  const closed = status === "closed" || status === "funded"
  const missing: string[] = []
  const settlement: NoCdaClosingProof["settlement"] = input.finalSettlement
    ? { status: "on_file", documentId: input.finalSettlement.documentId, actor: input.finalSettlement.uploadedBy ? `${input.finalSettlement.uploadedByType ?? "user"}:${input.finalSettlement.uploadedBy}` : null, at: input.finalSettlement.uploadedAt }
    : { status: "missing", documentId: null, actor: null, at: null }
  if (settlement.status === "missing") missing.push("the title company's final settlement / closing record is not on file")

  const rows = input.commissions
  let receipt: NoCdaClosingProof["receipt"]
  if (rows.length === 0) receipt = { status: "no_commission_row", by: null, at: null, basis: "no agent commission is on the ledger for this deal yet" }
  else {
    const received = rows.filter((r) => !!r.deposit_received_at)
    if (received.length === rows.length) {
      const latest = [...received].sort((a, b) => String(a.deposit_received_at).localeCompare(String(b.deposit_received_at))).pop()!
      receipt = { status: "recorded", by: latest.deposit_received_by ?? null, at: latest.deposit_received_at ?? null, basis: "agent_commissions.deposit_received_at — recorded by a person (recordCommissionDepositReceived)" }
    } else receipt = { status: "not_recorded", by: null, at: null, basis: received.length ? `${received.length} of ${rows.length} commission rows carry a recorded receipt` : "no commission row carries deposit_received_at" }
  }
  const fundsReceived = receipt.status === "recorded"
  if (!fundsReceived) missing.push(receipt.status === "no_commission_row" ? "no commission row to receive against" : "the brokerage's receipt of the commission is not recorded (a finance admin records the deposit — a closing date is not a receipt)")

  const compliance: NoCdaClosingProof["compliance"] = input.openBlockingCompliance > 0
    ? { status: "open_blocking", passedAt: input.transaction.compliance_passed_at ?? null, openBlocking: input.openBlockingCompliance }
    : input.transaction.compliance_passed_at ? { status: "passed", passedAt: input.transaction.compliance_passed_at, openBlocking: 0 } : { status: "not_passed", passedAt: null, openBlocking: 0 }
  if (compliance.status !== "passed") missing.push(compliance.status === "open_blocking" ? `${input.openBlockingCompliance} blocking compliance item(s) are open` : "transaction compliance has not passed")

  let payoutState: NoCdaClosingProof["payout"]["state"] = "no_commission_row"
  if (rows.length > 0) {
    const any = (k: keyof NoCdaClosingProofInput["commissions"][number]) => rows.some((r) => !!r[k])
    if (any("reconciled_at")) payoutState = "reconciled"
    else if (any("payment_received_at")) payoutState = "received"
    else if (rows.some((r) => r.status === "paid" || !!r.paid_at)) payoutState = "recorded"
    else if (any("payment_initiated_at")) payoutState = "initiated"
    else payoutState = fundsReceived ? "releasable_after_receipt" : "held_funds_not_received"
  }
  const payout: NoCdaClosingProof["payout"] = {
    state: payoutState,
    lifetimeHold: input.lifetimeHoldOpen ? "open" : "none",
    detail: payoutState === "held_funds_not_received"
      ? "the funds-received gate holds the payout until the brokerage's receipt is recorded (an advance needs a finance admin's stated reason)"
      : payoutState === "releasable_after_receipt" ? "receipt recorded — the payout may be initiated under the brokerage's approved disbursement" : payoutState === "no_commission_row" ? "nothing to pay out yet" : `payout ${payoutState}`,
  }
  return {
    mode: input.cdaMode.mode, blocksClosing: false, closed, settlement, receipt, fundsReceived, compliance, payout,
    missing: input.cdaMode.mode === "cda" ? ["this brokerage uses a CDA — the CDA workflow is the closing proof; this reading is informational"] : missing,
  }
}

// ─── 6. CONTRACT-TO-SETTLEMENT RECONCILIATION — THE FINAL CLOSING DISCLOSURE / SETTLEMENT STATEMENT (wave 152, lane 152G) ─────────
//
// Owner (verbatim, 2026-11-11): "anytime there is a change at closing to transaction, the final closing desclosure has to be correct.
// evn though the brokerage doesnt support a cda, compliance still needs to accurate along with the closing disclosure. that is not
// informational." OWNER RULING THIS IMPLIES: at the gated close the settlement / CD accuracy is BLOCKING in both CDA modes (the CDA is
// still never a closing requirement — resolveCdaMode.blocksClosing stays false; what blocks is the RECORD being wrong).
//
// This is the PURE rule. The I/O (lib/offers/closing-cost-accuracy.ts reconcileClosingSettlement) reads the 152E comparison
// (lib/transactions/closing-compliance-core.ts — the executed terms vs the latest statement, per term), the latest statement's
// issuer figures and the TRID facts, and hands them here. LAWFUL RESPONSIBILITY, as data: for a TRID-covered loan the LENDER
// (creditor) issues the borrower's Closing Disclosure (a settlement agent may deliver it); the seller's statement follows the settlement
// arrangement; a cash / non-TRID closing is reconciled against the settlement statement (ALTA / HUD-1 / attorney's closing statement)
// — never a manufactured borrower CD. Nothing here edits, issues or "balances" an official document: an item that is not computable
// from the evidence is UNRESOLVED and names who must supply the authoritative value. APR is never reconstructed — two lender-stated
// APRs are compared, nothing more.
//
// SOURCES the TRID branch follows (the CFPB pages the directive names — 12 CFR 1026.19(f)(2), 1026.22(a), 1026.38 and the TILA-RESPA
// FAQ): a corrected CD restarts the three-business-day waiting period ONLY when the APR becomes inaccurate under 1026.22 (beyond 1/8
// of a percentage point for a regular transaction, 1/4 for an irregular one), the loan product changes, or a prepayment penalty is
// added (1026.19(f)(2)(ii)); any other change before consummation is a corrected CD at or before consummation with no new wait
// (1026.19(f)(2)(i)). An overstated (decreased) APR can still be accurate (1026.22(a)(4)) — that is the LENDER's call, so it is
// escalated, never decided here. State title / closing-attorney rules are NOT modelled: they resolve through the deal's state closing
// policy, and an uncertain case is escalated to the responsible licensed professional.

/** How each reconciled item is known — the directive's three bases, ONE spelling. */
const SETTLEMENT_ITEM_BASES = ["exact", "extracted_estimate", "authoritative_required"] as const
type SettlementItemBasis = (typeof SETTLEMENT_ITEM_BASES)[number]

/** Where the closing stands — the four states the tenant sees, ONE spelling (CLAUDE.md §6). */
export const SETTLEMENT_READINESS_STATES = ["ready", "needs_review", "awaiting_revised_document", "compliance_blocked"] as const
type SettlementReadiness = (typeof SETTLEMENT_READINESS_STATES)[number]

export const SETTLEMENT_READINESS_LABEL: Record<SettlementReadiness, string> = {
  ready: "Ready",
  needs_review: "Needs review",
  awaiting_revised_document: "Awaiting a revised closing document",
  compliance_blocked: "Compliance blocked",
}

/** Who corrects an item — the ACTUAL responsible party, never the agent for an official document. */
type SettlementParty = "lender" | "settlement_agent" | "transaction_coordinator" | "licensed_professional" | "brokerage_finance"

const PARTY_WORDS: Record<SettlementParty, string> = {
  lender: "the lender (it issues the borrower's Closing Disclosure)",
  settlement_agent: "the title company / settlement agent or closing attorney (it issues the settlement statement)",
  transaction_coordinator: "the transaction coordinator",
  licensed_professional: "the responsible licensed professional or closing attorney",
  brokerage_finance: "the brokerage's finance admin",
}

/**
 * THE ITEM CATALOG — which items VIPAgents can calculate EXACTLY from the governing executed terms, which are EXTRACTED ESTIMATES,
 * and which only the title company / lender can state (AUTHORITATIVE). Every reconciled item carries its basis from here; items with
 * `evaluated: false` are listed so the boundary is published, never implied.
 */
export const SETTLEMENT_ITEM_CATALOG: ReadonlyArray<{ key: string; label: string; basis: SettlementItemBasis; evaluated: boolean; note: string }> = [
  { key: "purchase_price", label: "Purchase price", basis: "exact", evaluated: true, note: "the governing executed instrument states it" },
  { key: "earnest_money", label: "Earnest money / deposit", basis: "exact", evaluated: true, note: "the governing executed instrument states it" },
  { key: "seller_credit", label: "Seller credit to buyer", basis: "exact", evaluated: true, note: "executed contract / addendum" },
  { key: "agent_credit", label: "Agent credit to buyer", basis: "exact", evaluated: true, note: "broker-approved concession" },
  { key: "agent_credit_seller", label: "Agent credit to seller", basis: "exact", evaluated: true, note: "broker-approved concession" },
  { key: "client_fees", label: "Client-agreement fees", basis: "exact", evaluated: true, note: "verified client-agreement fee record" },
  { key: "owner_title_policy_payer", label: "Who pays the owner's title policy", basis: "exact", evaluated: true, note: "executed contract / counter" },
  { key: "commission", label: "Commission lines", basis: "exact", evaluated: true, note: "governing terms × governing price (staff view only)" },
  { key: "closing_date", label: "Closing date", basis: "exact", evaluated: true, note: "contractual date and wording" },
  { key: "cash_to_close", label: "Cash to close / due from borrower", basis: "authoritative_required", evaluated: true, note: "the issuer's figure — never computed here" },
  { key: "loan_amount", label: "Loan amount", basis: "authoritative_required", evaluated: true, note: "the lender's figure governs the deal record" },
  { key: "total_closing_costs", label: "Total closing costs", basis: "authoritative_required", evaluated: true, note: "the issuer's figure" },
  { key: "seller_proceeds", label: "Seller proceeds", basis: "authoritative_required", evaluated: true, note: "the settlement agent's figure" },
  { key: "loan_terms", label: "APR · loan product · prepayment penalty", basis: "authoritative_required", evaluated: true, note: "lender-stated; APR is never reconstructed" },
  { key: "prorations", label: "Tax / HOA prorations", basis: "extracted_estimate", evaluated: false, note: "estimated by the net sheet from the deal's convention; the statement's figure is authoritative" },
  { key: "title_settlement_fees", label: "Title / settlement / transfer / recording fees", basis: "extracted_estimate", evaluated: false, note: "regional estimate only (the closing-cost accuracy flywheel); the statement's figure is authoritative" },
  { key: "lender_charges", label: "Lender and loan-related charges", basis: "authoritative_required", evaluated: false, note: "only the lender states them" },
]

/** Money terms whose ABSENCE from the latest statement means the statement is incomplete (directive case 1: a signed credit missing). */
const MISSING_ON_STATEMENT_BLOCKS = new Set(["purchase_price", "earnest_money", "seller_credit", "agent_credit", "agent_credit_seller"])
/** Money terms (a difference holds the closing). Commission lines are money too — and never shown to an agent (CLAUDE.md §5). */
const MONEY_TERMS = new Set([...MISSING_ON_STATEMENT_BLOCKS, "seller_transaction_fee", "seller_admin_fee", "buyer_transaction_fee", "buyer_admin_fee", "owner_title_policy_payer", "commission_listing_side", "commission_buyer_side", "commission_total"])
const STAFF_ONLY_TERMS = new Set(["commission_listing_side", "commission_buyer_side", "commission_total"])
const BUYER_SIDE_TERMS = new Set(["agent_credit", "buyer_transaction_fee", "buyer_admin_fee"])
const SELLER_SIDE_TERMS = new Set(["agent_credit_seller", "seller_transaction_fee", "seller_admin_fee"])

type ItemStatus =
  | "agrees" | "differs" | "missing_on_document" | "not_stated_by_contract" | "unverified_reading"
  | "requires_interpretation" | "issuer_value" | "not_on_file" | "resolved_by_override" | "advisory"

interface SettlementItem {
  key: string
  label: string
  basis: SettlementItemBasis
  /** who may see it: a buyer-only / seller-only disclosure stays on its side; staff see both */
  side: "shared" | "buyer" | "seller"
  /** commission is off agent-facing display — the value is shown to brokerage staff only */
  staffOnly: boolean
  contractSays: string | null
  documentSays: string | null
  status: ItemStatus
  /** this item holds the closing */
  blocking: boolean
  /** the readiness bucket a blocking item lands in */
  bucket: SettlementReadiness | null
  responsible: string | null
  /** ONE action, in plain words */
  action: string | null
}

/** One term finding of the 152E comparison, as the reconciler consumes it (closing-compliance-core TermFinding, structurally). */
interface ReconTermFinding {
  term: string
  label: string
  verdict: "match" | "mismatch" | "unverifiable" | "conflict"
  classification: string
  governing: string | null
  settlement: string | null
  blocking: boolean
  against?: "settlement" | "deal_record"
}

type Figure = { value: number | string | boolean; confidence: string } | null

interface StatementIssuerFigures {
  cashToClose?: Figure
  loanAmount?: Figure
  totalClosingCosts?: Figure
  sellerProceeds?: Figure
  apr?: Figure
  loanProduct?: Figure
  prepaymentPenalty?: Figure
}

interface SettlementReconciliationInput {
  closing: { financing: "cash" | "financed" | null; tridTracked: boolean; closed: boolean; commissionFinalized: boolean }
  /** the 152E comparison of the executed terms against the latest statement (null = it did not run) */
  findings: ReadonlyArray<ReconTermFinding> | null
  /** OPEN blocking closing rows that are NOT a statement term (deal record drift, evidence holds, checklist, participants, faults) */
  otherOpenBlocking: string[]
  /** statement term rows an authorized reviewer WAIVED with a written reason (152E's override door) */
  waivedTerms: string[]
  /** the latest statement on file (documents rail), or null */
  statement: { documentId: string; classification: string; stage: "final" | "preliminary" | "unlabeled"; receivedAt: string | null; versions: number } | null
  figures: StatementIssuerFigures
  /** the previous Closing Disclosure version's figures, for the TRID re-wait comparison (null = no earlier CD) */
  priorCdFigures: StatementIssuerFigures | null
  dealRecord: { loanAmount: number | null }
  trid: { cdDeliveredDate: string | null } | null
  /** the brokerage's ONE switch (resolveCdaMode) and what the CDA workflow holds for the statement */
  cdaMode: "cda" | "no_cda"
  cdaRail: { finalAttached: boolean; preliminaryReviewed: boolean; correctionRequestedAt: string | null; correctionRoute: string | null }
  /** a statement uploaded on the transaction-documents rail (title portal / CDA page) that the platform never read */
  unreadStatementOnFile: boolean
  /** open corrective requests (transaction_tasks, compliance_correction) on the deal */
  openCorrectionTasks: number
  readFault: string | null
}

type TridRevisionPath = "not_applicable" | "initial_disclosure" | "new_waiting_period" | "corrected_cd_no_new_wait" | "escalate_to_lender"

interface TridRevisionAssessment {
  path: TridRevisionPath
  /** the triggers found (apr_inaccurate, loan_product_changed, prepayment_penalty_added) */
  triggers: string[]
  /** the revised CD's receipt starts a new wait and the delivery on file predates it */
  waitingPeriodOutstanding: boolean
  detail: string
}

export interface SettlementReconciliation {
  state: SettlementReadiness
  record: { kind: "trid_cd" | "settlement_statement" | "undetermined"; issuer: string; finalOnFile: boolean; documentId: string | null; stage: string | null; receivedAt: string | null; versions: number }
  items: SettlementItem[]
  trid: TridRevisionAssessment
  request: { status: "none" | "open_task" | "requested" | "revision_received"; requestedAt: string | null; route: string | null }
  /** plain lines a close gate shows (no commission amounts) */
  blockers: string[]
  fingerprint: string
}

const reconNum = (f: Figure | undefined): number | null => {
  if (!f) return null
  if (typeof f.value === "number") return Number.isFinite(f.value) ? f.value : null
  if (typeof f.value === "string") { const t = f.value.replace(/[$,%\s]/g, ""); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null }
  return null
}
const reconStr = (f: Figure | undefined): string | null => (f && (typeof f.value === "string" || typeof f.value === "number") ? String(f.value).trim() || null : null)
const reconBool = (f: Figure | undefined): boolean | null => {
  if (!f) return null
  if (typeof f.value === "boolean") return f.value
  const t = String(f.value).trim().toLowerCase()
  if (["yes", "true", "y"].includes(t)) return true
  if (["no", "false", "n", "none"].includes(t)) return false
  return null
}
const usdText = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** PURE — who issues the authoritative record for this closing. A financed deal with no TRID tracking is PRESUMED covered and says so. */
function closingRecordKind(input: { financing: "cash" | "financed" | null; tridTracked: boolean }): { kind: "trid_cd" | "settlement_statement" | "undetermined"; issuer: string; presumed: boolean } {
  if (input.tridTracked) return { kind: "trid_cd", issuer: PARTY_WORDS.lender, presumed: false }
  if (input.financing === "cash") return { kind: "settlement_statement", issuer: PARTY_WORDS.settlement_agent, presumed: false }
  if (input.financing === "financed") return { kind: "trid_cd", issuer: PARTY_WORDS.lender, presumed: true }
  return { kind: "undetermined", issuer: PARTY_WORDS.settlement_agent, presumed: true }
}

/**
 * PURE — does a revised Closing Disclosure restart the three-business-day wait? Compares LENDER-STATED values only. A trigger the
 * documents cannot show (a figure not stated on one of the two CDs) is escalated to the lender — never assumed either way.
 */
function tridRevisionAssessment(input: {
  kind: "trid_cd" | "settlement_statement" | "undetermined"
  prior: StatementIssuerFigures | null
  current: StatementIssuerFigures
  currentReceivedAt: string | null
  cdDeliveredDate: string | null
}): TridRevisionAssessment {
  if (input.kind !== "trid_cd") {
    return { path: "not_applicable", triggers: [], waitingPeriodOutstanding: false, detail: "Cash or non-TRID closing: the settlement statement is the record — no borrower Closing Disclosure and no TRID waiting period apply." }
  }
  if (!input.prior) {
    return { path: "initial_disclosure", triggers: [], waitingPeriodOutstanding: false, detail: "One Closing Disclosure is on file. The buyer must receive it at least three business days before closing (the closing gate checks the delivery date)." }
  }
  const triggers: string[] = []
  const unknowns: string[] = []
  const aprA = reconNum(input.prior.apr), aprB = reconNum(input.current.apr)
  let aprBand: "within" | "over" | "irregular_band" | "decrease_over" | null = null
  if (aprA == null || aprB == null) unknowns.push("the APR")
  else {
    const d = Math.round((aprB - aprA) * 1000) / 1000
    aprBand = Math.abs(d) <= 0.125 ? "within" : d < 0 ? "decrease_over" : d <= 0.25 ? "irregular_band" : "over"
    if (aprBand === "over") triggers.push("apr_inaccurate")
  }
  const prodA = reconStr(input.prior.loanProduct)?.toLowerCase() ?? null, prodB = reconStr(input.current.loanProduct)?.toLowerCase() ?? null
  if (prodA == null || prodB == null) unknowns.push("the loan product")
  else if (prodA !== prodB) triggers.push("loan_product_changed")
  const ppA = reconBool(input.prior.prepaymentPenalty), ppB = reconBool(input.current.prepaymentPenalty)
  if (ppA == null || ppB == null) unknowns.push("the prepayment penalty")
  else if (!ppA && ppB) triggers.push("prepayment_penalty_added")

  if (triggers.length > 0) {
    const received = input.currentReceivedAt ? input.currentReceivedAt.slice(0, 10) : null
    const outstanding = !input.cdDeliveredDate || (received != null && input.cdDeliveredDate < received)
    const words = triggers.map((t) => t === "apr_inaccurate" ? "changed the APR beyond the 1/8-point tolerance" : t === "loan_product_changed" ? "changed the loan product" : "added a prepayment penalty").join(" and ")
    return {
      path: "new_waiting_period", triggers, waitingPeriodOutstanding: outstanding,
      detail: `The revised Closing Disclosure ${words} — a new three-business-day waiting period starts when the buyer receives it (12 CFR 1026.19(f)(2)(ii)). The lender owns the timing.${outstanding ? " The delivery date on file is earlier than the revised Closing Disclosure — record when the buyer received the revised one." : ""}`,
    }
  }
  if (aprBand === "irregular_band" || aprBand === "decrease_over" || unknowns.length > 0) {
    const why = aprBand === "irregular_band" ? "the APR rose more than 1/8 but not more than 1/4 of a point — accurate only if the loan is an irregular transaction"
      : aprBand === "decrease_over" ? "the APR fell more than 1/8 of a point — it can still be accurate when the finance charge was overstated (12 CFR 1026.22(a)(4))"
      : `the documents on file do not state ${unknowns.join(", ")} on both Closing Disclosures`
    return { path: "escalate_to_lender", triggers: [], waitingPeriodOutstanding: false, detail: `Whether this revision restarts the three-business-day wait cannot be decided from the documents: ${why}. The lender confirms it.` }
  }
  return { path: "corrected_cd_no_new_wait", triggers: [], waitingPeriodOutstanding: false, detail: "The revision changes no APR beyond tolerance, no loan product and adds no prepayment penalty: the lender provides the corrected Closing Disclosure at or before closing (12 CFR 1026.19(f)(2)(i)) — no new three-business-day wait." }
}

/** PURE — a stable fingerprint of what the reconciliation saw (FNV-style over its canonical JSON; no crypto — this module is client-safe). */
function reconciliationFingerprint(value: unknown): string {
  const s = JSON.stringify(value)
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
}

/**
 * PURE — THE RECONCILIATION. Every executed term the 152E comparison judged becomes an item labelled with its basis, its side and
 * who corrects it; the issuer's own figures are listed as the issuer's (never computed); the TRID branch decides corrected-CD vs new
 * wait. The state is the WORST bucket of the blocking items: compliance_blocked > awaiting_revised_document > needs_review > ready.
 * The final record is reported beside the state (finalOnFile) — the close gate requires both; a pre-closing review of a preliminary
 * statement is judged on its figures alone. After closing nothing holds (the deal closed) — a difference becomes a finance correction.
 */
export function reconcileSettlement(input: SettlementReconciliationInput): SettlementReconciliation {
  const kind = closingRecordKind({ financing: input.closing.financing, tridTracked: input.closing.tridTracked })
  const issuerParty: SettlementParty = kind.kind === "trid_cd" ? "lender" : "settlement_agent"
  const issuerDoc = kind.kind === "trid_cd" ? "Closing Disclosure / settlement statement" : "settlement statement"
  const items: SettlementItem[] = []
  const postClose = input.closing.closed
  const push = (i: Omit<SettlementItem, "bucket"> & { bucket?: SettlementReadiness | null }) => { items.push({ ...i, bucket: i.blocking ? (i.bucket ?? "needs_review") : null }) }

  if (input.readFault) {
    push({ key: "inputs", label: "The closing records could be read", basis: "exact", side: "shared", staffOnly: false, contractSays: null, documentSays: null, status: "not_on_file", blocking: true, bucket: "compliance_blocked",
      responsible: PARTY_WORDS.transaction_coordinator, action: "Nothing was verified because the closing records could not be read. Try again; if it repeats, contact platform support." })
  }

  // 1 · the record itself. A statement the platform READ (documents rail) is reconciled figure by figure. Without one: in CDA mode a
  //     person already compared the preliminary statement in the CDA workflow (its review state) — said so, not re-claimed; without a
  //     CDA nothing else reviews it, so an upload the platform never read holds the close until it is read (the owner's ruling).
  const recordLabel = kind.kind === "trid_cd" ? "Closing Disclosure / settlement statement on file" : "Settlement statement on file"
  const finalOnDocuments = !!input.statement && (input.statement.stage === "final" || (input.statement.stage === "unlabeled" && input.statement.classification === "closing_disclosure"))
  const finalOnFile = finalOnDocuments || (input.cdaMode === "cda" && input.cdaRail.finalAttached)
  if (!input.statement && !input.readFault) {
    if (input.cdaMode === "cda" && input.cdaRail.preliminaryReviewed) {
      push({ key: "record", label: recordLabel, basis: "authoritative_required", side: "shared", staffOnly: false, contractSays: null, documentSays: null, status: "advisory", blocking: false,
        responsible: null, action: "A person compared the statement in the CDA workflow; the platform has not read it. Upload it to the deal's documents to have every figure compared." })
    } else if (input.unreadStatementOnFile) {
      push({ key: "record", label: recordLabel, basis: "authoritative_required", side: "shared", staffOnly: false, contractSays: null, documentSays: "uploaded, not read", status: "not_on_file", blocking: !postClose, bucket: "needs_review",
        responsible: PARTY_WORDS.transaction_coordinator, action: "The statement was uploaded but never read, so nothing on it was compared. Upload it to the deal's documents — it is read and compared automatically." })
    } else {
      push({ key: "record", label: recordLabel, basis: "authoritative_required", side: "shared", staffOnly: false,
        contractSays: null, documentSays: null, status: "not_on_file", blocking: !postClose, bucket: "awaiting_revised_document", responsible: PARTY_WORDS[issuerParty],
        action: kind.kind === "trid_cd" ? "Ask the lender and the settlement agent for the Closing Disclosure and settlement statement, then upload them." : "Ask the title company / settlement agent or closing attorney for the settlement statement (ALTA / HUD-1 / closing statement), then upload it." })
    }
  }
  // the CDA workflow asked title for a corrected statement and nothing newer has been read since — MONITOR: awaiting the revision
  const requestedAt = input.cdaRail.correctionRequestedAt
  const revisionReceived = !!requestedAt && !!input.statement?.receivedAt && input.statement.receivedAt > requestedAt
  if (requestedAt && !revisionReceived) {
    push({ key: "record.correction_requested", label: "Corrected statement requested from the title company", basis: "authoritative_required", side: "shared", staffOnly: false, contractSays: null, documentSays: `requested ${requestedAt.slice(0, 10)}${input.cdaRail.correctionRoute && input.cdaRail.correctionRoute !== "none" ? ` (${input.cdaRail.correctionRoute})` : " (deliver it by hand — no title recipient on file)"}`,
      status: "not_on_file", blocking: !postClose, bucket: "awaiting_revised_document", responsible: PARTY_WORDS.settlement_agent, action: "Waiting for the revised statement. When it arrives, upload it — it is compared automatically." })
  }
  if (kind.presumed && input.statement) {
    push({ key: "trid_coverage", label: "Which disclosure rules apply", basis: "authoritative_required", side: "buyer", staffOnly: false, contractSays: null, documentSays: null, status: "advisory", blocking: false,
      responsible: PARTY_WORDS.lender, action: kind.kind === "undetermined" ? "The deal's financing is not recorded. Record it (cash or financed) so the right closing record is checked." : "No TRID timeline is tracked on this financed deal. Confirm with the lender that the loan is TRID-covered (business-purpose loans, HELOCs, reverse mortgages and some seller-financed loans are not) and record the Closing Disclosure delivery date." })
  }

  // 2 · the executed terms against the latest statement (152E's comparison)
  const waived = new Set(input.waivedTerms)
  for (const f of input.findings ?? []) {
    if (f.against === "deal_record") continue // a deal-record drift is a compliance row (otherOpenBlocking), not a statement line
    const money = MONEY_TERMS.has(f.term)
    const side: SettlementItem["side"] = BUYER_SIDE_TERMS.has(f.term) ? "buyer" : SELLER_SIDE_TERMS.has(f.term) ? "seller" : "shared"
    const base = { key: `term.${f.term}`, label: f.label, basis: "exact" as const, side, staffOnly: STAFF_ONLY_TERMS.has(f.term), contractSays: f.governing, documentSays: f.settlement }
    if (f.verdict === "match") { push({ ...base, status: "agrees", blocking: false, responsible: null, action: null }); continue }
    if (waived.has(f.term)) {
      push({ ...base, status: "resolved_by_override", blocking: false, responsible: null, action: "Waived by an authorized reviewer with a written reason (kept as the audit record)." })
      continue
    }
    if (f.verdict === "mismatch") {
      push({ ...base, status: "differs", blocking: f.blocking && !postClose, bucket: "awaiting_revised_document", responsible: PARTY_WORDS[issuerParty],
        action: f.classification === "superseded" ? `Send the issuer the executed instrument that replaced this value and ask for a corrected ${issuerDoc}.` : `Ask the issuer for a corrected ${issuerDoc} — or record the executed amendment if the contract changed.` })
      continue
    }
    if (f.verdict === "conflict") {
      push({ ...base, status: "requires_interpretation", blocking: money && !postClose, bucket: "needs_review", responsible: PARTY_WORDS.licensed_professional,
        action: "Two executed instruments disagree on this term. A licensed professional reads them; record the instrument that settles it." })
      continue
    }
    if (f.governing != null && f.settlement == null) {
      const blocks = MISSING_ON_STATEMENT_BLOCKS.has(f.term) && !postClose && !!input.statement
      push({ ...base, status: "missing_on_document", blocking: blocks, bucket: "awaiting_revised_document", responsible: PARTY_WORDS[issuerParty],
        action: blocks ? `The executed contract states this but the latest ${issuerDoc} does not show it. Ask the issuer for a corrected statement that includes it.` : "The latest statement does not show this line. Confirm it on the other party's statement, or ask the issuer." })
    } else if (f.governing != null && f.settlement != null) {
      push({ ...base, status: "unverified_reading", blocking: money && !postClose, bucket: "needs_review", responsible: PARTY_WORDS.transaction_coordinator,
        action: "The figures differ but one reading is low-confidence. Verify the figure on the document in its reading review; it re-checks on its own." })
    } else {
      push({ ...base, status: "not_stated_by_contract", blocking: false, responsible: null, action: "No executed instrument states this term — nothing to compare." })
    }
  }

  // 3 · the issuer's own figures — listed as the issuer's, never computed or "balanced" here
  const fig = input.figures
  const issuerItem = (key: string, label: string, side: SettlementItem["side"], value: Figure | undefined) => {
    const v = reconNum(value)
    push({ key: `issuer.${key}`, label, basis: "authoritative_required", side, staffOnly: false, contractSays: null, documentSays: v != null ? usdText(v) : null,
      status: v != null ? "issuer_value" : "not_on_file", blocking: false, responsible: v != null ? null : PARTY_WORDS[issuerParty],
      action: v != null ? "The issuer's figure — VIPAgents never computes or edits it." : "Not read from the statement. Verify it on the document; only the issuer can state it." })
  }
  if (input.statement) {
    if (kind.kind === "trid_cd") {
      issuerItem("cash_to_close", "Cash to close", "buyer", fig.cashToClose)
      issuerItem("total_closing_costs", "Total closing costs", "buyer", fig.totalClosingCosts)
      const loan = reconNum(fig.loanAmount)
      const rec = input.dealRecord.loanAmount
      if (loan != null && rec != null && Math.abs(loan - rec) > 0.5) {
        push({ key: "issuer.loan_amount", label: "Loan amount", basis: "authoritative_required", side: "buyer", staffOnly: false, contractSays: `${usdText(rec)} (deal record)`, documentSays: usdText(loan), status: "differs", blocking: false,
          responsible: PARTY_WORDS.transaction_coordinator, action: "The lender's figure governs. Update the deal record's loan amount to the lender's figure." })
      } else issuerItem("loan_amount", "Loan amount", "buyer", fig.loanAmount)
    }
    if (reconNum(fig.sellerProceeds) != null) issuerItem("seller_proceeds", "Seller proceeds", "seller", fig.sellerProceeds)
  }

  // 4 · TRID — a corrected CD vs a new three-business-day wait
  const trid = tridRevisionAssessment({ kind: kind.kind, prior: input.priorCdFigures, current: fig, currentReceivedAt: input.statement?.receivedAt ?? null, cdDeliveredDate: input.trid?.cdDeliveredDate ?? null })
  if (trid.path === "new_waiting_period") {
    push({ key: "trid.waiting_period", label: "TRID waiting period after the revised Closing Disclosure", basis: "authoritative_required", side: "buyer", staffOnly: false, contractSays: null, documentSays: trid.triggers.join(", "),
      status: trid.waitingPeriodOutstanding ? "not_on_file" : "agrees", blocking: trid.waitingPeriodOutstanding && !postClose, bucket: "awaiting_revised_document", responsible: PARTY_WORDS.lender,
      action: trid.waitingPeriodOutstanding ? "Record the date the buyer received the revised Closing Disclosure; closing waits three business days from it. The lender owns the timing." : "The revised Closing Disclosure's delivery is on file; the closing gate counts the three business days." })
  } else if (trid.path === "escalate_to_lender") {
    push({ key: "trid.revision", label: "Does the revised Closing Disclosure restart the waiting period?", basis: "authoritative_required", side: "buyer", staffOnly: false, contractSays: null, documentSays: null, status: "advisory", blocking: false,
      responsible: PARTY_WORDS.lender, action: "Ask the lender to confirm in writing whether the revision restarts the three-business-day wait." })
  }

  // 5 · the compliance rows that are not statement lines — they hold the closing as they always did
  for (const label of input.otherOpenBlocking) {
    push({ key: `compliance.${label}`, label, basis: "exact", side: "shared", staffOnly: false, contractSays: null, documentSays: null, status: "requires_interpretation", blocking: !postClose, bucket: "compliance_blocked",
      responsible: PARTY_WORDS.transaction_coordinator, action: "Open the compliance tab and resolve this item; it re-checks on its own." })
  }

  // 6 · after closing: a corrected statement is reconciled — never a silent rewrite of a paid / finalized ledger
  if (postClose && items.some((i) => i.status === "differs" || i.status === "missing_on_document")) {
    push({ key: "post_closing.correction", label: "Corrected statement after closing", basis: "authoritative_required", side: "shared", staffOnly: true, contractSays: null, documentSays: null, status: "advisory", blocking: false,
      responsible: PARTY_WORDS.brokerage_finance,
      action: input.closing.commissionFinalized
        ? "The commission is finalized. If money moved, a finance admin records an approved adjustment through the ledger correction path — the paid entry is never re-written."
        : "Review the corrected statement against the commission before any payout is approved." })
  }

  const blocking = items.filter((i) => i.blocking)
  const has = (b: SettlementReadiness) => blocking.some((i) => i.bucket === b)
  const state: SettlementReadiness = has("compliance_blocked") ? "compliance_blocked" : has("awaiting_revised_document") ? "awaiting_revised_document" : has("needs_review") ? "needs_review" : "ready"
  const route = input.cdaRail.correctionRoute
  const request: SettlementReconciliation["request"] = revisionReceived
    ? { status: "revision_received", requestedAt, route }
    : requestedAt ? { status: "requested", requestedAt, route }
    : input.openCorrectionTasks > 0 ? { status: "open_task", requestedAt: null, route: null } : { status: "none", requestedAt: null, route: null }
  const blockers = blocking.map((i) => i.staffOnly
    ? `${i.label}: the brokerage reviews this line before closing.`
    : `${i.label}: ${i.contractSays != null || i.documentSays != null ? `contract says ${i.contractSays ?? "—"}; latest document says ${i.documentSays ?? "not shown"}. ` : ""}${i.action ?? ""}`.trim())
  const record = { kind: kind.kind, issuer: kind.issuer, finalOnFile, documentId: input.statement?.documentId ?? null, stage: input.statement?.stage ?? null, receivedAt: input.statement?.receivedAt ?? null, versions: input.statement?.versions ?? 0 }
  const fingerprint = reconciliationFingerprint({ state, record: [record.kind, record.documentId, finalOnFile], trid: [trid.path, trid.waitingPeriodOutstanding], items: items.map((i) => [i.key, i.status, i.contractSays, i.documentSays, i.blocking]) })
  return { state, record, items, trid, request, blockers, fingerprint }
}

/**
 * PURE — ROLE PRIVACY. A buyer-side viewer never sees a seller-only line and a seller-side viewer never a buyer-only one (the
 * borrower's loan figures, the seller's proceeds); commission values are blanked for anyone who is not brokerage staff (commission is
 * off agent-facing display). Staff (the TC, compliance, the books roster) see every line. What is withheld is COUNTED, never silently
 * dropped.
 */
export function settlementReconciliationForViewer(r: SettlementReconciliation, viewer: { side: "buyer" | "seller" | "both"; staff: boolean }): SettlementReconciliation & { withheld: number } {
  let withheld = 0
  const items = r.items.flatMap((i) => {
    if (!viewer.staff && viewer.side !== "both" && i.side !== "shared" && i.side !== viewer.side) { withheld++; return [] }
    if (!viewer.staff && i.staffOnly) return [{ ...i, contractSays: null, documentSays: null, action: i.blocking ? "The brokerage reviews this line before closing." : null }]
    return [i]
  })
  const blockers = viewer.staff ? r.blockers : r.blockers.filter((_, idx) => {
    const b = r.items.filter((i) => i.blocking)[idx]
    return !b || viewer.side === "both" || b.side === "shared" || b.side === viewer.side
  })
  return { ...r, items, blockers, withheld }
}
