import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = await createClient()
    const now = new Date()

    // Get posts scheduled for now or earlier
    const { data: posts, error } = await supabase
      .from("social_posts")
      .select(`
        *,
        social_accounts!inner(platform, access_token, refresh_token, account_id)
      `)
      .eq("status", "scheduled")
      .lte("scheduled_for", now.toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(20)

    if (error) throw error

    const results = []

    for (const post of posts || []) {
      try {
        // Update status to publishing
        await supabase.from("social_posts").update({ status: "publishing" }).eq("id", post.id)

        const publishResults: any = {}

        // Publish to each platform
        for (const platform of post.platforms) {
          const account = (post.social_accounts as any[]).find((acc: any) => acc.platform === platform)

          if (!account) {
            console.log(`[v0] No account found for platform: ${platform}`)
            continue
          }

          try {
            const postId = await publishToSocialPlatform(platform, {
              content: post.content,
              mediaUrls: post.media_urls,
              accessToken: account.access_token,
              accountId: account.account_id,
            })

            publishResults[`${platform}_post_id`] = postId

            // Initialize analytics row
            await supabase.from("social_post_analytics").insert({
              social_post_id: post.id,
              platform: platform,
            })
          } catch (platformError: any) {
            console.error(`[v0] Failed to publish to ${platform}:`, platformError.message)
            publishResults[`${platform}_error`] = platformError.message
          }
        }

        // Update post with results
        await supabase
          .from("social_posts")
          .update({
            status: "published",
            published_at: new Date().toISOString(),
            ...publishResults,
          })
          .eq("id", post.id)

        results.push({ postId: post.id, status: "published", platforms: post.platforms })
      } catch (postError: any) {
        console.error(`[v0] Failed to publish post ${post.id}:`, postError.message)

        // Update post as failed
        await supabase
          .from("social_posts")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            error_message: postError.message,
            retry_count: (post.retry_count || 0) + 1,
          })
          .eq("id", post.id)

        results.push({ postId: post.id, status: "failed", error: postError.message })
      }
    }

    return NextResponse.json({
      success: true,
      processed: results.length,
      results,
    })
  } catch (error: any) {
    console.error("[v0] Social publishing cron error:", error)
    return NextResponse.json({ error: "Social publishing failed", message: error.message }, { status: 500 })
  }
}

// Helper function to publish to social platforms
async function publishToSocialPlatform(
  platform: string,
  params: {
    content: string
    mediaUrls?: string[]
    accessToken: string
    accountId: string
  },
): Promise<string> {
  switch (platform) {
    case "facebook":
      return await publishToFacebook(params)
    case "instagram":
      return await publishToInstagram(params)
    case "linkedin":
      return await publishToLinkedIn(params)
    case "twitter":
      return await publishToTwitter(params)
    default:
      throw new Error(`Platform ${platform} not supported`)
  }
}

async function publishToFacebook(params: any): Promise<string> {
  // Meta Graph API implementation
  const hasMedia = params.mediaUrls && params.mediaUrls.length > 0

  if (hasMedia) {
    // Photo/video post
    const response = await fetch(`https://graph.facebook.com/v18.0/${params.accountId}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: params.mediaUrls[0],
        caption: params.content,
        access_token: params.accessToken,
      }),
    })

    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || "Facebook API error")
    return data.id
  } else {
    // Text post
    const response = await fetch(`https://graph.facebook.com/v18.0/${params.accountId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: params.content,
        access_token: params.accessToken,
      }),
    })

    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || "Facebook API error")
    return data.id
  }
}

async function publishToInstagram(params: any): Promise<string> {
  // Instagram Graph API (requires Business/Creator account)
  if (!params.mediaUrls || params.mediaUrls.length === 0) {
    throw new Error("Instagram requires media")
  }

  // Step 1: Create media container
  const containerResponse = await fetch(`https://graph.facebook.com/v18.0/${params.accountId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_url: params.mediaUrls[0],
      caption: params.content,
      access_token: params.accessToken,
    }),
  })

  const containerData = await containerResponse.json()
  if (!containerResponse.ok) throw new Error(containerData.error?.message || "Instagram API error")

  // Step 2: Publish container
  const publishResponse = await fetch(`https://graph.facebook.com/v18.0/${params.accountId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creation_id: containerData.id,
      access_token: params.accessToken,
    }),
  })

  const publishData = await publishResponse.json()
  if (!publishResponse.ok) throw new Error(publishData.error?.message || "Instagram publish error")
  return publishData.id
}

async function publishToLinkedIn(params: any): Promise<string> {
  // LinkedIn API v2 implementation
  const hasMedia = params.mediaUrls && params.mediaUrls.length > 0

  const shareData: any = {
    author: `urn:li:person:${params.accountId}`,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: {
          text: params.content,
        },
        shareMediaCategory: hasMedia ? "IMAGE" : "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  }

  if (hasMedia) {
    shareData.specificContent["com.linkedin.ugc.ShareContent"].media = [
      {
        status: "READY",
        media: params.mediaUrls[0],
      },
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
  if (!response.ok) throw new Error(data.message || "LinkedIn API error")
  return data.id
}

async function publishToTwitter(params: any): Promise<string> {
  // Twitter API v2 implementation
  // Note: Requires OAuth 2.0 with proper scopes
  const tweetData: any = {
    text: params.content,
  }

  if (params.mediaUrls && params.mediaUrls.length > 0) {
    // Twitter requires uploading media first, then referencing media_id
    // This is a simplified version
    tweetData.media = {
      media_ids: [], // Would need to upload media first
    }
  }

  const response = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tweetData),
  })

  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || "Twitter API error")
  return data.data.id
}
