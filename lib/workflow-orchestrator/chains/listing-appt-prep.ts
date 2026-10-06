/**
 * Chain: listing-appt-prep
 *
 * STARTED FROM THE LISTING-APPOINTMENT BOOKING, FOR THE SELLER (owner, wave 87:
 * "listing presentation prep which inlcudes the cma needs to be for a seller as
 * this is started from the listing appointmtent booking").
 *
 * THIS IS THE ORIGINAL AND THE SURVIVOR (lane 88D, owner wave 88: "listing
 * appointment already coded and built the listing prep … with drip including
 * video sections … you now just wrote it again in the last wave"). Its trigger is
 * the one it has always declared — the `listing.appointment_set` event — and the
 * orchestrator's chain registry (lib/orchestrator/internal.ts orchestrateEvent)
 * starts it with the EVENT's id as triggerEventId. Lane 87B's second module
 * (lib/listing-presentation/booking-prep.ts) is retired onto the foot of this file:
 * what it added that this chain lacked — every booking path fires it, only for a
 * SELLER, one run per booking, the cron as a safety net — is carried here as
 * fireListingAppointmentSetForBooking, which records the event every booking path
 * (agent calendar, listing consult + stage, AI-ISA seller milestone, AI-ISA/voice
 * at the agent's confirm, the seller's self-booking from the report page or the
 * portal, and the listing-presentation-prep cron) now fires.
 *
 * Often no listing record exists yet — everything runs against the SELLER
 * contact + the seller's property data resolved from the booking.
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
import { CalendarEventType } from "@/lib/kernel/calendar-types"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

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
  // THE SERVER-ONLY CORE, not the "use server" action (lane 86F). This called
  // app/actions/ai-cma.ts::generateAICMA, whose first gate is auth.getUser() on
  // the COOKIE client — and this chain runs from the orchestrator, from the stage
  // pipeline's service-client automations and from the AI-ISA booking webhook, so
  // every unattended run was refused "Unauthorized" at step 1. The core takes the
  // tenant from the RUN and proves the agents.id/users.id pair inside it.
  generateCMA: async (args) => {
    const { generateCmaReport } = await import("@/lib/cma/ai-cma-report")
    const { brokerageId, agentUserId, ...params } = args ?? {}
    return generateCmaReport(createServiceClient(), { brokerageId, agentUserId, params })
  },
  // The SERVER-ONLY core, not the "use server" action wrapping it. This chain is
  // started unattended by lib/ai-isa/book-seller-appointment.ts (a webhook lane
  // with no session), and the action's supabase.auth.getUser() gate returned
  // "Unauthorized" there — step 2 failed before it did any work. The core takes
  // the tenant explicitly from the run's context instead of from a session.
  // ── THE ARTIFACT SET THE OWNER NAMED (ruling 2026-09-05) ────────────────────
  // "the original autonomous should be cma + marketing plan + presentation/slide
  //  deck (packet is for printouts) turned into chapter reels"
  //
  // This called generateAiListingPresentation, which writes a listing_presentations
  // row carrying ONLY the AI narrative. It populates NONE of the typed columns the
  // readers actually read — cma_low_value / cma_mid_value / cma_high_value /
  // cma_narrative / marketing_plan / slide_deck / net_sheet are all left NULL — and
  // three separate surfaces read exactly those columns:
  //     app/dashboard/listings/presentations/[id]/page.tsx   (the agent's viewer,
  //       which coerces with `Number(pres.cma_low_value ?? 0)`, so the agent saw $0)
  //     app/portal/listing-plan/[id]/page.tsx                (the seller's plan)
  //     lib/listing-presentation/section-drip.ts             (the drip sections)
  //
  // AND IT SILENTLY BLOCKED THE REPAIR. The listing-presentation-prep cron is
  // idempotent by design — it SKIPS any appointment that already has a
  // listing_presentations row (route.ts:149). So whichever producer ran first won,
  // and when this chain won, the complete builder never ran for that seller at all:
  // a presentation with a $0 range, no marketing plan and no slide deck, permanently.
  //
  // THE SURVIVOR (§1.1) is lib/workflow/intelligence/listing-presentation-builder.ts
  // ::buildListingPresentation — the same producer the cron and the on-demand
  // workflow route already use. It writes the owner's set exactly: the CMA snapshot
  // columns, the 3-price net sheet, the marketing plan, the slide deck, and the
  // listing-agreement packet (which stays what the owner says it is — the printout,
  // not part of what becomes reels). Pointing this chain at it makes ALL THREE
  // autonomous entry points one producer, so "which ran first" stops mattering.
  //
  // NOT A DELETION, AND NOT A REVERSAL OF THE EARLIER RULING.
  // generateAiListingPresentation survives on its own authenticated door
  // (app/actions/ai-listing-presentation.ts, reached from the CMA → Presentation
  // tab), where it was already adjudicated the survivor of a DIFFERENT pair — see
  // the tombstone at app/actions/cma-presentation/presentation-assembler.ts:28. The
  // two are not duplicates of each other: that door is an agent ASKING for an AI
  // narrative in their own words, and its update arm attaches that narrative to the
  // existing row rather than creating a second one, so the two now compose on ONE
  // row per appointment instead of racing to define it.
  generatePresentation: async (args) => {
    const { buildListingPresentation } = await import("@/lib/workflow/intelligence/listing-presentation-builder")
    const p = args.propertyData ?? {}
    const built = await buildListingPresentation({
      brokerageId:     args.brokerageId,
      // The builder takes agentUserId (users.id); this chain resolved an agents.id
      // for the CMA step. agents.id and users.id are DISJOINT (CLAUDE.md §3), so the
      // run's own agentUserId is passed rather than the agent row's id.
      agentUserId:     args.agentUserId ?? null,
      contactId:       args.contactId ?? null,
      appointmentId:   args.appointmentId ?? null,
      appointmentAt:   args.appointmentAt ?? null,
      listingId:       args.listingId ?? null,
      propertyAddress: p.address,
      state:           p.state,
      city:            p.city ?? null,
      zip:             p.zipCode ?? p.zip ?? null,
      bedrooms:        p.bedrooms ?? null,
      bathrooms:       p.bathrooms ?? null,
      sqft:            p.sqft ?? null,
      yearBuilt:       p.yearBuilt ?? null,
      // THE CMA STEP 1 ALREADY PAID FOR. Without this the builder runs the SAME
      // engine again (lib/cma/ai-cma-orchestrator::runAiCma), buying a second set
      // of comps for the same house — and producing a second, independent number
      // that can disagree with the cma_reports row the agent opens.
      cma:             args.cma ?? undefined,
    })
    if (!built.success || !built.result) {
      return { success: false, error: built.error ?? "Listing presentation build failed" }
    }
    // Shape-adapt to what step 2's handler already returns, so the chapter-video and
    // drip steps downstream are untouched. `chapters` comes from the slide deck —
    // the deck IS the chapter list the owner is describing.
    return {
      success: true,
      presentationId: built.result.presentationId,
      chapters: (built.result.slideDeck ?? []).map((s: { title: string }) => ({ title: s.title })),
      content: built.result,
    }
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

// TOMBSTONE (lane 87B): listingApptPrepDedupeKey (`listing_appt_${listingId}`) is RETIRED.
// It keyed a prep run on the LISTING, which a home-value or AI-ISA seller does not have, so
// only two of the five booking paths could use it and the other three keyed on their own
// calendar row — two keys for one appointment. It was also not a uuid, and
// workflow_runs.trigger_event_id is a uuid FK to lifecycle_events(id). SURVIVOR: this
// chain's own trigger at the foot of this file (fireListingAppointmentSetForBooking, lane
// 88D): one `listing.appointment_set` lifecycle event per booking, whose id the
// orchestrator hands the engine as triggerEventId.


/** Override the money-spending leaf executors (tests only). Pass null to reset to real.
 *  CENSUS NOTE: a test seam by design — readers are scripts/listing-appt-prep-simulator.ts:181,
 *  buyer-intent-conversion-simulator.ts:113, seller-appt-conversion-simulator.ts:96.
 *  @proofSeam mutable module-level executor override; must stay exported for the three simulators above. */
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

        // Resolve agent row (the CMA core expects an agents.id, not a users.id) —
        // INSIDE the run's tenant: users.id and agents.id are disjoint (§3) and a
        // user with agents rows in two brokerages must not be filed under the other.
        const { data: agent, error: agentError } = await svc
          .from("agents")
          .select("id")
          .eq("user_id", ctx.agentUserId)
          .eq("brokerage_id", ctx.brokerageId)
          .maybeSingle()

        if (agentError) return { success: false, error: `Agent lookup refused: ${agentError.message}` }
        if (!agent) return { success: false, error: "Agent profile not found" }

        // Use the canonical CMA generator via the injectable executor seam.
        // Real path lazily imports the server action (avoids bundling it into
        // the lib layer at edge); tests inject a fake so no AVM spend in CI.
        //
        // PARAMETER NAMES. This object used `address`/`city`/`state`/`zipCode`/
        // `sqft` — NOT ONE of which is a key on the CMA core's CMAParams, which
        // reads propertyAddress / propertyCity / propertyState / propertyZip /
        // squareFeet. The `as any` on the call is what let it compile. So every
        // CMA generated from a listing appointment ran with an EMPTY address and
        // ZERO square feet: the comps provider was handed ", , " to search on and
        // the subject was valued as a 0-sqft home. It never failed loudly — it
        // returned a CMA built on nothing. `listingType` was missing too, which
        // the pricing strategy branches on.
        const cma = await activeExecutors.generateCMA({
          // The verified tenant + the users.id the core proves owns agent.id there.
          brokerageId: ctx.brokerageId,
          agentUserId: ctx.agentUserId,
          agentId: agent.id,
          contactId: ctx.contactId,
          propertyAddress: propertyData.address,
          propertyCity: propertyData.city ?? "",
          propertyState: propertyData.state ?? "",
          propertyZip: propertyData.zip ?? propertyData.zipCode ?? "",
          bedrooms: propertyData.bedrooms ?? 0,
          bathrooms: propertyData.bathrooms ?? 0,
          squareFeet: propertyData.sqft ?? 0,
          lotSize: propertyData.lotSize,
          yearBuilt: propertyData.yearBuilt,
          propertyType: propertyData.propertyType ?? "single_family",
          // Left unset unless the appointment actually recorded one. The old
          // `?? "average"` is not a member of the condition vocabulary
          // (excellent|good|fair|poor), so it graded as unknown anyway — but it
          // read on the record as though the property had been assessed.
          condition: propertyData.condition,
          listingType: "seller",
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

        // Inside the RUN's tenant (lane 87B) — the same pin step 1 carries; a user
        // with agents rows in two brokerages must not be filed under the other.
        const { data: agent, error: agentErr } = await svc
          .from("agents")
          .select("id")
          .eq("user_id", ctx.agentUserId)
          .eq("brokerage_id", ctx.brokerageId)
          .maybeSingle()
        if (agentErr) return { success: false, error: `Agent lookup refused: ${agentErr.message}` }
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
          // BOTH ID CLASSES, DELIBERATELY. `agentId` is an agents.id (what the CMA
          // step resolved); `agentUserId` is a users.id. They are DISJOINT (§3), and
          // the presentation builder wants the users.id — passing the agents.id
          // there would be a 23503 that loses the whole row. Both travel so the
          // executor picks the one its producer takes rather than converting.
          agentUserId: ctx.agentUserId ?? null,
          // The listing this appointment is for, when there is one. The builder uses
          // it to load the seller's recorded improvements so the CMA narrative
          // accounts for what they have done to the home — the last clause of the
          // owner's CMA ruling. A prospect with no listing yet passes null.
          listingId: ctx.listingId ?? null,
          contactId: ctx.contactId ?? null,
          // ── STEP 1'S CMA, REUSED RATHER THAN RE-BOUGHT ──────────────────────
          // The comment introducing this step has said "(uses CMA output)" since it
          // was written, and until now it did not: generate_cma's output was never
          // read by anything, so the builder ran the engine a second time. Mapped
          // into the builder's narrow shape here.
          //
          // UNITS: confidenceScore is the engine's native 0..1. `valuation` also
          // carries confidenceLevel (0..100) for display — passing THAT would look
          // correct to every type check and render an 8500% confidence.
          //
          // Absent or malformed (a gated/skipped step 1, an older run replayed) it
          // stays undefined and the builder values the property itself, exactly as
          // before. Reuse is an optimisation, never a precondition.
          cma: (() => {
            const v = ctx.previousStepOutputs.generate_cma?.valuation as
              | { estimatedValueLow?: number; estimatedValue?: number; estimatedValueHigh?: number; confidenceScore?: number; narrative?: string }
              | undefined
            if (
              typeof v?.estimatedValueLow !== "number" ||
              typeof v?.estimatedValue !== "number" ||
              typeof v?.estimatedValueHigh !== "number" ||
              typeof v?.confidenceScore !== "number"
            ) return undefined
            return {
              estimatedValueLow:  v.estimatedValueLow,
              estimatedValueMid:  v.estimatedValue,
              estimatedValueHigh: v.estimatedValueHigh,
              confidenceScore:    v.confidenceScore,
              aiNarrative:        v.narrative ?? "",
            }
          })(),
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

        // THE PITCH REEL rides the chain too (lane 88D). It was queued only by the
        // listing-presentation-prep cron's direct build, so once every booking path
        // started THIS chain (lane 87B) and the cron stood down to "in progress",
        // no booked seller's appointment got one. Same producer, same key (one
        // render per appointment — queueListingPitchReel is idempotent on it);
        // additive, never blocks the prep.
        if (appointmentId && propertyData?.address) {
          try {
            const { queueListingPitchReel } = await import("@/lib/video/listing-pitch-reel")
            await queueListingPitchReel(svc, {
              brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId ?? null,
              appointmentId, address: propertyData.address, contactId: ctx.contactId ?? null,
            })
          } catch (err) {
            console.error(`[listing-appt-prep] pitch reel not queued for appointment ${appointmentId}:`, (err as Error)?.message)
          }
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

        // WAVE 83C — THE PRE-LISTING POSTCARD CARRIES A TRACKED QR (82D open
        // item: this chain passed no qrScanUrl). ONE registered code per
        // seller contact's kit, minted/reused through THE ONE minter, pointing
        // at the booking CTA the postcard copy already uses. Letters carry no
        // QR (orchestrate-send renders it on the postcard front only). A
        // refused mint mails without one (the CTA still prints) and says so.
        let kitQr: { scanUrl: string } | null = null
        if (postcardTpl) {
          try {
            const { mintTrackedQr } = await import("@/lib/marketing/tracked-qr")
            const minted = await mintTrackedQr({ brokerageId: ctx.brokerageId, label: `pre_listing_kit:${ctx.contactId}`, purpose: "campaign", destinationType: "book_meeting" }, svc as any)
            if (minted) kitQr = { scanUrl: minted.scanUrl }
            else console.error(`[listing-appt-prep] no tracked QR for contact ${ctx.contactId} — the postcard mails without one`)
          } catch (err) {
            console.error(`[listing-appt-prep] tracked QR unavailable for contact ${ctx.contactId}:`, (err as Error)?.message)
          }
        }

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
            // The kit's REGISTERED code (minted above) — postcard front only.
            qrScanUrl:          piece === "postcard" ? kitQr?.scanUrl ?? null : null,
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

          const { error: kitMailErr } = await svc.from("direct_mail_campaigns").insert({
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
          if (kitMailErr) console.error(`[listing-appt-prep] pre-listing kit mailing NOT queued: ${kitMailErr.message}`)
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

// ═════════════════════════════════════════════════════════════════════════════
// THE TRIGGER — `listing.appointment_set`, FIRED FROM THE BOOKING, FOR THE SELLER
//
// Merged here from lib/listing-presentation/booking-prep.ts (lane 87B, retired by
// lane 88D — tombstone at the foot of this file). This chain always declared its
// trigger (triggerEvent above) and the orchestrator always started it from that
// event (lib/orchestrator/internal.ts orchestrateEvent → getChainsByTrigger →
// engine startRun with triggerEventId = the lifecycle_events id). What was missing
// was an EMITTER: nothing recorded the event, so each booking path called the
// engine its own way, and lane 87B then wrote a second starter beside the chain.
//
// WHY THE EVENT, NOT startRun (live read, hrvaqgvukzxfskkcrwbt, 2026-09-28):
// workflow_runs.trigger_event_id is a uuid FK to lifecycle_events(id)
// (workflow_runs_trigger_event_id_fkey). Lane 87B keyed the run on the BOOKING ROW
// id (calendar_events.id), and book-seller-appointment had done the same since it
// was written — every such INSERT is a 23503, so the run was never created, the
// cron safety net saw "no run" and tried again with the same refused key, and no
// seller got a presentation, a section drip or a chapter reel from ANY booking
// path. Keying on the event the chain was built for is both what the FK demands
// and what the original design said.
//
// ONE RUN PER BOOKING: one `listing.appointment_set` event per booking row
// (dedupe_key below, read with no time window; m673's partial unique index makes a
// racing second insert refuse), and the engine reuses the run whose
// trigger_event_id is that event (run-dedupe findReusableRun). The builder is
// one-presentation-per-appointment besides (m667).
// ═════════════════════════════════════════════════════════════════════════════

type Svc = ReturnType<typeof createServiceClient>

/** contact_type values that ARE the seller side (CHECK vocabulary: scripts/check-vocabularies.ts). */
const SELLER_SIDE_CONTACT_TYPES = new Set(["seller", "both"])
/** Statuses a booking can carry that mean "do not prep". */
const CANCELLED_BOOKING_STATUSES = new Set(["cancelled", "canceled", "no_show"])
/** lib/ai-isa/listing-appointment.ts LISTING_APPOINTMENT_STATUS.PENDING_AGENT_CONFIRMATION — a tentative hold. */
const PENDING_CONFIRMATION_STATUS = "pending_agent_confirmation"

/** ONE event per booking row — the key the dedupe read and m673's index both use. */
function listingAppointmentSetDedupeKey(calendarEventId: string): string {
  return `${listingApptPrepChain.triggerEvent}:${calendarEventId}`
}

type SellerPrepVerdict =
  | { seller: true; basis: "contact_type" | "listing_seller" | "valuation_request" }
  | { seller: false; reason: string }

/**
 * Is this booking FOR A SELLER? Owner: the prep "needs to be for a seller". PURE.
 *   · contact_type seller/both → yes;
 *   · otherwise EVIDENCE of a home to sell in the same tenant — the contact is the
 *     seller on a listing, or asked for a valuation of their home → yes;
 *   · anything else (a buyer, a vendor, an untyped contact with no home on file,
 *     or no contact at all) → no, with the reason named.
 */
export function classifySellerPrepContext(input: {
  contactId: string | null
  contactType: string | null
  isListingSeller: boolean
  hasValuationRequest: boolean
}): SellerPrepVerdict {
  if (!input.contactId) return { seller: false, reason: "no_seller_contact" }
  const t = (input.contactType ?? "").trim().toLowerCase()
  if (SELLER_SIDE_CONTACT_TYPES.has(t)) return { seller: true, basis: "contact_type" }
  if (input.isListingSeller) return { seller: true, basis: "listing_seller" }
  if (input.hasValuationRequest) return { seller: true, basis: "valuation_request" }
  return { seller: false, reason: `not_a_seller:${t || "untyped"}` }
}

/**
 * Which booking rows fire the event, which wait, which never do. PURE. The ONE
 * listing-appointment spelling is CalendarEventType.LISTING_APPOINTMENT (lane 87B2
 * merged 'listing_consultation' and the ISA milestone's 'isa_appointment' onto it
 * at their writers).
 */
export function bookingPrepGate(input: {
  eventType: string | null
  status: string | null
}): { go: true } | { go: false; outcome: "refused" | "deferred" | "skipped"; reason: string } {
  const et = (input.eventType ?? "").trim()
  if (et !== CalendarEventType.LISTING_APPOINTMENT) return { go: false, outcome: "refused", reason: `not_a_listing_appointment:${et || "none"}` }
  const st = (input.status ?? "").trim().toLowerCase()
  if (CANCELLED_BOOKING_STATUSES.has(st)) return { go: false, outcome: "skipped", reason: `booking_${st}` }
  if (st === PENDING_CONFIRMATION_STATUS) return { go: false, outcome: "deferred", reason: "awaiting_agent_confirmation" }
  return { go: true }
}

/**
 * The listing-presentation-prep cron's decision for ONE booking. PURE.
 *   · a presentation exists            → done (idempotent);
 *   · a live prep run exists           → in_progress (this chain will build it);
 *   · no run at all                    → start_prep (the booking missed its event);
 *   · runs exist, all ended, no deck   → build_presentation (the cron's original
 *                                        direct build is the net's net).
 */
export function decideSafetyNetAction(input: {
  presentationExists: boolean
  runStatuses: string[]
}): "done" | "in_progress" | "start_prep" | "build_presentation" {
  if (input.presentationExists) return "done"
  const live = new Set(["running", "paused"])
  if (input.runStatuses.some((s) => live.has(s))) return "in_progress"
  if (input.runStatuses.length === 0) return "start_prep"
  return "build_presentation"
}

/** Loose address comparison for picking WHICH valuation_request. */
function addressKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

interface SellerProperty {
  propertyAddress: string | null
  state: string | null
  city: string | null
  zip: string | null
  /** Only ever a real listings.id in this tenant. */
  listingId: string | null
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  yearBuilt: number | null
  lotSize: number | null
  propertyType: string | null
  source: "listing" | "caller_hint" | "valuation_request" | "booking_address" | "seller_home_address" | "none"
}

const NO_PROPERTY: SellerProperty = {
  propertyAddress: null, state: null, city: null, zip: null, listingId: null,
  bedrooms: null, bathrooms: null, sqft: null, yearBuilt: null, lotSize: null, propertyType: null,
  source: "none",
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

interface BookingPrepContext {
  calendarEventId: string
  brokerageId: string
  startAt: string | null
  contactId: string
  agentUserId: string | null
  property: SellerProperty
  sellerBasis: "contact_type" | "listing_seller" | "valuation_request"
}

type ResolveBookingPrepResult =
  | { ok: true; context: BookingPrepContext }
  | { ok: false; outcome: "refused" | "deferred" | "skipped" | "error"; reason: string }

interface ResolveBookingPrepParams {
  calendarEventId: string
  /** The tenant a SESSION caller holds. The booking row must be in it. */
  expectedBrokerageId?: string | null
  /** A listing the caller KNOWS this booking is for (tenant-verified here). */
  listingId?: string | null
  /** Property facts the caller captured at booking (address/city/state/zip…). */
  propertyHint?: Record<string, unknown> | null
}

/**
 * Read the booking row and resolve everything this chain needs — or say exactly
 * why this booking does not get it. Every read is on the service client and
 * pinned to the booking row's brokerage (the TENANT is the row's, never a body's;
 * a session caller's tenant must match). The seller property order is the cron's
 * original (listing → valuation request matched to the booked address) with the
 * caller's captured property, the booking's own address and the seller's home
 * address added behind it; a state is never invented.
 */
export async function resolveBookingPrepContext(svc: Svc, params: ResolveBookingPrepParams): Promise<ResolveBookingPrepResult> {
  const { data: row, error: rowErr } = await svc
    .from("calendar_events")
    .select("id, brokerage_id, entity_type, entity_id, event_type, status, start_at, location, metadata, agent_user_id")
    .eq("id", params.calendarEventId)
    .maybeSingle()
  if (rowErr) return { ok: false, outcome: "error", reason: `booking read refused: ${rowErr.message}` }
  if (!row) return { ok: false, outcome: "refused", reason: "booking_not_found" }
  const r = row as {
    id: string; brokerage_id: string | null; entity_type: string | null; entity_id: string | null
    event_type: string | null; status: string | null; start_at: string | null; location: string | null
    metadata: Record<string, unknown> | null; agent_user_id: string | null
  }

  const brokerageId = r.brokerage_id
  if (!brokerageId) return { ok: false, outcome: "refused", reason: "booking_has_no_tenant" }
  if (params.expectedBrokerageId && params.expectedBrokerageId !== brokerageId) {
    return { ok: false, outcome: "refused", reason: "booking_not_in_caller_tenant" }
  }

  const gate = bookingPrepGate({ eventType: r.event_type, status: r.status })
  if (!gate.go) return { ok: false, outcome: gate.outcome, reason: gate.reason }

  const meta = r.metadata ?? {}

  const listingCandidate =
    params.listingId ?? (r.entity_type === "listing" ? r.entity_id : null) ?? str(meta.listing_id)
  let listing: Record<string, unknown> | null = null
  if (listingCandidate) {
    const { data, error } = await svc
      .from("listings")
      .select("id, contact_id, seller_contact_id, address, city, state, zip, bedrooms, bathrooms, sqft, year_built, lot_size, property_type")
      .eq("id", listingCandidate)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (error) return { ok: false, outcome: "error", reason: `listing read refused: ${error.message}` }
    listing = (data as Record<string, unknown> | null) ?? null
  }

  const contactCandidate =
    (r.entity_type === "contact" ? r.entity_id : null) ??
    str(meta.contact_id) ??
    (listing ? str(listing.seller_contact_id) ?? str(listing.contact_id) : null)
  type ContactRow = { id: string; contact_type: string | null; address: string | null; city: string | null; state: string | null; zip_code: string | null }
  let contact: ContactRow | null = null
  if (contactCandidate) {
    const { data, error } = await svc
      .from("contacts")
      .select("id, contact_type, address, city, state, zip_code")
      .eq("id", contactCandidate)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (error) return { ok: false, outcome: "error", reason: `contact read refused: ${error.message}` }
    contact = (data as ContactRow | null) ?? null
  }

  const isListingSeller = !!(contact && listing &&
    (listing.seller_contact_id === contact.id || listing.contact_id === contact.id))

  let valuations: Array<Record<string, unknown>> = []
  if (contact) {
    const { data, error } = await svc
      .from("valuation_requests")
      .select("property_address, city, state, zip_code, bedrooms, bathrooms, square_feet, year_built, submitted_at")
      .eq("contact_id", contact.id)
      .eq("brokerage_id", brokerageId)
      .order("submitted_at", { ascending: false })
      .limit(10)
    if (error) return { ok: false, outcome: "error", reason: `valuation_requests read refused: ${error.message}` }
    valuations = (data as Array<Record<string, unknown>> | null) ?? []
  }

  const verdict = classifySellerPrepContext({
    contactId: contact?.id ?? null,
    contactType: contact?.contact_type ?? null,
    isListingSeller,
    hasValuationRequest: valuations.length > 0,
  })
  if (!verdict.seller || !contact) return { ok: false, outcome: "refused", reason: verdict.seller ? "no_seller_contact" : verdict.reason }

  // THE ONE one-line address splitter (§6) — loaded here so the chain module's
  // static graph (the engine loads it) does not carry the property rail.
  const { splitOneLineAddress } = await import("@/lib/ai-isa/property-lookup-rail")
  const property = pickSellerProperty({
    listing, hint: params.propertyHint ?? null, valuations,
    bookedAddress: str(meta.property_address) ?? str(meta.location) ?? str(r.location),
    contact, split: splitOneLineAddress,
  })

  const agentUserId = await resolveBookingAgentUserId(svc, {
    brokerageId,
    agentUserIdColumn: r.agent_user_id,
    metadataAgentId: str(meta.agent_id) ?? str(meta.agentId),
  })

  return {
    ok: true,
    context: {
      calendarEventId: r.id, brokerageId, startAt: r.start_at, contactId: contact.id,
      agentUserId, property, sellerBasis: verdict.basis,
    },
  }
}

function pickSellerProperty(args: {
  listing: Record<string, unknown> | null
  hint: Record<string, unknown> | null
  valuations: Array<Record<string, unknown>>
  bookedAddress: string | null
  contact: { address: string | null; city: string | null; state: string | null; zip_code: string | null } | null
  split: (line: string) => { street: string; city?: string | null; state?: string | null; zip?: string | null }
}): SellerProperty {
  // 1. The listing row — the property the appointment is ON.
  if (args.listing && str(args.listing.address)) {
    const l = args.listing
    return {
      propertyAddress: str(l.address), state: str(l.state), city: str(l.city), zip: str(l.zip),
      listingId: str(l.id), bedrooms: num(l.bedrooms), bathrooms: num(l.bathrooms), sqft: num(l.sqft),
      yearBuilt: num(l.year_built), lotSize: num(l.lot_size), propertyType: str(l.property_type), source: "listing",
    }
  }
  const listingId = args.listing ? str(args.listing.id) : null

  // 2. What the booking caller captured (the ISA's property data).
  const h = args.hint
  if (h && str(h.address)) {
    const sp = args.split(str(h.address) as string)
    const state = str(h.state) ?? sp.state ?? null
    if (state) {
      return {
        propertyAddress: sp.street, state: state.toUpperCase(), city: str(h.city) ?? sp.city ?? null,
        zip: str(h.zip) ?? str(h.zipCode) ?? sp.zip ?? null, listingId,
        bedrooms: num(h.bedrooms), bathrooms: num(h.bathrooms), sqft: num(h.sqft), yearBuilt: num(h.yearBuilt),
        lotSize: num(h.lotSize), propertyType: str(h.propertyType), source: "caller_hint",
      }
    }
  }

  // 3. The home-value request — prefer the one for the address booked about.
  if (args.valuations.length > 0) {
    let chosen = args.valuations[0]
    if (args.bookedAddress) {
      const want = addressKey(args.bookedAddress)
      const match = args.valuations.find((v) => typeof v.property_address === "string" && addressKey(v.property_address) === want)
      if (match) chosen = match
    }
    if (str(chosen.property_address) && str(chosen.state)) {
      return {
        propertyAddress: str(chosen.property_address), state: str(chosen.state), city: str(chosen.city),
        zip: str(chosen.zip_code), listingId, bedrooms: num(chosen.bedrooms), bathrooms: num(chosen.bathrooms),
        sqft: num(chosen.square_feet), yearBuilt: num(chosen.year_built), lotSize: null, propertyType: null,
        source: "valuation_request",
      }
    }
  }

  // 4. The address the booking itself recorded — only when it carries a state.
  if (args.bookedAddress) {
    const sp = args.split(args.bookedAddress)
    if (sp.state && sp.street) {
      return { ...NO_PROPERTY, propertyAddress: sp.street, state: sp.state, city: sp.city ?? null, zip: sp.zip ?? null, listingId, source: "booking_address" }
    }
  }

  // 5. The seller's own home address on the contact card.
  const c = args.contact
  if (c && str(c.address) && str(c.state)) {
    return { ...NO_PROPERTY, propertyAddress: str(c.address), state: str(c.state), city: str(c.city), zip: str(c.zip_code), listingId, source: "seller_home_address" }
  }

  return { ...NO_PROPERTY, listingId }
}

/**
 * The booking's agent as a USERS id, proven inside the tenant. agent_user_id is
 * the column most writers fill with one; metadata.agent_id is a users.id on some
 * paths and an AGENTS id on others (home-value, the calendar scheduler), so it is
 * tested as each — never substituted (listing_presentations.agent_user_id FKs users).
 */
async function resolveBookingAgentUserId(
  svc: Svc,
  args: { brokerageId: string; agentUserIdColumn: string | null; metadataAgentId: string | null },
): Promise<string | null> {
  for (const candidate of [args.agentUserIdColumn, args.metadataAgentId]) {
    if (!candidate) continue
    const { data: user, error: userErr } = await svc
      .from("users").select("id").eq("id", candidate).eq("brokerage_id", args.brokerageId).maybeSingle()
    if (userErr) { console.error(`[listing-appt-prep] users check for ${candidate} refused: ${userErr.message}`); continue }
    if (user) return candidate
    const { data: agent, error: agentErr } = await svc
      .from("agents").select("user_id").eq("id", candidate).eq("brokerage_id", args.brokerageId).maybeSingle()
    if (agentErr) { console.error(`[listing-appt-prep] agents check for ${candidate} refused: ${agentErr.message}`); continue }
    const uid = (agent as { user_id?: string | null } | null)?.user_id ?? null
    if (uid) return uid
  }
  return null
}

export type ListingAppointmentSetResult =
  | { status: "started" | "deduped"; eventId: string; runId: string | null; runStatus: string | null; context: BookingPrepContext }
  | { status: "refused" | "deferred" | "skipped" | "error"; reason: string }

/** The run this chain started from ONE event (the orchestrator keys it on the event id). */
async function runForEvent(svc: Svc, brokerageId: string, eventId: string): Promise<{ id: string; status: string } | null> {
  const { data, error } = await svc
    .from("workflow_runs")
    .select("id, status")
    .eq("chain_key", listingApptPrepChain.key)
    .eq("brokerage_id", brokerageId)
    .eq("trigger_event_id", eventId)
    .order("started_at", { ascending: false })
    .limit(1)
  if (error) { console.error(`[listing-appt-prep] run read for event ${eventId} refused: ${error.message}`); return null }
  return ((data as Array<{ id: string; status: string }> | null) ?? [])[0] ?? null
}

/**
 * THE TRIGGER every listing-appointment booking path calls with the calendar_events
 * row it wrote: records THIS chain's `listing.appointment_set` event for the
 * booking (the server-only lifecycle-event core, the service client, the booking
 * row's tenant) and lets the orchestrator start the run from it. Never throws — a
 * prep that could not start must not undo a booking.
 *
 * An event already recorded for this booking is REUSED; if it never produced a run
 * (a dispatch that failed after the row landed) it is dispatched again, which the
 * engine turns into the one run keyed on that event.
 */
export async function fireListingAppointmentSetForBooking(
  svc: Svc,
  params: ResolveBookingPrepParams & { origin: string; delegate?: ListingPrepDelegate | null },
): Promise<ListingAppointmentSetResult> {
  const r = await fireListingAppointmentSetCore(svc, params)
  // The started / deduped variants are the ones that carry the resolved booking `context` (and a run).
  if (params.delegate && "context" in r) await issueListingPrepDelegation(svc, r, params.delegate)
  return r
}

/**
 * WAVE 105 (lane 105A) — THE OWNER'S EXAMPLE: AI ISA → PREPARE_SELLER_APPOINTMENT → Listing Concierge.
 * A MANAGER that books a seller appointment (the AI ISA's two booking paths pass `delegate`) does not
 * run the prep itself — it REQUESTS the Concierge's `listing_appointment_prep` capability as a
 * structured delegation (lib/kernel/manager-delegation.ts: objective, input entities, required output,
 * authority rung, deadline = the appointment). The chain run that this trigger just started IS the
 * Concierge's work, so the delegation is accepted and marked WORKING here; the engine returns the
 * result through it when the run completes (settleDelegationForRun) and escalates it if the run
 * fails or the reaper stalls it. A human booking carries no `delegate` — nothing manager-to-manager
 * happened. Idempotent per run (requestDelegation dedupes on input_entities.workflow_run_id).
 * Best-effort: a delegation that could not be recorded never undoes the prep.
 */
export interface ListingPrepDelegate { requestingManager: ManagerKey; missionId?: string | null }

async function issueListingPrepDelegation(svc: Svc, r: Extract<ListingAppointmentSetResult, { status: "started" | "deduped" }>, delegate: ListingPrepDelegate): Promise<void> {
  if (!r.runId) return
  try {
    const { requestDelegation, acceptDelegation, startDelegationWork, settleDelegationForRun, PREPARE_SELLER_APPOINTMENT_CAPABILITY } = await import("@/lib/kernel/manager-delegation")
    const { MIN_AUTHORITY_FOR_RISK } = await import("@/lib/ai-isa/persona-tool-policy")
    const ctx = r.context
    const req = await requestDelegation({
      brokerageId: ctx.brokerageId, missionId: delegate.missionId ?? null,
      requestingManager: delegate.requestingManager, assignedManager: "listing_concierge",
      capability: PREPARE_SELLER_APPOINTMENT_CAPABILITY,
      objective: `Prepare the listing appointment${ctx.startAt ? ` on ${ctx.startAt}` : ""} for contact ${ctx.contactId}: CMA, presentation, chapter reels and the pre-appointment drip`,
      inputEntities: { calendar_event_id: ctx.calendarEventId, contact_id: ctx.contactId, listing_id: ctx.property.listingId ?? null, agent_user_id: ctx.agentUserId, workflow_run_id: r.runId, seller_basis: ctx.sellerBasis },
      requiredOutput: { cma: true, presentation: true, chapter_videos: true, drip_enrolled: true, pre_listing_kit: "if_verified_address" },
      authority: MIN_AUTHORITY_FOR_RISK.LOW_RISK_WRITE ?? 0,
      deadline: ctx.startAt,
    }, svc as any)
    if (!req.ok) { console.error(`[listing-appt-prep] delegation NOT requested for run ${r.runId}: ${req.reason}`); return }
    const id = req.delegation.id
    const actor = { type: "manager" as const, id: "listing_concierge" }
    if (r.runStatus === "completed") { await settleDelegationForRun({ runId: r.runId, outcome: "completed", actor }, svc as any); return }
    if (r.runStatus === "failed" || r.runStatus === "cancelled") { await settleDelegationForRun({ runId: r.runId, outcome: "failed", detail: `run ${r.runStatus} before the delegation was recorded`, actor }, svc as any); return }
    if (req.delegation.status === "REQUESTED") {
      const acc = await acceptDelegation({ brokerageId: ctx.brokerageId, delegationId: id, reason: `the listing-appt-prep run ${r.runId} is the Concierge's work`, actor }, svc as any)
      if (!acc.ok) { console.error(`[listing-appt-prep] delegation ${id} NOT accepted: ${acc.reason}`); return }
    }
    if (req.delegation.status === "REQUESTED" || req.delegation.status === "ACCEPTED") {
      const w = await startDelegationWork({ brokerageId: ctx.brokerageId, delegationId: id, reason: `run ${r.runId} ${r.runStatus ?? "running"}`, actor }, svc as any)
      if (!w.ok) console.error(`[listing-appt-prep] delegation ${id} NOT marked working: ${w.reason}`)
    }
  } catch (err) {
    console.error(`[listing-appt-prep] delegation for run ${r.runId} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function fireListingAppointmentSetCore(
  svc: Svc,
  params: ResolveBookingPrepParams & { origin: string },
): Promise<ListingAppointmentSetResult> {
  try {
    const resolved = await resolveBookingPrepContext(svc, params)
    if (!resolved.ok) {
      if (resolved.outcome === "error") console.error(`[listing-appt-prep] ${params.origin} ${params.calendarEventId}: ${resolved.reason}`)
      return { status: resolved.outcome, reason: resolved.reason }
    }
    const ctx = resolved.context
    if (!ctx.property.propertyAddress || !ctx.property.state) {
      // Honest skip: the CMA is state-scoped and listing_presentations.state is NOT NULL.
      return { status: "skipped", reason: "no_seller_property_with_state" }
    }
    const p = ctx.property
    const dedupeKey = listingAppointmentSetDedupeKey(ctx.calendarEventId)
    const payload = {
      contact_id: ctx.contactId,
      listing_id: p.listingId,
      agent_user_id: ctx.agentUserId,
      appointment_id: ctx.calendarEventId,
      appointment_date: ctx.startAt,
      seller_prep: { basis: ctx.sellerBasis, property_source: p.source, origin: params.origin },
      property_data: {
        address: p.propertyAddress, city: p.city, state: p.state, zip: p.zip,
        bedrooms: p.bedrooms, bathrooms: p.bathrooms, sqft: p.sqft, yearBuilt: p.yearBuilt,
        lotSize: p.lotSize, propertyType: p.propertyType ?? "single_family",
      },
    }

    // One event per booking — read with NO time window (the core's own dedupe
    // read looks back 24 h; a tentative hold confirmed days later is the same
    // booking). A refused read is an error, never "no event yet".
    const readExisting = async () => svc
      .from("lifecycle_events")
      .select("id, brokerage_id, event_type, metadata, actor_user_id, created_at")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("event_type", listingApptPrepChain.triggerEvent)
      .eq("dedupe_key", dedupeKey)
      .limit(1)
    const { data: prior, error: priorErr } = await readExisting()
    if (priorErr) return { status: "error", reason: `listing.appointment_set dedupe read refused: ${priorErr.message}` }
    let existing = ((prior as Array<Record<string, any>> | null) ?? [])[0] ?? null

    if (!existing) {
      const { recordLifecycleEvent } = await import("@/lib/events/lifecycle-event-core")
      const rec = await recordLifecycleEvent(svc, ctx.brokerageId, {
        event_type: listingApptPrepChain.triggerEvent,
        user_id: ctx.agentUserId ?? undefined,
        payload,
        source: params.origin === "cron_safety_net" ? "cron" : "system",
        dedupe_key: dedupeKey,
        entity_type: "calendar_event",
        entity_id: ctx.calendarEventId,
      })
      if (rec.ok && !rec.deduped) {
        const run = await runForEvent(svc, ctx.brokerageId, rec.event.id)
        if (!run && !rec.dispatched) {
          return { status: "error", reason: `listing.appointment_set ${rec.event.id} recorded but not dispatched — the cron safety net re-dispatches it` }
        }
        return { status: "started", eventId: rec.event.id, runId: run?.id ?? null, runStatus: run?.status ?? null, context: ctx }
      }
      if (!rec.ok && !/23505|duplicate key/i.test(rec.error)) return { status: "error", reason: rec.error }
      // Lost the race (m673) or the core's own dedupe hit: re-read the winner.
      const { data: winner, error: winErr } = await readExisting()
      if (winErr) return { status: "error", reason: `listing.appointment_set re-read refused: ${winErr.message}` }
      existing = ((winner as Array<Record<string, any>> | null) ?? [])[0] ?? null
      if (!existing) return { status: "error", reason: rec.ok ? "deduped event not readable" : rec.error }
    }

    const eventId = String(existing.id)
    let run = await runForEvent(svc, ctx.brokerageId, eventId)
    if (!run) {
      // The event landed but never produced a run — dispatch it again (the engine
      // keys the run on this event, so a second dispatch cannot double it).
      const { getRegisteredEventDispatcher } = await import("@/lib/events/dispatcher-registry")
      const event = {
        id: eventId, brokerage_id: ctx.brokerageId, event_type: listingApptPrepChain.triggerEvent,
        payload: (existing.metadata as Record<string, any> | null) ?? payload,
        user_id: (existing.actor_user_id as string | null) ?? undefined,
        source: "system" as const, created_at: String(existing.created_at ?? new Date().toISOString()),
      }
      const registered = getRegisteredEventDispatcher()
      if (registered) await registered(event)
      else {
        const { orchestrateEvent } = await import("@/lib/orchestrator/internal")
        await orchestrateEvent(event)
      }
      run = await runForEvent(svc, ctx.brokerageId, eventId)
    }
    return { status: "deduped", eventId, runId: run?.id ?? null, runStatus: run?.status ?? null, context: ctx }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[listing-appt-prep] ${params.origin} ${params.calendarEventId} threw: ${reason}`)
    return { status: "error", reason }
  }
}

/**
 * The prep runs already started for this booking — the cron safety net's second
 * read. Matched on the run's metadata.appointment_id (the event payload carries it
 * into workflow_runs.metadata), so a run keyed on any event for this booking counts.
 */
export async function prepRunStatusesForBooking(
  svc: Svc,
  args: { brokerageId: string; calendarEventId: string },
): Promise<{ ok: true; statuses: string[] } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("workflow_runs")
    .select("status")
    .eq("chain_key", listingApptPrepChain.key)
    .eq("brokerage_id", args.brokerageId)
    .eq("metadata->>appointment_id", args.calendarEventId)
    .limit(20)
  if (error) return { ok: false, error: error.message }
  return { ok: true, statuses: ((data as Array<{ status: string }> | null) ?? []).map((r) => r.status) }
}

// TOMBSTONE (lane 88D, CLAUDE.md §1.1): lib/listing-presentation/booking-prep.ts (lane 87B)
// is DELETED. It was a second starter written beside this chain — the original listing-
// appointment prep (CMA → presentation → chapter reels → section drip → kit) — and its
// startRun keyed the run on calendar_events.id, which workflow_runs.trigger_event_id's FK
// to lifecycle_events refuses. Merged here FIRST: the seller gate (classifySellerPrepContext,
// this file:1007), the booking gate (bookingPrepGate, :1027), the booking-row resolution
// (resolveBookingPrepContext, :1121), the cron's decision (decideSafetyNetAction, :1047) and
// run read (prepRunStatusesForBooking, :1452). Its starter startListingPresentationPrepFromBooking
// → fireListingAppointmentSetForBooking (this file:1348); splitBookedAddress → lib/ai-isa/property-lookup-rail.ts::splitOneLineAddress
// (called directly); LISTING_APPOINTMENT_BOOKING_EVENT_TYPES →
// lib/kernel/calendar-types.ts CalendarEventType.LISTING_APPOINTMENT; its chain-key and
// trigger constants → listingApptPrepChain.key / .triggerEvent.
