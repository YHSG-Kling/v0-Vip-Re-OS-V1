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

        const { data: listing, error } = await svc
          .from("listings")
          .insert({
            brokerage_id: ctx.brokerageId,
            agent_id: agent.id,
            seller_contact_id: ctx.contactId,
            address: data.propertyAddress,
            city: data.city ?? null,
            state: data.state ?? null,
            zip_code: data.zipCode ?? null,
            list_price: data.listPrice,
            list_date: data.listDate ?? null,
            expiration_date: data.expirationDate ?? null,
            commission_rate: data.commissionRate ?? null,
            status: "pending_mls",
            lifecycle_stage: "agreement_signed",
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

        await svc.from("activities").insert({
          contact_id: ctx.contactId,
          brokerage_id: ctx.brokerageId,
          agent_user_id: ctx.agentUserId,
          activity_type: "listing_auto_created",
          description: "Listing record auto-created from compliance-passed listing agreement.",
          metadata: { listing_id: listingId, workflow_run_id: ctx.runId },
        })

        return { success: true, output: { notified: true } }
      },
    },
  ],
}
