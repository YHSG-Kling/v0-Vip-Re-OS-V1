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
import { sendSMS } from "@/lib/providers/messaging"

export async function ensureSmsFirstChannels(alertId: string) {
  const supabase = createServiceClient()
  const { data: alert } = await supabase
    .from("property_alerts")
    .select("id, delivery_channels, frequency")
    .eq("id", alertId)
    .maybeSingle()

  if (!alert || alert.frequency !== "instant") return { skipped: true as const }

  const current: string[] = Array.isArray(alert.delivery_channels)
    ? (alert.delivery_channels as string[])
    : []
  if (current[0] === "sms") return { skipped: true as const }

  const next = ["sms", ...current.filter((c) => c !== "sms")]
  await supabase.from("property_alerts").update({ delivery_channels: next }).eq("id", alertId)
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

  const { data: contact } = await supabase
    .from("contacts")
    .select(
      "id, brokerage_id, first_name, last_name, phone, dnc_status, sms_opt_out",
    )
    .eq("id", input.contactId)
    .maybeSingle()

  if (!contact || contact.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "contact_not_found" }
  }
  if (!contact.phone) return { success: false, error: "no_phone_on_file" }
  if (contact.dnc_status || contact.sms_opt_out) {
    return { success: false, error: "consent_blocked" }
  }

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

  await supabase.from("activities").insert({
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

  return { success: true }
}
