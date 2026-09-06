// lib/kernel/board-packet-reel.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE BOARD PACKET AS A VIDEO — the monthly packet, presented by the AI team.
// KEEP-ONE: this REUSES the PartnersMeetingReel composition (the weekly show's
// registered Remotion surface) with monthly BoardPacketData mapped into the
// same earned-cards + narration contract — no second composition, no drift.
// This is also the composition's FIRST live producer (the weekly props builder
// existed but nothing ever queued a render).
//
// The differentiator card is the ATTRIBUTION RECEIPT: marketing-attributed
// closed volume from the marketing_attribution_credits engine — measured,
// never re-modeled — spoken to the broker as "here's what the AI team's
// marketing actually closed." Earned cards only; a thin month is a short
// video, never a padded one.

import type { BoardPacketData } from "./board-packet"
import type { PartnersMeetingReelProps, ReelCard } from "@/lib/intelligence/partners-meeting-reel-props"
import type { ReelQueueOutcome } from "@/lib/intelligence/partners-meeting"
// PURE (no DB, no server-only) — the companion-card gate and the hint cutter.
import { companionCard, seoHintFromNarration, SEO_HINT_MAX_CHARS, VIDEO_COVER_THUMB } from "@/lib/geo/video-landing"

export const BOARD_PACKET_REEL_COMPOSITION = "PartnersMeetingReel"
/** entity_type on the render row — the dedupe + delivery-sweep key. */
export const BOARD_PACKET_REEL_ENTITY = "board_packet_reel"

const money = (cents: number) => {
  const v = Math.round(Math.max(0, cents) / 100)
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000)}K`
  return `$${v.toLocaleString("en-US")}`
}

/** PURE: BoardPacketData → the reel props. Earned cards only (a number must be
 *  > 0 to appear); the finance card is the attribution receipt. */
export function buildBoardPacketReelProps(
  d: BoardPacketData,
  opts: { agentName?: string; avatarVideoUrl?: string | null; agentPhotoUrl?: string | null; brand?: Partial<PartnersMeetingReelProps["brand"]> } = {},
): PartnersMeetingReelProps {
  const cards: ReelCard[] = []
  if (d.closedCount > 0) cards.push({ value: String(d.closedCount), label: "CLOSED THIS MONTH", sub: `${money(d.closedVolumeCents)} volume`, kind: "team" })
  if (d.aiCallsAnswered > 0) cards.push({ value: String(d.aiCallsAnswered), label: "CALLS ANSWERED BY YOUR AI", sub: "every one disclosed, logged, and worked", kind: "team" })
  if (d.aiBookings > 0) cards.push({ value: String(d.aiBookings), label: "APPOINTMENTS BOOKED LIVE", sub: "on the phone, while agents slept", kind: "team" })
  if (d.draftsUsed > 0) cards.push({ value: String(d.draftsUsed), label: "AI DRAFTS YOUR AGENTS SENT", sub: "written for them, approved by them", kind: "team" })
  if (d.attributedGciCents > 0) {
    cards.push({
      value: money(d.attributedGciCents),
      label: "MARKETING-ATTRIBUTED CLOSED VOLUME",
      sub: `across ${d.attributedDeals} deal${d.attributedDeals === 1 ? "" : "s"} — the receipts, attribution-weighted`,
      kind: "finance",
    })
  }
  if (d.optOutsHonored > 0) {
    cards.push({ value: String(d.optOutsHonored), label: "OPT-OUTS HONORED IMMEDIATELY", sub: "compliance is a feature, not a checkbox", kind: "compliance" })
  }

  const spoken: string[] = [`${d.monthLabel} at ${d.brokerageName}, presented by your AI team.`]
  if (d.closedCount > 0) spoken.push(`You closed ${d.closedCount} transaction${d.closedCount === 1 ? "" : "s"} for ${money(d.closedVolumeCents)} in volume.`)
  if (d.aiCallsAnswered > 0) spoken.push(`Your AI answered ${d.aiCallsAnswered} inbound call${d.aiCallsAnswered === 1 ? "" : "s"}${d.aiBookings > 0 ? ` and booked ${d.aiBookings} appointment${d.aiBookings === 1 ? "" : "s"} live` : ""}.`)
  if (d.attributedGciCents > 0) spoken.push(`The marketing the team ran is attributed to ${money(d.attributedGciCents)} of that closed volume across ${d.attributedDeals} deal${d.attributedDeals === 1 ? "" : "s"} — measured by the attribution engine, not claimed.`)
  if (d.optOutsHonored > 0) spoken.push(`${d.optOutsHonored} opt-out${d.optOutsHonored === 1 ? " was" : "s were"} honored the moment they were spoken.`)
  spoken.push(`The full packet is in your documents.`)

  return {
    weekLabel: `${d.monthLabel} · Board Packet`,
    cards,
    oneAsk: "The full packet PDF is in your documents",
    narration: spoken.join(" "),
    agentName: opts.agentName ?? "Your AI Team",
    avatarVideoUrl: opts.avatarVideoUrl ?? null,
    agentPhotoUrl: opts.agentPhotoUrl ?? null,
    brand: {
      primaryColor: opts.brand?.primaryColor ?? "#0F172A",
      accentColor: opts.brand?.accentColor ?? "#F59E0B",
      brokerageName: d.brokerageName,
      showEhoMark: opts.brand?.showEhoMark ?? true,
      logoUrl: opts.brand?.logoUrl ?? null,
    },
  }
}

/** Queue ONE packet reel per brokerage per month (idempotent by entity + month
 *  window on the render ledger). Best-effort — a queue failure never blocks
 *  the PDF packet. Branded from the LIVE tenant brand tables + a branded
 *  VideoCoverThumb pass (thumbnail_props). Returns the disposition (the same
 *  vocabulary as the weekly show — §6), never a bare boolean. */
export async function queueBoardPacketReel(
  svc: any, p: { brokerageId: string; monthStartIso: string; data: BoardPacketData },
): Promise<ReelQueueOutcome> {
  const { data: existing } = await svc.from("remotion_composition_renders").select("id")
    .eq("brokerage_id", p.brokerageId)
    .eq("composition_id", BOARD_PACKET_REEL_COMPOSITION)
    .eq("entity_type", BOARD_PACKET_REEL_ENTITY)
    .eq("entity_id", p.brokerageId)
    .gte("created_at", p.monthStartIso)
    .limit(1).maybeSingle()
  if (existing) return { status: "already_queued", reason: "one packet reel per brokerage per month; this month's row exists" }
  const { resolveReelBrand } = await import("@/lib/video/reel-brand")
  const { resolveVideoIdentity } = await import("@/lib/video/video-identity")
  const [brand, identity] = await Promise.all([
    resolveReelBrand(svc, p.brokerageId),
    // The brokerage's named ASSISTANT presents the month (internal report —
    // never the broker's own face reading their own numbers back to them).
    resolveVideoIdentity(svc, { brokerageId: p.brokerageId, agentUserId: null, purpose: "internal_report" }),
  ])
  const props = buildBoardPacketReelProps(p.data, {
    brand, agentName: identity.speakerName, agentPhotoUrl: identity.avatarPhotoUrl,
  }) as unknown as Record<string, unknown>
  // THE CONTENT GATE, before any spend (the voiceover below is a TTS call) and
  // before the insert. Every push in buildBoardPacketReelProps is gated on a
  // count > 0, so a month with no closings, no AI calls, no attributed volume
  // and no opt-outs yields `cards: []` — the contract reads that as unsupplied,
  // render-composition would cancel the row, and this used to return `true`.
  const { missingContentProps, describeMissingContent } = await import("@/lib/remotion/content-contract")
  const missing = missingContentProps(BOARD_PACKET_REEL_COMPOSITION, props)
  if (missing.length > 0) {
    const reason = describeMissingContent(BOARD_PACKET_REEL_COMPOSITION, missing)
    console.warn(`[board-packet-reel] ${BOARD_PACKET_REEL_COMPOSITION} for brokerage ${p.brokerageId} (${p.data.monthLabel}) skipped — ${reason}`)
    return { status: "refused", reason }
  }
  // Voice on every video: the assistant narrates the month (its ElevenLabs
  // voice, the same one that answers the phone). Best-effort.
  const { prepareReelVoiceover } = await import("@/lib/video/reel-voiceover")
  const vo = await prepareReelVoiceover({
    brokerageId: p.brokerageId, narration: (props as any).narration,
    voiceId: identity.voiceId, renderKey: `packet-${p.brokerageId.slice(0, 8)}`,
  })
  if (vo) props.voiceover_url = vo.url
  // THE COMPANION CARD. `seoHint` is REQUIRED on VideoCoverThumb and this
  // producer omitted it, so a BOARD PACKET card printed the just-listed
  // composition's sample sentence as its summary line and as the hero image's
  // alt text. Cut verbatim from this packet's own narration instead.
  //
  // CAPPED AT THE FRAMING SENTENCE (§5). buildBoardPacketReelProps' second
  // sentence reads the month's closed VOLUME out loud and the attribution
  // sentence reads the money the marketing closed; this card becomes the
  // og:image the moment a broker publishes the render to /v/[slug]. The opening
  // line — "<Month> at <Brokerage>, presented by your AI team." — is the whole
  // honest summary and carries no figure.
  const cardSeoHint = seoHintFromNarration((props as { narration?: unknown }).narration as string | null, SEO_HINT_MAX_CHARS, 1)
  const card = companionCard(VIDEO_COVER_THUMB, {
    kind: "presentation", title: `${p.data.monthLabel} Board Packet`,
    subtitle: "Presented by your AI team", eyebrow: "BOARD PACKET",
    agentName: brand.brokerageName,
    brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, brokerageName: brand.brokerageName, showEhoMark: true, ...(brand.logoUrl ? { logoUrl: brand.logoUrl } : {}) },
    seoHint: cardSeoHint,
  })
  if (card.card) props.thumbnail_props = card.card
  else console.warn(`[board-packet-reel] no companion share card for brokerage ${p.brokerageId} (${p.data.monthLabel}) — ${describeMissingContent(VIDEO_COVER_THUMB, card.missing)}`)
  const { recordRenderQueued } = await import("@/lib/remotion/registry")
  const r = await recordRenderQueued({
    brokerageId: p.brokerageId,
    compositionId: BOARD_PACKET_REEL_COMPOSITION,
    entityType: BOARD_PACKET_REEL_ENTITY,
    entityId: p.brokerageId,
    inputProps: props,
    scopeType: "brokerage",
    scopeId: p.brokerageId,
    requestedVia: "cron",
  })
  if (r.ok) return { status: "queued" }
  return { status: "failed", reason: ("error" in r && typeof r.error === "string" ? r.error : null) ?? "render row insert refused" }
}

export interface PacketReelDeliveryResult { completed: number; notified: number }

/** DELIVERY SWEEP (phase=deliver, runs the day after the packet cron): any
 *  COMPLETED packet reel this month whose broker admins haven't been told →
 *  one notification each, deduped by the render id carried in the body. */
export async function deliverBoardPacketReels(svc: any, now: Date = new Date()): Promise<PacketReelDeliveryResult> {
  const { deliverCompletedReels } = await import("@/lib/video/reel-brand")
  return deliverCompletedReels(svc, {
    entityType: BOARD_PACKET_REEL_ENTITY,
    sinceIso: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    notificationType: "board_packet_ready",
    title: "Your board packet video is ready",
    bodyIntro: "Your AI team presents the month on camera — production, the receipts, and the compliance line.",
  })
}
