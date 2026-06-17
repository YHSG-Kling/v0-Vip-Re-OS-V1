// lib/marketing/geo-faq.ts
//
// GEO / AI-VISIBILITY (pure) — copy only gets cited by AI search (ChatGPT, Perplexity, Gemini, Google
// AI Overviews) when it's STRUCTURED as the answer to a real question, with schema.org markup the
// crawlers ingest. content-topics already gives us the REAL questions buyers/sellers ask; this turns
// the top ones into a FAQ (question + a concise, declarative, agent-authored answer) and emits a
// schema.org FAQPage JSON-LD block — the single highest-leverage thing for getting the page picked up
// by AI search. Fair-Housing-safe (topics are pre-filtered; the runner still gates the answers). Pure.

import type { ContentTopic } from "./content-topics"

export interface FaqItem {
  question: string
  answer: string
}

const QUESTION_OPENER = /^(how|what|when|where|why|should|can|do|does|is|are|will|would|which|who)\b/i

/** Make a topic read as a question (the AI search engines reward clean Q&A). Pure. */
function asQuestion(topic: string): string {
  const t = topic.trim().replace(/\s+/g, " ")
  if (t.endsWith("?")) return t.charAt(0).toUpperCase() + t.slice(1)
  if (QUESTION_OPENER.test(t)) return `${t.charAt(0).toUpperCase() + t.slice(1)}?`
  return `What should I know about ${t.replace(/[.?!]+$/, "").toLowerCase()}?`
}

/** A safe, declarative fallback answer when no AI generator is available. Real, FH-safe, never a stub. */
function fallbackAnswer(): string {
  return "A local expert can walk you through this in plain language, tailored to your situation and your market — reach out any time and we'll give you a straight answer with no pressure."
}

/**
 * Build the FAQ (question + answer) from the real demand topics. The answer is AI-written (grounded in
 * the question + a safe baseline) via the injected generator; the deterministic answer is the fallback.
 * Pure (the generator is an injectable seam; no I/O here). The runner gates the answers before publish.
 */
export async function buildFaqFromTopics(
  topics: ContentTopic[], magnetType: string, ctx: { brand?: string | null; area?: string | null } | undefined,
  opts: { copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator; limit?: number } = {},
): Promise<FaqItem[]> {
  const top = (topics ?? []).slice(0, opts.limit ?? 6)
  if (top.length === 0) return []
  const out: FaqItem[] = []
  for (const t of top) {
    const question = asQuestion(t.topic)
    let answer = fallbackAnswer()
    if (opts.copyGenerator) {
      try {
        const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
        const draft = await generatePersonaCopy(
          { goal: `a concise, declarative answer (2-3 sentences) to the real question "${question}" for a ${magnetType.replace(/_/g, " ")} page, written so an AI search engine can quote it directly`, facts: [question], channel: "faq", persona: { audience: "audience" }, words: 55 },
          { body: answer }, { generator: opts.copyGenerator },
        )
        answer = (draft.body || answer).trim()
      } catch { /* keep the safe fallback */ }
    }
    out.push({ question, answer })
  }
  return out
}

/**
 * Emit a schema.org FAQPage JSON-LD block — the structured data AI search engines + Google AI
 * Overviews ingest to CITE the page. Pure.
 */
export function faqPageJsonLd(items: FaqItem[], opts: { brand?: string | null; url?: string | null } = {}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: (items ?? []).map((it) => ({
      "@type": "Question",
      name: it.question,
      acceptedAnswer: { "@type": "Answer", text: it.answer },
    })),
  }
  if (opts.brand) ld.publisher = { "@type": "Organization", name: opts.brand }
  if (opts.url) ld.url = opts.url
  return ld
}

/** Serialize the JSON-LD for a <script type="application/ld+json"> tag. Pure. */
export function faqJsonLdScript(items: FaqItem[], opts?: { brand?: string | null; url?: string | null }): string {
  return JSON.stringify(faqPageJsonLd(items, opts ?? {}))
}
