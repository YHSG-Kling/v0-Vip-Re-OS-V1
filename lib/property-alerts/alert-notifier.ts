// Alert notifier — delivers matched properties via email / SMS / in-app
// All channel delivery writes through the real tables only

import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail } from "@/lib/providers/dispatch"
import type { AlertProperty } from "./alert-matcher"

export interface DeliverResult {
  sent: number
  channelsUsed: string[]
  errors: string[]
}

export async function deliverAlertResults(
  alert: any,
  properties: Array<AlertProperty & { matchScore: number; matchReasons: string[] }>,
  brokerageId: string,
  batchId: string
): Promise<DeliverResult> {
  const supabase = createServiceClient()
  const channels: string[] = alert.delivery_channels ?? ["in_app"]
  const channelsUsed: string[] = []
  const errors: string[] = []
  let sent = 0

  // Load contact
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, phone, agent_id")
    .eq("id", alert.contact_id)
    .maybeSingle()

  if (!contact) return { sent: 0, channelsUsed: [], errors: ["contact_not_found"] }

  const n = properties.length
  const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/portal/alerts/${alert.id}`
  const agentScheduleUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/buyers/${alert.contact_id}/tours`

  // ── Email ─────────────────────────────────────────────────────────────────
  if (channels.includes("email") && contact.email) {
    try {
      // Load SendGrid credential
      const { data: sgCred } = await supabase
        .from("platform_credentials")
        .select("api_key, config")
        .eq("brokerage_id", brokerageId)
        .eq("platform", "sendgrid")
        .eq("is_active", true)
        .maybeSingle()

      if (sgCred?.api_key) {
        const subject = `[${n}] New ${n === 1 ? "Property Matches" : "Properties Match"} Your Search, ${contact.first_name}!`
        // Body only — assembleEmail() in dispatchEmail() appends signature + unsubscribe + legal
        const bodyHtml = buildEmailHtml({
          contactFirstName: contact.first_name,
          properties,
          portalUrl,
          agentScheduleUrl,
          n,
        })

        const fromEmail = (sgCred.config as any)?.from_email ?? process.env.SENDGRID_FROM_EMAIL ?? "alerts@vip-re.com"
        const fromName  = (sgCred.config as any)?.from_name  ?? "VIP Real Estate OS"

        await dispatchEmail({
          brokerageId,
          agentId:      contact.agent_id ?? undefined,
          leadId:       alert.contact_id,
          systemSource: "property_alert",
          from:         `${fromName} <${fromEmail}>`,
          to:           contact.email,
          subject,
          html:         bodyHtml,
        })

        channelsUsed.push("email")
        sent++
      }
    } catch (err: any) {
      console.error("[alert-notifier] email error:", err?.message)
      errors.push(`email: ${err?.message}`)
    }
  }

  // ── SMS ───────────────────────────────────────────────────────────────────
  if (channels.includes("sms") && contact.phone) {
    try {
      const { data: twilioCred } = await supabase
        .from("platform_credentials")
        .select("api_key, account_id, config")
        .eq("brokerage_id", brokerageId)
        .eq("platform", "twilio")
        .eq("is_active", true)
        .maybeSingle()

      if (twilioCred?.api_key && twilioCred?.account_id) {
        const fromPhone = (twilioCred.config as any)?.from_phone ?? ""
        const body = `${n} ${n === 1 ? "property matches" : "properties match"} your search! View now: ${portalUrl}`

        const formData = new URLSearchParams({ To: contact.phone, From: fromPhone, Body: body })
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioCred.account_id}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: "Basic " + Buffer.from(`${twilioCred.account_id}:${twilioCred.api_key}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData.toString(),
        })

        channelsUsed.push("sms")
        sent++
      }
    } catch (err: any) {
      console.error("[alert-notifier] sms error:", err?.message)
      errors.push(`sms: ${err?.message}`)
    }
  }

  // ── In-app notification ───────────────────────────────────────────────────
  if (channels.includes("in_app")) {
    try {
      await supabase.from("notifications").insert({
        user_id:     contact.agent_id ?? null,
        brokerage_id: brokerageId,
        type:        "property_alert",
        title:       `${n} new ${n === 1 ? "property" : "properties"} match ${contact.first_name}'s search`,
        body:        properties.map(p => p.property_address).slice(0, 3).join(", ") + (n > 3 ? ` +${n - 3} more` : ""),
        entity_type: "property_alert",
        entity_id:   alert.id,
        priority:    n >= 5 ? "high" : "medium",
        channel:     "in_app",
      })
      channelsUsed.push("in_app")
      sent++
    } catch (err: any) {
      errors.push(`in_app: ${err?.message}`)
    }
  }

  // ── Smart assistant suggestion for agent ──────────────────────────────────
  try {
    await supabase.from("smart_assistant_suggestions").insert({
      agent_id:            contact.agent_id ?? null,
      title:               `${n} new ${n === 1 ? "property" : "properties"} match ${contact.first_name} ${contact.last_name}'s alert`,
      description:         `Properties delivered via: ${channelsUsed.join(", ")}. Review and add top matches to tour plan.`,
      context_type:        "property_alert",
      action_type:         "review_alert_results",
      action_payload_json: JSON.stringify({ alert_id: alert.id, contact_id: alert.contact_id }),
      priority:            n >= 3 ? "high" : "medium",
      status:              "pending",
    })
  } catch (_) { /* non-fatal */ }

  // Update delivered_at on results
  await supabase
    .from("property_alert_results")
    .update({ delivered_at: new Date().toISOString(), delivery_channel: channelsUsed[0] ?? "in_app", delivery_batch_id: batchId })
    .eq("delivery_batch_id", batchId)

  return { sent, channelsUsed, errors }
}

// ── Email HTML builder ────────────────────────────────────────────────────────
function buildEmailHtml(params: {
  contactFirstName: string
  properties: Array<AlertProperty & { matchScore: number; matchReasons: string[] }>
  portalUrl: string
  agentScheduleUrl: string
  n: number
}): string {
  const { contactFirstName, properties, portalUrl, agentScheduleUrl, n } = params
  const cards = properties.map(p => `
    <tr>
      <td style="padding:16px;border-bottom:1px solid #e5e7eb;">
        ${p.primary_photo_url ? `<img src="${p.primary_photo_url}" width="100%" style="max-height:180px;object-fit:cover;border-radius:6px;margin-bottom:8px;" alt="Property photo" />` : ""}
        <p style="margin:0 0 4px;font-weight:600;font-size:15px;color:#111827;">${p.property_address}${p.city ? `, ${p.city}` : ""}</p>
        <p style="margin:0 0 8px;font-size:14px;color:#374151;">${p.list_price ? new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(p.list_price) : "Price TBD"}${p.bedrooms ? ` · ${p.bedrooms} bd` : ""}${p.bathrooms ? ` · ${p.bathrooms} ba` : ""}${p.sqft ? ` · ${p.sqft.toLocaleString()} sqft` : ""}</p>
        ${p.is_price_reduction ? `<span style="display:inline-block;background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:6px;">Price Reduced</span>` : `<span style="display:inline-block;background:#f0fdf4;color:#16a34a;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:6px;">New Listing</span>`}
        <p style="margin:4px 0 8px;font-size:12px;color:#6b7280;">${p.matchReasons.slice(0, 3).join(" · ")}</p>
        ${p.listing_url ? `<a href="${p.listing_url}" style="color:#2563eb;font-size:13px;font-weight:600;text-decoration:none;">View Details &rarr;</a>` : ""}
      </td>
    </tr>
  `).join("")

  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#f9fafb;margin:0;padding:0;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
  <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
    <tr><td style="padding:24px;background:#2563eb;color:#fff;">
      <h1 style="margin:0;font-size:20px;font-weight:700;">${n} New ${n === 1 ? "Property" : "Properties"} Match Your Search</h1>
      <p style="margin:4px 0 0;font-size:14px;opacity:.85;">Hi ${contactFirstName}, we found new matches for you!</p>
    </td></tr>
    ${cards}
    <tr><td style="padding:24px;text-align:center;border-top:1px solid #e5e7eb;">
      <a href="${portalUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;font-weight:600;text-decoration:none;margin-right:8px;">View All Matches</a>
      <a href="${agentScheduleUrl}" style="display:inline-block;border:1px solid #d1d5db;color:#374151;padding:12px 24px;border-radius:6px;font-weight:600;text-decoration:none;">Schedule a Showing</a>
      <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;"><a href="${portalUrl}/settings" style="color:#6b7280;">Adjust your alerts</a></p>
    </td></tr>
  </table>
  </td></tr></table></body></html>`
}
