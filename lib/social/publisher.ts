// lib/social/publisher.ts
// Platform publishing library for Layer 9.2 Social Media Automation
// Supports: facebook, instagram, linkedin, twitter, tiktok, youtube, pinterest
//
// All social API egress routes through the single connector-gateway (the /ecc:api-connector-builder
// "one egress path" rule). YouTube is the lone exception: its resumable upload needs the init
// response's Location header + a binary PUT to that returned URL, neither of which the gateway
// (parsed body, no header access) can express — so it stays on raw fetch, documented inline.

import { callConnector, type GatewayAuth } from "@/lib/agentic-os/connector-gateway"

/** One social POST through the gateway. Returns the gateway result; callers map the provider shape. */
function socialPost(connector: string, baseUrl: string, path: string, body: unknown, auth: GatewayAuth, headers?: Record<string, string>) {
  return callConnector<any>({ connector, baseUrl, path, method: "POST", auth, body, headers })
}

export interface PublishParams {
  content: string
  mediaUrls?: string[]
  accessToken: string
  accountId: string
  hashtags?: string[]
}

export interface PublishResult {
  success: boolean
  externalPostId?: string
  error?: string
  platform: string
}

/**
 * Publish content to a social platform
 * Returns the external post ID on success, throws on failure
 */
export async function publishToSocialPlatform(
  platform: string,
  params: PublishParams
): Promise<PublishResult> {
  try {
    switch (platform.toLowerCase()) {
      case "facebook":
        return await publishToFacebook(params)
      case "instagram":
        return await publishToInstagram(params)
      case "linkedin":
        return await publishToLinkedIn(params)
      case "twitter":
        return await publishToTwitter(params)
      case "tiktok":
        return await publishToTikTok(params)
      case "youtube":
        return await publishToYouTube(params)
      case "pinterest":
        return await publishToPinterest(params)
      case "google_business":
        return await publishToGoogleBusiness(params)
      default:
        return {
          success: false,
          error: `Platform ${platform} not supported`,
          platform,
        }
    }
  } catch (error: any) {
    console.error(`[social/publisher] Failed to publish to ${platform}:`, error)
    return {
      success: false,
      error: error.message || `Failed to publish to ${platform}`,
      platform,
    }
  }
}

async function publishToFacebook(params: PublishParams): Promise<PublishResult> {
  const hasMedia = params.mediaUrls && params.mediaUrls.length > 0
  const content = params.hashtags?.length
    ? `${params.content}\n\n${params.hashtags.map((h) => `#${h}`).join(" ")}`
    : params.content

  if (hasMedia) {
    // Photo/video post — Graph takes access_token as a query param (gateway "query" auth).
    const res = await socialPost("facebook", "https://graph.facebook.com", `v18.0/${params.accountId}/photos`,
      { url: params.mediaUrls![0], caption: content },
      { style: "query", name: "access_token", value: params.accessToken })
    if (!res.ok) throw new Error(res.error || "Facebook API error")
    return { success: true, externalPostId: res.data?.id, platform: "facebook" }
  } else {
    // Text post
    const res = await socialPost("facebook", "https://graph.facebook.com", `v18.0/${params.accountId}/feed`,
      { message: content },
      { style: "query", name: "access_token", value: params.accessToken })
    if (!res.ok) throw new Error(res.error || "Facebook API error")
    return { success: true, externalPostId: res.data?.id, platform: "facebook" }
  }
}

async function publishToInstagram(params: PublishParams): Promise<PublishResult> {
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("Instagram requires media")
  }

  const caption = params.hashtags?.length
    ? `${params.content}\n\n${params.hashtags.map((h) => `#${h}`).join(" ")}`
    : params.content

  const igAuth: GatewayAuth = { style: "query", name: "access_token", value: params.accessToken }

  // Step 1: Create media container
  const containerRes = await socialPost("instagram", "https://graph.facebook.com", `v18.0/${params.accountId}/media`,
    { image_url: params.mediaUrls[0], caption }, igAuth)
  if (!containerRes.ok) throw new Error(containerRes.error || "Instagram container error")

  // Step 2: Publish container
  const publishRes = await socialPost("instagram", "https://graph.facebook.com", `v18.0/${params.accountId}/media_publish`,
    { creation_id: containerRes.data?.id }, igAuth)
  if (!publishRes.ok) throw new Error(publishRes.error || "Instagram publish error")
  return { success: true, externalPostId: publishRes.data?.id, platform: "instagram" }
}

async function publishToLinkedIn(params: PublishParams): Promise<PublishResult> {
  const hasMedia = params.mediaUrls && params.mediaUrls.length > 0
  const content = params.hashtags?.length
    ? `${params.content}\n\n${params.hashtags.map((h) => `#${h}`).join(" ")}`
    : params.content

  const shareData: any = {
    author: `urn:li:person:${params.accountId}`,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: content },
        shareMediaCategory: hasMedia ? "IMAGE" : "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  }

  if (hasMedia) {
    shareData.specificContent["com.linkedin.ugc.ShareContent"].media = [
      { status: "READY", media: params.mediaUrls![0] },
    ]
  }

  const res = await socialPost("linkedin", "https://api.linkedin.com", "v2/ugcPosts", shareData,
    { style: "bearer", token: params.accessToken },
    { "X-Restli-Protocol-Version": "2.0.0" })
  if (!res.ok) throw new Error(res.error || "LinkedIn API error")
  return { success: true, externalPostId: res.data?.id, platform: "linkedin" }
}

async function publishToTwitter(params: PublishParams): Promise<PublishResult> {
  const content = params.hashtags?.length
    ? `${params.content} ${params.hashtags.map((h) => `#${h}`).join(" ")}`
    : params.content

  // Truncate to 280 chars for Twitter
  const tweetText = content.length > 280 ? content.substring(0, 277) + "..." : content

  const tweetData: any = { text: tweetText }

  // Note: Twitter requires uploading media first via media/upload endpoint
  // This is a simplified version - media_ids would need to be obtained separately

  const res = await socialPost("twitter", "https://api.twitter.com", "2/tweets", tweetData,
    { style: "bearer", token: params.accessToken })
  if (!res.ok) throw new Error(res.error || "Twitter API error")
  return { success: true, externalPostId: res.data?.data?.id, platform: "twitter" }
}

async function publishToTikTok(params: PublishParams): Promise<PublishResult> {
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("TikTok requires video media")
  }

  // TikTok requires video content
  // This uses the TikTok Content Posting API
  const res = await socialPost("tiktok", "https://open.tiktokapis.com", "v2/post/publish/video/init/", {
    post_info: {
      title: params.content.substring(0, 150),
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    },
    source_info: { source: "PULL_FROM_URL", video_url: params.mediaUrls[0] },
  }, { style: "bearer", token: params.accessToken })
  // TikTok returns 200 with an error.code on business errors — check both.
  if (!res.ok || res.data?.error?.code) throw new Error(res.data?.error?.message || res.error || "TikTok API error")
  return { success: true, externalPostId: res.data?.data?.publish_id, platform: "tiktok" }
}

async function publishToYouTube(params: PublishParams): Promise<PublishResult> {
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("YouTube requires video media")
  }

  // YouTube uses a resumable upload: the init call returns an upload URL in the Location response
  // HEADER, then video bytes are PUT to that URL. The connector-gateway returns a parsed body with
  // no header access and can't PUT binary to an arbitrary URL, so this flow stays on raw fetch —
  // the documented exception to single-egress (same class as ElevenLabs streaming).
  const description = params.hashtags?.length
    ? `${params.content}\n\n${params.hashtags.map((h) => `#${h}`).join(" ")}`
    : params.content

  // Initialize upload
  const initResponse = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/*",
      },
      body: JSON.stringify({
        snippet: {
          title: params.content.substring(0, 100),
          description,
          tags: params.hashtags || [],
          categoryId: "22", // People & Blogs
        },
        status: {
          privacyStatus: "public",
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  )

  if (!initResponse.ok) {
    const error = await initResponse.json()
    throw new Error(error.error?.message || "YouTube API error")
  }

  const uploadUrl = initResponse.headers.get("Location")
  if (!uploadUrl) throw new Error("YouTube did not return an upload URL")

  // Stream video bytes to the resumable upload URL
  const videoResponse = await fetch(params.mediaUrls![0])
  if (!videoResponse.ok) throw new Error("Could not fetch video for YouTube upload")
  const videoBuffer = await videoResponse.arrayBuffer()

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/*",
      "Content-Length": String(videoBuffer.byteLength),
    },
    body: videoBuffer,
  })

  if (!uploadResponse.ok) {
    const err = await uploadResponse.json().catch(() => ({}))
    throw new Error(err.error?.message || "YouTube upload failed")
  }

  const uploadData = await uploadResponse.json()
  return { success: true, externalPostId: uploadData.id, platform: "youtube" }
}

async function publishToPinterest(params: PublishParams): Promise<PublishResult> {
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("Pinterest requires media")
  }

  const description = params.hashtags?.length
    ? `${params.content} ${params.hashtags.map((h) => `#${h}`).join(" ")}`
    : params.content

  // Pinterest Pins API
  const res = await socialPost("pinterest", "https://api.pinterest.com", "v5/pins", {
    board_id: params.accountId, // Pinterest uses board_id for posting
    media_source: { source_type: "image_url", url: params.mediaUrls[0] },
    description,
    title: params.content.substring(0, 100),
  }, { style: "bearer", token: params.accessToken })
  if (!res.ok) throw new Error(res.error || "Pinterest API error")
  return { success: true, externalPostId: res.data?.id, platform: "pinterest" }
}

async function publishToGoogleBusiness(params: PublishParams): Promise<PublishResult> {
  // accountId stored as "accounts/{id}/locations/{id}" after OAuth
  const locationName = params.accountId

  const body: Record<string, any> = {
    languageCode: "en-US",
    summary: params.content.substring(0, 1500), // GMB max 1500 chars
    callToAction: { actionType: "LEARN_MORE" },
  }

  if (params.mediaUrls && params.mediaUrls.length > 0) {
    body.media = [{ mediaFormat: "PHOTO", sourceUrl: params.mediaUrls[0] }]
  }

  const res = await socialPost("google_business", "https://mybusiness.googleapis.com", `v4/${locationName}/localPosts`,
    body, { style: "bearer", token: params.accessToken })
  if (!res.ok) throw new Error(res.error || "Google Business API error")
  // data.name = "accounts/123/locations/456/localPosts/789"
  return { success: true, externalPostId: res.data?.name, platform: "google_business" }
}

/**
 * Validate platform-specific content requirements
 */
export function validateContentForPlatform(
  platform: string,
  content: string,
  mediaUrls?: string[]
): { valid: boolean; error?: string } {
  const platformRequirements: Record<
    string,
    { maxLength: number; requiresMedia: boolean; mediaTypes?: string[] }
  > = {
    facebook: { maxLength: 63206, requiresMedia: false },
    instagram: { maxLength: 2200, requiresMedia: true, mediaTypes: ["image", "video"] },
    linkedin: { maxLength: 3000, requiresMedia: false },
    twitter: { maxLength: 280, requiresMedia: false },
    tiktok: { maxLength: 2200, requiresMedia: true, mediaTypes: ["video"] },
    youtube: { maxLength: 5000, requiresMedia: true, mediaTypes: ["video"] },
    pinterest: { maxLength: 500, requiresMedia: true, mediaTypes: ["image"] },
    google_business: { maxLength: 1500, requiresMedia: false },
  }

  const req = platformRequirements[platform.toLowerCase()]
  if (!req) {
    return { valid: false, error: `Unknown platform: ${platform}` }
  }

  if (content.length > req.maxLength) {
    return {
      valid: false,
      error: `Content exceeds ${platform} limit of ${req.maxLength} characters`,
    }
  }

  if (req.requiresMedia && (!mediaUrls || mediaUrls.length === 0)) {
    return { valid: false, error: `${platform} requires media` }
  }

  return { valid: true }
}
