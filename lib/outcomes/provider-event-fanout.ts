/**
 * lib/outcomes/provider-event-fanout.ts
 *
 * THE OTHER HALF OF THE ENGAGEMENT LOOP.
 *
 * The SendGrid Event Webhook has been landing opens and clicks in
 * `email_tracking` for a while, and the Twilio status callback has been landing
 * carrier truth in the reconciliation ledger. Neither ever walked BACK to the
 * per-send ledger that recorded the outbound. So every one of these was read on
 * a live surface and written by nobody:
 *
 *   newsletter_sends.opened_at / .clicked_at        — the marketing agent's
 *       realized_open_rate, its per-persona breakdown, and the content-intel
 *       aggregator all count these. All three measured a permanent zero, which
 *       is why plan_quality_score could never exceed the 30 points awarded for
 *       merely shipping, and why the `content_winner` manager signal has never
 *       fired for any brokerage.
 *   sequence_step_executions.opened_at              — the decision receipts
 *       trail an agent reads before deciding what to send next.
 *   open_house_invitations.opened_at / .clicked_at  — the listing Marketing tab.
 *   email_tracking.email_send_id                    — the bundle-attribution
 *       rollup's email leg (its own comment says "dispatchEmail stores the
 *       provider id on email_sends.provider_message_id"; it did not, so that
 *       leg counted zero engagement for every dispatch ever measured).
 *   message_provider_logs.event_at                  — see below.
 *
 * A provider-reported time is NOT the same fact as our own send time, and that
 * distinction is the whole reason `message_provider_logs` carries both columns.
 * `sent_at` is when WE handed the message over. `event_at` is when the PROVIDER
 * said something happened to it. app/actions/system-health.ts:534 already
 * documents that nothing wrote the second one and widened its window to survive
 * — so the delivery rate on the health board is computed purely from what the
 * sender CLAIMED, never from what the carrier reported. This module is the
 * writer that comment was waiting for.
 *
 * CORRELATION IS EXACT, NEVER FUZZY. Every stamp here keys on a provider
 * message id that this OS itself stored at send time. An id we never stored
 * matches nothing and no-ops — which is correct: a console test or another
 * environment sharing the provider account must never mark one of our rows as
 * opened.
 *
 * REFUSALS ARE NOT ZEROES. supabase-js RESOLVES a refused update, so a
 * `{ opened: 0 }` from an RLS refusal is byte-identical to a genuine "nobody
 * opened it". Every write below is destructured, `.select()`ed and counted, and
 * a refusal is returned in `refusals` so the caller can say WHICH ledger went
 * unwritten instead of publishing a clean zero.
 */

import "server-only"

type Svc = {
  from: (table: string) => any
}

/** open/click are the only email engagement events that have a per-send home. */
export type EngagementKind = "open" | "click"

export interface FanoutResult {
  /** rows stamped, per ledger */
  newsletterSends: number
  sequenceSteps: number
  openHouseInvitations: number
  messageProviderLogs: number
  /** email_sends.id resolved from the provider id, for email_tracking.email_send_id */
  emailSendId: string | null
  /** Ledgers whose write was REFUSED — never fold these into the zeroes above. */
  refusals: string[]
}

function emptyResult(): FanoutResult {
  return {
    newsletterSends: 0,
    sequenceSteps: 0,
    openHouseInvitations: 0,
    messageProviderLogs: 0,
    emailSendId: null,
    refusals: [],
  }
}

/**
 * Stamp the PROVIDER'S OWN event time onto the dispatch audit row.
 *
 * Shared by every truth channel that already exists — sendgrid-events,
 * twilio-sms-status, lob-events — because they all hold the same two facts (a
 * provider message id and a provider-stamped time) and `message_provider_logs`
 * is the one table that records a dispatch per channel.
 *
 * `brokerageId` narrows the update when the caller resolved a tenant. It is
 * OPTIONAL rather than required on purpose: a provider id we minted is already
 * an exact key, and refusing to record truth because the tenant lookup missed
 * would leave the audit row permanently claiming a send nobody ever confirmed.
 * When it IS known it is applied, because Twilio subaccounts under one master
 * account mean "globally unique sid" is not by itself a tenancy boundary.
 */
export async function recordProviderEventOnLog(
  svc: Svc,
  args: {
    providerMessageId: string
    providerEvent: string
    providerStatus?: string | null
    at?: string | null
    brokerageId?: string | null
  },
): Promise<{ updated: number; refusal: string | null }> {
  const id = (args.providerMessageId ?? "").trim()
  if (!id) return { updated: 0, refusal: null }

  // EVERY COLUMN NAMED, TWICE, RATHER THAN ONE OBJECT BUILT BY MUTATION.
  // A `Record<string, unknown>` assembled with conditional keys is opaque to
  // every static scanner in this repo, and an opaque write does not merely hide
  // these columns — it makes the whole TABLE invisible to the writer-less
  // census, so a genuine gap elsewhere on it would read as closed. The two arms
  // differ only in whether the provider reported a status: an engagement event
  // must not blank the 'failed' a previous delivery event recorded.
  const eventAt = args.at ?? new Date().toISOString()
  let q = args.providerStatus
    ? svc.from("message_provider_logs").update({
        event_at: eventAt,
        provider_event: args.providerEvent,
        provider_status: args.providerStatus,
      }).eq("provider_message_id", id)
    : svc.from("message_provider_logs").update({
        event_at: eventAt,
        provider_event: args.providerEvent,
      }).eq("provider_message_id", id)
  if (args.brokerageId) q = q.eq("brokerage_id", args.brokerageId)
  const { data, error } = await q.select("id")
  if (error) return { updated: 0, refusal: `message_provider_logs: ${error.message}` }
  return { updated: (data ?? []).length, refusal: null }
}

/**
 * Walk one email engagement event back to every per-send ledger that recorded
 * the outbound under the same provider message id.
 *
 * Deliberately does NOT advance `sequence_step_executions.status` to 'opened'.
 * That column is the channel-order learner's denominator
 * (lib/campaign-sequences/channel-order-runner.ts:41 counts rows whose status
 * is exactly 'sent'), so promoting an opened step would DELETE it from the very
 * sample that is supposed to prove the channel works. The timestamp is the
 * fact; the status stays the dispatch outcome.
 *
 * `newsletter_sends.status` IS promoted, because that vocabulary carries
 * 'opened'/'clicked' and publish-newsletters' idempotency guard already treats
 * both as "this campaign already went to this contact".
 */
export async function fanOutEmailEngagement(
  svc: Svc,
  args: {
    providerMessageId: string
    kind: EngagementKind
    at?: string | null
    brokerageId?: string | null
  },
): Promise<FanoutResult> {
  const out = emptyResult()
  const id = (args.providerMessageId ?? "").trim()
  if (!id) return out
  const at = args.at ?? new Date().toISOString()
  const isOpen = args.kind === "open"

  // ── newsletter_sends ──────────────────────────────────────────────────────
  // publish-newsletters stores result.messageId here already; this is the read
  // side that never existed.
  //
  // The open and click arms are written out in full rather than through a
  // `{ [tsColumn]: at }` computed key. A computed key is invisible to every
  // static scanner in this repo — and worse than invisible: a table with one
  // opaque write object is EXCLUDED from the writer-less census entirely, so a
  // column that still has no writer would silently read as closed. Duplicating
  // four lines is the price of the finding staying honest.
  {
    let q = isOpen
      ? svc.from("newsletter_sends").update({ opened_at: at, status: "opened" }).eq("provider_message_id", id)
      : svc.from("newsletter_sends").update({ clicked_at: at, status: "clicked" }).eq("provider_message_id", id)
    if (args.brokerageId) q = q.eq("brokerage_id", args.brokerageId)
    const { data, error } = await q.select("id")
    if (error) out.refusals.push(`newsletter_sends: ${error.message}`)
    else out.newsletterSends = (data ?? []).length
  }

  // ── sequence_step_executions ─────────────────────────────────────────────
  // Only the OPEN half has a home here: the table has opened_at and replied_at
  // and no clicked_at, so a click is recorded as the open it implies rather
  // than invented into a column that does not exist.
  {
    let q = svc
      .from("sequence_step_executions")
      .update({ opened_at: at })
      .eq("provider_message_id", id)
      .is("opened_at", null)
    if (args.brokerageId) q = q.eq("brokerage_id", args.brokerageId)
    const { data, error } = await q.select("id")
    if (error) out.refusals.push(`sequence_step_executions: ${error.message}`)
    else out.sequenceSteps = (data ?? []).length
  }

  // ── open_house_invitations ───────────────────────────────────────────────
  // The column is `message_id`, not provider_message_id — this table predates
  // that spelling and renaming it is a migration, not a lane.
  {
    let q = isOpen
      ? svc.from("open_house_invitations").update({ opened_at: at }).eq("message_id", id)
      : svc.from("open_house_invitations").update({ clicked_at: at }).eq("message_id", id)
    if (args.brokerageId) q = q.eq("brokerage_id", args.brokerageId)
    const { data, error } = await q.select("id")
    if (error) out.refusals.push(`open_house_invitations: ${error.message}`)
    else out.openHouseInvitations = (data ?? []).length
  }

  // ── email_sends → the id email_tracking has been leaving NULL ────────────
  {
    let q = svc.from("email_sends").select("id").eq("provider_message_id", id)
    if (args.brokerageId) q = q.eq("brokerage_id", args.brokerageId)
    const { data, error } = await q.limit(1).maybeSingle()
    if (error) out.refusals.push(`email_sends: ${error.message}`)
    else out.emailSendId = (data as { id: string } | null)?.id ?? null
  }

  // ── the dispatch audit row ───────────────────────────────────────────────
  {
    const r = await recordProviderEventOnLog(svc, {
      providerMessageId: id,
      providerEvent: args.kind,
      // An open is not a delivery status; it is an engagement event. Leaving
      // provider_status alone keeps 'sent'/'failed' meaning what the five
      // inserters wrote (app/actions/system-health.ts aggregates exactly that
      // vocabulary).
      providerStatus: null,
      at,
      brokerageId: args.brokerageId ?? null,
    })
    out.messageProviderLogs = r.updated
    if (r.refusal) out.refusals.push(r.refusal)
  }

  return out
}

/**
 * A CONTACT REPLIED — close the loop on the sequence step that prompted it.
 *
 * `sequence_step_executions.replied_at` is what
 * lib/campaign-sequences/channel-order-runner.ts turns into a per-channel reply
 * RATE, and what lib/intelligence/predictor-outcome-resolver.ts resolves
 * predictions against. Nothing wrote it, so every channel scored a 0% reply
 * rate and the advisory ("lead with SMS — it earns 2× the replies here") could
 * only ever rank channels that were all tied at zero.
 *
 * Correlation is by CONTACT + CHANNEL + RECENCY, not by provider id, and that
 * is not a shortcut: an inbound reply carries the provider's id for the INBOUND
 * message, which has no relationship to the id of the outbound it answers.
 * Email has no reply-threading id stored on the step row either. So the honest
 * rule is the narrowest one that can be true: the contact's most recent step on
 * the same channel that actually went out, inside a bounded window, that has
 * not already been credited with a reply. A second reply to the same touch does
 * not double-count, and a reply arriving out of the blue months later credits
 * nothing.
 */
export async function recordSequenceReply(
  svc: Svc,
  args: {
    brokerageId: string
    contactId: string
    channel: string
    at?: string | null
    windowDays?: number
  },
): Promise<{ updated: number; refusal: string | null }> {
  if (!args.brokerageId || !args.contactId || !args.channel) return { updated: 0, refusal: null }
  const at = args.at ?? new Date().toISOString()
  const since = new Date(Date.now() - (args.windowDays ?? 30) * 86_400_000).toISOString()

  const { data: candidate, error: readError } = await svc
    .from("sequence_step_executions")
    .select("id")
    .eq("brokerage_id", args.brokerageId)
    .eq("contact_id", args.contactId)
    .eq("channel", args.channel)
    .eq("status", "sent")
    .is("replied_at", null)
    .not("sent_at", "is", null)
    .gte("sent_at", since)
    .lte("sent_at", at)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (readError) return { updated: 0, refusal: `sequence_step_executions read: ${readError.message}` }
  const row = candidate as { id: string } | null
  if (!row) return { updated: 0, refusal: null }

  // Count the rows the UPDATE actually matched. A tenant predicate that refuses
  // resolves with error null and an empty array — indistinguishable from a
  // successful write unless it is counted (CLAUDE.md §3).
  const { data: updated, error: writeError } = await svc
    .from("sequence_step_executions")
    .update({ replied_at: at })
    .eq("id", row.id)
    .eq("brokerage_id", args.brokerageId)
    .select("id")
  if (writeError) return { updated: 0, refusal: `sequence_step_executions: ${writeError.message}` }
  return { updated: (updated ?? []).length, refusal: null }
}
