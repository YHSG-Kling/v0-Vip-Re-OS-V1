"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import {
  persistPhotoAnalysis,
  enhanceListingPhoto,
  virtualStagePhoto,
  twilightConvertPhoto,
  type PhotoEnhancement,
  type StagingStyle,
} from "@/lib/listings/photo-intelligence"

/**
 * The signed-in caller's users id + brokerage. Never taken from the client —
 * a caller-supplied brokerageId is a tenant boundary the caller controls.
 */
async function callerContext() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile, error } = await supabase
    .from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
  if (error) {
    console.error("[photo-management] profile read failed:", error.message)
    return null
  }
  if (!profile?.brokerage_id) return null
  return { supabase, userId: user.id, brokerageId: profile.brokerage_id as string }
}

/** The caller's agents.id. photo_ordering_rules.agent_id FKs agents(id) — a users
 *  id written there is FK-rejected, so it is RESOLVED, never substituted. */
async function callerAgentRecordId(userId: string, brokerageId: string): Promise<string | null> {
  const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
  return await resolveUserIdToAgentRecord(userId, brokerageId)
}

/** A listing the caller's brokerage actually owns. Returns null otherwise. */
async function callerOwnsListing(
  supabase: Awaited<ReturnType<typeof createClient>>,
  listingId: string,
  brokerageId: string,
) {
  const { data, error } = await supabase
    .from("listings").select("id, brokerage_id").eq("id", listingId).maybeSingle()
  if (error) {
    console.error("[photo-management] listing read failed:", error.message)
    return null
  }
  if (!data || data.brokerage_id !== brokerageId) return null
  return data
}

// ============================================
// AI PHOTO ANALYSIS — real vision call (lib/listings/photo-intelligence)
// ============================================

export async function analyzePhoto(params: { photoId: string; photoUrl: string }) {
  if (!isValidUUID(params.photoId)) {
    return { success: false, error: "Invalid photo ID" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  try {
    // RLS-scoped visibility check — the session client can only see photos in
    // the caller's tenant; the service client below only writes to that row.
    const { data: visible } = await supabase
      .from("listing_photos").select("id, photo_url").eq("id", params.photoId).maybeSingle()
    if (!visible) return { success: false, error: "Photo not found" }

    const svc = createServiceClient()
    const analysis = await persistPhotoAnalysis(svc, {
      photoId: params.photoId,
      photoUrl: visible.photo_url ?? params.photoUrl,
    })
    if (analysis.error) return { success: false, error: analysis.error }
    return {
      success: true,
      data: {
        room_type: analysis.roomType,
        quality_score: analysis.qualityScore,
        is_hero_worthy: analysis.heroWorthy,
        lighting_quality: analysis.lighting,
        suggestions: analysis.issues,
        vacant: analysis.vacant,
      },
    }
  } catch (error) {
    console.error("Analyze photo error:", error)
    return { success: false, error: "Failed to analyze photo" }
  }
}

// ============================================
// REAL PHOTO ENHANCEMENT — sharp pixel work, awaited inline
// ============================================

/**
 * photo_enhancement_jobs.agent_id is agents-class, so the job owner is RESOLVED
 * from the session rather than taken from the client. Both enhance entry points
 * below share this so they cannot disagree about what an agent id is.
 */
export async function enhancePhoto(params: {
  photoId: string
  enhancements: Array<PhotoEnhancement>
}) {
  if (!isValidUUID(params.photoId)) {
    return { success: false, error: "Invalid photo ID" }
  }
  const ctx = await callerContext()
  if (!ctx) return { success: false, error: "Not authenticated" }

  const { data: visible, error: visibleError } = await ctx.supabase
    .from("listing_photos").select("id").eq("id", params.photoId).maybeSingle()
  if (visibleError) return { success: false, error: visibleError.message }
  if (!visible) return { success: false, error: "Photo not found" }

  const agentRecordId = await callerAgentRecordId(ctx.userId, ctx.brokerageId)
  if (!agentRecordId) {
    return { success: false, error: "No agent profile for this user in this brokerage — an enhancement job has no owner to file it under." }
  }

  const svc = createServiceClient()
  const result = await enhanceListingPhoto(svc, {
    photoId: params.photoId,
    agentId: agentRecordId,
    brokerageId: ctx.brokerageId,
    enhancements: params.enhancements,
  })
  if (!result.ok) return { success: false, error: result.error ?? "Enhancement failed" }
  return { success: true, jobId: result.jobId, enhancedUrl: result.enhancedUrl }
}

export async function batchEnhancePhotos(params: { listingId: string }): Promise<{
  success: boolean
  error?: string
  enhanced?: number
  candidates?: number
  failures?: string[]
}> {
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  const ctx = await callerContext()
  if (!ctx) return { success: false, error: "Not authenticated" }
  if (!(await callerOwnsListing(ctx.supabase, params.listingId, ctx.brokerageId))) {
    return { success: false, error: "Listing not found" }
  }

  const agentRecordId = await callerAgentRecordId(ctx.userId, ctx.brokerageId)
  if (!agentRecordId) {
    return { success: false, error: "No agent profile for this user in this brokerage — an enhancement job has no owner to file it under." }
  }

  // RLS-scoped read: only photos in the caller's tenant come back.
  const { data: photos, error } = await ctx.supabase
    .from("listing_photos")
    .select("id, ai_quality_score, enhancement_applied")
    .eq("listing_id", params.listingId)
    .eq("ai_analysis_completed", true)

  if (error) {
    console.error("Batch enhance read error:", error.message)
    return { success: false, error: error.message }
  }
  if (!photos || photos.length === 0) return { success: true, enhanced: 0, candidates: 0 }

  const svc = createServiceClient()
  // Only scored, lower-quality, not-yet-enhanced photos
  const candidates = photos.filter(
    (p) => p.ai_quality_score !== null && p.ai_quality_score < 80 && !p.enhancement_applied,
  )
  let enhanced = 0
  const failures: string[] = []
  for (const photo of candidates) {
    const r = await enhanceListingPhoto(svc, {
      photoId: photo.id,
      agentId: agentRecordId,
      brokerageId: ctx.brokerageId,
      enhancements: ["auto"],
    })
    if (r.ok) enhanced++
    else failures.push(r.error ?? "enhancement failed")
  }

  revalidatePath(`/dashboard/listings/${params.listingId}`)
  return { success: true, enhanced, candidates: candidates.length, failures }
}

// ============================================
// VIRTUAL STAGING + TWILIGHT — gpt-image-1 edits, disclosure-carrying assets
// ============================================

async function resolvePhotoContext(photoId: string) {
  // RLS-scoped read: the session client only sees photos in the caller's
  // tenant, so cross-tenant photo ids resolve to null here.
  const supabase = await createClient()
  const { data: photo } = await supabase
    .from("listing_photos")
    .select("id, photo_url, room_type, listing_id, brokerage_id")
    .eq("id", photoId)
    .maybeSingle()
  if (!photo?.photo_url) return null
  let brokerageId = photo.brokerage_id as string | null
  if (!brokerageId && photo.listing_id) {
    const { data: listing } = await supabase
      .from("listings").select("brokerage_id").eq("id", photo.listing_id).maybeSingle()
    brokerageId = (listing as { brokerage_id: string } | null)?.brokerage_id ?? null
  }
  return brokerageId ? { svc: createServiceClient(), photo, brokerageId } : null
}

export async function stageListingPhoto(params: { photoId: string; style?: StagingStyle }) {
  if (!isValidUUID(params.photoId)) return { success: false, error: "Invalid photo ID" }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const ctx = await resolvePhotoContext(params.photoId)
  if (!ctx) return { success: false, error: "Photo not found" }

  const result = await virtualStagePhoto(ctx.svc, {
    brokerageId: ctx.brokerageId,
    agentUserId: user.id,
    listingId: ctx.photo.listing_id,
    photoId: ctx.photo.id,
    photoUrl: ctx.photo.photo_url,
    roomType: ctx.photo.room_type,
    style: params.style,
  })
  if (!result.ok) return { success: false, error: result.error ?? "Staging failed" }
  return { success: true, stagedUrl: result.stagedUrl, assetId: result.assetId }
}

export async function twilightListingPhoto(params: { photoId: string }) {
  if (!isValidUUID(params.photoId)) return { success: false, error: "Invalid photo ID" }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const ctx = await resolvePhotoContext(params.photoId)
  if (!ctx) return { success: false, error: "Photo not found" }

  const result = await twilightConvertPhoto(ctx.svc, {
    brokerageId: ctx.brokerageId,
    agentUserId: user.id,
    listingId: ctx.photo.listing_id,
    photoId: ctx.photo.id,
    photoUrl: ctx.photo.photo_url,
  })
  if (!result.ok) return { success: false, error: result.error ?? "Twilight conversion failed" }
  return { success: true, stagedUrl: result.stagedUrl, assetId: result.assetId }
}

// ============================================
// INTELLIGENT PHOTO ORDERING
// ============================================

/**
 * The MLS photo set for a listing — the `listing_photos` rows, which are a
 * DIFFERENT entity from the marketing media in `listing_media`. Every photo
 * tool in this file addresses a listing_photos id; this is how a surface gets
 * one. `photo_url` comes back so a caller holding a listing_media row can match
 * its file_url to the MLS row that was ingested from it.
 */
export async function getListingPhotoSet(listingId: string) {
  if (!isValidUUID(listingId)) return { success: false as const, error: "Invalid listing ID", photos: [] }
  const ctx = await callerContext()
  if (!ctx) return { success: false as const, error: "Not authenticated", photos: [] }
  if (!(await callerOwnsListing(ctx.supabase, listingId, ctx.brokerageId))) {
    return { success: false as const, error: "Listing not found", photos: [] }
  }

  const { data, error } = await ctx.supabase
    .from("listing_photos")
    .select("id, photo_url, order_index, room_type, ai_quality_score, ai_analysis_completed, enhancement_applied, is_hero")
    .eq("listing_id", listingId)
    .order("order_index", { ascending: true, nullsFirst: false })

  if (error) {
    console.error("[photo-management] photo set read failed:", error.message)
    return { success: false as const, error: error.message, photos: [] }
  }
  return { success: true as const, photos: data ?? [] }
}

/**
 * Reorder the MLS photo set.
 *
 * Honours the caller's ACTIVE photo_ordering_rule when they have one — that is
 * what savePhotoOrderingRule exists to produce; without this read the rule was
 * a preference nothing consulted. With no rule the MLS best-practice default
 * below applies.
 */
export async function optimizePhotoOrder(listingId: string): Promise<{
  success: boolean
  error?: string
  reordered?: number
  ruleApplied?: string | null
}> {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  const ctx = await callerContext()
  if (!ctx) return { success: false, error: "Not authenticated" }
  if (!(await callerOwnsListing(ctx.supabase, listingId, ctx.brokerageId))) {
    return { success: false, error: "Listing not found" }
  }

  const { data: photos, error: readError } = await ctx.supabase
    .from("listing_photos")
    .select("id, room_type, ai_quality_score")
    .eq("listing_id", listingId)
    .order("order_index")

  if (readError) {
    console.error("[photo-management] photo read failed:", readError.message)
    return { success: false, error: readError.message }
  }
  if (!photos || photos.length === 0) {
    return { success: true, reordered: 0, ruleApplied: null as string | null }
  }

  // The caller's own active rule, if any.
  let ruleSequence: string[] | null = null
  let rulePrioritizeQuality = true
  let ruleApplied: string | null = null
  const agentRecordId = await callerAgentRecordId(ctx.userId, ctx.brokerageId)
  if (agentRecordId) {
    const { data: rule, error: ruleError } = await ctx.supabase
      .from("photo_ordering_rules")
      .select("rule_name, room_sequence, prioritize_high_quality")
      .eq("agent_id", agentRecordId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (ruleError) {
      // A failed rule read must not silently downgrade to the default order —
      // the agent would see "optimized" and get an order they did not ask for.
      console.error("[photo-management] ordering rule read failed:", ruleError.message)
      return { success: false, error: ruleError.message }
    }
    if (rule?.room_sequence?.length) {
      ruleSequence = rule.room_sequence as string[]
      rulePrioritizeQuality = rule.prioritize_high_quality !== false
      ruleApplied = (rule.rule_name as string) ?? null
    }
  }

  const orderedPhotos = optimizePhotoSequence(photos, ruleSequence, rulePrioritizeQuality)

  for (let i = 0; i < orderedPhotos.length; i++) {
    const { error: updateError } = await ctx.supabase
      .from("listing_photos")
      .update({ order_index: i + 1 })
      .eq("id", orderedPhotos[i].id)
    if (updateError) {
      console.error("[photo-management] reorder write failed:", updateError.message)
      return { success: false, error: updateError.message }
    }
  }

  revalidatePath(`/dashboard/listings/${listingId}`)
  return { success: true, reordered: orderedPhotos.length, ruleApplied }
}

/** MLS best-practice default when the agent has saved no ordering rule. */
const DEFAULT_ROOM_SEQUENCE = [
  "exterior_front",
  "living_room",
  "kitchen",
  "primary_bedroom",
  "bathroom",
  "dining_room",
  "bedroom",
  "exterior_back",
]

function optimizePhotoSequence(
  photos: any[],
  roomSequence: string[] | null,
  prioritizeHighQuality: boolean,
): any[] {
  const sequence = roomSequence?.length ? roomSequence : DEFAULT_ROOM_SEQUENCE
  const roomPriority: Record<string, number> = {}
  sequence.forEach((room, i) => { roomPriority[room] = i + 1 })

  return [...photos].sort((a, b) => {
    const priorityA = roomPriority[a.room_type] || 99
    const priorityB = roomPriority[b.room_type] || 99

    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }

    if (!prioritizeHighQuality) return 0
    // Within same room type, sort by quality score — null scores sort last
    const scoreA = a.ai_quality_score ?? -1
    const scoreB = b.ai_quality_score ?? -1
    return scoreB - scoreA
  })
}

// ============================================
// VENDOR PHOTO PROCESSING
// ============================================

/**
 * Ingest delivered photo URLs into the listing's MLS photo set, analyse each one
 * and reorder. This is what turns a photographer's delivery into `listing_photos`
 * — nothing else in the app writes that table, so without this call the MLS set
 * stays empty and every downstream reader (hero selection, readiness, direct
 * mail, ordering) has nothing to read.
 *
 * Idempotent: a URL already in the set is skipped rather than duplicated, so
 * re-running an import after a partial failure is safe.
 *
 * SCOPE NOTE: this used to take `vendorName` and `agentId`. Neither was ever
 * used — listing_photos has no vendor column and `uploaded_by` is a users FK,
 * not a name string — so both were accepted and dropped on the floor. The row's
 * uploader is the authenticated caller, which is a fact the server already has.
 */
export async function processVendorPhotos(params: {
  listingId: string
  photoUrls: string[]
}): Promise<{
  success: boolean
  error?: string
  processed?: number
  skipped?: number
  analyzed?: number
  reordered?: number
}> {
  if (!isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }
  const urls = (params.photoUrls ?? []).map((u) => (u ?? "").trim()).filter(Boolean)
  if (urls.length === 0) return { success: false, error: "No photo URLs supplied" }

  const ctx = await callerContext()
  if (!ctx) return { success: false, error: "Not authenticated" }
  if (!(await callerOwnsListing(ctx.supabase, params.listingId, ctx.brokerageId))) {
    return { success: false, error: "Listing not found" }
  }

  // Existing set → dedupe by URL and find where the new photos append.
  const { data: existing, error: existingError } = await ctx.supabase
    .from("listing_photos")
    .select("photo_url, order_index")
    .eq("listing_id", params.listingId)
  if (existingError) {
    console.error("[photo-management] existing photo read failed:", existingError.message)
    return { success: false, error: existingError.message }
  }
  const known = new Set((existing ?? []).map((p) => p.photo_url))
  let nextIndex = (existing ?? []).reduce((max, p) => Math.max(max, p.order_index ?? 0), 0)

  const inserted: Array<{ id: string; photo_url: string }> = []
  let skipped = 0
  for (const photoUrl of urls) {
    if (known.has(photoUrl)) { skipped++; continue }
    nextIndex += 1
    const { data: photo, error: insertError } = await ctx.supabase
      .from("listing_photos")
      .insert({
        listing_id: params.listingId,
        brokerage_id: ctx.brokerageId,
        photo_url: photoUrl,
        order_index: nextIndex, // real column (was phantom display_order)
        uploaded_by: ctx.userId, // users-class FK — the authenticated importer
        ai_analysis_completed: false,
      })
      .select("id, photo_url")
      .maybeSingle()
    // A refused INSERT resolves rather than throwing — report it instead of
    // counting a row that does not exist.
    if (insertError || !photo) {
      console.error("[photo-management] photo insert failed:", insertError?.message)
      return { success: false, error: insertError?.message ?? "Photo could not be saved", processed: inserted.length }
    }
    known.add(photoUrl)
    inserted.push(photo as { id: string; photo_url: string })
  }

  // Analyse what was just ingested. A vision failure on one photo must not
  // discard the import — the row is real either way and the nightly
  // photo-intelligence cron drains the analysis backlog.
  let analyzed = 0
  for (const photo of inserted) {
    const result = await analyzePhoto({ photoId: photo.id, photoUrl: photo.photo_url })
    if (result.success) analyzed++
  }

  // Order the set once the new photos have room types to order by.
  const ordering = await optimizePhotoOrder(params.listingId)

  revalidatePath(`/dashboard/listings/${params.listingId}`)
  return {
    success: true,
    processed: inserted.length,
    skipped,
    analyzed,
    reordered: ordering.success ? (ordering as { reordered?: number }).reordered ?? 0 : 0,
  }
}

// ============================================
// PHOTO QUALITY VALIDATION
// ============================================

export async function validatePhotoQuality(listingId: string) {
  if (!isValidUUID(listingId)) {
    return {
      passed: false,
      issues: [],
    }
  }

  const supabase = await createClient()

  try {
    const { data: photos, error } = await supabase
      .from("listing_photos")
      .select("*")
      .eq("listing_id", listingId)

    // A refused read resolves rather than throwing — reporting it as "no photos
    // uploaded" would tell an agent their MLS set is empty when it is not.
    if (error) {
      console.error("Validate photo quality read error:", error.message)
      return { passed: false, issues: ["Could not read the photo set"] }
    }

    if (!photos || photos.length === 0) {
      return {
        passed: false,
        issues: ["No photos uploaded"],
      }
    }

    const issues = []

    // Check minimum photo count
    if (photos.length < 10) {
      issues.push(`Only ${photos.length} photos. Recommended: 15-25 photos`)
    }

    // Check for required room types
    const roomTypes = new Set(photos.map((p) => p.room_type))
    const requiredRooms = [
      "exterior_front",
      "living_room",
      "kitchen",
      "primary_bedroom",
    ]

    for (const room of requiredRooms) {
      if (!roomTypes.has(room)) {
        issues.push(`Missing ${room.replace("_", " ")} photo`)
      }
    }

    // Check photo quality — only flag photos that have been scored and are below threshold
    const lowQualityPhotos = photos.filter(
      (p) => p.ai_quality_score !== null && p.ai_quality_score < 70
    )
    if (lowQualityPhotos.length > 0) {
      issues.push(`${lowQualityPhotos.length} photos below quality threshold`)
    }

    // Check hero photo
    const heroPhoto = photos.find((p) => p.is_hero)
    if (!heroPhoto) {
      issues.push("No hero image selected")
    } else if (heroPhoto.ai_quality_score !== null && heroPhoto.ai_quality_score < 85) {
      issues.push("Hero image quality too low (should be 85+)")
    }

    return {
      passed: issues.length === 0,
      issues,
      photoCount: photos.length,
      avgQuality: (() => {
        const scored = photos.filter((p) => p.ai_quality_score !== null)
        return scored.length > 0
          ? scored.reduce((sum, p) => sum + p.ai_quality_score, 0) / scored.length
          : null
      })(),
    }
  } catch (error) {
    console.error("Validate photo quality error:", error)
    return {
      passed: false,
      issues: ["Error validating photos"],
    }
  }
}

// ============================================
// PHOTO ORDERING RULES
// ============================================

/**
 * Save the caller's photo ordering rule and make it the active one.
 * optimizePhotoOrder reads it, so a saved rule actually changes MLS order.
 *
 * The owning agent is RESOLVED from the session — photo_ordering_rules.agent_id
 * FKs agents(id), and a caller-supplied id is both the wrong class to trust and
 * someone else's preferences to overwrite.
 */
export async function savePhotoOrderingRule(params: {
  ruleName: string
  roomSequence: string[]
  prioritizeHighQuality: boolean
}) {
  if (!params.ruleName?.trim()) return { success: false, error: "Rule name is required" }
  if (!params.roomSequence?.length) return { success: false, error: "Room sequence is required" }

  const ctx = await callerContext()
  if (!ctx) return { success: false, error: "Not authenticated" }

  const agentRecordId = await callerAgentRecordId(ctx.userId, ctx.brokerageId)
  if (!agentRecordId) {
    return { success: false, error: "No agent profile for this user in this brokerage — an ordering rule has no owner to file it under." }
  }

  const { data: rule, error: insertError } = await ctx.supabase
    .from("photo_ordering_rules")
    .insert({
      agent_id: agentRecordId,
      brokerage_id: ctx.brokerageId,
      rule_name: params.ruleName,
      room_sequence: params.roomSequence,
      prioritize_high_quality: params.prioritizeHighQuality,
      is_active: true,
    })
    .select()
    .maybeSingle()
  if (insertError || !rule) {
    console.error("Save ordering rule error:", insertError?.message)
    return { success: false, error: insertError?.message ?? "Failed to save ordering rule" }
  }

  // Exactly one active rule per agent — deactivate the rest.
  const { error: deactivateError } = await ctx.supabase
    .from("photo_ordering_rules")
    .update({ is_active: false })
    .eq("agent_id", agentRecordId)
    .neq("id", rule.id)
  if (deactivateError) {
    console.error("Deactivate ordering rules error:", deactivateError.message)
    return { success: false, error: deactivateError.message }
  }

  return { success: true, data: rule }
}

/** The caller's own ordering rules, newest first. Agent resolved from the session. */
export async function getPhotoOrderingRules() {
  const ctx = await callerContext()
  if (!ctx) return []

  const agentRecordId = await callerAgentRecordId(ctx.userId, ctx.brokerageId)
  if (!agentRecordId) return []

  const { data, error } = await ctx.supabase
    .from("photo_ordering_rules")
    .select("*")
    .eq("agent_id", agentRecordId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Get ordering rules error:", error)
    return []
  }

  return data || []
}

// ============================================
// PHOTO ANALYTICS
// ============================================

export async function getPhotoPerformanceStats(listingId: string) {
  if (!isValidUUID(listingId)) {
    return {
      totalPhotos: 0,
      avgQuality: 0,
      roomCoverage: 0,
    }
  }

  const supabase = await createClient()

  try {
    const { data: photos, error } = await supabase.from("listing_photos").select("*").eq("listing_id", listingId)
    if (error) {
      console.error("Get photo stats read error:", error.message)
      return { totalPhotos: 0, avgQuality: null, roomCoverage: 0, error: error.message }
    }

    if (!photos || photos.length === 0) {
      return {
        totalPhotos: 0,
        avgQuality: 0,
        roomCoverage: 0,
      }
    }

    const roomTypes = new Set(photos.map((p) => p.room_type))
    const expectedRooms = 8 // Standard room types

    const scoredPhotos = photos.filter((p) => p.ai_quality_score !== null)
    return {
      totalPhotos: photos.length,
      avgQuality: scoredPhotos.length > 0
        ? scoredPhotos.reduce((sum, p) => sum + p.ai_quality_score, 0) / scoredPhotos.length
        : null,
      roomCoverage: (roomTypes.size / expectedRooms) * 100,
      enhancedCount: photos.filter((p) => p.enhancement_applied).length,
      heroImageQuality: photos.find((p) => p.is_hero)?.ai_quality_score ?? null,
    }
  } catch (error) {
    console.error("Get photo stats error:", error)
    return {
      totalPhotos: 0,
      avgQuality: 0,
      roomCoverage: 0,
    }
  }
}
