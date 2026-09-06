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

// ── WAVE 12, R1 — THE MAILBOX IS THE AUTHORITY, NOT THE SENDER ──────────────
//
// The webhook already knows whose inbox a message landed in: it resolves a
// per-user credential and holds `agent_user_id`. It THREW THAT AWAY for the
// offer lane and passed only the SENDER — the one identity an outside buyer's
// agent by definition does not have with us. Two consequences, both live:
//
//   · the auto/confirm branch turned entirely on the sender, so the AUTO branch
//     was unreachable for the very scenario this lane exists for; and
//   · the sweep loaded EVERY listing in the brokerage, so an email arriving in
//     agent A's inbox could open an offer on agent B's listing. Nothing checked
//     that the mailbox owner had anything to do with the matched listing.
//
// The mailbox now scopes the sweep. `resolvedCredential.agent_user_id` is a
// `users.id`; `listings.agent_id` is an `agents.id` — DISJOINT spaces, so this
// RESOLVES through lib/kernel/agent-identity.ts and never coalesces one into the
// other.
//
// TWO HONEST LIMITS, PRESERVED RATHER THAN PAPERED OVER:
//   1. The transactional lane (postmark/sendgrid/mailgun/resend) resolves its
//      credential from the To: address and frequently yields no agent. There is
//      then NO mailbox key, and the brokerage-wide address match that works
//      today is kept — with `match_key` in the provenance recording that the
//      match was UNKEYED, so a later reader can tell the two apart.
//   2. The sweep cap is a silent truncation. It is now detected exactly (one row
//      over the cap is requested) and REPORTED — on the provenance, on the
//      result, and loudly in the log when it truncated and nothing matched,
//      which is the case where the cap could have hidden the answer.

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"
import { uploadDocument } from "@/lib/documents/upload-document"
import { putAndSign, removeOrRecordOrphan } from "@/lib/storage/put-and-sign"
import { resolveAgentIdInBrokerage } from "@/lib/kernel/agent-identity"
import {
  looksLikeOffer, matchListingByAddress, assessOfferIntake, planInboundFiling,
  planInboundOfferLink,
  AWAITING_OFFER_LINK_KEY, LINKED_OFFER_ID_KEY,
  MAILBOX_USER_ID_KEY, MAILBOX_ADDRESS_KEY,
  OUTSIDE_LISTING_AGENT_EMAIL_KEY, COUNTERPARTY_REPLY_AT_KEY,
  type ListingLite, type PendingInboundDocument, type InboundOfferLinkPlan,
} from "./offer-detect"

type Svc = ReturnType<typeof createServiceClient>

const OFFER_DOCUMENTS_BUCKET = "offer-documents"
const ACTIVE_LISTING_STATUSES = ["active", "coming_soon", "pending"]
/** The sweep cap. A cap that truncates is reported, never hidden — see the header. */
const LISTING_SWEEP_LIMIT = 300

export interface InboundOfferAttachment { fileName: string; mime: string; contentB64: string | null }

/** WHOSE inbox the message arrived in. Absent on the unkeyed transactional lane. */
export interface InboundMailbox {
  /** platform_credentials.agent_user_id — a `users.id`. */
  userId:  string | null
  /** The mailbox address, for humans reading a notification. */
  address: string | null
}

/** How the listing was matched. The unkeyed value is a fact, not a failure. */
export type OfferMatchKey = "listing_agent_mailbox" | "brokerage_wide_unkeyed"

export interface OfferIntakeResult {
  handled: boolean
  outcome?: "auto" | "confirm"
  offerId?: string
  listingId?: string
  /** documents.id of every inbound PDF filed into the deal-file ledger. */
  documentIds?: string[]
  /** Mailbox-keyed, or the preserved brokerage-wide fallback. */
  matchKey?: OfferMatchKey
  /** The sweep hit its cap: listings beyond it were never examined. */
  listingSweepTruncated?: boolean
  /** Anything that could not be done. Never swallowed — a lost offer is silent. */
  errors?: string[]
}

// The filing PLAN — which attachments are filed and under what document_type —
// is pure, so it lives with the rest of this lane's pure half in
// `./offer-detect.ts:planInboundFiling` where a proof can run it without a
// storage bucket or a database. Nothing here re-decides it.

/**
 * The active-pipeline listings to match an address against, scoped to ONE agent
 * when the mailbox gave us one.
 *
 * `error` is destructured because supabase-js RESOLVES a refused read: without
 * it, "this query was refused" and "this agent has no listings" are the same
 * value, and pre-rollout the table is EMPTY so neither is evidence of health.
 */
async function sweepListings(
  svc: Svc,
  params: { brokerageId: string; agentId: string | null },
): Promise<{ listings: ListingLite[]; truncated: boolean; error: string | null }> {
  let q = svc
    .from("listings")
    .select("id, address, agent_id")
    .eq("brokerage_id", params.brokerageId)
    .in("status", ACTIVE_LISTING_STATUSES)
  if (params.agentId) q = q.eq("agent_id", params.agentId)

  const { data, error } = await q.limit(LISTING_SWEEP_LIMIT + 1)
  if (error) return { listings: [], truncated: false, error: error.message }
  const rows = (data ?? []) as ListingLite[]
  return {
    listings:  rows.slice(0, LISTING_SWEEP_LIMIT),
    truncated: rows.length > LISTING_SWEEP_LIMIT,
    error:     null,
  }
}

export async function tryIngestInboundOffer(
  input: {
    brokerageId: string
    subject: string | null
    bodyText: string | null
    fromEmail: string | null
    /** The resolved buyer contact when the SENDER is a known contact (null for outside agents). */
    senderContactId: string | null
    /** WHOSE inbox this arrived in. The detection authority — see the header. */
    mailbox?: InboundMailbox | null
    attachments: InboundOfferAttachment[]
  },
  client?: Svc,
): Promise<OfferIntakeResult> {
  const svc = client ?? createServiceClient()
  const errors: string[] = []
  const pdfs = input.attachments.filter((a) => a.mime === "application/pdf" && a.contentB64)
  if (pdfs.length === 0) return { handled: false }

  // users.id → agents.id. DISJOINT id spaces: resolved, never coalesced. A
  // mailbox owner with no agents row in this tenant (brokerage staff on the
  // transactional domain) is not a listing agent, so there is nothing to key on
  // and the lane falls back exactly as it does when there is no mailbox at all.
  const mailboxUserId = input.mailbox?.userId ?? null
  const mailboxAgentId = mailboxUserId
    ? await resolveAgentIdInBrokerage(svc as unknown as SupabaseClient, mailboxUserId, input.brokerageId)
    : null
  const matchKey: OfferMatchKey = mailboxAgentId ? "listing_agent_mailbox" : "brokerage_wide_unkeyed"

  const sweep = await sweepListings(svc, { brokerageId: input.brokerageId, agentId: mailboxAgentId })
  if (sweep.error) {
    console.error(`[offer-intake] the listing sweep was REFUSED (${sweep.error}) — failing closed rather than reading it as "no listings"`)
    return { handled: false, matchKey, errors: [`listing sweep refused: ${sweep.error}`] }
  }

  const fileNames = pdfs.map((p) => p.fileName).join(" ")
  const text = [input.subject, input.bodyText, fileNames].filter(Boolean).join(" \n ")
  const isOffer = looksLikeOffer(input.subject, fileNames, input.bodyText)
  const match = matchListingByAddress(text, sweep.listings)

  if (!match) {
    // The mailbox-keyed sweep found nothing. If this is offer-shaped mail, ask
    // ONE diagnostic question — did the address match a listing belonging to a
    // DIFFERENT agent? — because that is the case the owner's ruling forbids and
    // returning silently would hide a genuinely misdirected offer. It creates
    // nothing; the gate below refuses it.
    if (isOffer && mailboxAgentId) {
      const wide = await sweepListings(svc, { brokerageId: input.brokerageId, agentId: null })
      const foreign = wide.error ? null : matchListingByAddress(text, wide.listings)
      if (foreign) {
        const refused = assessOfferIntake({
          looksLikeOffer: true, listingMatched: true,
          mailboxOwnsListing: false,
          senderIsKnownContact: !!input.senderContactId,
        })
        console.warn(
          `[offer-intake] an offer-shaped email for "${foreign.address}" arrived in the mailbox of user ${mailboxUserId} `
        + `(agent ${mailboxAgentId}) but that listing is assigned to agent ${String(foreign.agent_id)} — `
        + `decision "${refused}". The listing agent's own inbox is what this lane watches; forward it to them.`,
        )
        return { handled: false, matchKey, listingSweepTruncated: wide.truncated }
      }
      if (wide.truncated) {
        console.warn(
          `[offer-intake] the brokerage-wide diagnostic sweep TRUNCATED at ${LISTING_SWEEP_LIMIT} listings — `
        + "a listing beyond the cap was never examined, so this 'no match' is not proof there is none.",
        )
      }
    }
    if (sweep.truncated) {
      console.warn(
        `[offer-intake] the listing sweep TRUNCATED at ${LISTING_SWEEP_LIMIT} rows and nothing matched — `
      + `${matchKey === "listing_agent_mailbox" ? `agent ${mailboxAgentId}` : `brokerage ${input.brokerageId}`} `
      + "has more active listings than the cap, so a match may exist beyond it.",
      )
    }
    return { handled: false, matchKey, listingSweepTruncated: sweep.truncated }
  }

  const decision = assessOfferIntake({
    looksLikeOffer: isOffer,
    listingMatched: true,
    // The sweep was scoped to this agent's listings, so a match IS one of theirs.
    // When there was no mailbox key the honest answer is "unknown", which is what
    // keeps the working brokerage-wide path alive instead of refusing it.
    mailboxOwnsListing: mailboxAgentId ? true : null,
    senderIsKnownContact: !!input.senderContactId,
  })
  if (decision === "skip") return { handled: false, matchKey, listingSweepTruncated: sweep.truncated }

  const provenance = {
    intake_source: "inbound_email",
    from_email:    input.fromEmail,
    subject:       input.subject,
    received_at:   new Date().toISOString(),
    // HOW this was matched, recorded on every row it produces. `unkeyed` means
    // the brokerage-wide fallback ran because no mailbox owner could be resolved
    // — a fact a later reader must be able to see, not infer.
    match_key:     matchKey,
    listing_sweep_truncated: sweep.truncated,
    [MAILBOX_USER_ID_KEY]: mailboxUserId,
    [MAILBOX_ADDRESS_KEY]: input.mailbox?.address ?? null,
  }
  if (sweep.truncated) {
    console.warn(
      `[offer-intake] the listing sweep TRUNCATED at ${LISTING_SWEEP_LIMIT} rows while matching ${match.address} — `
    + "the match stands, but a second listing beyond the cap was never compared.",
    )
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
    return {
      handled: true, outcome: "confirm", listingId: match.id, documentIds: filed.documentIds,
      matchKey, listingSweepTruncated: sweep.truncated, errors: filed.errors,
    }
  }

  // AUTO — store the offer PDF, create the offer (buyer = known sender contact), kick extraction.
  try {
    const pdf = pdfs[0]
    const buf = Buffer.from(pdf.contentB64 as string, "base64")
    const safe = pdf.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
    const path = `${input.brokerageId}/${match.id}/${Date.now()}-${safe}`
    // The bytes and the URL are ONE step. Every caller of the old two-step shape
    // guarded by returning AFTER the upload had already landed, so a failure to
    // mint a URL left a buyer's contract in the bucket with no row anywhere and
    // no log line naming it. `putAndSign` compensates — see its header.
    const stored = await putAndSign(svc as unknown as SupabaseClient, {
      bucket: OFFER_DOCUMENTS_BUCKET, path, body: buf,
      contentType: "application/pdf",
      brokerageId: input.brokerageId,
      reason: "inbound_offer_contract",
    })
    if (!stored.ok) {
      errors.push(`${pdf.fileName}: ${stored.error}${stored.orphanRecorded ? " (orphan recorded for sweep)" : ""}`)
      console.error(`[offer-intake] the inbound contract could not be stored: ${stored.error}`)
      return { handled: false, matchKey, listingSweepTruncated: sweep.truncated, errors }
    }
    const publicUrl = stored.signedUrl

    const { data: offer, error: offerErr } = await svc.from("offers").insert({
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
    if (!offerId) {
      // supabase-js RESOLVES a refused write, so this used to read as "no offer"
      // and return silently WITH the contract already in the bucket. The row is
      // what would have owned that object, so with no row the object is undone.
      const why = offerErr?.message ?? "the insert returned no row"
      errors.push(`offer row not created: ${why}`)
      console.error(`[offer-intake] the offer row for ${match.address} was NOT created (${why}) — compensating the stored contract`)
      const undo = await removeOrRecordOrphan(svc as unknown as SupabaseClient, {
        bucket: OFFER_DOCUMENTS_BUCKET, objectPath: stored.path,
        reason: "inbound_offer_row_not_created",
        detail: `the inbound contract uploaded but no offer row could own it: ${why}`,
        brokerageId: input.brokerageId,
      })
      if (!undo.orphanRemoved && !undo.orphanRecorded) {
        errors.push(`the stored contract could not be removed OR recorded: ${undo.orphanUnrecordedReason ?? "unknown"}`)
      }
      return { handled: false, matchKey, listingSweepTruncated: sweep.truncated, errors }
    }

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

    // An earlier email in THIS SAME CONVERSATION may already have been filed
    // against the listing awaiting an offer (the confirm branch runs whenever
    // the sender was not yet a known contact). Now there is an offer to key it
    // to. The mailbox is passed as the boundary and the subject + sender as the
    // conversation: another agent's pending paperwork on this listing, and
    // anything that arrived in a different inbox, is left exactly where it is.
    const relinked = await linkInboundDocumentsToOffer({
      brokerageId: input.brokerageId,
      listingId:   match.id,
      offerId,
      contactId:   input.senderContactId,
      mailboxKey:  mailboxUserId,
      subject:     input.subject,
      fromEmail:   input.fromEmail,
    }, svc)
    if (relinked.errors.length > 0) {
      console.error(`[offer-intake] offer ${offerId}: inbound link errors:`, relinked.errors.join(" | "))
    }

    // Kick AI extraction — on completion it hands off (data_steward → listing_concierge) the
    // comparison-ready offer for the net sheet.
    const { extractOfferFromPdf } = await import("@/lib/offers/offer-extractor")
    void extractOfferFromPdf({ offerId, brokerageId: input.brokerageId, pdfUrl: publicUrl, listingId: match.id }).catch(() => {})
    return {
      handled: true, outcome: "auto", offerId, listingId: match.id, documentIds: filed.documentIds,
      matchKey, listingSweepTruncated: sweep.truncated,
      errors: [...errors, ...filed.errors, ...relinked.errors],
    }
  } catch (e) {
    console.error("[offer-intake] auto-create failed:", e)
    return { handled: false, matchKey, errors: [...errors, String((e as Error)?.message ?? e)] }
  }
}

// ─── R2 — THE OUTBOUND RECIPROCAL, ON THE WAY BACK IN ───────────────────────
//
// Owner's ruling: "if we send an offer out to an outsdie listing agents property
// listing for our buyers, you can check for the returned email from that listing
// agent."
//
// `submit-for-signature.ts` records that agent's address on `offers.metadata`
// when the packet goes out. This is the other half: a reply arriving in OUR
// agent's mailbox FROM that recorded address is this deal's mail.
//
// R1's address match CANNOT do this job. An outside listing has no `listings`
// row — `offers.listing_id` is NULL and the address lives on
// `offers.property_address` — so there is nothing for the sweep to match. The
// recorded counterparty address is the only key that exists.

export interface OutboundReplyResult {
  handled: boolean
  offerId?: string
  documentIds?: string[]
  /** Several watched offers share this counterparty — nothing was routed. */
  ambiguous?: boolean
  errors?: string[]
}

export async function tryRouteOutboundOfferReply(
  input: {
    brokerageId: string
    subject: string | null
    fromEmail: string | null
    /** WHOSE inbox this arrived in. Scopes the match to that agent's own deals. */
    mailbox?: InboundMailbox | null
    attachments: InboundOfferAttachment[]
  },
  client?: Svc,
): Promise<OutboundReplyResult> {
  const svc = client ?? createServiceClient()
  const sender = (input.fromEmail ?? "").trim().toLowerCase()
  if (!sender) return { handled: false }

  const mailboxUserId = input.mailbox?.userId ?? null
  const mailboxAgentId = mailboxUserId
    ? await resolveAgentIdInBrokerage(svc as unknown as SupabaseClient, mailboxUserId, input.brokerageId)
    : null

  let q = svc
    .from("offers")
    .select("id, contact_id, listing_id, property_address, agent_id, metadata")
    .eq("brokerage_id", input.brokerageId)
    .filter(`metadata->>${OUTSIDE_LISTING_AGENT_EMAIL_KEY}`, "eq", sender)
  if (mailboxAgentId) q = q.eq("agent_id", mailboxAgentId)

  const { data, error } = await q.order("created_at", { ascending: false }).limit(3)
  if (error) {
    console.error(`[offer-intake] the outbound-watch lookup was REFUSED (${error.message}) — failing closed`)
    return { handled: false, errors: [`outbound watch lookup refused: ${error.message}`] }
  }

  const watched = (data ?? []) as Array<{
    id: string; contact_id: string | null; listing_id: string | null
    property_address: string | null; agent_id: string | null
    metadata: Record<string, unknown> | null
  }>
  if (watched.length === 0) return { handled: false }
  if (watched.length > 1) {
    // The same listing agent is the counterparty on more than one of our live
    // offers. Guessing which deal a reply belongs to is the mis-link class this
    // lane refuses everywhere else, so it is refused here too.
    console.warn(
      `[offer-intake] ${watched.length} offers are watching ${sender} as the outside listing agent `
    + `(${watched.map(o => o.property_address ?? o.id).join("; ")}) — nothing was routed; the reply falls through to the generic lane.`,
    )
    return { handled: false, ambiguous: true }
  }

  const offer = watched[0]
  const errors: string[] = []
  const receivedAt = new Date().toISOString()
  const pdfs = input.attachments.filter(a => a.mime === "application/pdf" && a.contentB64)

  const filed = pdfs.length > 0
    ? await fileInboundPdfs(svc, {
        brokerageId: input.brokerageId,
        listingId:   offer.listing_id,
        offerId:     offer.id,
        contactId:   offer.contact_id,
        pdfs,
        provenance: {
          intake_source: "inbound_email",
          from_email:    sender,
          subject:       input.subject,
          received_at:   receivedAt,
          match_key:     "outbound_counterparty_reply",
          [MAILBOX_USER_ID_KEY]: mailboxUserId,
          [MAILBOX_ADDRESS_KEY]: input.mailbox?.address ?? null,
        },
      })
    : { documentIds: [] as string[], errors: [] as string[] }
  errors.push(...filed.errors)

  // MERGED, never assigned: a wholesale metadata write here would destroy the
  // very key that made this routing possible, plus anything else on the offer.
  const stampPayload = {
    metadata: {
      ...(offer.metadata ?? {}),
      [COUNTERPARTY_REPLY_AT_KEY]: receivedAt,
      counterparty_last_reply_subject: input.subject,
      counterparty_reply_document_ids: filed.documentIds,
    },
    updated_at: receivedAt,
  }
  const { error: stampErr } = await svc
    .from("offers")
    .update(stampPayload)
    .eq("id", offer.id)
    .eq("brokerage_id", input.brokerageId)
  if (stampErr) errors.push(`could not stamp the reply on the offer: ${stampErr.message}`)

  try {
    const agentUserId = await resolveListingAgentUser(svc, offer.agent_id ?? null)
    if (agentUserId) {
      const { error: notifyErr } = await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: input.brokerageId, type: "offer_intake_review",
        title: "📬 The listing agent replied on your buyer's offer",
        body: `${sender} — the listing agent on ${offer.property_address ?? "the property"} — replied`
            + (input.subject ? ` ("${input.subject}")` : "")
            + (filed.documentIds.length > 0
               ? `, and ${filed.documentIds.length} attachment${filed.documentIds.length === 1 ? " is" : "s are"} filed to this offer's deal file and being read.`
               : " with no attachment. Open the email — a counter or acceptance may be in the body."),
        entity_type: "offer", entity_id: offer.id, priority: "high", is_read: false,
      })
      if (notifyErr) errors.push(`reply notification not written: ${notifyErr.message}`)
    } else {
      errors.push("no user could be resolved for the offer's agent, so nobody was told the counterparty replied")
    }
  } catch (e) {
    errors.push(`reply notification failed: ${String((e as Error)?.message ?? e)}`)
  }

  if (errors.length > 0) console.error(`[offer-intake] offer ${offer.id} counterparty reply:`, errors.join(" | "))
  return { handled: true, offerId: offer.id, documentIds: filed.documentIds, errors }
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
    /** Null on an OUTSIDE listing — there is no listings row to file against. */
    listingId:   string | null
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
  const scope = params.listingId ?? params.offerId ?? "unscoped"

  // ONE PLAN, computed by the pure planner above — so "every attachment is
  // filed" and "nothing is filed as the staged-packet type" are properties of a
  // function a proof can run, not of a loop only production can exercise.
  for (const entry of planInboundFiling(params.pdfs)) {
    const i = entry.index
    const pdf = params.pdfs[i]
    try {
      let storageUrl = i === 0 ? (params.primaryStorageUrl ?? null) : null
      let storedPath: string | null = null
      if (!storageUrl) {
        if (!pdf.contentB64) { errors.push(`${pdf.fileName}: no content`); continue }
        const buf = Buffer.from(pdf.contentB64, "base64")
        const safe = pdf.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
        const path = `${params.brokerageId}/${scope}/${Date.now()}-${i}-${safe}`
        // ONE step, compensated. The old two-step guarded AFTER the bytes had
        // landed, so a failed URL left an outside buyer's disclosure in the
        // bucket with nothing pointing at it.
        const stored = await putAndSign(svc as unknown as SupabaseClient, {
          bucket: OFFER_DOCUMENTS_BUCKET, path, body: buf,
          contentType: "application/pdf",
          brokerageId: params.brokerageId,
          reason: "inbound_offer_attachment",
        })
        if (!stored.ok) {
          errors.push(`${pdf.fileName}: ${stored.error}${stored.orphanRecorded ? " (orphan recorded for sweep)" : ""}`)
          continue
        }
        storageUrl = stored.signedUrl
        storedPath = stored.path
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
      if (r.success && r.documentId) { documentIds.push(r.documentId); continue }

      errors.push(`${pdf.fileName}: ${r.error ?? "document row not created"}`)
      // The ledger row is what would have owned these bytes. Without it the
      // object is unreachable by every reader in the product, so it is undone —
      // unless the caller already owns it (pdfs[0] on the AUTO branch is on the
      // offer row's own column and is compensated there instead).
      if (storedPath) {
        const undo = await removeOrRecordOrphan(svc as unknown as SupabaseClient, {
          bucket: OFFER_DOCUMENTS_BUCKET, objectPath: storedPath,
          reason: "inbound_attachment_row_not_created",
          detail: `an inbound attachment uploaded but no ledger row could own it: ${r.error ?? "unknown"}`,
          brokerageId: params.brokerageId,
        })
        if (!undo.orphanRemoved && !undo.orphanRecorded) {
          errors.push(`${pdf.fileName}: the stored file could not be removed OR recorded (${undo.orphanUnrecordedReason ?? "unknown"})`)
        }
      }
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
 *   · and — the part that matters — only ONE CONVERSATION'S documents, chosen by
 *     `planInboundOfferLink`, inside the MAILBOX the offer is keyed to. Two
 *     outside agents can be waiting on the same listing; stamping both sets
 *     would count another deal's paperwork toward this offer, which is worse
 *     than the gap being closed because it PASSES a gate. When nothing
 *     identifies the group, nothing is linked and the caller is handed the
 *     ambiguity to report.
 *
 * WAVE 12 RE-KEYED THE GROUPING, NOT THE REFUSAL. Wave 11 grouped by the SENDER,
 * which is the identifier this lane does not reliably have (an outside buyer's
 * agent is not our contact) and which has no security property attached. The key
 * is now the mailbox the paperwork arrived in plus the conversation inside it;
 * the ambiguity refusal is untouched and still the point.
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
    /** The mailbox this offer is keyed to — a HARD boundary on what may link. */
    mailboxKey?: string | null
    /** The mail subject, which with the sender names the conversation. */
    subject?:    string | null
    /** The sender, when the caller knows it. A selector now, not the authority. */
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
      // A REFUSED READ, not an empty one. `remaining: 0` here says "we linked
      // nothing and nothing was left over", which is true — the count of what
      // stayed behind is unknowable when the list could not be read at all, and
      // the caller learns that from `errors`, never from these numbers.
      plan: { link: [], sender: null, senders: [], foreignMailbox: 0, remaining: 0, ambiguous: false, reason: "no_pending" },
      errors,
    }
  }

  const pending: PendingInboundDocument[] = (rows ?? []).map((r: any) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return {
      id:            r.id as string,
      fileName:      (meta.file_name as string | null) ?? null,
      fromEmail:     (meta.from_email as string | null) ?? null,
      mailboxKey:    (meta[MAILBOX_USER_ID_KEY] as string | null) ?? null,
      subject:       (meta.subject as string | null) ?? null,
      linkedOfferId: (meta[LINKED_OFFER_ID_KEY] as string | null) ?? null,
    }
  })

  const plan = planInboundOfferLink(pending, {
    mailboxKey:          params.mailboxKey ?? null,
    conversationSubject: params.subject    ?? null,
    preferFromEmail:     params.fromEmail  ?? null,
    preferFileName:      params.fileName   ?? null,
  })
  if (plan.foreignMailbox > 0) {
    console.warn(
      `[offer-intake] offer ${params.offerId}: ${plan.foreignMailbox} pending inbound document(s) on this listing `
    + "arrived in a DIFFERENT mailbox and were excluded — they belong to another agent's deal.",
    )
  }
  // A SPLIT THAT STAYS BEHIND IS NOT A SAFE SPLIT UNLESS SOMEBODY IS TOLD.
  // The conversation key is finer than the sender key on purpose — splitting
  // fails safely, merging fails invisibly — but only if the residue is visible.
  // Pages left on `awaiting_offer_link` never reach this offer's compliance
  // count, which is the exact defect the linker exists to close.
  if (plan.link.length > 0 && plan.remaining > 0) {
    console.warn(
      `[offer-intake] offer ${params.offerId}: ${plan.link.length} document(s) linked, but ${plan.remaining} other `
    + `pending document(s) on this listing were NOT — they are a different conversation (${plan.senders.join("; ")}). `
    + "If they belong to this deal they must be attached from the deal file, or they will never count toward it.",
    )
  }

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

  // THE OFFER COMPLIANCE LOOP RE-ENTERS HERE TOO. These pages were scanned when
  // they ARRIVED (uploadDocument fires scanUploadedDocument), which is before
  // they carried an offer link — so the scanner's own re-entry
  // (lib/documents/scan-uploaded-document.ts, keyed on metadata.linked_offer_id)
  // ran for no offer. Linking is the moment they start counting toward this
  // offer's checklist, and the gate has to be asked again once, for the offer,
  // not once per page. Idle for an offer that is not yet fully executed.
  if (linkedDocumentIds.length > 0) {
    try {
      const { runOfferComplianceLoop } = await import("@/lib/transactions/offer-compliance-loop")
      await runOfferComplianceLoop(svc as any, {
        brokerageId: params.brokerageId,
        offerId:     params.offerId,
        trigger:     "document_uploaded",
        actorUserId: null,
      })
    } catch (err) {
      console.error("[offer-intake] offer compliance loop failed (non-fatal):", (err as Error).message)
    }
  }

  return { linkedDocumentIds, plan, errors }
}

async function resolveListingAgentUser(svc: Svc, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (data as { user_id: string | null } | null)?.user_id ?? null
}
