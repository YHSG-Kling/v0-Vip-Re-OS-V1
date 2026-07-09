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

export async function enhancePhoto(params: {
  photoId: string
  enhancements: Array<PhotoEnhancement>
  agentId: string
}) {
  if (!isValidUUID(params.photoId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const { data: visible } = await supabase
    .from("listing_photos").select("id").eq("id", params.photoId).maybeSingle()
  if (!visible) return { success: false, error: "Photo not found" }

  const svc = createServiceClient()
  const result = await enhanceListingPhoto(svc, {
    photoId: params.photoId,
    agentId: params.agentId,
    enhancements: params.enhancements,
  })
  if (!result.ok) return { success: false, error: result.error ?? "Enhancement failed" }
  return { success: true, jobId: result.jobId, enhancedUrl: result.enhancedUrl }
}

export async function batchEnhancePhotos(params: {
  listingId: string
  agentId: string
  autoEnhance?: boolean
}) {
  if (!isValidUUID(params.listingId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  try {
    // RLS-scoped read: only photos in the caller's tenant come back.
    const { data: photos } = await supabase
      .from("listing_photos")
      .select("id, ai_quality_score, enhancement_applied")
      .eq("listing_id", params.listingId)
      .eq("ai_analysis_completed", true)

    if (!photos || photos.length === 0) return { success: true, enhanced: 0 }

    const svc = createServiceClient()
    // Only scored, lower-quality, not-yet-enhanced photos
    const candidates = photos.filter(
      (p) => p.ai_quality_score !== null && p.ai_quality_score < 80 && !p.enhancement_applied,
    )
    let enhanced = 0
    for (const photo of candidates) {
      const r = await enhanceListingPhoto(svc, {
        photoId: photo.id,
        agentId: params.agentId,
        enhancements: ["auto"],
      })
      if (r.ok) enhanced++
    }

    revalidatePath(`/dashboard/listings/${params.listingId}`)
    return { success: true, enhanced }
  } catch (error) {
    console.error("Batch enhance error:", error)
    return { success: false, error: "Failed to batch enhance photos" }
  }
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

export async function optimizePhotoOrder(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  const supabase = await createClient()

  try {
    const { data: photos } = await supabase
      .from("listing_photos")
      .select("*")
      .eq("listing_id", listingId)
      .order("order_index")

    if (!photos || photos.length === 0) {
      return { success: true, reordered: 0 }
    }

    // AI-optimized ordering strategy
    const orderedPhotos = optimizePhotoSequence(photos)

    // Update display order
    for (let i = 0; i < orderedPhotos.length; i++) {
      await supabase
        .from("listing_photos")
        .update({ order_index: i + 1 })
        .eq("id", orderedPhotos[i].id)
    }

    revalidatePath(`/dashboard/listings/${listingId}`)
    return { success: true, reordered: orderedPhotos.length }
  } catch (error) {
    console.error("Optimize photo order error:", error)
    return { success: false, error: "Failed to optimize photo order" }
  }
}

function optimizePhotoSequence(photos: any[]): any[] {
  // Best practice photo ordering for MLS
  const roomPriority: Record<string, number> = {
    exterior_front: 1,
    living_room: 2,
    kitchen: 3,
    primary_bedroom: 4,
    bathroom: 5,
    dining_room: 6,
    bedroom: 7,
    exterior_back: 8,
  }

  return photos.sort((a, b) => {
    // First, sort by room priority
    const priorityA = roomPriority[a.room_type] || 99
    const priorityB = roomPriority[b.room_type] || 99

    if (priorityA !== priorityB) {
      return priorityA - priorityB
    }

    // Within same room type, sort by quality score — null scores sort last
    const scoreA = a.ai_quality_score ?? -1
    const scoreB = b.ai_quality_score ?? -1
    return scoreB - scoreA
  })
}

// ============================================
// VENDOR PHOTO PROCESSING
// ============================================

export async function processVendorPhotos(params: {
  listingId: string
  photoUrls: string[]
  vendorName: string
  agentId: string
}) {
  if (!isValidUUID(params.listingId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const processedPhotos = []

    for (const [index, photoUrl] of params.photoUrls.entries()) {
      // Create photo record
      const { data: photo } = await supabase
        .from("listing_photos")
        .insert({
          listing_id: params.listingId,
          photo_url: photoUrl,
          order_index: index + 1, // real column (was phantom display_order)
          // uploaded_by is a uuid FK→users; params.vendorName is a name string, not a user id — omit.
          ai_analysis_completed: false,
        })
        .select()
        .single()

      // Trigger AI analysis
      if (photo) {
        await analyzePhoto({ photoId: photo.id, photoUrl })
        processedPhotos.push(photo)
      }
    }

    // Auto-optimize order after processing
    await optimizePhotoOrder(params.listingId)

    revalidatePath(`/dashboard/listings/${params.listingId}`)
    return { success: true, processed: processedPhotos.length }
  } catch (error) {
    console.error("Process vendor photos error:", error)
    return { success: false, error: "Failed to process vendor photos" }
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
    const { data: photos } = await supabase
      .from("listing_photos")
      .select("*")
      .eq("listing_id", listingId)

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

export async function savePhotoOrderingRule(params: {
  agentId: string
  ruleName: string
  roomSequence: string[]
  prioritizeHighQuality: boolean
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: rule } = await supabase
      .from("photo_ordering_rules")
      .insert({
        agent_id: params.agentId,
        rule_name: params.ruleName,
        room_sequence: params.roomSequence,
        prioritize_high_quality: params.prioritizeHighQuality,
        is_active: true,
      })
      .select()
      .single()

    // Deactivate other rules
    await supabase
      .from("photo_ordering_rules")
      .update({ is_active: false })
      .eq("agent_id", params.agentId)
      .neq("id", rule.id)

    return { success: true, data: rule }
  } catch (error) {
    console.error("Save ordering rule error:", error)
    return { success: false, error: "Failed to save ordering rule" }
  }
}

export async function getPhotoOrderingRules(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("photo_ordering_rules")
    .select("*")
    .eq("agent_id", agentId)
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
    const { data: photos } = await supabase.from("listing_photos").select("*").eq("listing_id", listingId)

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
