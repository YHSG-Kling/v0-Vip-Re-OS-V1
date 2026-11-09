// lib/listings/owner-photo-upload.ts — THE OWNER-UPLOADED LISTING PHOTO PATH (wave 150, lane 150XY; owner ruling 2026-11-06, R9).
//
// Owner, 2026-11-06: listing photos come from exactly two lawful sources — the tenant's own IDX / MLS feed, and photos the tenant
// user UPLOADS and OWNS, "stored in the tenant's listing-media bucket with the uploading user, listing and an ownership
// attestation recorded; the existing listings.photos / listing-media survivor, never a second media store". RentCast, Tracerfy
// and DataZapp are never a photo source (RentCast's /listings/sale schema carries no photo field at all).
//
// SURVIVORS (CLAUDE.md §1 — nothing new beside them):
//   · the BUCKET: storage `listing-media`, path `<brokerageId>/<listingId>/<file>` — the convention the Media Manager upload
//     (app/dashboard/listings/[id]/media/components/media-grid.tsx uploadFile) already writes;
//   · the STORE: public.listing_media (m368/m369 merged listing_photos onto it) — uploaded_by + listing_id were already there;
//     m993 adds photo_source + the three ownership_attested_* columns (a CHECK refuses an owner_upload row without them);
//   · the GALLERY: listings.photos (jsonb, m206) — read by the public listing page, the portal, the producers; until now it had
//     no product writer. This module appends the same provenance onto each entry (shape documented for lane 150W in the notes).
//
// This module is the ONE writer of an owner-uploaded photo row; app/actions/listing-media.ts uploadListingMedia calls it for every
// media_type 'photo' after its session tenant gate. Injected client (the caller's SESSION client — RLS applies); no server import,
// so the Media Manager reads the attestation statement from here on the client.

import type { VendorCategory } from "@/lib/kernel/vendor-categories"
import { LIVE_BUCKET_CONFIG } from "@/lib/storage/bucket-limits"

type Db = { from: (t: string) => any }

/**
 * The lawful listing-photo sources (listing_media.photo_source CHECK — m993 + m966). THE ONE code constant; the
 * check-vocabulary guard holds it equal to the live CHECK plus any written-not-applied widening.
 *   idx_mls         the tenant's own IDX / MLS feed
 *   owner_upload    uploaded by a tenant user who attested ownership (recordOwnerUploadedListingPhoto)
 *   vendor_delivery delivered by the tenant's ASSIGNED photographer vendor for the listing of its booking
 *                   (recordPhotographerDelivery — wave 151, lane 151B, owner ruling L6.3)
 */
export const LISTING_PHOTO_SOURCES = ["idx_mls", "owner_upload", "vendor_delivery"] as const
export type ListingPhotoSource = (typeof LISTING_PHOTO_SOURCES)[number]

export const LISTING_MEDIA_BUCKET = "listing-media"

/** The statement the uploader accepts. A wording change is a NEW version, so an old row still names what was shown. */
export const OWNER_PHOTO_ATTESTATION_VERSION = "2026-11-06.v1"
export const OWNER_PHOTO_ATTESTATION_TEXT =
  "I took these photos, or I own them, or I hold a licence from the photographer that lets my brokerage use them to market this listing — and they show this property as it is."

/** One entry of listings.photos (the gallery). `url` stays first-class so every existing reader (`p.url`) keeps working. */
export interface ListingPhotoEntry {
  url: string
  caption: string | null
  order: number
  source: ListingPhotoSource
  media_id: string
  uploaded_by: string
  ownership_attested_at: string
  attestation_version: string
}

/** PURE — is this file in the tenant's listing-media bucket under THIS listing's folder? (never another tenant's object) */
function isListingMediaPathFor(fileUrl: string, brokerageId: string, listingId: string): boolean {
  if (typeof fileUrl !== "string" || !brokerageId || !listingId) return false
  let path: string
  try { path = decodeURIComponent(new URL(fileUrl).pathname) } catch { return false }
  return path.includes(`/${LISTING_MEDIA_BUCKET}/${brokerageId}/${listingId}/`) && !path.includes("..")
}

export interface OwnerPhotoInput {
  brokerageId: string
  listingId: string
  /** users.id of the uploader — the SESSION user, never a body value. */
  userId: string
  fileUrl: string
  caption?: string | null
  attestation: { accepted: boolean; version: string } | null | undefined
  /** The caller's other listing_media columns (usage intent, attribution flags, alt text, …). Provenance keys are refused here. */
  row?: Record<string, unknown>
  now?: Date
}

export type OwnerPhotoResult =
  | { ok: true; mediaId: string; entry: ListingPhotoEntry; galleryWarning: string | null }
  | { ok: false; error: string }

const PROVENANCE_KEYS = ["photo_source", "ownership_attested_by", "ownership_attested_at", "ownership_attestation_version", "uploaded_by", "listing_id", "brokerage_id", "media_type", "file_url"]

/**
 * Record ONE owner-uploaded listing photo: the listing_media row (uploader, listing, source 'owner_upload', the attestation) and
 * its entry on listings.photos. Refused, by name, without the attestation, outside the listing's bucket folder, or when the
 * listing is not this tenant's. A refused gallery append is RETURNED (the photo row stands — it is the record; the gallery is
 * its mirror), never swallowed.
 */
export async function recordOwnerUploadedListingPhoto(db: Db, input: OwnerPhotoInput): Promise<OwnerPhotoResult> {
  if (!input.brokerageId || !input.userId) return { ok: false, error: "No signed-in tenant user: the photo was not recorded." }
  if (input.attestation?.accepted !== true) return { ok: false, error: "Confirm that you took or own these photos (or hold the photographer's licence) before they are added to the listing." }
  if (input.attestation.version !== OWNER_PHOTO_ATTESTATION_VERSION) return { ok: false, error: "The ownership statement has changed — reopen the upload and confirm the current wording." }
  if (!isListingMediaPathFor(input.fileUrl, input.brokerageId, input.listingId)) return { ok: false, error: "A listing photo must be uploaded into this listing's folder of your listing-media library — a link to somewhere else cannot be attested." }
  const clash = Object.keys(input.row ?? {}).filter((k) => PROVENANCE_KEYS.includes(k))
  if (clash.length) return { ok: false, error: `provenance is set by the photo path itself, not by the caller: ${clash.join(", ")}` }

  const { data: listing, error: lErr } = await db.from("listings").select("id, photos").eq("id", input.listingId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (lErr) return { ok: false, error: `The listing could not be read: ${lErr.message}` }
  if (!listing) return { ok: false, error: "That listing is not in your brokerage." }

  const at = (input.now ?? new Date()).toISOString()
  const { data: ins, error: iErr } = await db.from("listing_media").insert({
    brokerage_id: input.brokerageId,
    listing_id: input.listingId,
    media_type: "photo",
    file_url: input.fileUrl,
    caption: input.caption ?? null,
    ...(input.row ?? {}),
    uploaded_by: input.userId,
    photo_source: "owner_upload",
    ownership_attested_by: input.userId,
    ownership_attested_at: at,
    ownership_attestation_version: OWNER_PHOTO_ATTESTATION_VERSION,
  }).select("id").single()
  if (iErr) {
    const missing = iErr.code === "PGRST204" ? " (the ownership columns of m993 are not live yet — nothing was stored)" : ""
    return { ok: false, error: `The photo was not recorded: ${iErr.message}${missing}` }
  }
  const mediaId = (ins as { id?: string } | null)?.id
  if (!mediaId) return { ok: false, error: "The photo insert returned no row." }

  const existing = Array.isArray((listing as { photos?: unknown }).photos) ? ((listing as { photos: unknown[] }).photos) : []
  const entry: ListingPhotoEntry = {
    url: input.fileUrl, caption: input.caption ?? null, order: existing.length, source: "owner_upload", media_id: mediaId,
    uploaded_by: input.userId, ownership_attested_at: at, attestation_version: OWNER_PHOTO_ATTESTATION_VERSION,
  }
  const { data: moved, error: gErr } = await db.from("listings").update({ photos: [...existing, entry] }).eq("id", input.listingId).eq("brokerage_id", input.brokerageId).select("id")
  const galleryWarning = gErr
    ? `The photo is saved, but the listing gallery was not updated: ${gErr.message}`
    : (Array.isArray(moved) ? moved.length : 0) !== 1 ? "The photo is saved, but the listing gallery was not updated (the listing row did not change)." : null
  return { ok: true, mediaId, entry, galleryWarning }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE PHOTOGRAPHER DELIVERY (wave 151, lane 151B — owner ruling L6.3, directive §151B "Photographer"):
//
//   ASSIGNED LISTING → authenticated photographer → permitted listing-media upload → media validation
//   → source / rights and ownership provenance → asset review (never auto-published) → availability → agent notification.
//   No access to unrelated listings.
//
// SURVIVORS, nothing new beside them: the ASSIGNMENT is the existing listing-stage booking (vendor_bookings.listing_id —
// app/actions/vendor-marketplace.ts createVendorBooking: "a listing-stage booking — photography, staging before a contract —
// has no transaction yet and carries listing_id"; vendor_assignments is transaction-only and has no listing_id); the SEAT is
// the vendor seat (user_role_assignments.vendor_id, gated by lib/kernel/portal-auth.ts requireVendorActor at the action); the
// TRADE is vendors.category 'photographer' (lib/kernel/vendor-categories.ts); the STORE is listing_media + m993's provenance
// columns + m966's third source and vendor_booking_id; the REVIEW is listing_media's own approval gate (approval_required /
// is_approved — app/actions/listing-media.ts approveListingMedia on the Media Manager); AVAILABILITY follows approval:
// this writer never appends to listings.photos (the public gallery), unlike the owner upload above, because an unreviewed
// vendor image must not be published; the NOTICE is a notifications row to the listing's agent (listings.agent_id →
// agents.user_id — agents.id and users.id are disjoint, CLAUDE.md §3).
//
// RLS NOTE: listing_media_tenant_insert admits tenant STAFF seats only, so a vendor seat cannot insert these rows through its
// session client — the "use server" door (app/actions/photo-management.ts submitPhotographerDelivery) gates FIRST
// (requireVendorActor → the booking is this vendor's) and then writes through the service client, the manager-registry
// pattern CLAUDE.md §4 names. This module is pure (injected client), so the proof drives it on the in-memory client.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The vendor trades that may deliver listing media. The owner ruling names the photographer; videographer / drone /
 *  3D-tour deliveries are a separate media_type question (video / virtual_tour) and are not admitted here. */
export const LISTING_MEDIA_DELIVERY_VENDOR_CATEGORIES: readonly VendorCategory[] = ["photographer"]

/** A booking a photographer may deliver against: accepted (confirmed) or already marked complete. `booked` is not yet
 *  accepted; requested / cancelled / no_show never (vendor_bookings_status_check vocabulary). */
export const DELIVERABLE_BOOKING_STATUSES = ["confirmed", "completed"] as const
/** A procurement-approved booking (vendor_bookings_approval_status_check), or a direct booking (NULL approval_status).
 *  Module-local: the writer below is its only reader (the jobs page shows the door by status; the server decides approval). */
const DELIVERABLE_BOOKING_APPROVALS = ["approved", "auto_approved"] as const

/** The statement the photographer accepts. A wording change is a NEW version, so an old row still names what was shown. */
export const PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION = "2026-11-09.v1"
export const PHOTOGRAPHER_DELIVERY_ATTESTATION_TEXT =
  "I photographed this property for this listing under my booking with this brokerage, I hold the rights to these images, and I license the brokerage to use them to market this listing."

/** MEDIA VALIDATION — the file types the listing-media bucket admits for a PHOTO, derived from the live bucket config
 *  (lib/storage/bucket-limits.ts), never a second list. The bucket enforces the mime at upload; this re-checks the URL
 *  the vendor hands back so a video or a PDF link cannot be recorded as a photo. */
const PHOTO_EXTENSION_MIME: Readonly<Record<string, string>> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
}
const BUCKET_IMAGE_MIMES: ReadonlySet<string> = new Set(
  (LIVE_BUCKET_CONFIG[LISTING_MEDIA_BUCKET]?.allowedMimeTypes ?? []).filter((m) => m.startsWith("image/")).map((m) => m.toLowerCase()),
)
/** PURE — does this URL name a photo file the bucket accepts? (module-local: the writer below is its one reader) */
function isAcceptedListingPhotoFile(fileUrl: string): boolean {
  let path: string
  try { path = decodeURIComponent(new URL(fileUrl).pathname) } catch { return false }
  const ext = (path.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? ""
  const mime = PHOTO_EXTENSION_MIME[ext]
  return !!mime && BUCKET_IMAGE_MIMES.has(mime)
}

export interface PhotographerDeliveryInput {
  /** The vendor seat's tenant — from requireVendorActor, never a body. */
  brokerageId: string
  /** The vendor company the seat belongs to — from requireVendorActor. */
  vendorId: string
  /** users.id of the photographer — the SESSION user. */
  userId: string
  /** The listing-stage booking the delivery is for. */
  bookingId: string
  fileUrls: string[]
  captions?: Array<string | null>
  attestation: { accepted: boolean; version: string } | null | undefined
  now?: Date
}

export type PhotographerDeliveryRefusal =
  | "no_identity" | "attestation" | "nothing" | "booking" | "not_listing_booking" | "status" | "approval" | "category"
  | "listing" | "path" | "file_type" | "write"

export type PhotographerDeliveryResult =
  | { ok: true; listingId: string; mediaIds: string[]; skipped: number; notifiedUserId: string | null; notifyWarning: string | null }
  | { ok: false; refusal: PhotographerDeliveryRefusal; error: string }

const MAX_DELIVERY_FILES = 200

/**
 * Record a photographer's delivery for the listing of ITS booking. Refused, by name, when the booking is not this vendor's,
 * is not a listing booking, is not yet accepted (or was cancelled), is not approved, when the vendor is not a photographer,
 * when a file sits outside THIS listing's folder of the tenant's bucket or is not a photo type, or without the attestation.
 * Rows land for REVIEW (approval_required, is_approved = false) and never on listings.photos. Idempotent: a URL already on
 * the listing is skipped, not duplicated. Every read's error is READ (§3).
 */
export async function recordPhotographerDelivery(db: Db, input: PhotographerDeliveryInput): Promise<PhotographerDeliveryResult> {
  if (!input.brokerageId || !input.vendorId || !input.userId) {
    return { ok: false, refusal: "no_identity", error: "No signed-in vendor seat: nothing was recorded." }
  }
  if (input.attestation?.accepted !== true) {
    return { ok: false, refusal: "attestation", error: "Confirm that you photographed this property under your booking and license the brokerage to use the images before they are delivered." }
  }
  if (input.attestation.version !== PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION) {
    return { ok: false, refusal: "attestation", error: "The rights statement has changed — reopen the delivery and confirm the current wording." }
  }
  const urls = [...new Set((input.fileUrls ?? []).map((u) => String(u ?? "").trim()).filter(Boolean))]
  if (urls.length === 0) return { ok: false, refusal: "nothing", error: "No photo files were delivered." }
  if (urls.length > MAX_DELIVERY_FILES) return { ok: false, refusal: "nothing", error: `A delivery carries at most ${MAX_DELIVERY_FILES} photos.` }

  // THE ASSIGNMENT: this vendor's booking, in this tenant.
  const { data: booking, error: bErr } = await db.from("vendor_bookings")
    .select("id, vendor_id, brokerage_id, listing_id, status, approval_status")
    .eq("id", input.bookingId).eq("vendor_id", input.vendorId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (bErr) return { ok: false, refusal: "booking", error: `The booking could not be read: ${bErr.message}` }
  if (!booking) return { ok: false, refusal: "booking", error: "That booking is not one of yours." }
  const listingId = (booking as { listing_id?: string | null }).listing_id ?? null
  if (!listingId) return { ok: false, refusal: "not_listing_booking", error: "This booking is not a listing photography booking — it names no listing." }
  const status = String((booking as { status?: string | null }).status ?? "")
  if (!(DELIVERABLE_BOOKING_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, refusal: "status", error: status === "booked" ? "Accept the booking before delivering photos." : `Photos cannot be delivered against a ${status || "non-active"} booking.` }
  }
  const approval = (booking as { approval_status?: string | null }).approval_status ?? null
  if (approval !== null && !(DELIVERABLE_BOOKING_APPROVALS as readonly string[]).includes(approval)) {
    return { ok: false, refusal: "approval", error: `This booking is ${approval} — the brokerage has not approved it yet.` }
  }

  // THE TRADE: the vendor row is a photographer.
  const { data: vendor, error: vErr } = await db.from("vendors").select("id, category, brokerage_id").eq("id", input.vendorId).maybeSingle()
  if (vErr) return { ok: false, refusal: "category", error: `Your vendor record could not be read: ${vErr.message}` }
  const category = String((vendor as { category?: string | null } | null)?.category ?? "").toLowerCase()
  if (!(LISTING_MEDIA_DELIVERY_VENDOR_CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, refusal: "category", error: `Listing photos are delivered by a photographer vendor; this vendor is ${category || "uncategorised"}.` }
  }

  // THE LISTING: in this tenant (the booking already pins it; read it for the agent and to refuse a vanished listing).
  const { data: listing, error: lErr } = await db.from("listings").select("id, agent_id, brokerage_id, address")
    .eq("id", listingId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (lErr) return { ok: false, refusal: "listing", error: `The listing could not be read: ${lErr.message}` }
  if (!listing) return { ok: false, refusal: "listing", error: "The booked listing is not in this brokerage." }

  // MEDIA VALIDATION: every file sits in THIS listing's folder of the tenant's bucket and is a photo type the bucket accepts.
  for (const url of urls) {
    if (!isListingMediaPathFor(url, input.brokerageId, listingId)) {
      return { ok: false, refusal: "path", error: "Every delivered photo must be uploaded into this listing's folder of the brokerage's listing-media library — a file from somewhere else cannot be delivered against this booking." }
    }
    if (!isAcceptedListingPhotoFile(url)) {
      return { ok: false, refusal: "file_type", error: `"${url.split("/").pop()}" is not a photo file the listing-media library accepts (jpg, jpeg, png, webp, gif, heic).` }
    }
  }

  // IDEMPOTENT: what is already on the listing is skipped, and the new rows append after the last sort position.
  const { data: existing, error: eErr } = await db.from("listing_media").select("id, file_url, sort_order")
    .eq("listing_id", listingId).eq("brokerage_id", input.brokerageId).eq("media_type", "photo")
  if (eErr) return { ok: false, refusal: "write", error: `The listing's photos could not be read: ${eErr.message}` }
  const existingRows = (existing ?? []) as Array<{ id: string; file_url: string | null; sort_order: number | null }>
  const known = new Set(existingRows.map((r) => r.file_url ?? ""))
  let sort = existingRows.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0)
  const fresh = urls.filter((u) => !known.has(u))
  const skipped = urls.length - fresh.length
  if (fresh.length === 0) return { ok: true, listingId, mediaIds: [], skipped, notifiedUserId: null, notifyWarning: null }

  const at = (input.now ?? new Date()).toISOString()
  const rows = fresh.map((url) => ({
    brokerage_id: input.brokerageId,
    listing_id: listingId,
    media_type: "photo",
    file_url: url,
    caption: input.captions?.[urls.indexOf(url)] ?? null,
    sort_order: ++sort,
    usage_intent: "both",
    // REVIEW, NOT PUBLICATION: listing_media's own approval gate holds the row until a person approves it.
    approval_required: true,
    is_approved: false,
    kernel_compliance_passed: false,
    has_logo_overlay: false,
    has_brokerage_attribution: false,
    has_eho_mark: false,
    tags: [] as string[],
    ai_analysis_completed: false,
    // PROVENANCE (m993 + m966): the uploader, the source, the rights attestation, the booking that authorized it.
    uploaded_by: input.userId,
    photo_source: "vendor_delivery",
    ownership_attested_by: input.userId,
    ownership_attested_at: at,
    ownership_attestation_version: PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION,
    vendor_booking_id: input.bookingId,
  }))
  const { data: ins, error: iErr } = await db.from("listing_media").insert(rows).select("id")
  if (iErr) {
    const missing = iErr.code === "PGRST204" || /vendor_booking_id|photo_source_check/.test(iErr.message)
      ? " (m966 — the vendor_delivery source and vendor_booking_id — is not live yet; nothing was stored)" : ""
    return { ok: false, refusal: "write", error: `The delivery was not recorded: ${iErr.message}${missing}` }
  }
  const mediaIds = ((ins ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (mediaIds.length !== rows.length) {
    return { ok: false, refusal: "write", error: `The delivery was only partly recorded (${mediaIds.length} of ${rows.length} rows came back).` }
  }

  // AGENT NOTIFICATION: the listing's agent (agents.user_id — never agents.id into notifications.user_id, a 23503).
  let notifiedUserId: string | null = null
  let notifyWarning: string | null = null
  const agentId = (listing as { agent_id?: string | null }).agent_id ?? null
  if (!agentId) {
    notifyWarning = "The photos are saved for review, but the listing has no agent to notify."
  } else {
    const { data: agent, error: aErr } = await db.from("agents").select("user_id").eq("id", agentId).maybeSingle()
    const agentUserId = (agent as { user_id?: string | null } | null)?.user_id ?? null
    if (aErr || !agentUserId) {
      notifyWarning = `The photos are saved for review, but the listing agent could not be resolved${aErr ? `: ${aErr.message}` : ""}.`
    } else {
      const address = (listing as { address?: string | null }).address ?? "your listing"
      const { error: nErr } = await db.from("notifications").insert({
        user_id: agentUserId,
        brokerage_id: input.brokerageId,
        type: "listing_media_delivered",
        title: `${mediaIds.length} photo${mediaIds.length === 1 ? "" : "s"} delivered for ${address}`,
        body: "Your photographer delivered listing photos. Review and approve them in the Media Manager before they are used.",
        entity_type: "listing",
        entity_id: listingId,
        priority: "medium",
        channel: "in_app",
      })
      if (nErr) notifyWarning = `The photos are saved for review, but the agent was not notified: ${nErr.message}`
      else notifiedUserId = agentUserId
    }
  }
  return { ok: true, listingId, mediaIds, skipped, notifiedUserId, notifyWarning }
}
