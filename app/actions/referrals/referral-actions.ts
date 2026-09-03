"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import {
  DEFAULT_REFERRAL_STATUS,
  isReferralStatus,
  type ReferralStatus,
} from "@/lib/referrals/referral-status"
import {
  isReferralPartnerType,
  isReferralAgreementType,
  REFERRAL_PARTNER_TYPES,
  REFERRAL_AGREEMENT_TYPES,
} from "@/lib/referrals/partner-vocabulary"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type ReferralPartnerRow = {
  id: string
  agent_id: string
  brokerage_id: string
  partner_name: string
  partner_type: string
  agreement_type: string
  /** Captured by createPartner and by the business-card scan. They were absent
   *  from this type, so every surface that listed partners could only ever show
   *  a name — the contact details were written and then invisible. */
  email: string | null
  phone: string | null
  /** Same class as email/phone above: `referral_partners.company_name` exists
   *  live and listPartnersWithReferrals selects `*`, so the value was always on
   *  the wire — it was simply undeclared here, which made the credit-pipeline
   *  partner picker unable to fall back to the company when a partner has no
   *  personal name (`p.partner_name || p.company_name || "Unnamed partner"`).
   *  Declared rather than dropped from the consumer: the data is real. */
  company_name: string | null
  agreement_date: string | null
  notes: string | null
  commission_split_percentage: number | null
  referral_fee_flat: number | null
  total_referrals_sent: number
  total_referrals_received: number
  total_value_generated: number
  active: boolean
  created_at: string
}

export type ReferralRow = {
  id: string
  brokerage_id: string
  agent_id: string
  /** nullable in Postgres — a referral does not have to come from a partner. */
  partner_id: string | null
  referred_contact_id: string | null
  /** MIRRORS referrals_status_check — see lib/referrals/referral-status.ts for
   *  the constraint and for what each surface used to believe instead. The union
   *  used to be spelled out here and carried 5 of the 7: `assigned` and `lost`
   *  were missing, so a referral handed to an agent or written off could not be
   *  represented at all and updateReferralStatus could not be asked for them. */
  status: ReferralStatus
  referred_lead_id: string | null
  referral_name: string | null
  referral_source: string | null
  notes: string | null
  commission_amount: number | null
  value_estimate: number | null
  closed_at: string | null
  created_at: string
  referral_partners?: Pick<ReferralPartnerRow, "partner_name" | "partner_type"> | null
}

export type CreateReferralParams = {
  /** OPTIONAL because referrals.partner_id is nullable and a referral does not
   *  always come from a partner record — a past client sends you a name, and
   *  there is no partner to point at. This used to be required, which is why
   *  referral-pipeline-panel.tsx invents a partner row just to satisfy it and
   *  then deletes it again if the referral insert fails. Only the orphaned
   *  multi-persona.ts:trackReferral could record a partner-less referral, and
   *  nothing called it. */
  partnerId?: string
  referralSource?: string
  commissionAmount?: number
  /** referrals.value_estimate — what the referral is thought to be WORTH, which
   *  is not the same number as the commission on it. The pipeline cards read
   *  this column; the create dialog labels its field "Potential Value" and had
   *  nowhere to send it, so it was being folded into commissionAmount. */
  valueEstimate?: number
  /** referrals.notes — free text about the referral. The create dialog's Notes
   *  box was being sent as `referralSource`, which is meant to record WHERE the
   *  referral came from, not what was said about it. */
  notes?: string
  referredPerson?: {
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
  }
  /** Where the referral starts. Defaults to `received`, which is what this
   *  function used to hard-code — a referral that arrives already assigned or
   *  already lost could not be recorded as such. */
  status?: ReferralStatus
  /** The LEAD this referral points at, when it is a lead rather than a contact.
   *  referrals.referred_lead_id was written by exactly one function in the
   *  codebase — an orphan with no callers — so in practice it was never set. */
  referredLeadId?: string
}

export type CreatePartnerParams = {
  partnerName: string
  partnerType: string
  agreementType: string
  commissionSplitPercentage?: number
  referralFeeFlat?: number
  /** How the agent knows this partner. The business-card scan flow has always
   *  collected it ("Met at open house, strong referral network...") and it was
   *  dropped at submit — so the one piece of context that makes a partner row
   *  worth anything six months later never arrived. */
  notes?: string
  /** The partner's contact details and the date the arrangement was signed.
   *
   *  These three were the ONLY thing the orphaned multi-persona.ts:
   *  createReferralPartner captured that this function did not — which made it
   *  impossible to retire without losing them. A referral partner you cannot
   *  email or phone is a name in a list, and agreement_date is what says the
   *  arrangement is real and when it started. They belong on the wired path. */
  email?: string
  phone?: string
  /** ISO date (YYYY-MM-DD) — referral_partners.agreement_date is a DATE column. */
  agreementDate?: string
}

// ─── ACTIONS ─────────────────────────────────────────────────────────────────

export async function createReferral(params: CreateReferralParams): Promise<{ id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId, userId } = await getAgentContext()
  const db = createServiceClient()

  // Step 1: If referred person has email/phone → call captureContact() (Track B)
  let referredContactId: string | null = null
  if (params.referredPerson) {
    const { firstName, lastName, email, phone } = params.referredPerson
    if (email || phone) {
      const result = await captureContact({
        brokerageId: brokerageId ?? "",
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        email: email ?? null,
        phone: phone ?? null,
        source: "referral",
        tcpa_consent: false,
      })
      referredContactId = result.contactId
    }
  }

  // Step 2: INSERT referrals
  const status = params.status ?? DEFAULT_REFERRAL_STATUS

  // referrals.referral_name is what every pipeline card renders. Nothing wrote
  // it, so every card created through the app rendered a blank title even though
  // the create dialog asks for the name and makes it required.
  const referralName =
    [params.referredPerson?.firstName, params.referredPerson?.lastName]
      .filter((p) => p && p.trim())
      .join(" ")
      .trim() || null
  const { data: referral, error: insertError } = await db
    .from("referrals")
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      partner_id: params.partnerId ?? null,
      referred_contact_id: referredContactId,
      referred_lead_id: params.referredLeadId ?? null,
      status,
      referral_name: referralName,
      referral_source: params.referralSource ?? null,
      commission_amount: params.commissionAmount ?? null,
      value_estimate: params.valueEstimate ?? null,
      notes: params.notes?.trim() || null,
      // A referral can ARRIVE already closed (a partner tells you about a deal
      // that has since settled). updateReferralStatus stamps closed_at on the
      // transition; nothing stamped it on creation, so such a row read as an
      // open referral forever.
      closed_at: status === "closed" ? new Date().toISOString() : null,
    })
    .select("id")
    .single()

  if (insertError || !referral) {
    throw new Error(`Failed to create referral: ${insertError?.message ?? "no row returned"}`)
  }

  // Step 3: UPDATE referral_partners SET total_referrals_received += 1
  // Skipped entirely when the referral has no partner — there is no counter to bump.
  if (params.partnerId) {
    const partnerId = params.partnerId
    const { error: updateError } = await db.rpc("increment_referral_received", {
      p_partner_id: partnerId,
    })
    // Non-fatal if RPC errors — fall back to a read-then-increment update
    if (updateError) {
      const { data: partner } = await db
        .from("referral_partners")
        .select("total_referrals_received")
        .eq("id", partnerId)
        .maybeSingle()
      await db
        .from("referral_partners")
        .update({ total_referrals_received: (partner?.total_referrals_received ?? 0) + 1 })
        .eq("id", partnerId)
    }
  }

  // Step 4: kernel event — audit row + reactor (sequences keyed on referral_received
  // now enroll; the bare insert reached nothing).
  await emitKernelEvent({
    entityType:  "contact",
    entityId:    referredContactId ?? referral.id,
    brokerageId,
    event:       KernelEvent.REFERRAL_RECEIVED,
    contactId:   referredContactId ?? undefined,
    actorUserId: userId, // lifecycle_events.actor_user_id FKs users(id) — agentId is agents(id)
    metadata: {
      referral_id: referral.id,
      partner_id:  params.partnerId ?? null,
      source:      params.referralSource ?? null,
      status,
    },
  })

  return { id: referral.id }
}

export async function updateReferralStatus(
  referralId: string,
  status: ReferralStatus,
  closedData?: { commissionAmount?: number }
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  // A server action's arguments are client input — the TYPE is a compile-time
  // promise, not a runtime one. Both call sites used to cast with `as any`, so a
  // stage the constraint refuses reached the UPDATE and came back as a raw
  // Postgres check_violation. Reject it here, in language the agent can read.
  if (!isReferralStatus(status)) {
    throw new Error(`"${status}" is not a referral status this system records.`)
  }

  const { agentId, brokerageId, userId } = await getAgentContext()
  const db = createServiceClient()

  const updates: Partial<ReferralRow> = { status }
  if (status === "closed") {
    updates.closed_at = new Date().toISOString()
    if (closedData?.commissionAmount !== undefined) {
      updates.commission_amount = closedData.commissionAmount
    }
  }

  const { error } = await db
    .from("referrals")
    .update(updates)
    .eq("id", referralId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw new Error(`Failed to update referral: ${error.message}`)

  // If closed: bump total_value_generated on partner
  if (status === "closed" && closedData?.commissionAmount) {
    const { data: ref } = await db
      .from("referrals")
      .select("partner_id, commission_amount")
      .eq("id", referralId)
      .single()

    if (ref?.partner_id) {
      const { data: partner } = await db
        .from("referral_partners")
        .select("total_value_generated")
        .eq("id", ref.partner_id)
        .single()

      if (partner) {
        await db
          .from("referral_partners")
          .update({
            total_value_generated:
              (partner.total_value_generated ?? 0) + (closedData.commissionAmount ?? 0),
          })
          .eq("id", ref.partner_id)
      }
    }
  }
}

/**
 * Draft the thank-you note for a converted referral.
 *
 * BUILT HERE (§1.1, lane N3a 2026-09-01) to replace the deleted
 * app/api/referrals/thank-you-draft/route.ts, which bypassed both AI rails: a raw
 * `generateText` call (so the spend was never booked to ai_tool_usage and the
 * prompt never passed Data Guard) carrying UNSCRUBBED contact notes, and a
 * body-supplied contactId read with no tenancy at all. This action:
 *   · anchors the referral to the SESSION's agent + brokerage (§4) and derives
 *     the referrer contact from the referral row — never from the caller;
 *   · reads every row through destructured { data, error } (§3);
 *   · generates through generateAIResponse, the routed rail — Data Guard scrubs
 *     the prompt at the model boundary and the spend books to ai_tool_usage.
 *
 * The draft is RETURNED, not sent: the appreciation flow on this pipeline is a
 * physical card a human writes and posts (see the pipeline page's note on
 * "Mark Thank-You Sent") — this hands the agent words to copy, nothing more.
 */
export async function draftReferralThankYou(referralId: string): Promise<{
  success: boolean
  draft?: string
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { agentId, brokerageId, userId } = await getAgentContext()
  if (!brokerageId || !agentId) {
    return { success: false, error: "Your account is not linked to an agent profile yet." }
  }

  const db = createServiceClient()

  // The referral must be THIS agent's, in THIS tenant — same anchor as
  // sendReferralThankYou above.
  const { data: referral, error: referralError } = await db
    .from("referrals")
    .select("id, referral_name, referrer_contact_id")
    .eq("id", referralId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (referralError) return { success: false, error: `Could not load that referral: ${referralError.message}` }
  if (!referral) return { success: false, error: "Referral not found" }

  // The recipient is the REFERRER (the person being thanked), resolved from the
  // referral row itself and read tenant-scoped.
  let referrerName = "there"
  let referrerNotes: string | null = null
  if (referral.referrer_contact_id) {
    const { data: referrer, error: referrerError } = await db
      .from("contacts")
      .select("first_name, last_name, notes")
      .eq("id", referral.referrer_contact_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (referrerError) {
      return { success: false, error: `Could not load the referrer: ${referrerError.message}` }
    }
    if (referrer) {
      referrerName = `${referrer.first_name ?? ""} ${referrer.last_name ?? ""}`.trim() || "there"
      referrerNotes = referrer.notes ?? null
    }
  }

  const { data: agentRow, error: agentRowError } = await db
    .from("users")
    .select("first_name, last_name")
    .eq("id", userId)
    .maybeSingle()
  if (agentRowError) {
    console.error("[draftReferralThankYou] agent name read failed:", agentRowError.message)
  }
  const agentName = agentRow
    ? `${agentRow.first_name ?? ""} ${agentRow.last_name ?? ""}`.trim() || "your agent"
    : "your agent"

  try {
    const { generateAIResponse } = await import("@/lib/ai")
    const response = await generateAIResponse({
      system: `You are a real estate agent assistant writing a warm, genuine thank-you message on behalf of ${agentName}.
Keep the tone personal, concise (3-5 sentences), and grateful without being over-the-top.
Do NOT include placeholders — write the full message ready to send.`,
      prompt: `Write a thank-you message to ${referrerName} for referring ${referral.referral_name || "a client"} to me.
${referrerNotes ? `Context about this person: ${referrerNotes}` : ""}
The referral has converted, so express genuine appreciation and mention I look forward to continuing to be a resource for them.`,
      metadata: {
        userId,
        brokerageId,
        agentId,
        feature: "email_generation",
      },
    })
    return { success: true, draft: response.text }
  } catch (error) {
    console.error("[draftReferralThankYou] generation failed:", (error as Error).message)
    return { success: false, error: "Could not draft the note — please try again." }
  }
}

export async function sendReferralThankYou(referralId: string): Promise<{ success: true }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId, userId } = await getAgentContext()
  const db = createServiceClient()

  const { error } = await db
    .from("referrals")
    .update({
      thank_you_sent: true,
      thank_you_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", referralId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (error) throw new Error(`Failed to send thank you: ${error.message}`)
  return { success: true }
}

export async function createPartner(params: CreatePartnerParams): Promise<{ id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId, userId } = await getAgentContext()
  const db = createServiceClient()

  // VOCABULARY GATE — before anything else, because a value the CHECK refuses
  // takes the whole flow down at the INSERT below with
  // `violates check constraint "referral_partners_partner_type_check"`, and the
  // two surfaces that call this have both shipped values it refuses: the
  // referrals screen once sent Title-Case display labels, and the business-card
  // scanner sent agreement_type 'referral_fee'. Every one of those adds failed,
  // forever, and the agent was shown "Please try again" — a message about a
  // transient problem for a permanent one.
  //
  // Refused HERE, in the vocabulary's own terms, naming the values that are
  // storable. The RESPA gate below runs after, so a malformed partner_type can
  // never reach guardVendorReferralFee's `category` and be classified.
  if (!isReferralPartnerType(params.partnerType)) {
    throw new Error(
      `"${params.partnerType}" is not a storable partner type. Choose one of: ` +
        REFERRAL_PARTNER_TYPES.map((t) => t.value).join(", "),
    )
  }
  if (!isReferralAgreementType(params.agreementType)) {
    throw new Error(
      `"${params.agreementType}" is not a storable agreement type. Choose one of: ` +
        REFERRAL_AGREEMENT_TYPES.map((t) => t.value).join(", "),
    )
  }

  // RESPA GATE — the platform structurally blocks a referral/kickback fee against a settlement-service
  // partner (lender, title, attorney, appraiser, inspector, surveyor). The refusal is recorded on the
  // immutable compliance ledger; the agent sees the RESPA kickback notice, not a generic error.
  const hasFee = (params.referralFeeFlat ?? 0) > 0 || (params.commissionSplitPercentage ?? 0) > 0
  if (hasFee) {
    const { guardVendorReferralFee, respaKickbackNotice } = await import("@/lib/compliance/vendor-respa")
    const verdict = await guardVendorReferralFee(db, {
      brokerageId,
      actorUserId: user.id,
      actorRole: "agent",
      category: params.partnerType,
      partnerName: params.partnerName,
      hasFee,
      feeType: (params.referralFeeFlat ?? 0) > 0 ? "flat_referral_fee" : "commission_split",
    })
    if (!verdict.allowed) {
      throw new Error(`${verdict.reason ?? "Referral fee not permitted."}\n\n${respaKickbackNotice()}`)
    }
  }

  const { data, error } = await db
    .from("referral_partners")
    .insert({
      agent_id: agentId,
      brokerage_id: brokerageId,
      partner_name: params.partnerName,
      partner_type: params.partnerType,
      agreement_type: params.agreementType,
      email: params.email?.trim() || null,
      phone: params.phone?.trim() || null,
      agreement_date: params.agreementDate || null,
      commission_split_percentage: params.commissionSplitPercentage ?? null,
      referral_fee_flat: params.referralFeeFlat ?? null,
      notes: params.notes?.trim() || null,
      total_referrals_sent: 0,
      total_referrals_received: 0,
      total_value_generated: 0,
      active: true,
    })
    .select("id")
    .single()

  if (error || !data) throw new Error(`Failed to create partner: ${error?.message ?? "no row"}`)
  return { id: data.id }
}

/**
 * Delete a partner record by ID. Used for compensating-transaction cleanup when
 * referral creation fails after a partner has already been inserted.
 */
export async function deletePartner(partnerId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId, userId } = await getAgentContext()
  const db = createServiceClient()

  const { data: deleted, error } = await db
    .from("referral_partners")
    .delete()
    .eq("id", partnerId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) throw new Error(`Failed to delete partner: ${error.message}`)
  if (!deleted || deleted.length === 0) {
    console.warn(`[deletePartner] No row deleted for partnerId=${partnerId} — may have already been removed or ownership mismatch`)
  }
}

export async function listPartnersWithReferrals(): Promise<{
  partners: ReferralPartnerRow[]
  referrals: ReferralRow[]
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { agentId, brokerageId } = await getAgentContext()

  // ABSORBED (wave 16) from the retired /api/dashboard/data `referrals` branch:
  // a refused read reported as a FAILURE, and an unresolved identity refused
  // rather than filtered on.
  //
  // Both reads below run on the SERVICE client, which has no RLS to fall back
  // on, and neither destructured `error` — so a refusal arrived as `undefined`,
  // became `[]`, and rendered "you have no referral partners". The identity was
  // not checked either: with a null agentId this filtered `agent_id=eq.null`,
  // which is not the same query anyone intended and is certainly not this
  // agent's book.
  if (!brokerageId) throw new Error("Your account is not linked to a brokerage yet.")
  if (!agentId) throw new Error("Agent profile not found. Please complete onboarding.")

  const db = createServiceClient()

  const [
    { data: partners, error: partnersError },
    { data: referrals, error: referralsError },
  ] = await Promise.all([
    db
      .from("referral_partners")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .eq("active", true)
      .order("created_at", { ascending: false }),
    db
      .from("referrals")
      .select("*, referral_partners(partner_name, partner_type)")
      .eq("agent_id", agentId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(200),
  ])

  if (partnersError) throw new Error(`Could not load referral partners: ${partnersError.message}`)
  if (referralsError) throw new Error(`Could not load referrals: ${referralsError.message}`)

  return {
    partners: (partners ?? []) as ReferralPartnerRow[],
    referrals: (referrals ?? []) as ReferralRow[],
  }
}
