// lib/lead-pipeline/perplexity-enrichment.ts
// Perplexity web-research enrichment — a COST-GATED gap-fill that runs only when
// the primary skip-trace (PeopleData) leaves a high-value lead thin (e.g. no
// email but a full name + location). Uses the existing AI gateway
// (perplexity-sonar via the 'lead_enrichment_research' route) — no new client.
//
// mergeEnrichment is pure and unit-tested; the gateway call is exercised live.

import { z } from "zod"
import { generateObjectRouted } from "@/lib/ai/models"
import { webSearch, formatWebSearchContext } from "@/lib/ai/web-search"
import type { PerplexityFindings } from "./enrichment-merge"

// Re-export the pure merge helpers so existing importers keep one entry point;
// the pure logic lives in enrichment-merge.ts (no server-only import).
export { mergeEnrichment, shouldGapFill, type BaseEnrichment, type PerplexityFindings } from "./enrichment-merge"

const findingsSchema = z.object({
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  employer: z.string().nullable().optional(),
  currentBrokerage: z.string().nullable().optional(),
})

/** Web-research a lead's missing contact/identity fields via the gateway (Perplexity). */
export async function enrichViaPerplexity(params: {
  firstName: string
  lastName: string
  city?: string | null
  state?: string | null
  brokerageId?: string
}): Promise<PerplexityFindings | null> {
  const where = [params.city, params.state].filter(Boolean).join(", ")
  try {
    // Ground the model with fresh web results so it reasons over current public
    // pages rather than parametric memory alone. "research" mode = Tavily-first
    // (synthesized answer): best for a named-person contact/identity lookup, as
    // opposed to Exa-first "intent" mode used for behavior discovery in sourcing.
    const grounding = await webSearch({
      query: `${params.firstName} ${params.lastName}${where ? ` ${where}` : ""} real estate agent contact email phone brokerage`,
      maxResults: 6,
      mode: "research",
    }).catch(() => null)
    const context = grounding ? formatWebSearchContext(grounding) : ""

    const { object } = await generateObjectRouted({
      feature: "lead_enrichment_research",
      brokerageId: params.brokerageId,
      maxTokens: 500,
      temperature: 0,
      schema: findingsSchema,
      prompt:
        `Find publicly-listed contact and professional details for ${params.firstName} ${params.lastName}` +
        `${where ? ` in ${where}` : ""}. Return only verifiable public info; use null for anything not found. ` +
        `Fields: email, phone, employer, currentBrokerage (if they are a real-estate agent).` +
        (context ? `\n\nWeb search context:\n${context}` : ""),
    })
    return object
  } catch {
    return null
  }
}
