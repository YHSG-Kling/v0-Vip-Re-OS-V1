/**
 * lib/credit/credit-event-handlers.ts — THE credit-copilot event reactions and
 * THE ONE credit_partner_referrals writer, callable with no session (lane 86F,
 * wave 86).
 *
 * THE DEFECT. lib/orchestrator/internal.ts EVENT_HANDLERS routed
 * credit.target_reached / credit.partner_referred (DISPATCHED) and
 * credit.status_updated (recorded) to app/actions/credit-copilot.ts's "use
 * server" exports handleTargetReached / handlePartnerReferral /
 * handlePartnerStatusUpdate. All three built the COOKIE client; the orchestrator
 * dispatches from cron and from logEventAndTrigger's registered dispatcher
 * (webhooks) with no cookie, so the contact update matched nothing, the
 * recipient lookup read nothing and no notification, task or referral row was
 * written — each returning `{ success: true }`. handleTargetReached's contacts
 * UPDATE also carried NO tenant predicate at all (an id from the payload was the
 * whole WHERE clause), and all three were public endpoints taking `user_id` and
 * `contact_id` from the browser.
 *
 * THE SHAPE (template lib/transactions/dotloop-document-sync.ts): server-only,
 * client-injected; the tenant is handed in — the EVENT row's brokerage_id from
 * the orchestrator, the SESSION's from referToCreditPartner — and every read and
 * write is pinned to it. The actor named by the event (payload.user_id, else the
 * row's user_id) is PROVEN in the tenant before anything is written for them:
 * users.brokerage_id for the notification (lib/notifications/recipient-tenant.ts,
 * the one resolver the bell compares against) and agents(user_id, brokerage_id)
 * for the task (users.id and agents.id are disjoint, §3 — resolved, never
 * substituted). Every write is COUNTED and returned.
 *
 * THE MERGE (§1.1). handlePartnerReferral was a DUPLICATE of
 * app/actions/credit-copilot.ts::referToCreditPartner (its own header said so and
 * named that one the survivor). Both now write through
 * recordCreditPartnerReferral below — the survivor's checks (contact AND partner
 * in the tenant, partner_name denormalised from the verified partner row, the
 * follow-up task) became the ONE body, and the duplicate is deleted.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import { resolveRecipientBrokerageId } from "@/lib/notifications/recipient-tenant"

export interface CreditEventOutcome {
  success: boolean
  written: string[]
  skipped: string[]
  error?: string
}

/** The agents row for a users.id INSIDE the tenant — null when there is none. */
async function agentInTenant(client: any, brokerageId: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const { data, error } = await client
    .from("agents").select("id").eq("user_id", userId).eq("brokerage_id", brokerageId).limit(1)
  if (error) throw new Error(`Agent lookup refused: ${error.message}`)
  return ((data ?? [])[0]?.id as string | undefined) ?? null
}

/** The contact must be the tenant's (a refused read is not "absent", §3). */
async function contactInTenant(client: any, brokerageId: string, contactId: string | null | undefined): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!contactId) return { ok: false, error: "No contact_id on the credit event" }
  const { data, error } = await client
    .from("contacts").select("id").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { ok: false, error: `Contact read refused: ${error.message}` }
  if (!data) return { ok: false, error: `Contact ${contactId} is not in brokerage ${brokerageId}` }
  return { ok: true }
}

interface NotificationFields {
  type: string
  title: string
  body: string
  entity_type: string
  entity_id: string
  priority?: "low" | "medium" | "high"
}

/** One notifications row for the recipient — only when the recipient's own
 *  users.brokerage_id IS the tenant (the value the bell compares against). */
async function notifyInTenant(
  client: any,
  brokerageId: string,
  userId: string | null | undefined,
  row: NotificationFields,
  out: CreditEventOutcome,
): Promise<void> {
  if (!userId) { out.skipped.push("notification: no recipient on the event"); return }
  const tenant = await resolveRecipientBrokerageId(client, userId)
  if (!tenant.ok) { out.skipped.push(`notification: ${tenant.reason}`); return }
  if (tenant.brokerageId !== brokerageId) {
    out.skipped.push(`notification: recipient ${userId} is not in brokerage ${brokerageId}`)
    return
  }
  // The row is written as an EXPLICIT literal — never `{ ...row, … }` — so the tenant stamp
  // is provable at the write (scripts/ai-insight-tenant-guard.ts cannot see through a spread).
  const { data, error } = await client.from("notifications").insert({
    user_id: userId,
    brokerage_id: brokerageId,
    type: row.type,
    title: row.title,
    body: row.body,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    priority: row.priority ?? "medium",
  }).select("id").maybeSingle()
  if (error || !data) out.skipped.push(`notification refused: ${error?.message ?? "no row returned"}`)
  else out.written.push("notification")
}

async function taskForAgent(
  client: any,
  brokerageId: string,
  userId: string | null | undefined,
  row: Record<string, unknown>,
  out: CreditEventOutcome,
): Promise<void> {
  // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5).
  const agentId = await agentInTenant(client, brokerageId, userId)
  if (!agentId) { out.skipped.push(`task: user ${userId ?? "(none)"} holds no agents row in this brokerage`); return }
  const { data, error } = await client
    .from("tasks").insert({ ...row, brokerage_id: brokerageId, assigned_to_agent_id: agentId }).select("id").maybeSingle()
  if (error || !data) out.skipped.push(`task refused: ${error?.message ?? "no row returned"}`)
  else out.written.push("task")
}

const outcome = (): CreditEventOutcome => ({ success: true, written: [], skipped: [] })

/** credit.status_updated (recorded in EVENT_HANDLERS; the switch's local handler is in force). */
export async function reactToCreditPartnerStatus(
  client: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<CreditEventOutcome> {
  const out = outcome()
  if (!brokerageId) return { ...out, success: false, error: "No brokerageId — credit events are never acted on untenanted" }
  const contact = await contactInTenant(client, brokerageId, payload?.contact_id)
  if (!contact.ok) return { ...out, success: false, error: contact.error }
  const userId = payload?.user_id ?? actorUserId ?? null
  await notifyInTenant(client, brokerageId, userId, {
    type: "partner_status_update",
    title: "Partner Status Updated",
    body: `Credit partner status changed from ${payload?.old_status ?? "unknown"} to ${payload?.new_status ?? "unknown"}.`,
    entity_type: "contact",
    entity_id: payload.contact_id,
  }, out)
  if (payload?.new_status === "approved") {
    await taskForAgent(client, brokerageId, userId, {
      contact_id: payload.contact_id,
      title: "Schedule credit program kickoff",
      due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      priority: "high",
    }, out)
  }
  return out
}

/** credit.target_reached — DISPATCHED. */
export async function reactToCreditTargetReached(
  client: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<CreditEventOutcome> {
  const out = outcome()
  if (!brokerageId) return { ...out, success: false, error: "No brokerageId — credit events are never acted on untenanted" }
  const contactId = payload?.contact_id
  const contact = await contactInTenant(client, brokerageId, contactId)
  if (!contact.ok) return { ...out, success: false, error: contact.error }

  // The update carries the tenant ON THE PREDICATE and is counted.
  const { data: updated, error: updErr } = await client
    .from("contacts")
    .update({ credit_status: "good", credit_pipeline_stage: "target_score_reached" })
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .select("id")
  if (updErr) return { ...out, success: false, error: `Contact credit update refused: ${updErr.message}` }
  if (!updated?.length) return { ...out, success: false, error: `Contact credit update matched no row in brokerage ${brokerageId}` }
  out.written.push("contact")

  const userId = payload?.user_id ?? actorUserId ?? null
  await notifyInTenant(client, brokerageId, userId, {
    type: "credit_target_reached",
    title: "Client Reached Credit Target!",
    body: `Your client reached their target credit score of ${payload?.target_score ?? "their goal"}. Time to re-engage for home buying!`,
    entity_type: "contact",
    entity_id: contactId,
    priority: "high",
  }, out)
  await taskForAgent(client, brokerageId, userId, {
    contact_id: contactId,
    title: "Re-engage client for home buying",
    description: "Client has reached target credit score and is ready to start looking at homes!",
    due_date: new Date().toISOString(),
    priority: "urgent",
  }, out)
  return out
}

export interface CreditPartnerReferralInput {
  contactId: string
  partnerId: string
  /** users.id of the referring person — credit_partner_referrals.referring_agent_id
   *  is users-class (both historical writers wrote a users id there). */
  referringUserId: string
  referralNotes?: string | null
  expectedTimeline?: string | null
}

export type CreditPartnerReferralResult =
  | { success: true; referral: Record<string, unknown>; taskWritten: boolean; taskSkipReason?: string }
  | { success: false; error: string }

/**
 * THE ONE credit_partner_referrals writer. Discloses a consumer's credit
 * situation to a third party, so BOTH ends must be inside the tenant, and the
 * referring person must be a user of it. status CHECK = referred | in_progress |
 * completed | declined.
 */
export async function recordCreditPartnerReferral(
  client: any,
  brokerageId: string,
  input: CreditPartnerReferralInput,
): Promise<CreditPartnerReferralResult> {
  if (!brokerageId) return { success: false, error: "No brokerageId — a credit referral is never written untenanted" }
  if (!input.contactId) return { success: false, error: "contact_id required" }
  if (!input.partnerId) return { success: false, error: "partner_id required" }
  if (!input.referringUserId) return { success: false, error: "No referring user — a credit referral must name who made it" }

  const referrer = await resolveRecipientBrokerageId(client, input.referringUserId)
  if (!referrer.ok) return { success: false, error: `Could not verify the referring user: ${referrer.reason}` }
  if (referrer.brokerageId !== brokerageId) return { success: false, error: "The referring user is not in this brokerage" }

  const contact = await contactInTenant(client, brokerageId, input.contactId)
  if (!contact.ok) return { success: false, error: contact.error.startsWith("Contact read refused") ? "Could not verify the contact" : "Contact not found in your brokerage" }

  const { data: partnerRow, error: partnerErr } = await client
    .from("referral_partners")
    .select("id, partner_name")
    .eq("id", input.partnerId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (partnerErr) return { success: false, error: "Could not verify the credit partner" }
  if (!partnerRow) return { success: false, error: "Credit partner not found in your brokerage" }

  const { data: referral, error } = await client
    .from("credit_partner_referrals")
    .insert({
      contact_id: input.contactId,
      partner_id: input.partnerId,
      // Denormalised from the VERIFIED partner row, never from a payload.
      partner_name: partnerRow.partner_name ?? null,
      referred_at: new Date().toISOString(),
      referring_agent_id: input.referringUserId,
      referral_notes: input.referralNotes ?? null,
      expected_timeline: input.expectedTimeline ?? null,
      status: "referred",
      brokerage_id: brokerageId,
    })
    .select()
    .single()
  if (error || !referral) return { success: false, error: `Credit referral not recorded: ${error?.message ?? "no row returned"}` }

  // A referral with no follow-up is a referral that gets forgotten. Best-effort:
  // never fails the referral that already landed, but REPORTED when skipped.
  const out = outcome()
  try {
    await taskForAgent(client, brokerageId, input.referringUserId, {
      contact_id: input.contactId,
      title: `Follow up on ${partnerRow.partner_name ?? "credit partner"} referral`,
      due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      priority: "medium",
    }, out)
  } catch (err) {
    out.skipped.push(`task threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  const taskWritten = out.written.includes("task")
  return { success: true, referral, taskWritten, ...(taskWritten ? {} : { taskSkipReason: out.skipped.join("; ") }) }
}

/** credit.partner_referred — DISPATCHED. The event door onto the one writer. */
export async function reactToCreditPartnerReferred(
  client: any,
  brokerageId: string,
  payload: Record<string, any>,
  actorUserId: string | null | undefined,
): Promise<CreditEventOutcome> {
  const r = await recordCreditPartnerReferral(client, brokerageId, {
    contactId: payload?.contact_id,
    partnerId: payload?.partner_id,
    referringUserId: payload?.user_id ?? actorUserId ?? "",
    referralNotes: payload?.referral_notes ?? null,
    expectedTimeline: payload?.expected_timeline ?? null,
  })
  if (!r.success) return { success: false, written: [], skipped: [], error: r.error }
  return { success: true, written: r.taskWritten ? ["referral", "task"] : ["referral"], skipped: r.taskSkipReason ? [r.taskSkipReason] : [] }
}
