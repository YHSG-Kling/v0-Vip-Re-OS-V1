"use server"

/**
 * Generate AI landing-page copy + deliverable copy for a lead magnet / home-value page — BUILT from
 * what buyers/sellers are ACTUALLY asking (content-topics from the gated web-search rail), not
 * boilerplate. Falls back to the safe deterministic copy when search/AI is unavailable. Marketing copy
 * only — separate from the kernel-owned portal view/education. Fair-Housing-safe (topics pre-filtered).
 *
 * Wave 142 (lane 142E): the finished page copy (headline / subhead / bullets / FAQ) runs the PUBLIC-COPY
 * FAIR-HOUSING REWRITE LOOP (lib/kernel/marketing/public-copy-rewrite.ts) — a flag goes back to the ROUTED
 * lane (feature lead_magnet_draft, booked under the session's tenant) with the specific findings, is
 * rechecked, capped at two rewrites, then falls back to the deterministic baseline and ESCALATES to the
 * human in the builder. The tenant + actor come from the session (getAgentContext), never the input.
 */

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { landingPageCopy, landingPageCopyFromTopics, magnetDeliverableCopy, prepareMagnetDeliverable, magnetHasDeliverable, type MagnetType, type LandingCopy, type MagnetDeliverable } from "@/lib/marketing/lead-magnet-copy"

const VALID: MagnetType[] = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]

export async function generateLeadMagnetCopyAction(input: { magnetType: string; area?: string | null; brand?: string | null }): Promise<{
  success: boolean
  landing?: LandingCopy & { fromTopics?: boolean }
  deliverable?: MagnetDeliverable | null
  topics?: string[]
  /** the AI-visibility FAQ (real questions + answers) + its schema.org JSON-LD for the page <head>. */
  faq?: Array<{ question: string; answer: string }>
  faqJsonLd?: string | null
  /** Wave 142: the rewrite loop's outcome on the page copy — rewrites run, whether a human now owns it, the findings. */
  fairHousing?: { rewrites: number; escalated: boolean; findings: string[] }
  error?: string
}> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "unauthorized" }
  const brokerageId = ctx.brokerageId
  const userId = ctx.userId ?? null
  return ledgered(ctx, { action: "marketing.lead_magnet_copy.generate", subject: { type: "lead_magnet", ref: input.magnetType }, riskClass: "LOW_RISK_WRITE" }, async () => {

  const magnetType: MagnetType = VALID.includes(input.magnetType as MagnetType) ? (input.magnetType as MagnetType) : "generic_form"
  const copyCtx = { area: input.area ?? null, brand: input.brand ?? null }

  // Pull what people are actually asking, then AI-write the copy grounded in it (platform-covered research,
  // attributed to this tenant — wave 139C).
  const { fetchContentTopics } = await import("@/lib/marketing/content-topics-runner")
  const topics = await fetchContentTopics(magnetType, input.area ?? null, { brokerageId }).catch(() => [])
  const { realCopyGenerator } = await import("@/lib/kernel/ai-copy")

  let landing = await landingPageCopyFromTopics(magnetType, topics, copyCtx, { copyGenerator: realCopyGenerator })
  const deliverable = magnetHasDeliverable(magnetType)
    ? await prepareMagnetDeliverable(magnetType, copyCtx, { topics, copyGenerator: realCopyGenerator })
    : null

  // AI-VISIBILITY (GEO) — turn the real questions into a FAQ + schema.org FAQPage JSON-LD so the page
  // gets cited by AI search (ChatGPT / Perplexity / Gemini / Google AI Overviews), not just indexed.
  const { buildFaqFromTopics, faqJsonLdScript } = await import("@/lib/marketing/geo-faq")
  let faq = await buildFaqFromTopics(topics, magnetType, copyCtx, { copyGenerator: realCopyGenerator })

  // THE REWRITE LOOP on everything the visitor reads.
  const { rewritePublicCopyUntilCompliant, renderFindingsForRewrite } = await import("@/lib/kernel/marketing/public-copy-rewrite")
  const pageText = (l: LandingCopy, f: Array<{ question: string; answer: string }>) => [l.headline, l.subhead, l.cta, ...l.bullets, ...f.flatMap((x) => [x.question, x.answer])].join("\n")
  let latestLanding = landing
  let latestFaq = faq
  // Wave 143 (lane 143F): a "55+ / senior living" claim on the page is verified against the session tenant's recorded
  // older-persons exemption (42 U.S.C. § 3607(b)) — a held claim is rewritten around with the reason, then a human decides.
  const { loadOlderPersonsVerifications } = await import("@/lib/compliance/fair-housing-older-persons-store")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const olderPersons = await loadOlderPersonsVerifications(createServiceClient(), brokerageId)
  const loop = await rewritePublicCopyUntilCompliant({
    text: pageText(landing, faq),
    surface: "landing_page",
    brokerageName: input.brand ?? null,
    olderPersons,
    rewrite: async (_text, findings) => {
      const { generateTextRouted } = await import("@/lib/ai/models")
      const { text } = await generateTextRouted({
        feature: "lead_magnet_draft",
        brokerageId,
        userId,
        prompt:
          `Rewrite this ${magnetType.replace(/_/g, " ")} landing page so EVERY fair-housing finding below is resolved — describe the home, the process and the service, never who should want it. Same offer, same structure.\n\n` +
          `Current page:\n${JSON.stringify({ headline: latestLanding.headline, subhead: latestLanding.subhead, cta: latestLanding.cta, bullets: latestLanding.bullets, faq: latestFaq })}\n\n` +
          `Findings:\n${renderFindingsForRewrite(findings)}\n\nRespond with ONLY a JSON object {"headline","subhead","cta","bullets":[],"faq":[{"question","answer"}]}.`,
        maxTokens: 900,
      })
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return null
      const parsed = JSON.parse(m[0]) as Partial<LandingCopy> & { faq?: Array<{ question?: string; answer?: string }> }
      if (typeof parsed.headline !== "string" || typeof parsed.subhead !== "string") return null
      latestLanding = { ...latestLanding, headline: parsed.headline, subhead: parsed.subhead, cta: typeof parsed.cta === "string" ? parsed.cta : latestLanding.cta, bullets: Array.isArray(parsed.bullets) ? parsed.bullets.map(String).slice(0, 4) : latestLanding.bullets }
      latestFaq = Array.isArray(parsed.faq) ? parsed.faq.filter((f): f is { question: string; answer: string } => typeof f?.question === "string" && typeof f?.answer === "string").slice(0, 6) : latestFaq
      return pageText(latestLanding, latestFaq)
    },
  })
  if (loop.ok) {
    landing = { ...latestLanding, fromTopics: landing.fromTopics }
    faq = latestFaq
  } else {
    // ESCALATED: the deterministic baseline (Fair-Housing-safe by construction) stands in; the builder shows the findings.
    landing = { ...landingPageCopy(magnetType, copyCtx), fromTopics: false }
    faq = []
  }

  return {
    success: true,
    landing,
    deliverable: deliverable ?? (magnetHasDeliverable(magnetType) ? magnetDeliverableCopy(magnetType, copyCtx) : null),
    topics: topics.map((t) => t.topic),
    faq,
    faqJsonLd: faq.length ? faqJsonLdScript(faq, { brand: input.brand ?? null }) : null,
    fairHousing: { rewrites: loop.rewrites, escalated: loop.escalated, findings: loop.findings.map((f) => f.phrase) },
  }
  })
}

/**
 * WAVE 155 (lane 155R9, G12): ONE agent_action_ledger receipt per session write — ledgerSessionAction
 * (lib/kernel/action-ledger.ts) does the claim → run → settle. Who and which tenant come from the SESSION (CLAUDE.md §4);
 * "session" resolves them through getAgentContext. NO idempotency key: a person's second save runs again and leaves a
 * second receipt. The export's value comes back unchanged; a refused claim (only a malformed action name, caught by
 * test:action-ledger §14) throws instead of returning a value of another shape. No session tenant → the write runs exactly
 * as before, unrecorded (agent_action_ledger.brokerage_id is NOT NULL — there is no valid row to write).
 * @proofSeam scripts/ledger-receipts-transaction2-guard.ts
 */
async function ledgered<T>(
  who: { userId?: string | null; brokerageId?: string | null; agentId?: string | null } | null | undefined | "session",
  what: { action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const seat = who === "session" ? await (await import("@/lib/identity/get-agent-context")).getAgentContext() : who
  if (!seat?.userId || !seat.brokerageId) return run()
  const id = what.subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(what.subject.id) ? what.subject.id : null
  const subject = { type: what.subject.type, id, ref: id ? what.subject.ref ?? null : what.subject.ref ?? what.subject.id ?? null }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: seat.brokerageId, action: what.action, actor: { type: "user", userId: seat.userId, agentId: seat.agentId ?? null }, subject, riskClass: what.riskClass, reasonCode: "HUMAN_REQUESTED", detail: what.detail ?? null }, async () => { ran = true; return run() })
  if (!ran) throw new Error((r as { error?: string }).error ?? "action ledger refused the claim")
  return r as T
}
