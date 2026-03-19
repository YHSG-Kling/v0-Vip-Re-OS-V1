// Layer 8.4 — Video Repurposing Utilities (non-server)
// Platform configurations and validation helpers

export type PlatformTarget = 
  | "instagram_reel"
  | "tiktok"
  | "youtube_short"
  | "linkedin_video"
  | "facebook_reel"
  | "twitter_video"

export interface PlatformConfig {
  platform: PlatformTarget
  minDuration: number
  maxDuration: number
  aspectRatio: "9:16" | "1:1" | "16:9"
  recommendedDuration: number
  captionRequired: boolean
  hashtagLimit: number
  ctaRequired: boolean
}

const PLATFORM_CONFIGS: Record<PlatformTarget, PlatformConfig> = {
  instagram_reel: {
    platform: "instagram_reel",
    minDuration: 3,
    maxDuration: 90,
    aspectRatio: "9:16",
    recommendedDuration: 15,
    captionRequired: true,
    hashtagLimit: 30,
    ctaRequired: false,
  },
  tiktok: {
    platform: "tiktok",
    minDuration: 3,
    maxDuration: 600,
    aspectRatio: "9:16",
    recommendedDuration: 21,
    captionRequired: true,
    hashtagLimit: 10,
    ctaRequired: true,
  },
  youtube_short: {
    platform: "youtube_short",
    minDuration: 15,
    maxDuration: 60,
    aspectRatio: "9:16",
    recommendedDuration: 45,
    captionRequired: true,
    hashtagLimit: 30,
    ctaRequired: true,
  },
  linkedin_video: {
    platform: "linkedin_video",
    minDuration: 3,
    maxDuration: 600,
    aspectRatio: "1:1",
    recommendedDuration: 30,
    captionRequired: true,
    hashtagLimit: 10,
    ctaRequired: false,
  },
  facebook_reel: {
    platform: "facebook_reel",
    minDuration: 3,
    maxDuration: 240,
    aspectRatio: "9:16",
    recommendedDuration: 30,
    captionRequired: true,
    hashtagLimit: 30,
    ctaRequired: true,
  },
  twitter_video: {
    platform: "twitter_video",
    minDuration: 1,
    maxDuration: 140,
    aspectRatio: "16:9",
    recommendedDuration: 45,
    captionRequired: false,
    hashtagLimit: 5,
    ctaRequired: false,
  },
}

export function getPlatformConfig(platform: PlatformTarget): PlatformConfig {
  return PLATFORM_CONFIGS[platform]
}

export function getAllPlatformConfigs(): Record<PlatformTarget, PlatformConfig> {
  return PLATFORM_CONFIGS
}

export function validateSnippetForPlatform(
  duration: number,
  platform: PlatformTarget
): { valid: boolean; message?: string } {
  const config = getPlatformConfig(platform)

  if (duration < config.minDuration) {
    return {
      valid: false,
      message: `Video must be at least ${config.minDuration}s for ${platform.replace(/_/g, " ")}`,
    }
  }

  if (duration > config.maxDuration) {
    return {
      valid: false,
      message: `Video must be no longer than ${config.maxDuration}s for ${platform.replace(/_/g, " ")}`,
    }
  }

  return { valid: true }
}
