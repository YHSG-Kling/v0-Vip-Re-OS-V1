"use server"

/**
 * System 5.3: CMA & Listing Presentation Engine
 * Presentation Assembler
 * 
 * Assembles complete listing presentation from CMA, net sheet, and marketing plan.
 * DOES NOT advance journey - only emits completion signals.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { createVideoProject } from "@/lib/services/video-generation.service"

export interface PresentationInput {
  listingId: string
  contactId: string
  agentId: string
  brokerageId?: string
  
  // Component selection
  includeCMA?: boolean
  includeNetSheet?: boolean
  includeMarketingPlan?: boolean
  includeVideo?: boolean
  
  // Customization
  customMessage?: string
  highlightFeatures?: string[]
}

export interface PresentationResult {
  success: boolean
  presentationId?: string
  videoProjectId?: string
  readyForDecision?: boolean
  error?: string
  warnings?: string[]
}

/**
 * Assemble complete listing presentation
 */
export async function assemblePresentation(input: PresentationInput): Promise<PresentationResult> {
  try {
    // Validation
    if (!isValidUUID(input.listingId)) {
      return { success: false, error: "Invalid listing ID" }
    }
    if (!isValidUUID(input.contactId)) {
      return { success: false, error: "Invalid contact ID" }
    }
    if (!isValidUUID(input.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()
    const warnings: string[] = []

    // Get listing and contact data for personalization
    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", input.listingId)
      .single()

    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", input.contactId)
      .single()

    if (!listing || !contact) {
      return { success: false, error: "Listing or contact not found" }
    }

    // Check for required components
    const hasCMA = await checkCMAExists(input.listingId)
    const hasNetSheet = await checkNetSheetExists(input.listingId)

    if (input.includeCMA && !hasCMA) {
      warnings.push("CMA not found - must be generated first")
    }

    if (input.includeNetSheet && !hasNetSheet) {
      warnings.push("Net sheet not found - must be generated first")
    }

    // Assemble presentation content
    const presentationContent = assemblePresentationContent({
      listing,
      contact,
      includeCMA: input.includeCMA && hasCMA,
      includeNetSheet: input.includeNetSheet && hasNetSheet,
      includeMarketingPlan: input.includeMarketingPlan !== false,
      customMessage: input.customMessage,
      highlightFeatures: input.highlightFeatures || []
    })

    const presentationId = crypto.randomUUID()

    // Emit presentation created event
    await supabase.from("activities").insert({
      type: "seller.presentation.created",
      listing_id: input.listingId,
      contact_id: input.contactId,
      user_id: input.agentId,
      metadata: {
        presentation_id: presentationId,
        has_cma: hasCMA,
        has_net_sheet: hasNetSheet,
        has_marketing_plan: input.includeMarketingPlan !== false,
        content_length: presentationContent.length
      }
    })

    // Generate video if requested
    let videoProjectId: string | undefined
    if (input.includeVideo) {
      const videoResult = await generatePresentationVideo({
        listingId: input.listingId,
        contactId: input.contactId,
        agentId: input.agentId,
        presentationContent
      })
      
      if (videoResult.success) {
        videoProjectId = videoResult.projectId
      } else {
        warnings.push("Video generation failed - presentation complete without video")
      }
    }

    // Check if all decision artifacts are ready
    const readyForDecision = hasCMA && hasNetSheet && (input.includeVideo ? !!videoProjectId : true)

    // Emit decision readiness signal if all artifacts complete
    if (readyForDecision) {
      await supabase.from("activities").insert({
        type: "seller.decision.ready",
        listing_id: input.listingId,
        contact_id: input.contactId,
        user_id: input.agentId,
        metadata: {
          presentation_id: presentationId,
          video_project_id: videoProjectId,
          has_all_artifacts: true
        }
      })
    }

    return {
      success: true,
      presentationId,
      videoProjectId,
      readyForDecision,
      warnings: warnings.length > 0 ? warnings : undefined
    }
  } catch (error: any) {
    console.error("[System 5.3] Presentation assembly error:", error)
    return {
      success: false,
      error: error.message || "Failed to assemble presentation"
    }
  }
}

/**
 * Assemble presentation content with seller personalization
 */
function assemblePresentationContent(params: {
  listing: any
  contact: any
  includeCMA: boolean
  includeNetSheet: boolean
  includeMarketingPlan: boolean
  customMessage?: string
  highlightFeatures: string[]
}) {
  const { listing, contact, includeCMA, includeNetSheet, includeMarketingPlan, customMessage, highlightFeatures } = params
  
  const contactName = contact?.first_name ? `${contact.first_name} ${contact.last_name || ''}`.trim() : "Valued Client"
  const propertyAddress = `${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}`
  
  let content = `
# Listing Presentation
## Prepared for ${contactName}
### Property: ${propertyAddress}

---

## Welcome

${customMessage || `Thank you for considering me as your real estate partner. I've prepared this comprehensive listing presentation to help you make an informed decision about selling your property.`}

---
`

  if (highlightFeatures.length > 0) {
    content += `
## Property Highlights

${highlightFeatures.map(feature => `- ${feature}`).join('\n')}

---
`
  }

  if (includeCMA) {
    content += `
## Market Analysis (CMA)

Your Comparative Market Analysis has been prepared and is included with this presentation. This analysis provides:

- Current market conditions in your area
- Comparable properties recently sold
- Recommended pricing strategy
- Market trends and insights

*See attached CMA document for complete details*

---
`
  }

  if (includeNetSheet) {
    content += `
## Estimated Seller Proceeds

Your Net Sheet calculation shows your estimated proceeds under various sale scenarios:

- Primary scenario at list price
- Conservative scenario (-5%)
- Optimistic scenario (+5%)

*See attached Net Sheet document for complete breakdown*

---
`
  }

  if (includeMarketingPlan) {
    content += `
## Marketing Strategy

Our comprehensive marketing plan includes:

### Digital Marketing
- Professional photography and virtual tour
- Featured placement on major real estate portals (Zillow, Realtor.com, etc.)
- Social media advertising campaign
- Email marketing to our database of qualified buyers

### Traditional Marketing
- Eye-catching yard signage
- Property brochures and flyers
- Open house events
- Direct mail to neighborhood

### Brokerage Support
- MLS listing with maximum exposure
- Agent-to-agent networking
- Weekly market updates and showing feedback
- Professional staging consultation (if needed)

---
`
  }

  content += `
## Next Steps

1. **Review this presentation** and all attached documents
2. **Schedule a meeting** to discuss any questions
3. **Make your decision** about listing your property
4. **Begin preparations** once you're ready to move forward

I'm here to guide you through every step of this process. Let's work together to achieve your real estate goals.

---

*This presentation was prepared specifically for you and reflects current market conditions as of ${new Date().toLocaleDateString()}.*
`.trim()

  return content
}

/**
 * Generate presentation video
 */
async function generatePresentationVideo(params: {
  listingId: string
  contactId: string
  agentId: string
  presentationContent: string
}): Promise<{ success: boolean; projectId?: string }> {
  try {
    // Get listing data for video script
    const supabase = await createClient()
    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", params.listingId)
      .single()

    if (!listing) {
      return { success: false }
    }

    // Generate video script from presentation
    const videoScript = generateVideoScript(listing, params.presentationContent)

    // Create video project using existing service
    const videoResult = await createVideoProject({
      agentId: params.agentId,
      projectType: "listing_tour",
      listingId: params.listingId,
      script: videoScript,
      duration: 120, // 2 minutes
      style: "professional"
    })

    if (videoResult.success && videoResult.projectId) {
      // Emit video generation event
      await supabase.from("activities").insert({
        type: "seller.presentation.video_generated",
        listing_id: params.listingId,
        contact_id: params.contactId,
        user_id: params.agentId,
        metadata: {
          video_project_id: videoResult.projectId,
          video_status: videoResult.status
        }
      })

      return { success: true, projectId: videoResult.projectId }
    }

    return { success: false }
  } catch (error) {
    console.error("[System 5.3] Video generation error:", error)
    return { success: false }
  }
}

/**
 * Generate video script from presentation content
 */
function generateVideoScript(listing: any, presentationContent: string): string {
  const address = listing.address || "this beautiful property"
  const beds = listing.bedrooms || "multiple"
  const baths = listing.bathrooms || "multiple"
  
  return `Welcome! I'm excited to present the marketing strategy for ${address}. This ${beds} bedroom, ${baths} bathroom property has tremendous potential in today's market. I've prepared a comprehensive analysis including comparable sales, estimated proceeds, and our proven marketing approach. Together, we'll maximize your property's value and achieve your goals. Let's discuss how we can make this a successful sale.`
}

/**
 * Check if CMA exists for listing
 */
async function checkCMAExists(listingId: string): Promise<boolean> {
  try {
    const supabase = await createClient()
    const { data } = await supabase
      .from("activities")
      .select("id")
      .eq("listing_id", listingId)
      .eq("type", "seller.cma.completed")
      .limit(1)

    return (data && data.length > 0) || false
  } catch (error) {
    return false
  }
}

/**
 * Check if net sheet exists for listing
 */
async function checkNetSheetExists(listingId: string): Promise<boolean> {
  try {
    const supabase = await createClient()
    const { data } = await supabase
      .from("activities")
      .select("id")
      .eq("listing_id", listingId)
      .eq("type", "seller.net_sheet.completed")
      .limit(1)

    return (data && data.length > 0) || false
  } catch (error) {
    return false
  }
}
