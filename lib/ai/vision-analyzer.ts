'use server'

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
