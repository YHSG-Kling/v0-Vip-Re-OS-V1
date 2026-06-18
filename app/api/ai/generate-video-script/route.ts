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
  "seller_education",
  "market_update",
  "agent_intro",
  "listing_presentation",
  "quick_tip",
  "market_fact",
  "personal_story",
  "listing_spotlight",
  "education_bite",
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

    // ── Fetch brand voice settings + prohibited words ─────────────────────────
    let brandVoiceGuidance = ""
    let brandVoiceProfile: any = null
    let hardConstraintBlock = ""
    try {
      const brandResult = await applyBrandVoice({
        brokerageId: brokerage_id,
        actorUserId: agent_id ?? undefined,
        actorRole: "agent",
        journeyType: script_type.includes("buyer") ? "buyer" : "seller",
        persona: contactInfo.persona ?? "default",
        messageType: "ai",
        content: "",
      })

      brandVoiceProfile = brandResult

      if (brandResult.notes.length > 0) {
        brandVoiceGuidance = `\n\nBRAND VOICE GUIDELINES:\n${brandResult.notes.join("\n")}`
      }

      // Fetch global_settings for additional prohibited language
      const serviceClient = createServiceClient()
      const { data: globalSettings } = await serviceClient
        .from("global_settings")
        .select("additional_settings")
        .eq("brokerage_id", brokerage_id)
        .maybeSingle()

      const prohibited: string[] = [
        ...(brandResult.prohibitedWords ?? []),
        ...((globalSettings?.additional_settings as any)?.prohibited_language ?? []),
      ]

      if (prohibited.length > 0 || brandResult.tagline || brandResult.tone) {
        hardConstraintBlock = `
MANDATORY BRAND COMPLIANCE — VIOLATIONS WILL REJECT THIS SCRIPT:
${prohibited.length > 0 ? `- NEVER use these words or phrases: ${prohibited.join(", ")}` : ""}
${brandResult.tagline ? `- Tagline if used must be verbatim: "${brandResult.tagline}"` : ""}
- Tone: ${brandResult.tone ?? "professional"}
- Formality: ${brandResult.formalityLevel ?? 3}/5
- FAIR HOUSING: Never mention school quality, safety, demographics, or family suitability
- INVESTMENT: Never use "guaranteed", "sure investment", "will appreciate"
- No pressure language: "act now", "won't last", "best deal"
`.trim()
      }
    } catch (err) {
      console.warn("[generate-video-script] Brand voice fetch failed:", err)
    }

    // ── Build the AI prompt ──────────────────────────────────────────────────
    const tone = TONE_ADJUSTMENTS[brand_voice_tone ?? "default"] ?? TONE_ADJUSTMENTS.default
    const targetDuration = duration_target_seconds ?? (templateData?.duration_seconds ?? 90)
    const wordCount = Math.round((targetDuration / 60) * 150) // ~150 words per minute

    const systemPrompt = `${hardConstraintBlock ? hardConstraintBlock + "\n\n" : ""}You are an expert real estate video script writer creating content for professional agents.

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

      case "seller_education":
        userPrompt = `Create an educational video script for home sellers.

${custom_context ? `TOPIC/FOCUS:\n${custom_context}` : "Focus on the home selling process and how to maximize sale price"}

Structure the script with:
1. HOOK (5 seconds) - Surprising fact about selling or common seller mistake
2. THE CHALLENGE (15 seconds) - What sellers get wrong
3. EDUCATION (40 seconds) - Clear, actionable guidance for sellers
4. EXPERT TIP (20 seconds) - Insider knowledge to maximize their outcome
5. NEXT STEP (10 seconds) - How to take action

Return ONLY the script text, ready to be read by a presenter.`
        break

      case "quick_tip":
      case "market_fact":
      case "education_bite":
        userPrompt = `Create a short-form UGC-style video script (30-60 seconds max).

STYLE: Casual, authentic, conversational — like talking to a friend. No corporate jargon.
FORMAT: Portrait (TikTok/Reels/Shorts)
${custom_context ? `TOPIC:\n${custom_context}` : "Share one genuinely useful real estate insight"}

Structure:
1. HOOK (3 seconds) - Open with the most interesting/surprising statement
2. CONTENT (20-45 seconds) - Deliver the tip or insight conversationally
3. CTA (5 seconds) - One simple, low-friction next step

Keep it under 150 words. Sound human, not scripted.
Return ONLY the script text.`
        break

      case "personal_story":
        userPrompt = `Create a short personal story video script for social media (30-60 seconds).

STYLE: Vulnerable, real, first-person — a genuine moment from your real estate career.
${custom_context ? `STORY ANGLE:\n${custom_context}` : "A client success story or lesson learned"}

Structure:
1. HOOK (3 seconds) - Start mid-story with the most emotionally resonant moment
2. THE STORY (40 seconds) - Brief, human, specific detail
3. THE LESSON (10 seconds) - What it taught you
4. CONNECT (5 seconds) - Invite viewers to share their own experience

Return ONLY the script text.`
        break

      case "listing_spotlight":
        userPrompt = `Create a short listing spotlight video script for social media (30-60 seconds).

${listingInfo.address ? `PROPERTY: ${listingInfo.address}` : ""}
${listingInfo.price ? `PRICE: $${listingInfo.price}` : ""}
${custom_context ? `PROPERTY HIGHLIGHTS:\n${custom_context}` : "Focus on 1-2 standout features"}

STYLE: Excited but authentic — like you genuinely love this home.

Structure:
1. HOOK (3 seconds) - Lead with the most unique/surprising feature
2. THE STORY (40 seconds) - Paint a picture of life in this home
3. CTA (5 seconds) - Easy next step (DM, link in bio, etc.)

Return ONLY the script text.`
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
      maxTokens: 2000,
      metadata: {
        userId: agent_id ?? "",
        brokerageId: brokerage_id,
        feature: "video_script_generation",
      },
    })
    let generatedScript = response.text

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

    // ── Brand voice check + auto-correction ──────────────────────────────────
    try {
      const brandCheck = await applyBrandVoice({
        brokerageId: brokerage_id,
        actorUserId: agent_id ?? undefined,
        actorRole: "agent",
        journeyType: script_type.includes("buyer") ? "buyer" : "seller",
        persona: contactInfo.persona ?? "default",
        messageType: "ai",
        content: generatedScript,
      })

      if (brandCheck.violations.length > 0) {
        // Auto-correction pass — minimal edits to fix violations only
        try {
          const correctionPrompt = `Fix ONLY the listed violations in this script. Minimal edits, preserve all meaning and structure.\n\nScript:\n${generatedScript}\n\nViolations to fix:\n${brandCheck.violations.join("\n")}\n\nReturn ONLY the corrected script, no explanation.`
          const corrected = await generateAIResponse({
            prompt: correctionPrompt,
            temperature: 0.3,
            maxTokens: 2000,
            metadata: { userId: agent_id ?? "", brokerageId: brokerage_id, feature: "brand_correction" },
          })
          generatedScript = corrected.text

          // Re-check after correction
          const recheck = await applyBrandVoice({
            brokerageId: brokerage_id,
            actorUserId: agent_id ?? undefined,
            actorRole: "agent",
            journeyType: script_type.includes("buyer") ? "buyer" : "seller",
            persona: contactInfo.persona ?? "default",
            messageType: "ai",
            content: generatedScript,
          })

          if (recheck.violations.length > 0) {
            approvalStatus = "pending_review"
            complianceReviewNotes = complianceReviewNotes
              ? `${complianceReviewNotes}. Brand voice (after correction): ${recheck.violations.join("; ")}`
              : `Brand voice issues after auto-correction: ${recheck.violations.join("; ")}`
          }
        } catch {
          approvalStatus = "pending_review"
          complianceReviewNotes = complianceReviewNotes
            ? `${complianceReviewNotes}. Brand voice: ${brandCheck.violations.join("; ")}`
            : `Brand voice issues: ${brandCheck.violations.join("; ")}`
        }
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
      const title = `${script_type.replace(/_/g, " ").replace(/\b\w/g, (l: any) => l.toUpperCase())} - ${
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
