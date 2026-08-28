/**
 * lib/marketing/email-campaign-sender.ts
 *
 * THE EMAIL-CAMPAIGN SEND, made reachable — the loop audit found TWO dead
 * ends here: (1) scheduleEmailCampaign set status='scheduled' + send_date
 * but NOTHING ever consumed it (no cron read email_campaigns), and
 * (2) prepareListingEmailCampaign queued per-contact email_sends rows that
 * no worker drained — and its campaigns keep content in the linked
 * email_template, which the old action refused to send (it required
 * campaign.content). Scheduled campaigns simply never went out.
 *
 * ONE sender now serves both the manual action and the new
 * send-email-campaigns cron (keep-one):
 *   · html resolves campaign.content → email_templates.body fallback
 *   · recipients resolve from queued email_sends (listing campaigns,
 *     marked sent/failed per row) or newsletter_subscribers (broadcasts,
 *     deduped by email)
 *   · every message rides dispatchEmail — the ONE consent-gated egress
 *   · honest lifecycle: sending → sent with real counts; kernel event
 */
import { KernelEvent, processKernelEvent } from "@/lib/kernel"

type Svc = any

interface CampaignRow {
  id: string
  brokerage_id: string
  agent_id: string | null
  subject_line: string
  content: string | null
  template_id: string | null
  status: string
  audience_segment_id: string | null
}

async function resolveCampaignHtml(svc: Svc, campaign: CampaignRow): Promise<string | null> {
  if (campaign.content) return campaign.content
  if (!campaign.template_id) return null
  const { data: tpl } = await svc.from("email_templates")
    .select("body").eq("id", campaign.template_id).maybeSingle()
  return (tpl as { body: string | null } | null)?.body ?? null
}

export interface CampaignSendResult {
  ok: boolean
  sent: number
  failed: number
  recipients: number
  error: string | null
}

/** Send one campaign now (service-side). Callers own auth; the consent gate
 *  lives inside dispatchEmail. Safe against double-send via the 'sending'
 *  status claim. */
export async function sendCampaignNow(svc: Svc, campaignId: string): Promise<CampaignSendResult> {
  const { data: c } = await svc.from("email_campaigns")
    .select("id, brokerage_id, agent_id, subject_line, content, template_id, status, audience_segment_id")
    .eq("id", campaignId).maybeSingle()
  const campaign = c as CampaignRow | null
  if (!campaign) return { ok: false, sent: 0, failed: 0, recipients: 0, error: "Campaign not found" }
  if (campaign.status === "sent" || campaign.status === "sending") {
    return { ok: false, sent: 0, failed: 0, recipients: 0, error: "Campaign already sent or sending" }
  }

  const html = await resolveCampaignHtml(svc, campaign)
  if (!html) return { ok: false, sent: 0, failed: 0, recipients: 0, error: "Campaign has no content (body or template)" }

  // Claim before the loop so a concurrent tick can't double-send.
  const { data: claimed } = await svc.from("email_campaigns")
    .update({ status: "sending" })
    .eq("id", campaignId).neq("status", "sending").neq("status", "sent")
    .select("id").maybeSingle()
  if (!claimed) return { ok: false, sent: 0, failed: 0, recipients: 0, error: "Campaign claimed by another worker" }

  // From: the campaign agent's real address, else the tenant's configured
  // sender. NEVER a placeholder — this used to fall back to
  // "noreply@example.com", which SendGrid rejects as an unverified sender
  // identity AND which OVERRODE the brokerage's real configured from-address,
  // because sendEmail resolves `params.from || SENDGRID_FROM_EMAIL`. A tenant
  // with SendGrid fully set up still had every campaign fail at the provider.
  const { resolveOutboundSender, formatSender, isUsableSender, NO_SENDER_ERROR } =
    await import("@/lib/providers/outbound-sender")
  let fromEmail: string | null = null
  if (campaign.agent_id) {
    const { data: u } = await svc.from("users").select("email").eq("id", campaign.agent_id).maybeSingle()
    const agentEmail = (u as { email: string | null } | null)?.email ?? null
    if (isUsableSender(agentEmail)) fromEmail = agentEmail
  }
  if (!fromEmail) {
    const sender = await resolveOutboundSender(svc, campaign.brokerage_id)
    fromEmail = sender ? formatSender(sender) : null
  }
  if (!fromEmail) {
    // Refuse before spending the tenant's quota to fail. The campaign returns
    // to its prior status so a human can configure a sender and re-run it.
    await svc.from("email_campaigns").update({ status: campaign.status }).eq("id", campaignId)
    return { ok: false, sent: 0, failed: 0, recipients: 0, error: NO_SENDER_ERROR }
  }

  const { dispatchEmail } = await import("@/lib/providers/dispatch")
  let sent = 0, failed = 0, recipients = 0

  // Path A — queued per-contact sends (listing campaigns)
  const { data: queued } = await svc.from("email_sends")
    .select("id, contact_id").eq("campaign_id", campaignId).eq("status", "queued").limit(2000)
  const queuedRows = (queued ?? []) as Array<{ id: string; contact_id: string | null }>

  if (queuedRows.length > 0) {
    for (const row of queuedRows) {
      let email: string | null = null
      if (row.contact_id) {
        const { data: contact } = await svc.from("contacts")
          .select("email").eq("id", row.contact_id).maybeSingle()
        email = (contact as { email: string | null } | null)?.email ?? null
      }
      if (!email) {
        await svc.from("email_sends").update({ status: "failed" }).eq("id", row.id)
        failed++
        continue
      }
      recipients++
      const result = await dispatchEmail({
        brokerageId: campaign.brokerage_id,
        userId: campaign.agent_id ?? undefined,
        from: fromEmail,
        to: email,
        subject: campaign.subject_line,
        html,
        contactId: row.contact_id ?? undefined,
        channelPurpose: "campaign",
        systemSource: "email_campaign",
        metadata: { campaign_id: campaignId, email_send_id: row.id },
      })
      await svc.from("email_sends").update({
        status: result.success ? "sent" : "failed",
        ...(result.success && { sent_at: new Date().toISOString() }),
      }).eq("id", row.id)
      if (result.success) sent++; else failed++
    }
  } else if (campaign.audience_segment_id) {
    // Path B — segment-targeted send: recipients resolve from contact_segments.
    // Memberships are opened and closed by lib/marketing/segment-membership.ts —
    // reached from the workflow add_to_segment / remove_from_segment steps
    // (lib/workflow/adapters/segment-ops.ts) and from the agent-facing door on
    // the contact page (app/actions/contacts/segment-membership.ts).
    //
    // ACTIVE MEMBERS ONLY. `removed_at IS NULL` is the whole point of the
    // column: it used to be read here and written NOWHERE, so a contact added
    // to a segment received its campaigns forever. It is an AUDIENCE filter,
    // not a consent one — consent is checked per recipient inside dispatchEmail
    // (lib/kernel/compliance/check-suppression.ts), which is the last word and
    // which no segment membership can talk over.
    const { data: members, error: memberError } = await svc.from("contact_segments")
      .select("contact_id")
      .eq("segment_id", campaign.audience_segment_id)
      .eq("brokerage_id", campaign.brokerage_id)
      .is("removed_at", null)
      .limit(2000)
    if (memberError) {
      await svc.from("email_campaigns").update({ status: campaign.status }).eq("id", campaignId)
      return { ok: false, sent: 0, failed: 0, recipients: 0, error: `Segment resolution failed: ${memberError.message}` }
    }
    const memberIds = [...new Set(((members ?? []) as Array<{ contact_id: string | null }>)
      .map((m) => m.contact_id).filter(Boolean))] as string[]
    if (memberIds.length === 0) {
      await svc.from("email_campaigns").update({ status: campaign.status }).eq("id", campaignId)
      return { ok: false, sent: 0, failed: 0, recipients: 0, error: "No contacts in the target segment" }
    }
    const { data: segContacts, error: segContactsError } = await svc.from("contacts")
      .select("id, email")
      .in("id", memberIds)
      .eq("brokerage_id", campaign.brokerage_id)
    if (segContactsError) {
      await svc.from("email_campaigns").update({ status: campaign.status }).eq("id", campaignId)
      return { ok: false, sent: 0, failed: 0, recipients: 0, error: `Segment contact lookup failed: ${segContactsError.message}` }
    }
    const seenEmails = new Set<string>()
    const segRecipients = ((segContacts ?? []) as Array<{ id: string; email: string | null }>)
      .filter((r) => r.email && !seenEmails.has(r.email) && seenEmails.add(r.email))
    if (segRecipients.length === 0) {
      await svc.from("email_campaigns").update({ status: campaign.status }).eq("id", campaignId)
      return { ok: false, sent: 0, failed: 0, recipients: 0, error: "No segment contacts have an email address" }
    }
    for (const contact of segRecipients) {
      recipients++
      const result = await dispatchEmail({
        brokerageId: campaign.brokerage_id,
        userId: campaign.agent_id ?? undefined,
        from: fromEmail,
        to: contact.email as string,
        subject: campaign.subject_line,
        html,
        contactId: contact.id,
        channelPurpose: "campaign",
        systemSource: "email_campaign",
        metadata: { campaign_id: campaignId, segment_id: campaign.audience_segment_id },
      })
      if (result.success) sent++; else failed++
    }
  } else {
    // Path C — broadcast to the subscriber list (deduped by email)
    let subscriberQuery = svc.from("newsletter_subscribers")
      .select("id, email, contact_id")
      .eq("brokerage_id", campaign.brokerage_id)
      .eq("status", "subscribed")
    if (campaign.agent_id) subscriberQuery = subscriberQuery.eq("agent_id", campaign.agent_id)
    const { data: subs } = await subscriberQuery
    const seen = new Set<string>()
    const uniqueSubs = ((subs ?? []) as Array<{ id: string; email: string; contact_id: string | null }>)
      .filter((s) => s.email && !seen.has(s.email) && seen.add(s.email))
    if (uniqueSubs.length === 0) {
      await svc.from("email_campaigns").update({ status: campaign.status }).eq("id", campaignId)
      return { ok: false, sent: 0, failed: 0, recipients: 0, error: "No subscribed recipients" }
    }
    for (const sub of uniqueSubs) {
      recipients++
      const result = await dispatchEmail({
        brokerageId: campaign.brokerage_id,
        userId: campaign.agent_id ?? undefined,
        from: fromEmail,
        to: sub.email,
        subject: campaign.subject_line,
        html,
        contactId: sub.contact_id ?? undefined,
        channelPurpose: "campaign",
        systemSource: "email_campaign",
        metadata: { campaign_id: campaignId, subscriber_id: sub.id },
      })
      if (sub.contact_id) {
        await svc.from("newsletter_sends").insert({
          brokerage_id: campaign.brokerage_id,
          contact_id: sub.contact_id,
          campaign_id: campaignId,
          subject: campaign.subject_line,
          status: result.success ? "sent" : "failed",
          sent_at: result.success ? new Date().toISOString() : null,
        })
      }
      if (result.success) sent++; else failed++
    }
  }

  await svc.from("email_campaigns").update({
    status: "sent",
    sent_at: new Date().toISOString(),
    recipient_count: recipients,
    delivered_count: sent,
  }).eq("id", campaignId)

  await processKernelEvent({
    event: KernelEvent.EMAIL_CAMPAIGN_SENT,
    brokerageId: campaign.brokerage_id,
    entityType: "newsletter_campaign",
    entityId: campaignId,
  }).catch(() => { /* non-blocking */ })

  return { ok: true, sent, failed, recipients, error: null }
}

/** Cron work: every scheduled campaign whose send_date has arrived goes out. */
export async function runScheduledEmailCampaigns(svc: Svc): Promise<{ campaignsSent: number; campaignErrors: number }> {
  const out = { campaignsSent: 0, campaignErrors: 0 }
  const { data: due } = await svc.from("email_campaigns")
    .select("id")
    .eq("status", "scheduled")
    .lte("send_date", new Date().toISOString())
    .limit(10)
  for (const row of ((due ?? []) as Array<{ id: string }>)) {
    const r = await sendCampaignNow(svc, row.id)
    if (r.ok) out.campaignsSent++
    else out.campaignErrors++
  }
  return out
}
