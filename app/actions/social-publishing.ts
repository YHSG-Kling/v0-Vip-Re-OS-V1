"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { runComplianceGate } from "@/lib/kernel/marketing/real-estate-compliance-gate"
// resolveRecipientBrokerageId (the recipient-tenant rule for notifications) is
// no longer imported here: its only user, handleContentApproved, was deleted
// onto approveSocialPost, which now carries the import.

// =====================================================
// AUTH HELPER
// =====================================================
// All social-publishing actions are exposed as Next.js server actions, which
// makes them callable from any authenticated browser session. Previous version
// trusted caller-supplied userId/userRole params and fell back to literal
// "system" when missing — both wrong. Now we resolve identity from the
// session and ignore any caller-supplied identity values.

async function resolveCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false }
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!userData?.brokerage_id) return { ok: false }
  return {
    ok: true,
    userId: user.id,
    brokerageId: userData.brokerage_id,
    userType: userData.user_type ?? "agent",
  }
}

// =====================================================
// EVENT HANDLERS — none remain (see the two tombstones below)
// =====================================================

// REMOVED (w4s1) — handleScheduledPost and handlePostPublished.
//
// Survivor for BOTH: app/api/cron/publish-social-posts/route.ts (the publish loop).
// Neither removed function published anything; both were "use server" endpoints —
// reachable over HTTP by any signed-in browser session — that mutated the publish
// state machine out of band, and nothing in the tree ever dispatched them (searched
// for callers, for the event names, and through lib/orchestrator).
//
// ONE GROUND OF THAT SEARCH HAS SINCE CHANGED; THE CONCLUSION HAS NOT. This note used
// to add that "the internal EVENT_HANDLERS map that would have registered them is
// itself declared and never read". That is RETIRED: lib/orchestrator/internal.ts's
// map is now "CONSULTED BY orchestrateEvent()" — `dispatchRegistered` (~:185-208)
// invokes handlers through it for the event types the switch routes there. What still
// holds, and is decisive on its own: neither function was ever a key in that map, and
// `lib/events/types.ts:29-54` — the whole EVENT_TYPES vocabulary — has no member for a
// scheduled-post or post-published event, so there was never an event that could have
// reached them through the map even now.
//
// They were actively hazardous, not merely redundant:
//   · handleScheduledPost flipped a due post to status='publishing' and created a
//     "Verify social post published" task. The cron selects on status='scheduled',
//     so a post moved to 'publishing' by anything else NEVER MATCHES AGAIN — the
//     post is stranded mid-flight and silently never publishes. An endpoint that
//     can permanently strand another tenant-member's scheduled post.
//   · handlePostPublished stamped status='published', published_at and a
//     CALLER-SUPPLIED external_post_id. Any signed-in user could mark any of their
//     brokerage's posts published with a fabricated platform id without a single
//     byte going to a platform — a control reporting success without doing the
//     thing, and it also skipped social_publish_log, the engagement-tracking seed
//     and the SOCIAL_POST_PUBLISHED kernel event, all of which the cron writes.
//
// MERGE REVIEW: the only capability they had that the cron lacks was an
// auto-created follow-up task per post ("verify published" at +30m, "check
// engagement" at +24h). Deliberately NOT ported. The verify task was raised at the
// moment of flipping to 'publishing' — before anything had published — and the cron
// already records real failure (status='failed', social_publish_log,
// SOCIAL_POST_FAILED), so it is busywork by construction. The engagement-check task
// is the right INTENT implemented badly: a task per published post is task spam, and
// the class is already served better at the survivor, which seeds
// social_engagement_tracking and is followed by the nightly
// /api/cron/social-analytics-sync that writes measured platform numbers.

// ─── handleContentApproved — DELETED (orphan doctrine §1.1, 2026-09-03) ──────
//
// TOMBSTONE — `handleContentApproved(payload)` is DELETED. Survivor:
// app/actions/social-media-automation.ts `approveSocialPost`, wired from
// app/actions/command-center.ts. The header above says "called by orchestrator";
// nothing in lib/orchestrator or anywhere else ever dispatched it (no caller in
// app/ or lib/), so it was a second, unreachable approver of the same
// social_posts row. What it had that the survivor lacked — the `content_approved`
// notification to the post's author, tenant-resolved through
// resolveRecipientBrokerageId — was ported onto the survivor FIRST. What was not
// ported, on purpose: its `pending_approval` scheduling arm (the survivor's own
// note rules that status was never valid — approval-pending posts are drafts).
// The header's "EVENT HANDLERS" label now describes nothing in this file.

function shouldFilterByUser(role: string): boolean {
  // Admin, Broker, and Compliance Officer see all posts in brokerage
  // SCOPE LADDER (kept inline — admits compliance tier; legacy uppercase
  // spellings retained for old rows): 'superadmin' removed — dead as
  // users.user_type (0 live rows store it).
  const adminRoles = ["ADMIN", "BROKER", "COMPLIANCE_OFFICER", "admin", "broker", "broker_owner", "compliance_officer"]
  return !adminRoles.includes(role)
}

export async function getSocialAccounts(_userId?: string, _userRole?: string) {
  const caller = await resolveCaller()
  if (!caller.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("social_media_accounts")
    .select("*")
    .eq("is_active", true)
    .order("platform")

  // Filter by user when caller doesn't have brokerage-wide visibility.
  // Note: social_media_accounts has no brokerage_id column, so we scope via user_id.
  if (shouldFilterByUser(caller.userType)) {
    query = query.eq("user_id", caller.userId)
  } else {
    // For broker/admin, restrict to users in the same brokerage
    const { data: brokerageUsers } = await supabase
      .from("users")
      .select("id")
      .eq("brokerage_id", caller.brokerageId)
    const ids = (brokerageUsers ?? []).map((u: any) => u.id)
    if (ids.length === 0) return []
    query = query.in("user_id", ids)
  }

  const { data, error } = await query

  if (error) {
    console.log("[social-publishing] Get social accounts error:", error)
    return []
  }
  return data || []
}

export async function connectSocialAccount(params: {
  platform: string
  accountId: string
  accountName: string
  accessToken: string
  refreshToken?: string
  tokenExpiresAt?: string
  scope?: string
  userId?: string  // ignored — kept for backward compat
}) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("social_media_accounts")
    .upsert(
      {
        // pass 10: the live unique is (brokerage_id, platform, account_id) —
        // the old onConflict "user_id,platform,account_id" matched no index
        // and errored on every call.
        brokerage_id: caller.brokerageId,
        user_id: caller.userId,
        platform: params.platform,
        account_id: params.accountId,
        account_name: params.accountName,
        access_token: params.accessToken,
        refresh_token: params.refreshToken,
        token_expires_at: params.tokenExpiresAt,
        scope: params.scope,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "brokerage_id,platform,account_id",
      },
    )
    .select()
    .maybeSingle()

  if (error) throw error

  // /settings/social-accounts has no page.tsx. social_media_accounts is connected
  // and disconnected from app/dashboard/profile (profile-settings-client.tsx:245) and
  // listed by the social dashboard (app/dashboard/social/page.tsx).
  revalidatePath("/dashboard/profile")
  revalidatePath("/dashboard/social")
  return data
}

export async function disconnectSocialAccount(accountId: string, _userId?: string) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  const { error } = await supabase
    .from("social_media_accounts")
    .update({ is_active: false })
    .eq("id", accountId)
    .eq("user_id", caller.userId)

  if (error) throw error

  // /settings/social-accounts has no page.tsx. social_media_accounts is connected
  // and disconnected from app/dashboard/profile (profile-settings-client.tsx:245) and
  // listed by the social dashboard (app/dashboard/social/page.tsx).
  revalidatePath("/dashboard/profile")
  revalidatePath("/dashboard/social")
}

export async function getSocialPosts(filters?: {
  status?: string
  startDate?: string
  endDate?: string
  userId?: string  // ignored — kept for backward compat
  userRole?: string  // ignored
}) {
  const caller = await resolveCaller()
  if (!caller.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("social_posts")
    .select(`
      *,
      social_post_analytics(*)
    `)
    .eq("brokerage_id", caller.brokerageId)

  if (shouldFilterByUser(caller.userType)) {
    query = query.eq("user_id", caller.userId)
  }

  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  if (filters?.startDate) {
    query = query.gte("scheduled_for", filters.startDate)
  }

  if (filters?.endDate) {
    query = query.lte("scheduled_for", filters.endDate)
  }

  const { data, error } = await query.order("scheduled_for", { ascending: true })

  if (error) {
    console.log("[social-publishing] Get social posts error:", error)
    return []
  }
  return data || []
}

export async function createSocialPost(params: {
  content: string
  mediaUrls?: string[]
  mediaTypes?: string[]
  hashtags?: string[]
  scheduledFor: string
  platforms: string[]
  contentType?: string
  linkedListingId?: string
  generatedByAi?: boolean
  aiPrompt?: string
  userId?: string  // ignored — kept for backward compat
  /** Force human review (approval_status='pending') regardless of the compliance
   *  gate — used by AUTONOMOUS posters (e.g. GBP auto-posts) so nothing reaches a
   *  public feed without passing the Command Center release gate. */
  forceApprovalPending?: boolean
}) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  // Compliance gate — hard stop if content violates real-estate rules
  const gate = await runComplianceGate({
    content: params.content,
    brokerageId: caller.brokerageId,
    authorUserId: caller.userId,
    contentType: (params.contentType as any) ?? "social_post",
    platforms: params.platforms,
  })

  if (!gate.passed) {
    const { data: draftPost } = await supabase
      .from("social_posts")
      .insert({
        user_id: caller.userId,
        brokerage_id: caller.brokerageId,
        content: params.content,
        media_urls: params.mediaUrls ?? [],
        hashtags: params.hashtags ?? [],
        scheduled_for: params.scheduledFor,
        platform: params.platforms?.[0] ?? "facebook",
        post_type: params.contentType ?? "custom",
        listing_id: params.linkedListingId ?? null,
        ai_generated: params.generatedByAi ?? false,
        post_brief: params.aiPrompt ?? null,
        status: "draft",
        brand_compliance_passed: false,
        approval_status: "pending",
      })
      .select("id")
      .maybeSingle()

    revalidatePath("/content-studio")
    return {
      success: false,
      complianceBlocked: true,
      violations: gate.violations,
      draftPostId: draftPost?.id ?? null,
      message: `Content held for compliance review: ${gate.violations.map((v) => v.rule).join(", ")}`,
    }
  }

  const { data, error } = await supabase
    .from("social_posts")
    .insert({
      user_id: caller.userId,
      brokerage_id: caller.brokerageId,
      content: params.content,
      media_urls: params.mediaUrls ?? [],
      hashtags: params.hashtags ?? [],
      scheduled_for: params.scheduledFor,
      platform: params.platforms?.[0] ?? "facebook",
      post_type: params.contentType ?? "custom",
      listing_id: params.linkedListingId ?? null,
      ai_generated: params.generatedByAi ?? false,
      post_brief: params.aiPrompt ?? null,
      status: "scheduled",
      brand_compliance_passed: true,
      approval_status: params.forceApprovalPending || gate.requiresHumanReview ? "pending" : "approved",
    })
    .select()
    .maybeSingle()

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
  return data
}

export async function updateSocialPost(
  postId: string,
  params: {
    content?: string
    mediaUrls?: string[]
    scheduledFor?: string
    platforms?: string[]
    status?: string
    userId?: string  // ignored — kept for backward compat
  },
) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  // Verify post belongs to caller's brokerage before mutating
  const { data: existing } = await supabase
    .from("social_posts")
    .select("brokerage_id, user_id")
    .eq("id", postId)
    .maybeSingle()
  if (!existing) throw new Error("Post not found")
  if (existing.brokerage_id !== caller.brokerageId) throw new Error("Forbidden")
  // Non-admins can only edit their own posts
  if (shouldFilterByUser(caller.userType) && existing.user_id !== caller.userId) {
    throw new Error("Forbidden")
  }

  const updateData: any = {}
  if (params.content !== undefined) updateData.content = params.content
  if (params.mediaUrls !== undefined) updateData.media_urls = params.mediaUrls
  if (params.scheduledFor !== undefined) updateData.scheduled_for = params.scheduledFor
  if (params.platforms !== undefined) updateData.platform = params.platforms?.[0]
  if (params.status !== undefined) updateData.status = params.status

  const { data, error } = await supabase
    .from("social_posts")
    .update(updateData)
    .eq("id", postId)
    .eq("brokerage_id", caller.brokerageId)
    .select()
    .maybeSingle()

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
  return data
}

export async function deleteSocialPost(postId: string, _userId?: string) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  // Verify post belongs to caller's brokerage before deleting
  const { data: existing } = await supabase
    .from("social_posts")
    .select("brokerage_id, user_id")
    .eq("id", postId)
    .maybeSingle()
  if (!existing) throw new Error("Post not found")
  if (existing.brokerage_id !== caller.brokerageId) throw new Error("Forbidden")
  // Non-admins can only delete their own posts
  if (shouldFilterByUser(caller.userType) && existing.user_id !== caller.userId) {
    throw new Error("Forbidden")
  }

  const { error } = await supabase
    .from("social_posts")
    .delete()
    .eq("id", postId)
    .eq("brokerage_id", caller.brokerageId)

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
}

// REMOVED (w4s1) — getSocialAnalytics.
//
// Survivor: app/actions/social-media-automation.ts:getSocialMediaAnalytics — the
// canonical social lane (that file's own header names social_engagement_tracking /
// social_publish_log as the canonical tables), wired to
// app/dashboard/social/social-dashboard-client.tsx.
//
// This one embedded `social_post_analytics`, whose only writer was REMOVED from the
// publish cron in favour of social_engagement_tracking (see the note at
// app/api/cron/publish-social-posts/route.ts: "Previously wrote
// social_post_analytics, a table nothing reads"). So its analytics block was
// structurally empty for every post, forever — it returned rows that looked like
// analytics and carried no measurement. The survivor reads the live
// social_engagement_tracking AND lets the nightly-synced social_media_analytics
// (real platform numbers) win where present.
//
// MERGED before removal: the ONE thing this had that the survivor lacked was
// per-user scoping — it narrowed to the caller's own posts for non-leadership roles,
// while the survivor was brokerage-wide, so an individual agent could read the whole
// brokerage's social performance. That filter is now on the survivor
// (`seesAllBrokeragePosts`), including the extra `broker_admin` role this list
// omitted.

export async function generateSocialContent(params: {
  contentType: string
  personaTarget?: string
  listingId?: string
  customPrompt?: string
  userId?: string  // ignored — kept for backward compat
}) {
  const caller = await resolveCaller()
  if (!caller.ok) {
    return {
      content: "",
      hashtags: [],
      aiPrompt: "",
      error: "Unauthorized",
    }
  }

  const supabase = createServiceClient()

  // Get listing details if provided — scoped to caller's brokerage
  let listingContext = ""
  if (params.listingId) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, list_price, bedrooms, bathrooms, sqft, brokerage_id")
      .eq("id", params.listingId)
      .maybeSingle()

    if (listing && listing.brokerage_id === caller.brokerageId) {
      listingContext = `Listing Details: ${listing.address}, $${listing.list_price?.toLocaleString()}, ${listing.bedrooms}BR/${listing.bathrooms}BA, ${listing.sqft}sqft.`
    }
  }

  const prompt =
    params.customPrompt ||
    `Generate a social media post for ${params.contentType}. ${listingContext} Target persona: ${params.personaTarget || "general"}. Use the "Them First" approach: 40% feelings/empathy, 25% trust-building, 25% value, 10% solution. Include relevant hashtags.`

  try {
    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt,
    })

    const hashtagRegex = /#\w+/g
    const hashtags = text.match(hashtagRegex) || []

    return {
      content: text,
      hashtags,
      aiPrompt: prompt,
    }
  } catch (error: any) {
    console.error("[social-publishing] AI generation error:", error)
    return {
      content: "AI generation is currently unavailable. Please configure your AI API keys in Settings or use the full Marketing Studio to create content.",
      hashtags: [],
      aiPrompt: prompt,
      error: error.message,
    }
  }
}
