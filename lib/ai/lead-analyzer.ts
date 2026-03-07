'use server'

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
    model: "gpt-4o",
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
