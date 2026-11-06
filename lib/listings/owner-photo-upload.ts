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

type Db = { from: (t: string) => any }

/** The two lawful listing-photo sources (listing_media.photo_source CHECK, m993). */
export const LISTING_PHOTO_SOURCES = ["idx_mls", "owner_upload"] as const
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
