// lib/storage/document-buckets.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHICH BUCKETS MAY SERVE A PERMANENT UNAUTHENTICATED URL, AND WHICH MAY NOT.
//
// A PUBLIC Supabase bucket serves every object it holds at
//
//     https://<proj>.supabase.co/storage/v1/object/public/<bucket>/<path>
//
// with no session, no RLS and NO EXPIRY. That URL is a bearer capability that
// never dies: once it exists — in an email body, a webhook payload, a browser
// history, a proxy log — the object behind it is readable by anyone holding the
// string, forever. It is the same class as a credential riding out in an export,
// except that a credential can be rotated and this cannot.
//
// PUBLIC IS NOT AUTOMATICALLY A DEFECT. A listing photo on a public listing page,
// an agent headshot, a brokerage logo, a business card, a rendered promo video,
// a voicemail-drop MP3 a carrier must fetch unauthenticated — those are MEANT to
// be world-readable, and signing them would be theatre. The defect is putting a
// board packet, a buyer's bank statement, a filled commission disclosure or a
// signed listing agreement behind the same primitive.
//
// So this module is the ONE VOCABULARY (CLAUDE.md §6) for that distinction, and
// the ONE ROUTER for issuing a URL against it. There is exactly one way a
// document-class object URL is minted in this tree, and it is
// issueBucketObjectUrl → signedDocUrl (lib/storage/signed-doc-url.ts, the
// write-time survivor) — never getPublicUrl, and never a fallback to
// getPublicUrl when signing fails. FAIL CLOSED: a caller that cannot get a
// signed URL gets a REASON and must refuse, because a fallback to public is
// exactly the shape that would undo this.
//
// The read-time survivor for a `client_documents` row is
// lib/kernel/document-custody.ts#issueGovernedDocumentUrl — short purpose-scoped
// TTL plus a document_access_log row. That one governs an ACCESS; this one
// governs the URL a WRITER persists. document-custody re-exports the predicate
// below so custody callers keep a single import surface.
//
// ── THE MEASUREMENT THAT SIZES THE RISK (live, project hrvaqgvukzxfskkcrwbt) ──
// Measured 2026-08-22 against storage.buckets / storage.objects:
//   public=true : agent-media, brokerage-assets, brokerage-forms, business-cards,
//                 documents, listing-media, media, video-assets
//   public=false: client-documents, offer-documents, transaction-documents
//   EVERY bucket holds ZERO objects.
// Nothing has leaked yet. Every fix below is pre-traffic, which is the only
// window in which the bucket flip in
// scripts/1108-private-document-buckets.sql is free.

import type { SupabaseClient } from "@supabase/supabase-js"
import { signedDocUrl, DOC_URL_TTL_SECONDS } from "./signed-doc-url"

/**
 * Buckets whose objects are MEANT to be world-readable — marketing surfaces and
 * media that a public page, a render worker or a telephony carrier fetches with
 * no session. Each entry carries the reason it is on this list; adding one is a
 * deliberate decision, not a default.
 *
 * THIS LIST IS THE ALLOWLIST. Anything not on it is document-class, so a bucket
 * nobody has classified yet fails CLOSED into signing (a signed URL still
 * fetches for whoever holds it, so the safe default is also the working one).
 */
export const PUBLIC_MEDIA_BUCKETS: Readonly<Record<string, string>> = {
  "listing-media":      "Listing photos and B-roll rendered onto public listing pages, MLS syndication and promo video.",
  "agent-media":        "Agent headshots, brand imagery and content-studio assets shown on public agent pages.",
  "business-cards":     "Generated business-card images — the entire point is that anyone can open the link.",
  "brokerage-assets":   "Brokerage logos and brand marks composited into public marketing.",
  "media":              "Voice/MMS audio a telephony carrier fetches UNAUTHENTICATED at delivery time (lib/providers/dispatch.ts).",
  "video-assets":       "TTS audio and rendered video the Remotion workers and public players fetch by URL.",
  "twin-avatars":       "The agent's own avatar image; the resulting twin speaks in published marketing video.",
  "twin-voice-samples": "The agent's own voice sample for their twin. UNRESOLVED: a voice print is closer to biometric than to marketing — public is defensible only because the clone it trains speaks publicly anyway. Flagged for the owner rather than silently reclassified.",
}

/**
 * Buckets that hold DOCUMENTS — brokerage financials, client/buyer financial
 * paperwork, transaction paperwork and the forms those are filled onto. A
 * permanent public URL is never correct for one of these.
 *
 * Listed explicitly (rather than left to the not-in-the-allowlist rule) so the
 * guard has a positive roster to check the migration and the call sites against.
 * Four of these buckets do not exist live yet — they are created on first write
 * by lib/storage/buckets.ts#ensureBucket, which is exactly why that function's
 * default had to stop being `public: true`.
 */
export const DOCUMENT_CLASS_BUCKETS: Readonly<Record<string, string>> = {
  "client-documents":       "Client/buyer financial paperwork — pre-approvals, proof of funds, bank statements, tax returns. Already public=false live.",
  "offer-documents":        "Offer PDFs and counters. Already public=false live.",
  "transaction-documents":  "Closed-file transaction record. Already public=false live.",
  "documents":              "The universal document lane — offer attachments, listing agreements, inbound-email attachments, board packets, certificates. PUBLIC LIVE TODAY; the flip is scripts/1108-private-document-buckets.sql.",
  "brokerage-forms":        "Broker-uploaded transaction forms AND the FILLED copies written alongside them under filled/ (app/actions/buyer-offer/prefill-storage-form.ts). A filled offer form carries the buyer's name, price and terms. PUBLIC LIVE TODAY.",
  "cda-templates":          "Brokerage commission-disclosure templates — proprietary brokerage paperwork. Not yet created live.",
  "cda-filled":             "FILLED commission disclosures — commission splits, a brokerage financial. Not yet created live.",
  "commission-agreements":  "Signed agent commission / independent-contractor agreements. Not yet created live.",
  "receipts":               "Expense receipts attached to the brokerage P&L. Not yet created live.",
  "agent-documents":        "An agent's real-estate LICENSE document and E&O insurance certificate (app/dashboard/onboarding/license). NOT CREATED LIVE AND NOT CREATABLE FROM HERE — the upload runs in the browser, so ensureBucket never sees it; those uploads fail today with 'Bucket not found'. scripts/1108-private-document-buckets.sql creates it private.",
}

/**
 * PURE. Is this bucket document-class — i.e. must its URLs be signed?
 *
 * FAIL CLOSED by construction: the answer is "yes" for every bucket that is not
 * on the PUBLIC_MEDIA_BUCKETS allowlist, so a bucket introduced tomorrow and
 * classified by nobody is signed rather than served forever. "Nobody checked"
 * must never render as "checked and fine" (CLAUDE.md §4).
 */
export function isDocumentClassBucket(bucket: string | null | undefined): boolean {
  if (!bucket) return true
  return !(bucket in PUBLIC_MEDIA_BUCKETS)
}

/** The reason a bucket is classified the way it is — for reports and the guard. */
export function bucketClassReason(bucket: string): string {
  return (
    PUBLIC_MEDIA_BUCKETS[bucket] ??
    DOCUMENT_CLASS_BUCKETS[bucket] ??
    "unclassified — treated as document-class (fail closed); add it to one of the two rosters in lib/storage/document-buckets.ts"
  )
}

export type BucketUrlResult =
  | { ok: true; url: string; kind: "signed" | "public"; ttlSeconds: number | null }
  | { ok: false; reason: string }

/**
 * THE ONE WAY a writer turns an object it just stored into a URL.
 *
 *   · document-class bucket → a TIME-LIMITED signed URL via signedDocUrl.
 *     If signing fails, the caller gets { ok: false, reason } and MUST refuse.
 *     There is deliberately no public fallback: falling back to a permanent
 *     unauthenticated URL on the sad path is the whole defect this closes.
 *   · public-media bucket   → getPublicUrl, which is correct for that class.
 *
 * Honest about supabase-js (CLAUDE.md §3): a refusal RESOLVES rather than
 * throwing, so signedDocUrl's empty-string return is read as a failure here
 * instead of being handed onward as a URL.
 *
 * `ttlSeconds` defaults to DOC_URL_TTL_SECONDS because nearly every write-time
 * caller PERSISTS the URL to a column (documents.storage_url, offers
 * .offer_document_url, brokerage_form_library.pdf_url …) and a short expiry
 * would silently break the stored link. The correct end-state is sign-on-read —
 * lib/kernel/document-custody.ts#issueGovernedDocumentUrl is that path for
 * client_documents — and this long-TTL signer is the bridge, exactly as
 * signed-doc-url.ts already documents.
 */
export async function issueBucketObjectUrl(
  client: SupabaseClient,
  params: { bucket: string; objectPath: string; ttlSeconds?: number },
): Promise<BucketUrlResult> {
  const { bucket, objectPath } = params

  if (!isDocumentClassBucket(bucket)) {
    try {
      const { data } = client.storage.from(bucket).getPublicUrl(objectPath)
      const url = data?.publicUrl ?? ""
      if (!url) return { ok: false, reason: `getPublicUrl returned no URL for ${bucket}/${objectPath}` }
      return { ok: true, url, kind: "public", ttlSeconds: null }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  const ttlSeconds = params.ttlSeconds ?? DOC_URL_TTL_SECONDS
  let signed = ""
  try {
    signed = await signedDocUrl(client, bucket, objectPath, ttlSeconds)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  if (!signed) {
    return {
      ok: false,
      reason:
        `could not mint a signed URL for the document-class bucket '${bucket}' ` +
        `(${objectPath}) — refusing rather than falling back to a permanent public URL. ` +
        `Why this bucket is document-class: ${bucketClassReason(bucket)}`,
    }
  }
  return { ok: true, url: signed, kind: "signed", ttlSeconds }
}
