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
 *
 * The agent gets a notification at each step's completion. By default the
 * chain runs to completion automatically; CMA and presentation steps can be
 * gated for human approval if the brokerage opts in.
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { WorkflowChain } from "../types"
import { generatePropertyChapterVideos } from "@/lib/video/chapter-video-generator"

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
  ],
}

const DEFAULT_CHAPTERS = [
  { title: "Why I'm the Right Agent for You", focus: "credibility" },
  { title: "How I'll Price Your Home", focus: "pricing_strategy" },
  { title: "My Marketing Plan", focus: "marketing" },
  { title: "What to Expect at Our Appointment", focus: "expectations" },
]
