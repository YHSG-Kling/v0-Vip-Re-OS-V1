/**
 * Sprint 9 cont. — Marketing campaign touchpoint recorder.
 *
 * Records a per-(campaign × contact × channel) row whenever a campaign
 * asset is sent / posted / mailed to a contact. This is the spine
 * attribution reads back to figure out which campaigns touched a deal.
 *
 * Idempotency: the same (campaign, contact, channel, sent_at-day) won't
 * duplicate when called twice in the same day from the same source; we
 * rely on `source` + `external_id` to disambiguate the touchpoint vs.
 * a deliberate retarget. Callers should pass an external_id when one
 * exists (e.g. newsletter_campaign.id) so the touchpoint is linkable.
 *
 * Failure-isolated: never throws. Callers should fire-and-forget.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface RecordTouchpointInput {
  brokerageId:    string
  campaignId:     string
  contactId:      string
  channel:        "email" | "sms" | "direct_mail" | "social" | "qr_scan"
                | "blog" | "podcast" | "newsletter" | "phone" | "portal" | "video"
  externalTable?: string
  externalId?:    string
  source?:        "launch" | "trigger" | "manual" | "retarget"
  status?:        "queued" | "sent" | "delivered" | "opened" | "clicked"
                | "converted" | "bounced" | "failed"
  metadata?:      Record<string, unknown>
}

export async function recordCampaignTouchpointSafe(
  input: RecordTouchpointInput,
): Promise<{ ok: boolean; touchpointId?: string }> {
  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("marketing_campaign_touchpoints")
      .insert({
        brokerage_id:   input.brokerageId,
        campaign_id:    input.campaignId,
        contact_id:     input.contactId,
        channel:        input.channel,
        external_table: input.externalTable ?? null,
        external_id:    input.externalId    ?? null,
        status:         input.status        ?? "sent",
        source:         input.source        ?? "launch",
        metadata:       input.metadata      ?? {},
        sent_at:        new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()
    if (error || !data) return { ok: false }
    return { ok: true, touchpointId: data.id as string }
  } catch (err) {
    console.error("[touchpoint-recorder] insert failed:", err)
    return { ok: false }
  }
}

/**
 * Batch record — used by the campaign publisher to write one row per
 * resolved contact in the audience on launch. Single round-trip insert.
 */
export async function recordCampaignTouchpointsBulkSafe(
  brokerageId: string,
  campaignId:  string,
  contactIds:  string[],
  channel:     RecordTouchpointInput["channel"],
  source:      RecordTouchpointInput["source"] = "launch",
): Promise<{ ok: boolean; inserted: number }> {
  if (contactIds.length === 0) return { ok: true, inserted: 0 }
  try {
    const svc = createServiceClient()
    const rows = contactIds.map((cid) => ({
      brokerage_id: brokerageId,
      campaign_id:  campaignId,
      contact_id:   cid,
      channel,
      source,
      status:       "sent",
      sent_at:      new Date().toISOString(),
    }))
    const { error } = await svc.from("marketing_campaign_touchpoints").insert(rows)
    if (error) return { ok: false, inserted: 0 }
    return { ok: true, inserted: rows.length }
  } catch (err) {
    console.error("[touchpoint-recorder] bulk insert failed:", err)
    return { ok: false, inserted: 0 }
  }
}
