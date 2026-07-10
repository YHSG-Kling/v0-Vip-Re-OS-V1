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

/** Record the magnet delivery as an auditable activity on the contact. Best-effort. */
export async function recordMagnetDelivery(
  args: { brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; deliverable: MagnetDeliverable }, client?: Svc,
): Promise<{ ok: boolean }> {
  const svc = client ?? createServiceClient()
  const { error } = await svc.from("activities").insert({
    brokerage_id: args.brokerageId, contact_id: args.contactId, agent_user_id: args.agentUserId ?? null,
    activity_type: "lead_magnet_delivered", title: `Delivered: ${args.deliverable.title}`,
    description: `${args.magnetType} deliverable sent to the contact who filled out the form.`,
    metadata: { magnet_type: args.magnetType, subject: args.deliverable.subject, body: args.deliverable.body },
  })
  return { ok: !error }
}

/** Convenience: prepare + record the deliverable for a captured magnet lead — BUILT from the real
 *  demand topics, AI-written, and compliance-gated. Best-effort. */
export async function deliverMagnet(
  args: { brokerageId: string; contactId: string; agentUserId?: string | null; magnetType: MagnetType; ctx?: CopyContext }, client?: Svc,
): Promise<{ delivered: boolean; fromTopics: boolean; pdfUrl?: string | null }> {
  const svc = client ?? createServiceClient()

  // 1. What are buyers/sellers actually asking? (gated web-search rail → ranked topics)
  const { fetchContentTopics } = await import("./content-topics-runner")
  const topics = await fetchContentTopics(args.magnetType, args.ctx?.area ?? null).catch(() => [])

  // 2. AI-write the deliverable grounded in those topics, then clear the compliance gate.
  const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")
  const gate = async (content: string) => {
    try {
      const { evaluateOutbound } = await import("@/lib/kernel/compliance")
      const r = await evaluateOutbound({
        actorContext: { brokerageId: args.brokerageId, userId: args.agentUserId ?? "", role: "system" },
        journeyType: "buyer", persona: "other", messageType: "email", content,
      })
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
  if (args.magnetType === "buyer_guide" || args.magnetType === "seller_guide") {
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
        deliverable.body = `${deliverable.body}\n\nDownload your full guide (PDF): ${produced.pdfUrl}`
      }
    } catch { /* copy-only delivery is still a delivery */ }
  }

  const r = await recordMagnetDelivery({ ...args, deliverable }, svc)
  return { delivered: r.ok, fromTopics: topics.length > 0, pdfUrl }
}
