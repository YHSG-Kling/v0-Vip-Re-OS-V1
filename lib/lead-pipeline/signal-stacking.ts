// lib/lead-pipeline/signal-stacking.ts
//
// MULTI-SIGNAL STACKING (lane 88G, wave 88 — lane-87F scraping gap #7: "no list-stacking score
// across sources on one property … a 'distress count per parcel' rank is the industry norm").
//
// WHAT EXISTED, AND WHY IT WAS NOT A STACK. Every source scored ALONE:
//   • source-intent-map.ts::calculateSourceScore adds +5 per matched boost signal, capped +25 and
//     clamped to the SOURCE's own range — a per-source adjustment, blind to every other source.
//   • A BatchData pull knows every quickList a parcel is on (tax-default AND vacant AND absentee in one
//     row), but normalizeBatchDataProperty dropped the whole set (object-vs-array wire shape — fixed
//     in lib/external/batchdata-client.ts::quickListSlugsFromRow) and normalizeBatchDataRecord stamped
//     only the ONE trigger that pulled it.
//   • When the SAME person arrived from a second source (a divorce filing from OSINT, then a
//     tax-default from BatchData), pipeline-processor's dedup correctly refused to mint a duplicate —
//     and the second source's signals were simply lost. The lead never learned it was stacked.
//   • lib/services/lead-management.service.ts already credits STRONG motivated_seller_signals rows
//     (+15 each, cap 30) — the post-lead probe lane; this module is the ACQUISITION-time half that
//     acts before any probe spend.
//
// THE RULE (industry consensus, researched 2026-09-28 — DistressIQ / REmail / DealRun / PropIntel /
// FlaggedLeads: count DISTINCT signal TYPES per property, not raw events; single-signal lists convert
// ~1-2%, 3+ overlapping ~8-12%; absentee / high equity / senior owner are "multipliers or tier-up
// factors rather than additive components"):
//   1. Map every spelling any source writes onto ONE family (STACK_FAMILY) — a divorce is a divorce
//      whether OSINT, the text lexicon or the seller-signal lane wrote it (CLAUDE.md §6).
//   2. Count DISTINCT DISTRESS families. ENABLER families (absentee, high equity, senior owner, tired
//      landlord) count only when at least one distress family is present — an absentee owner alone is
//      a demographic, not motivation.
//   3. Boost = STACK_BOOST_PER_EXTRA_FAMILY per family beyond the first, capped at STACK_BOOST_CAP,
//      added ON TOP of the fused source score (it is a cross-source fact, so it may exceed a single
//      source's scoreRange) and clamped to 0-100.
//
// NO VENDOR CALL, $0: the stack is assembled from signals already bought and already on the raw rows.
// Dedup and the lead gate are UNCHANGED — this reads their verdicts, it never changes one.

import { scoreToUrgencyLevel } from "./source-intent-map"

/** Every spelling → its stacking family. Families reuse the motivated_seller_signals signal_type
 *  namespace where one exists (tax_delinquent, vacancy, absentee_owner, high_equity, tired_landlord,
 *  senior_owner, code_violation, involuntary_lien, expired_listing, for_sale_by_owner). */
export const STACK_FAMILY: Readonly<Record<string, string>> = {
  // foreclosure ladder — one family, however far along
  foreclosure: "foreclosure", pre_foreclosure: "foreclosure", preforeclosure: "foreclosure",
  notice_of_default: "foreclosure", lis_pendens: "foreclosure", auction: "foreclosure",
  distressed: "foreclosure", behind_on_mortgage: "foreclosure", notice_of_sale: "foreclosure",
  // tax
  tax_lien: "tax_delinquent", tax_delinquent: "tax_delinquent", tax_default: "tax_delinquent",
  // other liens
  involuntary_lien: "involuntary_lien",
  // estate
  probate: "probate", estate: "probate", inherited: "probate", inherited_property: "probate",
  obituary: "probate", pre_probate: "probate", estate_sale: "probate",
  // household events (court)
  divorce: "divorce", recent_divorce: "divorce",
  bankruptcy: "bankruptcy",
  eviction: "eviction",
  // property condition
  vacant: "vacancy", vacancy: "vacancy",
  code_violation: "code_violation",
  // owner left the mailing address — the change-of-address proxy
  mailing_vacant: "moved_away",
  // a failed attempt to sell
  expired: "expired_listing", expired_listing: "expired_listing", canceled_listing: "expired_listing",
  failed_listing: "expired_listing", withdrawn: "expired_listing", listing_withdrawn: "expired_listing",
  off_market: "expired_listing", listing_removed: "expired_listing",
  price_reduced: "price_cut", price_cut: "price_cut",
  fsbo: "for_sale_by_owner", for_sale_by_owner: "for_sale_by_owner", by_owner: "for_sale_by_owner",
  must_sell: "urgent_sale", need_to_sell: "urgent_sale", motivated: "urgent_sale",
  // ENABLERS (tier-up only)
  absentee: "absentee_owner", absentee_owner: "absentee_owner",
  high_equity: "high_equity",
  senior_owner: "senior_owner", downsizing: "senior_owner",
  tired_landlord: "tired_landlord",
}

/** Families that tier a stack up but never start one (researched: "multipliers, not components"). */
const ENABLER_FAMILIES: ReadonlySet<string> = new Set(["absentee_owner", "high_equity", "senior_owner", "tired_landlord"])

export const STACK_BOOST_PER_EXTRA_FAMILY = 6
export const STACK_BOOST_CAP = 20

interface SignalStack {
  /** Distinct families that COUNT (distress, plus enablers once a distress family exists). */
  families: string[]
  count: number
  boost: number
}

function canon(signal: string): string {
  return String(signal ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
}

/** PURE. Any mix of spellings from any source → the stack. */
export function stackSignals(signals: ReadonlyArray<string | null | undefined>): SignalStack {
  const distress = new Set<string>()
  const enablers = new Set<string>()
  for (const s of signals) {
    if (!s) continue
    const fam = STACK_FAMILY[canon(s)]
    if (!fam) continue
    ;(ENABLER_FAMILIES.has(fam) ? enablers : distress).add(fam)
  }
  const families = distress.size > 0 ? [...distress, ...enablers].sort() : []
  const count = families.length
  const boost = count <= 1 ? 0 : Math.min(STACK_BOOST_CAP, (count - 1) * STACK_BOOST_PER_EXTRA_FAMILY)
  return { families, count, boost }
}

/** PURE. The stacked score, clamped 0-100 (a cross-source fact may exceed one source's range). */
export function applyStackBoost(score: number, stack: SignalStack): number {
  return Math.max(0, Math.min(100, Math.round(score + stack.boost)))
}

// ─── DB helpers — the only reads/writes this module makes ────────────────────

/** Structural subset of the supabase-js client these helpers use (keeps the module test-injectable). */
type Db = { from: (table: string) => any }

interface RawSignalRow { id: string; source?: string | null; normalized_preview?: { intentSignals?: string[] } | null }

function signalsOf(rows: ReadonlyArray<RawSignalRow>): string[] {
  const out: string[] = []
  for (const r of rows) out.push(...(r.normalized_preview?.intentSignals ?? []))
  return out
}

async function rawSignalRows(db: Db, ids: string[]): Promise<{ rows: RawSignalRow[]; error: string | null }> {
  if (ids.length === 0) return { rows: [], error: null }
  const { data, error } = await db.from("raw_scraped_leads").select("id, source, normalized_preview").in("id", ids.slice(0, 200))
  return { rows: (data ?? []) as RawSignalRow[], error: error?.message ?? null }
}

/**
 * The signals already known for a raw row that is about to PROMOTE: its own plus every raw row the
 * dedup log recorded as a duplicate OF it (match_details.duplicate_of_raw_id — written by
 * pipeline-processor's two dedup passes). A refused read is reported (`measured: false`) and
 * contributes nothing — never a fabricated stack.
 */
export async function readRawSignalStack(
  db: Db,
  rawRecordId: string,
  ownSignals: ReadonlyArray<string>,
): Promise<{ stack: SignalStack; siblingRawIds: string[]; measured: boolean }> {
  const { data, error } = await db
    .from("lead_deduplication_log")
    .select("raw_record_id")
    .eq("match_details->>duplicate_of_raw_id", rawRecordId)
    .limit(200)
  if (error) return { stack: stackSignals(ownSignals), siblingRawIds: [], measured: false }
  const siblingRawIds = [...new Set(((data ?? []) as Array<{ raw_record_id: string | null }>).map((r) => r.raw_record_id).filter((x): x is string => !!x && x !== rawRecordId))]
  const sib = await rawSignalRows(db, siblingRawIds)
  return {
    stack: stackSignals([...ownSignals, ...signalsOf(sib.rows)]),
    siblingRawIds,
    measured: !sib.error,
  }
}

interface LeadStackResult {
  applied: boolean
  /** Why nothing moved, when nothing moved. */
  reason?: string
  families: string[]
  priorBoost: number
  boost: number
  delta: number
  leadScore?: number
}

/**
 * A raw row the dedup passes judged a duplicate of an EXISTING LEAD. Its signals join that lead's
 * stack and the lead_score rises by the stack's DELTA (new boost − prior boost), never by the whole
 * boost again. The lead's prior signals are its promoted raw rows (raw_scraped_leads.lead_id) plus
 * every raw row already logged as its duplicate (lead_deduplication_log.duplicate_of_lead_id),
 * EXCLUDING this row — so a re-run of the same row computes the same delta, and the caller's own log
 * row (written after this returns, carrying `signal_stack`) is the idempotency stamp checked first.
 *
 * Fail-closed on every read: a refused read applies NOTHING (reason names it). The update is
 * `.select()`-counted — a zero-row update is reported, never read as success (CLAUDE.md §3).
 */
export async function stackDuplicateOntoLead(
  db: Db,
  params: { leadId: string; rawRecordId: string; signals: ReadonlyArray<string> },
): Promise<LeadStackResult> {
  const none = (reason: string, extra: Partial<LeadStackResult> = {}): LeadStackResult =>
    ({ applied: false, reason, families: [], priorBoost: 0, boost: 0, delta: 0, ...extra })

  // An enabler alone can still complete a stack the lead's prior distress started — so the test is
  // "does ANY signal map to a family", not "does this row stack on its own".
  if (params.signals.every((s) => !STACK_FAMILY[canon(s)])) {
    return none("no stackable signal on this row")
  }

  // Idempotency: this raw row already stacked onto a lead once.
  const { data: stamped, error: stampErr } = await db
    .from("lead_deduplication_log")
    .select("id")
    .eq("raw_record_id", params.rawRecordId)
    .not("match_details->signal_stack", "is", null)
    .limit(1)
  if (stampErr) return none(`dedup-log read refused: ${stampErr.message}`)
  if ((stamped ?? []).length > 0) return none("already stacked (dedup log carries this row's signal_stack)")

  const [{ data: promoted, error: promotedErr }, { data: logged, error: loggedErr }] = await Promise.all([
    db.from("raw_scraped_leads").select("id, source, normalized_preview").eq("lead_id", params.leadId).limit(200),
    db.from("lead_deduplication_log").select("raw_record_id").eq("duplicate_of_lead_id", params.leadId).limit(200),
  ])
  if (promotedErr) return none(`raw_scraped_leads read refused: ${promotedErr.message}`)
  if (loggedErr) return none(`lead_deduplication_log read refused: ${loggedErr.message}`)
  const loggedIds = ((logged ?? []) as Array<{ raw_record_id: string | null }>)
    .map((r) => r.raw_record_id).filter((x): x is string => !!x && x !== params.rawRecordId)
  const sib = await rawSignalRows(db, loggedIds)
  if (sib.error) return none(`duplicate raw rows read refused: ${sib.error}`)

  const priorRows = [...((promoted ?? []) as RawSignalRow[]).filter((r) => r.id !== params.rawRecordId), ...sib.rows]
  const priorSignals = signalsOf(priorRows)
  const prior = stackSignals(priorSignals)
  const next = stackSignals([...priorSignals, ...params.signals])
  const delta = next.boost - prior.boost
  if (delta <= 0) return none("no new family — the stack did not grow", { families: next.families, priorBoost: prior.boost, boost: next.boost })

  const { data: lead, error: leadErr } = await db.from("leads").select("id, lead_score").eq("id", params.leadId).maybeSingle()
  if (leadErr) return none(`leads read refused: ${leadErr.message}`, { families: next.families, priorBoost: prior.boost, boost: next.boost })
  if (!lead) return none("lead not found", { families: next.families, priorBoost: prior.boost, boost: next.boost })
  const before = Number((lead as { lead_score?: number | null }).lead_score ?? 0)
  const leadScore = Math.max(0, Math.min(100, Math.round(before + delta)))
  const { data: updated, error: updErr } = await db
    .from("leads")
    .update({ lead_score: leadScore, urgency_level: scoreToUrgencyLevel(leadScore), updated_at: new Date().toISOString() })
    .eq("id", params.leadId)
    .select("id")
  if (updErr) return none(`leads update refused: ${updErr.message}`, { families: next.families, priorBoost: prior.boost, boost: next.boost })
  if ((updated ?? []).length === 0) return none("leads update matched no row", { families: next.families, priorBoost: prior.boost, boost: next.boost })
  return { applied: true, families: next.families, priorBoost: prior.boost, boost: next.boost, delta, leadScore }
}
