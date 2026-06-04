/**
 * Chain: listing-appt-prep
 *
 * Triggered when an agent schedules a listing appointment on a contact.
 * No listing record exists yet — everything runs against the contact +
 * property data captured at appointment scheduling.
 *
 * Steps:
 *   1. generate_cma         — runs canonical CMA pipeline against property data
 *   2. generate_presentation — builds listing presentation from CMA output
 *   3. generate_chapter_videos — produces N short videos (one per chapter)
 *      using DID avatar + agent's cloned voice
 *   4. enroll_drip          — schedules each chapter video as a touchpoint
 *      timed to land before the appointment date
 *   5. send_pre_listing_kit — Wave 36. Mails a physical Lob kit
 *      (letter + postcard) to the contact's verified mailing address,
 *      scheduled to arrive 2-3 days before the appointment. The kit
 *      "sells the system before setting foot in the home" — referencing
 *      the chapter-video drip the contact is already receiving so the
 *      mailer reinforces a coordinated, tech-forward presentation. Soft-
 *      fails if no verified address exists (the digital drip is still
 *      enough on its own) — never blocks the chain.
 *
 * The agent gets a notification at each step's completion. By default the
 * chain runs to completion automatically; CMA and presentation steps can be
 * gated for human approval if the brokerage opts in.
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { WorkflowChain } from "../types"
import { generatePropertyChapterVideos } from "@/lib/video/chapter-video-generator"
import { resolveMailingAddressForContact } from "@/lib/contacts/resolve-mailing-address"
import { dispatchDirectMail } from "@/lib/providers/dispatch"

export const listingApptPrepChain: WorkflowChain = {
  key: "listing-appt-prep",
  label: "Listing Appointment Prep",
  triggerEvent: "listing.appointment_set",
  steps: [
    // -----------------------------------------------------------------------
    // 1. Generate CMA
    // -----------------------------------------------------------------------
    {
      key: "generate_cma",
      label: "Generate CMA",
      handler: async (ctx) => {
        const svc = createServiceClient()
        const propertyData = ctx.metadata.property_data
        if (!propertyData?.address) {
          return { success: false, error: "Missing property data on appointment" }
        }
        if (!ctx.contactId || !ctx.agentUserId) {
          return { success: false, error: "Missing contact or agent context" }
        }

        // Resolve agent row (generateAICMA expects an agents.id, not a users.id)
        const { data: agent } = await svc
          .from("agents")
          .select("id")
          .eq("user_id", ctx.agentUserId)
          .maybeSingle()

        if (!agent) return { success: false, error: "Agent profile not found" }

        // Use the canonical CMA generator. We import dynamically to avoid
        // bundling server-action code into the lib layer at edge.
        const { generateAICMA } = await import("@/app/actions/ai-cma")
        const cma = await generateAICMA({
          agentId: agent.id,
          contactId: ctx.contactId,
          address: propertyData.address,
          city: propertyData.city,
          state: propertyData.state,
          zipCode: propertyData.zip ?? propertyData.zipCode,
          bedrooms: propertyData.bedrooms,
          bathrooms: propertyData.bathrooms,
          sqft: propertyData.sqft,
          lotSize: propertyData.lotSize,
          yearBuilt: propertyData.yearBuilt,
          propertyType: propertyData.propertyType ?? "single_family",
          condition: propertyData.condition ?? "average",
        } as any)

        if (!cma.success) {
          return { success: false, error: cma.error ?? "CMA generation failed" }
        }

        return {
          success: true,
          output: {
            cmaId: cma.id ?? cma.cmaId,
            valuation: cma.valuation,
            pricingStrategy: cma.pricingStrategy,
          },
        }
      },
      retry: { max: 1, delayMs: 2000 },
    },

    // -----------------------------------------------------------------------
    // 2. Generate Listing Presentation (uses CMA output)
    // -----------------------------------------------------------------------
    {
      key: "generate_presentation",
      label: "Generate Listing Presentation",
      handler: async (ctx) => {
        const svc = createServiceClient()
        const propertyData = ctx.metadata.property_data
        if (!ctx.agentUserId) return { success: false, error: "Missing agent context" }

        const { data: agent } = await svc
          .from("agents")
          .select("id")
          .eq("user_id", ctx.agentUserId)
          .maybeSingle()
        if (!agent) return { success: false, error: "Agent profile not found" }

        // Pull seller name from contact
        let sellerName: string | undefined
        if (ctx.contactId) {
          const { data: c } = await svc
            .from("contacts")
            .select("first_name, last_name")
            .eq("id", ctx.contactId)
            .maybeSingle()
          sellerName = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || undefined
        }

        const { generateListingPresentation } = await import("@/app/actions/ai-listing-presentation")
        const result: any = await generateListingPresentation({
          agentId: agent.id,
          propertyData: {
            address: propertyData.address,
            city: propertyData.city,
            state: propertyData.state,
            zipCode: propertyData.zip ?? propertyData.zipCode ?? "",
            bedrooms: propertyData.bedrooms ?? 0,
            bathrooms: propertyData.bathrooms ?? 0,
            sqft: propertyData.sqft ?? 0,
            lotSize: propertyData.lotSize,
            yearBuilt: propertyData.yearBuilt,
            propertyType: propertyData.propertyType ?? "single_family",
            features: propertyData.features,
            condition: propertyData.condition,
            sellerMotivation: ctx.metadata.seller_motivation,
            timeline: ctx.metadata.timeline,
          },
          sellerInfo: sellerName ? { name: sellerName } : undefined,
          presentationType: "full",
        })

        if (!result?.success) {
          return { success: false, error: result?.error ?? "Presentation generation failed" }
        }

        return {
          success: true,
          output: {
            presentationId: result.presentationId ?? result.id,
            chapters: result.chapters ?? result.sections ?? [],
            content: result.content ?? result.presentation,
          },
        }
      },
      retry: { max: 1, delayMs: 2000 },
    },

    // -----------------------------------------------------------------------
    // 3. Generate per-chapter videos (one short video per presentation chapter)
    // -----------------------------------------------------------------------
    {
      key: "generate_chapter_videos",
      label: "Generate Chapter Videos",
      handler: async (ctx) => {
        const presentation = ctx.previousStepOutputs.generate_presentation
        if (!presentation) {
          return { success: false, error: "No presentation in previous step output" }
        }

        const result = await generatePropertyChapterVideos({
          brokerageId: ctx.brokerageId,
          agentUserId: ctx.agentUserId ?? null,
          contactId: ctx.contactId ?? null,
          presentationId: presentation.presentationId,
          chapters: presentation.chapters?.length
            ? presentation.chapters
            : DEFAULT_CHAPTERS,
          presentationContent: presentation.content,
          propertyData: ctx.metadata.property_data,
        })

        if (!result.success) {
          return { success: false, error: result.error }
        }

        return {
          success: true,
          output: {
            videoIds: result.videoIds,
            chapterTitles: result.chapterTitles,
          },
        }
      },
      retry: { max: 1, delayMs: 5000 },
    },

    // -----------------------------------------------------------------------
    // 4. Enroll contact in pre-appointment drip — one chapter per touchpoint
    // -----------------------------------------------------------------------
    {
      key: "enroll_drip",
      label: "Enroll in Pre-Appointment Drip",
      handler: async (ctx) => {
        const videos = ctx.previousStepOutputs.generate_chapter_videos
        const apptDate = ctx.metadata.appointment_date
        if (!videos?.videoIds?.length) {
          return { success: false, error: "No chapter videos available for drip" }
        }
        if (!apptDate) {
          return { success: false, error: "Missing appointment_date in metadata" }
        }
        if (!ctx.contactId) {
          return { success: false, error: "Missing contactId" }
        }

        const svc = createServiceClient()

        // Distribute video touchpoints evenly between now and appointment date
        const apptTime = new Date(apptDate).getTime()
        const now = Date.now()
        const totalSpan = Math.max(apptTime - now, 24 * 60 * 60 * 1000) // min 24h
        const count = videos.videoIds.length
        const interval = totalSpan / (count + 1) // leave a gap before appt

        const touchpoints = videos.videoIds.map((videoId: string, i: number) => ({
          contact_id: ctx.contactId,
          brokerage_id: ctx.brokerageId,
          touchpoint_type: "video",
          subject: videos.chapterTitles?.[i] ?? `Chapter ${i + 1}`,
          metadata: {
            video_id: videoId,
            chapter_index: i,
            chapter_title: videos.chapterTitles?.[i],
            chain_run_id: ctx.runId,
          },
          scheduled_for: new Date(now + interval * (i + 1)).toISOString(),
          status: "scheduled",
        }))

        // Use the activities table as the touchpoint store — every activity
        // shows on the contact's CRM timeline automatically.
        const { error } = await svc.from("activities").insert(
          touchpoints.map((t: typeof touchpoints[number]) => ({
            contact_id: t.contact_id,
            brokerage_id: t.brokerage_id,
            agent_user_id: ctx.agentUserId,
            activity_type: "scheduled_video_touchpoint",
            description: `Pre-listing chapter video: ${t.subject}`,
            metadata: t.metadata,
            scheduled_for: t.scheduled_for,
          }))
        )

        if (error) {
          return { success: false, error: error.message }
        }

        return {
          success: true,
          output: {
            touchpointsScheduled: touchpoints.length,
            firstTouchAt: touchpoints[0].scheduled_for,
            lastTouchAt: touchpoints[touchpoints.length - 1].scheduled_for,
          },
        }
      },
    },

    // -----------------------------------------------------------------------
    // 5. Send pre-listing physical kit (Wave 36)
    //    Lob letter + postcard mailed to the contact's verified address,
    //    timed to arrive 2-3 days before the appointment. Soft-fails so
    //    the digital drip alone still completes the chain cleanly.
    // -----------------------------------------------------------------------
    {
      key: "send_pre_listing_kit",
      label: "Send Pre-Listing Physical Kit",
      handler: async (ctx) => {
        if (!ctx.contactId) {
          return { success: true, output: { skipped: true, reason: "no_contact_id" } }
        }

        const apptDateRaw = ctx.metadata.appointment_date
        if (!apptDateRaw) {
          return { success: true, output: { skipped: true, reason: "no_appointment_date" } }
        }

        // The kit should land 2-3 days before the appointment. Lob's
        // typical first-class transit is 4-7 days for postcards and
        // 5-8 for letters; if the appointment is < 7 days out the kit
        // wouldn't arrive in time, so we soft-skip to avoid wasting
        // spend on a piece the contact would receive AFTER the
        // appointment.
        const apptTime = new Date(apptDateRaw).getTime()
        const leadDays = Math.floor((apptTime - Date.now()) / 86_400_000)
        if (leadDays < 7) {
          return {
            success: true,
            output:  { skipped: true, reason: "appointment_too_soon_for_mail", lead_days: leadDays },
          }
        }

        const address = await resolveMailingAddressForContact({
          contactId:   ctx.contactId,
          brokerageId: ctx.brokerageId,
        })
        if (!address) {
          return {
            success: true,
            output:  { skipped: true, reason: "no_verified_mailing_address" },
          }
        }

        // Pull contact name (the resolver returned only the address).
        const svc = createServiceClient()
        const { data: c } = await svc
          .from("contacts")
          .select("first_name, last_name")
          .eq("id", ctx.contactId)
          .maybeSingle()
        const recipientName = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || "Future Seller"

        // Optional Lob templates the broker uploads ahead of time. If
        // neither is configured this step is a documented no-op rather
        // than a hard failure (the chain still ships the digital drip).
        const letterTpl   = process.env.LOB_PRELISTING_LETTER_TEMPLATE_ID ?? ""
        const postcardTpl = process.env.LOB_PRELISTING_POSTCARD_TEMPLATE_ID ?? ""
        if (!letterTpl && !postcardTpl) {
          return {
            success: true,
            output:  { skipped: true, reason: "no_lob_template_configured" },
          }
        }

        const property = ctx.metadata.property_data ?? {}
        const apptDateIso = new Date(apptTime).toISOString().slice(0, 10)
        const mergeVars: Record<string, string> = {
          first_name:       c?.first_name ?? "",
          property_address: String(property.address ?? ""),
          property_city:    String(property.city ?? ""),
          appointment_date: apptDateIso,
        }

        const sent: Array<{ piece: string; success: boolean; messageId?: string; error?: string }> = []

        for (const [piece, tpl] of [["letter", letterTpl], ["postcard", postcardTpl]] as const) {
          if (!tpl) continue
          const dispatchResult = await dispatchDirectMail({
            brokerageId:    ctx.brokerageId,
            userId:         ctx.agentUserId ?? ctx.brokerageId,
            contactId:      ctx.contactId,
            recipientName,
            mailingAddress: address.street,
            city:           address.city,
            state:          address.state,
            zip:            address.zip,
            templateId:     tpl,
            pieceType:      piece,
            systemSource:   "pre_listing_kit",
            mergeVars,
            metadata: {
              chain_run_id:    ctx.runId,
              appointment_date: apptDateIso,
              address_source:   address.source,
            },
          })
          sent.push({
            piece,
            success:   dispatchResult.success,
            messageId: dispatchResult.messageId,
            error:     dispatchResult.error,
          })

          // Record a direct_mail_campaigns row tagged for the
          // pre-listing analytics cohort so the admin can see
          // pre-listing kit ROI separately from welcome kits.
          await svc.from("direct_mail_campaigns").insert({
            brokerage_id:    ctx.brokerageId,
            agent_id:        ctx.agentUserId ?? null,
            contact_id:      ctx.contactId,
            campaign_name:   `Pre-Listing Kit (${piece}) - ${recipientName}`,
            target_audience: "pre_listing_kit",
            quantity:        1,
            status:          dispatchResult.success ? "sent" : "failed",
            piece_type:      piece,
            lob_order_id:    dispatchResult.messageId ?? null,
            mailing_date:    dispatchResult.success ? new Date().toISOString().slice(0, 10) : null,
            pieces_mailed:   dispatchResult.success ? 1 : 0,
            is_ai_generated: true,
            created_at:      new Date().toISOString(),
          })
        }

        const anyOk = sent.some((s) => s.success)
        return {
          success: true, // never block — digital drip is enough
          output:  {
            skipped:        false,
            address_source: address.source,
            pieces:         sent,
            kit_dispatched: anyOk,
          },
        }
      },
    },
  ],
}

const DEFAULT_CHAPTERS = [
  { title: "Why I'm the Right Agent for You", focus: "credibility" },
  { title: "How I'll Price Your Home", focus: "pricing_strategy" },
  { title: "My Marketing Plan", focus: "marketing" },
  { title: "What to Expect at Our Appointment", focus: "expectations" },
]
