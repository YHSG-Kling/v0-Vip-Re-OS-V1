// lib/inbound-mail/deal-doc-intake.ts
// ─────────────────────────────────────────────────────────────────────────────
// INBOUND DEAL-DOC INTAKE (server) — the generalized lookout beyond offers. Runs AFTER the offer
// intake (which auto-ingests offers/counteroffers): for the remaining outside-party deal docs that
// matched an in-house listing — signed contracts, inspection / appraisal reports, lender clear-to-
// close, disclosures — classify the type and route it to the manager who OWNS that stage, surfacing
// a one-tap "file it to the deal" notification to the responsible agent. Confirm-first (we never
// auto-file a transaction doc from an email); best-effort, never throws into the webhook.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { matchListingByAddress, type ListingLite } from "./offer-detect"
import { classifyDealDoc, routeForDocType } from "./deal-doc-router"

type Svc = ReturnType<typeof createServiceClient>

export interface InboundDocAttachment { fileName: string; mime: string; contentB64: string | null }
export interface DealDocIntakeResult { handled: boolean; docType?: string; manager?: string; listingId?: string }

export async function routeInboundDealDoc(
  input: {
    brokerageId: string
    subject: string | null
    bodyText: string | null
    fromEmail: string | null
    attachments: InboundDocAttachment[]
  },
  client?: Svc,
): Promise<DealDocIntakeResult> {
  const svc = client ?? createServiceClient()
  const pdfs = input.attachments.filter((a) => a.mime === "application/pdf")
  if (pdfs.length === 0) return { handled: false }

  const fileNames = pdfs.map((p) => p.fileName).join(" ")
  const docType = classifyDealDoc({ subject: input.subject, fileNames, body: input.bodyText })
  const route = routeForDocType(docType)
  // Only handle the NON-auto-ingestable deal docs here — offers/counteroffers are owned by the
  // offer-intake path that runs before this. Unknown docs fall through to the generic handler.
  if (!route || route.autoIngestable) return { handled: false }

  // Match the doc to an in-house listing (by address, not sender — same as the offer lookout).
  const { data: lst } = await svc
    .from("listings")
    .select("id, address, agent_id")
    .eq("brokerage_id", input.brokerageId)
    .in("status", ["active", "coming_soon", "pending"])
    .limit(300)
  const listings = (lst ?? []) as ListingLite[]
  if (listings.length === 0) return { handled: false }
  const text = [input.subject, input.bodyText, fileNames].filter(Boolean).join(" \n ")
  const match = matchListingByAddress(text, listings)
  if (!match) return { handled: false }

  // Route: surface a one-tap "file it to the deal" notification to the responsible agent. The owning
  // MANAGER (Deal Coordinator for transaction docs, Listing Concierge for disclosures) is named so the
  // team coordination is legible; we don't auto-file a transaction doc from an email (confirm-first).
  try {
    const agentUserId = await resolveListingAgentUser(svc, match.agent_id ?? null)
    if (agentUserId) {
      await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: input.brokerageId, type: "deal_doc_received",
        title: `📄 ${capitalize(route.label)} arrived by email`,
        body: `${capitalize(route.label)}${input.fromEmail ? ` from ${input.fromEmail}` : ""} for ${match.address} — file it to the deal (${managerLabel(route.manager)} handles this stage).`,
        entity_type: "listing", entity_id: match.id, priority: "high", is_read: false,
      })
    }
  } catch (e) {
    console.error("[deal-doc-intake] notify failed:", e)
    return { handled: false }
  }
  return { handled: true, docType, manager: route.manager, listingId: match.id }
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }
function managerLabel(m: string): string {
  return m === "deal_coordinator" ? "Deal Coordinator" : m === "listing_concierge" ? "Listing Concierge" : "Shopping Agent"
}
async function resolveListingAgentUser(svc: Svc, agentId: string | null): Promise<string | null> {
  if (!agentId) return null
  const { data } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  return (data as { user_id: string | null } | null)?.user_id ?? null
}
