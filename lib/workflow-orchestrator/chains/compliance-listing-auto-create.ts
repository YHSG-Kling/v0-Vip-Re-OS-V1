/**
 * Chain: compliance-listing-auto-create
 *
 * Triggered when a seller contact's listing-agreement docs pass the compliance
 * scan (signature/initial completeness verified). Auto-creates the listings
 * row using extracted contract terms — agent never manually clicks "Create
 * Listing." On creation, agent is notified.
 *
 * Steps:
 *   1. validate_extracted_data — ensure key fields present
 *   2. create_listing          — INSERT into listings with extracted data
 *   3. notify_agent            — push notification + activity log
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { WorkflowChain } from "../types"

export const complianceListingAutoCreateChain: WorkflowChain = {
  key: "compliance-listing-auto-create",
  label: "Auto-Create Listing on Compliance Pass",
  triggerEvent: "compliance.listing_agreement_passed",
  steps: [
    {
      key: "validate_extracted_data",
      label: "Validate Extracted Contract Data",
      handler: async (ctx) => {
        const data = ctx.metadata.extracted ?? {}
        const required = ["propertyAddress", "listPrice"]
        const missing = required.filter((k) => !data[k])
        if (missing.length > 0) {
          return {
            success: false,
            error: `Missing required fields from extraction: ${missing.join(", ")}`,
          }
        }
        return { success: true, output: { validated: true } }
      },
    },

    {
      key: "create_listing",
      label: "Create Listing Record",
      handler: async (ctx) => {
        const svc = createServiceClient()
        const data = ctx.metadata.extracted ?? {}

        if (!ctx.contactId || !ctx.agentUserId) {
          return { success: false, error: "Missing contact or agent context" }
        }

        // Resolve agents.id from auth user
        const { data: agent } = await svc
          .from("agents")
          .select("id")
          .eq("user_id", ctx.agentUserId)
          .maybeSingle()
        if (!agent) return { success: false, error: "Agent profile not found" }

        // ── ADOPT THE DRAFT BEFORE CREATING ANYTHING ──────────────────────────
        // Two doors open a listing and BOTH are legitimate:
        //   · the agent runs the New Listing wizard first, which parks a DRAFT row
        //     (createListingRecord → status='draft', LISTING_AGREEMENT_INITIATED)
        //     so the agreement and its forms have something to hang off;
        //   · the signed agreement simply arrives, with no draft ahead of it —
        //     the "agent never manually clicks Create Listing" path.
        //
        // A bare INSERT serves only the second door. Once the wizard parks a draft,
        // the same property would end up with TWO listing rows — the draft the agent
        // has been working in, and a second one the seller's portal, the media
        // pipeline and the MLS-readiness gate would each pick differently. So look
        // for this seller's draft at THIS brokerage first and promote it in place.
        const draftAddress = String(data.propertyAddress ?? "").trim().toLowerCase()
        const { data: draftCandidates } = await svc
          .from("listings")
          .select("id, address")
          .eq("brokerage_id", ctx.brokerageId)
          .eq("seller_contact_id", ctx.contactId)
          .eq("status", "draft")
          .order("created_at", { ascending: false })

        const existingDraft = (draftCandidates ?? []).find(
          (l) => String(l.address ?? "").trim().toLowerCase() === draftAddress,
        )

        if (existingDraft) {
          // Payload hoisted so the WHERE clause sits directly against .from() —
          // the tenant filters below are the point of this write, not a footnote
          // buried under twenty lines of column assignments.
          const promotion = {
            list_price:      data.listPrice,
            listing_date:    data.listDate ?? null,
            expiration_date: data.expirationDate ?? null,
            commission_rate: data.commissionRate ?? null,
            city:            data.city ?? null,
            state:           data.state ?? null,
            zip:             data.zipCode ?? null,
            status:          "coming_soon",
            lifecycle_stage: "LISTING_AGREEMENT_SIGNED",
            metadata: {
              source_document_id: ctx.metadata.document_id,
              extracted_terms: data,
              workflow_run_id: ctx.runId,
              promoted_from_draft: true,
            },
            updated_at: new Date().toISOString(),
          }

          const { data: promoted, error: promoteErr } = await svc
            .from("listings")
            .update(promotion)
            .eq("id", existingDraft.id)
            // The id came from a brokerage-scoped read, but the WRITE carries the
            // tenant anchor too — a promotion must never be able to reach across
            // brokerages even if the lookup above is one day loosened.
            .eq("brokerage_id", ctx.brokerageId)
            // Re-assert the draft state in the WHERE clause: if a concurrent run
            // already promoted this row, 0 rows come back and we do not double-fire.
            .eq("status", "draft")
            .select("id")
            .maybeSingle()

          if (promoteErr) {
            return { success: false, error: `Draft promotion failed: ${promoteErr.message}` }
          }
          if (!promoted) {
            // Already promoted by another run — the listing exists and is signed.
            // Not an error; hand the id downstream so notify_agent still resolves.
            return { success: true, output: { listingId: existingDraft.id, adopted: true, alreadyPromoted: true } }
          }

          const { KernelEvent } = await import("@/lib/kernel/events")
          // One emit does the audit row + fan-out (was a direct insert whose outcome was
          // swallowed by `.then(() => {})`, then a separate fan-out call).
          try {
            const { emitKernelEvent } = await import("@/lib/kernel/emit")
            const r = await emitKernelEvent({
              event: KernelEvent.LISTING_CREATED,
              brokerageId: ctx.brokerageId,
              entityType: "listing",
              entityId: existingDraft.id,
              sellerContactId: ctx.contactId,
              listingId: existingDraft.id,
              agentUserId: ctx.agentUserId,
              actorUserId: ctx.agentUserId ?? null,
              metadata: { stage: "LISTING_AGREEMENT_SIGNED", agent_id: agent.id, promoted_from_draft: true },
            })
            if (r.error) console.error("[compliance-listing-auto-create] LISTING_CREATED row refused (non-fatal):", r.error)
          } catch (err: any) {
            console.error("[compliance-listing-auto-create] LISTING_CREATED fan-out failed (non-fatal):", err?.message ?? err)
          }

          return { success: true, output: { listingId: existingDraft.id, adopted: true } }
        }

        const { data: listing, error } = await svc
          .from("listings")
          .insert({
            brokerage_id: ctx.brokerageId,
            agent_id: agent.id,
            seller_contact_id: ctx.contactId,
            address: data.propertyAddress,
            city: data.city ?? null,
            state: data.state ?? null,
            zip: data.zipCode ?? null,
            list_price: data.listPrice,
            listing_date: data.listDate ?? null,
            expiration_date: data.expirationDate ?? null,
            commission_rate: data.commissionRate ?? null,
            // listings_status_check allows coming_soon|active|pending|sold|expired|
            // withdrawn — a freshly auto-created (signed, pre-MLS) listing is
            // "coming_soon". ("pending_mls" violated the constraint → insert threw.)
            status: "coming_soon",
            lifecycle_stage: "LISTING_AGREEMENT_SIGNED",
            created_via: "compliance_auto_create",
            metadata: {
              source_document_id: ctx.metadata.document_id,
              extracted_terms: data,
              workflow_run_id: ctx.runId,
            },
          })
          .select("id")
          .single()

        if (error || !listing) {
          return { success: false, error: error?.message ?? "Listing insert failed" }
        }

        // Emit LISTING_CREATED so downstream automation enrolls — same signal the
        // kernel createListingRecord emits. Direct-insert chains otherwise skip it,
        // so auto-created listings never kicked off marketing/portal automation.
        const { KernelEvent } = await import("@/lib/kernel/events")
        // One emit does the audit row + fan-out (see the draft-promotion branch above).
        try {
          const { emitKernelEvent } = await import("@/lib/kernel/emit")
          const r = await emitKernelEvent({
            event: KernelEvent.LISTING_CREATED,
            brokerageId: ctx.brokerageId,
            entityType: "listing",
            entityId: listing.id as string,
            sellerContactId: ctx.contactId,
            listingId: listing.id as string,
            agentUserId: ctx.agentUserId,
            actorUserId: ctx.agentUserId ?? null,
            metadata: { stage: "LISTING_AGREEMENT_SIGNED", agent_id: agent.id, created_via: "compliance_auto_create" },
          })
          if (r.error) console.error("[compliance-listing-auto-create] LISTING_CREATED row refused (non-fatal):", r.error)
        } catch (err: any) {
          console.error("[compliance-listing-auto-create] LISTING_CREATED fan-out failed (non-fatal):", err?.message ?? err)
        }

        return {
          success: true,
          output: { listingId: listing.id },
        }
      },
    },

    {
      key: "notify_agent",
      label: "Notify Agent",
      handler: async (ctx) => {
        const svc = createServiceClient()
        const listingId = ctx.previousStepOutputs.create_listing?.listingId
        if (!listingId || !ctx.agentUserId) {
          return { success: false, error: "Missing listingId or agentUserId" }
        }

        await svc.from("notifications").insert({
          user_id: ctx.agentUserId,
          brokerage_id: ctx.brokerageId,
          title: "Listing created from signed agreement",
          body: "Compliance review passed — your listing is ready to go live.",
          type: "listing_created",
          entity_type: "listing",
          entity_id: listingId,
          priority: "high",
          is_read: false,
        })

        // The record that compliance passing an agreement AUTO-CREATED a
        // listing — the provenance of a row nobody typed.
        const { error: autoCreateActivityError } = await svc.from("activities").insert({
          contact_id: ctx.contactId,
          brokerage_id: ctx.brokerageId,
          agent_user_id: ctx.agentUserId,
          activity_type: "listing_auto_created",
          description: "Listing record auto-created from compliance-passed listing agreement.",
          metadata: { listing_id: listingId, workflow_run_id: ctx.runId },
        })
        if (autoCreateActivityError) {
          console.error(`[compliance-listing-auto-create] listing_auto_created activity REJECTED for listing ${listingId} — the listing has no provenance record:`, autoCreateActivityError.message)
        }

        return { success: true, output: { notified: true } }
      },
    },
  ],
}
