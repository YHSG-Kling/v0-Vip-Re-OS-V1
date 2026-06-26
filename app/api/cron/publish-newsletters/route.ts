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
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { checkAssetReadiness, ASSET_READINESS_CONFIGS } from "@/lib/kernel/composition-gate"

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
  /** Wave 21 — the composition gate's video-render readiness check only
   *  fires for AI-authored campaigns (the only ones the newsletter-video-
   *  render cron stages). Human-authored campaigns never had a video
   *  expectation, so the gate skips that check for them. */
  is_ai_generated:      boolean | null
  send_date:            string | null
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
  /** Joined from contacts in a single query — persona + location for
   *  per-recipient section filtering. Eliminates the per-recipient N+1
   *  the cron previously did inside the publish loop. */
  contact:      {
    contact_persona: string | null
    city:            string | null
    state:           string | null
    zip_code:        string | null
  } | null
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
    .select("id, brokerage_id, agent_id, campaign_name, subject_line, content, status, approval_status, marketing_campaign_id, created_by, is_ai_generated, send_date")
    .eq("approval_status", "approved")
    .in("status", ["scheduled"])
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

/**
 * Wave 21 — defer helper for the composition gate. Writes the structured
 * reason into newsletter_campaigns.defer_reason (m132) and emits the
 * NEWSLETTER_SEND_DEFERRED kernel event so the marketing-agent observability
 * surfaces see WHICH campaigns degraded and why. The campaign stays in
 * 'deferred' status — the agent can manually re-queue or the next cron run
 * picks it up after the gating condition clears (e.g. video render
 * completes between ticks).
 */
async function deferCampaign(
  svc: ReturnType<typeof createServiceClient>,
  c: CampaignRow,
  reason: string,
): Promise<CampaignResult> {
  await svc.from("newsletter_campaigns")
    .update({ status: "deferred", defer_reason: reason })
    .eq("id", c.id)
  processKernelEvent({
    event:       KernelEvent.NEWSLETTER_SEND_DEFERRED,
    brokerageId: c.brokerage_id,
    entityType:  "newsletter_campaign",
    entityId:    c.id,
    metadata:    { reason, campaign_name: c.campaign_name },
  }).catch((err) => console.error(`[publish-newsletters] NEWSLETTER_SEND_DEFERRED emit failed for ${c.id}:`, err))
  return {
    campaign_id: c.id, brokerage_id: c.brokerage_id, agent_id: c.agent_id,
    outcome: "deferred", recipients: 0, sent: 0, suppressed: 0, errors: 0,
    reason,
  }
}

async function publishCampaign(svc: ReturnType<typeof createServiceClient>, c: CampaignRow): Promise<CampaignResult> {
  // newsletter_sections.newsletter_id FKs to newsletter_campaigns.id — so the
  // "newsletter" for section assembly is the campaign itself. There is no
  // separate newsletters row to pull sections from.
  const newsletterId: string = c.id

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
    return await deferCampaign(svc, c, `broadcast_cap:${cap.reason ?? "exceeded"}`)
  }

  // ── Wave 21 COMPOSITION GATE ─────────────────────────────────────────────
  // Three checks. Any failure marks status='deferred' with a structured
  // defer_reason and emits NEWSLETTER_SEND_DEFERRED so the marketing-agent
  // observability surfaces (admin page + weekly snapshot) show WHY a campaign
  // didn't send, instead of the campaign silently going out half-baked.
  //
  // Check (1) — video render completion for AI-generated campaigns.
  // m136 — the readiness decision tree is now in lib/kernel/composition-gate
  // so listing-promo/podcast/direct-mail can call the same surface when
  // they onboard. The newsletter publisher feeds in its config + send_date
  // and reacts to the four-shape decision; the embed HTML stays here
  // because it's channel-specific.
  let videoEmbed = ""
  if (c.is_ai_generated === true) {
    const decision = await checkAssetReadiness({
      assetId:  c.id,
      sendDate: c.send_date,
      config:   ASSET_READINESS_CONFIGS.newsletter_video,
    })
    switch (decision.kind) {
      case "not_staged":
        return await deferCampaign(svc, c, `video_${decision.reason}`)
      case "defer":
        return await deferCampaign(svc, c, `video_${decision.reason}`)
      case "wait":
        return {
          campaign_id: c.id, brokerage_id: c.brokerage_id, agent_id: c.agent_id,
          outcome: "skipped_concurrent", recipients: 0, sent: 0, suppressed: 0, errors: 0,
          reason: `video_${decision.reason}`,
        }
      case "ready":
        videoEmbed = [
          `<div style="margin:0 0 24px 0;text-align:center">`,
          `  <video controls preload="metadata" style="max-width:100%;border-radius:8px;">`,
          `    <source src="${decision.url}" type="video/mp4">`,
          `    Your email client doesn't support video — `,
          `    <a href="${decision.url}">click here to watch</a>.`,
          `  </video>`,
          `</div>`,
        ].join("\n")
        break
    }
  }

  // Check (2) — section presence. The Wave 20 decomposer should have
  // populated at least one newsletter_sections row. When that's zero AND
  // the campaign body itself is empty, the assembled email would be blank;
  // defer instead of sending a 1-pixel email blast.
  // Code-review pass 2 — section presence is necessary but not sufficient:
  // if every section has target_personas/target_locations set AND the
  // campaign body is empty, a recipient whose persona/location matches
  // NONE gets a blank email. Require at least one persona-AND-location
  // universal section (no targeting columns set) OR a non-empty body.
  const sectionGate = await svc
    .from("newsletter_sections")
    .select("target_personas, target_locations", { count: "exact" })
    .eq("newsletter_id", c.id)
    .eq("brokerage_id", c.brokerage_id)
  const sectionRows = (sectionGate.data ?? []) as Array<{
    target_personas:  string[] | null
    target_locations: { cities?: string[]; states?: string[]; zip_codes?: string[] } | null
  }>
  const sectionCount  = sectionGate.count ?? sectionRows.length
  const hasCampaignBody  = ((c.content ?? "").trim().length > 0)
  const hasUniversalSection = sectionRows.some((s) => {
    const personaScoped  = Array.isArray(s.target_personas)  && s.target_personas.length > 0
    const locationScoped = !!s.target_locations && (
      (s.target_locations.cities?.length ?? 0) +
      (s.target_locations.states?.length ?? 0) +
      (s.target_locations.zip_codes?.length ?? 0)
    ) > 0
    return !personaScoped && !locationScoped
  })
  if (sectionCount === 0 && !hasCampaignBody) {
    return await deferCampaign(svc, c, "sections_missing:empty_body")
  }
  if (!hasUniversalSection && !hasCampaignBody) {
    return await deferCampaign(svc, c, "sections_missing:no_universal_fallback")
  }

  // Check (3) — final-shape compliance gate. Per-section evaluateOutbound runs
  // at draft time inside aiWriteNewsletterContent (broadcast shape), but the
  // FINAL assembled email body (video embed + sections stitched into one
  // document) has never been gated as a single unit. Some patterns only
  // surface once the document is composed (e.g. a benign section title +
  // a benign section body that, side-by-side, read as protected-class
  // adjacency). Run one final broadcast-shape evaluateOutbound on the
  // assembled preview HTML. The compliance fence catches it here, in the
  // last 30 seconds before send, instead of after a thousand recipients.
  const previewSections = await resolveSectionsForRecipient({
    brokerageId:       c.brokerage_id,
    newsletterId:      c.id,
    recipientPersona:  null,
    recipientLocation: null,
  })
  const previewAssembled = assembleNewsletterHtml({
    context: {
      campaignId:       c.id,
      brokerageId:      c.brokerage_id,
      newsletterId,
      campaignSubject:  c.subject_line,
      campaignBodyHtml: videoEmbed + (c.content ?? ""),
    },
    sections: previewSections,
  })
  const finalCompliance = await evaluateOutbound({
    actorContext: { userId: c.created_by ?? c.agent_id ?? c.brokerage_id, role: "agent", brokerageId: c.brokerage_id },
    journeyType:  "seller",
    // 'other' is the canonical Persona value when no specific persona
    // narrows the broadcast; the per-recipient pass later uses the actual
    // contact persona — this gate runs on the broadcast-shape preview.
    persona:      "other",
    messageType:  "email",
    content:      previewAssembled.text,
    contact: {
      id: "broadcast_preview",
      first_name: "Subscriber",
      last_name: "Audience",
      contact_type: "buyer",
      tcpa_consent: true,
      isa_reengage_allowed: false,
      dnc_status: false,
    },
  }).catch(() => ({ allowed: true, violations: [] as string[] }))
  if (!finalCompliance.allowed) {
    return await deferCampaign(svc, c, `final_compliance:${finalCompliance.violations.slice(0, 3).join("|") || "blocked"}`)
  }

  // Claim the campaign so concurrent ticks don't re-send it.
  const { data: claimed } = await svc
    .from("newsletter_campaigns")
    .update({ status: "sending" })
    .eq("id", c.id)
    .in("status", ["scheduled"])
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
      .select("id, contact_id, email, first_name, last_name, status, brokerage_id, agent_id, contact:contacts(contact_persona, city, state, zip_code)")
      .eq("brokerage_id", c.brokerage_id)
      // CANONICAL subscriber status is 'subscribed' (the status CHECK constraint allows only
      // subscribed/unsubscribed/bounced/complained — 'active' is NOT a legal value and matched
      // ZERO rows, silently dropping EVERY recipient of EVERY newsletter). Fixed to 'subscribed'.
      .eq("status", "subscribed")
    if (ownerAgent) q = q.eq("agent_id", ownerAgent)
    const { data, error } = await q
    if (error) {
      // Surface so the team sees degradation instead of silently sending
      // un-localized newsletters.
      console.error(`[publish-newsletters] subscriber join failed for campaign ${c.id}:`, error.message)
    }
    subs = (data ?? []) as unknown as SubscriberRow[]
  } catch (e) {
    console.error(`[publish-newsletters] subscriber query threw for campaign ${c.id}:`, (e as Error).message)
  }

  if (subs.length === 0) {
    await svc.from("newsletter_campaigns").update({ status: "sent" }).eq("id", c.id)
    return {
      campaign_id: c.id, brokerage_id: c.brokerage_id, agent_id: c.agent_id,
      outcome: "sent_empty", recipients: 0, sent: 0, suppressed: 0, errors: 0,
    }
  }

  // Wave 22 (a + b) — per-persona video variants. Wave 28 generalized to
  // asset_persona_renders(asset_type, asset_id, persona). We fetch the
  // whole map in ONE query before the recipient loop, then look up
  // per-recipient by their contact_persona. Recipients whose persona has
  // no completed row fall back to the universal videoEmbed assembled above.
  const personaVariantMap = new Map<string, { composite_video_url: string | null; thumbnail_url: string | null }>()
  try {
    const { data: variants } = await svc
      .from("asset_persona_renders")
      .select("persona, composite_video_url, thumbnail_url")
      .eq("asset_type", "newsletter_campaign")
      .eq("asset_id", c.id)
      .eq("status", "completed")
    for (const v of (variants ?? []) as Array<{ persona: string; composite_video_url: string | null; thumbnail_url: string | null }>) {
      personaVariantMap.set(v.persona, { composite_video_url: v.composite_video_url, thumbnail_url: v.thumbnail_url })
    }
  } catch (e) {
    // Variant lookup failure is non-fatal — every recipient gets the
    // universal videoEmbed, same as before Wave 22.
    console.error(`[publish-newsletters] persona variant lookup failed for ${c.id}:`, (e as Error).message)
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
          .in("status", ["sent", "delivered"])
          .limit(1)
          .maybeSingle()
        if (prior) continue
      } catch { /* if the check fails, fall through and let dispatch run */ }
    }

    // Persona + LOCATION come from the join we did up at the subscribers
    // query — no per-recipient round-trip. A subscriber without a linked
    // contact (anonymous capture) has s.contact === null which is
    // semantically distinct from "query errored" (handled at the
    // subscribers-query layer above with explicit console.error).
    const persona  = s.contact?.contact_persona ?? null
    const location = s.contact ? { city: s.contact.city, state: s.contact.state, zip_code: s.contact.zip_code } : null

    const sections = await resolveSectionsForRecipient({
      brokerageId:       c.brokerage_id,
      newsletterId,
      recipientPersona:  persona,
      recipientLocation: location,
    })

    // Wave 22 (a + b) — per-recipient video embed. When the recipient's
    // persona has a completed variant render, embed the persona overlay
    // MP4 + the persona thumbnail (poster attribute drives the inbox
    // preview). Otherwise fall back to the universal videoEmbed assembled
    // above. The universal main MP4 is always present (the composition gate
    // wouldn't have let us reach this point otherwise on AI campaigns).
    const variant = persona ? personaVariantMap.get(persona) ?? null : null
    const recipientVideoEmbed = (() => {
      // No video for this campaign at all (non-AI-generated path).
      if (!videoEmbed && !variant) return ""
      // Persona variant has both pieces (composite + thumbnail) → use them.
      if (variant?.composite_video_url) {
        return [
          `<div style="margin:0 0 24px 0;text-align:center">`,
          `  <video controls preload="metadata" ${variant.thumbnail_url ? `poster="${variant.thumbnail_url}"` : ""} style="max-width:100%;border-radius:8px;">`,
          `    <source src="${variant.composite_video_url}" type="video/mp4">`,
          `    Your email client doesn't support video — `,
          `    <a href="${variant.composite_video_url}">click here to watch</a>.`,
          `  </video>`,
          `</div>`,
        ].join("\n")
      }
      // Persona has only a thumbnail (overlay was skipped, e.g. ffmpeg
      // unavailable). Use the main video URL but pair it with the
      // persona-themed thumbnail so the inbox preview still differentiates.
      if (variant?.thumbnail_url && videoEmbed) {
        return videoEmbed.replace(/<video controls preload="metadata"/,
          `<video controls preload="metadata" poster="${variant.thumbnail_url}"`)
      }
      // No persona variant for this recipient — universal embed.
      return videoEmbed
    })()

    const assembled = assembleNewsletterHtml({
      context: {
        campaignId:       c.id,
        brokerageId:      c.brokerage_id,
        newsletterId,
        campaignSubject:  c.subject_line,
        campaignBodyHtml: recipientVideoEmbed
          ? `${recipientVideoEmbed}\n${c.content ?? ""}`
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
