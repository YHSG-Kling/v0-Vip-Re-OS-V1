"use server"

/**
 * System 5.3: CMA & Listing Presentation Engine
 * Presentation Assembler
 *
 * Assembles complete listing presentation from CMA, net sheet, and marketing plan.
 * DOES NOT advance journey - only emits completion signals.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "GENERATE PRESENTATION" USED TO DO, AND WHY IT LOOKED LIKE IT WORKED.
 *
 * This is the function behind the CMA → Presentation tab's "Generate
 * Presentation" button, and it NEVER PRODUCED A PRESENTATION:
 *
 *   const presentationId = crypto.randomUUID()
 *
 * That id was invented, written into an activity's metadata, and returned. No
 * listing_presentations row was ever inserted, so
 * /dashboard/listings/presentations/{that id} was a guaranteed 404 — there was
 * nothing to open. The "presentation" itself was a hardcoded markdown template
 * (assemblePresentationContent) built from an if-ladder of generic marketing
 * copy, and it was thrown away the moment it was measured: only its
 * content_length reached the database. The toast said "CMA presentation
 * generated — ready for seller decision" and the status card ticked
 * "Presentation Assembled: Complete" over exactly nothing.
 *
 * THE SURVIVOR. lib/listing-presentation/generate-ai-presentation.ts writes a
 * REAL listing_presentations row with a real AI narrative (sections, pricing
 * strategy, marketing plan, objection handlers, appendix) and enforces ONE ROW
 * PER APPOINTMENT so a seller can never be enrolled in two pre-listing drips.
 * It is reached here through its authenticated door,
 * app/actions/ai-listing-presentation.ts::generateListingPresentation, which
 * derives the tenant from the session rather than taking it from this caller.
 *
 * NOTHING WAS LOST IN THE MERGE. The template carried exactly one input the
 * survivor did not accept — the agent's customMessage — so `agentMessage` was
 * added to the survivor first and is passed below. highlightFeatures fold into
 * propertyData.features. Everything else the template "carried" (the marketing
 * plan, the next-steps list, the CMA/net-sheet sections) was generic prose that
 * the survivor generates against the real property, comps and market data.
 *
 * THE SECOND DEFECT. checkCMAExists() looked for an `activities` row with
 * listing_id + 'seller.cma.completed', but generateCMA writes that activity with
 * entity_type:'contact' and NO listing_id — so hasCMA was false on every run
 * this workflow has ever made. readyForDecision (hasCMA && hasNetSheet) could
 * therefore never be true, and "Ready for Decision" always read "Not yet" even
 * with a CMA sitting in cma_reports. It now reads cma_reports directly, which is
 * where generateAICMA actually puts it, and a REFUSED read is reported rather
 * than being folded into "no CMA".
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { createVideoProject } from "@/app/actions/video/create-video-project"
import { generateListingPresentation } from "@/app/actions/ai-listing-presentation"

export interface PresentationInput {
  listingId: string
  contactId: string
  agentId: string
  brokerageId?: string
  
  /**
   * Component selection.
   *
   * includeCMA / includeNetSheet gate the PRE-FLIGHT CHECK, not the content: a
   * missing artifact is reported as a warning and keeps readyForDecision false.
   * includeMarketingPlan is recorded on the activity; the AI narrative always
   * produces a marketing plan, so it does not suppress one — stated here rather
   * than left looking like a switch that does nothing.
   */
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

    // pass 13: activities.agent_user_id FKs users(id) but callers pass MIXED
    // classes (the presentation tab passes listing.agent_id = agents.id).
    // Resolve tolerantly so both classes land the users.id — and keep the
    // AGENTS-class id too, because the narrative producer keys agents(id).
    const { data: presIdRow } = await supabase
      .from("agents").select("id, user_id")
      .or(`id.eq.${input.agentId},user_id.eq.${input.agentId}`)
      .maybeSingle()
    const presAgentUserId = presIdRow?.user_id ?? input.agentId
    const presAgentRecordId = presIdRow?.id ?? null

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

    // Check for required components. A REFUSED read is not "no artifact" —
    // reporting one as the other is what made this workflow look complete while
    // producing nothing, so both surface their error as a warning.
    const cmaCheck = await checkCMAExists(input.listingId)
    const netSheetCheck = await checkNetSheetExists(input.listingId)
    const hasCMA = cmaCheck.exists
    const hasNetSheet = netSheetCheck.exists
    if (cmaCheck.error) warnings.push(`CMA lookup failed: ${cmaCheck.error}`)
    if (netSheetCheck.error) warnings.push(`Net sheet lookup failed: ${netSheetCheck.error}`)

    if (input.includeCMA && !hasCMA) {
      warnings.push("CMA not found - must be generated first")
    }

    if (input.includeNetSheet && !hasNetSheet) {
      warnings.push("Net sheet not found - must be generated first")
    }

    // ── THE PRESENTATION ITSELF ──────────────────────────────────────────────
    // A real listing_presentations row, written by the canonical narrative
    // producer through its authenticated door. See the file header for what this
    // replaced.
    if (!presAgentRecordId) {
      return {
        success: false,
        error: "No agent record found for this listing — link an agent before generating a presentation",
      }
    }

    // ONE PRESENTATION PER LISTING APPOINTMENT. If this seller already has a
    // booked listing appointment on this listing, the narrative is written onto
    // that appointment's presentation instead of creating a second one (a second
    // row would materialize a second pre-listing drip for one seller).
    const { data: appt, error: apptErr } = await supabase
      .from("calendar_events")
      .select("id, start_at")
      .eq("event_type", "listing_appointment")
      .eq("entity_type", "listing")
      .eq("entity_id", input.listingId)
      .gte("start_at", new Date().toISOString())
      .order("start_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (apptErr) warnings.push(`Listing appointment lookup failed: ${apptErr.message}`)

    // The seller's own upgrades since purchase — the owner's CMA ruling. Read
    // from property_upgrades, the same row the CMA and the appraiser packet use,
    // so all three describe the same work.
    const { loadSellerUpgradesForListing } = await import("@/lib/cma/seller-upgrades")
    const sellerUpgrades = listing.brokerage_id
      ? await loadSellerUpgradesForListing({
          listingId: input.listingId,
          brokerageId: listing.brokerage_id,
        })
      : []
    const sellerUpgradeLines = sellerUpgrades.map((u) =>
      u.estimatedCost ? `${u.description} (~$${Math.round(u.estimatedCost).toLocaleString()})` : u.description,
    )

    const narrative = await generateListingPresentation({
      agentId:       presAgentRecordId,
      contactId:     input.contactId,
      appointmentId: appt?.id ?? null,
      appointmentAt: appt?.start_at ?? null,
      propertyData: {
        address:      listing.address ?? "",
        city:         listing.city ?? "",
        state:        (listing.state ?? "").trim().toUpperCase(),
        zipCode:      listing.zip ?? "",
        bedrooms:     Number(listing.bedrooms ?? 0),
        bathrooms:    Number(listing.bathrooms ?? 0),
        // `sqft`, NOT `square_feet` — listings has no square_feet column (checked
        // against information_schema). The neighbouring CMA path read the phantom
        // name and therefore valued every listing at 0 sqft.
        sqft:         Number(listing.sqft ?? 0),
        lotSize:      listing.lot_size ?? undefined,
        yearBuilt:    listing.year_built ?? undefined,
        // NOT defaulted to "single_family". listings.property_type is nullable
        // and null on real rows today; telling the narrative a condo is a
        // single-family home would be a fabricated property fact.
        propertyType: listing.property_type ?? "unspecified",
        // The agent's highlights, plus the seller's OWN recorded upgrades. There
        // is no `features` column on listings, so the upgrades table — the same
        // one the CMA and the appraiser packet read — is the honest source.
        features: [
          ...(input.highlightFeatures ?? []),
          ...sellerUpgradeLines,
        ],
      },
      sellerInfo: {
        name: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "the seller",
      },
      agentMessage: input.customMessage,
    })

    // A refused or failed generation is a FAILED assembly. Emitting
    // seller.presentation.created here is what taught every downstream reader
    // that a presentation existed when none did.
    if (!narrative.success || !narrative.presentationId) {
      return {
        success: false,
        error: narrative.error ?? "Presentation generation returned no presentation",
        warnings: warnings.length > 0 ? warnings : undefined,
      }
    }
    const presentationId = narrative.presentationId

    // Emit presentation created event — Agent task (correct location, no changes) — type: seller.presentation.created, seller.decision.ready
    await supabase.from("activities").insert({
      activity_type: "seller.presentation.created",
      listing_id: input.listingId,
      contact_id: input.contactId,
      agent_user_id: presAgentUserId,
      metadata: {
        presentation_id: presentationId,
        has_cma: hasCMA,
        has_net_sheet: hasNetSheet,
        has_marketing_plan: input.includeMarketingPlan !== false,
        // True when the narrative landed on the presentation the prep cron had
        // already built for this appointment, rather than creating a new row.
        attached_to_existing: narrative.attachedToExisting === true,
      }
    })

    // GOVERNANCE VOCABULARY. The row above says `seller.presentation.created`, but
    // presentation-readiness (the gate on the seller's decision) reads
    // `seller.presentation.assembled`. Nothing wrote that, so
    // derivePresentationReadinessFromEvents always returned null and the
    // presentation check reported "No presentation data found" for listings whose
    // presentation had in fact just been assembled. logPresentationActivity is the
    // canonical writer of that vocabulary. Best-effort — the presentation exists
    // either way.
    try {
      const { logPresentationActivity } = await import("@/app/actions/seller-decision-governance")
      const gov = await logPresentationActivity({
        listing_id: input.listingId,
        event_type: "assembled",
        metadata: { presentation_id: presentationId, has_cma: hasCMA, has_net_sheet: hasNetSheet },
      })
      if (!gov.success) {
        console.error("[presentation] governance row NOT written:", gov.error)
      }
    } catch (err) {
      console.error("[presentation] governance row NOT written:", err)
    }

    // Generate video if requested
    let videoProjectId: string | undefined
    if (input.includeVideo) {
      const videoResult = await generatePresentationVideo({
        listingId: input.listingId,
        contactId: input.contactId,
        // resolved users.id — activities.agent_user_id is USERS-class
        agentId: presAgentUserId,
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
        activity_type: "seller.decision.ready",
        listing_id: input.listingId,
        contact_id: input.contactId,
        agent_user_id: presAgentUserId,
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
 * Generate presentation video
 */
async function generatePresentationVideo(params: {
  listingId: string
  contactId: string
  agentId: string
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

    // Generate video script from the listing's own facts.
    const videoScript = generateVideoScript(listing)

    // Create a real video project on the canonical path (ai_video_projects;
    // provider resolved by resolveVideoProvider — D-ID default). The project is
    // created in 'draft' so the agent can confirm avatar/voice and submit; this
    // replaces the former stub that wrote dead columns and a fake 'processing'.
    const videoResult = await createVideoProject({
      brokerageId: listing.brokerage_id,
      agentUserId: params.agentId,
      title: `Listing Tour — ${listing.address ?? "Property"}`,
      script: videoScript,
      videoType: "listing_tour",
      backgroundType: "property",
      format: "horizontal",
      durationSeconds: 120,
      captionsEnabled: true,
      listingId: params.listingId,
    })

    if (videoResult.success && videoResult.project) {
      // Emit video generation event — type: seller.presentation.video_generated
      await supabase.from("activities").insert({
        activity_type: "seller.presentation.video_generated",
        listing_id: params.listingId,
        contact_id: params.contactId,
        agent_user_id: params.agentId,
        metadata: {
          video_project_id: videoResult.project.id,
          video_status: videoResult.project.status
        }
      })

      // Same vocabulary gap as `assembled` above — the readiness engine reads
      // `seller.presentation_video.ready`, not `seller.presentation.video_generated`.
      try {
        const { logPresentationActivity } = await import("@/app/actions/seller-decision-governance")
        const gov = await logPresentationActivity({
          listing_id: params.listingId,
          event_type: "video_ready",
          metadata: { video_project_id: videoResult.project.id, video_status: videoResult.project.status },
        })
        if (!gov.success) {
          console.error("[presentation] video governance row NOT written:", gov.error)
        }
      } catch (err) {
        console.error("[presentation] video governance row NOT written:", err)
      }

      return { success: true, projectId: videoResult.project.id }
    }

    return { success: false }
  } catch (error) {
    console.error("[System 5.3] Video generation error:", error)
    return { success: false }
  }
}

/**
 * Generate video script from the listing.
 *
 * It used to take the assembled markdown as a second argument and never read
 * it — the script has always been composed from the listing row alone. The
 * parameter is gone rather than left as a lie about what shapes this script.
 */
function generateVideoScript(listing: any): string {
  const address = listing.address || "this beautiful property"
  const beds = listing.bedrooms || "multiple"
  const baths = listing.bathrooms || "multiple"
  
  return `Welcome! I'm excited to present the marketing strategy for ${address}. This ${beds} bedroom, ${baths} bathroom property has tremendous potential in today's market. I've prepared a comprehensive analysis including comparable sales, estimated proceeds, and our proven marketing approach. Together, we'll maximize your property's value and achieve your goals. Let's discuss how we can make this a successful sale.`
}

/** An artifact check that can tell "not there" from "could not look". */
interface ArtifactCheck { exists: boolean; error?: string }

/**
 * Does this listing have a CMA?
 *
 * READS cma_reports, NOT activities. The previous version looked for an
 * `activities` row carrying listing_id + 'seller.cma.completed', and
 * app/actions/cma-presentation/cma-generator.ts writes that activity with
 * entity_type:'contact' and contact_id — never listing_id. So the query matched
 * nothing on every run this workflow has ever made: hasCMA was permanently
 * false, `readyForDecision` (hasCMA && hasNetSheet) could never be true, and the
 * agent saw "Ready for Decision: Not yet" with a finished CMA on file.
 * cma_reports.listing_id is written by generateAICMA and is the fact itself
 * rather than a notification about it.
 */
async function checkCMAExists(listingId: string): Promise<ArtifactCheck> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("cma_reports")
    .select("id")
    .eq("listing_id", listingId)
    .limit(1)

  // A refused read is NOT "no CMA" — saying so is how a seller's finished
  // analysis gets silently regenerated or reported missing.
  if (error) return { exists: false, error: error.message }
  return { exists: (data?.length ?? 0) > 0 }
}

/**
 * Does this listing have a net sheet?
 *
 * This one legitimately reads activities: net-sheet-calculator.ts writes
 * `seller.net_sheet.completed` WITH listing_id (there is no net-sheet table of
 * its own), so the row is the record. The error is now checked for the same
 * reason as above.
 */
async function checkNetSheetExists(listingId: string): Promise<ArtifactCheck> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("activities")
    .select("id")
    .eq("listing_id", listingId)
    .eq("activity_type", "seller.net_sheet.completed")
    .limit(1)

  if (error) return { exists: false, error: error.message }
  return { exists: (data?.length ?? 0) > 0 }
}
