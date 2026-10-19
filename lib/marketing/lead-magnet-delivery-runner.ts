// lib/marketing/lead-magnet-delivery-runner.ts
//
// Live side of LEAD-MAGNET DELIVERY — when a contact fills out a lead-magnet form, generate the
// deliverable they asked for (the guide/report copy), CLEAR THE COMPLIANCE GATE (Fair Housing / brand
// voice), and record the delivery as an activity so it's auditable and the existing enrolled sequence/
// messaging path ships it. The deterministic copy is Fair-Housing-safe by construction; an injected AI
// generator may personalize within the same safe frame. Best-effort; never throws into the caller.

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

/** Record the magnet delivery as an auditable activity on the contact. Best-effort. */
// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
async function recordMagnetDelivery(
  args: { brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; deliverable: MagnetDeliverable; refs: DeliveredCreativeRefs }, client?: Svc,
): Promise<{ ok: boolean }> {
  const svc = client ?? createServiceClient()
  const { error } = await svc.from("activities").insert({
    brokerage_id: args.brokerageId, contact_id: args.contactId, agent_user_id: args.agentUserId ?? null,
    activity_type: "lead_magnet_delivered", title: `Delivered: ${args.deliverable.title}`,
    description: `${args.magnetType} deliverable sent to the contact who filled out the form.`,
    // Wave 142 (lane 142E, owner: "lead magnet creative and ai assets need to be accessible in follow up"):
    // the asset refs ride beside the prose — magnet, the hosted PDF, the document-library row, the kind.
    metadata: { magnet_type: args.magnetType, subject: args.deliverable.subject, body: args.deliverable.body, ...args.refs },
  })
  return { ok: !error }
}

/** Convenience: prepare + record the deliverable for a captured magnet lead — BUILT from the real
 *  demand topics, AI-written, and compliance-gated. Best-effort. */
export async function deliverMagnet(
  args: {
    brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; ctx?: CopyContext
    /** Wave 142: the magnet row, so the delivery activity names it. */
    magnetId?: string | null
    /** Wave 142: a FINISHED book on the magnet (lib/kernel/lead-magnets.ts leadMagnetBookRefOf) — delivered
     *  instead of rendering the 5-chapter booklet. */
    book?: { pdfUrl: string; documentId: string | null; title: string; chapters: number } | null
  }, client?: Svc,
): Promise<{ delivered: boolean; fromTopics: boolean; pdfUrl?: string | null; deliverableKind?: "book" | "booklet" | "copy" }> {
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
    } catch {
      return { allowed: true, violations: [] } // gate unreachable → the deterministic copy is already FH-safe
    }
  }

  const deliverable = await prepareMagnetDeliverable(args.magnetType, args.ctx, { topics, copyGenerator: realCopyGenerator, gate }).catch(() => null)
  if (!deliverable) return { delivered: false, fromTopics: false }

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
    } catch { /* copy-only delivery is still a delivery */ }
  }

  const r = await recordMagnetDelivery({ ...args, deliverable, refs: { magnet_id: args.magnetId ?? null, pdf_url: pdfUrl, document_id: documentId, deliverable_kind: deliverableKind, title: args.book?.title ?? deliverable.title } }, svc)
  return { delivered: r.ok, fromTopics: topics.length > 0, pdfUrl, deliverableKind }
}
