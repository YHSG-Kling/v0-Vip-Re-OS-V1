// ============================================================
// SYSTEM: L11-S02 — Brand Sample Generation API Route
// VIP Real Estate AI OS — Layer 11
// ============================================================
// POST: Generates a sample email using the brand voice configuration
// Uses Vercel AI SDK with streaming response

import { streamText } from "ai"
import { createClient } from "@/lib/supabase/server"

export async function POST(req: Request) {
  try {
    const supabase = await createClient()

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Get user's brokerage
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return new Response(JSON.stringify({ error: "Brokerage not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    const brokerageId = userData.brokerage_id

    // Get brand voice profile
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("tone, formality_level, prohibited_words, preferred_words, tagline, mission_statement")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .is("team_id", null)
      .maybeSingle()

    // Build system prompt from brand voice
    const systemPrompt = buildBrandVoiceSystemPrompt(brandVoice)

    const result = streamText({
      model: "anthropic/claude-sonnet-4-20250514",
      system: systemPrompt,
      prompt: "Write a 3-sentence follow-up email to a new real estate lead who recently inquired about buying a home. The email should feel warm and personal while maintaining professionalism. Include a soft call-to-action.",
      maxOutputTokens: 500,
      temperature: 0.7,
    })

    return result.toTextStreamResponse()
  } catch (error) {
    console.error("[L11-Brand] Generate sample error:", error)
    return new Response(JSON.stringify({ error: "Failed to generate sample" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}

// Build system prompt from brand voice profile
function buildBrandVoiceSystemPrompt(brandVoice: {
  tone: string | null
  formality_level: string | null
  prohibited_words: string[] | null
  preferred_words: string[] | null
  tagline: string | null
  mission_statement: string | null
} | null): string {
  const parts: string[] = [
    "You are a professional real estate agent writing a follow-up email to a new lead.",
    "Your communication should be helpful, genuine, and build trust.",
  ]

  if (brandVoice) {
    if (brandVoice.tone) {
      parts.push(`Tone: Write in a ${brandVoice.tone} manner.`)
    }

    if (brandVoice.formality_level) {
      const formalityGuide: Record<string, string> = {
        formal: "Use formal, professional language. Avoid contractions and casual phrases.",
        "semi-formal": "Use professional language but with a warm, approachable feel. Some contractions are acceptable.",
        casual: "Use conversational, friendly language. Contractions and casual phrases are encouraged.",
      }
      parts.push(formalityGuide[brandVoice.formality_level] || "")
    }

    if (brandVoice.prohibited_words && brandVoice.prohibited_words.length > 0) {
      parts.push(`NEVER use these words or phrases: ${brandVoice.prohibited_words.join(", ")}`)
    }

    if (brandVoice.preferred_words && brandVoice.preferred_words.length > 0) {
      parts.push(`Try to naturally incorporate these signature phrases: ${brandVoice.preferred_words.join(", ")}`)
    }

    if (brandVoice.tagline) {
      parts.push(`Brand tagline (can reference if appropriate): "${brandVoice.tagline}"`)
    }

    if (brandVoice.mission_statement) {
      parts.push(`Brand mission (inform your approach): ${brandVoice.mission_statement}`)
    }
  }

  parts.push(
    "Keep the email concise (3 sentences) and focused on building a relationship.",
    "Do not include placeholder text like [Name] - write it as if speaking to a real person."
  )

  return parts.join("\n\n")
}
