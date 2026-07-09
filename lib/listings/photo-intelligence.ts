/**
 * lib/listings/photo-intelligence.ts
 *
 * REAL listing-photo intelligence — replaces the three stubs that shipped in
 * app/actions/photo-management.ts (filename-regex "room detection", a quality
 * score that returned null, and an "enhancement" that appended ?enhanced=true
 * inside a setTimeout that never fires in serverless):
 *
 *   · analyzeListingPhoto  — ONE vision call (gateway, same rail as
 *     lib/external/vision-property.ts) returns room type, 0-100 quality,
 *     hero-worthiness, lighting, and fixable issues; written to
 *     listing_photos so photo ordering / hero selection / readiness checks
 *     run on real scores.
 *   · enhanceListingPhoto  — real pixel work (sharp): exposure, contrast,
 *     saturation, auto (normalize + sharpen). Original kept in
 *     photo_enhancement_jobs.original_url; finished JPEG hosted on Supabase
 *     storage (media-host rule). Awaited inline — honest job lifecycle.
 *   · virtualStagePhoto / twilightConvertPhoto — gpt-image-1 image EDITS
 *     (photo in → transformed photo out). Staged/twilight variants NEVER
 *     replace the listing photo set: they land in marketing_assets carrying
 *     the "Virtually staged" disclosure MLS + state ad rules require, plus a
 *     photo_enhancement_jobs row for the audit trail.
 *
 * Egress: every outbound call rides the connector gateway (single-egress
 * rule). Vision model override: PHOTO_INTEL_MODEL. Fair Housing: prompts
 * forbid people; staging is furnishings/decor ONLY — architecture, windows,
 * floors, and fixtures must stay untouched (structural edits on marketing
 * photos are misrepresentation).
 *
 * Not server-only: the asset-production simulator drives the pure pieces
 * (applyEnhancements, buildMultipartBody, prompts). Never import from a
 * client component.
 */
import sharp from "sharp"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { hostRenderedMedia } from "@/lib/remotion/media-host"

const VISION_MODEL = process.env.PHOTO_INTEL_MODEL ?? "anthropic/claude-haiku-4-5-20251001"

export const LISTING_ROOM_TYPES = [
  "exterior_front", "exterior_back", "living_room", "kitchen", "dining_room",
  "primary_bedroom", "bedroom", "bathroom", "office", "garage", "utility",
  "pool", "view", "floor_plan", "other",
] as const
export type ListingRoomType = (typeof LISTING_ROOM_TYPES)[number]

export interface PhotoAnalysis {
  roomType: ListingRoomType
  /** 0-100 — composition + lighting + clarity, judged as an MLS hero candidate. */
  qualityScore: number
  heroWorthy: boolean
  lighting: "excellent" | "good" | "dim" | "poor"
  /** Up to 3 fixable issues ("clutter on counters", "underexposed", "vertical skew"). */
  issues: string[]
  /** True when the room reads as unfurnished — the virtual-staging candidate signal. */
  vacant: boolean
  error: string | null
}

const EMPTY_ANALYSIS: PhotoAnalysis = {
  roomType: "other", qualityScore: 0, heroWorthy: false,
  lighting: "poor", issues: [], vacant: false, error: null,
}

/** One vision call → structured analysis. Pure of the DB — see persistPhotoAnalysis. */
export async function analyzeListingPhoto(params: {
  photoUrl: string
  /** Optional context ("4BR colonial in Naples FL, $1.2M") to sharpen judgment. */
  context?: string | null
}): Promise<PhotoAnalysis> {
  if (!params.photoUrl) return { ...EMPTY_ANALYSIS, error: "photoUrl required" }

  const userText =
    "You are a real-estate listing-photo editor. Look at this photo and respond ONLY with JSON:\n" +
    `{\n` +
    `  "room_type": one of ${JSON.stringify(LISTING_ROOM_TYPES)},\n` +
    `  "quality_score": 0-100 (MLS hero standard: composition, lighting, clarity, appeal),\n` +
    `  "hero_worthy": bool (would a top listing agent lead the MLS gallery with this shot?),\n` +
    `  "lighting": "excellent" | "good" | "dim" | "poor",\n` +
    `  "issues": ["up to 3 fixable issues", ...],\n` +
    `  "vacant": bool (true when the room is unfurnished/empty — a virtual-staging candidate)\n` +
    `}\n` +
    (params.context ? `CONTEXT: ${params.context}\n` : "")

  const { gatewayChat } = await import("@/lib/ai/gateway-chat")
  const res = await gatewayChat({
    model: VISION_MODEL,
    maxTokens: 400,
    temperature: 0.1,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: params.photoUrl } },
        { type: "text", text: userText },
      ],
    }],
  })
  if (!res.ok || !res.content) return { ...EMPTY_ANALYSIS, error: res.error ?? "vision call returned no content" }

  let parsed: any
  try {
    parsed = JSON.parse(res.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""))
  } catch (e) {
    return { ...EMPTY_ANALYSIS, error: `json parse failed: ${(e as Error).message}` }
  }

  const roomType = (LISTING_ROOM_TYPES as readonly string[]).includes(parsed.room_type)
    ? (parsed.room_type as ListingRoomType) : "other"
  const lighting = ["excellent", "good", "dim", "poor"].includes(parsed.lighting) ? parsed.lighting : "good"
  return {
    roomType,
    qualityScore: Math.max(0, Math.min(100, Math.round(Number(parsed.quality_score) || 0))),
    heroWorthy: !!parsed.hero_worthy,
    lighting,
    issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 3).map((s: unknown) => String(s).slice(0, 120)) : [],
    vacant: !!parsed.vacant,
    error: null,
  }
}

/** Analyze + write the result onto the listing_photos row. */
export async function persistPhotoAnalysis(
  svc: any,
  params: { photoId: string; photoUrl: string; context?: string | null },
): Promise<PhotoAnalysis> {
  const analysis = await analyzeListingPhoto(params)
  if (analysis.error) return analysis
  await svc.from("listing_photos").update({
    room_type: analysis.roomType,
    ai_quality_score: analysis.qualityScore,
    ai_analyzed_at: new Date().toISOString(),
    ai_analysis_completed: true,
  }).eq("id", params.photoId)
  return analysis
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL ENHANCEMENT — sharp pixel work, honest job lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export type PhotoEnhancement = "brightness" | "contrast" | "saturation" | "auto"

async function downloadImageBytes(url: string): Promise<Buffer | null> {
  const dl = await callConnector<Buffer>({
    connector: "asset-download", baseUrl: "", path: "", url,
    method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 30_000,
  })
  return dl.ok && dl.data ? dl.data : null
}

/** Apply the requested corrections. Pure bytes → bytes (exported for the sim). */
export async function applyEnhancements(imageBytes: Buffer, enhancements: PhotoEnhancement[]): Promise<Buffer> {
  let img = sharp(imageBytes, { failOn: "none" }).rotate() // respect EXIF orientation
  const wants = new Set(enhancements)
  if (wants.has("auto")) img = img.normalize().sharpen({ sigma: 0.8 })
  const modulate: { brightness?: number; saturation?: number } = {}
  if (wants.has("brightness")) modulate.brightness = 1.06
  if (wants.has("saturation")) modulate.saturation = 1.12
  if (modulate.brightness || modulate.saturation) img = img.modulate(modulate)
  if (wants.has("contrast")) img = img.linear(1.1, -12.8) // gentle S-curve approximation
  return img.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
}

export interface EnhanceResult {
  ok: boolean
  jobId: string | null
  enhancedUrl: string | null
  error: string | null
}

/**
 * Real enhancement, awaited inline. The original URL is preserved on the job
 * row; listing_photos.photo_url moves to the enhanced JPEG and
 * enhancement_applied flips true.
 */
export async function enhanceListingPhoto(
  svc: any,
  params: { photoId: string; agentId: string; brokerageId?: string | null; enhancements?: PhotoEnhancement[] },
): Promise<EnhanceResult> {
  const enhancements = params.enhancements?.length ? params.enhancements : (["auto"] as PhotoEnhancement[])

  const { data: photo } = await svc.from("listing_photos")
    .select("id, photo_url, listing_id, brokerage_id")
    .eq("id", params.photoId).maybeSingle()
  if (!photo?.photo_url) return { ok: false, jobId: null, enhancedUrl: null, error: "photo not found" }

  const { data: job } = await svc.from("photo_enhancement_jobs").insert({
    photo_id: params.photoId,
    agent_id: params.agentId,
    brokerage_id: params.brokerageId ?? photo.brokerage_id ?? null,
    original_url: photo.photo_url,
    enhancement_type: enhancements.join(","),
    status: "processing",
    started_at: new Date().toISOString(),
  }).select("id").single()
  const jobId = (job as { id: string } | null)?.id ?? null

  const fail = async (error: string): Promise<EnhanceResult> => {
    if (jobId) await svc.from("photo_enhancement_jobs")
      .update({ status: "failed", error_message: error }).eq("id", jobId)
    return { ok: false, jobId, enhancedUrl: null, error }
  }

  const original = await downloadImageBytes(photo.photo_url)
  if (!original) return fail("could not download the original photo")

  let enhanced: Buffer
  try {
    enhanced = await applyEnhancements(original, enhancements)
  } catch (e) {
    return fail(`enhancement failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  const enhancedUrl = await hostRenderedMedia(
    svc, `photo-enhance/${params.photoId}-${Date.now()}.jpg`, enhanced, "image/jpeg",
  )

  if (jobId) await svc.from("photo_enhancement_jobs").update({
    status: "completed", enhanced_url: enhancedUrl, completed_at: new Date().toISOString(),
  }).eq("id", jobId)
  await svc.from("listing_photos").update({
    photo_url: enhancedUrl, enhancement_applied: true,
  }).eq("id", params.photoId)

  return { ok: true, jobId, enhancedUrl, error: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI IMAGE EDITS — gpt-image-1 photo-in → photo-out (staging / twilight)
// ─────────────────────────────────────────────────────────────────────────────

/** Hand-built multipart/form-data body — the gateway sends it via bodyType:"binary". */
export function buildMultipartBody(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; contentType: string; data: Buffer }>,
  boundary: string,
): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if ("data" in p) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
        `Content-Type: ${p.contentType}\r\n\r\n`,
      ))
      chunks.push(p.data, Buffer.from("\r\n"))
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`))
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

/**
 * One gpt-image-1 EDIT call: photo bytes + instruction → transformed photo
 * bytes. Vercel AI Gateway first (one egress/billing), direct OpenAI as the
 * fallback — the same two-step image-generation.ts uses.
 */
export async function editImageWithAI(params: {
  imageBytes: Buffer
  prompt: string
  /** gpt-image-1 edit sizes; picked from the source aspect when omitted. */
  size?: "1024x1024" | "1536x1024" | "1024x1536"
}): Promise<{ imageBytes: Buffer | null; error: string | null }> {
  let size = params.size
  let pngBytes: Buffer
  try {
    const meta = await sharp(params.imageBytes).metadata()
    const w = meta.width ?? 1024, h = meta.height ?? 1024
    if (!size) size = w > h * 1.15 ? "1536x1024" : h > w * 1.15 ? "1024x1536" : "1024x1024"
    // Bound the upload (edits accept ≤50MB but there's no reason to ship 8K)
    pngBytes = await sharp(params.imageBytes).rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .png().toBuffer()
  } catch (e) {
    return { imageBytes: null, error: `source image unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }

  const boundary = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const attempt = async (baseUrl: string, model: string, token: string) => {
    const body = buildMultipartBody([
      { name: "model", value: model },
      { name: "prompt", value: params.prompt },
      { name: "size", value: size as string },
      { name: "image", filename: "photo.png", contentType: "image/png", data: pngBytes },
    ], boundary)
    return callConnector<any>({
      connector: "gpt-image-edit",
      baseUrl,
      path: "/v1/images/edits",
      method: "POST",
      auth: { style: "bearer", token },
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      bodyType: "binary",
      timeoutMs: 120_000,
    })
  }

  const gatewayKey = process.env.AI_GATEWAY_API_KEY
  if (gatewayKey) {
    const res = await attempt("https://ai-gateway.vercel.sh", "openai/gpt-image-1", gatewayKey)
    const b64 = res.ok ? (res.data?.data?.[0]?.b64_json as string | undefined) : undefined
    if (b64) return { imageBytes: Buffer.from(b64, "base64"), error: null }
  }
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    const res = await attempt("https://api.openai.com", "gpt-image-1", openaiKey)
    const b64 = res.ok ? (res.data?.data?.[0]?.b64_json as string | undefined) : undefined
    if (b64) return { imageBytes: Buffer.from(b64, "base64"), error: null }
    if (!res.ok) return { imageBytes: null, error: res.error ?? `edit call failed (${res.status})` }
  }
  return { imageBytes: null, error: "no image-edit provider available (AI_GATEWAY_API_KEY / OPENAI_API_KEY)" }
}

export const STAGING_STYLES = ["modern", "scandinavian", "traditional", "coastal", "farmhouse", "luxury"] as const
export type StagingStyle = (typeof STAGING_STYLES)[number]

/** The MLS-safe editorial boundary, stated once. */
const STRUCTURE_GUARDRAIL =
  "CRITICAL: Do NOT alter the architecture, walls, windows, doors, flooring, ceilings, " +
  "built-in fixtures, or the view outside the windows — the room itself must remain exactly " +
  "as photographed. Do not add people or pets. Photorealistic result."

export function stagingPrompt(roomType: string, style: StagingStyle): string {
  const room = roomType.replace(/_/g, " ")
  return (
    `Virtually stage this empty ${room} with tasteful ${style}-style furniture, rugs, ` +
    `lighting and decor appropriate for a real-estate listing. Keep the arrangement realistic ` +
    `and uncluttered so the space reads larger. ${STRUCTURE_GUARDRAIL}`
  )
}

export function twilightPrompt(): string {
  return (
    "Convert this exterior real-estate photo to a professional twilight (dusk) shot: deep-blue " +
    "evening sky with warm sunset glow on the horizon, interior and exterior lights turned on " +
    "with a warm inviting glow. Keep the house, landscaping, driveway and every physical detail " +
    `exactly as photographed — only the time of day and lighting change. ${STRUCTURE_GUARDRAIL}`
  )
}

export const VIRTUAL_STAGING_DISCLOSURE =
  "Virtually staged — furnishings and decor are digitally rendered."
export const TWILIGHT_DISCLOSURE =
  "Digitally enhanced twilight photo."

export interface StagedPhotoResult {
  ok: boolean
  jobId: string | null
  assetId: string | null
  stagedUrl: string | null
  error: string | null
}

async function runPhotoEdit(
  svc: any,
  params: {
    brokerageId: string
    agentUserId?: string | null
    listingId?: string | null
    photoId?: string | null
    photoUrl: string
    kind: "virtual_staging" | "twilight"
    prompt: string
    assetName: string
    disclosure: string
    tags: string[]
  },
): Promise<StagedPhotoResult> {
  const { data: job } = await svc.from("photo_enhancement_jobs").insert({
    photo_id: params.photoId ?? null,
    agent_id: params.agentUserId ?? null,
    brokerage_id: params.brokerageId,
    original_url: params.photoUrl,
    enhancement_type: params.kind,
    status: "processing",
    started_at: new Date().toISOString(),
  }).select("id").single()
  const jobId = (job as { id: string } | null)?.id ?? null

  const fail = async (error: string): Promise<StagedPhotoResult> => {
    if (jobId) await svc.from("photo_enhancement_jobs")
      .update({ status: "failed", error_message: error }).eq("id", jobId)
    return { ok: false, jobId, assetId: null, stagedUrl: null, error }
  }

  const original = await downloadImageBytes(params.photoUrl)
  if (!original) return fail("could not download the source photo")

  const edited = await editImageWithAI({ imageBytes: original, prompt: params.prompt })
  if (!edited.imageBytes) return fail(edited.error ?? "image edit produced no output")

  const jpeg = await sharp(edited.imageBytes).jpeg({ quality: 92, mozjpeg: true }).toBuffer()
  const stagedUrl = await hostRenderedMedia(
    svc, `photo-staging/${params.kind}-${jobId ?? Date.now()}.jpg`, jpeg, "image/jpeg",
  )

  if (jobId) await svc.from("photo_enhancement_jobs").update({
    status: "completed", enhanced_url: stagedUrl, completed_at: new Date().toISOString(),
  }).eq("id", jobId)

  // The staged variant is a MARKETING asset carrying its disclosure — it never
  // joins the listing_photos MLS set.
  const { data: asset } = await svc.from("marketing_assets").insert({
    brokerage_id: params.brokerageId,
    agent_user_id: params.agentUserId ?? null,
    visibility_scope: "agent",
    asset_type: "image",
    asset_name: params.assetName,
    asset_url: stagedUrl,
    thumbnail_url: stagedUrl,
    source_table: "photo_enhancement_jobs",
    source_id: jobId,
    tags: params.tags,
    approval_status: "approved",
    metadata: {
      kind: params.kind,
      disclosure: params.disclosure,
      original_url: params.photoUrl,
      listing_id: params.listingId ?? null,
      photo_id: params.photoId ?? null,
    },
  }).select("id").single()

  return { ok: true, jobId, assetId: (asset as { id: string } | null)?.id ?? null, stagedUrl, error: null }
}

/** Stage an empty room. Output → marketing_assets with the staging disclosure. */
export async function virtualStagePhoto(
  svc: any,
  params: {
    brokerageId: string
    agentUserId?: string | null
    listingId?: string | null
    photoId?: string | null
    photoUrl: string
    roomType?: string | null
    style?: StagingStyle
  },
): Promise<StagedPhotoResult> {
  const style = params.style ?? "modern"
  const room = params.roomType ?? "room"
  return runPhotoEdit(svc, {
    ...params,
    kind: "virtual_staging",
    prompt: stagingPrompt(room, style),
    assetName: `Virtually Staged ${room.replace(/_/g, " ")} (${style})`,
    disclosure: VIRTUAL_STAGING_DISCLOSURE,
    tags: ["virtually_staged", style, room],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTONOMOUS SWEEP — the nightly photo-intelligence pass (asset_manager)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Daily cron work: (1) vision-analyze unanalyzed photos on active listings
 * (bounded per run — the backlog drains across nights), (2) fill missing MLS
 * heroes with the best-scored shot (exterior-front first, then quality) so no
 * active listing markets itself off a random first upload.
 */
export async function runPhotoIntelligenceSweep(
  svc: any,
  opts?: { analyzeLimit?: number },
): Promise<{ photosAnalyzed: number; analysisFailures: number; heroesSet: number }> {
  const analyzeLimit = opts?.analyzeLimit ?? 40

  const { data: listings } = await svc.from("listings")
    .select("id, address, city, state, list_price")
    .eq("status", "active")
    .limit(2000)
  const listingRows = (listings ?? []) as Array<{ id: string; address: string | null; city: string | null; state: string | null; list_price: number | null }>
  const listingById = new Map(listingRows.map((l) => [l.id, l]))
  const listingIds = listingRows.map((l) => l.id)
  if (listingIds.length === 0) return { photosAnalyzed: 0, analysisFailures: 0, heroesSet: 0 }

  // 1. Analyze the unanalyzed (bounded)
  const { data: pending } = await svc.from("listing_photos")
    .select("id, photo_url, listing_id")
    .in("listing_id", listingIds)
    .eq("ai_analysis_completed", false)
    .not("photo_url", "is", null)
    .limit(analyzeLimit)
  let photosAnalyzed = 0, analysisFailures = 0
  for (const p of (pending ?? []) as Array<{ id: string; photo_url: string; listing_id: string }>) {
    const l = listingById.get(p.listing_id)
    const context = l
      ? [l.address, [l.city, l.state].filter(Boolean).join(", "), l.list_price ? `$${Number(l.list_price).toLocaleString()}` : null].filter(Boolean).join(" · ")
      : null
    const analysis = await persistPhotoAnalysis(svc, { photoId: p.id, photoUrl: p.photo_url, context })
    if (analysis.error) analysisFailures++
    else photosAnalyzed++
  }

  // 2. Fill missing heroes from analyzed inventory
  const { data: allPhotos } = await svc.from("listing_photos")
    .select("id, listing_id, is_hero, room_type, ai_quality_score, ai_analysis_completed")
    .in("listing_id", listingIds)
  const byListing = new Map<string, Array<{ id: string; is_hero: boolean; room_type: string | null; ai_quality_score: number | null; ai_analysis_completed: boolean }>>()
  for (const p of (allPhotos ?? []) as Array<any>) {
    const arr = byListing.get(p.listing_id) ?? []
    arr.push(p)
    byListing.set(p.listing_id, arr)
  }
  let heroesSet = 0
  for (const [, photos] of byListing) {
    if (photos.some((p) => p.is_hero)) continue
    const analyzed = photos.filter((p) => p.ai_analysis_completed && p.ai_quality_score !== null)
    if (analyzed.length === 0) continue
    analyzed.sort((a, b) => {
      const frontA = a.room_type === "exterior_front" ? 1 : 0
      const frontB = b.room_type === "exterior_front" ? 1 : 0
      if (frontA !== frontB) return frontB - frontA
      return (b.ai_quality_score ?? 0) - (a.ai_quality_score ?? 0)
    })
    const { error } = await svc.from("listing_photos").update({ is_hero: true }).eq("id", analyzed[0].id)
    if (!error) heroesSet++
  }

  return { photosAnalyzed, analysisFailures, heroesSet }
}

/** Day-to-dusk conversion for exterior heroes. */
export async function twilightConvertPhoto(
  svc: any,
  params: {
    brokerageId: string
    agentUserId?: string | null
    listingId?: string | null
    photoId?: string | null
    photoUrl: string
  },
): Promise<StagedPhotoResult> {
  return runPhotoEdit(svc, {
    ...params,
    kind: "twilight",
    prompt: twilightPrompt(),
    assetName: "Twilight Exterior (digitally enhanced)",
    disclosure: TWILIGHT_DISCLOSURE,
    tags: ["twilight", "exterior"],
  })
}
