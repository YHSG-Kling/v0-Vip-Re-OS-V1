"use server"

/**
 * Dispatch a single tour stop's scheduling outreach to the listing agent.
 * Called by the buyer agent from the tour-confirm tab — one click per stop.
 *
 * Routing:
 *   - channel='showingtime' → POST to ShowingTime API (brokerage_credentials)
 *   - channel='sms'         → Twilio (brokerage_credentials)
 *   - channel='email'       → SendGrid (brokerage_credentials)
 *
 * If the brokerage doesn't have credentials for the chosen channel, returns
 * the rendered draft so the agent can copy/paste/send manually. Either
 * way we record the dispatch attempt as a lifecycle_event so the UI can
 * show "Sent at HH:MM via SMS to (555) 555-5555" history per stop.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import {
  dispatchViaShowingTime, dispatchViaSms, dispatchViaEmail,
  type DispatchChannel, type DispatchResult,
} from "@/lib/showings/dispatchers"

export interface DispatchStopSchedulingInput {
  tourStopId:   string
  channel:      DispatchChannel
}

export interface DispatchStopSchedulingResult extends DispatchResult {
  success:    boolean
  error?:     string
  channel?:   DispatchChannel
}

export async function dispatchStopScheduling(
  input: DispatchStopSchedulingInput,
): Promise<DispatchStopSchedulingResult> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return {
      success: false, error: "Unauthorized",
      providerRef: null, draft: { to: "", body: "" }, sent: false,
    }
  }

  const supabase = createServiceClient()

  // Load stop + tour
  const { data: stop } = await supabase
    .from("tour_stops")
    .select("id, tour_id, property_address, city, state, zip, listing_agent_name, listing_agent_phone, listing_agent_email, listing_agent_company, suggested_time, suggested_duration_minutes")
    .eq("id", input.tourStopId)
    .maybeSingle()
  if (!stop) {
    return { success: false, error: "Tour stop not found", providerRef: null, draft: { to: "", body: "" }, sent: false }
  }

  const { data: tour } = await supabase
    .from("tours")
    .select("id, contact_id, agent_id, brokerage_id, tour_date, start_time")
    .eq("id", stop.tour_id)
    .maybeSingle()
  if (!tour || tour.brokerage_id !== ctx.brokerageId) {
    return { success: false, error: "Tour not found", providerRef: null, draft: { to: "", body: "" }, sent: false }
  }

  // Resolve buyer-agent identity (full name + phone + email + license)
  let buyerAgentName = "Buyer's Agent"
  let buyerAgentPhone: string | null = null
  let buyerAgentEmail: string | null = null
  let buyerAgentLicense: string | null = null
  let brokerageName: string | null = null

  // tours.agent_id stores users.id (the auth uid of the buyer agent),
  // resolve via users + agents to get full identity.
  if (tour.agent_id) {
    const { data: u } = await supabase
      .from("users")
      .select("first_name, last_name, email, phone")
      .eq("id", tour.agent_id)
      .maybeSingle()
    buyerAgentName  = [u?.first_name, u?.last_name].filter(Boolean).join(" ") || buyerAgentName
    buyerAgentEmail = u?.email ?? null
    buyerAgentPhone = u?.phone ?? null

    const { data: a } = await supabase
      .from("agents")
      .select("license_number")
      .eq("user_id", tour.agent_id)
      .maybeSingle()
    buyerAgentLicense = a?.license_number ?? null
  }
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name")
    .eq("id", ctx.brokerageId)
    .maybeSingle()
  brokerageName = brokerage?.name ?? null

  // Resolve buyer (first/last name + verified flag)
  let buyerFirst: string | null = null
  let buyerLast:  string | null = null
  let buyerVerified = false
  if (tour.contact_id) {
    const [{ data: contact }, { data: fin }] = await Promise.all([
      supabase.from("contacts").select("first_name, last_name").eq("id", tour.contact_id).maybeSingle(),
      supabase.from("buyer_financial_profiles").select("verified").eq("contact_id", tour.contact_id).maybeSingle(),
    ])
    buyerFirst    = contact?.first_name ?? null
    buyerLast     = contact?.last_name ?? null
    buyerVerified = !!fin?.verified
  }

  // Resolve credentials for the chosen channel.
  // Brokerage credentials live in `integration_credentials` keyed by
  // brokerage_id + provider. Falling back to env vars for ShowingTime so
  // single-tenant deployments work without credential setup.
  const dispatchCtx = {
    stop:       stop as any,
    tour:       { id: tour.id, tour_date: tour.tour_date, start_time: tour.start_time },
    buyerAgent: {
      fullName:      buyerAgentName,
      phone:         buyerAgentPhone,
      email:         buyerAgentEmail,
      licenseNumber: buyerAgentLicense,
      brokerageName: brokerageName,
    },
    buyer: { firstName: buyerFirst, lastName: buyerLast, isVerified: buyerVerified },
  }

  let result: DispatchResult
  if (input.channel === "showingtime") {
    const apiKey = await loadBrokerageCredential(supabase, ctx.brokerageId, "showingtime", "api_key") ?? process.env.SHOWINGTIME_API_KEY ?? null
    result = await dispatchViaShowingTime(dispatchCtx, apiKey)
  } else if (input.channel === "sms") {
    const [accountSid, authToken, fromNumber] = await Promise.all([
      loadBrokerageCredential(supabase, ctx.brokerageId, "twilio", "account_sid"),
      loadBrokerageCredential(supabase, ctx.brokerageId, "twilio", "auth_token"),
      loadBrokerageCredential(supabase, ctx.brokerageId, "twilio", "from_number"),
    ])
    const twilio = (accountSid && authToken && fromNumber)
      ? { accountSid, authToken, fromNumber }
      : null
    result = await dispatchViaSms(dispatchCtx, twilio)
  } else {
    const sendgridKey = await loadBrokerageCredential(supabase, ctx.brokerageId, "sendgrid", "api_key") ?? process.env.SENDGRID_API_KEY ?? null
    // Pass agentUserId so the email dispatcher tries the agent's connected
    // Gmail/Outlook OAuth account first (sends from their real address +
    // replies threads in their inbox).
    result = await dispatchViaEmail(dispatchCtx, ctx.userId ?? null, sendgridKey)
  }

  // Record the dispatch attempt — agent UI reads this to show history.
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  ctx.brokerageId,
    entity_type:   "tour_stop",
    entity_id:     input.tourStopId,
    event_type:    result.sent ? "tour_stop.scheduling_sent" : "tour_stop.scheduling_drafted",
    actor_user_id: ctx.userId,
    metadata: {
      channel:       input.channel,
      provider_ref:  result.providerRef,
      to:            result.draft.to,
      sent:          result.sent,
    },
  }).then(() => null, () => null)

  return { ...result, success: true, channel: input.channel }
}

async function loadBrokerageCredential(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  provider: string,
  field: string,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("integration_credentials")
      .select("credentials")
      .eq("brokerage_id", brokerageId)
      .eq("provider", provider)
      .maybeSingle()
    const creds = (data?.credentials ?? null) as Record<string, string> | null
    return creds?.[field] ?? null
  } catch {
    return null
  }
}
