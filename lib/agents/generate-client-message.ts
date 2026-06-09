/**
 * lib/agents/generate-client-message.ts
 *
 * Wave 58 — THE canonical way the managers draft a client-facing message. This app's
 * strategy is AI-GENERATED, personalized, brand-voiced communication — never canned
 * scripts. Every deliverable-gated producer (testimonial, tour follow-up, offer
 * strategy, buyer welcome, …) routes its copy through here so it is:
 *   1. personalized by the model (Vercel AI Gateway) in the agent/brokerage VOICE
 *      (resolveBrandContext → displayName + tone), THEM-FIRST,
 *   2. compliance-gated with ONE targeted redraft (runWithComplianceRedraft + the
 *      shared Fair-Housing guard) so a steering/price slip becomes a corrected draft,
 *   3. signed off as the contact's own agent (so they know who it's from),
 *   4. resilient — if the gateway is unavailable or both drafts fail the gate, it falls
 *      back to a neutral template; the human still reviews/edits it in the gate before
 *      anything sends. Nothing canned reaches a client un-reviewed.
 *
 * Server-only (uses the AI gateway + brand resolver). Never throws — failure → fallback.
 */
import "server-only"
import { generateTextRouted } from "@/lib/ai/models"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"
import { hasFairHousingViolation, sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export interface ClientMessageBrief {
  brokerageId:       string
  agentUserId?:      string | null
  teamId?:           string | null
  audience:          "buyer" | "seller" | "lead"
  /** Plain-language goal of the message (e.g. "request a review after closing"). */
  purpose:           string
  recipientFirstName?: string | null
  /** Concrete facts the model may weave in (no demographics). */
  facts?:            Array<{ label: string; value: string }>
  /** Concrete next steps to offer. */
  ctas?:             string[]
  /** Whether the model may state specific prices/figures (default false → never invent numbers). */
  allowNumbers?:     boolean
  /** Neutral resilience copy used only when generation/compliance fails. */
  fallback:          { subject: string; body: string }
}

export interface GeneratedClientMessage { subject: string; body: string; generated: boolean }

const PRICE_FIGURE = /\$\s?\d|\b\d{3,}\s?(?:k|grand)\b/i

function buildPrompt(brief: ClientMessageBrief, brandName: string, signoff: string): string {
  const factLines = (brief.facts ?? []).filter((f) => f.value).map((f) => `- ${f.label}: ${f.value}`).join("\n")
  const ctaLines  = (brief.ctas ?? []).map((c) => `- ${c}`).join("\n")
  return `You are ${brandName}, a real estate professional, writing a SHORT personal message to YOUR ${brief.audience}${brief.recipientFirstName ? ` (first name: ${brief.recipientFirstName})` : ""}.

GOAL: ${brief.purpose}

Return ONLY valid JSON: {"subject": "...", "body": "..."} — no markdown, no extra text.

Non-negotiable rules:
- THEM-FIRST: 60%+ "you/your" vs "I/we/our". Warm, specific, conversational — like an agent who knows them.
- subject: 4-9 words, specific, not generic or salesy.
- body: 45-90 words. End by signing off exactly as: — ${signoff}
- ZERO Fair Housing risk: never reference or imply race, color, religion, sex, familial status (kids/families), national origin, disability, age, or sexual orientation; never "perfect for", "great for families", "safe neighborhood", "good schools", "Christian community", "adults only".
- ZERO pushy phrasing: no "act now", "limited time", "don't miss out".
- NEVER guarantee a price, appraisal, ROI, or sale outcome.${brief.allowNumbers ? "" : "\n- NEVER state a specific price, dollar amount, or numeric estimate — the agent fills those in during review."}
${factLines ? `\nFacts you may use (optional, no demographics):\n${factLines}` : ""}
${ctaLines ? `\nOffer these concrete next steps:\n${ctaLines}` : ""}

Return the JSON now.`
}

function parseSubjectBody(text: string): { subject: string; body: string } | null {
  try {
    let s = text.trim()
    if (s.startsWith("```json")) s = s.slice(7)
    if (s.startsWith("```")) s = s.slice(3)
    if (s.endsWith("```")) s = s.slice(0, -3)
    const obj = JSON.parse(s.trim()) as { subject?: unknown; body?: unknown }
    const subject = typeof obj.subject === "string" ? obj.subject.trim() : ""
    const body    = typeof obj.body === "string" ? obj.body.trim() : ""
    if (!subject || !body) return null
    return { subject, body }
  } catch { return null }
}

export async function generateClientMessage(brief: ClientMessageBrief): Promise<GeneratedClientMessage> {
  try {
    const brand = await resolveBrandContext({
      brokerageId: brief.brokerageId, teamId: brief.teamId ?? null, agentUserId: brief.agentUserId ?? null,
    }).catch(() => null)
    const brandName = sanitizeProperNoun(brand?.displayName, 60) ?? "Your Agent"
    const prompt = buildPrompt(brief, brandName, brandName)

    const result = await runWithComplianceRedraft({
      draft: async ({ violations }) => {
        const fb = violations.length ? `\n\nYour previous draft violated these — fix EACH: ${violations.join("; ")}` : ""
        const { text } = await generateTextRouted({
          feature: "client_message", brokerageId: brief.brokerageId,
          prompt: prompt + fb, temperature: violations.length ? 0.4 : 0.7, maxTokens: 400,
        })
        return text
      },
      gate: async (text) => {
        const v: string[] = []
        if (hasFairHousingViolation(text)) v.push("protected-class / steering language")
        if (!brief.allowNumbers && PRICE_FIGURE.test(text)) v.push("stated a specific price/number — remove all figures")
        return { allowed: v.length === 0, violations: v }
      },
    })

    if (!result.ok) return { ...brief.fallback, generated: false }
    const parsed = parseSubjectBody(result.script)
    if (!parsed) return { ...brief.fallback, generated: false }
    return { subject: parsed.subject, body: parsed.body, generated: true }
  } catch {
    return { ...brief.fallback, generated: false }
  }
}
