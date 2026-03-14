"use server"

/**
 * lib/marketing/qr-asset-linker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.1 — QR Code to Marketing Asset Linker
 *
 * Provides functions to link/unlink QR codes to marketing assets.
 * Reads from: qr_codes
 * Writes to:  marketing_asset_qr_links
 *
 * Emits KernelEvent.QR_ATTACHED_TO_ASSET on successful link.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { KernelEvent, processKernelEvent } from "@/lib/kernel"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type QrPlacementType =
  | "flyer"
  | "postcard"
  | "sign_rider"
  | "business_card"
  | "brochure"
  | "social_post"
  | "email"
  | "website"
  | "other"

export interface QrLinkParams {
  marketingAssetId: string
  qrCodeId: string
  placementType: QrPlacementType
}

export interface QrLinkInfo {
  id: string
  qrCodeId: string
  placementType: QrPlacementType
  qrCode: {
    id: string
    label: string
    slug: string
    targetUrl: string
    scanCount: number
    leadCount: number
    isActive: boolean
  } | null
}

// ─── LINK QR TO ASSET ─────────────────────────────────────────────────────────

/**
 * linkQrToAsset
 *
 * Creates a link between a QR code and a marketing asset.
 * Validates that both the QR code and asset belong to the same brokerage.
 * Emits QR_ATTACHED_TO_ASSET kernel event on success.
 */
export async function linkQrToAsset(
  params: QrLinkParams
): Promise<{ success: boolean; linkId?: string; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Validate QR code exists and belongs to brokerage
  const { data: qrCode, error: qrError } = await supabase
    .from("qr_codes")
    .select("id, brokerage_id, is_active")
    .eq("id", params.qrCodeId)
    .single()

  if (qrError || !qrCode) {
    return { success: false, error: "QR code not found" }
  }

  if (qrCode.brokerage_id !== brokerageId) {
    return { success: false, error: "QR code does not belong to your brokerage" }
  }

  if (!qrCode.is_active) {
    return { success: false, error: "QR code is inactive" }
  }

  // Validate asset exists and belongs to brokerage
  const { data: asset, error: assetError } = await supabase
    .from("marketing_assets")
    .select("id, brokerage_id")
    .eq("id", params.marketingAssetId)
    .single()

  if (assetError || !asset) {
    return { success: false, error: "Marketing asset not found" }
  }

  if (asset.brokerage_id !== brokerageId) {
    return { success: false, error: "Asset does not belong to your brokerage" }
  }

  // Check for existing link (prevent duplicates)
  const { data: existingLink } = await supabase
    .from("marketing_asset_qr_links")
    .select("id")
    .eq("marketing_asset_id", params.marketingAssetId)
    .eq("qr_code_id", params.qrCodeId)
    .maybeSingle()

  if (existingLink) {
    return { success: false, error: "QR code is already linked to this asset" }
  }

  // Create the link
  const { data: link, error: linkError } = await supabase
    .from("marketing_asset_qr_links")
    .insert({
      brokerage_id: brokerageId,
      marketing_asset_id: params.marketingAssetId,
      qr_code_id: params.qrCodeId,
      placement_type: params.placementType,
    })
    .select("id")
    .single()

  if (linkError) {
    console.error("[v0] Error linking QR to asset:", linkError)
    return { success: false, error: linkError.message }
  }

  // Emit kernel event
  await processKernelEvent({
    event: KernelEvent.QR_ATTACHED_TO_ASSET,
    brokerageId,
    entityType: "marketing_asset",
    entityId: params.marketingAssetId,
    metadata: {
      qr_code_id: params.qrCodeId,
      placement_type: params.placementType,
    },
  }).catch((err) => console.error("[QrAssetLinker] Kernel event failed:", err))

  return { success: true, linkId: link.id }
}

// ─── UNLINK QR FROM ASSET ─────────────────────────────────────────────────────

/**
 * unlinkQrFromAsset
 *
 * Removes a link between a QR code and a marketing asset.
 */
export async function unlinkQrFromAsset(
  linkId: string
): Promise<{ success: boolean; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { error } = await supabase
    .from("marketing_asset_qr_links")
    .delete()
    .eq("id", linkId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error unlinking QR from asset:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

// ─── GET ASSET QR LINKS ───────────────────────────────────────────────────────

/**
 * getAssetQrLinks
 *
 * Returns all QR codes linked to a specific marketing asset,
 * including QR code details (label, slug, scan count, etc.).
 */
export async function getAssetQrLinks(
  marketingAssetId: string
): Promise<{ success: boolean; links: QrLinkInfo[]; error?: string }> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  const { data: links, error } = await supabase
    .from("marketing_asset_qr_links")
    .select(`
      id,
      qr_code_id,
      placement_type,
      qr_code:qr_codes(
        id,
        label,
        slug,
        target_url,
        scan_count,
        lead_count,
        is_active
      )
    `)
    .eq("marketing_asset_id", marketingAssetId)
    .eq("brokerage_id", brokerageId)

  if (error) {
    console.error("[v0] Error fetching asset QR links:", error)
    return { success: false, links: [], error: error.message }
  }

  const formattedLinks: QrLinkInfo[] = (links ?? []).map((link) => ({
    id: link.id,
    qrCodeId: link.qr_code_id,
    placementType: link.placement_type as QrPlacementType,
    qrCode: link.qr_code
      ? {
          id: (link.qr_code as any).id,
          label: (link.qr_code as any).label,
          slug: (link.qr_code as any).slug,
          targetUrl: (link.qr_code as any).target_url,
          scanCount: (link.qr_code as any).scan_count ?? 0,
          leadCount: (link.qr_code as any).lead_count ?? 0,
          isActive: (link.qr_code as any).is_active ?? false,
        }
      : null,
  }))

  return { success: true, links: formattedLinks }
}

// ─── GET QR CODE PERFORMANCE ──────────────────────────────────────────────────

/**
 * getQrCodePerformance
 *
 * Returns performance metrics for a QR code, including scan events
 * and conversion data.
 */
export async function getQrCodePerformance(
  qrCodeId: string
): Promise<{
  success: boolean
  performance?: {
    totalScans: number
    uniqueScans: number
    leadsGenerated: number
    conversionRate: number
    recentScans: Array<{
      scannedAt: string
      isFirstScan: boolean
      contactId?: string
    }>
  }
  error?: string
}> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  // Get QR code summary
  const { data: qrCode, error: qrError } = await supabase
    .from("qr_codes")
    .select("scan_count, lead_count")
    .eq("id", qrCodeId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (qrError || !qrCode) {
    return { success: false, error: "QR code not found" }
  }

  // Get recent scan events
  const { data: scanEvents, error: scanError } = await supabase
    .from("qr_scan_events")
    .select("scanned_at, is_first_scan, contact_id")
    .eq("qr_code_id", qrCodeId)
    .eq("brokerage_id", brokerageId)
    .order("scanned_at", { ascending: false })
    .limit(50)

  if (scanError) {
    console.error("[v0] Error fetching scan events:", scanError)
  }

  const totalScans = qrCode.scan_count ?? 0
  const uniqueScans = (scanEvents ?? []).filter((e) => e.is_first_scan).length
  const leadsGenerated = qrCode.lead_count ?? 0
  const conversionRate = totalScans > 0 ? (leadsGenerated / totalScans) * 100 : 0

  return {
    success: true,
    performance: {
      totalScans,
      uniqueScans,
      leadsGenerated,
      conversionRate: Math.round(conversionRate * 100) / 100,
      recentScans: (scanEvents ?? []).map((e) => ({
        scannedAt: e.scanned_at,
        isFirstScan: e.is_first_scan,
        contactId: e.contact_id ?? undefined,
      })),
    },
  }
}

// ─── LIST AVAILABLE QR CODES ──────────────────────────────────────────────────

/**
 * listAvailableQrCodes
 *
 * Returns all active QR codes available for linking to marketing assets.
 */
export async function listAvailableQrCodes(filters?: {
  purpose?: string
  listingId?: string
  search?: string
}): Promise<{
  success: boolean
  qrCodes: Array<{
    id: string
    label: string
    slug: string
    targetUrl: string
    purpose: string
    scanCount: number
    leadCount: number
    linkedAssetCount: number
  }>
  error?: string
}> {
  const { brokerageId } = await getAgentContext()
  const supabase = await createClient()

  let query = supabase
    .from("qr_codes")
    .select(`
      id,
      label,
      slug,
      target_url,
      purpose,
      scan_count,
      lead_count,
      asset_links:marketing_asset_qr_links(count)
    `)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  if (filters?.purpose) {
    query = query.eq("purpose", filters.purpose)
  }
  if (filters?.listingId) {
    query = query.eq("listing_id", filters.listingId)
  }
  if (filters?.search) {
    query = query.ilike("label", `%${filters.search}%`)
  }

  const { data, error } = await query

  if (error) {
    console.error("[v0] Error listing QR codes:", error)
    return { success: false, qrCodes: [], error: error.message }
  }

  const qrCodes = (data ?? []).map((qr) => ({
    id: qr.id,
    label: qr.label ?? "Untitled QR",
    slug: qr.slug ?? "",
    targetUrl: qr.target_url ?? "",
    purpose: qr.purpose ?? "general",
    scanCount: qr.scan_count ?? 0,
    leadCount: qr.lead_count ?? 0,
    linkedAssetCount: (qr.asset_links as any)?.[0]?.count ?? 0,
  }))

  return { success: true, qrCodes }
}
