"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// Stage values that indicate the listing is live on MLS and eligible for packet generation
const MLS_LIVE_STAGES = ["live", "mls_active", "active", "mls_live", "for_sale", "MLS_ACTIVE"]

// =====================================================
// AI LISTING PACKET SYSTEM
// Generates comprehensive property packets for display
// after listing goes live on MLS
// =====================================================

interface ListingPacketConfig {
  listingId: string
  agentId: string
  includeFlyer: boolean
  includeSellerDisclosure: boolean
  includeUtilitiesForm: boolean
  includeGISReport: boolean
  includeTaxRecord: boolean
  includeAppraiserReport: boolean
  createPhysicalBinder: boolean
  deliveryMethod: "email" | "print" | "both"
  copies: number
}

interface PacketDocument {
  type: string
  name: string
  url?: string
  content?: string | Record<string, unknown> | null
  status: "pending" | "generated" | "error"
  generatedAt?: string
}

// =====================================================
// GENERATE COMPLETE LISTING PACKET
// =====================================================

export async function generateListingPacket(config: ListingPacketConfig) {
  if (!isValidUUID(config.listingId) || !isValidUUID(config.agentId)) {
    return { success: false, error: "Invalid listing or agent ID" }
  }

  // Use service client for listing lookup — packet generation is an admin action
  // that must work regardless of RLS policies on the listings table.
  const service = createServiceClient()
  const supabase = await createClient()

  try {
    // Get listing details (service client bypasses RLS)
    const { data: listing, error: listingError } = await service
      .from("listings")
      .select(`
        *,
        contacts:contact_id (first_name, last_name, email, phone),
        agents:agent_id (first_name, last_name, email, phone, license_number)
      `)
      .eq("id", config.listingId)
      .single()

    if (listingError || !listing) {
      return { success: false, error: "Listing not found" }
    }

    // Verify listing is in an MLS-active state
    const listingStage = (listing.stage ?? listing.status ?? "").toLowerCase()
    const isLive = MLS_LIVE_STAGES.some(s => s.toLowerCase() === listingStage) ||
      listingStage.includes("active") || listingStage.includes("live")
    if (!isLive) {
      return { success: false, error: "Listing must be live on MLS before generating packet" }
    }

    // Get agent's brokerage_id for the job record
    const { data: agent } = await service
      .from("agents")
      .select("brokerage_id")
      .eq("user_id", config.agentId)
      .single()

    // Create packet job record
    const { data: packet, error: packetError } = await supabase
      .from("listing_packet_jobs")
      .insert({
        listing_id: config.listingId,
        brokerage_id: agent?.brokerage_id,
        agent_user_id: config.agentId,
        job_type: "full_packet",
        status: "queued",
        config: { ...config, sections: [], content: null },
      })
      .select()
      .single()

    if (packetError) throw packetError

    const documents: PacketDocument[] = []

    // Generate each requested document
    if (config.includeFlyer) {
      const flyer = await generateListingFlyer(listing)
      documents.push(flyer)
    }

    if (config.includeSellerDisclosure) {
      const disclosure = await compileSellerDisclosure(listing)
      documents.push(disclosure)
    }

    if (config.includeUtilitiesForm) {
      const utilities = await generateUtilitiesForm(listing)
      documents.push(utilities)
    }

    if (config.includeGISReport) {
      const gisReport = await fetchGISPropertyReport(listing)
      documents.push(gisReport)
    }

    if (config.includeTaxRecord) {
      const taxRecord = await fetchTaxRecordReport(listing)
      documents.push(taxRecord)
    }

    if (config.includeAppraiserReport) {
      const appraiserReport = await fetchAppraiserSiteReport(listing)
      documents.push(appraiserReport)
    }

    // Update packet job with generated content stored in config jsonb
    await supabase
      .from("listing_packet_jobs")
      .update({
        status: "completed",
        config: {
          ...config,
          sections: documents.map(d => d.type),
          content: documents,
        },
      })
      .eq("id", packet.id)

    revalidatePath(`/listings/${config.listingId}`)
    return {
      success: true,
      packetId: packet.id,
      documents: documents,
      message: `Generated ${documents.length} documents for listing packet`,
    }
  } catch (error) {
    console.error("Generate listing packet error:", error)
    return handleError(error, "generateListingPacket")
  }
}

// =====================================================
// AI LISTING FLYER GENERATION
// =====================================================

export async function generateListingFlyer(listing: any) {
  try {
    const { text: flyerContent } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Generate a professional real estate listing flyer for this property:

Property Details:
- Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
- Price: $${listing.list_price?.toLocaleString()}
- Bedrooms: ${listing.bedrooms}
- Bathrooms: ${listing.bathrooms}
- Square Feet: ${listing.square_feet?.toLocaleString()}
- Year Built: ${listing.year_built}
- Lot Size: ${listing.lot_size}
- Property Type: ${listing.property_type}
- MLS#: ${listing.mls_number}

Special Features: ${listing.features?.join(", ") || "N/A"}
Description: ${listing.description || "Beautiful property in excellent condition"}

Agent: ${listing.agents?.first_name} ${listing.agents?.last_name}
Phone: ${listing.agents?.phone}
Email: ${listing.agents?.email}

Generate a compelling flyer with:
1. Attention-grabbing headline
2. Key property highlights (bullet points)
3. Neighborhood/area highlights
4. Call to action
5. Open house information placeholder

Return as JSON:
{
  "headline": "...",
  "subheadline": "...",
  "highlights": ["...", "..."],
  "description": "...",
  "neighborhoodInfo": "...",
  "callToAction": "...",
  "layout": "modern" | "classic" | "luxury"
}`,
    })

    const flyerData = JSON.parse(flyerContent)

    return {
      type: "listing_flyer",
      name: `Listing Flyer - ${listing.address}`,
      content: flyerData,
      status: "generated" as const,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("Generate flyer error:", error)
    return {
      type: "listing_flyer",
      name: `Listing Flyer - ${listing.address}`,
      status: "error" as const,
    }
  }
}

// =====================================================
// SELLER DISCLOSURE COMPILATION
// =====================================================

export async function compileSellerDisclosure(listing: any) {
  const supabase = await createClient()

  try {
    // Fetch existing disclosure documents for this listing
    const { data: disclosures } = await supabase
      .from("client_documents")
      .select("*")
      .eq("listing_id", listing.id)
      .ilike("document_category", "%disclosure%")

    // Get state-specific disclosure requirements
    const stateRequirements = getStateDisclosureRequirements(listing.state)

    // Use AI to compile and verify completeness
    const { text: analysisResult } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Analyze seller disclosure completeness for ${listing.state}:

Required disclosures for ${listing.state}:
${stateRequirements.join("\n")}

Documents on file:
${disclosures?.map((d) => d.document_name).join("\n") || "None"}

Property: ${listing.address}

Return JSON:
{
  "completionStatus": "complete" | "incomplete" | "needs_review",
  "missingDisclosures": ["..."],
  "presentDisclosures": ["..."],
  "recommendations": ["..."],
  "complianceScore": 0-100
}`,
    })

    const analysis = JSON.parse(analysisResult)

    return {
      type: "seller_disclosure",
      name: `Seller Disclosure Package - ${listing.address}`,
      content: {
        analysis,
        documents: disclosures,
        stateRequirements,
      },
      status: "generated" as const,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("Compile disclosure error:", error)
    return {
      type: "seller_disclosure",
      name: `Seller Disclosure Package`,
      status: "error" as const,
    }
  }
}

// =====================================================
// SELLER UTILITIES FORM
// =====================================================

export async function generateUtilitiesForm(listing: any) {
  try {
    const { text: utilitiesContent } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate a seller utilities form for property at ${listing.address}, ${listing.city}, ${listing.state}.

Create a comprehensive utilities information form that sellers typically fill out, including:
1. Electric company and average monthly cost
2. Gas company and average monthly cost
3. Water/sewer provider and average monthly cost
4. Trash service provider
5. Internet/cable providers available
6. HOA information (if applicable)
7. Property tax information
8. Any special assessments

Return as JSON with form fields and any pre-filled information based on the location.`,
    })

    const formData = JSON.parse(utilitiesContent)

    return {
      type: "utilities_form",
      name: `Seller Utilities Form - ${listing.address}`,
      content: formData,
      status: "generated" as const,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("Generate utilities form error:", error)
    return {
      type: "utilities_form",
      name: `Seller Utilities Form`,
      status: "error" as const,
    }
  }
}

// =====================================================
// GIS MAP PROPERTY REPORT
// =====================================================

export async function fetchGISPropertyReport(listing: any) {
  try {
    // In production, this would call actual GIS APIs
    // For now, generate AI-enhanced property report
    const { text: gisContent } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Generate a GIS property report summary for:
Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
Lot Size: ${listing.lot_size}

Include typical GIS report information:
1. Parcel boundaries description
2. Zoning classification
3. Flood zone status
4. School district
5. Utilities availability
6. Easements (typical for area)
7. Environmental considerations
8. Nearby amenities distances

Return as JSON with sections for each category.`,
    })

    const gisData = JSON.parse(gisContent)

    return {
      type: "gis_report",
      name: `GIS Property Report - ${listing.address}`,
      content: {
        ...gisData,
        generatedFrom: "AI-enhanced (connect to county GIS for official data)",
        disclaimer: "This is a preliminary report. Official GIS data should be verified with county records.",
      },
      status: "generated" as const,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("Fetch GIS report error:", error)
    return {
      type: "gis_report",
      name: `GIS Property Report`,
      status: "error" as const,
    }
  }
}

// =====================================================
// TAX RECORD REPORT
// =====================================================

export async function fetchTaxRecordReport(listing: any) {
  try {
    // In production, integrate with county assessor APIs
    const { text: taxContent } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate a property tax record summary for:
Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
List Price: $${listing.list_price}

Include typical tax record information:
1. Assessed value (estimate based on list price)
2. Annual property tax estimate
3. Tax rate for the area
4. Tax payment schedule
5. Any exemptions that may apply
6. Recent assessment history pattern
7. School taxes breakdown
8. Special district taxes

Return as JSON.`,
    })

    const taxData = JSON.parse(taxContent)

    return {
      type: "tax_record",
      name: `Tax Record Report - ${listing.address}`,
      content: {
        ...taxData,
        disclaimer: "Tax estimates only. Verify with county assessor for official records.",
        dataSource: "AI-estimated (connect to county assessor API for official data)",
      },
      status: "generated" as const,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("Fetch tax record error:", error)
    return {
      type: "tax_record",
      name: `Tax Record Report`,
      status: "error" as const,
    }
  }
}

// =====================================================
// APPRAISER SITE PROPERTY REPORT
// =====================================================

export async function fetchAppraiserSiteReport(listing: any) {
  try {
    const { text: appraiserContent } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Generate an appraiser-style property report for:
Address: ${listing.address}, ${listing.city}, ${listing.state} ${listing.zip}
Property Type: ${listing.property_type}
Bedrooms: ${listing.bedrooms}
Bathrooms: ${listing.bathrooms}
Square Feet: ${listing.square_feet}
Year Built: ${listing.year_built}
Lot Size: ${listing.lot_size}
List Price: $${listing.list_price}

Generate report sections:
1. Property identification and legal description format
2. Site analysis (topography, utilities, access)
3. Improvements description
4. Comparable properties consideration
5. Market conditions summary
6. Value indicators
7. Special considerations

Return as JSON with professional appraiser report formatting.`,
    })

    const appraiserData = JSON.parse(appraiserContent)

    return {
      type: "appraiser_report",
      name: `Appraiser Site Report - ${listing.address}`,
      content: {
        ...appraiserData,
        disclaimer:
          "This is not an official appraisal. For lending purposes, a licensed appraiser must be engaged.",
        reportType: "Property Information Summary",
      },
      status: "generated" as const,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    console.error("Fetch appraiser report error:", error)
    return {
      type: "appraiser_report",
      name: `Appraiser Site Report`,
      status: "error" as const,
    }
  }
}

// =====================================================
// GET LISTING PACKET STATUS
// =====================================================

export async function getListingPacketStatus(listingId: string) {
  if (!isValidUUID(listingId)) {
    return { success: false, error: "Invalid listing ID" }
  }

  const supabase = await createClient()

  try {
    const { data: packets, error } = await supabase
      .from("listing_packet_jobs")
      .select("*")
      .eq("listing_id", listingId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, packets }
  } catch (error) {
    console.error("Get packet status error:", error)
    return handleError(error, "getListingPacketStatus")
  }
}

// =====================================================
// AI PACKET QUALITY CHECK
// =====================================================

export async function aiPacketQualityCheck(packetId: string) {
  if (!isValidUUID(packetId)) {
    return { success: false, error: "Invalid packet ID" }
  }

  const supabase = await createClient()

  try {
    const { data: packet } = await supabase.from("listing_packet_jobs").select("*").eq("id", packetId).single()

    if (!packet) {
      return { success: false, error: "Packet not found" }
    }

    // Extract documents from config.content
    const documents = packet.config?.content || []

    const { text: qualityResult } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Review this listing packet for quality and completeness:

Documents included:
${JSON.stringify(documents, null, 2)}

Configuration:
${JSON.stringify(packet.config, null, 2)}

Evaluate:
1. Document completeness (all requested items generated?)
2. Content quality (professional, accurate, compliant?)
3. Missing critical information
4. Compliance with real estate disclosure requirements
5. Presentation readiness for property display

Return JSON:
{
  "overallScore": 0-100,
  "completeness": 0-100,
  "quality": 0-100,
  "compliance": 0-100,
  "issues": ["..."],
  "recommendations": ["..."],
  "readyForDisplay": true/false
}`,
    })

    const qualityCheck = JSON.parse(qualityResult)

    // Update packet job with quality check in config
    await supabase
      .from("listing_packet_jobs")
      .update({
        config: {
          ...packet.config,
          quality_check: qualityCheck,
          quality_checked_at: new Date().toISOString(),
        },
      })
      .eq("id", packetId)

    return { success: true, qualityCheck }
  } catch (error) {
    console.error("AI packet quality check error:", error)
    return handleError(error, "aiPacketQualityCheck")
  }
}

// =====================================================
// REGENERATE SPECIFIC DOCUMENT
// =====================================================

export async function regeneratePacketDocument(params: {
  packetId: string
  documentType: string
  customInstructions?: string
}) {
  if (!isValidUUID(params.packetId)) {
    return { success: false, error: "Invalid packet ID" }
  }

  const supabase = await createClient()

  try {
    const { data: packet } = await supabase
      .from("listing_packet_jobs")
      .select("*, listings:listing_id(*)")
      .eq("id", params.packetId)
      .single()

    if (!packet) {
      return { success: false, error: "Packet not found" }
    }

    let newDocument: PacketDocument

    switch (params.documentType) {
      case "listing_flyer":
        newDocument = await generateListingFlyer(packet.listings)
        break
      case "seller_disclosure":
        newDocument = await compileSellerDisclosure(packet.listings)
        break
      case "utilities_form":
        newDocument = await generateUtilitiesForm(packet.listings)
        break
      case "gis_report":
        newDocument = await fetchGISPropertyReport(packet.listings)
        break
      case "tax_record":
        newDocument = await fetchTaxRecordReport(packet.listings)
        break
      case "appraiser_report":
        newDocument = await fetchAppraiserSiteReport(packet.listings)
        break
      default:
        return { success: false, error: "Unknown document type" }
    }

    // Update documents in config.content
    const existingContent = packet.config?.content || []
    const updatedDocs = existingContent.map((doc: PacketDocument) =>
      doc.type === params.documentType ? newDocument : doc
    )

    await supabase
      .from("listing_packet_jobs")
      .update({
        config: {
          ...packet.config,
          content: updatedDocs,
          sections: updatedDocs.map((d: PacketDocument) => d.type),
        },
      })
      .eq("id", params.packetId)

    return { success: true, document: newDocument }
  } catch (error) {
    console.error("Regenerate document error:", error)
    return handleError(error, "regeneratePacketDocument")
  }
}

// =====================================================
// STATE DISCLOSURE REQUIREMENTS
// =====================================================

function getStateDisclosureRequirements(state: string): string[] {
  const requirements: Record<string, string[]> = {
    CA: [
      "Transfer Disclosure Statement (TDS)",
      "Natural Hazard Disclosure (NHD)",
      "Seller Property Questionnaire (SPQ)",
      "Lead-Based Paint Disclosure",
      "Smoke Detector Compliance",
      "Water Heater Bracing",
      "Megan's Law Disclosure",
    ],
    TX: [
      "Seller's Disclosure Notice",
      "Lead-Based Paint Disclosure",
      "MUD/PID Disclosure (if applicable)",
      "Property Tax Information",
    ],
    FL: [
      "Seller's Property Disclosure",
      "Lead-Based Paint Disclosure",
      "Radon Gas Disclosure",
      "HOA Disclosure (if applicable)",
      "Energy-Efficiency Rating Disclosure",
    ],
    NY: [
      "Property Condition Disclosure Statement",
      "Lead-Based Paint Disclosure",
      "Smoke/CO Detector Compliance",
      "Bed Bug Infestation History",
    ],
    // Add more states as needed
    DEFAULT: [
      "Seller's Property Disclosure",
      "Lead-Based Paint Disclosure (pre-1978)",
      "Known Defects Disclosure",
      "HOA Documents (if applicable)",
    ],
  }

  return requirements[state] || requirements.DEFAULT
}

// =====================================================
// AUTO-GENERATE PACKET AFTER LISTING GOES LIVE
// =====================================================

export async function autoGeneratePacketOnLive(listingId: string, agentId: string) {
  // Default configuration for auto-generation
  const defaultConfig: ListingPacketConfig = {
    listingId,
    agentId,
    includeFlyer: true,
    includeSellerDisclosure: true,
    includeUtilitiesForm: true,
    includeGISReport: true,
    includeTaxRecord: true,
    includeAppraiserReport: true,
    createPhysicalBinder: true,
    deliveryMethod: "both",
    copies: 2,
  }

  return generateListingPacket(defaultConfig)
}
