// lib/reputation/review-ask.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE REVIEW ASK AT CLOSING — ONE engine, one path (wave 143, lane 143E).
//
// OWNER RULING (wave 143): "A review is always asked at closing (reputation business process)." Lane brief:
// "Review request at verified closing through the reputation process: channel/consent/platform policy; no
// duplicates, no gating, no misleading incentives (prove on the close path)."
//
// WHAT THE CLOSE PATH LOOKED LIKE AT 21da8e4e (measured, not assumed) — FIVE writers of review_requests and
// two senders, none agreeing on what "already asked" means:
//   1. lib/kernel/transactions.ts closeTransactionCommand inserted a `scheduled` row for the BUYER only.
//   2. lib/transactions/stage-progression.ts (closed-stage hook) drafted a `pending` row AND wrote a reminder
//      activity a hard-coded 5 days out (ignoring the tenant's review_request_delay_days).
//   3. lib/listing-lifecycle/lifecycle-event-tasks.ts scheduleReviewRequests (transaction.closed) inserted THREE
//      `scheduled` rows — google, zillow, facebook — for one client (an ask on every platform at once).
//   4. app/api/cron/review-request-on-close was the only AUTONOMOUS sender, and it skipped any contact that had
//      ANY review_requests row — so writers 1-3 (which always ran first) made it skip every client closed through
//      them. The "always asked at closing" ask therefore never went out unless an agent clicked Send by hand.
//   5. app/actions/ai-review-automation.ts (UI) drafts on demand.
//   Senders: the cron (email, `from: "Your Agent"`, always Google) and lib/application/listing-lifecycle.ts
//   sendReviewRequestService (SMS, links `…/YOUR_GOOGLE_PLACE_ID/review` — a placeholder, to a real client).
//
// THE SHAPE NOW. This engine is the ONE path from a verified closing to a sent ask:
//   VERIFIED CLOSING  transactions.status ∈ {closed, funded} with a close_date (the ladder closed → funded) —
//                     the same close the lifetime conversion and the anniversary cron already key on.
//   WHO               the agent's CLIENT(S) on the deal: seller side → seller, buyer side → buyer, dual → both.
//   WHEN              close_date + the tenant's review_request_delay_days (lib/reputation/review-request-delay.ts).
//   NO DUPLICATES     any review_requests row for this client created on/after the close date means "asked" —
//                     except a legacy `scheduled` row nobody sent, which is ADOPTED, not duplicated. The send
//                     itself rides the action ledger's at-most-once cycle `review_ask:<tx>:<contact>` — a re-run
//                     or a race replays, it never sends twice.
//   WHERE             ONE platform: the first with a REAL link in the tenant's `reputation_profiles` policy.
//                     No real link → nothing is drafted, nothing is sent, the broker is told once.
//   WHAT              AI-drafted in the agent's voice; machine-screened for incentive / gating / rating
//                     pressure / suppression (16 CFR 465.4, 465.7; Google contributed-content policy — see
//                     review-ask-policy.ts); a draft that still fails after one repair is STAGED for the agent,
//                     never sent.
//   HOW               dispatchEmail / dispatchSms — consent, DNC, suppression, quiet hours and the autonomy gate
//                     are the dispatch gate's; this engine never decides consent. A refusal is a staged draft.
//   APPROVAL          `reputation_profiles.approval`: "auto" (default — the historical autonomous ask) or
//                     "agent_approves" (the draft waits for the agent's Send).
//
// Not server-only: scripts/intent-driven-followup-guard.ts drives it in memory with injected deps. The
// production defaults are lazy imports at the call.

import { KernelEvent } from "@/lib/kernel/events"
import { normalizeReviewRequestDelay, REVIEW_REQUEST_LOOKBACK_DAYS } from "./review-request-delay"
import {
  parseReputationProfiles,
  chooseReviewTarget,
  chooseReviewChannel,
  screenReviewAskCopy,
  reviewAskDueAt,
  type ReviewAskChannel,
  type ReviewAskViolation,
  type AskableReviewPlatform,
} from "./review-ask-policy"

type Svc = { from: (table: string) => any }

const DAY_MS = 86_400_000
/** The ladder closed → funded: both are past the closing table (the lifetime cron keys on the same pair). */
const VERIFIED_CLOSING_STATUSES: readonly string[] = ["closed", "funded"]

export type ReviewAskSkipReason =
  | "transaction_not_found" | "not_closed" | "no_close_date" | "not_due" | "aged_out" | "no_client_contact"
  | "already_asked" | "contact_not_found" | "no_channel" | "no_review_link" | "settings_unreadable"

export type ReviewAskResult =
  | { status: "sent"; contactId: string; reviewRequestId: string; channel: ReviewAskChannel; platform: AskableReviewPlatform; messageId?: string }
  | { status: "staged"; contactId: string; reviewRequestId: string; why: "agent_approves" | "copy_flagged" | "send_refused"; detail: string }
  | { status: "skipped"; contactId?: string; reason: ReviewAskSkipReason; detail?: string; dueAt?: string }
  | { status: "error"; contactId?: string; error: string }

export interface ReviewAskRun { transactionId: string; results: ReviewAskResult[] }

interface DraftOutcome {
  success: boolean
  error?: string
  code?: string
  message?: string
  data?: { subject?: string }
  reviewRequestId?: string
  reviewUrl?: string
  platform?: AskableReviewPlatform
  violations?: ReviewAskViolation[]
}

export interface ReviewAskDeps {
  now?: () => Date
  draft?: (svc: Svc, input: { brokerageId: string; transactionId: string; agentId: string; contactId: string; platform: AskableReviewPlatform; channel: "email" | "text"; existingRequestId?: string }) => Promise<DraftOutcome>
  dispatchEmail?: (p: Record<string, unknown>) => Promise<{ success: boolean; error?: string; messageId?: string }>
  dispatchSms?: (p: Record<string, unknown>) => Promise<{ success: boolean; error?: string; messageId?: string }>
  emit?: (input: Record<string, unknown>) => Promise<unknown>
  /** Tell the agent (users.id resolved from agents.id by the caller of this dep). */
  notifyAgent?: (svc: Svc, a: { brokerageId: string; agentId: string; type: string; title: string; body: string; contactId: string }) => Promise<void>
  notifyBrokerageAdmins?: (svc: Svc, brokerageId: string, n: { type: string; title: string; body: string }) => Promise<unknown>
}

/** PURE. The agent's client contact(s) on a deal: seller side → seller, buyer side → buyer, dual → both. */
function reviewClientContactIds(tx: { deal_type?: string | null; buyer_contact_id?: string | null; seller_contact_id?: string | null; contact_id?: string | null }): string[] {
  const buyer = tx.buyer_contact_id ?? null
  const seller = tx.seller_contact_id ?? null
  const primary = tx.contact_id ?? null
  let ids: Array<string | null>
  switch ((tx.deal_type ?? "").toLowerCase()) {
    case "seller": ids = [seller ?? primary]; break
    case "buyer": ids = [buyer ?? primary]; break
    case "dual": ids = [buyer, seller].filter(Boolean).length > 0 ? [buyer, seller] : [primary]; break
    default: ids = [primary ?? buyer ?? seller]
  }
  return [...new Set(ids.filter((x): x is string => !!x))]
}

/** PURE. Is this transaction a verified closing that is DUE for the ask at `now`? */
function reviewAskTiming(
  tx: { status?: string | null; close_date?: string | null },
  delayDays: number,
  now: Date,
): { due: true; dueAt: Date } | { due: false; reason: Extract<ReviewAskSkipReason, "not_closed" | "no_close_date" | "not_due" | "aged_out">; dueAt?: Date } {
  if (!VERIFIED_CLOSING_STATUSES.includes((tx.status ?? "").toLowerCase())) return { due: false, reason: "not_closed" }
  if (!tx.close_date) return { due: false, reason: "no_close_date" }
  const closeMs = new Date(tx.close_date).getTime()
  if (Number.isNaN(closeMs)) return { due: false, reason: "no_close_date" }
  const dueAt = reviewAskDueAt(tx.close_date, delayDays)
  if (now < dueAt) return { due: false, reason: "not_due", dueAt }
  if (now.getTime() - closeMs > REVIEW_REQUEST_LOOKBACK_DAYS * DAY_MS) return { due: false, reason: "aged_out", dueAt }
  return { due: true, dueAt }
}

async function defaultDeps(deps: ReviewAskDeps): Promise<Required<ReviewAskDeps>> {
  return {
    now: deps.now ?? (() => new Date()),
    draft: deps.draft ?? (async (svc, input) => (await import("./review-request-draft")).draftReviewRequest(svc, input) as Promise<DraftOutcome>),
    dispatchEmail: deps.dispatchEmail ?? (async (p) => (await import("@/lib/providers/dispatch")).dispatchEmail(p as never)),
    dispatchSms: deps.dispatchSms ?? (async (p) => (await import("@/lib/providers/dispatch")).dispatchSms(p as never)),
    emit: deps.emit ?? (async (i) => (await import("@/lib/kernel/emit")).emitKernelEvent(i as never)),
    notifyAgent: deps.notifyAgent ?? (async (svc, a) => {
      const { data: agent } = await svc.from("agents").select("user_id").eq("id", a.agentId).eq("brokerage_id", a.brokerageId).maybeSingle()
      const userId = (agent as { user_id?: string | null } | null)?.user_id
      if (!userId) return
      const { error } = await svc.from("notifications").insert({
        user_id: userId, brokerage_id: a.brokerageId, type: a.type, title: a.title.slice(0, 200), body: a.body.slice(0, 480),
        entity_type: "contact", entity_id: a.contactId, priority: "medium", is_read: false,
      })
      if (error) console.error(`[review-ask] agent notification not written (${a.type}): ${error.message}`)
    }),
    notifyBrokerageAdmins: deps.notifyBrokerageAdmins ?? (async (svc, b, n) => (await import("@/lib/notifications/brokerage-admins")).notifyBrokerageAdmins(svc as never, b, n)),
  }
}

/** The message the contact receives: the drafted text, guaranteed to carry the ONE link (an SMS keeps it short). */
function composeReviewAskBody(message: string, url: string, channel: ReviewAskChannel): string {
  const text = message.trim()
  return text.includes(url) ? text : channel === "sms" ? `${text.slice(0, 220)} ${url}`.trim() : `${text}\n\n${url}`
}

/**
 * Ask the agent's client(s) on ONE transaction for a review — or say precisely why not. Idempotent: calling it
 * again for the same closing returns `already_asked` / replays, it never asks twice. Tenant-pinned on every read.
 * Never throws; every refusal is a result.
 */
export async function askForReviewAtClose(
  svc: Svc,
  args: { brokerageId: string; transactionId: string; source?: "cron" | "system" },
  depsIn: ReviewAskDeps = {},
): Promise<ReviewAskRun> {
  const deps = await defaultDeps(depsIn)
  const run: ReviewAskRun = { transactionId: args.transactionId, results: [] }
  const push = (r: ReviewAskResult) => { run.results.push(r); return run }
  if (!args.brokerageId) return push({ status: "error", error: "no brokerageId — the tenant is pinned from the transaction row, never guessed" })

  const { data: tx, error: txError } = await svc
    .from("transactions")
    .select("id, brokerage_id, agent_id, status, close_date, deal_type, contact_id, buyer_contact_id, seller_contact_id")
    .eq("id", args.transactionId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  if (txError) return push({ status: "error", error: `transaction read refused: ${txError.message}` })
  if (!tx) return push({ status: "skipped", reason: "transaction_not_found", detail: "no such transaction in this brokerage" })

  // The tenant's delay + policy in ONE read. A refused read refuses the ask — it must not send on the default day.
  const { data: settingsRow, error: settingsError } = await svc
    .from("brokerage_settings")
    .select("review_request_delay_days, settings")
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  if (settingsError) return push({ status: "skipped", reason: "settings_unreadable", detail: settingsError.message })
  const delayDays = normalizeReviewRequestDelay((settingsRow as { review_request_delay_days?: unknown } | null)?.review_request_delay_days)
  const profiles = parseReputationProfiles((settingsRow as { settings?: unknown } | null)?.settings)

  const now = deps.now()
  const timing = reviewAskTiming(tx, delayDays, now)
  if (!timing.due) return push({ status: "skipped", reason: timing.reason, ...(timing.dueAt ? { dueAt: timing.dueAt.toISOString() } : {}) })

  const clientIds = reviewClientContactIds(tx)
  if (clientIds.length === 0) return push({ status: "skipped", reason: "no_client_contact", detail: "the transaction names no client contact" })
  if (!tx.agent_id) return push({ status: "skipped", reason: "no_client_contact", detail: "the transaction has no agent to ask on behalf of" })
  const agentId = tx.agent_id as string
  const closeIso = new Date(tx.close_date as string).toISOString()

  const target = chooseReviewTarget(profiles, agentId)

  for (const contactId of clientIds) {
    try {
      // NO DUPLICATES — any request for this client since the close date. A legacy `scheduled` row nobody sent is adopted.
      const { data: prior, error: priorError } = await svc
        .from("review_requests")
        .select("id, status, sent_at, platform")
        .eq("brokerage_id", args.brokerageId)
        .eq("contact_id", contactId)
        .gte("created_at", closeIso)
      if (priorError) { push({ status: "error", contactId, error: `review_requests read refused — not asking blind: ${priorError.message}` }); continue }
      const rows = (prior ?? []) as Array<{ id: string; status: string | null; sent_at: string | null }>
      const asked = rows.find((r) => r.status !== "scheduled" || r.sent_at)
      if (asked) { push({ status: "skipped", contactId, reason: "already_asked", detail: `request ${asked.id} (${asked.status ?? "?"})` }); continue }
      const adoptable = rows.find((r) => r.status === "scheduled" && !r.sent_at) ?? null

      const { data: contact, error: contactError } = await svc
        .from("contacts")
        .select("id, first_name, last_name, email, phone, preferred_channel, tcpa_consent, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, dnc_status")
        .eq("id", contactId)
        .eq("brokerage_id", args.brokerageId)
        .maybeSingle()
      if (contactError) { push({ status: "error", contactId, error: `contact read refused: ${contactError.message}` }); continue }
      if (!contact) { push({ status: "skipped", contactId, reason: "contact_not_found", detail: "the client is not in this brokerage" }); continue }

      const channel = chooseReviewChannel(contact)
      if (!channel) { push({ status: "skipped", contactId, reason: "no_channel", detail: "no usable, permitted channel on file" }); continue }

      if (!target) {
        // Fail closed: no real link ⇒ no draft, no spend, no send. The broker is told ONCE (an unread alert is the dedupe).
        const { data: open } = await svc.from("notifications").select("id").eq("brokerage_id", args.brokerageId).eq("type", "review_link_missing").eq("is_read", false).limit(1)
        if (!open || open.length === 0) {
          await deps.notifyBrokerageAdmins(svc, args.brokerageId, {
            type: "review_link_missing",
            title: "Add your review link — closings are waiting for a review request",
            body: "A client closed and a review request is due, but no real Google/Zillow/Realtor.com review link is set. Add it on the Referrals page (\"Where review requests point\") and the request goes out on its own.",
          })
        }
        push({ status: "skipped", contactId, reason: "no_review_link", detail: profiles.rejected.length ? `rejected: ${profiles.rejected.map((r) => `${r.where} (${r.reason})`).join("; ")}` : "no link configured" })
        continue
      }

      const drafted = await deps.draft(svc, {
        brokerageId: args.brokerageId, transactionId: args.transactionId, agentId, contactId,
        platform: target.platform, channel: channel === "sms" ? "text" : "email",
        ...(adoptable ? { existingRequestId: adoptable.id } : {}),
      })
      if (!drafted.success || !drafted.reviewRequestId || !drafted.message) {
        push(drafted.code === "no_review_link"
          ? { status: "skipped", contactId, reason: "no_review_link", detail: drafted.error }
          : { status: "error", contactId, error: drafted.error ?? "the review request could not be drafted" })
        continue
      }
      const reviewRequestId = drafted.reviewRequestId

      // The screen re-runs here on what will ACTUALLY be sent — the draft core's screen is advisory, this is the gate.
      const violations = screenReviewAskCopy({ subject: drafted.data?.subject, body: drafted.message })
      if (violations.length > 0) {
        await deps.notifyAgent(svc, { brokerageId: args.brokerageId, agentId, contactId, type: "review_request_flagged", title: "A review request needs your edit before it can go", body: `The drafted ask was held back (${violations.map((v) => v.code).join(", ")}). Review it, reword it, and send it yourself.` })
        push({ status: "staged", contactId, reviewRequestId, why: "copy_flagged", detail: violations.map((v) => `${v.code}:${v.match}`).join("; ") })
        continue
      }
      if (profiles.approval === "agent_approves") {
        await deps.notifyAgent(svc, { brokerageId: args.brokerageId, agentId, contactId, type: "review_request_ready", title: "Review request ready to send", body: "Your brokerage asks you to approve each review request. The draft is ready in Reputation." })
        push({ status: "staged", contactId, reviewRequestId, why: "agent_approves", detail: "tenant policy reputation_profiles.approval = agent_approves" })
        continue
      }

      const body = composeReviewAskBody(drafted.message, target.url, channel)
      const subject = drafted.data?.subject?.trim() || "How was your experience?"
      const ledger = {
        reasonCode: "LIFETIME_TOUCH",
        reasonDetail: `post-closing review request via ${target.platform} (${target.scope} link)`,
        cycle: `review_ask:${args.transactionId}:${contactId}`,
        subject: { type: "transaction" as const, id: args.transactionId },
        detail: { review_request_id: reviewRequestId, platform: target.platform, transaction_id: args.transactionId },
        policyKey: "reputation_profiles",
      }
      const common = { brokerageId: args.brokerageId, contactId, agentId, managerKey: "sphere_of_influence", systemSource: "review_automation", metadata: { transactionId: args.transactionId, platform: target.platform, reviewRequestId } }
      const sent = channel === "email"
        ? await deps.dispatchEmail({ ...common, ledger, to: contact.email, subject, html: body.replace(/\n/g, "<br>"), text: body, channelPurpose: "update" })
        : await deps.dispatchSms({ ...common, ledger, to: contact.phone, message: body })
      if (!sent.success) {
        push({ status: "staged", contactId, reviewRequestId, why: "send_refused", detail: sent.error ?? "the send gate refused" })
        continue
      }

      const { data: marked, error: markError } = await svc
        .from("review_requests")
        .update({ status: "sent", sent_at: now.toISOString(), review_url: target.url, platform: target.platform })
        .eq("id", reviewRequestId)
        .eq("brokerage_id", args.brokerageId)
        .select("id")
      // The message is OUT. A row that is not marked sent would be re-sent — but the ledger cycle replays, so the
      // honest failure is a logged one, not an unsend.
      if (markError || !marked || marked.length !== 1) console.error(`[review-ask] request ${reviewRequestId} sent but NOT marked sent (${markError?.message ?? `matched ${marked?.length ?? 0} rows`}); the ledger cycle prevents a second send`)
      try {
        await deps.emit({
          event: KernelEvent.REVIEW_REQUEST_SENT, brokerageId: args.brokerageId, entityType: "review_request", entityId: reviewRequestId, contactId,
          source: args.source ?? "system", metadata: { platform: target.platform, channel, transaction_id: args.transactionId },
          dedupeKey: `review_ask:${args.transactionId}:${contactId}`, dedupeWindowSec: 86_400 * 7, client: svc,
        })
      } catch (e) { console.error("[review-ask] REVIEW_REQUEST_SENT emit failed:", e instanceof Error ? e.message : e) }
      push({ status: "sent", contactId, reviewRequestId, channel, platform: target.platform, messageId: sent.messageId })
    } catch (e) {
      push({ status: "error", contactId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return run
}
