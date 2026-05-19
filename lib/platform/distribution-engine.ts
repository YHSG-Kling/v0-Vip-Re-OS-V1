/**
 * PLATFORM DISTRIBUTION ENGINE (Engine 1)
 *
 * Routes platform-origin leads (scraped/aggregated by the platform itself,
 * not by an individual brokerage) to a subscriber tenant by zip-code service
 * area, in round-robin order based on signup date and last-received date.
 *
 * Engine 1 fires AFTER the lead has cleared the dedupe/enrichment/scoring gate
 * and BEFORE any ISA outreach. It sets `leads.distribution_brokerage_id`,
 * `leads.brokerage_id`, and `leads.distributed_at`, and writes a row to
 * `platform_lead_distributions` for rotation tracking.
 *
 * Engine 1 only handles `source_origin = 'platform'` leads. Brokerage-scraped
 * leads (`source_origin = 'brokerage'`) belong to the scraping brokerage by
 * definition and skip this engine entirely.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isPhoneOnSuppressionList, isEmailOnSuppressionList } from "./suppression-list"

interface DistributionResult {
  success: boolean
  brokerageId?: string
  rotationPosition?: number
  reason: string
}

interface ServiceAreaSubscriber {
  brokerage_id: string
  joined_at: string
}

interface LeadDistributionRow {
  id: string
  source_origin: "platform" | "brokerage" | null
  property_zip_code: string | null
  mailing_zip: string | null
  brokerage_id: string | null
  distribution_brokerage_id: string | null
  phone_digits: string | null
  email: string | null
  source_family: string | null
  motivation_type: string | null
  urgency_level: string | null
  raw_record_id: string | null
}

/**
 * Distributes a single platform-origin lead to the next-in-rotation subscriber
 * for the lead's zip code. No-op for `source_origin = 'brokerage'`.
 */
export async function distributePlatformLead(params: {
  leadId: string
}): Promise<DistributionResult> {
  const { leadId } = params
  const supabase = createServiceClient()

  // 1. Load the lead
  const { data: leadData, error: leadErr } = await supabase
    .from("leads")
    .select(
      "id, source_origin, property_zip_code, mailing_zip, brokerage_id, distribution_brokerage_id, " +
        "phone_digits, email, source_family, motivation_type, urgency_level, raw_record_id"
    )
    .eq("id", leadId)
    .single()

  if (leadErr || !leadData) {
    return { success: false, reason: `Lead not found: ${leadErr?.message ?? "no data"}` }
  }

  // Cast to typed shape — new columns aren't in the generated Supabase types yet
  const lead = leadData as unknown as LeadDistributionRow

  // 2. Skip non-platform leads (brokerage-scraped leads stay with their brokerage)
  if (lead.source_origin !== "platform") {
    return { success: false, reason: "skip_non_platform_origin" }
  }

  // 3. Already distributed — idempotent guard
  if (lead.distribution_brokerage_id) {
    return {
      success: true,
      brokerageId: lead.distribution_brokerage_id,
      reason: "already_distributed",
    }
  }

  // 4. Hard suppression: phone or email on platform_suppression_list
  //    (cross-tenant DNC — never give this lead to anyone)
  if (lead.phone_digits && (await isPhoneOnSuppressionList(lead.phone_digits))) {
    return { success: false, reason: "suppressed_phone" }
  }
  if (lead.email && (await isEmailOnSuppressionList(lead.email))) {
    return { success: false, reason: "suppressed_email" }
  }

  // 5. Resolve target zip — prefer property zip, fall back to mailing
  const zip: string | null = lead.property_zip_code || lead.mailing_zip
  if (!zip) {
    return { success: false, reason: "no_zip_code" }
  }

  // 6. Load active subscribers for this zip ordered by joined_at ASC
  //    (oldest subscribers in the zip get first lead in rotation cycle)
  const { data: subscribers, error: subErr } = await supabase
    .from("subscriber_service_areas")
    .select("brokerage_id, joined_at")
    .eq("zip_code", zip)
    .eq("active", true)
    .is("agent_user_id", null)
    .is("team_id", null)
    .order("joined_at", { ascending: true })

  if (subErr) {
    return { success: false, reason: `Failed to load subscribers: ${subErr.message}` }
  }
  if (!subscribers || subscribers.length === 0) {
    return { success: false, reason: "no_subscribers_for_zip" }
  }

  // 7. Determine rotation position by reading prior distributions for this zip
  const subscriberList = subscribers as ServiceAreaSubscriber[]
  const { count: priorCount } = await supabase
    .from("platform_lead_distributions")
    .select("id", { count: "exact", head: true })
    .eq("zip_code", zip)

  const rotationPosition = (priorCount ?? 0) % subscriberList.length
  const targetBrokerageId = subscriberList[rotationPosition].brokerage_id

  // 8. Stamp the lead with distribution + write rotation row atomically-ish
  const nowIso = new Date().toISOString()

  const { error: updateErr } = await supabase
    .from("leads")
    .update({
      brokerage_id: targetBrokerageId,
      distribution_brokerage_id: targetBrokerageId,
      distributed_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", leadId)
    .is("distribution_brokerage_id", null) // optimistic lock — don't overwrite if already set

  if (updateErr) {
    return { success: false, reason: `Lead distribution write failed: ${updateErr.message}` }
  }

  await supabase.from("platform_lead_distributions").insert({
    zip_code: zip,
    brokerage_id: targetBrokerageId,
    lead_id: leadId,
    raw_lead_id: lead.raw_record_id,
    distributed_at: nowIso,
    rotation_position: rotationPosition,
    source_family: lead.source_family,
    motivation_type: lead.motivation_type,
    urgency_level: lead.urgency_level,
  })

  // 9. Stamp the raw record too so downstream visibility is consistent
  if (lead.raw_record_id) {
    await supabase
      .from("raw_scraped_leads")
      .update({ brokerage_id: targetBrokerageId, updated_at: nowIso })
      .eq("id", lead.raw_record_id)
  }

  return {
    success: true,
    brokerageId: targetBrokerageId,
    rotationPosition,
    reason: `distributed_to_${targetBrokerageId}_position_${rotationPosition}`,
  }
}

/**
 * Batch entry point — call after a scrape execution completes.
 * Picks up all platform-origin leads with no distribution yet and distributes
 * them. Returns counts per outcome.
 */
export async function distributePendingPlatformLeads(params?: {
  limit?: number
}): Promise<{
  total: number
  distributed: number
  suppressed: number
  noZip: number
  noSubscribers: number
  failed: number
}> {
  const supabase = createServiceClient()
  const limit = params?.limit ?? 200

  const { data: pending, error } = await supabase
    .from("leads")
    .select("id")
    .eq("source_origin", "platform")
    .is("distribution_brokerage_id", null)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(limit)

  if (error || !pending) {
    return { total: 0, distributed: 0, suppressed: 0, noZip: 0, noSubscribers: 0, failed: 1 }
  }

  let distributed = 0
  let suppressed = 0
  let noZip = 0
  let noSubscribers = 0
  let failed = 0

  for (const row of pending) {
    const result = await distributePlatformLead({ leadId: (row as { id: string }).id })
    if (result.success && result.brokerageId) distributed++
    else if (result.reason === "suppressed_phone" || result.reason === "suppressed_email") suppressed++
    else if (result.reason === "no_zip_code") noZip++
    else if (result.reason === "no_subscribers_for_zip") noSubscribers++
    else if (result.reason !== "already_distributed" && result.reason !== "skip_non_platform_origin") failed++
  }

  return { total: pending.length, distributed, suppressed, noZip, noSubscribers, failed }
}
