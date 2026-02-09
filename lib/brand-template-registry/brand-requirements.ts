// ============================================
// SYSTEM 4.4 – BRAND REQUIREMENTS
// Declarative brand element requirements (no storage)
// ============================================

/**
 * Required Brand Element
 */
export type RequiredBrandElement =
  | "brokerage_logo"
  | "brokerage_disclaimer"
  | "license_number"
  | "equal_housing_logo"
  | "team_logo"
  | "agent_photo"
  | "agent_signature"
  | "brokerage_address"
  | "brokerage_phone"
  | "agent_contact"
  | "copyright_notice"
  | "privacy_policy_link"
  | "unsubscribe_link"

/**
 * Brand Context (runtime input)
 */
export interface BrandContext {
  content_type: string
  channel_intent: string
  audience_scope: "private" | "public"
  is_paid_ad?: boolean
  requires_compliance?: boolean
  brokerage_policy_level?: "standard" | "strict" | "custom"
}

/**
 * Brand Requirements Output (ephemeral)
 */
export interface BrandRequirements {
  required_elements: RequiredBrandElement[]
  optional_elements: RequiredBrandElement[]
  channel_specific_notes?: string[]
  legal_disclaimers?: string[]
  asset_references?: {
    element: RequiredBrandElement
    reference_note: string
  }[]
  generated_at: string
}

/**
 * Determine required brand elements based on context
 * Returns conceptual requirements only (no file retrieval)
 */
export function getBrandRequirements(context: BrandContext): BrandRequirements {
  const required: RequiredBrandElement[] = []
  const optional: RequiredBrandElement[] = []
  const notes: string[] = []
  const disclaimers: string[] = []
  const asset_references: { element: RequiredBrandElement; reference_note: string }[] = []

  // RULE 1: Public content requires brokerage attribution
  if (context.audience_scope === "public") {
    required.push("brokerage_logo")
    required.push("license_number")
    asset_references.push({
      element: "brokerage_logo",
      reference_note: "Use official brokerage logo from brand assets library",
    })
  }

  // RULE 2: Paid ads require full compliance
  if (context.is_paid_ad) {
    required.push("brokerage_disclaimer")
    required.push("equal_housing_logo")
    required.push("license_number")
    disclaimers.push(
      "All advertising must comply with Fair Housing Act and state real estate advertising laws"
    )
    asset_references.push({
      element: "equal_housing_logo",
      reference_note: "Use official Equal Housing Opportunity logo (EHO)",
    })
  }

  // RULE 3: Email requires unsubscribe
  if (context.content_type === "email" || context.content_type === "newsletter") {
    required.push("unsubscribe_link")
    required.push("privacy_policy_link")
    required.push("brokerage_address")
    disclaimers.push("Email must comply with CAN-SPAM Act requirements")
  }

  // RULE 4: SMS requires agent contact
  if (context.content_type === "sms_script") {
    required.push("agent_contact")
    disclaimers.push("SMS marketing must comply with TCPA requirements")
    notes.push("Ensure recipient has opted-in to receive SMS messages")
  }

  // RULE 5: Listing content requires license
  if (context.content_type === "listing_description") {
    required.push("license_number")
    required.push("brokerage_logo")
    optional.push("agent_photo")
  }

  // RULE 6: Social media brand elements
  if (
    context.channel_intent === "instagram" ||
    context.channel_intent === "facebook" ||
    context.channel_intent === "linkedin" ||
    context.channel_intent === "twitter" ||
    context.channel_intent === "tiktok"
  ) {
    optional.push("agent_photo")
    optional.push("team_logo")
    notes.push("Social posts should maintain consistent brand voice and visual identity")
  }

  // RULE 7: Direct mail requires full attribution
  if (context.content_type === "direct_mail") {
    required.push("brokerage_logo")
    required.push("agent_photo")
    required.push("agent_contact")
    required.push("license_number")
    required.push("brokerage_address")
    disclaimers.push("Direct mail must include physical brokerage address per state law")
  }

  // RULE 8: Video/audio requires verbal attribution
  if (
    context.content_type === "video_script" ||
    context.content_type === "podcast_script" ||
    context.content_type === "audio_script"
  ) {
    required.push("brokerage_disclaimer")
    notes.push("Include verbal disclosure: 'Licensed by [Brokerage Name], License #[Number]'")
  }

  // RULE 9: Strict policy requires all branding
  if (context.brokerage_policy_level === "strict") {
    if (!required.includes("brokerage_logo")) required.push("brokerage_logo")
    if (!required.includes("license_number")) required.push("license_number")
    if (!required.includes("brokerage_disclaimer")) required.push("brokerage_disclaimer")
    notes.push("Strict brokerage policy: All content must include full brand attribution")
  }

  // RULE 10: Compliance-required content
  if (context.requires_compliance) {
    required.push("brokerage_disclaimer")
    required.push("equal_housing_logo")
    disclaimers.push("Content must adhere to all federal, state, and local fair housing laws")
  }

  // Channel-specific notes
  const channelNotes = getChannelSpecificNotes(context.channel_intent)
  if (channelNotes) {
    notes.push(channelNotes)
  }

  return {
    required_elements: Array.from(new Set(required)), // Remove duplicates
    optional_elements: Array.from(new Set(optional)),
    channel_specific_notes: notes,
    legal_disclaimers: disclaimers,
    asset_references,
    generated_at: new Date().toISOString(),
  }
}

/**
 * Get channel-specific brand notes
 */
function getChannelSpecificNotes(channel_intent?: string): string | null {
  const channelNotes: Record<string, string> = {
    instagram: "Maintain visual brand consistency; use brand colors and fonts in graphics",
    facebook: "Profile must include brokerage affiliation; posts should link to professional website",
    linkedin: "Professional headshot required; company affiliation must be accurate",
    twitter: "Bio must include license information; use branded hashtags",
    tiktok: "Watermark videos with brokerage logo; verbal disclosure in video captions",
    youtube: "Video description must include full brokerage info and license number",
    google_ads: "Ad copy must include license number; landing page must show brokerage attribution",
    meta_ads: "Ad creative must include Equal Housing logo if showing property imagery",
    email: "Email signature must include license number and brokerage affiliation",
    sms: "Messages must identify sender and brokerage; include opt-out instructions",
  }

  return channel_intent && channelNotes[channel_intent] ? channelNotes[channel_intent] : null
}

/**
 * Check if content meets brand requirements
 */
export function validateBrandCompliance(
  content: {
    raw_content: string
    metadata?: Record<string, any>
  },
  requirements: BrandRequirements
): {
  is_compliant: boolean
  missing_elements: RequiredBrandElement[]
  warnings: string[]
} {
  const missing: RequiredBrandElement[] = []
  const warnings: string[] = []

  const contentLower = content.raw_content.toLowerCase()

  // Check for required elements (simple text matching)
  for (const element of requirements.required_elements) {
    const elementPatterns = getElementPatterns(element)
    const found = elementPatterns.some((pattern) => contentLower.includes(pattern.toLowerCase()))

    if (!found) {
      missing.push(element)
    }
  }

  // Generate warnings
  if (missing.length > 0) {
    warnings.push(`Missing ${missing.length} required brand element(s)`)
  }

  if (requirements.legal_disclaimers && requirements.legal_disclaimers.length > 0) {
    warnings.push("Ensure all legal disclaimers are included per requirements")
  }

  return {
    is_compliant: missing.length === 0,
    missing_elements: missing,
    warnings,
  }
}

/**
 * Get search patterns for brand elements
 */
function getElementPatterns(element: RequiredBrandElement): string[] {
  const patterns: Record<RequiredBrandElement, string[]> = {
    brokerage_logo: ["[logo]", "[brokerage logo]"],
    brokerage_disclaimer: ["licensed by", "brokerage", "affiliated with"],
    license_number: ["license", "lic #", "lic#", "license number"],
    equal_housing_logo: ["equal housing", "eho", "[eho logo]"],
    team_logo: ["[team logo]", "[logo]"],
    agent_photo: ["[photo]", "[headshot]", "[agent photo]"],
    agent_signature: ["[signature]", "sincerely", "best regards"],
    brokerage_address: ["address:", "located at", "office:"],
    brokerage_phone: ["phone:", "call", "contact:"],
    agent_contact: ["contact", "reach me", "email me", "call me"],
    copyright_notice: ["copyright", "©", "(c)"],
    privacy_policy_link: ["privacy policy", "privacy"],
    unsubscribe_link: ["unsubscribe", "opt-out", "manage preferences"],
  }

  return patterns[element] || []
}

/**
 * Get brand element description (for human reference)
 */
export function getBrandElementDescription(element: RequiredBrandElement): string {
  const descriptions: Record<RequiredBrandElement, string> = {
    brokerage_logo: "Official brokerage logo image file (PNG/SVG preferred)",
    brokerage_disclaimer: "Text: 'Licensed by [Brokerage Name], License #[Number]'",
    license_number: "Agent or brokerage license number as required by state law",
    equal_housing_logo: "Equal Housing Opportunity (EHO) logo image",
    team_logo: "Team or agent personal branding logo",
    agent_photo: "Professional headshot of the agent",
    agent_signature: "Digital or handwritten signature image",
    brokerage_address: "Physical address of brokerage office",
    brokerage_phone: "Main brokerage phone number",
    agent_contact: "Agent direct contact information (phone/email)",
    copyright_notice: "Copyright statement (e.g., '© 2024 [Brokerage Name]')",
    privacy_policy_link: "Link to privacy policy page",
    unsubscribe_link: "Functional unsubscribe link for email marketing",
  }

  return descriptions[element] || "No description available"
}

/**
 * Batch brand requirements
 */
export function batchGetBrandRequirements(contexts: BrandContext[]): BrandRequirements[] {
  return contexts.map((context) => getBrandRequirements(context))
}

/**
 * Format brand requirements for display
 */
export function formatBrandRequirements(requirements: BrandRequirements): string {
  let output = `Brand Requirements:\n\n`

  output += `REQUIRED ELEMENTS (${requirements.required_elements.length}):\n`
  for (const element of requirements.required_elements) {
    output += `- ${element.replace(/_/g, " ").toUpperCase()}\n`
    output += `  ${getBrandElementDescription(element)}\n`
  }

  if (requirements.optional_elements.length > 0) {
    output += `\nOPTIONAL ELEMENTS (${requirements.optional_elements.length}):\n`
    for (const element of requirements.optional_elements) {
      output += `- ${element.replace(/_/g, " ").toUpperCase()}\n`
    }
  }

  if (requirements.legal_disclaimers && requirements.legal_disclaimers.length > 0) {
    output += `\nLEGAL DISCLAIMERS:\n`
    for (const disclaimer of requirements.legal_disclaimers) {
      output += `- ${disclaimer}\n`
    }
  }

  if (requirements.channel_specific_notes && requirements.channel_specific_notes.length > 0) {
    output += `\nCHANNEL NOTES:\n`
    for (const note of requirements.channel_specific_notes) {
      output += `- ${note}\n`
    }
  }

  if (requirements.asset_references && requirements.asset_references.length > 0) {
    output += `\nASSET REFERENCES:\n`
    for (const ref of requirements.asset_references) {
      output += `- ${ref.element.replace(/_/g, " ").toUpperCase()}: ${ref.reference_note}\n`
    }
  }

  output += `\nGenerated: ${new Date(requirements.generated_at).toLocaleString()}\n`

  return output
}
