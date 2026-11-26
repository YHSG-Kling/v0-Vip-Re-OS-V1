// lib/kernel/lifetime-conversion.ts — CONTACT → LIFETIME, ONE WRITER, ONE GATE (wave 142, lane 142C).
//
// Owner ruling (2026-10-18): "Lifetime conversion after verified closing + complete records; CLOSED /
// PAYOUT PENDING until payout verified where rules require; no duplicate conversions."
//
// SURVIVOR EXTENDED, not replaced: the conversion itself (contacts.contact_type + lifecycle_state →
// lifetime_customer, the post-close touchpoint schedule) lived inline in
// lib/kernel/transactions.ts::closeTransactionCommand (steps 2 + 4). It is MOVED here verbatim-in-spirit
// so the close path and the payout path call the SAME idempotent writer instead of a second copy:
//   · at CLOSE (closeTransactionCommand) — convert, unless the tenant's policy holds conversion until
//     the agent's payout is recorded ("CLOSED / PAYOUT PENDING", visible as an open activity);
//   · at PAYOUT (lib/kernel/financial.ts markCommissionPaid) — release the hold and convert.
// The other two lifetime writers (lib/transactions/stage-progression.ts seller promotion on the deal
// stage machine, lib/application/listing-lifecycle.ts handleSellerToLifetimeTransition) stay as they are:
// they convert ONE seller on their own rails and are idempotent by construction (same value written).
//
// POLICY: brokerage_settings.settings.lifetime_conversion = { require_payout_verified: boolean } —
// registered in lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS (versioned like every tenant
// policy). Missing / unreadable → convert at close (today's behaviour), SAID in `source`.

import type { SupabaseClient } from "@supabase/supabase-js"
import { LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

type Svc = SupabaseClient<any, any, any>

export const LIFETIME_CONVERSION_POLICY_KEY = "lifetime_conversion"
/** The activity that makes a held conversion VISIBLE on the transaction ("CLOSED / PAYOUT PENDING"). */
export const LIFETIME_HOLD_ACTIVITY_TYPE = "lifetime_conversion_pending_payout"
export const LIFETIME_HOLD_LABEL = "CLOSED / PAYOUT PENDING"

export type LifetimeConversionAction = "convert" | "hold_payout_pending" | "hold_records" | "not_closed"

/**
 * PURE — may the deal's customer(s) become lifetime customers now?
 *   not_closed          — the closing is not verified (never convert on a pending deal)
 *   hold_records        — closed, but the required records are not complete yet
 *   hold_payout_pending — closed + records, the tenant REQUIRES a verified payout and none is recorded
 *   convert             — everything the rules require is in place
 */
export function lifetimeConversionVerdict(input: {
  closed: boolean
  requiredRecordsComplete: boolean
  payoutVerified: boolean
  requirePayoutVerified: boolean
}): { action: LifetimeConversionAction; label: string; reason: string } {
  if (!input.closed) return { action: "not_closed", label: "NOT CLOSED", reason: "the closing is not verified" }
  if (!input.requiredRecordsComplete) return { action: "hold_records", label: "CLOSED / RECORDS PENDING", reason: "the closing records are not complete" }
  if (input.requirePayoutVerified && !input.payoutVerified) {
    return { action: "hold_payout_pending", label: LIFETIME_HOLD_LABEL, reason: "this brokerage converts a customer only once the agent's payout is recorded" }
  }
  return { action: "convert", label: "LIFETIME", reason: input.requirePayoutVerified ? "closing verified, records complete, payout recorded" : "closing verified, records complete" }
}

/** PURE — the tenant's policy from brokerage_settings.settings (any shape; absent → convert at close).
 *  Exported so the settings door (app/actions/settings/brokerage-column-settings.ts) reads with the SAME parser. */
export function parseLifetimeConversionPolicy(settings: unknown): { requirePayoutVerified: boolean } {
  const s = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[LIFETIME_CONVERSION_POLICY_KEY] : null
  const requirePayoutVerified = !!(s && typeof s === "object" && (s as Record<string, unknown>).require_payout_verified === true)
  return { requirePayoutVerified }
}

/** The ONE read of the policy. A refused read is SAID (source) and the default applies — never a throw on the money rail. */
export async function readLifetimeConversionPolicy(svc: Svc, brokerageId: string): Promise<{ requirePayoutVerified: boolean; source: string }> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { requirePayoutVerified: false, source: `brokerage_settings read refused (${error.message}) — default (convert at close) applied` }
  const policy = parseLifetimeConversionPolicy((data as { settings?: unknown } | null)?.settings)
  return { ...policy, source: data ? "brokerage_settings.settings.lifetime_conversion" : "no brokerage_settings row — default (convert at close)" }
}

/** The PLATFORM DEFAULT post-close moments — the fallback when the tenant's follow-up policy cannot be read
 * (lib/ai-isa/followup-policy.ts owns the vocabulary; wave 143E). Never the schedule by itself. */
const POST_CLOSE_TOUCHPOINTS = [
  { type: "post_close_3_day",   daysAfter: 3,       channel: "video" },
  { type: "post_close_30_day",  daysAfter: 30,      channel: "sms" },
  { type: "post_close_6_month", daysAfter: 180,     channel: "email" },
  { type: "home_anniversary",   daysAfter: 365,     channel: "video" },
  { type: "referral_request",   daysAfter: 18 * 30, channel: "sms" },
] as const

export interface PromoteLifetimeResult {
  /** contacts rows the promotion matched (COUNTED — a matched-nothing update also resolves, CLAUDE.md §3). */
  promoted: number
  touchpointsScheduled: number
  /** The schedule already existed for this transaction — nothing re-inserted (no duplicate conversions). */
  skippedExistingTouchpoints: boolean
  errors: string[]
}

/**
 * THE ONE LIFETIME WRITER for a closed deal's customers. Idempotent: the contact write sets the same
 * value every time; the touchpoint schedule is inserted ONCE per transaction (an existing schedule for
 * related_transaction_id is the guard). Tenant-pinned and counted. Never throws.
 */
export async function promoteDealContactsToLifetime(
  svc: Svc,
  args: { brokerageId: string; transactionId: string; contactIds: string[]; agentRecordId: string | null; closeDate: string; nowIso?: string },
): Promise<PromoteLifetimeResult> {
  const result: PromoteLifetimeResult = { promoted: 0, touchpointsScheduled: 0, skippedExistingTouchpoints: false, errors: [] }
  const contactIds = Array.from(new Set(args.contactIds.filter(Boolean)))
  if (contactIds.length === 0) return result
  const nowIso = args.nowIso ?? new Date().toISOString()

  // 1. The contact becomes a lifetime customer — BOTH columns, deliberately (contact_type and
  //    lifecycle_state are one fact in two columns; m539 retired the cross-column CHECK, so the
  //    writer keeps the invariant — scripts/contact-vocabulary-guard.ts asserts it).
  const { data: promoted, error: promoteErr } = await svc
    .from("contacts")
    .update({ contact_type: LIFETIME_CUSTOMER_TYPE, lifecycle_state: LIFETIME_CUSTOMER_TYPE, updated_at: nowIso })
    .in("id", contactIds)
    .eq("brokerage_id", args.brokerageId)
    .select("id")
  if (promoteErr) {
    result.errors.push(`lifetime promotion REFUSED for contacts ${contactIds.join(", ")}: ${promoteErr.message}`)
  } else {
    result.promoted = (promoted ?? []).length
    if (result.promoted < contactIds.length) result.errors.push(`lifetime promotion matched ${result.promoted} of ${contactIds.length} contacts in brokerage ${args.brokerageId}`)
  }

  // 2. The post-close nurture schedule — ONCE per transaction.
  if (!args.agentRecordId) {
    result.errors.push("no agents.id to attribute the touchpoints to — schedule not written")
    return result
  }
  const { data: existing, error: existingErr } = await svc
    .from("lifetime_customer_touchpoints")
    .select("id")
    .eq("brokerage_id", args.brokerageId)
    .eq("related_transaction_id", args.transactionId)
    .limit(1)
  if (existingErr) {
    result.errors.push(`touchpoint existence read refused (${existingErr.message}) — schedule not written, never duplicated blind`)
    return result
  }
  if (existing && existing.length > 0) {
    result.skippedExistingTouchpoints = true
    return result
  }
  // Wave 143 (lane 143E, merged here): the moments come from the tenant's VERSIONED follow-up policy — not a literal
  // schedule. The arbiter decides what each moment becomes when it opens. A refused/unloadable policy keeps the
  // platform defaults above (same numbers), said in result.errors, never a silent change.
  let moments: ReadonlyArray<{ type: string; daysAfter: number; channel: string }> = POST_CLOSE_TOUCHPOINTS
  try {
    const { loadFollowupPolicy } = await import("@/lib/ai-isa/followup-policy")
    const { policy, source } = await loadFollowupPolicy(svc as any, args.brokerageId)
    if (Array.isArray(policy.postClose) && policy.postClose.length > 0) {
      moments = policy.postClose.map((m) => ({ type: m.key, daysAfter: m.afterClosingDays, channel: m.defaultChannel }))
    } else result.errors.push(`follow-up policy carries no post-close moments (${source}) — platform defaults scheduled`)
  } catch (e) {
    result.errors.push(`follow-up policy unreadable (${e instanceof Error ? e.message : String(e)}) — platform defaults scheduled`)
  }
  const closeDate = new Date(args.closeDate)
  const rows = contactIds.flatMap((contactId) =>
    moments.map((s) => {
      const d = new Date(closeDate)
      d.setDate(d.getDate() + s.daysAfter)
      return {
        brokerage_id: args.brokerageId,
        contact_id: contactId,
        agent_id: args.agentRecordId,
        touchpoint_type: s.type,
        channel: s.channel,
        scheduled_date: d.toISOString().split("T")[0],
        status: "scheduled",
        related_transaction_id: args.transactionId,
      }
    }),
  )
  // sentinelWrite READS the refusal and ledgers the loss (a lost touchpoint is a missed nudge, never the
  // conversion it follows); it returns true only when the insert landed — every row in one statement.
  if (rows.length === 0) return result
  const landed = await sentinelWrite(svc, svc.from("lifetime_customer_touchpoints").insert(rows), {
    table: "lifetime_customer_touchpoints",
    flow: "lifetime_customer_touchpoints_write",
    brokerageId: args.brokerageId,
    reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent",
  })
  result.touchpointsScheduled = landed ? rows.length : 0
  if (!landed) result.errors.push("touchpoint schedule insert refused — ledgered by the write sentinel")
  return result
}

/** Make a held conversion VISIBLE: one open activity per transaction ("CLOSED / PAYOUT PENDING"). Idempotent. */
export async function holdLifetimeConversionPendingPayout(
  svc: Svc,
  args: { brokerageId: string; transactionId: string; contactIds: string[]; agentRecordId: string | null; nowIso?: string },
): Promise<{ held: boolean; alreadyHeld: boolean; released?: boolean; error?: string }> {
  const { data: prior, error: priorErr } = await svc
    .from("activities")
    .select("id, status")
    .eq("brokerage_id", args.brokerageId)
    .eq("transaction_id", args.transactionId)
    .eq("activity_type", LIFETIME_HOLD_ACTIVITY_TYPE)
    .in("status", ["pending", "completed"])
    .limit(2)
  if (priorErr) return { held: false, alreadyHeld: false, error: priorErr.message }
  // wave 142 (lane 142K finding 2): a COMPLETED hold is the payout having already released the conversion — a re-run of
  // the close must not open a second "CLOSED / PAYOUT PENDING" that nobody will ever release (owner: no duplicate
  // conversions or accounting on a re-run). A pending one is simply already held.
  if ((prior ?? []).some((p) => (p as { status?: string }).status === "completed")) return { held: false, alreadyHeld: true, released: true }
  if (prior && prior.length > 0) return { held: true, alreadyHeld: true }
  const { error } = await svc.from("activities").insert({
    brokerage_id: args.brokerageId,
    transaction_id: args.transactionId,
    agent_id: args.agentRecordId,
    contact_id: args.contactIds[0] ?? null,
    entity_type: "transaction",
    activity_type: LIFETIME_HOLD_ACTIVITY_TYPE,
    title: `${LIFETIME_HOLD_LABEL} — lifetime conversion held`,
    description: "This brokerage converts a customer to lifetime only once the agent's payout is recorded. The conversion (and the post-close touchpoints) start the moment the payout lands.",
    status: "pending",
    priority: "medium",
    created_at: args.nowIso ?? new Date().toISOString(),
  })
  if (error) return { held: false, alreadyHeld: false, error: error.message }
  return { held: true, alreadyHeld: false }
}

/**
 * At PAYOUT: if this tenant held conversion for a verified payout, convert now (idempotent) and close
 * the hold. A tenant that converts at close is a no-op here (no second conversion, no second schedule).
 */
export async function releaseLifetimeConversionOnPayout(
  svc: Svc,
  args: { brokerageId: string; transactionId: string; actorUserId: string | null },
): Promise<{ released: boolean; reason: string; promotion?: PromoteLifetimeResult }> {
  const policy = await readLifetimeConversionPolicy(svc, args.brokerageId)
  if (!policy.requirePayoutVerified) return { released: false, reason: "policy converts at close — nothing held" }
  const { data: txn, error: txnErr } = await svc
    .from("transactions")
    .select("id, status, close_date, buyer_contact_id, seller_contact_id, agent_id")
    .eq("id", args.transactionId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  if (txnErr) return { released: false, reason: `transaction read refused: ${txnErr.message}` }
  if (!txn) return { released: false, reason: "transaction not found in this brokerage" }
  const t = txn as { status?: string | null; close_date?: string | null; buyer_contact_id?: string | null; seller_contact_id?: string | null; agent_id?: string | null }
  if ((t.status ?? "").toLowerCase() !== "closed") return { released: false, reason: `transaction is ${t.status ?? "unknown"}, not closed — conversion waits for the verified closing` }
  const verdict = lifetimeConversionVerdict({ closed: true, requiredRecordsComplete: true, payoutVerified: true, requirePayoutVerified: true })
  if (verdict.action !== "convert") return { released: false, reason: verdict.reason }
  const contactIds = [t.buyer_contact_id, t.seller_contact_id].filter((id): id is string => !!id)
  const promotion = await promoteDealContactsToLifetime(svc, {
    brokerageId: args.brokerageId,
    transactionId: args.transactionId,
    contactIds,
    agentRecordId: t.agent_id ?? null,
    closeDate: t.close_date ?? new Date().toISOString().slice(0, 10),
  })
  const nowIso = new Date().toISOString()
  const { error: holdErr } = await svc
    .from("activities")
    .update({ status: "completed", completed_at: nowIso, updated_at: nowIso })
    .eq("brokerage_id", args.brokerageId)
    .eq("transaction_id", args.transactionId)
    .eq("activity_type", LIFETIME_HOLD_ACTIVITY_TYPE)
    .eq("status", "pending")
    .select("id")
  if (holdErr) promotion.errors.push(`hold activity not completed: ${holdErr.message}`)
  return { released: true, reason: "payout recorded — lifetime conversion released", promotion }
}
