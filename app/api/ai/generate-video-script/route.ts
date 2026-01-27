import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { generateText } from "ai"

// Tone adjustments based on persona type
const TONE_ADJUSTMENTS: Record<string, string> = {
  military_buyer: "professional, patriotic, emphasize stability and VA benefits",
  first_time_buyer: "educational, patient, reassuring, avoid jargon",
  luxury_buyer: "sophisticated, exclusive, emphasize investment and lifestyle",
  investor: "data-driven, ROI-focused, market analysis heavy",
  downsizer: "empathetic, emphasize simplification and life stage transition",
  relocating: "informative, emphasize community and settling in support",
  growing_family: "warm, family-focused, emphasize space and schools",
  empty_nester: "understanding, focus on lifestyle change and new possibilities",
  default: "professional but warm, client-focused",
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const body = await request.json()

    const { video_type, client_id, property_id, agent_id, custom_context, template_id } = body

    if (!video_type || !agent_id) {
      return NextResponse.json({ error: "Missing required fields: video_type, agent_id" }, { status: 400 })
    }

    // Fetch agent info
    const { data: agent } = await supabase
      .from("agents")
      .select("*, users(*)")
      .eq("id", agent_id)
      .single()

    // Fetch template if specified
    let templatePrompt = ""
    if (template_id) {
      const { data: template } = await supabase.from("video_scripts_library").select("*").eq("id", template_id).single()

      if (template) {
        templatePrompt = template.base_prompt
        // Increment usage count
        await supabase
          .from("video_scripts_library")
          .update({ usage_count: (template.usage_count || 0) + 1 })
          .eq("id", template_id)
      }
    }

    // Fetch persona and context based on video type
    let persona: any = null
    let property: any = null
    let marketStats: any = null
    let contextData: Record<string, any> = {}

    if (client_id) {
      // Try leads table first, then contacts
      const { data: lead } = await supabase
        .from("leads")
        .select("*, client_detailed_personas(*)")
        .eq("id", client_id)
        .single()

      if (lead) {
        persona = lead.client_detailed_personas || {
          persona_type: lead.persona_type || "default",
          pain_points: lead.preferences_json?.pain_points || [],
          buying_motivations: lead.preferences_json?.motivations || [],
          communication_preferences: lead.preferences_json?.communication_style || "friendly",
        }
        contextData.client_name = lead.first_name || lead.name
        contextData.client_email = lead.email
        contextData.preferences = lead.preferences_json
      } else {
        const { data: contact } = await supabase.from("contacts").select("*").eq("id", client_id).single()

        if (contact) {
          contextData.client_name = contact.first_name
          persona = { persona_type: contact.contact_type || "default" }
        }
      }
    }

    if (property_id) {
      const { data: prop } = await supabase.from("properties").select("*").eq("id", property_id).single()

      if (prop) {
        property = prop
        contextData.property_address = prop.address
        contextData.beds = prop.bedrooms || prop.beds
        contextData.baths = prop.bathrooms || prop.baths
        contextData.sqft = prop.square_feet || prop.sqft
        contextData.listing_price = prop.price || prop.listing_price
        contextData.features_array = prop.features_json || prop.features || []
      }
    }

    // Fetch market stats if needed
    if (video_type === "market_update") {
      const area = body.area || contextData.property_address?.split(",")[1]?.trim()
      if (area) {
        const { data: stats } = await supabase
          .from("market_stats")
          .select("*")
          .ilike("area", `%${area}%`)
          .order("created_at", { ascending: false })
          .limit(1)
          .single()

        if (stats) {
          marketStats = stats
          contextData.avg_price = stats.avg_price
          contextData.avg_dom = stats.days_on_market
          contextData.inventory_count = stats.inventory_levels
          contextData.price_change_percentage = stats.trends?.price_change || 0
        }
      }
    }

    // Build the AI prompt
    const personaType = persona?.persona_type || "default"
    const tone = TONE_ADJUSTMENTS[personaType] || TONE_ADJUSTMENTS.default

    let systemPrompt = `You are an expert real estate video script writer. Create engaging, authentic scripts that connect emotionally with the target audience.

CRITICAL: THEM-FIRST CONTENT PHILOSOPHY
- Write 80-90% about the client and their situation
- Focus on THEIR needs, emotions, and goals
- Use "you" and "your" extensively (15%+ of words)
- Minimize "I", "me", "my" to under 10%
- Start with THEIR situation/pain point, not agent introduction
- Show understanding of what THEY care about
- Make it feel personal and specific to them`

    let userPrompt = ""

    if (templatePrompt) {
      // Use template and replace variables
      userPrompt = templatePrompt
      for (const [key, value] of Object.entries(contextData)) {
        userPrompt = userPrompt.replace(new RegExp(`{{${key}}}`, "g"), String(value || ""))
      }
      userPrompt = userPrompt.replace(/{{persona_type}}/g, personaType)
      userPrompt = userPrompt.replace(/{{tone_based_on_persona}}/g, tone)
      userPrompt = userPrompt.replace(/{{pain_points}}/g, JSON.stringify(persona?.pain_points || []))
      userPrompt = userPrompt.replace(/{{buying_priorities}}/g, JSON.stringify(persona?.buying_motivations || []))
    } else {
      // Build prompt based on video type
      switch (video_type) {
        case "listing_tour":
          userPrompt = `Generate a 90-second video script for a listing tour.

PROPERTY: ${contextData.property_address || "Property Address"}
- ${contextData.beds || "N/A"} beds, ${contextData.baths || "N/A"} baths, ${contextData.sqft || "N/A"} sqft
- Price: $${contextData.listing_price?.toLocaleString() || "N/A"}
- Features: ${JSON.stringify(contextData.features_array || [])}

TARGET BUYER PERSONA: ${personaType}
TONE: ${tone}

Create sections: [INTRO], [LIFESTYLE], [FEATURES], [NEIGHBORHOOD], [CTA]
Be specific and vivid. Focus on benefits, not just features.`
          break

        case "personalized_buyer":
          userPrompt = `Write a personalized video message for ${contextData.client_name || "the client"} about properties matching their search.

CLIENT PROFILE:
- Name: ${contextData.client_name}
- Persona: ${personaType}
- Preferences: ${JSON.stringify(contextData.preferences || {})}

SCRIPT STRUCTURE:
1. Personal greeting (5 sec)
2. "I was thinking of you..." (10 sec)
3. Why this matters to THEM (40 sec)
4. Next steps (10 sec)

TONE: ${tone}
Make them feel like you're truly thinking about THEIR needs.`
          break

        case "market_update":
          userPrompt = `Create a 2-minute market update video script.

MARKET DATA:
- Area: ${body.area || contextData.property_address?.split(",")[1]?.trim() || "Local Market"}
- Avg Price: $${contextData.avg_price?.toLocaleString() || "N/A"}
- Days on Market: ${contextData.avg_dom || "N/A"}
- Inventory: ${contextData.inventory_count || "N/A"} homes

TARGET AUDIENCE: ${personaType}
TONE: ${tone}

Create sections: [OPENING], [THE NUMBERS], [WHAT IT MEANS FOR THEM], [PREDICTIONS], [ACTION]
Make data accessible and relevant to their decision-making.`
          break

        case "agent_intro":
          userPrompt = `Write a 60-second agent introduction video script.

AGENT: ${agent?.first_name || "Agent"} ${agent?.last_name || ""}
- Experience: ${agent?.years_experience || "N/A"} years
- Specialties: ${JSON.stringify(agent?.specialties || [])}
- Areas: ${JSON.stringify(agent?.areas_served || [])}

TARGET AUDIENCE: ${personaType}
TONE: ${tone}

Create sections: [HOOK], [RELATABILITY], [EXPERTISE], [VALUE PROMISE], [CTA]
Make it feel like a genuine conversation, not a rehearsed pitch.`
          break

        case "memory_video":
          userPrompt = `Create a heartfelt 2-minute video script helping a senior seller say goodbye to their home.

Use the memories and details provided to create something deeply personal.
Context: ${custom_context || "Long-time homeowner selling their beloved home"}

TONE: Warm, respectful, celebratory (not sad)
Honor their journey while exciting them for what's next.`
          break

        default:
          userPrompt = `Generate a ${video_type} video script.
Context: ${custom_context || "Real estate video content"}
Target Audience: ${personaType}
TONE: ${tone}`
      }
    }

    // Generate script using AI
    const { text: script } = await generateText({
      model: "openai/gpt-4o-mini",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.7,
      maxTokens: 2000,
    })

    // Calculate word count and estimated duration
    const wordCount = script.split(/\s+/).length
    const estimatedDuration = Math.ceil(wordCount / 150) * 60 // 150 words per minute

    // Create video project record
    const { data: project, error: projectError } = await supabase
      .from("ai_video_projects")
      .insert({
        lead_id: client_id,
        contact_id: client_id,
        agent_id,
        video_type,
        project_type: video_type,
        script_content: script,
        script_generated_by: "ai",
        target_persona: personaType,
        personalization_data: contextData,
        persona_used: {
          persona_type: personaType,
          tone_applied: tone,
          pain_points_addressed: persona?.pain_points || [],
        },
        heygen_status: "script_ready",
        template_id,
        duration_seconds: estimatedDuration,
      })
      .select()
      .single()

    if (projectError) {
      console.error("[v0] Project creation error:", projectError)
      throw projectError
    }

    return NextResponse.json({
      success: true,
      script,
      project_id: project.id,
      word_count: wordCount,
      estimated_duration_seconds: estimatedDuration,
      persona_used: personaType,
      tone_applied: tone,
    })
  } catch (error: any) {
    console.error("[v0] AI script generation error:", error)
    return NextResponse.json({ error: "Failed to generate script", details: error.message }, { status: 500 })
  }
}
