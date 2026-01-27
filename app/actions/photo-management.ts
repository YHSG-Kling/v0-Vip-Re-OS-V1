"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// ============================================
// AI PHOTO ANALYSIS
// ============================================

export async function analyzePhoto(params: { photoId: string; photoUrl: string }) {
  if (!isValidUUID(params.photoId)) {
    return {
      success: false,
      error: "Invalid photo ID",
    }
  }

  const supabase = await createClient()

  try {
    // AI analysis would integrate with vision API (OpenAI Vision, Google Vision, etc.)
    // For now, returning structured analysis format
    const analysis = {
      room_type: detectRoomType(params.photoUrl),
      quality_score: calculateQualityScore(),
      detected_features: [
        "hardwood floors",
        "recessed lighting",
        "large windows",
        "modern fixtures",
      ],
      composition_score: 85,
      lighting_quality: "good",
      suggestions: [
        "Increase brightness by 10%",
        "Straighten horizon line",
      ],
      is_hero_worthy: true,
    }

    // Update photo record with analysis
    await supabase
      .from("listing_photos")
      .update({
        room_type: analysis.room_type,
        ai_quality_score: analysis.quality_score,
        ai_detected_features: analysis.detected_features,
        ai_analysis_completed: true,
      })
      .eq("id", params.photoId)

    return { success: true, data: analysis }
  } catch (error) {
    console.error("Analyze photo error:", error)
    return { success: false, error: "Failed to analyze photo" }
  }
}

function detectRoomType(photoUrl: string): string {
  // In production, this would use AI vision API
  const roomTypes = [
    "living_room",
    "kitchen",
    "primary_bedroom",
    "bathroom",
    "exterior_front",
    "exterior_back",
    "dining_room",
  ]
  return roomTypes[Math.floor(Math.random() * roomTypes.length)]
}

function calculateQualityScore(): number {
  // In production, this would analyze sharpness, exposure, composition
  return Math.floor(Math.random() * 30) + 70 // 70-100
}

// ============================================
// AUTOMATED PHOTO ENHANCEMENT
// ============================================

export async function enhancePhoto(params: {
  photoId: string
  enhancements: Array<"brightness" | "contrast" | "saturation" | "hdr" | "straighten">
  agentId: string
}) {
  if (!isValidUUID(params.photoId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: photo } = await supabase
      .from("listing_photos")
      .select("*")
      .eq("id", params.photoId)
      .single()

    if (!photo) {
      return { success: false, error: "Photo not found" }
    }

    // Create enhancement job
    const { data: job } = await supabase
      .from("photo_enhancement_jobs")
      .insert({
        photo_id: params.photoId,
        agent_id: params.agentId,
        original_url: photo.photo_url,
        enhancement_type: params.enhancements.join(","),
        status: "processing",
      })
      .select()
      .single()

    // In production, this would call image processing API (Cloudinary, Imgix, etc.)
    // Simulate processing
    setTimeout(async () => {
      const enhancedUrl = `${photo.photo_url}?enhanced=true`

      await supabase
        .from("photo_enhancement_jobs")
        .update({
          enhanced_url: enhancedUrl,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id)

      await supabase
        .from("listing_photos")
        .update({
          photo_url: enhancedUrl,
        })
        .eq("id", params.photoId)
    }, 2000)

    return { success: true, jobId: job.id }
  } catch (error) {
    console.error("Enhance photo error:", error)
    return { success: false, error: "Failed to enhance photo" }
  }
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

  try {
    const { data: photos } = await supabase
      .from("listing_photos")
      .select("*")
      .eq("listing_id", params.listingId)
      .eq("ai_analysis_completed", true)

    if (!photos || photos.length === 0) {
      return { success: true, enhanced: 0 }
    }

    const enhancementPromises = photos
      .filter((p) => (p.ai_quality_score || 0) < 80) // Only enhance lower quality photos
      .map((photo) =>
        enhancePhoto({
          photoId: photo.id,
          enhancements: ["brightness", "contrast", "saturation"],
          agentId: params.agentId,
        })
      )

    await Promise.all(enhancementPromises)

    revalidatePath(`/dashboard/listings/${params.listingId}`)
    return { success: true, enhanced: enhancementPromises.length }
  } catch (error) {
    console.error("Batch enhance error:", error)
    return { success: false, error: "Failed to batch enhance photos" }
  }
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
      .order("display_order")

    if (!photos || photos.length === 0) {
      return { success: true, reordered: 0 }
    }

    // AI-optimized ordering strategy
    const orderedPhotos = optimizePhotoSequence(photos)

    // Update display order
    for (let i = 0; i < orderedPhotos.length; i++) {
      await supabase
        .from("listing_photos")
        .update({ display_order: i + 1 })
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

    // Within same room type, sort by quality score
    return (b.ai_quality_score || 0) - (a.ai_quality_score || 0)
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
          display_order: index + 1,
          uploaded_by: params.vendorName,
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

    // Check photo quality
    const lowQualityPhotos = photos.filter((p) => (p.ai_quality_score || 0) < 70)
    if (lowQualityPhotos.length > 0) {
      issues.push(`${lowQualityPhotos.length} photos below quality threshold`)
    }

    // Check hero photo
    const heroPhoto = photos.find((p) => p.is_hero_image)
    if (!heroPhoto) {
      issues.push("No hero image selected")
    } else if ((heroPhoto.ai_quality_score || 0) < 85) {
      issues.push("Hero image quality too low (should be 85+)")
    }

    return {
      passed: issues.length === 0,
      issues,
      photoCount: photos.length,
      avgQuality: photos.reduce((sum, p) => sum + (p.ai_quality_score || 0), 0) / photos.length,
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

    return {
      totalPhotos: photos.length,
      avgQuality: photos.reduce((sum, p) => sum + (p.ai_quality_score || 0), 0) / photos.length,
      roomCoverage: (roomTypes.size / expectedRooms) * 100,
      enhancedCount: photos.filter((p) => p.enhancement_applied).length,
      heroImageQuality: photos.find((p) => p.is_hero_image)?.ai_quality_score || 0,
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
