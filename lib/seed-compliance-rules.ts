

import { createServiceClient } from "./supabase/service"

/**
 * Seed default compliance rules for Fair Housing and marketing regulations
 */
export async function seedComplianceRules() {
  const supabase = createServiceClient()

  // Fair Housing Prohibited Phrases
  const prohibitedPhrases = [
    // Familial Status
    {
      phrase: "perfect for families",
      phrase_pattern: "perfect\\s+(for|4)\\s+famil",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "This home offers generous space and a welcoming layout",
      is_active: true,
    },
    {
      phrase: "no children",
      phrase_pattern: "no\\s+children",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: null,
      is_active: true,
    },
    {
      phrase: "adults only",
      phrase_pattern: "adults\\s+only",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: null,
      is_active: true,
    },
    {
      phrase: "ideal for couples",
      phrase_pattern: "ideal\\s+(for|4)\\s+couples",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "This home features a cozy layout",
      is_active: true,
    },
    // Age
    {
      phrase: "great for young professionals",
      phrase_pattern: "great\\s+(for|4)\\s+young\\s+professional",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "This home is ideal for those seeking convenient urban living",
      is_active: true,
    },
    {
      phrase: "perfect for retirees",
      phrase_pattern: "perfect\\s+(for|4)\\s+retiree",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "This home offers low-maintenance living",
      is_active: true,
    },
    // Religion
    {
      phrase: "close to church",
      phrase_pattern: "close\\s+to\\s+(church|synagogue|mosque|temple)",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "Conveniently located near community amenities",
      is_active: true,
    },
    {
      phrase: "Christian neighborhood",
      phrase_pattern: "(christian|jewish|muslim|hindu)\\s+neighborhood",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "Welcoming community",
      is_active: true,
    },
    // Race/National Origin
    {
      phrase: "diverse neighborhood",
      phrase_pattern: "diverse\\s+neighborhood",
      category: "fair_housing",
      severity: "warning",
      suggested_alternative: "Vibrant community",
      is_active: true,
    },
    {
      phrase: "ethnic area",
      phrase_pattern: "(ethnic|minority|white|black|hispanic|asian)\\s+(area|neighborhood)",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: null,
      is_active: true,
    },
    // Disability
    {
      phrase: "no wheelchairs",
      phrase_pattern: "no\\s+wheelchair",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "Please inquire about accessibility features",
      is_active: true,
    },
    {
      phrase: "able-bodied",
      phrase_pattern: "able[\\s-]?bodied",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: null,
      is_active: true,
    },
    // Gender/Sex
    {
      phrase: "bachelor pad",
      phrase_pattern: "bachelor\\s+pad",
      category: "fair_housing",
      severity: "warning",
      suggested_alternative: "Stylish studio or one-bedroom",
      is_active: true,
    },
    {
      phrase: "man cave",
      phrase_pattern: "man\\s+cave",
      category: "fair_housing",
      severity: "warning",
      suggested_alternative: "Bonus room or recreation space",
      is_active: true,
    },
    // Marketing compliance
    {
      phrase: "guaranteed return",
      phrase_pattern: "guaranteed\\s+(return|profit|income)",
      category: "marketing",
      severity: "blocking",
      suggested_alternative: "Potential for strong returns based on market analysis",
      is_active: true,
    },
    {
      phrase: "best agent",
      phrase_pattern: "(best|#1|number\\s+one)\\s+agent",
      category: "marketing",
      severity: "warning",
      suggested_alternative: "Experienced and dedicated agent",
      is_active: true,
    },
    // RESPA Violations
    {
      phrase: "kickback",
      phrase_pattern: "kickback|referral\\s+fee\\s+for\\s+referral",
      category: "respa",
      severity: "blocking",
      suggested_alternative: null,
      is_active: true,
    },
    {
      phrase: "referral fee",
      phrase_pattern: "referral\\s+fee",
      category: "respa",
      severity: "warning",
      suggested_alternative: "Please review RESPA guidelines for referral arrangements",
      is_active: true,
    },
    // UDAAP Violations (Unfair, Deceptive, or Abusive Acts)
    {
      phrase: "guaranteed approval",
      phrase_pattern: "guaranteed\\s+approval|approval\\s+guaranteed",
      category: "udaap",
      severity: "blocking",
      suggested_alternative: "We work hard to find financing options that fit your situation",
      is_active: true,
    },
    {
      phrase: "no credit check needed",
      phrase_pattern: "no\\s+credit\\s+check",
      category: "udaap",
      severity: "blocking",
      suggested_alternative: "Various financing options available",
      is_active: true,
    },
    {
      phrase: "investment guaranteed to increase",
      phrase_pattern: "(investment|property|home)\\s+(guaranteed|will)\\s+(to\\s+)?(increase|appreciate|go\\s+up)",
      category: "udaap",
      severity: "blocking",
      suggested_alternative: "Real estate has historically shown potential for appreciation",
      is_active: true,
    },
    // Them-First Language Violations
    {
      phrase: "I can help you",
      phrase_pattern: "I\\s+can\\s+help|I\\s+will\\s+help|let\\s+me\\s+help",
      category: "them_first",
      severity: "info",
      suggested_alternative: "You deserve expert guidance through this process",
      is_active: true,
    },
    {
      phrase: "my expertise",
      phrase_pattern: "my\\s+expertise|my\\s+experience|my\\s+skills",
      category: "them_first",
      severity: "info",
      suggested_alternative: "Focus on the benefits you will receive",
      is_active: true,
    },
    {
      phrase: "master bedroom",
      phrase_pattern: "master\\s+(bedroom|suite|bath)",
      category: "fair_housing",
      severity: "warning",
      suggested_alternative: "primary bedroom/suite/bath",
      is_active: true,
    },
    {
      phrase: "no Section 8",
      phrase_pattern: "no\\s+section\\s+8|section\\s+8\\s+not\\s+accepted",
      category: "fair_housing",
      severity: "blocking",
      suggested_alternative: "Remove this restriction - it may violate fair housing laws",
      is_active: true,
    },
  ]

  // Required Disclosures
  const requiredDisclosures = [
    {
      disclosure_type: "license_number",
      disclosure_text: "Licensed Real Estate Agent",
      required_for_channels: ["email", "print", "social"],
      required_for_states: null, // All states
      placement_requirement: "footer",
      is_active: true,
    },
    {
      disclosure_type: "brokerage_name",
      disclosure_text: "Brokerage Name Required",
      required_for_channels: ["email", "print", "social"],
      required_for_states: null,
      placement_requirement: "footer",
      is_active: true,
    },
    {
      disclosure_type: "equal_housing",
      disclosure_text: "Equal Housing Opportunity",
      required_for_channels: ["print", "email"],
      required_for_states: null,
      placement_requirement: "footer",
      is_active: true,
    },
    {
      disclosure_type: "advertising_disclosure",
      disclosure_text: "This is a paid advertisement",
      required_for_channels: ["social"],
      required_for_states: null,
      placement_requirement: "beginning",
      is_active: true,
    },
    {
      disclosure_type: "mls_disclaimer",
      disclosure_text: "Information deemed reliable but not guaranteed. Data provided by MLS.",
      required_for_channels: ["email", "print"],
      required_for_states: null,
      placement_requirement: "footer",
      is_active: true,
    },
  ]

  // Insert prohibited phrases
  for (const phrase of prohibitedPhrases) {
    const { error } = await supabase.from("prohibited_phrases").upsert(phrase, {
      onConflict: "phrase",
    })
    if (error) {
      console.error("[v0] Error inserting prohibited phrase:", error)
    }
  }

  // Insert required disclosures
  for (const disclosure of requiredDisclosures) {
    const { error } = await supabase.from("required_disclosures").upsert(disclosure, {
      onConflict: "disclosure_type",
    })
    if (error) {
      console.error("[v0] Error inserting required disclosure:", error)
    }
  }

  return { success: true, prohibitedPhrases: prohibitedPhrases.length, disclosures: requiredDisclosures.length }
}

/**
 * Get all active prohibited phrases
 */
export async function getProhibitedPhrases() {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("prohibited_phrases")
    .select("*")
    .eq("is_active", true)
    .order("category", { ascending: true })

  if (error) {
    console.error("[v0] Error fetching prohibited phrases:", error)
    return []
  }

  return data || []
}

/**
 * Get required disclosures for a specific channel and state
 */
export async function getRequiredDisclosures(channel: string, state?: string) {
  const supabase = createServiceClient()

  const query = supabase
    .from("required_disclosures")
    .select("*")
    .eq("is_active", true)
    .contains("required_for_channels", [channel])

  const { data, error } = await query

  if (error) {
    console.error("[v0] Error fetching required disclosures:", error)
    return []
  }

  // Filter by state if provided
  if (state && data) {
    return data.filter((d) => !d.required_for_states || d.required_for_states.includes(state))
  }

  return data || []
}
