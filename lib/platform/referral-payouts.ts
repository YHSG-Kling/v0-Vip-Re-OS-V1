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
  parseReferrerEmail,
  type ReferralPayoutStatus,
} from "@/lib/platform/subscriber-referrals"

type Svc = ReturnType<typeof createServiceClient>

/** Postgres codes that mean "m573 has not been applied yet". */
const MISSING_RELATION = "42P01"
const MISSING_COLUMN = "42703"

export interface ReferralFeeTerms {
  percent: number
  /** Where the number came from — surfaced, so a default is never mistaken for policy. */
  source: "platform_settings" | "default_constant"
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
  // select("*"), deliberately: naming referral_fee_percent in the select would
  // be a hard PostgREST refusal (42703) until m573 is applied — the whole read
  // would fail on today's live schema. The singleton row is tiny; reading it
  // whole and taking the field off the record makes the SAME code correct
  // before and after the migration (absent column → undefined → default,
  // reported as default_constant). Same idiom as buildSnapshotPayload's
  // allow-list reads in lib/platform/config-snapshots.ts.
  const { data, error } = await svc
    .from("platform_settings")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error || !data) return { percent: REFERRAL_FEE_PERCENT, source: "default_constant" }
  const p = Number((data as Record<string, unknown>).referral_fee_percent)
  if (!Number.isFinite(p) || p < 0 || p > 100) return { percent: REFERRAL_FEE_PERCENT, source: "default_constant" }
  return { percent: p, source: "platform_settings" }
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
      reason: "already_posted" | "ledger_unavailable" | "invalid" | "error"
      error: string
      recipient?: ReferralRecipient
    }

/**
 * POST a referral payout onto the ledger — idempotent per (prospect, period).
 * The write is .select()ed and READ (§3): a refused insert is a reported
 * refusal, a duplicate is "already posted", and a missing table (pre-m573) is
 * named as such so the caller can degrade honestly.
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

  const recipient = await resolveReferralRecipient(input.referrer, svc)

  const { data, error } = await svc
    .from("referral_payouts")
    .insert({
      prospect_id: input.prospectId,
      referrer: input.referrer,
      recipient_brokerage_id: recipient.brokerageId,
      recipient_email: recipient.email,
      amount_cents: amountCents,
      fee_percent: input.feePercent,
      period,
      status: "posted",
      note: (input.note ?? "").trim() || null,
      posted_by: input.postedBy,
    })
    .select("id")
    .single()
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
    .select("id, referrer, amount_cents, fee_percent, period, status, note, posted_at, received_at")
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
    .select("prospect_id, amount_cents, status, posted_at, recipient_brokerage_id")
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
    }
    const cents = Number(r.amount_cents) || 0
    cur.postedCents += cents
    if (r.status === "received") cur.receivedCents += cents
    if (!cur.lastPostedAt) {
      // ordered desc — first row seen is the latest posting
      cur.lastPostedAt = r.posted_at
      cur.lastPostedCents = cents
      cur.recipientBrokerageId = r.recipient_brokerage_id ?? null
    }
    byProspect.set(r.prospect_id, cur)
  }
  return { byProspect, unavailable: false, error: null }
}
