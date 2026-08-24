

import { runPipelineSimple } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { CONTENT_TYPES, type ContentType } from "@/lib/constants"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { calculateThemFirstScore } from "@/lib/compliance-rules/rule-evaluators"

// ============================================
// UNIFIED CONTENT GENERATION SERVICE
// Consolidates all AI content generation across the app
// Replaces duplicates in: ai-content-generation.tsx, social-publishing.ts, link-to-video.ts
// ============================================

export interface ContentGenerationParams {
  agentId: string
  contentType: ContentType
  targetAudience?: string
  propertyId?: string
  contactId?: string
  transactionId?: string
  customPrompt?: string
  platform?: "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "email"
  emailType?: "welcome" | "follow_up" | "property_alert" | "market_update" | "check_in" | "reengagement" | "newsletter"
  metadata?: Record<string, any>
  context?: Record<string, unknown>
}

export interface ContentGenerationResult {
  success: boolean
  content?: {
    id: string
    generated_content: string
    subject?: string
    hashtags?: string[]
    call_to_action?: string
    platform_specific?: Record<string, any>
  }
  error?: string
}

/**
 * Master content generation function - handles all AI content creation
 */
export async function generateContent(params: ContentGenerationParams): Promise<ContentGenerationResult> {
  try {
    // Validate inputs
    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    console.log("[v0] Generating content:", params.contentType, "for platform:", params.platform)

    const supabase = await createClient()

    // THE THIRD WRITER OF ai_generated_content. The Content OS census records
    // app/actions/ai-content-generation.tsx as the sole writer of this table;
    // it is not — this function is reached from that file's generateSocialPost
    // and generateEmail, and it was inserting with NO brokerage_id.
    //
    // Verified against the live database:
    //   agc_insert  WITH CHECK (is_platform_admin() OR has_brokerage_access(brokerage_id))
    //   has_brokerage_access(NULL) => false
    //
    // So every row this function ever tried to save was REFUSED outright for
    // any non-platform-admin. `error` is thrown below, so the caller did see a
    // failure — but generateSocialPost's own catch turns it into a generic
    // message while the generated text is gone. The tenant must be resolved
    // from the session and stamped AT THE INSERT, never patched on after.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      throw new ValidationError("No brokerage on this session — cannot save generated content")
    }

    // Get context data based on content type
    const contextData = await gatherContextData(params)

    // Generate content using AI
    const generatedContent = await generateContentWithAI(params, contextData)

    // Save to database
    const { data: savedContent, error } = await supabase
      .from("ai_generated_content")
      .insert({
        agent_id: params.agentId,
        brokerage_id: ctx.brokerageId,
        content_type: params.contentType,
        platform: params.platform,
        generated_content: generatedContent.body,
        subject_line: generatedContent.subject,
        hashtags: generatedContent.hashtags,
        metadata: {
          ...params.metadata,
          context_data: contextData,
          generation_params: params,
        },
        // `|| 85` removed: it substituted a constant whenever the measured score
        // was 0 (all agent-centric copy — the case that most deserves a low
        // number) or null. quality_score is nullable; null means "not measured".
        quality_score: generatedContent.qualityScore ?? null,
        approval_status: "pending",
      })
      .select()
      .maybeSingle()

    if (error) throw error
    if (!savedContent) {
      throw new NotFoundError("Generated content was not saved")
    }

    return {
      success: true,
      content: {
        id: savedContent.id,
        generated_content: generatedContent.body,
        subject: generatedContent.subject,
        hashtags: generatedContent.hashtags,
        call_to_action: generatedContent.cta,
        platform_specific: generatedContent.platformSpecific,
      },
    }
  } catch (error) {
    return handleError(error, "generateContent")
  }
}

/**
 * Gather all relevant context data for content generation
 */
async function gatherContextData(params: ContentGenerationParams) {
  const supabase = await createClient()
  const context: any = {}

  // Get property details if provided
  if (params.propertyId && isValidUUID(params.propertyId)) {
    // No embed here, so nothing to repoint — but the error is read for the same reason
    // its siblings below now read theirs: a refusal that is never destructured is
    // indistinguishable from "no such listing", and the prompt goes out either way.
    const { data: property, error: propertyError } = await supabase
      .from("listings")
      .select("*")
      .eq("id", params.propertyId)
      .maybeSingle()

    if (propertyError) {
      console.error("[gatherContextData] listing read failed:", propertyError.message)
    }

    context.property = property
  }

  // Get contact details if provided
  if (params.contactId && isValidUUID(params.contactId)) {
    // `buyer_persona(*)` named a relation that DOES NOT EXIST — no public.buyer_persona
    // table, and no such column on contacts. `lead_intelligence` is keyed on lead_id and
    // declares NO foreign key to contacts. PostgREST embeds on DECLARED relationships, so
    // either one refused the WHOLE query (PGRST200); with the error undestructured the
    // contact came back null and EVERY prompt built here has gone to the model with no
    // contact and no persona, silently.
    // The real per-contact persona is client_detailed_personas (contact_id -> contacts.id,
    // one row per contact, kept current by lib/contacts/persona-builder.ts) — so the array
    // `?.[0]` the consumer already expects is the right shape, and `persona_name` (read by
    // buildEmailPrompt) is a real column on it. Only that column is named: never `*` inside
    // an embed, which hides drift from the schema guard (defect #214).
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*, client_detailed_personas(persona_name)")
      .eq("id", params.contactId)
      .maybeSingle()

    if (contactError) {
      // supabase-js RESOLVES a refused query, so an unchecked read reports a real
      // failure as an absence — which is exactly how this one hid.
      console.error("[gatherContextData] contact read failed:", contactError.message)
    }

    context.contact = contact
    context.persona = contact?.client_detailed_personas?.[0]
  }

  // Get transaction details if provided
  if (params.transactionId && isValidUUID(params.transactionId)) {
    // Same defect class as the contact read above, different cause: `transactions` has
    // THREE foreign keys to contacts (contact_id, buyer_contact_id, seller_contact_id),
    // so the bare `contacts(*)` embed was AMBIGUOUS (PGRST201) and refused this whole
    // query — `context.property` and `context.contact` have always been undefined on the
    // transaction path. The embed is now named by constraint, picking the side meant
    // here: the client on the deal. Columns are named, never `*` inside an embed (#214).
    // The prompt-quality defect this NOTE used to describe is now FIXED rather than
    // recorded: buildEmailPrompt (and buildSocialPrompt, buildListingPrompt and
    // buildVideoPrompt with it) read `property.price`, `property.square_feet`,
    // `property.zip_code` and `property.lot_size_acres` — NONE of which are listings
    // columns. The live names are `list_price`, `sqft`, `zip` and `lot_size`. Those
    // reads printed the literal string "undefined" INTO THE AI PROMPT, so the model
    // was told the price of a house was "$undefined" and wrote around it.
    //
    // The select is widened to name every column those four builders actually read.
    // `property_type`, `year_built`, `zip` and `lot_size` were consumed but never
    // selected, which is the same fault from the other side: an embed must name what
    // its consumers read, and nothing else.
    const { data: transaction, error: transactionError } = await supabase
      .from("transactions")
      .select(`
        *,
        listings(id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, property_type, year_built, lot_size),
        contacts!transactions_contact_id_fkey(id, first_name, last_name, lead_temperature)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    if (transactionError) {
      console.error("[gatherContextData] transaction read failed:", transactionError.message)
    }

    context.transaction = transaction
    context.property = transaction?.listings
    context.contact = transaction?.contacts
  }

  return context
}

/**
 * Generate content using AI with platform-specific optimizations
 */
async function generateContentWithAI(params: ContentGenerationParams, contextData: any) {
  const prompt = buildPrompt(params, contextData)

  const text = await runPipelineSimple(prompt, {
    feature: `content_service_${params.contentType}`,
  })

  // Parse AI response
  const parsed = parseAIResponse(text, params)

  return parsed
}

/**
 * Build AI prompt based on content type and context
 */
function buildPrompt(params: ContentGenerationParams, contextData: any): string {
  let prompt = ""

  // Base context
  if (params.customPrompt) {
    prompt += `${params.customPrompt}\n\n`
  }

  // Content type specific prompts
  switch (params.contentType) {
    case "email":
      prompt += buildEmailPrompt(params, contextData)
      break
    case "social_post":
      prompt += buildSocialPrompt(params, contextData)
      break
    case "listing_description":
      prompt += buildListingPrompt(params, contextData)
      break
    case "video_narration":
      prompt += buildVideoPrompt(params, contextData)
      break
    default:
      prompt += `Generate ${params.contentType} content.\n\n`
  }

  // Add "Them First" instruction
  prompt += `\nIMPORTANT: Focus on the buyer/reader benefits (you, your, imagine) rather than agent promotion (I, me, my). Score should be 70%+ buyer-focused.\n`

  // Add output format
  prompt += `\nOUTPUT FORMAT (JSON):\n`
  prompt += `{\n`
  prompt += `  "subject": "Subject line or title",\n`
  prompt += `  "body": "Main content",\n`
  prompt += `  "hashtags": ["tag1", "tag2"],\n`
  prompt += `  "cta": "Call to action"\n`
  // NO "qualityScore" FIELD. It used to ask the model to return the literal
  // 85 — so the "score" was a constant this prompt handed over and then read
  // back as if the model had assessed anything. The score is now MEASURED from
  // the returned text (calculateThemFirstScore), never self-reported.
  prompt += `}\n`

  return prompt
}

function buildEmailPrompt(params: ContentGenerationParams, contextData: any): string {
  const contact = contextData.contact
  const property = contextData.property

  let prompt = `Generate a professional real estate ${params.emailType} email.\n\n`
  prompt += audienceDirection(params)

  if (contact) {
    prompt += `RECIPIENT: ${contact.full_name || contact.first_name}\n`
    prompt += `Lead Temperature: ${contact.lead_temperature || "warm"}\n`
    if (contextData.persona) {
      prompt += `Buyer Persona: ${contextData.persona.persona_name}\n`
    }
  }

  if (property) {
    // `price` → `list_price`, `square_feet` → `sqft`: the phantom names printed
    // "$undefined" and "undefined sqft" into the prompt. See gatherContextData.
    prompt += `\nPROPERTY:\n`
    prompt += `- Address: ${property.address}\n`
    prompt += `- Price: $${property.list_price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms}BR/${property.bathrooms}BA\n`
    prompt += `- ${property.sqft} sqft\n`
  }

  // Platform-specific character limits
  if (params.platform === "twitter") {
    prompt += `\nKeep under 280 characters.\n`
  }

  return prompt
}

function buildSocialPrompt(params: ContentGenerationParams, contextData: any): string {
  const property = contextData.property
  const platform = params.platform || "instagram"

  let prompt = `Generate an engaging ${platform} post for a real estate listing.\n\n`
  prompt += audienceDirection(params)

  if (property) {
    prompt += `PROPERTY:\n`
    // `price` → `list_price` (phantom; printed "$undefined"). See gatherContextData.
    prompt += `- ${property.address}, ${property.city}\n`
    prompt += `- $${property.list_price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms}BR/${property.bathrooms}BA\n`
    prompt += `- ${property.property_type}\n`
  }

  // Platform-specific guidelines
  const platformGuidelines: Record<string, string> = {
    instagram: "Use emojis, engaging hooks, max 2200 characters. Include 10-15 hashtags.",
    facebook: "Conversational tone, 400-500 characters optimal. Focus on community benefits.",
    linkedin: "Professional tone, industry insights, max 700 characters.",
    twitter: "Concise, punchy, max 280 characters. 2-3 hashtags max.",
    tiktok: "Casual, trendy, speak to younger buyers. Include trending phrases.",
  }

  prompt += `\n${platformGuidelines[platform] || platformGuidelines.instagram}\n`

  return prompt
}

/**
 * `targetAudience` IS A DECLARED INPUT NOTHING READ.
 *
 * `ContentGenerationParams.targetAudience` is filled in by callers and, until
 * 2026-08-24, reached NO prompt builder in this file: `buildListingPrompt` and
 * `buildVideoPrompt` accepted `params` and read nothing out of it at all, and the
 * two that did read it only reached for `emailType` / `platform`. A field a caller
 * sets and no reader consumes is the writer-with-no-reader shape §1 names — and here
 * it is the single biggest lever on the copy, because a listing description written
 * for a first-time buyer and one written for an investor are different documents.
 *
 * FAIR HOUSING (§5): this renders the caller's audience string as WRITING DIRECTION
 * only, and is paired with the standing instruction below it. It never asks the model
 * to describe who a home or a neighbourhood is "right for" — that phrasing is what
 * lib/them-first/validator.ts flags as a critical fair-housing violation.
 */
function audienceDirection(params: ContentGenerationParams): string {
  const audience = (params.targetAudience ?? "").trim()
  if (!audience) return ""
  return (
    `\nWRITE FOR: ${audience}. Shape the emphasis and vocabulary for that reader.\n` +
    `Never state or imply who the property or area is suitable for, and never describe ` +
    `the people who live there — describe the HOME and its features only.\n`
  )
}

function buildListingPrompt(params: ContentGenerationParams, contextData: any): string {
  const property = contextData.property

  let prompt = `Generate a compelling MLS listing description.\n\n`
  prompt += audienceDirection(params)

  if (property) {
    prompt += `PROPERTY DETAILS:\n`
    // FOUR phantoms on these six lines: `zip_code` → `zip`, `price` → `list_price`,
    // `square_feet` → `sqft`, `lot_size_acres` → `lot_size`. See gatherContextData.
    prompt += `- ${property.address}, ${property.city}, ${property.state} ${property.zip}\n`
    prompt += `- List Price: $${property.list_price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms} Bedrooms, ${property.bathrooms} Bathrooms\n`
    prompt += `- ${property.sqft} Square Feet\n`
    prompt += `- Property Type: ${property.property_type}\n`
    if (property.year_built) prompt += `- Year Built: ${property.year_built}\n`
    // The " acres" suffix is NOT carried over with the repoint. `listings.lot_size` is
    // a bare numeric: m206-listings-property-attributes.sql declares no unit, the
    // column holds no live rows to infer one from, and the only other renderer of it
    // (app/actions/ai-listing-packet.ts) prints it unitless too. The old line asserted
    // acres about a column that never fed it; stating a unit we cannot establish would
    // put a fabricated fact in front of the model, which is worse than omitting it.
    if (property.lot_size) prompt += `- Lot Size: ${property.lot_size}\n`
  }

  prompt += `\nCreate a description that highlights the lifestyle benefits and unique features.\n`

  return prompt
}

function buildVideoPrompt(params: ContentGenerationParams, contextData: any): string {
  const property = contextData.property

  let prompt = `Generate a 30-second video narration script for a property video.\n\n`
  prompt += audienceDirection(params)

  if (property) {
    prompt += `PROPERTY:\n`
    // `price` → `list_price` (phantom; printed "$undefined"). See gatherContextData.
    prompt += `- ${property.address}\n`
    prompt += `- $${property.list_price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms}BR/${property.bathrooms}BA\n`
  }

  prompt += `\nCreate an engaging script that flows naturally with video footage. Use storytelling to create emotional connection.\n`

  return prompt
}

/**
 * Parse AI response into structured format
 */
/**
 * `params` WAS ACCEPTED HERE AND READ BY NOTHING until 2026-08-24, and it cost this
 * function the two things it could not otherwise know: WHICH generation failed to
 * parse (the catch below logged an anonymous line, so a parse failure in a nightly
 * batch named neither the content type nor the platform), and WHICH PLATFORM the
 * piece was shaped for. `platform_specific` is a STORED column on the result, and its
 * only source was whatever the model chose to echo back — so the row recorded the
 * platform only when the model volunteered it.
 */
function parseAIResponse(text: string, params: ContentGenerationParams) {
  const platformFacts = params.platform ? { platform: params.platform } : {}
  try {
    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      const body = parsed.body || text
      return {
        subject: parsed.subject || "",
        body,
        hashtags: parsed.hashtags || [],
        cta: parsed.cta || "",
        // MEASURED, not self-reported. This was `parsed.qualityScore || 85`,
        // reading a field the prompt itself specified as the literal 85 — so
        // the number was a constant on both paths and the `|| 85` never even
        // had to fire. calculateThemFirstScore actually counts buyer-focused
        // vs agent-focused pronouns in the text that came back.
        qualityScore: themFirstQualityScore(body),
        platformSpecific: { ...platformFacts, ...(parsed.platformSpecific || {}) },
      }
    }
  } catch (e) {
    console.warn(
      `[content-generation] Failed to parse JSON for contentType="${params.contentType}"` +
      `${params.platform ? ` platform="${params.platform}"` : ""} — using raw text`,
    )
  }

  // Fallback: use raw text. The score is measured off that raw text — the old
  // hardcoded 80 here scored content nobody had looked at.
  return {
    subject: "",
    body: text,
    hashtags: [],
    cta: "",
    qualityScore: themFirstQualityScore(text),
    platformSpecific: platformFacts,
  }
}

/**
 * The stored quality_score for a generated piece, 0-100.
 *
 * WHAT IT IS: the deterministic "Them First" pronoun ratio — how much of the
 * copy speaks to the reader ("you", "your", "imagine") versus about the agent
 * ("I", "me", "my"). It is the same measure the compliance gate enforces
 * (lib/kernel/compliance.ts evaluateOutbound warns below 0.6), so a piece that
 * scores badly here is the same piece that gate will flag.
 *
 * WHAT IT IS NOT: a judgement of whether the copy is any good. It is one
 * cheap, honest signal, not an editorial verdict — which is precisely why it
 * replaced a hardcoded 85. The richer instrument is
 * lib/them-first/validator.ts::validateThemFirstContent (AI structural analysis
 * + sentiment + severity-graded prohibited phrases, including Fair Housing);
 * it costs an AI call per piece, so it belongs on review, not on every write.
 *
 * Returns null for empty content: no text is "no signal", and writing a number
 * for it would be the same fabrication in a new place. quality_score is
 * nullable (verified against the live schema), so null is storable.
 */
function themFirstQualityScore(content: string): number | null {
  if (!content || !content.trim()) return null
  return Math.round(calculateThemFirstScore(content) * 100)
}

/**
 * Batch generate content for multiple items
 */
export async function bulkGenerateContent(params: {
  agentId: string
  contentType: ContentType
  targets: string[] // Property IDs, Contact IDs, etc.
  platform?: string
}): Promise<{ success: boolean; generated: number; failed: number }> {
  let generated = 0
  let failed = 0

  for (const targetId of params.targets) {
    const result = await generateContent({
      agentId: params.agentId,
      contentType: params.contentType,
      propertyId: targetId,
      platform: params.platform as any,
    })

    if (result.success) {
      generated++
    } else {
      failed++
    }

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return { success: true, generated, failed }
}
