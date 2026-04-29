// lib/social/publisher.ts
// Platform publishing library for Layer 9.2 Social Media Automation
// Supports: facebook, instagram, linkedin, twitter, tiktok, youtube, pinterest

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
    // Photo/video post
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${params.accountId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: params.mediaUrls![0],
          caption: content,
          access_token: params.accessToken,
        }),
      }
    )

    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.error?.message || "Facebook API error")
    }
    return { success: true, externalPostId: data.id, platform: "facebook" }
  } else {
    // Text post
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${params.accountId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: content,
          access_token: params.accessToken,
        }),
      }
    )

    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.error?.message || "Facebook API error")
    }
    return { success: true, externalPostId: data.id, platform: "facebook" }
  }
}

async function publishToInstagram(params: PublishParams): Promise<PublishResult> {
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("Instagram requires media")
  }

  const caption = params.hashtags?.length
    ? `${params.content}\n\n${params.hashtags.map((h) => `#${h}`).join(" ")}`
    : params.content

  // Step 1: Create media container
  const containerResponse = await fetch(
    `https://graph.facebook.com/v18.0/${params.accountId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: params.mediaUrls[0],
        caption,
        access_token: params.accessToken,
      }),
    }
  )

  const containerData = await containerResponse.json()
  if (!containerResponse.ok) {
    throw new Error(containerData.error?.message || "Instagram container error")
  }

  // Step 2: Publish container
  const publishResponse = await fetch(
    `https://graph.facebook.com/v18.0/${params.accountId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: containerData.id,
        access_token: params.accessToken,
      }),
    }
  )

  const publishData = await publishResponse.json()
  if (!publishResponse.ok) {
    throw new Error(publishData.error?.message || "Instagram publish error")
  }
  return { success: true, externalPostId: publishData.id, platform: "instagram" }
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

  const response = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(shareData),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || "LinkedIn API error")
  }
  return { success: true, externalPostId: data.id, platform: "linkedin" }
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

  const response = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tweetData),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.detail || data.title || "Twitter API error")
  }
  return { success: true, externalPostId: data.data?.id, platform: "twitter" }
}

async function publishToTikTok(params: PublishParams): Promise<PublishResult> {
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("TikTok requires video media")
  }

  // TikTok requires video content
  // This uses the TikTok Content Posting API
  const response = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        post_info: {
          title: params.content.substring(0, 150),
          privacy_level: "PUBLIC_TO_EVERYONE",
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: "PULL_FROM_URL",
          video_url: params.mediaUrls[0],
        },
      }),
    }
  )

  const data = await response.json()
  if (!response.ok || data.error?.code) {
    throw new Error(data.error?.message || "TikTok API error")
  }
  return { success: true, externalPostId: data.data?.publish_id, platform: "tiktok" }
}

async function publishToYouTube(params: PublishParams): Promise<PublishResult> {
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("YouTube requires video media")
  }

  // YouTube requires OAuth 2.0 and video upload via resumable upload
  // This is a simplified placeholder - real implementation needs multi-step upload
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
  const response = await fetch("https://api.pinterest.com/v5/pins", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      board_id: params.accountId, // Pinterest uses board_id for posting
      media_source: {
        source_type: "image_url",
        url: params.mediaUrls[0],
      },
      description,
      title: params.content.substring(0, 100),
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || "Pinterest API error")
  }
  return { success: true, externalPostId: data.id, platform: "pinterest" }
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

  const response = await fetch(
    `https://mybusiness.googleapis.com/v4/${locationName}/localPosts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  )

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error?.message || "Google Business API error")
  }
  // data.name = "accounts/123/locations/456/localPosts/789"
  return { success: true, externalPostId: data.name, platform: "google_business" }
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
