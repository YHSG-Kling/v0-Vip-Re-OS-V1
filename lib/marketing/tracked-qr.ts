/**
 * lib/marketing/tracked-qr.ts
 *
 * ★ THE ONE QR MINTER ★ — the single writer of `qr_codes` for the whole tree.
 *
 * A census found NINE distinct creation paths writing this table with different slug recipes,
 * different (or absent) idempotency, and inconsistent column coverage — so the same listing could
 * carry two tracked codes that could not see each other, and `expires_at` /
 * `marketing_campaign_id` had one writer and zero writers respectively. Every one of those paths
 * now routes THROUGH this function. See the CONSOLIDATED-INTO-THIS-FILE block at the bottom for
 * what died and what was merged in first.
 *
 * Reuses the existing qr_codes + qr_scan_events tables and the dynamic /api/qr/scan?slug=
 * resolver (the printed/encoded slug never goes stale). Adds NOTHING to the schema.
 *
 * IDEMPOTENT per `label` (the deterministic "(entity, kind)" key): a re-render / re-generate /
 * re-launch reuses the SAME tracked code so scans accrue to one row. NEVER throws — an asset must
 * still render without a QR (returns null → caller skips the badge).
 *
 * TWO URLs, DO NOT CONFUSE THEM:
 *   • scanUrl      — `${origin}/api/qr/scan?slug=…`. THIS is what the PNG encodes. Always.
 *   • target_url   — the SEMANTIC destination the code stands for (the listing page, the magnet
 *                    landing, whatever the agent typed). Stored for display + editing; it is what
 *                    the QR management surfaces show as "where this points". This module used to
 *                    overwrite it with the scan URL after insert, which made every survivor-minted
 *                    row self-referential and destroyed the caller's destination — so routing the
 *                    remaining minters here would have LOST the URL their users typed. It no
 *                    longer does that. When a caller supplies no target, target_url falls back to
 *                    the public QR landing `${origin}/qr/<slug>` (patched once the slug exists).
 *
 * LIVE CHECK VOCABULARIES (hrvaqgvukzxfskkcrwbt, verified — a value outside these is a REFUSED
 * insert, and supabase-js resolves that refusal, it does not throw):
 *   destination_type ∈ {anniversary_video, book_meeting, cma_form, landing_page, listing_detail,
 *                       other, podcast_episode, video_avatar_tour}  (NULL allowed)
 *   purpose          ∈ {business_card, campaign, event, general, lead_capture, lead_magnet,
 *                       listing, listing_inquiry, open_house}       (NULL allowed)
 */
import "server-only"
import QRCode from "qrcode"
import { createServiceClient } from "@/lib/supabase/service"

type AnyClient = ReturnType<typeof createServiceClient>

const ORIGIN_FALLBACK = "https://app.vipagentos.com"

export function normalizeOrigin(origin?: string | null): string {
  return (origin ?? process.env.NEXT_PUBLIC_APP_URL ?? ORIGIN_FALLBACK).replace(/\/$/, "")
}

/** qr_codes.destination_type CHECK (m148) — the FULL live vocabulary. */
export type QrDestinationType =
  | "anniversary_video"
  | "book_meeting"
  | "cma_form"
  | "landing_page"
  | "listing_detail"
  | "other"
  | "podcast_episode"
  | "video_avatar_tour"

/** qr_codes.purpose CHECK — the FULL live vocabulary. */
export type QrPurpose =
  | "business_card"
  | "campaign"
  | "event"
  | "general"
  | "lead_capture"
  | "lead_magnet"
  | "listing"
  | "listing_inquiry"
  | "open_house"

export const QR_DESTINATION_TYPES: readonly QrDestinationType[] = [
  "anniversary_video", "book_meeting", "cma_form", "landing_page",
  "listing_detail", "other", "podcast_episode", "video_avatar_tour",
] as const

export const QR_PURPOSES: readonly QrPurpose[] = [
  "business_card", "campaign", "event", "general", "lead_capture",
  "lead_magnet", "listing", "listing_inquiry", "open_house",
] as const

export function isQrDestinationType(v: unknown): v is QrDestinationType {
  return typeof v === "string" && (QR_DESTINATION_TYPES as readonly string[]).includes(v)
}
export function isQrPurpose(v: unknown): v is QrPurpose {
  return typeof v === "string" && (QR_PURPOSES as readonly string[]).includes(v)
}

// ─── CANONICAL IDEMPOTENCY KEYS ──────────────────────────────────────────────
// The whole point of the merge: two paths minting for the SAME entity must produce the SAME key,
// or they cannot see each other and both mint. Any new minter for one of these entities MUST use
// the helper, not a hand-rolled string.

/** ONE key for every listing QR — used by BOTH app/actions/listings-kernel.ts:launchListing and
 *  lib/orchestrator/internal.ts:handleListingLive, which used to dedupe on different columns. */
export function listingQrLabel(listingId: string): string {
  return `listing:${listingId}`
}

/** ONE key for every open-house QR (app/actions/seller-open-house.ts). Replaces the deterministic
 *  `oh-<eventId>` SLUG that used to carry that role via an upsert-on-slug. */
export function openHouseQrLabel(eventId: string): string {
  return `open_house:${eventId}`
}

export interface MintTrackedQrArgs {
  brokerageId: string
  /** agents.id (qr_codes.agent_id FK → agents.id) — nullable for brokerage-level material. */
  agentId?: string | null
  /** Deterministic idempotency key, e.g. `material:listing_flyer:<listingId>`.
   *  NOTE: `qr_codes` has ONE text column for this, so the key IS the stored label. There is no
   *  separate display name — the QR surfaces resolve the human description from `listing_id` /
   *  `marketing_campaign_id`, which every row now carries. A prettier label is not worth a key
   *  that moves when a listing's address is corrected. */
  label: string
  /** m148 destination_type — MUST be an enum-valid value (or null). */
  destinationType?: QrDestinationType | null
  /** The SEMANTIC URL this code stands for. Omit → defaults to the public `/qr/<slug>` landing. */
  targetUrl?: string | null
  listingId?: string | null
  /** ★ TRACKING LINKED TO CAMPAIGN ★ qr_codes.marketing_campaign_id (FK marketing_campaigns).
   *  Stamp this whenever the code is minted in a marketing-campaign context — it is what
   *  lib/marketing/campaign-measurer.ts aggregates scans over. */
  marketingCampaignId?: string | null
  /** qr_codes.expires_at (timestamptz ISO string). */
  expiresAt?: string | null
  purpose?: QrPurpose
  origin?: string
}

export interface MintedTrackedQr {
  qrCodeId: string
  slug: string
  /** the /api/qr/scan?slug= URL the PNG actually encodes. */
  scanUrl: string
  /** the SEMANTIC destination stored on the row (what the QR "means"). */
  targetUrl: string
  /** data:image/png;base64,... ready for an <Img> / print template. */
  qrCodeDataUrl: string
  destinationType: QrDestinationType | null
  /** true when THIS call minted a new row (vs. reusing an existing tracked code). */
  created: boolean
}

/** PNG encode of any URL. The ONLY QR image source in the tree — no third-party HTTP renderer. */
export async function renderQrPng(url: string, width = 600): Promise<string> {
  return QRCode.toDataURL(url, {
    width,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  })
}

export async function mintTrackedQr(
  args: MintTrackedQrArgs,
  client?: AnyClient,
): Promise<MintedTrackedQr | null> {
  try {
    if (!args.brokerageId || !args.label) return null
    if (args.destinationType && !isQrDestinationType(args.destinationType)) return null
    if (args.purpose && !isQrPurpose(args.purpose)) return null

    const svc: AnyClient = client ?? createServiceClient()
    const origin = normalizeOrigin(args.origin)

    // 1. Reuse an existing tracked code for this (entity, kind).
    //    A FAILED lookup must NOT read as "no code yet" — that mints a duplicate on every
    //    re-run, each with its own globally-unique slug, which is exactly the drift this
    //    consolidation exists to end. supabase-js RESOLVES refusals, so destructure the error.
    const { data: existing, error: lookupError } = await svc
      .from("qr_codes")
      .select("id, slug, target_url, destination_type, listing_id, marketing_campaign_id, expires_at")
      .eq("brokerage_id", args.brokerageId)
      .eq("label", args.label)
      .eq("is_active", true)
      .maybeSingle()

    if (lookupError) {
      console.error("[mintTrackedQr] idempotency lookup refused — refusing to mint a duplicate:", lookupError.message)
      return null
    }

    let qrCodeId: string
    let slug: string
    let targetUrl: string
    let destinationType: QrDestinationType | null = args.destinationType ?? null
    let created = false

    if (existing?.id && existing?.slug) {
      qrCodeId = existing.id as string
      slug = existing.slug as string
      targetUrl = (existing.target_url as string) ?? `${origin}/qr/${slug}`
      destinationType = (existing.destination_type as QrDestinationType | null) ?? destinationType

      // ENRICH-ON-REUSE, never clobber. The agent may have re-pointed target_url by hand, and the
      // first campaign a code was minted under owns its attribution — so only NULL columns are
      // backfilled from the new call. This is how a listing QR minted by the orchestrator picks up
      // the destination_type / campaign the later marketing path knows about.
      const backfill: Record<string, unknown> = {}
      if (!existing.destination_type && args.destinationType) backfill.destination_type = args.destinationType
      if (!existing.listing_id && args.listingId) backfill.listing_id = args.listingId
      if (!existing.marketing_campaign_id && args.marketingCampaignId) backfill.marketing_campaign_id = args.marketingCampaignId
      if (!existing.expires_at && args.expiresAt) backfill.expires_at = args.expiresAt
      if (Object.keys(backfill).length > 0) {
        const { error: backfillError } = await svc.from("qr_codes").update(backfill).eq("id", qrCodeId)
        if (backfillError) {
          console.error("[mintTrackedQr] reuse backfill refused:", backfillError.message)
        } else if (backfill.destination_type) {
          destinationType = backfill.destination_type as QrDestinationType
        }
      }
    } else {
      // 2. Mint a fresh tracked row.
      const newSlug = `${args.label
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 40)}-${Date.now().toString(36)}`

      const suppliedTarget = (args.targetUrl ?? "").trim() || null

      const { data: inserted, error } = await svc
        .from("qr_codes")
        .insert({
          brokerage_id: args.brokerageId,
          agent_id: args.agentId ?? null,
          label: args.label,
          // target_url is NOT NULL — seed with the semantic URL when we have one, else a
          // placeholder that is patched to the real landing the moment the slug is known.
          target_url: suppliedTarget ?? `${origin}/qr`,
          purpose: args.purpose ?? "campaign",
          destination_type: args.destinationType ?? null,
          slug: newSlug,
          listing_id: args.listingId ?? null,
          marketing_campaign_id: args.marketingCampaignId ?? null,
          expires_at: args.expiresAt ?? null,
          is_active: true,
          scan_count: 0,
          lead_count: 0,
        })
        .select("id, slug")
        .maybeSingle()

      if (error || !inserted?.id || !inserted?.slug) {
        if (error) console.error("[mintTrackedQr] insert refused:", error.message)
        return null
      }
      qrCodeId = inserted.id as string
      slug = inserted.slug as string
      created = true

      if (suppliedTarget) {
        targetUrl = suppliedTarget
      } else {
        // No semantic destination from the caller — point at this code's own public landing,
        // which only becomes knowable after the slug exists.
        targetUrl = `${origin}/qr/${slug}`
        const { error: patchError } = await svc.from("qr_codes").update({ target_url: targetUrl }).eq("id", qrCodeId)
        if (patchError) console.error("[mintTrackedQr] target_url patch refused:", patchError.message)
      }
    }

    const scanUrl = `${origin}/api/qr/scan?slug=${slug}`
    const qrCodeDataUrl = await renderQrPng(scanUrl)

    return { qrCodeId, slug, scanUrl, targetUrl, qrCodeDataUrl, destinationType, created }
  } catch {
    return null
  }
}

// ─── CONSOLIDATED INTO THIS FILE in the QR merge (wave Q) ────────────────────
//
// The following creation paths were MERGED-THEN-DELETED. Each one's raw insert is gone; each
// call site now calls mintTrackedQr. What each contributed BEFORE it died:
//
//   • lib/kernel/marketing.ts:createQrAsset — DELETED outright (orphan export, zero callers).
//     It was the SOLE writer of `qr_codes.expires_at`, so that column would have become dead
//     schema. `expiresAt` moved here and is now reachable from createQrCodeAction and the admin
//     POST route, which is more callers than it ever had.
//
//   • app/actions/marketing-studio.ts:createQrCodeAction — insert deleted, action kept as the
//     session gate. It was NOT idempotent and never set destination_type. It contributed the
//     slug recipe (kept above) and the browser-facing param shape.
//
//   • app/api/admin/qr-codes/route.ts POST — insert deleted. Contributed the destination_type
//     validation set and the app-hosted default-URL table (both kept in that route).
//
//   • lib/kernel/lead-magnets.ts:publishLeadMagnet + :generateQRCode, and
//     app/actions/lead-magnets-actions.ts:generateQRCodeAction — THREE lead-magnet minters with
//     THREE dedupe keys (none / target_url / none). Collapsed to ONE key: `lead_magnet:<magnetId>`.
//     generateQRCodeAction contributed destination_type 'landing_page', which the other two lacked.
//
//   • app/actions/listings-kernel.ts:launchListing and lib/orchestrator/internal.ts:
//     handleListingLive — TWO listing minters deduping on DIFFERENT keys
//     ((listing_id,brokerage_id,purpose) vs (brokerage_id,target_url)), so neither could see the
//     other and both minted for the same listing. Collapsed to ONE key: `listing:<listingId>`.
//     listings-kernel contributed the "a failed lookup must not read as no-code-yet" rule, which
//     is now enforced here for every caller.
//
//   • app/actions/seller-open-house.ts:createQrCodeForEvent — upsert-on-slug deleted. Its
//     deterministic `oh-<eventId>` slug was its idempotency; that role moved to the label
//     `open_house:<eventId>`.
//
// BUILT here, not merged: `marketing_campaign_id`. It is an FK to marketing_campaigns that had
// ZERO writers in the tree, which is why lib/marketing/campaign-measurer.ts always reported 0
// scans for every campaign. It is a FORWARD link and is NOT the same thing as
// direct_mail_campaigns.qr_code_id, which is a separate reverse link that already worked.
