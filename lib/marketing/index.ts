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

// ★ THE ONE QR MINTER ★ — the single writer of `qr_codes`. Nine rival creation paths were
// merged into it; any NEW minter must go through here, and must use a canonical label helper
// when one exists for the entity, or it will not be able to see the codes the other paths made.
export {
  mintTrackedQr,
  renderQrPng,
  normalizeOrigin,
  listingQrLabel,
  openHouseQrLabel,
  isQrPurpose,
  isQrDestinationType,
  QR_PURPOSES,
  QR_DESTINATION_TYPES,
  type MintTrackedQrArgs,
  type MintedTrackedQr,
  type QrPurpose,
  type QrDestinationType,
} from "./tracked-qr"

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
