/**
 * INBOUND CALLER CLASSIFIER
 *
 * When an unknown caller phones in, classify them based on conversation
 * signals and create the right entity:
 *
 *   - real_estate_buyer/seller/investor → contact + immediate portal invite
 *   - vendor                            → vendor record (no portal unless
 *                                          paying or invited)
 *   - business_general                  → admin inbox notification (no portal)
 *   - cooperating_agent                 → contact_type='cooperating_agent'
 *                                          (no portal)
 *   - existing_contact                  → already classified — no-op (caller
 *                                          recognized in build-call-context)
 *
 * Inbound calls = implicit consent (caller initiated). New contacts created
 * here bypass the lead pipeline entirely — no Engine 1 distribution, no
 * unconsented gating.
 */

import { createServiceClient } from "@/lib/supabase/service"

export type CallerClassification =
  | "real_estate_buyer"
  | "real_estate_seller"
  | "real_estate_investor"
  | "vendor"
  | "business_general"
  | "cooperating_agent"
  | "existing_contact"
  | "unknown"

interface ClassifyInput {
  brokerageId: string
  callLogId?: string
  callerPhone: string
  callerName?: string
  conversationSummary?: string
  detectedKeywords?: string[]
}

interface ClassifyResult {
  classification: CallerClassification
  contactId?: string
  vendorId?: string
  portalInvited?: boolean
  notes?: string
}

function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10)
}

/**
 * Heuristic classifier — runs against conversation summary + keywords picked
 * up by the ISA. Returns a classification bucket.
 *
 * For richer signal extraction the ISA can populate `detectedKeywords` from
 * its function-call output (e.g., the assistant calls a `classify_caller`
 * tool with structured fields).
 */
function classifyFromSignals(input: {
  conversationSummary?: string
  detectedKeywords?: string[]
}): CallerClassification {
  const text = (input.conversationSummary ?? "").toLowerCase()
  const kw = (input.detectedKeywords ?? []).map((k) => k.toLowerCase())

  const has = (term: string) => text.includes(term) || kw.includes(term)

  // Cooperating agent — REALTOR®, fellow agent
  if (has("cooperating agent") || has("buyer's agent") || has("listing agent") || has("fellow realtor") || has("co-op")) {
    return "cooperating_agent"
  }

  // Vendor — service providers
  if (has("plumber") || has("electrician") || has("contractor") || has("photographer") ||
      has("inspector") || has("appraiser") || has("title company") || has("stager") ||
      has("handyman") || has("hvac") || has("roofer")) {
    return "vendor"
  }

  // Investor — explicit signal
  if (has("investor") || has("rental property") || has("flip") || has("portfolio") || has("cash buy")) {
    return "real_estate_investor"
  }

  // Seller — listing inquiry
  if (has("sell my home") || has("sell my house") || has("list my home") || has("listing") || has("home value") || has("cma")) {
    return "real_estate_seller"
  }

  // Buyer — looking-to-buy
  if (has("looking to buy") || has("buying a house") || has("buying a home") || has("first-time buyer") || has("pre-approval") || has("show me properties")) {
    return "real_estate_buyer"
  }

  // Generic real estate inquiry — default to buyer when intent unclear
  if (has("real estate") || has("agent") || has("realtor") || has("property")) {
    return "real_estate_buyer"
  }

  // Generic business — could be anything else (sales calls, partnerships)
  return "business_general"
}

/**
 * Resolve an existing contact by caller phone.
 */
export async function resolveExistingCaller(
  brokerageId: string,
  callerPhone: string
): Promise<{ contactId: string; agentId: string | null } | null> {
  const supabase = createServiceClient()
  const digits = normalizePhoneDigits(callerPhone)
  if (!digits) return null

  const { data } = await supabase
    .from("contacts")
    .select("id, agent_id")
    .eq("brokerage_id", brokerageId)
    .eq("phone_digits", digits)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()

  if (!data) return null
  return { contactId: data.id, agentId: data.agent_id }
}

/**
 * Main classification entry point. Creates the right entity and logs the
 * classification decision to inbound_call_classifications for audit.
 */
export async function classifyAndIngestInboundCaller(
  input: ClassifyInput
): Promise<ClassifyResult> {
  const supabase = createServiceClient()
  const phoneDigits = normalizePhoneDigits(input.callerPhone)

  // 1. Existing contact short-circuit
  const existing = await resolveExistingCaller(input.brokerageId, input.callerPhone)
  if (existing) {
    await supabase.from("inbound_call_classifications").insert({
      call_log_id: input.callLogId ?? null,
      brokerage_id: input.brokerageId,
      caller_phone: input.callerPhone,
      caller_phone_digits: phoneDigits,
      classification: "existing_contact",
      resulting_contact_id: existing.contactId,
      ai_handled: true,
      classified_at: new Date().toISOString(),
    })
    return {
      classification: "existing_contact",
      contactId: existing.contactId,
      notes: existing.agentId ? "routed to assigned agent flow" : "no agent assigned",
    }
  }

  // 2. Run heuristic classifier
  const classification = classifyFromSignals({
    conversationSummary: input.conversationSummary,
    detectedKeywords: input.detectedKeywords,
  })

  // 3. Branch by classification — create the right entity
  let contactId: string | undefined
  let vendorId: string | undefined
  let portalInvited = false

  if (
    classification === "real_estate_buyer" ||
    classification === "real_estate_seller" ||
    classification === "real_estate_investor"
  ) {
    // Real estate inquiry → CONTACT (inbound = implicit consent, bypass lead pipeline)
    const contactType =
      classification === "real_estate_buyer"
        ? "buyer"
        : classification === "real_estate_seller"
        ? "seller"
        : "investor"

    const [firstName, ...rest] = (input.callerName ?? "").trim().split(" ")
    const lastName = rest.join(" ") || null

    const { data: newContact } = await supabase
      .from("contacts")
      .insert({
        brokerage_id: input.brokerageId,
        first_name: firstName || "Unknown",
        last_name: lastName,
        phone: input.callerPhone,
        phone_digits: phoneDigits,
        contact_type: contactType,
        source: "inbound_call",
        source_family: "phone",
        source_channel: "inbound",
        tcpa_consent: true,
        tcpa_consent_at: new Date().toISOString(),
        tcpa_consent_source: "inbound_call_implicit",
        tcpa_consent_text: "Caller initiated inbound call — implicit consent",
        notes: input.conversationSummary ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    contactId = newContact?.id

    // Real estate contacts get an immediate portal invite.
    // Use the brokerage Admin user as the system "inviter" since the AI is
    // creating the invite on the brokerage's behalf.
    if (contactId) {
      try {
        const { data: inviter } = await supabase
          .from("users")
          .select("id")
          .eq("brokerage_id", input.brokerageId)
          .eq("role", "Admin")
          .limit(1)
          .maybeSingle()

        if (inviter?.id) {
          const { createPortalInviteForContact } = await import(
            "@/app/actions/portal-invites"
          )
          await createPortalInviteForContact({
            contactId,
            brokerageId: input.brokerageId,
            invitedByUserId: inviter.id,
            sendMagicLink: true,
          })
          portalInvited = true
        }
      } catch {
        // best effort — failure is non-blocking
      }
    }
  } else if (classification === "vendor") {
    // Vendor record — no portal unless paying customer or invited later
    const { data: newVendor } = await supabase
      .from("vendors")
      .insert({
        brokerage_id: input.brokerageId,
        name: input.callerName ?? "Unknown vendor",
        phone: input.callerPhone,
        notes: input.conversationSummary ?? null,
      })
      .select("id")
      .single()

    vendorId = newVendor?.id
  } else if (classification === "cooperating_agent") {
    // Cooperating agent — special contact type, no portal
    const [firstName, ...rest] = (input.callerName ?? "").trim().split(" ")
    const lastName = rest.join(" ") || null

    const { data: newContact } = await supabase
      .from("contacts")
      .insert({
        brokerage_id: input.brokerageId,
        first_name: firstName || "Unknown",
        last_name: lastName,
        phone: input.callerPhone,
        phone_digits: phoneDigits,
        contact_type: "cooperating_agent",
        source: "inbound_call",
        source_family: "phone",
        source_channel: "inbound",
        tcpa_consent: true,
        tcpa_consent_at: new Date().toISOString(),
        tcpa_consent_source: "inbound_call_implicit",
        notes: input.conversationSummary ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single()
    contactId = newContact?.id
  } else if (classification === "business_general") {
    // No record created — admin gets a notification with the call details.
    // Find the brokerage's admin user.
    const { data: adminUser } = await supabase
      .from("users")
      .select("id")
      .eq("brokerage_id", input.brokerageId)
      .eq("role", "Admin")
      .limit(1)
      .maybeSingle()

    if (adminUser?.id) {
      await supabase.from("notifications").insert({
        user_id: adminUser.id,
        brokerage_id: input.brokerageId,
        type: "inbound_business_call",
        title: `Business call from ${input.callerName ?? input.callerPhone}`,
        body: input.conversationSummary ?? "Caller did not specify real estate intent.",
        priority: "low",
        is_read: false,
        created_at: new Date().toISOString(),
      })
    }
  }

  // 4. Persist classification decision for audit
  await supabase.from("inbound_call_classifications").insert({
    call_log_id: input.callLogId ?? null,
    brokerage_id: input.brokerageId,
    caller_phone: input.callerPhone,
    caller_phone_digits: phoneDigits,
    classification,
    resulting_contact_id: contactId ?? null,
    resulting_vendor_id: vendorId ?? null,
    ai_handled: true,
    classified_at: new Date().toISOString(),
  })

  return { classification, contactId, vendorId, portalInvited }
}
