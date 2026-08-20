"use server"

/**
 * Dispatch a single tour stop's scheduling outreach to the listing agent.
 * Called by the buyer agent from the tour-confirm tab — one click per stop.
 *
 * Routing (all egress goes through the connector-gateway, never bespoke fetch):
 *   - channel='showingtime' → ShowingTime API; key resolved via the unified
 *                             ownership cascade (resolveScopedConnection)
 *   - channel='sms'         → the ONE SMS resolution (resolveSMSProviderForActor:
 *                             overrides → ownership cascade → tenant number → env)
 *                             / agent deep-link fallback
 *   - channel='email'       → agent Gmail/Outlook OAuth → SendGrid → mailto
 *
 * If the brokerage doesn't have credentials for the chosen channel, returns
 * the rendered draft so the agent can copy/paste/send manually. Either
 * way we record the dispatch attempt as a lifecycle_event so the UI can
 * show "Sent at HH:MM via SMS to (555) 555-5555" history per stop.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { resolveSMSProviderForActor } from "@/lib/providers/messaging/resolve-sms-provider"
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
    // Resolve the ShowingTime key through the unified ownership cascade
    // (agent → team → brokerage → platform). resolveScopedConnection also
    // falls back to the legacy integration_credentials store, so keys
    // connected either via the Connection Center or the old settings UI work.
    const teamId = await loadTeamId(supabase, ctx.userId)
    const conn = await resolveScopedConnection("showingtime", {
      agentUserId: ctx.userId ?? null,
      teamId,
      brokerageId: ctx.brokerageId,
    })
    const apiKey = conn?.apiKey ?? process.env.SHOWINGTIME_API_KEY ?? null
    result = await dispatchViaShowingTime(dispatchCtx, apiKey)
  } else if (input.channel === "sms") {
    // REPOINTED onto the SURVIVOR — see the tombstone where loadBrokerageCredential
    // used to be. resolveSMSProviderForActor is the one SMS credential resolution in
    // the tree: it walks provider_overrides (user → team → brokerage), then the
    // unified ownership cascade, then the platform-managed tenant number, then env.
    // It THROWS when nothing is configured, which is the honest answer and is exactly
    // what the manual deep-link fallback below is for.
    const teamId = await loadTeamId(supabase, ctx.userId)
    const twilio = await resolveSMSProviderForActor({
      brokerageId: ctx.brokerageId,
      userId:      ctx.userId ?? null,
      teamId,
    })
      .then((r) =>
        r.credentials.apiKey && r.credentials.apiSecret && r.credentials.fromNumber
          ? { accountSid: r.credentials.apiKey, authToken: r.credentials.apiSecret, fromNumber: r.credentials.fromNumber }
          : null,
      )
      .catch(() => null)
    result = await dispatchViaSms(dispatchCtx, twilio)
  } else {
    // Same cascade the ShowingTime branch above already used. The old private
    // loader read integration_credentials directly, which is the LAST tier of
    // that cascade and skipped the agent's/team's own SendGrid key entirely.
    const teamId = await loadTeamId(supabase, ctx.userId)
    const sendgridConn = await resolveScopedConnection("sendgrid", {
      agentUserId: ctx.userId ?? null,
      teamId,
      brokerageId: ctx.brokerageId,
    })
    const sendgridKey = sendgridConn?.apiKey ?? process.env.SENDGRID_API_KEY ?? null
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

async function loadTeamId(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null
  try {
    const { data } = await supabase.from("users").select("team_id").eq("id", userId).maybeSingle()
    return (data?.team_id as string | null) ?? null
  } catch {
    return null
  }
}

// ─── TOMBSTONE — `loadBrokerageCredential` (wave 14) ─────────────────────────
//
// SURVIVORS:
//   SMS   lib/providers/messaging/resolve-sms-provider.ts:76 resolveSMSProviderForActor
//   key   lib/connections/resolve-scoped.ts resolveScopedConnection (already used
//         by the ShowingTime branch twenty lines above this one)
//
// DELETED AS A DUPLICATE, AND IT COULD NEVER HAVE WORKED. It read the Twilio pair
// out of `integration_credentials.api_secret`, a column NOTHING in the tree writes
// (the writerless-read census found it at :209), and asked that same table for
// `from_number`, which is not a column on it AT ALL — the map returned null for it
// unconditionally. Since the SMS branch required all three to be non-null, the
// `twilio` object was ALWAYS null and this dispatcher has never once sent an SMS
// through a provider; every call silently took the manual deep-link fallback.
//
// Meanwhile the credential it was looking for HAS a writer and a form, in a
// different shape: app/actions/phone-connect.ts:33 connectPhoneAction and
// app/actions/connections/connection-center.ts:215 connectApiKeyProvider both write
// `platform_credentials` with api_key = Account SID, config.auth_token and
// config.from_number — the exact three fields this needed. So this was not a
// missing writer; it was a second reader pointed at the wrong store.
//
// Building the missing api_secret WRITER for this reader would have been the wrong
// repair: it would have created a SECOND place a brokerage's Twilio credentials
// live, and the one the actual send path (sendSMS) reads would still be the other
// one. Merged onto the survivor instead, per CLAUDE.md §1.1.
//
// The api_secret COLUMN is not orphaned by this deletion — connection-manager.ts
// still reads it for both legacy stores, and connectCrmAction now writes it.
