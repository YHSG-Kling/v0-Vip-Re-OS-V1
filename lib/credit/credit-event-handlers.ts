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

// TOMBSTONE (wave 155, lane 155R24): notifyInTenant (the tenant-proven notifications writer of the two credit event reactions)
// lived here; both reactions are retired (below), so it had no caller. The one bell on a credit-flow stage is the survivor's:
// app/actions/credit-copilot.ts:399 triggerCreditFlowActions.

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

// TOMBSTONE (wave 155, lane 155R24 — CLAUDE.md §1): reactToCreditPartnerStatus ("credit.status_updated": a bell to the actor and,
// on new_status 'approved', a kickoff task) and reactToCreditTargetReached ("credit.target_reached": contact → good /
// target_score_reached, a bell and a re-engage task) lived here. Nothing emits either dotted name (logCreditStatusUpdated writes
// the underscore credit_status_updated), and both keyed on credit_status values the one writer never stores (needs_work |
// in_program | good). SURVIVOR: app/actions/credit-copilot.ts:399 triggerCreditFlowActions — the approved stage's kickoff
// task (:500) and the funded stage's target_score_reached + celebration task (:542). The re-engage-for-home-buying step the
// survivor lacks is merged by the outside-lane diff in lane 155R24's notes.

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

// TOMBSTONE (wave 155, lane 155B2 — CLAUDE.md §1): reactToCreditPartnerReferred(client, brokerageId, payload) lived here — the
// orchestrator's event door for "credit.partner_referred", an event no code emits. SURVIVOR: app/actions/credit-copilot.ts
// referToCreditPartner → recordCreditPartnerReferral (above, in this file) — the one writer, reached from the session action.
