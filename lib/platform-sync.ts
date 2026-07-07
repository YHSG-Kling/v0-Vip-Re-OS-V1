
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
      console.error(`[v0] ${platformName} API error:`, response.error)
      return { success: false, error: `API error: ${response.status}` }
    }

    const result = response.data ?? {}

    return {
      success: true,
      listingUrl: result.listing_url || result.url || `https://${normalizedPlatform}.com/listing/${result.id}`
    }
  } catch (error) {
    console.error(`[v0] Error syncing to ${platformName}:`, error)
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

export async function removePlatformListing(
  platformName: string,
  listingUrl: string
): Promise<{ success: boolean; error?: string }> {
  const normalizedPlatform = platformName.toLowerCase().replace(/\s+/g, "")
  const config = PLATFORM_CONFIGS[normalizedPlatform]

  if (!config || !config.apiKey) {
    console.log(`[v0] Cannot remove from ${platformName} - not configured`)
    return { success: true }
  }

  try {
    // Extract listing ID from URL
    const listingId = listingUrl.split("/").pop()

    const ep = new URL(config.apiEndpoint)
    const response = await callConnector({
      connector: `syndication-${normalizedPlatform}`, baseUrl: ep.origin, path: `${ep.pathname}/${listingId}`, method: "DELETE",
      auth: { style: "bearer", token: config.apiKey! },
    })

    return { success: response.ok }
  } catch (error) {
    console.error(`[v0] Error removing from ${platformName}:`, error)
    return { success: false, error: "Failed to remove listing" }
  }
}

export async function updatePlatformListing(
  platformName: string,
  listingUrl: string,
  updates: any
): Promise<{ success: boolean; error?: string }> {
  const normalizedPlatform = platformName.toLowerCase().replace(/\s+/g, "")
  const config = PLATFORM_CONFIGS[normalizedPlatform]

  if (!config || !config.apiKey) {
    console.log(`[v0] Cannot update on ${platformName} - not configured`)
    return { success: true }
  }

  try {
    const listingId = listingUrl.split("/").pop()

    const ep = new URL(config.apiEndpoint)
    const response = await callConnector({
      connector: `syndication-${normalizedPlatform}`, baseUrl: ep.origin, path: `${ep.pathname}/${listingId}`, method: "PATCH",
      auth: { style: "bearer", token: config.apiKey! }, body: updates,
    })

    return { success: response.ok }
  } catch (error) {
    console.error(`[v0] Error updating on ${platformName}:`, error)
    return { success: false, error: "Failed to update listing" }
  }
}
