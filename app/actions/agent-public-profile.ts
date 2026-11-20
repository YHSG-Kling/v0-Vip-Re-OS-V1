"use server"

/**
 * Lead capture from the agent's public profile (/p/[agentSlug]).
 *
 * This is INTENTIONALLY public — visitors browsing an agent's marketing page
 * don't have a Supabase session. We can't gate this with auth.getUser().
 *
 * Previous version: trusted caller-supplied agentId / agentUserId / brokerageId,
 * so an attacker could write inquiry contacts attached to ANY (agent_id,
 * brokerage_id) pair they chose, including mismatched cross-brokerage pairs.
 *
 * Fix: validate the (agentId, agentUserId, brokerageId) triple by looking up
 * the agent row server-side and confirming all three fields are consistent.
 * Any mismatch → reject.
 *
 * WAVE 148 (lane 148B — owner rulings 3, 4, 12): ONE DOOR, ONE CONSENT COMPONENT.
 * TOMBSTONE: this action used to INSERT its own `contacts` row (no dedupe — a
 * returning visitor became a second contact; `contact_type: "lead"`; a single
 * "consent to be contacted" box that conflated the reply they asked for with
 * marketing) and queue enrichment itself. It now rides THE one consented-intake
 * door — lib/contact-pipeline/contact-capture.ts captureConsentedContact (C8),
 * which dedupes onto the canonical contact, records each ticked box of the ONE
 * consent component (C15, app/components/forms/ConsentBoxes.tsx) through the one
 * consent writer, queues enrichment, sends the one welcome and tells the AI ISA.
 * The agent is the form's CREATOR (contacts.source_agent_id) and its owner, so
 * the person is assigned back to them. The inquiry activity and the agent's bell
 * stay this door's own.
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { captureConsentedContact, consentGrantsFromComponent, resolveConsentBrand } from "@/lib/contact-pipeline/contact-capture"
import type { ConsentComponentSubmission } from "@/lib/kernel/compliance/consent-component"

export interface ProfileLeadInput {
  agentId: string
  agentUserId: string
  brokerageId: string
  fullName: string
  email?: string
  phone?: string
  message?: string
  /** THE ONE CONSENT COMPONENT's submission (C15). The service-delivery box is required to send the message. */
  consent: ConsentComponentSubmission
  /** The person's situation (owner ruling 12) — what they SAID, never inferred. Timeline is a CHECK bucket. */
  situation?: { intent?: "buyer" | "seller" | "both" | null; timeline?: string | null }
}

const PROFILE_TIMELINES = new Set(["immediate", "1-3_months", "3-6_months", "6-12_months", "12+_months", "researching"])

export async function captureProfileLead(input: ProfileLeadInput): Promise<{
  success: boolean
  contactId?: string
  error?: string
}> {
  if (!input.email && !input.phone) {
    return { success: false, error: "Email or phone required" }
  }

  const svc = createServiceClient()

  // Verify the (agentId, agentUserId, brokerageId) triple is a real, consistent
  // agent record. Without this, a caller can pass any combination of IDs and
  // get orphan / mismatched rows inserted.
  const { data: agent, error: agentErr } = await svc
    .from("agents")
    .select("id, user_id, brokerage_id")
    .eq("id", input.agentId)
    .maybeSingle()

  if (agentErr) return { success: false, error: "We could not look that up right now. Please try again." }
  if (!agent) return { success: false, error: "Agent not found" }
  if (agent.user_id !== input.agentUserId || agent.brokerage_id !== input.brokerageId) {
    return { success: false, error: "Agent identity mismatch" }
  }

  // The consent names the AGENT — THE one brand rule (resolveConsentBrand), read off the agent row, never the body.
  const agentName = await resolveConsentBrand(svc, { agentId: agent.id, brokerageId: agent.brokerage_id })

  const nameParts = input.fullName.trim().split(/\s+/)
  const firstName = nameParts[0] ?? ""
  const lastName = nameParts.slice(1).join(" ") || null
  const email = input.email?.trim().toLowerCase() || null
  const phone = input.phone?.trim() || null

  const c15 = consentGrantsFromComponent(input.consent, { door: "agent_profile", brandName: agentName, provided: { email: !!email, phone: !!phone } })
  if (!c15.submission?.service_delivery) return { success: false, error: "Please tick the consent box so we may contact you about your message." }

  const intent = input.situation?.intent ?? null
  const timeline = input.situation?.timeline && PROFILE_TIMELINES.has(input.situation.timeline) ? input.situation.timeline : null

  const captured = await captureConsentedContact({
    brokerageId: agent.brokerage_id,
    ownerAgentId: agent.id,
    creatorUserId: agent.user_id,
    source: "agent_public_profile",
    source_subtype: "profile_inquiry",
    status: "new",
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    ...(intent ? { contact_type: intent } : {}),
    ...(timeline ? { timeline } : {}),
    notes: input.message ?? null,
    consents: c15.grants,
    intake: {
      channel: "agent_profile",
      sourceUrl: null,
      evidence: { ...c15.evidence, wording_hash: c15.wordingHash, agent_id: agent.id },
      formOwner: { table: "agents", id: agent.id },
    },
  }, { client: svc })

  if (!captured.ok || !captured.contactId) {
    return { success: false, error: captured.refused === "not_identifiable" ? "Please add your name and an email or phone." : "We could not send that right now. Please try again." }
  }
  const contactId = captured.contactId
  if (captured.replay) return { success: true, contactId }

  // THIS ROW IS THE RECORD OF THE INQUIRY. The kernel's conversation memory
  // reads it back as "this person reached out"; losing it silently makes the
  // assistant believe the inquiry never happened. Read the error and say so.
  const { error: inquiryActivityError } = await svc.from("activities").insert({
    contact_id: contactId,
    brokerage_id: agent.brokerage_id,
    agent_user_id: agent.user_id,
    activity_type: "profile_inquiry",
    description: `Inquiry from agent public profile: ${input.message ? `"${input.message}"` : "general contact request"}`,
    metadata: { source: "agent_public_profile", capture_action: captured.action },
  })
  if (inquiryActivityError) {
    console.error("[agentPublicProfile] profile_inquiry activity REJECTED — the contact's timeline will not show this inquiry:", inquiryActivityError.message)
  }

  await sentinelWrite(svc, svc.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: agent.brokerage_id,
    title: "📩 New profile inquiry",
    body: `${input.fullName} reached out from your public profile${input.message ? `: "${input.message}"` : ""}`,
    type: "new_lead",
    entity_type: "contact",
    entity_id: contactId,
    priority: "high",
    is_read: false,
  }), { table: "notifications", flow: "agent_public_profile_notify", brokerageId: agent.brokerage_id, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })

  return { success: true, contactId }
}
