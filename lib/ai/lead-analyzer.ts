// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published analyzeLead({ content, … }) as a public HTTP door
// with no gate: an unmetered, unattributed model call (§5 — ai_tool_usage is the
// cost ledger, and a door with no session has no tenant to book against) that
// any session could run on any text. Every caller is in-process server code
// (re-verified 2026-09-03):
//   · lib/lead-pipeline/pipeline-processor.ts:493 (dynamic import; that module
//     is itself "use server" and is the pipeline's own door)
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the model call.
import "server-only"

import { runPipelineSimple } from "./pipeline"

export async function analyzeLead(params: {
  content: string
  authorName?: string
  authorProfile?: string
}): Promise<{
  intent: string
  urgencyScore: number
  summary: string
  timeline: string
  location: string
  budget?: string
  phone?: string
  email?: string
  confidence: number
}> {
  const prompt = `Analyze this real estate lead content:

Content: ${params.content}
Author: ${params.authorName || 'Unknown'}

Extract and determine:
1. Intent: buying, selling, distress, fsbo, relocating, motivated_seller, research
2. Urgency: 1-5 scale (5 = immediate action needed)
3. Timeline: immediate, 1-3 months, 3-6 months, 6+ months
4. Location: City/State or zip code mentioned
5. Budget: if mentioned
6. Confidence score: 0-1

Return JSON only, no markdown or preamble.`

  const text = await runPipelineSimple(prompt, {
    feature: "lead_analysis",
  })

  const result = JSON.parse(text)

  return {
    intent: result.intent || 'research',
    urgencyScore: result.urgency || 3,
    summary: params.content.substring(0, 200),
    timeline: result.timeline || '3-6 months',
    location: result.location || '',
    budget: result.budget,
    confidence: result.confidence || 0.75,
  }
}
