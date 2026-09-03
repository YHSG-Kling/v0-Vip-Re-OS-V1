// lib/video/listing-pitch-reel.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE LISTING-PITCH REEL — win the listing with the team on camera. When a
// listing appointment is on the calendar, the prep cron already pre-builds the
// CMA + net sheets + deck; this adds the SHOWSTOPPER: a branded video the
// agent opens on the seller's kitchen table — "meet the team that will sell
// your home" — fronted by the AGENT'S OWN face and name (contact-facing rule:
// the licensed human, never the assistant) over the brokerage's MEASURED
// proof: attributed closed volume, calls answered around the clock, the
// compliance discipline. Every number from the ROI ledger (keep-one — the
// same counting the command-center tile shows), never a claim.
//
// KEEP-ONE: reuses the PartnersMeetingReel composition + the shared brand
// resolver + the shared delivery sweep. Delivered to the AGENT (internal
// notification with the watch link) — the human decides to show or send it;
// no client egress from this rail.

import type { PartnersMeetingReelProps, ReelCard } from "@/lib/intelligence/partners-meeting-reel-props"
import type { RoiLedger } from "@/lib/intelligence/roi-ledger"
import type { ReelBrand } from "@/lib/video/reel-brand"
import { geometryFor } from "@/lib/remotion/composition-geometry"
// PURE (no DB, no server-only) — the companion-card gate, the hint cutter and
// the sentence the refusal log names.
import { companionCard, seoHintFromNarration, SEO_HINT_MAX_CHARS, VIDEO_COVER_THUMB } from "@/lib/geo/video-landing"
import { describeMissingContent } from "@/lib/remotion/content-contract"

export const LISTING_PITCH_REEL_ENTITY = "listing_pitch_reel"

/**
 * The composition this reel rides, named ONCE (§6) — the dedupe probe, the
 * caption timeline and the queued render all have to mean the same video.
 */
const LISTING_PITCH_COMPOSITION = "PartnersMeetingReel"

const money = (cents: number) => {
  const v = Math.round(Math.max(0, cents) / 100)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000).toLocaleString("en-US")}K`
  return `$${v.toLocaleString("en-US")}`
}

/** PURE: the pitch props — earned proof only (a young brokerage gets a shorter,
 *  still-honest pitch; zero-proof tenants get the team-promise card alone). */
export function buildListingPitchReelProps(
  p: { address: string; agentName: string; agentPhotoUrl: string | null; brand: ReelBrand; roi: Pick<RoiLedger, "periodDays" | "attributedGciCents" | "attributedDeals" | "callsAnswered" | "appointmentsBooked" | "optOutsHonored"> },
): PartnersMeetingReelProps {
  const cards: ReelCard[] = []
  cards.push({
    value: "24/7", label: "AN AI TEAM ON YOUR LISTING", kind: "team",
    sub: "every inquiry answered, every showing followed up, day one",
  })
  if (p.roi.attributedGciCents > 0) {
    cards.push({
      value: money(p.roi.attributedGciCents), label: "CLOSED VOLUME OUR MARKETING PRODUCED",
      sub: `across ${p.roi.attributedDeals} deal${p.roi.attributedDeals === 1 ? "" : "s"} in ${p.roi.periodDays} days — attribution-measured, not claimed`,
      kind: "finance",
    })
  }
  if (p.roi.callsAnswered > 0) {
    cards.push({
      value: String(p.roi.callsAnswered), label: "BUYER CALLS ANSWERED LIVE",
      sub: p.roi.appointmentsBooked > 0 ? `${p.roi.appointmentsBooked} appointments booked on the call` : "no voicemail, no missed buyer",
      kind: "team",
    })
  }
  if (p.roi.optOutsHonored >= 0) {
    cards.push({
      value: "100%", label: "FAIR HOUSING & CONSENT PRE-FLIGHT",
      sub: "every outbound reviewed before it sends — discipline your listing deserves",
      kind: "compliance",
    })
  }
  return {
    weekLabel: p.address,
    cards,
    oneAsk: `Let's put this team to work on ${p.address}`,
    narration: [
      `Hi, I'm ${p.agentName} with ${p.brand.brokerageName}. Here's what listing ${p.address} with us looks like.`,
      `From day one, an AI team works your listing around the clock — every inquiry answered, every showing followed up.`,
      p.roi.attributedGciCents > 0
        ? `In the last ${p.roi.periodDays} days, our marketing produced ${money(p.roi.attributedGciCents)} in closed volume across ${p.roi.attributedDeals} deal${p.roi.attributedDeals === 1 ? "" : "s"} — measured by our attribution engine, not claimed.`
        : null,
      p.roi.callsAnswered > 0
        ? `${p.roi.callsAnswered} buyer call${p.roi.callsAnswered === 1 ? "" : "s"} answered live${p.roi.appointmentsBooked > 0 ? `, ${p.roi.appointmentsBooked} appointment${p.roi.appointmentsBooked === 1 ? "" : "s"} booked on the call` : ""} — no buyer goes to voicemail.`
        : null,
      `And every message that goes out is reviewed for Fair Housing and consent before it sends. Let's put this team to work on ${p.address}.`,
    ].filter(Boolean).join(" "),
    agentName: p.agentName,
    avatarVideoUrl: null,
    agentPhotoUrl: p.agentPhotoUrl,
    brand: {
      primaryColor: p.brand.primaryColor, accentColor: p.brand.accentColor,
      brokerageName: p.brand.brokerageName, showEhoMark: true, logoUrl: p.brand.logoUrl,
    },
  }
}

/** Queue ONE pitch reel per listing appointment (idempotent on the render
 *  ledger). Fronted by the AGENT (contact-facing identity). Best-effort. */
export async function queueListingPitchReel(
  svc: any,
  p: { brokerageId: string; agentUserId: string | null; appointmentId: string; address: string },
): Promise<boolean> {
  const { data: existing } = await svc.from("remotion_composition_renders").select("id")
    .eq("brokerage_id", p.brokerageId).eq("composition_id", LISTING_PITCH_COMPOSITION)
    .eq("entity_type", LISTING_PITCH_REEL_ENTITY).eq("entity_id", p.appointmentId)
    .limit(1).maybeSingle()
  if (existing) return false

  const [{ resolveReelBrand }, { resolveVideoIdentity }, { generateRoiLedger }] = await Promise.all([
    import("@/lib/video/reel-brand"), import("@/lib/video/video-identity"), import("@/lib/intelligence/roi-ledger"),
  ])
  const [brand, identity, roi] = await Promise.all([
    resolveReelBrand(svc, p.brokerageId),
    resolveVideoIdentity(svc, { brokerageId: p.brokerageId, agentUserId: p.agentUserId, purpose: "contact_facing" }),
    generateRoiLedger(svc, p.brokerageId),
  ])
  const props = buildListingPitchReelProps({
    address: p.address, agentName: identity.speakerName, agentPhotoUrl: identity.avatarPhotoUrl, brand, roi,
  }) as unknown as Record<string, unknown>
  // Voice on every video: the AGENT's cloned voice narrates their own pitch
  // (contact-facing rule — the licensed human speaks to clients). Best-effort.
  const { prepareReelVoiceover } = await import("@/lib/video/reel-voiceover")
  const vo = await prepareReelVoiceover({
    brokerageId: p.brokerageId, narration: (props as any).narration,
    voiceId: identity.voiceId, renderKey: `pitch-${p.appointmentId.slice(0, 8)}`,
  })
  if (vo) {
    props.voiceover_url = vo.url
    // WORD-SYNCED CAPTIONS (finish-spec: client-facing report shows carry
    // captions) — real alignment when the timestamped path succeeded, honest
    // even-distribution from the script otherwise.
    //
    // THE TIMELINE IS DERIVED. `900, 30` used to be typed here: correct against
    // PartnersMeetingReel today and silently wrong the moment its
    // durationInFrames changes — the captions would end at second 30 of a
    // longer reel with every assertion still green (§2: assert the rule, derive
    // the number; never pin to a waypoint).
    const { buildCaptionPlan } = await import("@/lib/video/caption-plan")
    const geo = geometryFor(LISTING_PITCH_COMPOSITION)
    if (!geo) {
      // REFUSE rather than fall back to a remembered 900/30: a composition that
      // left the registry has no timeline to cue against.
      console.error(
        `[listing-pitch-reel] ${LISTING_PITCH_COMPOSITION} is not in the composition registry — `
        + `captions REFUSED rather than timed against a hardcoded frame count. The video still ships.`,
      )
    } else {
      const plan = buildCaptionPlan(
        vo.alignment ?? (props as any).narration,
        geo.duration_frames, geo.fps,
        { tailPaddingFrames: 45 },
      )
      if (plan.cues.length > 0) props.captionsCues = plan.cues
    }
  }
  // Finish-spec: the pitch is CLIENT-FACING → tracked outro QR (scan to book).
  try {
    if (p.agentUserId) {
      const { mintVideoQr } = await import("@/lib/video/video-qr")
      const minted = await mintVideoQr({ brokerageId: p.brokerageId, agentUserId: p.agentUserId, kind: "explainer" }, svc)
      if (minted) { props.qrCodeDataUrl = minted.qrCodeDataUrl; props.qrCaption = "Scan to get started" }
    }
  } catch { /* QR is additive */ }
  // THE COMPANION CARD. `seoHint` is REQUIRED on VideoCoverThumb and this
  // producer omitted it, so a listing-pitch card printed the just-listed
  // composition's SAMPLE sentence as its summary line and as the hero image's
  // alt text. Cut verbatim from the pitch's own narration.
  //
  // CAPPED AT TWO SENTENCES (§5). buildListingPitchReelProps' third sentence is
  // the ROI line — "…in closed volume across N deals" — brokerage money spoken
  // to a prospective seller in the room, not something to publish as the page
  // summary if this render is ever put on /v/[slug]. The first two sentences
  // are the introduction and the promise, which is what the card is for.
  const card = companionCard(VIDEO_COVER_THUMB, {
    kind: "presentation", title: p.address, subtitle: `Listed with ${brand.brokerageName}`, eyebrow: "LISTING PRESENTATION",
    agentName: identity.speakerName, agentPhotoUrl: identity.avatarPhotoUrl,
    brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: true, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) },
    seoHint: seoHintFromNarration((props as { narration?: unknown }).narration as string | null, SEO_HINT_MAX_CHARS, 2),
  })
  if (card.card) props.thumbnail_props = card.card
  else console.warn(`[listing-pitch-reel] no companion share card for appointment ${p.appointmentId} — ${describeMissingContent(VIDEO_COVER_THUMB, card.missing)}`)
  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const r = await recordRenderQueued({
    brokerageId: p.brokerageId, compositionId: LISTING_PITCH_COMPOSITION,
    agentUserId: p.agentUserId,
    entityType: LISTING_PITCH_REEL_ENTITY, entityId: p.appointmentId,
    inputProps: props, scopeType: "brokerage", scopeId: p.brokerageId, requestedVia: "cron",
  })
  return r.ok
}

export interface PitchReelDeliveryResult { completed: number; notified: number }

/** Deliver completed pitch reels to THEIR AGENT (the render row carries
 *  agent_user_id) ahead of the appointment. Deduped by render-id marker. */
export async function deliverListingPitchReels(svc: any, now: Date = new Date()): Promise<PitchReelDeliveryResult> {
  const out: PitchReelDeliveryResult = { completed: 0, notified: 0 }
  const sinceIso = new Date(now.getTime() - 2 * 86_400_000).toISOString()
  const { data: renders } = await svc.from("remotion_composition_renders")
    .select("id, brokerage_id, agent_user_id, output_url, input_props")
    .eq("entity_type", LISTING_PITCH_REEL_ENTITY)
    .eq("render_status", "succeeded").not("output_url", "is", null)
    .gte("created_at", sinceIso).limit(100)
  for (const ren of ((renders ?? []) as any[])) {
    out.completed += 1
    if (!ren.agent_user_id) continue
    const marker = `[reel:${ren.id}]`
    const { data: dup } = await svc.from("notifications").select("id")
      .eq("brokerage_id", ren.brokerage_id).ilike("body", `%${marker}%`).limit(1).maybeSingle()
    if (dup) continue
    const address = (ren.input_props as any)?.weekLabel ?? "your listing appointment"
    await svc.from("notifications").insert({
      user_id: ren.agent_user_id, brokerage_id: ren.brokerage_id, type: "listing_presentation_ready",
      title: `Your pitch video for ${address} is ready`,
      body: `Open it on the seller's kitchen table — you, the team, and the measured proof, on camera. Watch: ${ren.output_url} ${marker}`,
      priority: "high", channel: "in_app", is_read: false,
    }).then(undefined, () => {})
    out.notified += 1
  }
  return out
}
