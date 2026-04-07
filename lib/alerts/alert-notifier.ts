/**
 * lib/alerts/alert-notifier.ts
 * Spec: sendAlertNotification(alertId, contactId, agentUserId, matches, channels)
 * Channels: 'in_app' always. 'email' if in delivery_channels. Never SMS unless explicit.
 * Idempotency: skip if already sent today for same alert.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail } from "@/lib/providers/dispatch"

export interface AlertMatch {
  alertId:          string
  contactId:        string
  agentUserId:      string
  brokerageId:      string
  mlsId:            string
  address:          string
  city?:            string
  listPrice?:       number
  bedrooms?:        number
  bathrooms?:       number
  matchScore:       number
  listingUrl?:      string
  photoUrl?:        string
  isPriceReduction: boolean
}

export interface NotifyResult {
  sent:    boolean
  channel: string
}

export async function sendAlertNotification(
  alertId:     string,
  contactId:   string,
  agentUserId: string,
  matches:     AlertMatch[],
  channels:    string[] = ["in_app"]
): Promise<NotifyResult> {
  const supabase = createServiceClient()

  if (!matches.length) return { sent: false, channel: "" }

  const brokerageId = matches[0].brokerageId

  // 1. Idempotency: skip if already sent today for same alert
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { data: todayLog } = await supabase
    .from("property_alert_delivery_log")
    .select("id")
    .eq("alert_id", alertId)
    .gte("created_at", todayStart.toISOString())
    .not("properties_sent", "eq", 0)
    .limit(1)
    .maybeSingle()

  if (todayLog) return { sent: false, channel: "already_sent_today" }

  const n            = matches.length
  const channelsUsed: string[] = []

  // Load contact for name/email
  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, email, agent_id")
    .eq("id", contactId)
    .maybeSingle()

  const firstName = contact?.first_name ?? "there"

  // 2. Email — only if explicitly in channels
  if (channels.includes("email") && contact?.email) {
    try {
      const { data: sgCred } = await supabase
        .from("platform_credentials")
        .select("api_key, config")
        .eq("brokerage_id", brokerageId)
        .eq("provider_name", "sendgrid")
        .eq("is_active", true)
        .maybeSingle()

      if (sgCred?.api_key) {
        const fromEmail = (sgCred.config as any)?.from_email ?? process.env.SENDGRID_FROM_EMAIL ?? "alerts@vip-re.com"
        const fromName  = (sgCred.config as any)?.from_name  ?? "VIP Real Estate OS"
        const subject   = `${n} New ${n === 1 ? "Property Matches" : "Properties Match"} Your Search`

        const cards = matches.map(m => `
          <tr><td style="padding:12px;border-bottom:1px solid #e5e7eb">
            ${m.photoUrl ? `<img src="${m.photoUrl}" width="100%" style="max-height:160px;object-fit:cover;border-radius:6px;margin-bottom:6px;" alt="" />` : ""}
            <p style="margin:0 0 4px;font-weight:600;font-size:14px">${m.address}${m.city ? `, ${m.city}` : ""}</p>
            <p style="margin:0;font-size:13px;color:#374151">
              ${m.listPrice ? new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(m.listPrice) : ""}
              ${m.bedrooms ? ` · ${m.bedrooms} bd` : ""}${m.bathrooms ? ` · ${m.bathrooms} ba` : ""}
            </p>
            ${m.isPriceReduction ? `<span style="background:#fef2f2;color:#dc2626;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600">Price Reduced</span>` : `<span style="background:#f0fdf4;color:#16a34a;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600">New</span>`}
            ${m.listingUrl ? `<br/><a href="${m.listingUrl}" style="color:#2563eb;font-size:12px">View Details &rarr;</a>` : ""}
          </td></tr>`).join("")

        // Body only — assembleEmail() in dispatchEmail() appends signature + unsubscribe + legal
        const bodyHtml = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f9fafb;padding:32px 0">
          <table width="560" style="margin:0 auto;background:#fff;border-radius:8px;overflow:hidden">
            <tr><td style="padding:20px;background:#2563eb;color:#fff">
              <h2 style="margin:0">${n} New ${n === 1 ? "Property" : "Properties"} For You</h2>
              <p style="margin:4px 0 0;opacity:.85;font-size:13px">Hi ${firstName}, here are your latest matches</p>
            </td></tr>
            ${cards}
          </table></body></html>`

        await dispatchEmail({
          brokerageId,
          agentId:      agentUserId,
          leadId:       contactId,
          systemSource: "property_alert",
          from:         `${fromName} <${fromEmail}>`,
          to:           contact.email,
          subject,
          html:         bodyHtml,
        })
        channelsUsed.push("email")
      }
    } catch (err: any) {
      console.error("[alert-notifier] email error:", err?.message)
    }
  }

  // 3. In-app notification (always)
  try {
    await supabase.from("notifications").insert({
      user_id:      agentUserId,
      brokerage_id: brokerageId,
      type:         "property_alert",
      title:        `${n} new ${n === 1 ? "property matches" : "properties match"} ${firstName}'s alert`,
      body:         matches.slice(0, 2).map(m => m.address).join(", ") + (n > 2 ? ` +${n - 2} more` : ""),
      entity_type:  "property_alert",
      entity_id:    alertId,
      priority:     n >= 5 ? "high" : "medium",
      channel:      "in_app",
    })
    channelsUsed.push("in_app")
  } catch (err: any) {
    console.error("[alert-notifier] in_app error:", err?.message)
  }

  // 4. INSERT into property_alert_delivery_log
  await supabase.from("property_alert_delivery_log").insert({
    brokerage_id:        brokerageId,
    alert_id:            alertId,
    contact_id:          contactId,
    run_triggered_by:    "cron",
    properties_checked:  n,
    properties_matched:  n,
    properties_sent:     n,
    channels_used:       channelsUsed,
    idx_api_called:      true,
    error_message:       null,
  })

  return { sent: true, channel: channelsUsed[0] ?? "in_app" }
}
