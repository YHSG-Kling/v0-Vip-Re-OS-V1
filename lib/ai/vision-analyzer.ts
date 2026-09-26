// NOT A "use server" MODULE (lane S1, 2026-09-02). The directive that stood here
// made `analyzePropertyImages` — a model call, ungated — a Server Action. It is
// re-exported by the lib/ai barrel and called by NOTHING (orphan export; the
// barrel is imported by 26 server modules, so the module was bundled and the
// action id was live regardless). Kept, un-published, server-only; a caller that
// wants it goes through a gated app/actions wrapper (§4).
import "server-only"

import { runPipelineSimple } from "./pipeline"

export async function analyzePropertyImages(imageUrls: string[]): Promise<{
  conditionGrade: string
  estimatedNeeds: string
  cost: number
}> {
  // Build a prompt that embeds image URLs for vision-capable models
  const imageList = imageUrls.map((url, i) => `Image ${i + 1}: ${url}`).join("\n")

  const prompt = `Analyze the following property images and grade the condition:

${imageList}

Grade: A (turnkey, excellent condition)
       B (good condition, minor updates)
       C (fair condition, moderate work needed)
       D (poor condition, major work needed)
       E (very poor condition, extensive renovation)
       F (uninhabitable)

Also estimate renovation needs.

Return JSON: { grade, estimatedNeeds }. JSON only, no markdown.`

  const text = await runPipelineSimple(prompt, {
    model: "gpt-4o",
    feature: "property_image_analysis",
  })

  const result = JSON.parse(text)

  return {
    conditionGrade: result.grade || 'C',
    estimatedNeeds: result.estimatedNeeds || 'Unknown',
    cost: 0.15,
  }
}
