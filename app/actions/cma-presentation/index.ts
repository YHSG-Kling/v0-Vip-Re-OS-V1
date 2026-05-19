/**
 * System 5.3: CMA & Listing Presentation Engine
 * Main Export File
 * 
 * EXECUTION SCOPE (STRICT):
 * ✅ Generate CMA with quality enforcement and mandatory disclaimer
 * ✅ Calculate net sheet with 90-day validity
 * ✅ Assemble seller-personalized presentation
 * ✅ Coordinate presentation video generation
 * ✅ Emit seller.decision.ready when complete
 * 
 * ❌ DOES NOT advance journey state
 * ❌ DOES NOT manage drip delivery
 * ❌ DOES NOT decide MLS readiness
 * ❌ DOES NOT store journey/lifecycle state
 */

export { generateCMA, type CMAGenerationInput, type CMAResult } from "./cma-generator"
export { CMA_DISCLAIMER } from "@/lib/cma/disclaimer"

export {
  generateNetSheet,
  isNetSheetValid,
  getNetSheetExpiration,
  type NetSheetInput,
  type NetSheetResult,
  type NetSheetScenario
} from "./net-sheet-calculator"

export {
  assemblePresentation,
  type PresentationInput,
  type PresentationResult
} from "./presentation-assembler"

/**
 * Complete presentation workflow (orchestrated)
 */
export async function generateCompletePresentation(params: {
  listingId: string
  contactId: string
  agentId: string
  brokerageId?: string
  
  // CMA parameters
  salePrice: number
  radiusMiles?: number
  maxAgeDays?: number
  minComparables?: number
  
  // Net sheet parameters
  mortgageBalance?: number
  commissionRate?: number
  
  // Presentation options
  includeVideo?: boolean
  customMessage?: string
  highlightFeatures?: string[]
}): Promise<{
  success: boolean
  cmaGenerated: boolean
  netSheetGenerated: boolean
  presentationAssembled: boolean
  videoGenerated: boolean
  readyForDecision: boolean
  errors?: string[]
}> {
  const { generateCMA } = await import("./cma-generator")
  const { generateNetSheet } = await import("./net-sheet-calculator")
  const { assemblePresentation } = await import("./presentation-assembler")
  
  const errors: string[] = []
  let cmaGenerated = false
  let netSheetGenerated = false
  let presentationAssembled = false
  let videoGenerated = false

  try {
    // Step 1: Generate CMA
    const cmaResult = await generateCMA({
      listingId: params.listingId,
      contactId: params.contactId,
      agentId: params.agentId,
      brokerageId: params.brokerageId,
      radiusMiles: params.radiusMiles,
      maxAgeDays: params.maxAgeDays,
      minComparables: params.minComparables
    })

    if (cmaResult.success) {
      cmaGenerated = true
    } else {
      errors.push(`CMA generation failed: ${cmaResult.error}`)
    }

    // Step 2: Generate Net Sheet
    const netSheetResult = await generateNetSheet({
      listingId: params.listingId,
      contactId: params.contactId,
      agentId: params.agentId,
      salePrice: params.salePrice,
      mortgageBalance: params.mortgageBalance,
      listingCommissionRate: params.commissionRate,
      buyerCommissionRate: params.commissionRate
    })

    if (netSheetResult.success) {
      netSheetGenerated = true
    } else {
      errors.push(`Net sheet generation failed: ${netSheetResult.error}`)
    }

    // Step 3: Assemble Presentation
    const presentationResult = await assemblePresentation({
      listingId: params.listingId,
      contactId: params.contactId,
      agentId: params.agentId,
      brokerageId: params.brokerageId,
      includeCMA: true,
      includeNetSheet: true,
      includeMarketingPlan: true,
      includeVideo: params.includeVideo,
      customMessage: params.customMessage,
      highlightFeatures: params.highlightFeatures
    })

    if (presentationResult.success) {
      presentationAssembled = true
      videoGenerated = !!presentationResult.videoProjectId
    } else {
      errors.push(`Presentation assembly failed: ${presentationResult.error}`)
    }

    const readyForDecision = cmaGenerated && netSheetGenerated && presentationAssembled

    return {
      success: readyForDecision,
      cmaGenerated,
      netSheetGenerated,
      presentationAssembled,
      videoGenerated,
      readyForDecision,
      errors: errors.length > 0 ? errors : undefined
    }
  } catch (error: any) {
    errors.push(error.message || "Unknown error in complete presentation workflow")
    
    return {
      success: false,
      cmaGenerated,
      netSheetGenerated,
      presentationAssembled,
      videoGenerated,
      readyForDecision: false,
      errors
    }
  }
}
