"use server"

/**
 * app/actions/instant-property-alerts.ts
 *
 * Two SMS-first additions on top of the existing alert engine. The existing
 * `lib/property-alerts/alert-notifier.ts` already handles SMS as one of
 * several channels — this file adds:
 *
 *   1. ensureSmsFirstChannels()  — for any alert with frequency='instant',
 *      makes sure 'sms' is the FIRST delivery channel and email is a
 *      backup (98% SMS open rate vs 25% email).
 *
 *   2. sendFirstLookText()       — agent-side action that pushes an
 *      immediate SMS preview of a single property to a buyer the agent
 *      thinks would love it, even if the alert engine hasn't fired yet.
 *
 * Both write through the existing tables — no schema additions.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { requireCaller } from "@/lib/auth/require-caller"
import { isCrmContactStaff } from "@/lib/auth/crm-contact-staff"
import { sendSMS } from "@/lib/providers/messaging"
import { firstLookConsentBlock } from "@/lib/property-alerts/first-look-consent"

/**
 * Promote 'sms' to the front of an instant alert's delivery channels.
 *
 * FOUND UNGATED (wave 26, lane SEC3), and reported here because it sits beside
 * the site this lane was sent to fix. This is a `"use server"` export, so it is
 * a PUBLIC HTTP ENDPOINT (§4) — its single in-tree caller is
 * app/actions/property-alerts/alert-actions.ts:createPropertyAlert, but that is
 * not who can reach it. It took a bare `alertId` straight onto
 * `createServiceClient()` with NO session, NO tenant and NO role: anyone holding
 * an alert uuid could rewrite another brokerage's delivery channels and push a
 * stranger's alerts onto SMS — the channel that costs money to send and that a
 * TCPA complaint is about.
 *
 * Now: session identity (§4), the back-office roster, and the alert's OWN
 * brokerage compared to the caller's before the update. The internal call site
 * still passes — it runs inside the same server-action request, so the session
 * cookie is present, and createPropertyAlert has already proved the same seat.
 *
 * The refusal is a DISTINCT outcome from `skipped`. `skipped: true` means "read
 * it, nothing to do"; folding a refusal into that would have made "nobody could
 * check" render as "checked and fine" (§4, fail closed).
 */
export async function ensureSmsFirstChannels(
  alertId: string,
): Promise<
  | { skipped: true; refused?: undefined }
  | { skipped: false; channels: string[]; refused?: undefined }
  | { skipped: true; refused: string }
> {
  const caller = await requireCaller()
  if (!caller.ok) {
    return { skipped: true as const, refused: caller.reason === "unauthenticated" ? "Unauthorized" : caller.error }
  }
  if (!isCrmContactStaff(caller.userType)) return { skipped: true as const, refused: "Forbidden" }

  const supabase = createServiceClient()
  // `error` destructured: supabase-js RESOLVES a refused read, so `const { data }`
  // alone reported a denied lookup as "no such alert" and returned `skipped`,
  // which the caller reads as success.
  const { data: alert, error: alertError } = await supabase
    .from("property_alerts")
    .select("id, brokerage_id, delivery_channels, frequency")
    .eq("id", alertId)
    .maybeSingle()

  if (alertError) return { skipped: true as const, refused: "Access check failed" }
  if (!alert) return { skipped: true as const }
  if (alert.brokerage_id !== caller.brokerageId) return { skipped: true as const, refused: "Forbidden" }
  if (alert.frequency !== "instant") return { skipped: true as const }

  const current: string[] = Array.isArray(alert.delivery_channels)
    ? (alert.delivery_channels as string[])
    : []
  if (current[0] === "sms") return { skipped: true as const }

  const next = ["sms", ...current.filter((c) => c !== "sms")]
  // Tenant predicate on the WRITE as well as the read, and the row is COUNTED:
  // an update that matches nothing also resolves with `error: null` (§3), so
  // without `.select()` a refused write was byte-identical to one that worked.
  const { data: updated, error: updateError } = await supabase
    .from("property_alerts")
    .update({ delivery_channels: next })
    .eq("id", alertId)
    .eq("brokerage_id", caller.brokerageId)
    .select("id")
  if (updateError) return { skipped: true as const, refused: updateError.message }
  if (!updated || updated.length === 0) return { skipped: true as const, refused: "Forbidden" }

  return { skipped: false as const, channels: next }
}

export async function sendFirstLookText(input: {
  contactId: string
  listingId?: string
  externalListingUrl?: string
  customMessage?: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  // ── THE ROLE TEST THAT WAS MISSING (wave 26, lane SEC3) ─────────────────────
  //
  // `requireAuth` proves a session and a tenant; it does not ask WHO. The gate
  // then compared the contact's brokerage_id to the caller's and admitted on
  // EQUALITY ALONE. `users.user_type` can hold `contact`, `vendor` and `lender`
  // on rows that carry a brokerage_id — so a vendor seat could make the
  // brokerage send an SMS, from the brokerage's number, to any client in the
  // tenant, with `customMessage` under the vendor's control and an `activities`
  // row filed against that client's record as if their agent had sent it. That
  // is an outbound egress on someone else's client, billed to the brokerage and
  // answerable under TCPA by the agent whose name is on it.
  //
  // This is the agent-side "I saw this and thought of you" push — its only
  // caller is the CRM buyer-match panel — so the back-office roster is the
  // question, and it is asked before the contact is read.
  if (!isCrmContactStaff(auth.userType)) return { success: false, error: "forbidden" }

  // `error` destructured (§3): supabase-js RESOLVES a refused read, so a denied
  // contacts lookup came back as `data: null` and was reported as
  // "contact_not_found" — a clean negative. An outage must not be answered with
  // a sentence that says the record does not exist.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(
      "id, brokerage_id, first_name, last_name, phone, dnc_status, sms_opt_out",
    )
    .eq("id", input.contactId)
    .maybeSingle()

  if (contactError) return { success: false, error: "access_check_failed" }
  if (!contact || contact.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "contact_not_found" }
  }
  const block = firstLookConsentBlock(contact)
  if (block) return { success: false, error: block }

  let propertyLine = ""
  let portalUrl = input.externalListingUrl ?? ""

  if (input.listingId) {
    const { data: listing } = await supabase
      .from("listings")
      .select("id, mls_number, list_price, bedrooms, bathrooms, sqft, address, city, state")
      .eq("id", input.listingId)
      .maybeSingle()
    if (listing) {
      const price = listing.list_price ? `$${Number(listing.list_price).toLocaleString()}` : "TBD"
      propertyLine = `${listing.address ?? ""} ${listing.city ?? ""}, ${listing.state ?? ""} — ${price}, ${listing.bedrooms ?? "?"}bd/${listing.bathrooms ?? "?"}ba`
      portalUrl = portalUrl || `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/portal/listings/${listing.id}`
    }
  }

  const firstName = contact.first_name ?? "there"
  const body =
    input.customMessage ??
    `Hi ${firstName} — saw this just hit and thought of you: ${propertyLine}\n${portalUrl}\nText back if you want me to set up a tour.`

  const sendResult = await sendSMS({
    to: contact.phone,
    body,
    brokerageId: contact.brokerage_id,
    contactId: contact.id,
    metadata: { source: "first_look_text", listingId: input.listingId ?? null },
  } as any)

  if (!(sendResult as any)?.success) {
    return { success: false, error: (sendResult as any)?.error ?? "send_failed" }
  }

  // The SMS is already out the door (send error returned above). This row is
  // the record of that send — the AI reads it back as outreach that happened.
  const { error: firstLookActivityError } = await supabase.from("activities").insert({
    contact_id: contact.id,
    brokerage_id: auth.brokerageId,
    agent_id: auth.agentId,
    activity_type: "first_look_text",
    title: "First-look SMS sent",
    description: `First-look SMS: ${propertyLine || input.externalListingUrl || "(no property)"}`,
    completed_at: new Date().toISOString(),
    status: "completed",
    channel: "sms",
    entity_type: "contact",
  })
  if (firstLookActivityError) {
    console.error("[instantPropertyAlerts] first_look_text activity REJECTED — the SMS was sent but is not on the contact's record:", firstLookActivityError.message)
  }

  return { success: true }
}
