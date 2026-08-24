
/**
 * Platform Syndication Module
 * Handles syncing listings to various real estate platforms
 */

import { callConnector } from "@/lib/agentic-os/connector-gateway"

type PlatformConfig = {
  apiKey?: string
  apiEndpoint: string
  requiresAuth: boolean
}

const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  zillow: {
    apiKey: process.env.ZILLOW_API_KEY,
    apiEndpoint: "https://api.zillow.com/v2/listings",
    requiresAuth: true,
  },
  realtor: {
    apiKey: process.env.REALTOR_API_KEY,
    apiEndpoint: "https://api.realtor.com/v1/listings",
    requiresAuth: true,
  },
  redfin: {
    apiKey: process.env.REDFIN_API_KEY,
    apiEndpoint: "https://api.redfin.com/listings",
    requiresAuth: true,
  },
  trulia: {
    apiKey: process.env.TRULIA_API_KEY,
    apiEndpoint: "https://api.trulia.com/v1/listings",
    requiresAuth: true,
  },
  mls: {
    apiKey: process.env.MLS_API_KEY,
    apiEndpoint: process.env.MLS_API_ENDPOINT || "https://api.mls.com/listings",
    requiresAuth: true,
  },
}

/**
 * `transactionId` NAMES THE DEAL THIS SYNDICATION BELONGS TO — accepted here and
 * read by NOTHING until 2026-08-24. Every exit was anonymous, so a syndication
 * failure in the marketing-package sweep
 * (app/actions/marketing-package-automation.ts:509 loops over platforms per
 * transaction) could not be traced back to the deal that produced it.
 */
export async function syncToPlatform(
  platformName: string,
  transactionId: string,
  listing: any
): Promise<{ success: boolean; listingUrl?: string; error?: string }> {
  const normalizedPlatform = platformName.toLowerCase().replace(/\s+/g, "")
  const config = PLATFORM_CONFIGS[normalizedPlatform]

  // HONESTY FIX (vendor audit): this used to return success:true with a
  // FABRICATED listing URL for unconfigured platforms — a fake syndication
  // claim. Unknown/unconfigured platforms now fail honestly.
  if (!config) {
    return { success: false, error: `${platformName} syndication is not supported/configured — no listing was posted.` }
  }

  // Check if API key is available
  if (config.requiresAuth && !config.apiKey) {
    return { success: false, error: `${platformName} API key not configured — syndication skipped honestly (no fake URL).` }
  }

  try {
    // Format listing data for platform
    const listingPayload = formatListingForPlatform(normalizedPlatform, listing)

    // Make API call to platform through the connector-gateway
    const ep = new URL(config.apiEndpoint)
    const response = await callConnector<any>({
      connector: `syndication-${normalizedPlatform}`, baseUrl: ep.origin, path: ep.pathname, method: "POST",
      auth: { style: "bearer", token: config.apiKey! }, body: listingPayload,
    })

    if (!response.ok) {
      console.error(`[v0] ${platformName} API error (transaction ${transactionId}):`, response.error)
      return { success: false, error: `API error: ${response.status}` }
    }

    const result = response.data ?? {}

    // HONESTY FIX, same class as the two the rest of this file already carries:
    // the third branch of this fallback BUILT a listing URL out of the platform
    // name and `result.id`, so a response that carried neither a url nor an id
    // returned `https://zillow.com/listing/undefined` — a fabricated syndication
    // link the caller then stored as proof the listing was live. A post that
    // succeeded but told us no URL is a post with no URL, not a guessable one.
    const listingUrl: string | undefined =
      result.listing_url || result.url || (result.id ? `https://${normalizedPlatform}.com/listing/${result.id}` : undefined)
    if (!listingUrl) {
      console.warn(
        `[v0] ${platformName} accepted the post for transaction ${transactionId} but returned no listing URL or id`,
      )
    }

    return { success: true, ...(listingUrl ? { listingUrl } : {}) }
  } catch (error) {
    console.error(`[v0] Error syncing to ${platformName} (transaction ${transactionId}):`, error)
    return { success: false, error: error instanceof Error ? error.message : `${platformName} sync failed` }
  }
}

function formatListingForPlatform(platform: string, listing: any) {
  // Base listing data
  const baseData = {
    address: listing.address,
    city: listing.city,
    state: listing.state,
    zip: listing.zip_code,
    price: listing.price,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    sqft: listing.square_feet,
    lot_size: listing.lot_size,
    year_built: listing.year_built,
    property_type: listing.property_type,
    description: listing.description,
    photos: listing.photos || [],
    virtual_tour_url: listing.virtual_tour_url,
    mls_number: listing.mls_number,
  }

  // Platform-specific formatting
  switch (platform) {
    case "zillow":
      return {
        ...baseData,
        zestimate_enabled: true,
        premier_agent_enabled: true,
      }
    case "realtor":
      return {
        ...baseData,
        lead_routing: true,
        featured: listing.price > 500000,
      }
    case "redfin":
      return {
        listing_data: baseData,
        hot_home_eligible: true,
      }
    default:
      return baseData
  }
}

/**
 * Withdraw a listing from a syndication platform.
 *
 * HONESTY FIX (orphan burn-down, lane E). This function carried the SAME defect
 * syncToPlatform was already repaired for above: an unknown or unconfigured
 * platform returned `{ success: true }`. On a REMOVAL that lie is the worse
 * direction — the caller marks the syndication 'removed', the tracking row says
 * the listing is off Zillow, and the listing is still up. A withdrawal that did
 * not happen must never report success.
 */
export async function removePlatformListing(
  platformName: string,
  listingUrl: string
): Promise<{ success: boolean; error?: string }> {
  const normalizedPlatform = platformName.toLowerCase().replace(/\s+/g, "")
  const config = PLATFORM_CONFIGS[normalizedPlatform]

  if (!config) {
    return { success: false, error: `${platformName} syndication is not supported/configured — the listing was NOT withdrawn.` }
  }
  if (config.requiresAuth && !config.apiKey) {
    return { success: false, error: `${platformName} API key not configured — the listing was NOT withdrawn.` }
  }

  try {
    // Extract listing ID from URL
    const listingId = listingUrl.split("/").pop()

    const ep = new URL(config.apiEndpoint)
    const response = await callConnector({
      connector: `syndication-${normalizedPlatform}`, baseUrl: ep.origin, path: `${ep.pathname}/${listingId}`, method: "DELETE",
      auth: { style: "bearer", token: config.apiKey! },
    })

    return response.ok
      ? { success: true }
      : { success: false, error: `${platformName} removal failed (HTTP ${response.status ?? "?"})${response.error ? `: ${response.error}` : ""}` }
  } catch (error) {
    console.error(`[v0] Error removing from ${platformName}:`, error)
    return { success: false, error: "Failed to remove listing" }
  }
}

/**
 * Push changed listing fields (price, status, photos …) to a syndication platform.
 *
 * HONESTY FIX (orphan burn-down, lane E), same as removePlatformListing above:
 * an unconfigured platform used to return `{ success: true }`, so a price change
 * that never left the building was recorded as synced and the portal kept
 * showing the OLD price to buyers.
 */
export async function updatePlatformListing(
  platformName: string,
  listingUrl: string,
  updates: any
): Promise<{ success: boolean; error?: string }> {
  const normalizedPlatform = platformName.toLowerCase().replace(/\s+/g, "")
  const config = PLATFORM_CONFIGS[normalizedPlatform]

  if (!config) {
    return { success: false, error: `${platformName} syndication is not supported/configured — the update was NOT pushed.` }
  }
  if (config.requiresAuth && !config.apiKey) {
    return { success: false, error: `${platformName} API key not configured — the update was NOT pushed.` }
  }

  try {
    const listingId = listingUrl.split("/").pop()

    const ep = new URL(config.apiEndpoint)
    const response = await callConnector({
      connector: `syndication-${normalizedPlatform}`, baseUrl: ep.origin, path: `${ep.pathname}/${listingId}`, method: "PATCH",
      auth: { style: "bearer", token: config.apiKey! }, body: updates,
    })

    return response.ok
      ? { success: true }
      : { success: false, error: `${platformName} update failed (HTTP ${response.status ?? "?"})${response.error ? `: ${response.error}` : ""}` }
  } catch (error) {
    console.error(`[v0] Error updating on ${platformName}:`, error)
    return { success: false, error: "Failed to update listing" }
  }
}
