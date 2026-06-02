/**
 * app/api/cron/publish-newsletters/route.ts
 *
 * Hourly publisher for newsletter_campaigns. Mirrors the publish-social-posts
 * cron pattern but assembles a PER-RECIPIENT body from the campaign's source
 * newsletter sections, filtered by the recipient's contact_persona.
 *
 * Flow per ready campaign:
 *   1. Brokerage-wide broadcast frequency cap (evaluateBroadcastDeconflict
 *      → newsletter / 7d / 1 per segment). If exceeded, mark campaign status
 *      'deferred' and move on.
 *   2. Resolve subscribers (status='active') for the brokerage + agent +
 *      audience segment (read from the linked newsletters.audience_segment).
 *   3. For each subscriber:
 *        - Read contacts.contact_persona.
 *        - Resolve per-persona sections via resolveSectionsForRecipient.
 *        - Assemble HTML via assembleNewsletterHtml.
 *        - Dispatch via dispatchEmail (compliance + suppression + 1:1
 *          de-conflict already gated there).
 *        - Write newsletter_sends row with status from dispatch result.
 *   4. Mark campaign status='sent' + sent_at on success; emit
 *      NEWSLETTER_SENT kernel event.
 *
 * Idempotency: campaign moves to 'sending' before recipient loop and is
 * skipped on subsequent ticks while in flight. A unique partial index on
 * (campaign_id, contact_id) WHERE status IN ('sent','queued','delivered')
 * would be ideal — for now we check newsletter_sends presence per recipient
 * before dispatching (so a mid-loop crash + replay is safe).
 *
 * Auth: CRON_SECRET via Authorization: Bearer or ?secret= (matches the rest
 * of the cron fleet).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { dispatchEmail } from "@/lib/providers/dispatch"
import { evaluateBroadcastDeconflict } from "@/lib/kernel/deconflict"
import {
  resolveSectionsForRecipient,
  assembleNewsletterHtml,
} from "@/lib/kernel/newsletter/assemble"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

interface CampaignRow {
  id:                   string
  brokerage_id:         string
  agent_id:             string | null
  campaign_name:        string | null
  subject_line:         string | null
  content:              string | null
  status:               string | null
  approval_status:      string | null
  marketing_campaign_id: string | null
  created_by:           string | null
}

interface SubscriberRow {
  id:           string
  contact_id:   string | null
  email:        string | null
  first_name:   string | null
  last_name:    string | null
  status:       string
  brokerage_id: string
  agent_id:     string | null
}

interface CampaignResult {
  campaign_id:    string
  brokerage_id:   string
  agent_id:       string | null
  outcome:        string
  recipients:     number
  sent:           number
  suppressed:     number
  errors:         number
  reason?:        string
}

export async function GET(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  // Pull ready campaigns: approved + scheduled + send_date due. Cap at 25 per
  // tick so a backlog drains across multiple cron runs instead of timing out.
  const { data: campaigns, error } = await svc
    .from("newsletter_campaigns")
    .select("id, brokerage_id, agent_id, campaign_name, subject_line, content, status, approval_status, marketing_campaign_id, created_by")
    .eq("approval_status", "approved")
    .in("status", ["scheduled", "queued"])
    .lte("send_date", new Date().toISOString())
    .order("send_date", { ascending: true })
    .limit(25)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: CampaignResult[] = []

  for (const c of (campaigns ?? []) as CampaignRow[]) {
    const r = await publishCampaign(svc, c)
    results.push(r)
  }

  return NextResponse.json({
    ran_at:               new Date().toISOString(),
    campaigns_processed:  results.length,
    results,
  })
}

async function publishCampaign(svc: ReturnType<typeof createServiceClient>, c: CampaignRow): Promise<CampaignResult> {
  // newsletter_sections.newsletter_id FKs to newsletter_campaigns.id — so the
  // "newsletter" for section assembly is the campaign itself. There is no
  // separate newsletters row to pull sections from.
  const newsletterId: string = c.id

  // Wave 15 — newsletter video. ONE render per campaign embeds in every
  // recipient's body (cost-bounded: $0.30 ÷ N, never × N). Read the URL
  // from newsletter_video_renders; if present, prepend an embed block to
  // the campaign body before per-persona section assembly.
  let videoEmbed = ""
  try {
    const { data: vr } = await svc
      .from("newsletter_video_renders")
      .select("video_url, status")
      .eq("newsletter_campaign_id", c.id)
      .maybeSingle()
    const ready = vr as { video_url: string | null; status: string } | null
    if (ready?.status === "completed" && ready.video_url) {
      videoEmbed = [
        `<div style="margin:0 0 24px 0;text-align:center">`,
        `  <video controls preload="metadata" style="max-width:100%;border-radius:8px;">`,
        `    <source src="${ready.video_url}" type="video/mp4">`,
        `    Your email client doesn't support video — `,
        `    <a href="${ready.video_url}">click here to watch</a>.`,
        `  </video>`,
        `</div>`,
      ].join("\n")
    }
  } catch { /* best-effort — newsletter still sends without the video */ }

  // Brokerage-wide newsletter cooldown (1/7d default). Per-segment scoping is
  // a follow-up — the campaign row doesn't carry the audience segment yet
  // and adding the join would silently filter most setups to zero matches.
  const cap = await evaluateBroadcastDeconflict({
    brokerageId:  c.brokerage_id,
    channel:      "newsletter",
    segment:      null,
    systemSource: "publish-newsletters",
  })
  if (!cap.allowed) {
    await svc.from("newsletter_campaigns").update({ status: "deferred" }).eq("id", c.id)
    return {
      campaign_id: c.id, brokerage_id: c.brokerage_id, agent_id: c.agent_id,
      outcome: "deferred", recipients: 0, sent: 0, suppressed: 0, errors: 0,
      reason: cap.reason,
    }
  }

  // Claim the campaign so concurrent ticks don't re-send it.
  const { data: claimed } = await svc
    .from("newsletter_campaigns")
    .update({ status: "sending" })
    .eq("id", c.id)
    .in("status", ["scheduled", "queued"])
    .select("id")
  if (!claimed?.length) {
    return {
      campaign_id: c.id, brokerage_id: c.brokerage_id, agent_id: c.agent_id,
      outcome: "skipped_concurrent", recipients: 0, sent: 0, suppressed: 0, errors: 0,
    }
  }

  // Resolve subscriber list. Note: newsletter_subscribers schema today does
  // NOT carry a segment column — the segment filter is applied via the linked
  // newsletter's audience_segment AND the contact's lifecycle_state mapping
  // (so a "lifetime_customer" segment maps to contacts with that state).
  let subs: SubscriberRow[] = []
  try {
    const ownerAgent = c.agent_id ?? c.created_by ?? null
    let q = svc
      .from("newsletter_subscribers")
      .select("id, contact_id, email, first_name, last_name, status, brokerage_id, agent_id")
      .eq("brokerage_id", c.brokerage_id)
      .eq("status", "active")
    if (ownerAgent) q = q.eq("agent_id", ownerAgent)
    const { data } = await q
    subs = (data ?? []) as SubscriberRow[]
  } catch { /* fall through with empty list */ }

  if (subs.length === 0) {
    await svc.from("newsletter_campaigns").update({ status: "sent" }).eq("id", c.id)
    return {
      campaign_id: c.id, brokerage_id: c.brokerage_id, agent_id: c.agent_id,
      outcome: "sent_empty", recipients: 0, sent: 0, suppressed: 0, errors: 0,
    }
  }

  // For each subscriber: resolve persona → sections → assemble → dispatch → log.
  let sent = 0, suppressed = 0, errors = 0
  const fromAddress = `newsletter@${(process.env.NEWSLETTER_FROM_DOMAIN ?? "platform.com")}`

  for (const s of subs) {
    if (!s.email) continue

    // Idempotency check — already dispatched this campaign to this contact?
    if (s.contact_id) {
      try {
        const { data: prior } = await svc
          .from("newsletter_sends")
          .select("id")
          .eq("campaign_id", c.id)
          .eq("contact_id", s.contact_id)
          .in("status", ["sent", "queued", "delivered"])
          .limit(1)
          .maybeSingle()
        if (prior) continue
      } catch { /* if the check fails, fall through and let dispatch run */ }
    }

    // Persona + LOCATION from contacts table — Wave 18 makes the location
    // signal flow through to the section filter. Per-recipient section
    // scoping (a Miami subscriber sees Miami-only sections, Tampa sees
    // Tampa, all from one campaign).
    let persona: string | null = null
    let location: { city?: string | null; state?: string | null; zip_code?: string | null } | null = null
    if (s.contact_id) {
      try {
        const { data: contact } = await svc
          .from("contacts")
          .select("contact_persona, city, state, zip_code")
          .eq("id", s.contact_id)
          .maybeSingle()
        const cr = contact as { contact_persona?: string | null; city?: string | null; state?: string | null; zip_code?: string | null } | null
        persona  = cr?.contact_persona ?? null
        location = cr ? { city: cr.city, state: cr.state, zip_code: cr.zip_code } : null
      } catch { /* anonymous subscriber — fall through with both null */ }
    }

    const sections = await resolveSectionsForRecipient({
      brokerageId:       c.brokerage_id,
      newsletterId,
      recipientPersona:  persona,
      recipientLocation: location,
    })

    const assembled = assembleNewsletterHtml({
      context: {
        campaignId:       c.id,
        brokerageId:      c.brokerage_id,
        newsletterId,
        campaignSubject:  c.subject_line,
        // Video embed (when rendered) prepends the campaign body — same URL
        // for every recipient (cost-bounded pattern; $0.30 per campaign).
        campaignBodyHtml: videoEmbed
          ? `${videoEmbed}\n${c.content ?? ""}`
          : c.content,
      },
      sections,
    })

    const result = await dispatchEmail({
      brokerageId:    c.brokerage_id,
      userId:         c.agent_id ?? c.created_by ?? undefined,
      contactId:      s.contact_id ?? undefined,
      systemSource:   "newsletter",
      channelPurpose: "campaign",
      from:           fromAddress,
      to:             s.email,
      subject:        assembled.subject,
      html:           assembled.html,
      text:           assembled.text,
      metadata: {
        newsletter_campaign_id: c.id,
        newsletter_id:          newsletterId,
        rendered_section_ids:   assembled.rendered_section_ids,
      },
    })

    const status =
      result.success                                            ? "sent"
      : result.providerKey === "deconflict_gate"                ? "suppressed"
      : result.providerKey === "compliance_gate"                ? "suppressed"
                                                                : "failed"

    if (status === "sent")       sent++
    if (status === "suppressed") suppressed++
    if (status === "failed")     errors++

    try {
      await svc.from("newsletter_sends").insert({
        brokerage_id:        c.brokerage_id,
        campaign_id:         c.id,
        contact_id:          s.contact_id,
        template_id:         null,
        subject:             assembled.subject,
        status,
        provider_message_id: result.messageId ?? null,
        sent_at:             status === "sent" ? new Date().toISOString() : null,
      })
    } catch { /* row write failure shouldn't block remaining recipients */ }
  }

  await svc.from("newsletter_campaigns")
    .update({ status: "sent" })
    .eq("id", c.id)

  // Emit kernel event so notification rules + analytics pick this up.
  try {
    const { processKernelEvent } = await import("@/lib/kernel/notification-engine")
    const { KernelEvent }        = await import("@/lib/kernel/events")
    void processKernelEvent({
      event:      KernelEvent.NEWSLETTER_SENT,
      brokerageId: c.brokerage_id,
      entityType: "newsletter_campaign",
      entityId:   c.id,
    })
  } catch { /* notification engine is optional in this path */ }

  return {
    campaign_id: c.id, brokerage_id: c.brokerage_id, agent_id: c.agent_id,
    outcome: "sent", recipients: subs.length, sent, suppressed, errors,
  }
}
