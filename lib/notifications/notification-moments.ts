/**
 * lib/notifications/notification-moments.ts
 *
 * ONE ALERT PER PERSON PER DEAL MOMENT (owner, wave 94: "accepting an offer
 * notifcation should have duplicate notification to the same person and same for
 * closing" — read, and confirmed by the integrator, as NO duplicate).
 *
 * WHAT WAS MEASURED (lane 93D2's live walk): accepting an offer rang the deal
 * agent's bell FOUR times — "Offer accepted" (OFFER_ACCEPTED), "Buyer under
 * contract" (BUYER_UNDER_CONTRACT), "Under contract: <address>" (the parties
 * packet) and "Contract Signed" (CONTRACT_SIGNED, from the listing's stage
 * transition) — and closing rang it TWICE: "Transaction closed" and "Deal Closed"
 * (closeTransactionCommand emits both spellings on purpose, because brokerages
 * hold notification_rules on each). Every one is a legitimate kernel event with
 * its own non-alert consumers (sequences, portal cards, education, lifecycle), so
 * none of the EMITS is removed. What is wrong is that each writer decided "should
 * this person be told?" alone, so the same human moment was told four times.
 *
 * THE RULE, IN ONE PLACE: the alert writers — lib/kernel/notification-engine.ts
 * (staff bells), lib/kernel/event-fanout.ts (the client's portal bell) and
 * lib/notifications/notify-helpers.ts notifyTransactionParties (both) — ask this
 * module whether the person already holds an alert for the same MOMENT of the same
 * DEAL. If they do, the event is not alerted again. The parties packet is the one
 * exception, by design: it carries the terms, dates and the deal team, which no
 * kernel-event alert does, so instead of adding a second alert it REWRITES the one
 * the person already has (one alert, the richest wording).
 *
 * The DEAL is keyed by every id an alert of that moment can carry as entity_id:
 * the transaction id (OFFER_ACCEPTED / BUYER_UNDER_CONTRACT / the packet /
 * TRANSACTION_CLOSED / DEAL_CLOSED all ride entity "transaction") and the listing
 * id (CONTRACT_SIGNED / DEAL_CLOSED from the listing stage machine, and
 * LISTING_UNDER_CONTRACT). A listing can carry a fallen-through deal and a new one,
 * so the lookup is bounded by MOMENT_WINDOW_MS — every alert of one moment is
 * written inside the same request (seconds apart); a moment of a LATER deal on the
 * same listing is hours or days away and is alerted again, correctly.
 *
 * NOT A GATE. A refused dedupe read lets the alert through (and says so): this
 * decides whether a person is told twice, never whether they are told at all, and
 * a deal-critical alert lost to a failed read is the worse failure.
 */

import { KernelEvent } from "@/lib/kernel/events"
import { PARTIES_NOTIFIED_NOTIFICATION_TYPE } from "./transaction-parties-packet"

export type NotificationMoment = "under_contract" | "closed"

/** Every notifications.type that announces each moment. One list per moment (§6). */
export const NOTIFICATION_MOMENTS: Readonly<Record<NotificationMoment, readonly string[]>> = {
  under_contract: [
    KernelEvent.OFFER_ACCEPTED,
    KernelEvent.BUYER_UNDER_CONTRACT,
    KernelEvent.CONTRACT_SIGNED,
    KernelEvent.LISTING_UNDER_CONTRACT,
    PARTIES_NOTIFIED_NOTIFICATION_TYPE,
  ],
  closed: [
    KernelEvent.TRANSACTION_CLOSED,
    KernelEvent.DEAL_CLOSED,
  ],
}

/** How far back an alert of the same moment counts as "already told". */
export const MOMENT_WINDOW_MS = 6 * 60 * 60 * 1000

/** The moment a notifications.type belongs to, or null for every other alert. */
export function momentForType(type: string | null | undefined): NotificationMoment | null {
  const t = String(type ?? "")
  for (const [moment, types] of Object.entries(NOTIFICATION_MOMENTS) as Array<[NotificationMoment, readonly string[]]>) {
    if (types.includes(t)) return moment
  }
  return null
}

/** Exactly one recipient class per lookup: a staff users.id OR a client contacts.id. */
export type MomentRecipient = { userId: string; contactId?: never } | { contactId: string; userId?: never }

type Db = { from: (table: string) => any }

/**
 * Every id an alert of this deal's moment may carry as entity_id: the event's own
 * entity, the transaction and its listing. Reads are tenant-pinned and their errors
 * READ (§3); a refused read keeps the ids already known and is logged.
 */
export async function resolveMomentDealKeys(db: Db, params: {
  brokerageId: string
  entityType: string
  entityId: string
  transactionId?: string | null
  listingId?: string | null
}): Promise<string[]> {
  const keys = new Set<string>([params.entityId, params.transactionId ?? "", params.listingId ?? ""].filter(Boolean))
  const isTransaction = params.entityType === "transaction"
  const isListing = params.entityType === "listing" || params.entityType === "listing_stage_machine"

  const txnId = params.transactionId ?? (isTransaction ? params.entityId : null)
  if (txnId) {
    const { data, error } = await db.from("transactions").select("listing_id")
      .eq("id", txnId).eq("brokerage_id", params.brokerageId).maybeSingle()
    if (error) console.error(`[notification-moments] transaction ${txnId} listing read refused: ${error.message}`)
    const listingId = (data as { listing_id?: string | null } | null)?.listing_id
    if (listingId) keys.add(listingId)
  }
  const listingId = params.listingId ?? (isListing ? params.entityId : null)
  if (listingId) {
    const { data, error } = await db.from("transactions").select("id")
      .eq("listing_id", listingId).eq("brokerage_id", params.brokerageId)
    if (error) console.error(`[notification-moments] listing ${listingId} transaction read refused: ${error.message}`)
    for (const row of (data ?? []) as Array<{ id?: string | null }>) if (row.id) keys.add(row.id)
  }
  return [...keys]
}

/**
 * The alert this person already holds for this moment of this deal, or null.
 * `refused` is set when the read failed — the caller then alerts anyway (see header).
 */
export async function findMomentAlert(db: Db, params: {
  brokerageId: string
  moment: NotificationMoment
  dealKeys: string[]
  recipient: MomentRecipient
  now?: number
}): Promise<{ id: string; type: string } | null | { refused: string }> {
  if (params.dealKeys.length === 0) return null
  const since = new Date((params.now ?? Date.now()) - MOMENT_WINDOW_MS).toISOString()
  let q = db.from("notifications").select("id, type")
    .eq("brokerage_id", params.brokerageId)
    .in("type", [...NOTIFICATION_MOMENTS[params.moment]])
    .in("entity_id", params.dealKeys)
    .gte("created_at", since)
  q = params.recipient.userId ? q.eq("user_id", params.recipient.userId) : q.eq("contact_id", params.recipient.contactId)
  const { data, error } = await q.limit(1)
  if (error) {
    console.error(`[notification-moments] dedupe read refused (${error.message}) — the alert is sent rather than lost`)
    return { refused: error.message }
  }
  const row = ((data ?? []) as Array<{ id: string; type: string }>)[0]
  return row ? { id: row.id, type: row.type } : null
}

/** True when `findMomentAlert` found a prior alert (a refused read is NOT a hit). */
export function alreadyAlerted(hit: Awaited<ReturnType<typeof findMomentAlert>>): hit is { id: string; type: string } {
  return !!hit && "id" in hit
}

/**
 * The words a person reads for each moment — human, never the kernel's key.
 * One title per moment so the surviving alert reads the same whichever event
 * landed first.
 */
export const MOMENT_TITLES: Readonly<Record<NotificationMoment, string>> = {
  under_contract: "Under contract",
  closed: "Deal closed",
}
export const MOMENT_BODIES: Readonly<Record<NotificationMoment, string>> = {
  under_contract:
    "An offer was accepted and the deal is under contract. The terms, the parties and the first deadlines are on the deal file.",
  closed:
    "The deal closed. Your client is now a lifetime customer and their post-close follow-up has started.",
}
