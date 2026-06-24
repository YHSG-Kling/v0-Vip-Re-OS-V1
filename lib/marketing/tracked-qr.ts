/**
 * lib/marketing/tracked-qr.ts
 *
 * SHARED tracked-QR core. One mint path for every AI-made marketing asset — videos (outro QR),
 * listing flyers / packets, open-house flyers, postcards — so we never drift into per-surface QR
 * logic. Reuses the existing qr_codes + qr_scan_events tables and the dynamic /api/qr/scan?slug=
 * resolver (the printed/encoded slug never goes stale; target_url is editable). Adds NOTHING to the
 * schema.
 *
 * mintVideoQr (lib/video/video-qr.ts) and mintMarketingQr (lib/marketing/marketing-qr.ts) both
 * delegate here — they only own their KIND→destination mapping. This is the DB write + PNG encode.
 *
 * IDEMPOTENT per `label` (the deterministic "(entity, kind)" key): a re-render / re-generate reuses
 * the SAME tracked code so scans accrue to one row. NEVER throws — an asset must still render without
 * a QR (returns null → caller skips the badge).
 */
import "server-only"
import QRCode from "qrcode"
import { createServiceClient } from "@/lib/supabase/service"

type AnyClient = ReturnType<typeof createServiceClient>

const ORIGIN_FALLBACK = "https://app.vipagentos.com"

export function normalizeOrigin(origin?: string | null): string {
  return (origin ?? process.env.NEXT_PUBLIC_APP_URL ?? ORIGIN_FALLBACK).replace(/\/$/, "")
}

export interface MintTrackedQrArgs {
  brokerageId: string
  /** agents.id (qr_codes.agent_id FK → agents.id) — nullable for brokerage-level material. */
  agentId?: string | null
  /** deterministic idempotency key, e.g. `material:listing_flyer:<listingId>`. */
  label: string
  /** m148 destination_type — MUST be an enum-valid value. */
  destinationType: string
  /** the semantic URL a scan ultimately lands on (recorded as the resolver fallback). */
  targetUrl: string
  listingId?: string | null
  /** qr_codes.purpose CHECK: listing|open_house|general|campaign|lead_capture. */
  purpose?: "listing" | "open_house" | "general" | "campaign" | "lead_capture"
  origin?: string
}

export interface MintedTrackedQr {
  qrCodeId: string
  slug: string
  /** the /api/qr/scan?slug= URL the PNG actually encodes. */
  scanUrl: string
  /** data:image/png;base64,... ready for an <Img> / print template. */
  qrCodeDataUrl: string
  destinationType: string
  /** true when THIS call minted a new row (vs. reusing an existing tracked code). */
  created: boolean
}

export async function mintTrackedQr(
  args: MintTrackedQrArgs,
  client?: AnyClient,
): Promise<MintedTrackedQr | null> {
  try {
    if (!args.brokerageId || !args.label) return null

    const svc: AnyClient = client ?? createServiceClient()
    const origin = normalizeOrigin(args.origin)

    // 1. Reuse an existing tracked code for this (entity, kind).
    const { data: existing } = await svc
      .from("qr_codes")
      .select("id, slug")
      .eq("brokerage_id", args.brokerageId)
      .eq("label", args.label)
      .eq("is_active", true)
      .maybeSingle()

    let qrCodeId: string
    let slug: string
    let created = false

    if (existing?.id && existing?.slug) {
      qrCodeId = existing.id as string
      slug = existing.slug as string
    } else {
      // 2. Mint a fresh tracked row (slug mirrors createQrCodeAction's recipe).
      const newSlug = `${args.label
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 40)}-${Date.now().toString(36)}`

      const { data: inserted, error } = await svc
        .from("qr_codes")
        .insert({
          brokerage_id: args.brokerageId,
          agent_id: args.agentId ?? null,
          label: args.label,
          target_url: args.targetUrl,
          purpose: args.purpose ?? "campaign",
          destination_type: args.destinationType,
          slug: newSlug,
          listing_id: args.listingId ?? null,
          is_active: true,
          scan_count: 0,
          lead_count: 0,
        })
        .select("id, slug")
        .maybeSingle()

      if (error || !inserted?.id || !inserted?.slug) return null
      qrCodeId = inserted.id as string
      slug = inserted.slug as string
      created = true

      // Patch target_url to the canonical scan redirector now the slug exists.
      await svc.from("qr_codes").update({ target_url: `${origin}/api/qr/scan?slug=${slug}` }).eq("id", qrCodeId)
    }

    const scanUrl = `${origin}/api/qr/scan?slug=${slug}`
    const qrCodeDataUrl = await QRCode.toDataURL(scanUrl, {
      width: 600,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })

    return { qrCodeId, slug, scanUrl, qrCodeDataUrl, destinationType: args.destinationType, created }
  } catch {
    return null
  }
}
