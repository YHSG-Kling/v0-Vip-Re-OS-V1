// lib/marketing/lead-magnet-delivery-runner.ts
//
// Live side of LEAD-MAGNET DELIVERY — when a contact fills out a lead-magnet form, PREPARE the
// deliverable they asked for (the guide/report copy, the designed booklet PDF, or the finished book's
// hosted PDF) and CLEAR THE COMPLIANCE GATE (Fair Housing / brand voice). The deterministic copy is
// Fair-Housing-safe by construction; an injected AI generator may personalize within the same safe
// frame. Best-effort; never throws into the caller.
//
// WAVE 146 (lane 146F — owner ruling 10, contract C4): PREPARING IS NOT DELIVERING. This module used to
// write the `lead_magnet_delivered` activity the moment the COPY was prepared — before anything was sent,
// and also when a guide's booklet failed to render ("copy-only delivery is still a delivery"). Nothing
// ever sent it: the activity told the AI ISA "Delivered" for a guide nobody received. Now
// prepareMagnetDelivery only PREPARES (and says which asset exists), and recordMagnetDelivery is called by
// THE PROMISE LEDGER (lib/lead-magnets/promised-deliverables.ts deliverPromised) only AFTER the asset was
// verified and a permitted channel accepted it. The tombstone for the old one-step deliverMagnet is below.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { prepareMagnetDeliverable, type MagnetType, type CopyContext, type MagnetDeliverable } from "./lead-magnet-copy"

type Svc = ReturnType<typeof createServiceClient>

export { prepareMagnetDeliverable }

/** The creative a capture delivered — recorded WITH the activity so follow-up (the AI ISA's activity readers,
 *  the context spine, the sequence steps) can reference the exact asset, never only its prose. */
interface DeliveredCreativeRefs {
  magnet_id: string | null
  pdf_url: string | null
  document_id: string | null
  /** "book" when a finished AI-written book shipped, "booklet" for the designed 5-chapter PDF, "copy" otherwise. */
  deliverable_kind: "book" | "booklet" | "copy"
  title: string
}

/** Record the VERIFIED magnet delivery as an auditable activity on the contact (the AI ISA's timeline reads it —
 *  lib/ai-isa/customer-context-tools.ts deliveredAssets). Called ONLY by the promise ledger after the asset went out
 *  (lib/lead-magnets/promised-deliverables.ts deliverPromised); its error is returned, never swallowed. */
export async function recordMagnetDelivery(
  args: { brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; deliverable: MagnetDeliverable; refs: DeliveredCreativeRefs & { promise_id?: string | null; delivered_via?: string | null } }, client?: Svc,
): Promise<{ ok: boolean; error?: string }> {
  const svc = client ?? createServiceClient()
  const { error } = await svc.from("activities").insert({
    brokerage_id: args.brokerageId, contact_id: args.contactId, agent_user_id: args.agentUserId ?? null,
    activity_type: "lead_magnet_delivered", title: `Delivered: ${args.deliverable.title}`,
    description: `${args.magnetType} deliverable sent to the contact who filled out the form.`,
    // Wave 142 (lane 142E, owner: "lead magnet creative and ai assets need to be accessible in follow up"):
    // the asset refs ride beside the prose — magnet, the hosted PDF, the document-library row, the kind.
    metadata: { magnet_type: args.magnetType, subject: args.deliverable.subject, body: args.deliverable.body, ...args.refs },
  })
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** What prepareMagnetDelivery hands the promise ledger: the copy (null when the compliance gate held it), the asset that
 *  exists (the hosted PDF + its document-library row, or none) and the refs the delivery activity will carry. */
export interface PreparedMagnetDelivery {
  deliverable: MagnetDeliverable | null
  fromTopics: boolean
  pdfUrl: string | null
  documentId: string | null
  deliverableKind: "book" | "booklet" | "copy"
  refs: DeliveredCreativeRefs
  /** Why nothing could be prepared (the compliance gate held the copy), when it could not. */
  heldReason?: string
}

// TOMBSTONE (wave 146, lane 146F): `deliverMagnet` — prepare + record "lead_magnet_delivered" in one step, with NO send — is
// split. Its preparation half survives below as prepareMagnetDelivery (same steps, same booklet / book handling, same gate);
// its record half is recordMagnetDelivery above, now called only after a verified delivery by
// lib/lead-magnets/promised-deliverables.ts deliverPromised, which also SENDS (email through dispatchEmail, the portal card)
// and refuses to call a promise delivered without its asset. Its one caller (lib/kernel/lead-magnets.ts captureFormSubmission)
// records the promise and calls deliverPromised instead.

/** PREPARE the deliverable for a captured magnet lead — BUILT from the real demand topics, AI-written, and
 *  compliance-gated. Records nothing and sends nothing (the promise ledger does both). Best-effort; never throws. */
export async function prepareMagnetDelivery(
  args: {
    brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; ctx?: CopyContext
    /** Wave 142: the magnet row, so the delivery activity names it. */
    magnetId?: string | null
    /** Wave 142: a FINISHED book on the magnet (lib/kernel/lead-magnets.ts leadMagnetBookRefOf) — delivered
     *  instead of rendering the 5-chapter booklet. */
    book?: { pdfUrl: string; documentId: string | null; title: string; chapters: number } | null
  }, client?: Svc,
): Promise<PreparedMagnetDelivery> {
  const svc = client ?? createServiceClient()

  // 1. What are buyers/sellers actually asking? (gated web-search rail → ranked topics)
  const { fetchContentTopics } = await import("./content-topics-runner")
  const topics = await fetchContentTopics(args.magnetType, args.ctx?.area ?? null, { brokerageId: args.brokerageId }).catch(() => [])

  // 2. AI-write the deliverable grounded in those topics, then clear the compliance gate.
  const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")
  const gate = async (content: string) => {
    try {
      const { evaluateOutbound } = await import("@/lib/kernel/compliance")
      const r = await evaluateOutbound({
        actorContext: { brokerageId: args.brokerageId, userId: args.agentUserId ?? "", role: "system" },
        journeyType: "buyer", persona: "other", messageType: "email", content,
      }, { client: svc })
      return { allowed: r.allowed, violations: r.violations }
    } catch (e) {
      // FAIL CLOSED (CLAUDE.md §4): a gate that cannot run refuses — a delivery is held and the reason is said, never
      // "checked and fine". The deterministic copy being FH-safe is an argument, not a check that ran.
      return { allowed: false, violations: [`compliance gate unreachable — delivery held: ${e instanceof Error ? e.message : String(e)}`] }
    }
  }

  let gateHeld: string | null = null
  const heldGate = async (content: string) => {
    const r = await gate(content)
    if (!r.allowed) gateHeld = r.violations.join("; ") || "the compliance gate refused the copy"
    return r
  }
  const deliverable = await prepareMagnetDeliverable(args.magnetType, args.ctx, { topics, copyGenerator: realCopyGenerator, gate: heldGate }).catch(() => null)
  if (!deliverable) {
    return {
      deliverable: null, fromTopics: false, pdfUrl: null, documentId: null, deliverableKind: "copy",
      refs: { magnet_id: args.magnetId ?? null, pdf_url: null, document_id: null, deliverable_kind: "copy", title: args.book?.title ?? args.magnetType },
      heldReason: gateHeld ?? `no deliverable copy for a ${args.magnetType} magnet`,
    }
  }

  // 3. Guide magnets get the DESIGNED BOOKLET: a real branded PDF (cover +
  //    chapters + agent attribution) hosted on our storage, with the download
  //    link appended to the delivery copy. The AI/topic-grounded copy above is
  //    the booklet intro; the evergreen chapters are the durable spine.
  //    Best-effort — the copy still delivers if the PDF render hiccups.
  let pdfUrl: string | null = null
  let documentId: string | null = null
  let deliverableKind: "book" | "booklet" | "copy" = "copy"
  if (args.book?.pdfUrl) {
    // THE BOOK (wave 142): the human-approved, AI-written book the magnet carries — already rendered, hosted
    // and recorded in the document library by the book pipeline. No render here; the link ships.
    pdfUrl = args.book.pdfUrl
    documentId = args.book.documentId
    deliverableKind = "book"
    deliverable.body = `${deliverable.body}\n\nDownload your copy of "${args.book.title}" (PDF, ${args.book.chapters} chapters): ${args.book.pdfUrl}`
  } else if (args.magnetType === "buyer_guide" || args.magnetType === "seller_guide") {
    try {
      const { resolvePdfBrand, produceClientDocument } = await import("@/lib/documents/client-document-producer")
      const { guideBookletSpec } = await import("@/lib/documents/client-pdf")
      const { generateGuideChapters } = await import("./guide-booklet-content")
      const brand = await resolvePdfBrand(svc, { brokerageId: args.brokerageId, agentUserId: args.agentUserId })
      const dateLabel = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })
      // Chapters are AI-written (grounded in the same demand topics as the
      // copy, gated) — the evergreen set is only the fallback floor.
      const { chapters } = await generateGuideChapters(args.magnetType, {
        topics: topics.map((t) => t.topic),
        area: args.ctx?.area ?? null,
        gate: async (text) => {
          const g = await gate(text)
          return { allowed: g.allowed }
        },
      })
      const spec = guideBookletSpec({
        kind: args.magnetType,
        title: deliverable.title,
        intro: deliverable.body,
        chapters,
        areaLabel: args.ctx?.area ?? null,
      }, brand, dateLabel)
      const produced = await produceClientDocument(svc, {
        brokerageId: args.brokerageId,
        agentUserId: args.agentUserId,
        contactId: args.contactId,
        documentType: args.magnetType,
        spec,
        metadata: { source: "lead_magnet_delivery" },
      })
      if (produced.ok && produced.pdfUrl) {
        pdfUrl = produced.pdfUrl
        documentId = produced.documentId
        deliverableKind = "booklet"
        deliverable.body = `${deliverable.body}\n\nDownload your full guide (PDF): ${produced.pdfUrl}`
      }
    } catch (e) {
      // WAVE 146: a guide whose booklet did not render is NOT delivered with its cover note — deliverableKind stays "copy"
      // and the promise ledger records the guide as MISSING (retried, then escalated), never as sent.
      console.warn(`[lead-magnet-delivery] booklet render failed for ${args.magnetType}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    deliverable, fromTopics: topics.length > 0, pdfUrl, documentId, deliverableKind,
    refs: { magnet_id: args.magnetId ?? null, pdf_url: pdfUrl, document_id: documentId, deliverable_kind: deliverableKind, title: args.book?.title ?? deliverable.title },
  }
}
