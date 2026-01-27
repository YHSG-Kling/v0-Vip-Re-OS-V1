"use server"

import { generateText, streamText, generateObject } from "ai"
import { z } from "zod"

// General purpose AI text generation using Vercel AI Gateway
export async function generateAIText(prompt: string, options?: {
  model?: string
  maxTokens?: number
  temperature?: number
}): Promise<{ text: string; error?: string }> {
  try {
    const { text } = await generateText({
      model: options?.model || "openai/gpt-4o-mini",
      prompt,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
    })
    return { text }
  } catch (error) {
    console.error("AI generation error:", error)
    return { text: "", error: "Failed to generate AI response" }
  }
}

// Chat widget AI response
export async function generateChatResponse(
  userMessage: string,
  context: string
): Promise<{ text: string; error?: string }> {
  const prompt = `You are a real estate assistant chat bot following the THEM-FIRST philosophy.
                    
CONTEXT:
- User is viewing property ${context}
- User Question: "${userMessage}"

THEM-FIRST PHILOSOPHY (CRITICAL):
- Focus 80-90% on THEIR needs, not the agent/company
- Use "you" and "your" extensively
- Ask understanding questions about THEIR situation
- Show empathy for THEIR concerns
- Minimize "I", "me", "we", "our" language
- Lead with what matters to THEM, not what you offer

Provide a helpful, empathetic response that shows you understand their situation. Keep it under 2 sentences.
If they ask a question, answer it from THEIR perspective, focusing on what they gain or how it helps them.`

  return generateAIText(prompt)
}

// CMA/Market analysis generation
export async function generateCMAAnalysis(
  propertyData: {
    address: string
    bedrooms: number
    bathrooms: number
    squareFeet: number
    yearBuilt: number
  },
  comparables: Array<{
    address: string
    soldPrice: number
    soldDate: string
    bedrooms: number
    bathrooms: number
    squareFeet: number
  }>
): Promise<{ text: string; error?: string }> {
  const prompt = `Generate a professional Comparative Market Analysis summary for:

Subject Property:
- Address: ${propertyData.address}
- Bedrooms: ${propertyData.bedrooms}
- Bathrooms: ${propertyData.bathrooms}
- Square Feet: ${propertyData.squareFeet}
- Year Built: ${propertyData.yearBuilt}

Comparable Sales:
${comparables.map((c, i) => `
${i + 1}. ${c.address}
   Sold: $${c.soldPrice.toLocaleString()} on ${c.soldDate}
   ${c.bedrooms}bd/${c.bathrooms}ba, ${c.squareFeet} sqft
`).join("")}

Provide a professional analysis including:
1. Market overview
2. Price per square foot comparison
3. Suggested price range
4. Key factors affecting value

Keep the tone professional and data-driven.`

  return generateAIText(prompt)
}

// Document analysis
export async function analyzeDocument(
  documentType: string,
  documentContent: string
): Promise<{ summary: string; keyPoints: string[]; error?: string }> {
  const prompt = `Analyze this ${documentType} document and provide:
1. A brief summary (2-3 sentences)
2. Key points or action items

Document content:
${documentContent.substring(0, 4000)}

Respond in JSON format:
{
  "summary": "...",
  "keyPoints": ["point 1", "point 2", ...]
}`

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt,
    })
    
    const parsed = JSON.parse(text)
    return {
      summary: parsed.summary,
      keyPoints: parsed.keyPoints,
    }
  } catch (error) {
    console.error("Document analysis error:", error)
    return {
      summary: "",
      keyPoints: [],
      error: "Failed to analyze document",
    }
  }
}

// Listing description generation
export async function generateListingDescription(
  propertyDetails: {
    address: string
    price: number
    bedrooms: number
    bathrooms: number
    squareFeet: number
    yearBuilt: number
    features: string[]
    neighborhood: string
  }
): Promise<{ text: string; error?: string }> {
  const prompt = `Generate an engaging real estate listing description for:

Address: ${propertyDetails.address}
Price: $${propertyDetails.price.toLocaleString()}
Bedrooms: ${propertyDetails.bedrooms}
Bathrooms: ${propertyDetails.bathrooms}
Square Feet: ${propertyDetails.squareFeet}
Year Built: ${propertyDetails.yearBuilt}
Features: ${propertyDetails.features.join(", ")}
Neighborhood: ${propertyDetails.neighborhood}

Create a compelling, professional listing description that:
- Highlights key features and benefits
- Appeals to potential buyers' emotions
- Is optimized for MLS and online search
- Stays under 300 words`

  return generateAIText(prompt)
}

// Smart property matching explanation
export async function explainPropertyMatch(
  buyerPreferences: {
    budget: number
    bedrooms: number
    location: string
    mustHaves: string[]
  },
  property: {
    address: string
    price: number
    bedrooms: number
    features: string[]
  }
): Promise<{ text: string; matchScore: number; error?: string }> {
  const prompt = `Explain why this property matches the buyer's criteria:

Buyer Preferences:
- Budget: $${buyerPreferences.budget.toLocaleString()}
- Bedrooms needed: ${buyerPreferences.bedrooms}
- Preferred location: ${buyerPreferences.location}
- Must-haves: ${buyerPreferences.mustHaves.join(", ")}

Property:
- Address: ${property.address}
- Price: $${property.price.toLocaleString()}
- Bedrooms: ${property.bedrooms}
- Features: ${property.features.join(", ")}

Respond in JSON format:
{
  "explanation": "2-3 sentence explanation of why this is a good match",
  "matchScore": 85
}
The matchScore should be 0-100 based on how well the property matches.`

  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt,
    })
    
    const parsed = JSON.parse(text)
    return {
      text: parsed.explanation,
      matchScore: parsed.matchScore,
    }
  } catch (error) {
    console.error("Property match error:", error)
    return {
      text: "",
      matchScore: 0,
      error: "Failed to analyze property match",
    }
  }
}

// Event/appointment suggestion
export async function suggestEventDetails(
  eventType: string,
  context: string
): Promise<{ suggestion: string; error?: string }> {
  const prompt = `Suggest details for a real estate ${eventType}:

Context: ${context}

Provide a helpful suggestion for this event including timing, preparation tips, and what to expect. Keep it under 100 words.`

  const result = await generateAIText(prompt)
  return { suggestion: result.text, error: result.error }
}

// Structured object generation with Zod schema validation
export async function generateAIObject<T extends z.ZodType>(
  prompt: string,
  schema: T,
  options?: {
    model?: string
    temperature?: number
  }
): Promise<{ success: boolean; object?: z.infer<T>; error?: string }> {
  try {
    const { object } = await generateObject({
      model: options?.model || "openai/gpt-4o",
      prompt,
      schema,
      temperature: options?.temperature ?? 0.7,
    })

    return { success: true, object }
  } catch (error: any) {
    console.error("AI object generation error:", error)
    return { success: false, error: error.message || "Failed to generate AI object" }
  }
}

// General purpose JSON generation using Vercel AI Gateway
export async function generateAIJSON<T = Record<string, unknown>>(
  prompt: string, 
  options?: {
    model?: string
    maxTokens?: number
    temperature?: number
  }
): Promise<{ data: T | null; error?: string }> {
  try {
    const jsonPrompt = `${prompt}

IMPORTANT: Respond with ONLY valid JSON. No markdown, no code blocks, no explanation - just the raw JSON object.`

    const { text } = await generateText({
      model: options?.model || "openai/gpt-4o-mini",
      prompt: jsonPrompt,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature ?? 0.3,
    })
    
    // Clean up potential markdown formatting
    let cleanedText = text.trim()
    if (cleanedText.startsWith("```json")) {
      cleanedText = cleanedText.slice(7)
    }
    if (cleanedText.startsWith("```")) {
      cleanedText = cleanedText.slice(3)
    }
    if (cleanedText.endsWith("```")) {
      cleanedText = cleanedText.slice(0, -3)
    }
    cleanedText = cleanedText.trim()
    
    const data = JSON.parse(cleanedText) as T
    return { data }
  } catch (error) {
    console.error("AI JSON generation error:", error)
    return { data: null, error: "Failed to generate AI JSON response" }
  }
}
