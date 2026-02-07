'use server'

import { openai } from '@ai-sdk/openai'
import { generateText } from 'ai'

export async function analyzePropertyImages(imageUrls: string[]): Promise<{
  conditionGrade: string
  estimatedNeeds: string
  cost: number
}> {
  const prompt = `Analyze these property images and grade the condition:

Grade: A (turnkey, excellent condition)
       B (good condition, minor updates)
       C (fair condition, moderate work needed)
       D (poor condition, major work needed)
       E (very poor condition, extensive renovation)
       F (uninhabitable)

Also estimate renovation needs.

Return JSON: { grade, estimatedNeeds }. JSON only.`

  const { text } = await generateText({
    model: openai('gpt-4o'),
    prompt,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageUrls.map(url => ({ type: 'image' as const, image: url }))
        ]
      }
    ]
  })

  const result = JSON.parse(text)

  return {
    conditionGrade: result.grade || 'C',
    estimatedNeeds: result.estimatedNeeds || 'Unknown',
    cost: 0.15,
  }
}
