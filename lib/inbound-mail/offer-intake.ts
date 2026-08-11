// lib/inbound-mail/offer-intake.ts
// ─────────────────────────────────────────────────────────────────────────────
// EMAIL → OFFER auto-intake (server). The listing agent's email lookout: when an inbound email is an
// offer for an in-house listing, AUTO-create the offer (when the buyer is a known sender contact) and
// kick AI extraction — which, on completion, hands off to the Listing Concierge for the net-sheet
// comparison. When the buyer is unknown, surface a one-tap "confirm" notification to the listing agent
// instead of fabricating an offer. Documents land in Supabase Storage (offer-documents). Best-effort;
// never throws into the webhook.
//
// ── OBLIGATION 4 OF THE OWNER'S RULING — "documents that are NOT ours must be
//    read and COUNTED in the transaction paperwork" ──────────────────────────
//
// This module used to write the PDF to storage, set `offers.offer_document_url`,
// and create NO `documents` row at all. `lib/compliance/required-documents.ts:
// auditOfferDocuments` counts ONLY `documents` rows (by `metadata.linked_offer_id`
// or the buyer contact), so the outside buyer's contract — the single most
// important piece of paper in the deal — could not be counted, classified,
// scanned for signatures, or filed. Worse on the CONFIRM branch, which is the one
// that actually fires for an outside buyer's AGENT (they are not a known
// contact): it stored NOTHING. It notified the listing agent "review and upload
// it" and then returned `handled:true`, which makes
// `app/api/webhooks/inbound-mail/route.ts` `continue` PAST its own generic
// `uploadDocument` loop. The attachment was dropped on the floor.
//
// Both branches now route every PDF through the UNIVERSAL uploader,
// `lib/documents/upload-document.ts:uploadDocument` — the same ledger
// `record-seller-response.ts` uses — which creates the `documents` row AND kicks
// `scan-uploaded-document.ts` (classification + summary + `signature_completeness`
// + the field-extraction ledger). One ledger, not a second one.
//
// EVERY PDF, not just the first. An outside agent's email carries the contract
// PLUS addenda, disclosures and the pre-approval; only `pdfs[0]` was ever
// touched. The rest are the same class of paper and are filed the same way.
//
// ── ONE THING THIS DELIBERATELY DOES NOT DO ─────────────────────────────────
// It never files these rows as `document_type:'offer'`. That value is the key
// `lib/workflow/intelligence/scan-offer-packet.ts:179` finds a STAGED PACKET by,
// and an inbound PDF has no `content.filledPacket` in it. Since wave 9 a staged
// document that carries no packet is an explicit FAULT — so filing the inbound
// contract under that type would have made the packet scan unrunnable on every
// inbound offer and refused 100% of them at the compliance gate. The rows are
// filed under their own types and reach the audit through `classification`,
// which is what `auditOfferDocuments` actually counts.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { uploadDocument } from "@/lib/documents/upload-document"
import {
  looksLikeOffer, matchListingByAddress, assessOfferIntake, planInboundFiling,
  planInboundOfferLink, AWAITING_OFFER_LINK_KEY, LINKED_OFFER_ID_KEY,
  type ListingLite, type PendingInboundDocument, type InboundOfferLinkPlan,
} from "./offer-detect"

type Svc = ReturnType<typeof createServiceClient>

export interface InboundOfferAttachment { fileName: string; mime: string; contentB64: string | null }

export interface OfferIntakeResult {
  handled: boolean
  outcome?: "auto" | "confirm"
  offerId?: string
  listingId?: string
  /** documents.id of every inbound PDF filed into the deal-file ledger. */
  documentIds?: string[]
}

// The filing PLAN — which attachments are filed and under what document_type —
// is pure, so it lives with the rest of this lane's pure half in
// `./offer-detect.ts:planInboundFiling` where a proof can run it without a
// storage bucket or a database. Nothing here re-decides it.

export async function tryIngestInboundOffer(
  input: {
    brokerageId: string
    subject: string | null
    bodyText: string | null
    fromEmail: string | null
    /** The resolved buyer contact when the SENDER is a known contact (null for outside agents). */
    senderContactId: string | null
    attachments: InboundOfferAttachment[]
  },
  client?: Svc,
): Promise<OfferIntakeResult> {
  const svc = client ?? createServiceClient()
  const pdfs = input.attachments.filter((a) => a.mime === "application/pdf" && a.contentB64)
  if (pdfs.length === 0) return { handled: false }

  // In-house listings in the active pipeline to match the address against.
  const { data: lst } = await svc
    .from("listings")
    .select("id, address, agent_id")
    .eq("brokerage_id", input.brokerageId)
    .in("status", ["active", "coming_soon", "pending"])
    .limit(300)
  const listings = (lst ?? []) as ListingLite[]
  if (listings.length === 0) return { handled: false }

  const fileNames = pdfs.map((p) => p.fileName).join(" ")
  const text = [input.subject, input.bodyText, fileNames].filter(Boolean).join(" \n ")
  const match = matchListingByAddress(text, listings)
  const isOffer = looksLikeOffer(input.subject, fileNames, input.bodyText)
  const decision = assessOfferIntake({
    looksLikeOffer: isOffer,
    listingMatched: !!match,
    senderIsKnownContact: !!input.senderContactId,
  })
  if (decision === "skip" || !match) return { handled: false }

  const provenance = {
    intake_source: "inbound_email",
    from_email:    input.fromEmail,
    subject:       input.subject,
    received_at:   new Date().toISOString(),
  }

  // CONFIRM — the OUTSIDE BUYER'S AGENT path (they are not a known contact, so
  // there is no buyer to fill the NOT-NULL offers.contact_id and we will not
  // fabricate one). We still FILE THE PAPER: the contract is the whole point of
  // the email, and the branch that used to discard it is the branch the owner's
  // scenario actually takes. Filed against the LISTING (documents.listing_id),
  // which is the link `auditListingDocuments` reads, and marked as awaiting the
  // offer it will be linked to when the agent ingests it.
  if (decision === "confirm") {
    const filed = await fileInboundPdfs(svc, {
      brokerageId: input.brokerageId,
      listingId:   match.id,
      offerId:     null,
      contactId:   null,
      pdfs,
      provenance:  { ...provenance, awaiting_offer_link: true },
    })
    try {
      const agentUserId = await resolveListingAgentUser(svc, match.agent_id ?? null)
      if (agentUserId) {
        await svc.from("notifications").insert({
          user_id: agentUserId, brokerage_id: input.brokerageId, type: "offer_intake_review",
          title: "📨 Possible offer received by email",
          body: `An email${input.fromEmail ? ` from ${input.fromEmail}` : ""} looks like an offer for ${match.address}. `
              + (filed.documentIds.length > 0
                 ? `${filed.documentIds.length} document${filed.documentIds.length === 1 ? " is" : "s are"} already filed to the listing's deal file and being read. Confirm the buyer to create the offer and start the seller net-sheet comparison.`
                 : `The attachment could NOT be filed (${filed.errors.join("; ") || "unknown error"}) — open the email and upload it manually.`),
          entity_type: "listing", entity_id: match.id, priority: "high", is_read: false,
        })
      }
    } catch (e) { console.error("[offer-intake] confirm notify failed:", e) }
    return { handled: true, outcome: "confirm", listingId: match.id, documentIds: filed.documentIds }
  }

  // AUTO — store the offer PDF, create the offer (buyer = known sender contact), kick extraction.
  try {
    const pdf = pdfs[0]
    const buf = Buffer.from(pdf.contentB64 as string, "base64")
    const safe = pdf.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    const path = `${input.brokerageId}/${match.id}/${Date.now()}-${safe}`
    const { data: up, error: upErr } = await svc.storage
      .from("offer-documents").upload(path, buf, { contentType: "application/pdf", upsert: false })
    if (upErr || !up) return { handled: false }
    const { signedDocUrl } = await import("@/lib/storage/signed-doc-url")
    const publicUrl = await signedDocUrl(svc, "offer-documents", up.path)
    if (!publicUrl) return { handled: false }

    const { data: offer } = await svc.from("offers").insert({
      listing_id: match.id, contact_id: input.senderContactId, brokerage_id: input.brokerageId,
      agent_id: match.agent_id ?? null,
      offer_price: 0, offer_document_url: publicUrl, offer_document_name: pdf.fileName,
      ai_extraction_status: "pending", offer_type: "standard", current_round: 1,
      // THE ORIGIN, RECORDED. `form_source` is the column that already means
      // "where did this paperwork come from" (live CHECK: portal_upload |
      // dotloop | docusign | skyslope | authentisign | in_app | manual), and this
      // lane left it NULL — so nothing downstream could tell an offer we built
      // from one an outside agent sent. 'manual' is the constraint's value for
      // paperwork our form engine did not produce; no column and no vocabulary
      // value is invented. It is what makes
      // lib/buyer-offer/buyer-signature-evidence.ts:isOutsideOriginated able to
      // answer honestly instead of guessing, and therefore what lets the
      // buyer-signature refusal name the evidence that CAN unblock this deal.
      form_source: "manual",
      metadata: { ...provenance },
      status: "submitted", submitted_at: new Date().toISOString(),
    }).select("id").maybeSingle()
    const offerId = (offer as { id: string } | null)?.id
    if (!offerId) return { handled: false }

    // THE PAPER REACHES THE COUNT. Every PDF in the email is filed into the
    // `documents` ledger keyed to this offer (metadata.linked_offer_id — the key
    // auditOfferDocuments reads) AND to the listing and the buyer contact. The
    // first one is the contract itself and already lives in storage, so its URL
    // is reused rather than uploading the same bytes twice.
    const filed = await fileInboundPdfs(svc, {
      brokerageId: input.brokerageId,
      listingId:   match.id,
      offerId,
      contactId:   input.senderContactId,
      pdfs,
      provenance,
      primaryStorageUrl: publicUrl,
    })
    if (filed.errors.length > 0) {
      console.error(`[offer-intake] offer ${offerId}: ${filed.errors.length} inbound document(s) could not be filed:`, filed.errors.join(" | "))
    }

    // An earlier email from this SAME sender may already have been filed
    // against the listing awaiting an offer (the confirm branch runs whenever
    // the sender was not yet a known contact). Now there is an offer to key it
    // to. The sender is known here, so it is passed as AUTHORITATIVE: another
    // agent's pending paperwork on this listing is a different deal and is left
    // exactly where it is.
    const relinked = await linkInboundDocumentsToOffer({
      brokerageId: input.brokerageId,
      listingId:   match.id,
      offerId,
      contactId:   input.senderContactId,
      fromEmail:   input.fromEmail,
    }, svc)
    if (relinked.errors.length > 0) {
      console.error(`[offer-intake] offer ${offerId}: inbound link errors:`, relinked.errors.join(" | "))
    }

    // Kick AI extraction — on completion it hands off (data_steward → listing_concierge) the
    // comparison-ready offer for the net sheet.
    const { extractOfferFromPdf } = await import("@/lib/offers/offer-extractor")
    void extractOfferFromPdf({ offerId, brokerageId: input.brokerageId, pdfUrl: publicUrl, listingId: match.id }).catch(() => {})
    return { handled: true, outcome: "auto", offerId, listingId: match.id, documentIds: filed.documentIds }
  } catch (e) {
    console.error("[offer-intake] auto-create failed:", e)
    return { handled: false }
  }
}

/**
 * File inbound PDFs into the deal-file ledger through the UNIVERSAL uploader.
 *
 * One helper for the whole class — the contract, the addenda, the disclosures,
 * the pre-approval — because they all have the same problem and the same answer:
 * a `documents` row (so `auditOfferDocuments` can count them) plus the classifier
 * (so they get a `classification`, a summary, extracted fields and a
 * `signature_completeness` reading). `uploadDocument` does both; nothing here
 * re-implements either half.
 *
 * Best-effort PER FILE and never throws: one unreadable attachment must not cost
 * the deal the other four. Every failure is returned, not swallowed — pre-rollout
 * these tables are empty, so "no documents came back" can never be read as health.
 */
async function fileInboundPdfs(
  svc: Svc,
  params: {
    brokerageId: string
    listingId:   string
    offerId:     string | null
    contactId:   string | null
    pdfs:        InboundOfferAttachment[]
    provenance:  Record<string, unknown>
    /** Storage URL of pdfs[0] when the caller already uploaded it. */
    primaryStorageUrl?: string
  },
): Promise<{ documentIds: string[]; errors: string[] }> {
  const documentIds: string[] = []
  const errors: string[] = []

  // ONE PLAN, computed by the pure planner above — so "every attachment is
  // filed" and "nothing is filed as the staged-packet type" are properties of a
  // function a proof can run, not of a loop only production can exercise.
  for (const entry of planInboundFiling(params.pdfs)) {
    const i = entry.index
    const pdf = params.pdfs[i]
    try {
      let storageUrl = i === 0 ? (params.primaryStorageUrl ?? null) : null
      if (!storageUrl) {
        if (!pdf.contentB64) { errors.push(`${pdf.fileName}: no content`); continue }
        const buf = Buffer.from(pdf.contentB64, "base64")
        const safe = pdf.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
        const path = `${params.brokerageId}/${params.listingId}/${Date.now()}-${i}-${safe}`
        const { data: up, error: upErr } = await svc.storage
          .from("offer-documents").upload(path, buf, { contentType: "application/pdf", upsert: false })
        if (upErr || !up) { errors.push(`${pdf.fileName}: storage upload failed (${upErr?.message ?? "no path returned"})`); continue }
        const { signedDocUrl } = await import("@/lib/storage/signed-doc-url")
        storageUrl = await signedDocUrl(svc, "offer-documents", up.path)
        if (!storageUrl) { errors.push(`${pdf.fileName}: could not sign a URL for the stored file`); continue }
      }

      const r = await uploadDocument({
        brokerageId:  params.brokerageId,
        storageUrl,
        fileName:     pdf.fileName,
        // The first attachment is the one the address + offer signals matched on;
        // the rest are the addenda / disclosures / pre-approvals that travel with
        // it. Both are only HINTS — the classifier decides the `classification`
        // the compliance audit actually counts.
        documentType: entry.documentType,
        contactId:    params.contactId,
        offerId:      params.offerId,
        listingId:    params.listingId,
        metadata:     { ...params.provenance, attachment_index: i },
      })
      if (r.success && r.documentId) documentIds.push(r.documentId)
      else errors.push(`${pdf.fileName}: ${r.error ?? "document row not created"}`)
    } catch (e: any) {
      errors.push(`${pdf.fileName}: ${e?.message ?? e}`)
    }
  }

  return { documentIds, errors }
}

export interface InboundLinkResult {
  /** documents.id actually stamped with this offer. */
  linkedDocumentIds: string[]
  /** The plan that was executed — reason, sender, and the ambiguity flag. */
  plan:   InboundOfferLinkPlan
  /** Reads/writes that were REFUSED. Never swallowed: a lost link is silent. */
  errors: string[]
}

/**
 * COMPLETE THE LINK THE CONFIRM BRANCH OPENED.
 *
 * The confirm branch files the outside agent's paperwork against the LISTING and
 * marks it `metadata.awaiting_offer_link`, because no offer row exists yet.
 * Nothing ever finished the job, so those documents counted toward the listing
 * forever and never toward the offer — `auditOfferDocuments` matches
 * `metadata.linked_offer_id`, and the buyer-signature attestation refuses
 * outright without a document on file for THAT offer. This is what turns an
 * emailed contract into paperwork the offer's compliance gate can count.
 *
 * WHAT IS MATCHED, and why it is this narrow:
 *   · this brokerage and this listing (columns, both re-asserted on the WRITE);
 *   · still awaiting a link, and not already linked to some other offer;
 *   · and — the part that matters — only ONE SENDER'S documents, chosen by
 *     `planInboundOfferLink`. Two outside agents can be waiting on the same
 *     listing; stamping both sets would count another deal's paperwork toward
 *     this offer, which is worse than the gap being closed because it PASSES a
 *     gate. When nothing identifies the sender, nothing is linked and the
 *     caller is handed the ambiguity to report.
 *
 * The metadata blob is MERGED, never assigned wholesale — the load-bearing bug
 * of wave 9 (`generateOfferDraft` replaced a document's metadata and destroyed
 * the only key the packet scan could find it by) and the one the wave-10 proof
 * reintroduces as a negative control.
 */
export async function linkInboundDocumentsToOffer(
  params: {
    brokerageId: string
    listingId:   string
    offerId:     string
    /** The buyer contact for the new offer — filled in where the row has none. */
    contactId?:  string | null
    /** AUTHORITATIVE when known: only this sender's documents may be linked. */
    fromEmail?:  string | null
    /** The file the agent just uploaded, which identifies the emailed group. */
    fileName?:   string | null
  },
  client?: Svc,
): Promise<InboundLinkResult> {
  const svc = client ?? createServiceClient()
  const errors: string[] = []

  // `error` is destructured: supabase-js RESOLVES a refused read, so `const
  // { data }` renders "the query was refused" and "nothing is waiting"
  // identically — and pre-rollout these tables are EMPTY, so an empty result is
  // never evidence of health.
  const { data: rows, error: readErr } = await svc
    .from("documents")
    .select("id, metadata, contact_id")
    .eq("brokerage_id", params.brokerageId)
    .eq("listing_id",   params.listingId)
    .filter(`metadata->>${AWAITING_OFFER_LINK_KEY}`, "eq", "true")

  if (readErr) {
    errors.push(`could not read the documents awaiting an offer link: ${readErr.message}`)
    return {
      linkedDocumentIds: [],
      plan: { link: [], sender: null, senders: [], ambiguous: false, reason: "no_pending" },
      errors,
    }
  }

  const pending: PendingInboundDocument[] = (rows ?? []).map((r: any) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return {
      id:            r.id as string,
      fileName:      (meta.file_name as string | null) ?? null,
      fromEmail:     (meta.from_email as string | null) ?? null,
      linkedOfferId: (meta[LINKED_OFFER_ID_KEY] as string | null) ?? null,
    }
  })

  const plan = planInboundOfferLink(pending, {
    preferFromEmail: params.fromEmail ?? null,
    preferFileName:  params.fileName  ?? null,
  })

  const byId = new Map((rows ?? []).map((r: any) => [r.id as string, r]))
  const linkedDocumentIds: string[] = []
  const linkedAt = new Date().toISOString()

  for (const id of plan.link) {
    const row = byId.get(id)
    if (!row) continue
    const existing = ((row.metadata ?? {}) as Record<string, unknown>)
    // The payload, built ABOVE the call rather than inline.
    //
    // Two comments used to live inside the `.update({...})` object literal and
    // pushed `.eq("brokerage_id")` past the 500-character window
    // scripts/tenant-scope-guard.ts examines after a tenant-table `from(...)`
    // call, so a genuinely tenant-scoped write was reported as unscoped. (Do not
    // name that call literally here — the guard scans raw source, so the mention
    // itself would register as a query. That is exactly how this comment failed
    // the guard on its first draft.) The right
    // answer is neither to widen that window nor to bank the finding as
    // baseline debt — both blunt a guard that exists to make cross-tenant reads
    // impossible by CI. Hoisting the payload keeps the query byte-identical and
    // puts the tenant filter back where the guard can see it.
    //
    // metadata is MERGED: every provenance key the confirm branch wrote — the
    // sender, the subject, when it arrived, the attachment index — survives.
    // contact_id is only ever FILLED IN, never overwritten: the buyer is known
    // now, and the confirm branch had nobody to file it under.
    const linkPayload = {
      metadata: {
        ...existing,
        [LINKED_OFFER_ID_KEY]:     params.offerId,
        [AWAITING_OFFER_LINK_KEY]: false,
        offer_linked_at:           linkedAt,
      },
      contact_id: (row.contact_id as string | null) ?? params.contactId ?? null,
      updated_at: linkedAt,
    }
    const { error: updErr, data: updated } = await svc
      .from("documents")
      .update(linkPayload)
      .eq("id", id)
      .eq("brokerage_id", params.brokerageId)
      .eq("listing_id",   params.listingId)
      // Re-asserted on the WRITE so a concurrent ingest cannot link the same
      // paperwork to two offers: the second update matches 0 rows.
      .filter(`metadata->>${LINKED_OFFER_ID_KEY}`, "is", null)
      .select("id")

    if (updErr) { errors.push(`${id}: ${updErr.message}`); continue }
    if ((updated ?? []).length === 0) {
      errors.push(`${id}: already linked to another offer — left untouched`)
      continue
    }
    linkedDocumentIds.push(id)
  }

  return { linkedDocumentIds, plan, errors }
}

async function resolveListingAgentUser(svc: Svc, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (data as { user_id: string | null } | null)?.user_id ?? null
}
