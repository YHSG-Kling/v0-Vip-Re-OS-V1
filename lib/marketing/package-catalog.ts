/**
 * lib/marketing/package-catalog.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure catalog for listing marketing packages. Extracted from the orphaned
 * server action app/actions/marketing-package-automation.ts so the package
 * contents + flat cost can be displayed in the UI BEFORE activation (display-
 * and-confirm) and unit-tested without a database.
 *
 * No DB, no I/O — pure functions only. The server action imports these and
 * writes the resolved service list + cost into listing_marketing_packages.
 */

export const MARKETING_PACKAGE_TYPES = ["basic", "standard", "premium", "luxury"] as const

export type MarketingPackageType = (typeof MARKETING_PACKAGE_TYPES)[number]

/** Services every tier includes. */
const BASE_SERVICES = ["mls_syndication", "listing_description", "social_media_posts"] as const

/** Flat estimated cost (USD) presented before activation. */
const PACKAGE_COSTS: Record<MarketingPackageType, number> = {
  basic: 0,
  standard: 500,
  premium: 1500,
  luxury: 3500,
}

const PACKAGE_SERVICES: Record<MarketingPackageType, string[]> = {
  basic: [...BASE_SERVICES],
  standard: [...BASE_SERVICES, "professional_photos", "virtual_tour", "email_campaign"],
  premium: [
    ...BASE_SERVICES,
    "professional_photos",
    "virtual_tour",
    "drone_photos",
    "video_walkthrough",
    "email_campaign",
    "facebook_ads",
    "instagram_ads",
  ],
  luxury: [
    ...BASE_SERVICES,
    "professional_photos",
    "twilight_photos",
    "drone_photos",
    "drone_video",
    "cinematic_video",
    "virtual_staging",
    "3d_matterport",
    "email_campaign",
    "facebook_ads",
    "instagram_ads",
    "google_ads",
    "print_materials",
  ],
}

/** Type guard — narrows an arbitrary string to a valid package type. */
export function isMarketingPackageType(value: string): value is MarketingPackageType {
  return (MARKETING_PACKAGE_TYPES as readonly string[]).includes(value)
}

/**
 * Resolve the included service list for a package type.
 * Unknown types fall back to "basic" (matches the original action behaviour).
 */
export function getPackageServices(packageType: string): string[] {
  if (isMarketingPackageType(packageType)) return [...PACKAGE_SERVICES[packageType]]
  return [...PACKAGE_SERVICES.basic]
}

/**
 * Flat estimated cost (USD) for a package type.
 * Unknown types fall back to 0 (matches the original action behaviour).
 */
export function calculatePackageCost(packageType: string): number {
  if (isMarketingPackageType(packageType)) return PACKAGE_COSTS[packageType]
  return 0
}

/** Display label, e.g. "Premium Package". */
export function getPackageDisplayName(packageType: string): string {
  const safe = isMarketingPackageType(packageType) ? packageType : "basic"
  return `${safe.charAt(0).toUpperCase()}${safe.slice(1)} Package`
}

/** Full preview bundle for the display-and-confirm UI. */
export interface MarketingPackagePreview {
  packageType: MarketingPackageType
  packageName: string
  services: string[]
  estimatedCost: number
}

export function buildPackagePreview(packageType: MarketingPackageType): MarketingPackagePreview {
  return {
    packageType,
    packageName: getPackageDisplayName(packageType),
    services: getPackageServices(packageType),
    estimatedCost: calculatePackageCost(packageType),
  }
}
