"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
// Wave 97 (lane 97C): routed lane — books ai_tool_usage under the caller's tenant + user.
import { generateTextRouted } from "@/lib/ai/models"
import { createSocialPostDraft } from "@/lib/social/create-social-post-draft"
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

  // Wave 140 (lane 140P): the NON-secret projection — a "use server" return value handed to the
  // profile page's SocialAccountsCard; the sealed tokens stay in the store (credential-projection.ts).
  const { publicCredentialSelect, CREDENTIAL_STORES } = await import("@/lib/security/credential-projection")
  let query = supabase
    .from("social_media_accounts")
    .select(publicCredentialSelect("id, brokerage_id, user_id, agent_id, platform, account_id, account_name, scope, token_expires_at, is_active, created_at, updated_at", CREDENTIAL_STORES.social_media_accounts))
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

// TOMBSTONE (wave 155, lane 155R29; CLAUDE.md §1 case 2): connectSocialAccount DELETED (its twin in social-media-automation.ts with
// it). Survivor: app/api/social/oauth/[platform]/route.ts:122 GET — the OAuth connect the product runs (profile-settings-client.tsx:234
// sends the browser there). This door stored a CALLER-PASTED access token as the tenant's credential and had no importer.

export async function disconnectSocialAccount(accountId: string, _userId?: string) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const ledgered = async () => {

  const supabase = createServiceClient()

  // MERGED (wave 155, lane 155R29) from the retired social-media-automation.ts twin, plus what neither had: a malformed id is
  // refused before any write, the update is pinned to the SESSION tenant as well as the caller, and it is COUNTED — a disconnect
  // that matched nothing (another user's account, another tenant's, already gone) throws instead of reporting success (§3).
  if (!isValidUUID(accountId)) throw new Error("Invalid account ID")
  const { data: disconnected, error } = await supabase
    .from("social_media_accounts")
    .update({ is_active: false })
    .eq("id", accountId)
    .eq("brokerage_id", caller.brokerageId)
    .eq("user_id", caller.userId)
    .select("id")

  if (error) throw error
  if (!disconnected || disconnected.length === 0) throw new Error("That social account is not one of yours — nothing was disconnected")

  // /settings/social-accounts has no page.tsx. social_media_accounts is connected
  // and disconnected from app/dashboard/profile (profile-settings-client.tsx:245) and
  // listed by the social dashboard (app/dashboard/social/page.tsx).
  revalidatePath("/dashboard/profile")
  revalidatePath("/dashboard/social")
  }
  return ledgerSessionAction({ brokerageId: caller.brokerageId, action: "social.account.disconnect", actor: { type: "user", userId: caller.userId }, subject: { type: "social_media_account", id: accountId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, ledgered).then((r) => r as Awaited<ReturnType<typeof ledgered>>)
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
  /** social_accounts.id this post is scheduled through, when the caller already
   *  knows which connected account to use (merged in from the listing-media
   *  duplicate — see tombstone at app/actions/listing-media.ts). */
  socialAccountId?: string
}) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const ledgered = async () => {
  // THE writer lives in lib/social/create-social-post-draft.ts (explicit actor; the orchestrator drafts through it without a
  // session) — this action is its session door: the caller, then the studio paths revalidated.
  const result = await createSocialPostDraft(createServiceClient() as never, { userId: caller.userId, brokerageId: caller.brokerageId }, params)
  revalidatePath("/content-studio")
  if (!("complianceBlocked" in result)) revalidatePath("/social-planner")
  return result
  }
  return ledgerSessionAction({ brokerageId: caller.brokerageId, action: "social.post.create_draft", actor: { type: "user", userId: caller.userId }, subject: { type: "listing", id: params.linkedListingId ?? null }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { platforms: params.platforms } }, ledgered).then((r) => r as Awaited<ReturnType<typeof ledgered>>)
}

// TOMBSTONE (wave 155, lane 155R29; CLAUDE.md §1 case 1 — DUPLICATES): updateSocialPost and deleteSocialPost DELETED. Survivors:
// app/actions/social-media-automation.ts:1360 updateSocialPost (app/dashboard/social/components/post-composer-dialog.tsx:61 import,
// :355 call) and app/actions/social-media-automation.ts:1308 deleteSocialPost (app/dashboard/social/social-dashboard-client.tsx:61
// import, :260 call). Neither twin had an importer.
// MERGED onto the survivors first: the per-user rule (an ordinary agent edits / cancels only their own post) and, on the edit, the
// tenant pin. NOT merged, on purpose: this updateSocialPost accepted a caller-supplied `status`, so an author could move their own
// post past review (owner rule: approvers are compliance, TC, team lead and admin) — status moves only through approveSocialPost /
// rejectSocialPost and the publish cron. And this deleteSocialPost HARD-deleted the row (the survivor cancels it, so publish logs keep
// their parent).

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

  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const ledgered = async () => {
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
    const { text } = await generateTextRouted({
      feature: "social_content_draft", brokerageId: caller.brokerageId, userId: caller.userId,
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
  return ledgerSessionAction({ brokerageId: caller.brokerageId, action: "social.content.generate", actor: { type: "user", userId: caller.userId }, subject: { type: "listing", id: params.listingId ?? null }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { content_type: params.contentType } }, ledgered).then((r) => r as Awaited<ReturnType<typeof ledgered>>)
}
