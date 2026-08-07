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
import type { generatePropertyChapterVideos as realGeneratePropertyChapterVideos } from "@/lib/video/chapter-video-generator"
import type { DirectMailCopyContext } from "@/lib/direct-mail/draft-copy"
import { pushPortalValueCard } from "@/lib/kernel/portal-value"

// ---------------------------------------------------------------------------
// Injection seam for the three MONEY-SPENDING leaves of this chain.
//
// The orchestration (engine step routing, gating, run-dedupe, drip enrollment,
// portal-card push) is the SYSTEM UNDER TEST and must run for real. The leaves
// that actually spend money — the AVM/AI CMA, the AI listing presentation, and
// the D-ID + ElevenLabs chapter-video renders — are the only things a test must
// not invoke for real. These executors default to the real implementations
// (loaded lazily exactly as the handlers did before) and can be overridden in a
// simulator via setListingApptPrepExecutors() so CI exercises the REAL control
// flow while injecting fakes for the external, costly side-effects.
// ---------------------------------------------------------------------------
export interface ListingApptPrepExecutors {
  generateCMA: (args: any) => Promise<any>
  generatePresentation: (args: any) => Promise<any>
  generateChapterVideos: typeof realGeneratePropertyChapterVideos
}

const realExecutors: ListingApptPrepExecutors = {
  generateCMA: async (args) => {
    const { generateAICMA } = await import("@/app/actions/ai-cma")
    return generateAICMA(args)
  },
  // The SERVER-ONLY core, not the "use server" action wrapping it. This chain is
  // started unattended by lib/ai-isa/book-seller-appointment.ts (a webhook lane
  // with no session), and the action's supabase.auth.getUser() gate returned
  // "Unauthorized" there — step 2 failed before it did any work. The core takes
  // the tenant explicitly from the run's context instead of from a session.
  generatePresentation: async (args) => {
    const { generateAiListingPresentation } = await import("@/lib/listing-presentation/generate-ai-presentation")
    return generateAiListingPresentation(args)
  },
  // Lazily import the D-ID + ElevenLabs chapter-video pipeline so merely loading
  // this chain module (e.g. in a tsx simulator) does NOT eagerly pull the video/
  // direct-mail dispatch graph. Same lazy pattern as the two leaves above; tests
  // inject a fake so no D-ID render is ever submitted in CI.
  generateChapterVideos: async (args) => {
    const { generatePropertyChapterVideos } = await import("@/lib/video/chapter-video-generator")
    return generatePropertyChapterVideos(args)
  },
}

let activeExecutors: ListingApptPrepExecutors = realExecutors

/**
 * Deterministic dedupe key for the listing-appt-prep chain, keyed on the LISTING. Every booking
 * path — the stage pipeline (advanceListingStage → appointment_scheduled), the calendar
 * (ai-calendar-management.createAppointment), and the AI-ISA (bookSellerListingAppointment) — passes
 * this as triggerEventId so they all collapse to ONE prep run per listing (the engine's
 * findReusableRun matches on trigger_event_id first). Prevents double CMA / chapter-video renders /
 * postcards when more than one path fires for the same appointment.
 */
export function listingApptPrepDedupeKey(listingId: string): string {
  return `listing_appt_${listingId}`
}


/** Override the money-spending leaf executors (tests only). Pass null to reset to real. */
export function setListingApptPrepExecutors(next: Partial<ListingApptPrepExecutors> | null): void {
  activeExecutors = next ? { ...realExecutors, ...next } : realExecutors
}

export const listingApptPrepChain: WorkflowChain = {
  key: "listing-appt-prep",
  label: "Listing Appointment Prep",
  triggerEvent: "listing.appointment_set",
  steps: [
    // -----------------------------------------------------------------------
    // 0. Prep the seller's portal — the flywheel.
    //    The listing-appointment target is ALWAYS a contact (the event only
    //    fires with a contactId — see ai-calendar-management createAppointment),
    //    so the seller has a portal. Push ONE value card up front —
    //    "your home's market position is being prepared" — so the portal
    //    carries value BEFORE the agent even arrives. Idempotent per
    //    (contact, "listing_appt_prep", day) via pushPortalValueCard; soft —
    //    a portal push must never block the chain's primary work.
    // -----------------------------------------------------------------------
    {
      key: "prep_seller_portal",
      label: "Prep Seller Portal",
      handler: async (ctx) => {
        if (!ctx.contactId) {
          return { success: true, output: { skipped: true, reason: "no_contact_id" } }
        }
        const property = ctx.metadata.property_data ?? {}
        const addressLine =
          [property.address, property.city].filter(Boolean).join(", ") || "your home"
        const push = await pushPortalValueCard({
          brokerageId: ctx.brokerageId,
          contactId: ctx.contactId,
          title: "We're preparing your home's market position",
          summary:
            `Your agent is putting together a tailored market analysis for ${addressLine} ` +
            `ahead of your listing appointment. You'll see the pricing strategy, a custom ` +
            `presentation, and short chapter videos arrive here over the next few days.`,
          updateType: "listing_appt_prep",
          metadata: {
            appointment_date: ctx.metadata.appointment_date ?? null,
            chain_run_id: ctx.runId,
          },
        })
        return { success: true, output: { pushed: push.pushed, reason: push.reason } }
      },
    },

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

        // Use the canonical CMA generator via the injectable executor seam.
        // Real path lazily imports the server action (avoids bundling it into
        // the lib layer at edge); tests inject a fake so no AVM spend in CI.
        const cma = await activeExecutors.generateCMA({
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

        // The APPOINTMENT this prep is for. It is what keeps the presentation to
        // ONE row per meeting: the listing-presentation-prep cron keys its build
        // on appointment_id, so passing it here makes step 2 write onto that same
        // row instead of creating a second one — and a second one would mean a
        // second seller drip (materializePresentationSections runs per row).
        const appointmentId = await resolveAppointmentEventId(svc, {
          metadataAppointmentId: ctx.metadata.appointment_id,
          listingId: ctx.listingId ?? null,
        })

        const result: any = await activeExecutors.generatePresentation({
          // TENANT ANCHOR — the run's brokerage, not a session. The chain is
          // started unattended by the AI-ISA and by the kernel event lane.
          brokerageId: ctx.brokerageId,
          agentId: agent.id,
          contactId: ctx.contactId ?? null,
          appointmentId,
          appointmentAt: ctx.metadata.appointment_date ?? null,
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

        const chapters = presentation.chapters?.length
          ? presentation.chapters
          : DEFAULT_CHAPTERS

        const result = await activeExecutors.generateChapterVideos({
          brokerageId: ctx.brokerageId,
          agentUserId: ctx.agentUserId ?? null,
          contactId: ctx.contactId ?? null,
          presentationId: presentation.presentationId,
          chapters,
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
            // chapterTitles is index-aligned with videoIds (succeededTitles in
            // chapter-video-generator) — a partial run reports the chapters that
            // actually reached the provider, not the first N requested.
            chapterTitles: result.chapterTitles,
            // The chapters AS SENT, so enroll_drip can read each reel's `focus`
            // and land it on the section it is the on-camera version of. The
            // generator's return carries titles only.
            chapters,
          },
        }
      },
      retry: { max: 1, delayMs: 5000 },
    },

    // -----------------------------------------------------------------------
    // 4. Enroll the chapter reels in the pre-appointment SECTION DRIP.
    //
    //    This step used to write one activities row per chapter with
    //    activity_type='scheduled_video_touchpoint' and its own hand-rolled
    //    "spread evenly between now and the appointment" arithmetic. NOTHING
    //    consumed those rows — no cron, no reactor, no dispatcher — so the
    //    seller never received a single chapter reel, and the schedule was a
    //    second, competing timetable next to the one that actually delivers.
    //
    //    There is now exactly ONE scheduler (planPresentationSections) and ONE
    //    delivery path (deliverDueSections → dispatchEmail): each reel is linked
    //    to a section of the seller's pre-listing drip and goes out as its own
    //    email with the reel embedded as a clickable thumbnail, spaced across
    //    the window that ends before the listing appointment.
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

        // The presentation the reels belong to. Prefer the one this run just
        // produced; fall back to the newest presentation already on file for
        // this seller (the listing-presentation-prep cron builds one too). A
        // RESOLVE, never a substitution — if neither yields a real row there is
        // nothing to attach to and the step says so.
        const presentationId = await resolveDripPresentation(svc, {
          candidateId: ctx.previousStepOutputs.generate_presentation?.presentationId,
          brokerageId: ctx.brokerageId,
          contactId:   ctx.contactId,
          agentUserId: ctx.agentUserId ?? null,
          appointmentAt: apptDate,
        })
        if (!presentationId) {
          return {
            success: false,
            error:
              "No listing_presentations row to drip against — the presentation step returned no persisted id and this seller has none on file",
          }
        }

        // Idempotent: creates the seller-safe section set + its schedule if the
        // presentation does not have one yet, no-ops if it does.
        const { materializePresentationSections, attachChapterReelsToSections } =
          await import("@/lib/listing-presentation/section-drip")
        const materialized = await materializePresentationSections(presentationId, svc)
        if (!materialized.ok) {
          return { success: false, error: `Could not materialize drip sections: ${materialized.error}` }
        }

        // Carry each chapter's focus through so a reel lands on the section it
        // is the on-camera version of (credibility → credibility, and so on).
        const chapters: Array<{ title: string; focus?: string }> = videos.chapters ?? []
        const focusByTitle = new Map<string, string | undefined>()
        for (const c of chapters) if (!focusByTitle.has(c.title)) focusByTitle.set(c.title, c.focus)

        const reels = (videos.videoIds as string[]).map((videoId, i) => {
          const title = videos.chapterTitles?.[i] ?? `Chapter ${i + 1}`
          return { videoId, title, focus: focusByTitle.get(title) ?? null, chapterIndex: i }
        })

        const attached = await attachChapterReelsToSections(presentationId, reels, svc)
        if (!attached.ok) {
          return { success: false, error: `Could not attach chapter reels to the drip: ${attached.error}` }
        }

        return {
          success: true,
          output: {
            presentationId,
            sectionsMaterialized: materialized.inserted,
            reelsAttached:        attached.attached,
            newSectionsCreated:   attached.newSections,
            // Never silently dropped — an unplaced reel is reported on the step.
            reelsUnattached:      attached.unattached,
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

        const { resolveMailingAddressForContact } = await import("@/lib/contacts/resolve-mailing-address")
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

        // Wave 36 — pre-listing kit copy is HIGH-CONTEXT: we know the
        // property address, the appointment date, and the seller's
        // first name. That's exactly the signal the AI copy generator
        // shines on, so we route the pieces through orchestrateRender
        // AndSend instead of merging vars into a static Lob template.
        // Fall-through guarantees the kit still ships (via the static
        // template) if the copy gate fails for any reason.
        // Wave 36 tier cascade: resolve the agent's team_id so the
        // brand resolver picks team logo/colors when the listing
        // agent is on a team. agentUserId is already in ctx.
        let agentTeamId: string | null = null
        if (ctx.agentUserId) {
          const { data: agentRow } = await svc
            .from("agents")
            .select("team_id")
            .eq("user_id", ctx.agentUserId)
            .maybeSingle()
          agentTeamId = (agentRow?.team_id as string | undefined) ?? null
        }

        const copyCtxBase: Omit<DirectMailCopyContext, "qrDestinationType"> = {
          brokerageId: ctx.brokerageId,
          teamId:      agentTeamId,
          agentUserId: ctx.agentUserId ?? null,
          contactId:   ctx.contactId,
          persona:     "upsize",  // listing-appointment contacts are sellers; "upsize" is the closest canonical persona for "selling current home to upgrade/downsize"
          hookFacts: {
            listingAddress: [property.address, property.city].filter(Boolean).join(", ") || undefined,
          },
        }

        const sent: Array<{
          piece: string; success: boolean; messageId?: string; error?: string
          rendered?: boolean; fellBackReason?: string | null
        }> = []

        const { orchestrateRenderAndSend } = await import("@/lib/direct-mail/orchestrate-send")
        for (const [piece, tpl] of [["letter", letterTpl], ["postcard", postcardTpl]] as const) {
          if (!tpl) continue
          const result = await orchestrateRenderAndSend({
            brokerageId:    ctx.brokerageId,
            contactId:      ctx.contactId,
            userId:         ctx.agentUserId ?? ctx.brokerageId,
            recipientName,
            mailingAddress: address.street,
            city:           address.city,
            state:          address.state,
            zip:            address.zip,
            pieceType:      piece,
            copyCtx: {
              ...copyCtxBase,
              // Postcards land best with a fast "book_meeting" CTA —
              // the appointment is the contact's actual next step.
              // Letters carry the longer narrative and don't need a
              // CTA enum.
              qrDestinationType: piece === "postcard" ? "book_meeting" : "landing_page",
            },
            fallbackTemplateId: tpl,
            agentName:          null,
            agentTitle:         "REALTOR®",
            systemSource:       "pre_listing_kit",
          })

          sent.push({
            piece,
            success:        result.success,
            messageId:      result.messageId,
            error:          result.error,
            rendered:       result.rendered,
            fellBackReason: result.fellBackReason,
          })

          // Record a direct_mail_campaigns row tagged for the
          // pre-listing analytics cohort so the admin can see
          // pre-listing kit ROI separately from welcome kits.
          // approval_status reflects the render path: 'auto_approved'
          // when AI-drafted copy passed the gate, 'fell_back' when we
          // dropped to the static template (admin can audit drift).
          // direct_mail_campaigns.agent_id is agents-class — the USERS id was
          // FK-rejected, so the pre-listing-kit cohort this row exists to feed
          // was permanently empty and the ROI split could never be computed.
          let kitAgentId: string | null = null
          if (ctx.agentUserId) {
            const { resolveUserIdToAgentRecord } = await import("@/lib/kernel/agent-identity-resolver")
            kitAgentId = await resolveUserIdToAgentRecord(ctx.agentUserId, ctx.brokerageId)
          }

          await svc.from("direct_mail_campaigns").insert({
            brokerage_id:    ctx.brokerageId,
            agent_id:        kitAgentId,
            contact_id:      ctx.contactId,
            campaign_name:   `Pre-Listing Kit (${piece}) - ${recipientName}`,
            target_audience: "pre_listing_kit",
            quantity:        1,
            status:          result.success ? "sent" : "failed",
            piece_type:      piece,
            lob_order_id:    result.messageId ?? null,
            mailing_date:    result.success ? new Date().toISOString().slice(0, 10) : null,
            pieces_mailed:   result.success ? 1 : 0,
            is_ai_generated: true,
            approval_status: result.rendered ? "auto_approved" : "fell_back",
            variant_id:          result.variantPick?.variantId ?? null,
            compliance_event_id: result.complianceEventId ?? null,
            created_at:          new Date().toISOString(),
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

/**
 * The calendar_events row this prep run is for.
 *
 * Two sources, because the three booking paths do not all carry it the same way:
 *   1. metadata.appointment_id — set by lib/ai-isa/book-seller-appointment.ts.
 *   2. listings.appointment_event_id — written by
 *      lib/application/listing-lifecycle.ts::scheduleListingAppointmentService
 *      when an agent books a consult on a listing.
 * Returns null when neither yields one; the presentation is still built, it just
 * cannot be keyed to an appointment.
 */
async function resolveAppointmentEventId(
  svc: ReturnType<typeof createServiceClient>,
  args: { metadataAppointmentId?: unknown; listingId: string | null },
): Promise<string | null> {
  const { isValidUUID } = await import("@/lib/validations")
  if (typeof args.metadataAppointmentId === "string" && isValidUUID(args.metadataAppointmentId)) {
    return args.metadataAppointmentId
  }
  if (!args.listingId) return null
  const { data, error } = await svc
    .from("listings")
    .select("appointment_event_id")
    .eq("id", args.listingId)
    .maybeSingle()
  if (error) {
    // Not fatal — a presentation without an appointment_id is still a
    // presentation. But a refused read is never passed off as "no appointment".
    console.error(`[listing-appt-prep] appointment_event_id lookup for listing ${args.listingId} failed: ${error.message}`)
    return null
  }
  const id = (data as { appointment_event_id?: string | null } | null)?.appointment_event_id ?? null
  return id && isValidUUID(id) ? id : null
}

/**
 * Resolve the listing_presentations row the chapter reels drip against, and make
 * sure it carries what the drip needs (contact, appointment time, sending agent).
 *
 * Two sources, in order:
 *   1. the id this run's generate_presentation step returned, and
 *   2. the newest presentation already on file for this seller.
 *
 * WHY (2) STILL EARNS ITS PLACE now that step 2 genuinely persists. It is no
 * longer covering for a step that always returned undefined — step 2 fails the
 * run outright if it cannot save, so a run that REACHES here has a real id. What
 * it still covers is a run started before that fix whose step_outputs already
 * recorded presentationId: undefined, and the ordinary case where the
 * listing-presentation-prep cron got to this appointment first. It is no longer
 * masking a failure, because a failure can no longer arrive here dressed as a
 * success.
 *
 * It prefers the presentation for THIS appointment's date rather than simply the
 * newest for the contact: a seller who has had a previous listing appointment has
 * more than one presentation on file, and attaching this run's reels to the old
 * one would drip them against a timetable that has already run.
 *
 * Both paths are scoped to the run's brokerage. Returns null rather than
 * inventing a row: with no presentation there is no section timetable to attach
 * reels to.
 */
async function resolveDripPresentation(
  svc: ReturnType<typeof createServiceClient>,
  args: {
    candidateId?: unknown
    brokerageId: string
    contactId: string
    agentUserId: string | null
    appointmentAt: string
  },
): Promise<string | null> {
  const { isValidUUID } = await import("@/lib/validations")
  type PresRow = { id: string; contact_id: string | null; appointment_at: string | null; agent_user_id: string | null }
  let row: PresRow | null = null

  if (typeof args.candidateId === "string" && isValidUUID(args.candidateId)) {
    const { data, error } = await svc
      .from("listing_presentations")
      .select("id, contact_id, appointment_at, agent_user_id")
      .eq("id", args.candidateId)
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle()
    if (error) console.error(`[listing-appt-prep] presentation ${args.candidateId} unreadable: ${error.message}`)
    row = (data as PresRow | null) ?? null
  }

  if (!row) {
    const { data, error } = await svc
      .from("listing_presentations")
      .select("id, contact_id, appointment_at, agent_user_id")
      .eq("brokerage_id", args.brokerageId)
      .eq("contact_id", args.contactId)
      .order("created_at", { ascending: false })
      .limit(10)
    if (error) console.error(`[listing-appt-prep] presentation lookup for contact ${args.contactId} failed: ${error.message}`)
    const rows = (data as PresRow[] | null) ?? []
    // This appointment's presentation first (same calendar day), then the newest.
    const wanted = new Date(args.appointmentAt)
    const wantDay = Number.isNaN(wanted.getTime()) ? null : wanted.toISOString().slice(0, 10)
    const sameDay = wantDay
      ? rows.find((r) => {
          if (!r.appointment_at) return false
          const at = new Date(r.appointment_at)
          return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === wantDay
        })
      : undefined
    row = sameDay ?? rows[0] ?? null
  }
  if (!row) return null

  // Fill only what is MISSING. contact_id/appointment_at drive the drip's
  // recipient and its timetable; agent_user_id (users class — the column FKs
  // users.id) is the from-address the section emails send as.
  const patch: Record<string, unknown> = {}
  if (!row.contact_id) patch.contact_id = args.contactId
  if (!row.appointment_at) patch.appointment_at = new Date(args.appointmentAt).toISOString()
  if (!row.agent_user_id && args.agentUserId) patch.agent_user_id = args.agentUserId
  if (Object.keys(patch).length > 0) {
    const { error } = await svc.from("listing_presentations").update(patch).eq("id", row.id)
    if (error) console.error(`[listing-appt-prep] could not complete presentation ${row.id}: ${error.message}`)
  }

  return row.id
}

const DEFAULT_CHAPTERS = [
  { title: "Why I'm the Right Agent for You", focus: "credibility" },
  { title: "How I'll Price Your Home", focus: "pricing_strategy" },
  { title: "My Marketing Plan", focus: "marketing" },
  { title: "What to Expect at Our Appointment", focus: "expectations" },
]
