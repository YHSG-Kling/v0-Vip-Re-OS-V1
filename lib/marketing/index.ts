/**
 * lib/marketing/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER 9.1 — Marketing Module Index
 *
 * Unified export point for all marketing-related utilities.
 * Import from '@/lib/marketing' instead of individual files.
 */

// Campaign Registry
export {
  getCampaignRegistry,
  registerCampaignSource,
  unregisterCampaignSource,
  getCampaignSources,
  type ContentSourceTable,
  type ContentSourceItem,
  type CampaignRegistryFilters,
} from "./campaign-registry"

// QR Asset Linker
export {
  linkQrToAsset,
  unlinkQrFromAsset,
  getAssetQrLinks,
  getQrCodePerformance,
  listAvailableQrCodes,
  type QrPlacementType,
  type QrLinkParams,
  type QrLinkInfo,
} from "./qr-asset-linker"
