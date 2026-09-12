// lib/platform/referral-payouts.ts
// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER-REFERRAL PAYOUTS — the server half of "posted and received".
//
// Owner ruling: "make sure referral payouts are posted and received by the
// recipient." Before this module, "paid" was a superadmin_audit_log line read
// back from the log — a trail, not a ledger — and nothing ever showed the
// RECIPIENT anything.
//
//   POSTED   = a referral_payouts row (migration m573 — WRITTEN, applied by
//              the integrator). UNIQUE(prospect_id, period) makes posting
//              idempotent by construction (the affiliate rail's proven idiom);
//              the insert is .select()ed and read (§3), 23505 reported as
//              "already posted", never as a second payment. The recipient is
//              resolved AT POST TIME from the referrer string's email →
//              users.email → users.brokerage_id: a match makes the referrer a
//              TENANT and the payout lands on their billing surface.
//   RECEIVED = the recipient's own acknowledgment: their billing page
//              (app/dashboard/admin/billing → referral-earnings-card) lists
//              posted payouts and flips status posted → received — a COUNTED
//              update scoped to the SESSION tenant (§4), so "received" is the
//              recipient seeing and confirming, never the platform asserting.
//
// TERMS' ONE HOME (§6): platform_settings.referral_fee_percent (m573), read by
// getReferralFeeTerms off the same singleton row platform-controls reads.
// Until m573 is applied the column read fails (42703) and the resolver falls
// back to the code default — the source is reported either way, never guessed.
//
// PRE-m573 the ledger table is also absent (42P01): every function here reads
// the error (§3 — supabase-js RESOLVES refusals), reports "ledger_unavailable"
// naming the migration, and the calling action degrades to the legacy
// audit-line behavior instead of breaking the superadmin flow.
//
// NON-TENANT REFERRERS — the honest remaining half: a referrer whose email
// matches no users row gets a ledger row with recipient_email only. Posting is
// recorded; the CASH rail to reach them (external transfer — the
// vendor_payouts + Stripe transfer pattern) is NOT built here, because a new
// Stripe money path must be declared in lib/billing/stripe-account-scope.ts
// (STRIPE_MONEY_PATHS + the guard's importer roster), which is an integrator
// decision. The same applies to auto-applying a tenant-referrer's payout as a
// Stripe customer-balance credit on the platform account (a negative
// adjustment inside the tenant_saas_subscription path): declared as follow-up,
// not silently half-built.
//
// No new inbound webhook is needed: posting is a staff action and receipt is
// an in-app acknowledgment — nothing external delivers events for this rail,
// so lib/providers/webhook-contract.ts is deliberately unchanged.

import { createServiceClient } from "@/lib/supabase/service"
// Calendar helpers only — 'YYYY-MM' has ONE spelling in this repo (§6). The
// affiliate rail's "never share tables, math, or UI" ruling covers commission
// math and money tables, not the shape of a month string.
import { PERIOD_RE, periodFor } from "@/lib/platform/affiliates"
import {
  REFERRAL_FEE_PERCENT,
  REFERRAL_FEE_BASES,
  REFERRAL_FEE_BASIS_DEFAULT,
  REFERRAL_FEE_DURATION_MONTHS_DEFAULT,
  computeReferralFeeCents,
  monthIndexForPeriod,
  parseReferrerEmail,
  type ReferralFeeBasis,
  type ReferralPayoutStatus,
} from "@/lib/platform/subscriber-referrals"

type Svc = ReturnType<typeof createServiceClient>

/** Postgres codes that mean "m573 has not been applied yet". */
const MISSING_RELATION = "42P01"
const MISSING_COLUMN = "42703"

export type ReferralTermsSource = "platform_settings" | "default_constant"

/**
 * THE FULL TERMS (m576 extends the m573 rate): basis, rate, duration — each
 * with its OWN reported source, because the owner's ruling ("platform should
 * not make assumption even with referrals") means a code default may stand in
 * ONLY while it is visibly labeled as the default, per field. The original
 * single `source` keeps its m573 meaning (the percent's source) — the pattern
 * is extended, not forked.
 */
export interface ReferralFeeTerms {
  percent: number
  /** Where the percent came from — surfaced, so a default is never mistaken for policy. */
  source: ReferralTermsSource
  /** 'percent' of MRR (m573 shape) or 'flat' per conversion (m576). */
  basis: ReferralFeeBasis
  basisSource: ReferralTermsSource
  /** Flat amount in cents when basis='flat'; null otherwise/unset. */
  flatCents: number | null
  /** Months of MRR the fee runs (anchored on the first posted period per
   *  prospect). 1 = one-time; 0 = indefinite — EXPLICIT platform_settings
   *  choice only, the code default is bounded (12). */
  durationMonths: number
  durationSource: ReferralTermsSource
}

// FOLLOW-UP, deliberately not built pre-apply: an in-app terms EDITOR (a
// billing-gated, counted update of platform_settings.referral_fee_percent on
// the singleton row, audited like setPlatformControls) belongs AFTER m573 is
// applied — writing the column today is a PGRST204 refusal (the whole update
// is rejected, §3), and the schema-drift guard would rightly flag the writer
// until the post-apply snapshot regen absorbs the column. Until then the terms
// are the migration default (10) or a direct SQL update, and getReferralFeeTerms
// reports which source answered.

/**
 * The referral-fee terms from their ONE home — platform_settings.referral_fee_percent
 * on the singleton row (oldest, same read as lib/platform/platform-controls.ts).
 * Falls back to the code default before m573 is applied (42703) or when unset,
 * and SAYS SO via `source`.
 */
export async function getReferralFeeTerms(client?: Svc): Promise<ReferralFeeTerms> {
  const svc = client ?? createServiceClient()
  // select("*"), deliberately: naming referral_fee_percent (m573) or the m576
  // basis/duration columns in the select would be a hard PostgREST refusal
  // (42703) until the migrations are applied — the whole read would fail on
  // today's live schema. The singleton row is tiny; reading it whole and
  // taking the fields off the record makes the SAME code correct before and
  // after each migration (absent column → undefined → default, reported as
  // default_constant). Same idiom as buildSnapshotPayload's allow-list reads
  // in lib/platform/config-snapshots.ts.
  const { data, error } = await svc
    .from("platform_settings")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  const defaults: ReferralFeeTerms = {
    percent: REFERRAL_FEE_PERCENT,
    source: "default_constant",
    basis: REFERRAL_FEE_BASIS_DEFAULT,
    basisSource: "default_constant",
    flatCents: null,
    durationMonths: REFERRAL_FEE_DURATION_MONTHS_DEFAULT,
    durationSource: "default_constant",
  }
  if (error || !data) return defaults
  const row = data as Record<string, unknown>
  const terms = { ...defaults }

  const p = Number(row.referral_fee_percent)
  if (Number.isFinite(p) && p >= 0 && p <= 100) {
    terms.percent = p
    terms.source = "platform_settings"
  }

  // BASIS + FLAT AMOUNT (m576). Fail-closed coherence: a stored basis of
  // 'flat' with no valid flat amount is UNCONFIGURED — the resolver falls back
  // to the default basis and SAYS SO, rather than computing a $0 "flat" fee.
  const flatRaw = Number(row.referral_fee_flat_cents)
  const flatCents = Number.isInteger(flatRaw) && flatRaw > 0 ? flatRaw : null
  const basisRaw = row.referral_fee_basis
  if (REFERRAL_FEE_BASES.includes(basisRaw as ReferralFeeBasis) && (basisRaw !== "flat" || flatCents !== null)) {
    terms.basis = basisRaw as ReferralFeeBasis
    terms.basisSource = "platform_settings"
    terms.flatCents = basisRaw === "flat" ? flatCents : null
  }

  // DURATION (m576). 0 = indefinite, accepted ONLY as a stored explicit value;
  // the code default stays bounded at REFERRAL_FEE_DURATION_MONTHS_DEFAULT.
  // NULL/absent must NOT collapse into the explicit 0 (Number(null) === 0) —
  // that would read "unconfigured" as "indefinite, chosen".
  const dRaw = row.referral_fee_duration_months
  const d = dRaw === null || dRaw === undefined ? Number.NaN : Number(dRaw)
  if (Number.isInteger(d) && d >= 0) {
    terms.durationMonths = d
    terms.durationSource = "platform_settings"
  }

  return terms
}

/**
 * PURE: the fee the configured terms compute. Percent basis → % of MRR (the
 * m573 math, computeReferralFeeCents); flat basis → the flat amount ONCE the
 * referral is a linked tenant (a flat fee is per CONVERSION — it does not
 * scale with MRR, but it is owed to no one until the prospect actually became
 * a tenant). Lives beside ReferralFeeTerms: the terms module computes what the
 * terms say, the parsing module stays pure of them.
 */
export function referralFeeCentsUnderTerms(
  terms: { basis: ReferralFeeBasis; percent: number; flatCents: number | null },
  mrrCents: number,
  linked: boolean,
): number {
  if (terms.basis === "flat") {
    if (!linked) return 0
    const flat = Number(terms.flatCents)
    return Number.isFinite(flat) && flat > 0 ? Math.floor(flat) : 0
  }
  return computeReferralFeeCents(mrrCents, terms.percent)
}

export interface ReferralRecipient {
  email: string | null
  userId: string | null
  brokerageId: string | null
  brokerageName: string | null
}

/**
 * Resolve who a referrer IS: parse the email out of the free-text referrer and
 * match it against users.email. A match = tenant referrer (their brokerage
 * receives on its billing surface); no email / no match = non-tenant referrer.
 * Errors are read and surfaced as an unresolved (all-null) recipient — a
 * lookup failure must not block a posting, but it is logged by the caller.
 */
export async function resolveReferralRecipient(referrer: string, client?: Svc): Promise<ReferralRecipient> {
  const email = parseReferrerEmail(referrer)
  if (!email) return { email: null, userId: null, brokerageId: null, brokerageName: null }
  const svc = client ?? createServiceClient()
  const { data: user, error } = await svc
    .from("users")
    .select("id, brokerage_id")
    .eq("email", email)
    .maybeSingle()
  if (error || !user) return { email, userId: null, brokerageId: null, brokerageName: null }
  const brokerageId = (user as { brokerage_id: string | null }).brokerage_id
  let brokerageName: string | null = null
  if (brokerageId) {
    const { data: brk } = await svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle()
    brokerageName = (brk as { name?: string | null } | null)?.name ?? null
  }
  return { email, userId: (user as { id: string }).id, brokerageId, brokerageName }
}

export type PostReferralPayoutResult =
  | { ok: true; payoutId: string; period: string; recipient: ReferralRecipient }
  | {
      ok: false
      reason: "already_posted" | "ledger_unavailable" | "invalid" | "beyond_duration" | "error"
      error: string
      recipient?: ReferralRecipient
    }

/**
 * POST a referral payout onto the ledger — idempotent per (prospect, period).
 * The write is .select()ed and READ (§3): a refused insert is a reported
 * refusal, a duplicate is "already posted", and a missing table (pre-m573) is
 * named as such so the caller can degrade honestly.
 *
 * READS THE FULL TERMS (m576): a posting for a month beyond the configured
 * duration is REFUSED (reason 'beyond_duration'), naming the term and where it
 * came from — configured terms or the reported bounded code default. The run
 * is anchored on the EARLIEST non-void posted period for the prospect (this
 * posting itself when it is the first). Duration 0 = indefinite, and only an
 * explicit platform_settings value can say so. The terms' basis is stamped
 * onto the row like fee_percent — the ledger records what it was posted under.
 */
export async function postReferralPayout(
  svc: Svc,
  input: {
    prospectId: string
    referrer: string
    amountCents: number
    feePercent: number
    period?: string | null
    note?: string | null
    postedBy: string
  },
): Promise<PostReferralPayoutResult> {
  const period = input.period?.trim() || periodFor(new Date())
  if (!PERIOD_RE.test(period)) return { ok: false, reason: "invalid", error: `Invalid period '${period}' — expected YYYY-MM` }
  const amountCents = Math.floor(Number(input.amountCents))
  if (!Number.isFinite(amountCents) || amountCents <= 0) return { ok: false, reason: "invalid", error: "A positive amount is required" }

  const terms = await getReferralFeeTerms(svc)

  // DURATION ENFORCEMENT. Anchor = earliest non-void posted period (a voided
  // first month was a retracted posting — it must not start the clock).
  if (terms.durationMonths > 0) {
    const { data: prior, error: priorErr } = await svc
      .from("referral_payouts")
      .select("period")
      .eq("prospect_id", input.prospectId)
      .neq("status", "void")
      .order("period", { ascending: true })
      .limit(1)
    if (priorErr) {
      // §3: the error is READ. A missing ledger (pre-m573) degrades exactly as
      // the insert would have — never a throw, never silent.
      const code = (priorErr as { code?: string }).code
      if (code === MISSING_RELATION || code === MISSING_COLUMN) {
        return { ok: false, reason: "ledger_unavailable", error: "referral_payouts does not exist yet — migration m573 is written but not applied." }
      }
      return { ok: false, reason: "error", error: priorErr.message }
    }
    const earliest = (prior?.[0] as { period?: string } | undefined)?.period
    const anchor = earliest && earliest < period ? earliest : period
    const monthIndex = monthIndexForPeriod(anchor, period)
    if (monthIndex > terms.durationMonths) {
      const src = terms.durationSource === "platform_settings" ? "the configured terms" : "the platform default (terms not configured)"
      return {
        ok: false,
        reason: "beyond_duration",
        error:
          `${period} is month ${monthIndex} of this referral's fee run (anchored at ${anchor}), but ${src} ` +
          `pay ${terms.durationMonths} month${terms.durationMonths === 1 ? "" : "s"} — posting beyond the term is refused.`,
      }
    }
  }

  const recipient = await resolveReferralRecipient(input.referrer, svc)

  const payload: Record<string, unknown> = {
    prospect_id: input.prospectId,
    referrer: input.referrer,
    recipient_brokerage_id: recipient.brokerageId,
    recipient_email: recipient.email,
    amount_cents: amountCents,
    fee_percent: input.feePercent,
    // Denormalized like fee_percent (m576): the basis this posting was made
    // under. INTEGRATOR NOTE (post-apply): add `basis` to the earnings/summary
    // selects so the recipient surface shows it — naming it there TODAY would
    // 42703-fail those whole reads (the writer is safe: PGRST204 is retried
    // below), and the opposite-missing census will rightly ask for the reader
    // once the schema caches learn the column.
    basis: terms.basis,
    period,
    status: "posted",
    note: (input.note ?? "").trim() || null,
    posted_by: input.postedBy,
  }
  let { data, error } = await svc.from("referral_payouts").insert(payload).select("id").single()
  if (error && (error as { code?: string }).code === "PGRST204") {
    // Pre-m576: the basis column is absent, and naming it refuses the WHOLE
    // insert (§3 — PGRST204 rejects everything, not "most of the row"). Retry
    // under the m573 shape; the row posts with basis null, exactly like every
    // legacy percent-era row.
    delete payload.basis
    ;({ data, error } = await svc.from("referral_payouts").insert(payload).select("id").single())
  }
  if (error) {
    const code = (error as { code?: string }).code
    if (code === "23505") {
      return { ok: false, reason: "already_posted", error: `A payout for ${period} is already posted for this referral — the ledger holds one row per referral per period.`, recipient }
    }
    if (code === MISSING_RELATION || code === MISSING_COLUMN) {
      return { ok: false, reason: "ledger_unavailable", error: "referral_payouts does not exist yet — migration m573 is written but not applied.", recipient }
    }
    return { ok: false, reason: "error", error: error.message, recipient }
  }
  if (!data) return { ok: false, reason: "error", error: "Insert returned no row — the payout cannot be confirmed as posted.", recipient }
  return { ok: true, payoutId: (data as { id: string }).id, period, recipient }
}

export interface ReferralEarningRow {
  id: string
  referrer: string
  amountCents: number
  feePercent: number
  period: string
  status: ReferralPayoutStatus
  note: string | null
  postedAt: string
  receivedAt: string | null
  /** Provenance: which of the tenant's own users confirmed receipt (users.id).
   *  The write half has stamped this since the ledger existed; this reader is
   *  what lets a finance admin see WHO on their team confirmed. */
  receivedBy: string | null
  /** The fee basis this payout was posted under (m576); null = percent-era row. */
  basis: ReferralFeeBasis | null
}

/**
 * RECEIVED half, read side: the payouts posted to a recipient tenant. The
 * caller passes the SESSION tenant's brokerage id (§4) — this module never
 * derives tenancy from a request. Pre-m573 the table is absent: reported as
 * `unavailable` with zero rows, never as "no earnings" without qualification.
 */
export async function listReferralEarningsForBrokerage(
  brokerageId: string,
  client?: Svc,
): Promise<{ ok: true; rows: ReferralEarningRow[]; unavailable: boolean } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "brokerageId required" }
  const svc = client ?? createServiceClient()
  const { data, error } = await svc
    .from("referral_payouts")
    .select("id, referrer, amount_cents, fee_percent, period, status, note, posted_at, received_at, received_by, basis")
    .eq("recipient_brokerage_id", brokerageId)
    .neq("status", "void")
    .order("posted_at", { ascending: false })
    .limit(200)
  if (error) {
    const code = (error as { code?: string }).code
    if (code === MISSING_RELATION || code === MISSING_COLUMN) return { ok: true, rows: [], unavailable: true }
    return { ok: false, error: error.message }
  }
  return {
    ok: true,
    unavailable: false,
    rows: ((data ?? []) as any[]).map((r) => ({
      id: r.id,
      referrer: r.referrer,
      amountCents: Number(r.amount_cents) || 0,
      feePercent: Number(r.fee_percent) || 0,
      period: r.period,
      status: r.status as ReferralPayoutStatus,
      note: r.note ?? null,
      postedAt: r.posted_at,
      receivedAt: r.received_at ?? null,
      receivedBy: r.received_by ?? null,
      basis: (r.basis ?? null) as ReferralFeeBasis | null,
    })),
  }
}

/**
 * RECEIVED half, write side: the recipient acknowledges a posted payout.
 * COUNTED (§3 — an update matching nothing also resolves): scoped to the
 * session tenant AND status='posted', .select()ed, and zero rows is reported
 * as the refusal it is (not theirs, already received, or void).
 */
export async function markReferralPayoutReceived(
  svc: Svc,
  input: { payoutId: string; brokerageId: string; userId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.payoutId || !input.brokerageId) return { ok: false, error: "payoutId and brokerageId required" }
  const { data, error } = await svc
    .from("referral_payouts")
    .update({ status: "received", received_at: new Date().toISOString(), received_by: input.userId, updated_at: new Date().toISOString() })
    .eq("id", input.payoutId)
    .eq("recipient_brokerage_id", input.brokerageId)
    .eq("status", "posted")
    .select("id")
  if (error) return { ok: false, error: error.message }
  if ((data ?? []).length === 0) {
    return { ok: false, error: "Nothing to acknowledge — that payout is not posted to your brokerage, or was already received." }
  }
  return { ok: true }
}

export interface ProspectLedgerSummary {
  postedCents: number
  receivedCents: number
  lastPostedAt: string | null
  lastPostedCents: number | null
  recipientBrokerageId: string | null
  /** WHOM TO PAY when the referrer is not a tenant: the parsed recipient email
   *  the post resolved. Written at post time and — until this reader existed —
   *  read by nothing, which the opposite-missing census flagged the moment the
   *  schema caches learned the table. Null for tenant referrers (they receive
   *  in-app) and pre-parse legacy rows. */
  recipientEmail: string | null
  /** Provenance: which staff user posted the latest payout (users.id). */
  lastPostedBy: string | null
}

/**
 * Ledger totals per prospect for the superadmin growth card. Pre-m573 returns
 * `unavailable: true` with an empty map (the card then shows legacy audit-line
 * history only — degraded, and said so where the caller logs it).
 */
export async function summarizeLedgerByProspect(
  prospectIds: string[],
  client?: Svc,
): Promise<{ byProspect: Map<string, ProspectLedgerSummary>; unavailable: boolean; error: string | null }> {
  const byProspect = new Map<string, ProspectLedgerSummary>()
  if (prospectIds.length === 0) return { byProspect, unavailable: false, error: null }
  const svc = client ?? createServiceClient()
  const { data, error } = await svc
    .from("referral_payouts")
    .select("prospect_id, amount_cents, status, posted_at, recipient_brokerage_id, recipient_email, posted_by, basis")
    .in("prospect_id", prospectIds)
    .order("posted_at", { ascending: false })
    .limit(2000)
  if (error) {
    const code = (error as { code?: string }).code
    const unavailable = code === MISSING_RELATION || code === MISSING_COLUMN
    return { byProspect, unavailable, error: unavailable ? null : error.message }
  }
  for (const r of (data ?? []) as any[]) {
    if (r.status === "void") continue
    const cur = byProspect.get(r.prospect_id) ?? {
      postedCents: 0, receivedCents: 0, lastPostedAt: null, lastPostedCents: null, recipientBrokerageId: null,
      recipientEmail: null, lastPostedBy: null,
    }
    const cents = Number(r.amount_cents) || 0
    cur.postedCents += cents
    if (r.status === "received") cur.receivedCents += cents
    if (!cur.lastPostedAt) {
      // ordered desc — first row seen is the latest posting
      cur.lastPostedAt = r.posted_at
      cur.lastPostedCents = cents
      cur.recipientBrokerageId = r.recipient_brokerage_id ?? null
      cur.recipientEmail = r.recipient_email ?? null
      cur.lastPostedBy = r.posted_by ?? null
    }
    byProspect.set(r.prospect_id, cur)
  }
  return { byProspect, unavailable: false, error: null }
}
