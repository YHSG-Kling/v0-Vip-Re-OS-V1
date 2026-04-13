/**
 * Layer 8.1 AI Script Generator — API Route
 * 
 * Generates video scripts using Claude API with kernel governance.
 * 
 * CRITICAL RULES:
 * - Writes to public.video_scripts_library (canonical table)
 * - Writes lifecycle_events row for every script generated
 * - Runs kernel compliance check before finalizing approval_status
 * - NEVER references public.video_scripts or public.script_templates
 */

import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { generateAIResponse } from "@/lib/ai"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"

// ─── SCRIPT TYPES ────────────────────────────────────────────────────────────

const SCRIPT_TYPES = [
  "property_tour",
  "buyer_education", 
  "market_update",
  "agent_intro",
  "listing_presentation",
] as const

type ScriptType = (typeof SCRIPT_TYPES)[number]

// ─── COMPLIANCE SENSITIVE PHRASES ────────────────────────────────────────────

const COMPLIANCE_RISK_PHRASES = [
  // Fair Housing
  "family-friendly neighborhood",
  "great schools",
  "safe area",
  "exclusive community",
  "up and coming",
  // Investment advice
  "guaranteed returns",
  "sure investment",
  "will appreciate",
  "can't lose money",
  // Misleading claims
  "best deal",
  "lowest price",
  "won't last long",
  "act now",
  "limited time",
]

// ─── TONE ADJUSTMENTS ────────────────────────────────────────────────────────

const TONE_ADJUSTMENTS: Record<string, string> = {
  professional: "authoritative, polished, industry-expert tone",
  friendly: "warm, approachable, conversational tone",
  energetic: "enthusiastic, dynamic, high-energy tone",
  educational: "informative, patient, explanatory tone",
  luxury: "sophisticated, exclusive, premium tone",
  empathetic: "understanding, supportive, caring tone",
  default: "professional but warm, client-focused tone",
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Auth guard — agent_id and brokerage_id always from session
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  try {
    const serviceSupabase = createServiceClient()
    const body = await request.json()

    const {
      script_type,
      listing_id,
      contact_id,
      template_id,
      custom_context,
      brand_voice_tone,
      duration_target_seconds,
      save_to_library,
    } = body

    // Always use session-resolved values — never trust body-supplied IDs
    const agent_id = auth.agentId
    const brokerage_id = auth.brokerageId

    // Validate required fields
    if (!script_type || !SCRIPT_TYPES.includes(script_type)) {
      return NextResponse.json(
        { error: `Invalid script_type. Must be one of: ${SCRIPT_TYPES.join(", ")}` },
        { status: 400 }
      )
    }

    // ── Fetch agent info ─────────────────────────────────────────────────────
    let agentInfo: Record<string, any> = {}
    if (agent_id) {
      const { data: agent } = await supabase
        .from("agents")
        .select("*, users(first_name, last_name, email)")
        .eq("id", agent_id)
        .single()

      if (agent) {
        agentInfo = {
          name: `${agent.users?.first_name ?? ""} ${agent.users?.last_name ?? ""}`.trim(),
          years_experience: agent.years_experience,
          specializations: agent.specializations,
          bio: agent.bio,
        }
      }
    }

    // ── Fetch template if specified ──────────────────────────────────────────
    let templateData: Record<string, any> | null = null
    if (template_id) {
      const { data: template } = await supabase
        .from("video_templates")
        .select("*")
        .eq("id", template_id)
        .single()

      if (template) {
        templateData = template
      }
    }

    // ── Fetch listing if specified ───────────────────────────────────────────
    let listingInfo: Record<string, any> = {}
    if (listing_id) {
      const { data: listing } = await supabase
        .from("listings")
        .select("*")
        .eq("id", listing_id)
        .single()

      if (listing) {
        listingInfo = {
          address: listing.address,
          city: listing.city,
          state: listing.state,
          zip: listing.zip,
          price: listing.list_price,
          beds: listing.bedrooms,
          baths: listing.bathrooms,
          sqft: listing.sqft,
        }
      }
    }

    // ── Fetch contact if specified ───────────────────────────────────────────
    let contactInfo: Record<string, any> = {}
    if (contact_id) {
      const { data: contact } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", contact_id)
        .single()

      if (contact) {
        contactInfo = {
          name: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(),
          persona: contact.contact_persona,
          buyer_stage: contact.buyer_stage,
        }
      }
    }

    // ── Fetch brand voice settings ───────────────────────────────────────────
    let brandVoiceGuidance = ""
    try {
      const brandResult = await applyBrandVoice({
        brokerageId: brokerage_id,
        actorUserId: agent_id,
        actorRole: "agent",
        journeyType: script_type.includes("buyer") ? "buyer" : "seller",
        persona: contactInfo.persona ?? "default",
        messageType: "ai",
        content: "",
      })

      if (brandResult.notes.length > 0) {
        brandVoiceGuidance = `\n\nBRAND VOICE GUIDELINES:\n${brandResult.notes.join("\n")}`
      }
    } catch (err) {
      console.warn("[generate-video-script] Brand voice fetch failed:", err)
    }

    // ── Build the AI prompt ──────────────────────────────────────────────────
    const tone = TONE_ADJUSTMENTS[brand_voice_tone ?? "default"] ?? TONE_ADJUSTMENTS.default
    const targetDuration = duration_target_seconds ?? (templateData?.duration_seconds ?? 90)
    const wordCount = Math.round((targetDuration / 60) * 150) // ~150 words per minute

    const systemPrompt = `You are an expert real estate video script writer creating content for professional agents.

CRITICAL COMPLIANCE RULES:
- NEVER use Fair Housing violation language (protected classes, steering, discriminatory phrases)
- NEVER make investment guarantees or financial promises
- NEVER use high-pressure sales tactics
- ALWAYS focus on the property features, not the neighborhood demographics
- Use "you" and "your" extensively — make it about the viewer
- Avoid claims that can't be substantiated

THEM-FIRST PHILOSOPHY:
- Write 80%+ about the client's needs and situation
- Minimize agent self-promotion
- Start with THEIR pain point or aspiration
- Show understanding of what THEY care about

TARGET DURATION: ${targetDuration} seconds (~${wordCount} words)
TONE: ${tone}
${brandVoiceGuidance}`

    let userPrompt = ""

    switch (script_type as ScriptType) {
      case "property_tour":
        userPrompt = `Create a property tour video script.

PROPERTY DETAILS:
${listingInfo.address ? `Address: ${listingInfo.address}, ${listingInfo.city}, ${listingInfo.state}` : "Address: [Property Address]"}
${listingInfo.beds ? `Bedrooms: ${listingInfo.beds}` : ""}
${listingInfo.baths ? `Bathrooms: ${listingInfo.baths}` : ""}
${listingInfo.sqft ? `Square Feet: ${listingInfo.sqft.toLocaleString()}` : ""}
${listingInfo.price ? `Price: $${listingInfo.price.toLocaleString()}` : ""}

${custom_context ? `ADDITIONAL CONTEXT:\n${custom_context}` : ""}

Structure the script with:
1. HOOK (5 seconds) - Grab attention with the most compelling feature
2. LIFESTYLE (20 seconds) - Paint a picture of living there
3. KEY FEATURES (30 seconds) - Highlight 3-4 standout features
4. NEIGHBORHOOD BENEFITS (15 seconds) - Local amenities (no demographic mentions)
5. CALL TO ACTION (10 seconds) - Next steps to learn more

Return ONLY the script text, ready to be read by a presenter.`
        break

      case "buyer_education":
        userPrompt = `Create an educational video script for home buyers.

TARGET AUDIENCE: ${contactInfo.persona ?? "Home buyers"}
BUYER STAGE: ${contactInfo.buyer_stage ?? "Researching"}

${custom_context ? `TOPIC/FOCUS:\n${custom_context}` : "Focus on the home buying process overview"}

Structure the script with:
1. HOOK (5 seconds) - Common question or pain point
2. THE CHALLENGE (15 seconds) - Acknowledge their concern
3. EDUCATION (40 seconds) - Clear, actionable information
4. EXPERT TIP (20 seconds) - Pro insight they won't find online
5. NEXT STEP (10 seconds) - How to apply this knowledge

Return ONLY the script text, ready to be read by a presenter.`
        break

      case "market_update":
        userPrompt = `Create a market update video script.

${custom_context ? `MARKET/AREA:\n${custom_context}` : "Focus on general market trends"}

Structure the script with:
1. HOOK (5 seconds) - Surprising stat or trend
2. THE DATA (25 seconds) - Key market metrics (prices, inventory, days on market)
3. WHAT IT MEANS (30 seconds) - Interpret for buyers AND sellers
4. PREDICTIONS (15 seconds) - Near-term outlook
5. CALL TO ACTION (15 seconds) - How to take advantage of current conditions

Return ONLY the script text, ready to be read by a presenter.`
        break

      case "agent_intro":
        userPrompt = `Create an agent introduction video script.

AGENT INFO:
${agentInfo.name ? `Name: ${agentInfo.name}` : ""}
${agentInfo.years_experience ? `Experience: ${agentInfo.years_experience} years` : ""}
${agentInfo.specializations ? `Specializations: ${agentInfo.specializations}` : ""}

${custom_context ? `PERSONAL NOTES:\n${custom_context}` : ""}

Structure the script with:
1. HOOK (5 seconds) - Why you got into real estate (relatable moment)
2. YOUR WHY (20 seconds) - What drives you to help clients
3. VALUE PROPOSITION (30 seconds) - What makes working with you different
4. PROOF (20 seconds) - Brief success story or testimonial mention
5. INVITATION (15 seconds) - Warm invitation to connect

IMPORTANT: This is NOT a resume reading. Make it personal and relatable.

Return ONLY the script text, ready to be read by the agent.`
        break

      case "listing_presentation":
        userPrompt = `Create a listing presentation video script for a seller.

${listingInfo.address ? `PROPERTY: ${listingInfo.address}` : ""}
${contactInfo.name ? `SELLER: ${contactInfo.name}` : ""}

${custom_context ? `PRESENTATION FOCUS:\n${custom_context}` : ""}

Structure the script with:
1. PERSONAL GREETING (10 seconds) - Acknowledge the seller by name
2. UNDERSTANDING THEIR GOALS (20 seconds) - Show you listened to their needs
3. MARKETING PLAN OVERVIEW (35 seconds) - How you'll showcase their home
4. PRICING STRATEGY (15 seconds) - Your approach to getting top dollar
5. NEXT STEPS (10 seconds) - What happens if they choose you

Return ONLY the script text, ready to be read by the agent.`
        break
    }

    // Use template default_script as base if available
    if (templateData?.default_script) {
      userPrompt += `\n\nTEMPLATE STRUCTURE TO FOLLOW:\n${templateData.default_script}`
    }

    // ── Generate script using AI ─────────────────────────────────────────────
    const response = await generateAIResponse({
      prompt: `${systemPrompt}\n\n${userPrompt}`,
      temperature: 0.7,
      maxOutputTokens: 2000,
      metadata: {
        userId: agent_id,
        brokerageId: brokerage_id,
        feature: "video_script_generation",
      },
    })
    const generatedScript = response.text

    // ── Compliance check ─────────────────────────────────────────────────────
    const scriptLower = generatedScript.toLowerCase()
    const complianceIssues: string[] = []

    for (const phrase of COMPLIANCE_RISK_PHRASES) {
      if (scriptLower.includes(phrase.toLowerCase())) {
        complianceIssues.push(`Contains risky phrase: "${phrase}"`)
      }
    }

    // Determine approval status based on compliance
    let approvalStatus: "draft" | "pending_review" | "approved" | "rejected" = "draft"
    let complianceReviewNotes: string | null = null

    if (complianceIssues.length > 0) {
      approvalStatus = "pending_review"
      complianceReviewNotes = `Auto-flagged for review: ${complianceIssues.join("; ")}`
    }

    // ── Brand voice check ────────────────────────────────────────────────────
    try {
      const brandCheck = await applyBrandVoice({
        brokerageId: brokerage_id,
        actorUserId: agent_id,
        actorRole: "agent",
        journeyType: script_type.includes("buyer") ? "buyer" : "seller",
        persona: contactInfo.persona ?? "default",
        messageType: "ai",
        content: generatedScript,
      })

      if (brandCheck.violations.length > 0) {
        approvalStatus = "pending_review"
        const brandIssues = brandCheck.violations.join("; ")
        complianceReviewNotes = complianceReviewNotes 
          ? `${complianceReviewNotes}. Brand voice: ${brandIssues}`
          : `Brand voice issues: ${brandIssues}`
      }
    } catch (err) {
      console.warn("[generate-video-script] Brand voice check failed:", err)
    }

    // ── Calculate word count and duration ────────────────────────────────────
    const wordCountActual = generatedScript.split(/\s+/).length
    const estimatedDuration = Math.ceil(wordCountActual / 2.5) // ~150 wpm = 2.5 wps

    // ── Determine required brand assets ──────────────────────────────────────
    const requiredBrandAssets: Record<string, boolean> = {
      logo: true,
      disclaimer: script_type === "market_update" || script_type === "listing_presentation",
      contact_info: true,
    }

    // ── Save to library if requested ─────────────────────────────────────────
    let savedScript: Record<string, any> | null = null

    if (save_to_library !== false) {
      const title = `${script_type.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())} - ${
        listingInfo.address ?? contactInfo.name ?? new Date().toLocaleDateString()
      }`

      const { data: script, error: scriptError } = await serviceSupabase
        .from("video_scripts_library")
        .insert({
          brokerage_id,
          agent_id: agent_id ?? null,
          listing_id: listing_id ?? null,
          contact_id: contact_id ?? null,
          template_id: template_id ?? null,
          script_type,
          title,
          script_content: generatedScript,
          duration_target_seconds: targetDuration,
          brand_voice_tone: brand_voice_tone ?? null,
          approval_status: approvalStatus,
          compliance_review_notes: complianceReviewNotes,
          required_brand_assets: requiredBrandAssets,
          ai_generated: true,
          is_active: true,
          created_by: agent_id ?? null,
          compliance_approved: false,
        })
        .select()
        .single()

      if (scriptError) {
        console.error("[generate-video-script] Error saving to library:", scriptError)
      } else {
        savedScript = script

        // Write lifecycle_events row
        await serviceSupabase.from("lifecycle_events").insert({
          entity_type: "video_script",
          entity_id: script.id,
          brokerage_id,
          event_type: KernelEvent.SCRIPT_GENERATED,
          actor_user_id: agent_id ?? null,
          metadata: {
            script_type,
            ai_generated: true,
            approval_status: approvalStatus,
            word_count: wordCountActual,
            compliance_issues: complianceIssues,
          },
        })

        // Fire kernel event
        await processKernelEvent({
          event: KernelEvent.SCRIPT_GENERATED,
          brokerageId: brokerage_id,
          entityType: "video_script",
          entityId: script.id,
        }).catch(err => console.error("[generate-video-script] Kernel event failed:", err))
      }
    }

    return NextResponse.json({
      success: true,
      script: generatedScript,
      script_id: savedScript?.id ?? null,
      word_count: wordCountActual,
      estimated_duration_seconds: estimatedDuration,
      approval_status: approvalStatus,
      compliance_issues: complianceIssues,
      compliance_review_notes: complianceReviewNotes,
      required_brand_assets: requiredBrandAssets,
      template_used: templateData?.template_name ?? null,
    })
  } catch (error: any) {
    console.error("[generate-video-script] Error:", error)
    return NextResponse.json(
      { error: "Failed to generate script", details: error.message },
      { status: 500 }
    )
  }
}
