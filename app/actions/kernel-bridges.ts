"use server"

// app/actions/kernel-bridges.ts
//
// THIN "use server" WRAPPERS over lib/kernel and lib/documents capabilities that
// a CLIENT component cannot import directly.
//
// Named for what they are, not for the bug that surfaced them: each of these
// existed as a complete server-side capability with no callable path from the
// browser, so the control that should have invoked it sat inert. The wrapper IS
// the missing middle.
//
// Every one authorises FIRST (portal contact access / brokerage scope) and only
// then reaches for the service client — the wrapper must not become a way around
// the gate the capability was relying on.

/**
 * THE MISSING MIDDLE, server side.
 *
 * Two capabilities in this codebase were complete and reachable from NOTHING,
 * because the only surfaces that want them are CLIENT components while the
 * capability itself lives behind a server-only module. There was no defect in
 * either end — only the absence of a callable seam between them:
 *
 *   · netSheetPdfSpec (lib/documents/client-pdf) + produceClientDocument's
 *     "net_sheet" document type. The branch existed in the union and no caller
 *     ever selected it, so the seller portal's "Download Net Sheet PDF" button
 *     had no handler at all and the seller left with nothing on paper.
 *
 *   · previewQrAsset (lib/kernel/marketing) — a KERNEL function, not a server
 *     action, with zero callers anywhere. The mobile open-house panel's "QR
 *     Code" button rendered for every event that HAD a qr_code_id and did
 *     nothing when tapped, so the agent at the door could not put the sign-in
 *     code in front of a visitor.
 *
 * Both wrappers are thin on purpose: authorize, resolve tenant scope, call the
 * real thing, return exactly what it returned. Neither invents a number, a
 * fallback, or a success.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { netSheetPdfSpec } from "@/lib/documents/client-pdf"
import { resolvePdfBrand, produceClientDocument } from "@/lib/documents/client-document-producer"
import { previewQrAsset } from "@/lib/kernel/marketing"

/**
 * One priced scenario off the portal net-sheet calculator. The figures are the
 * ones the seller is looking at on screen — this action does no arithmetic of
 * its own, so the PDF and the screen can never disagree.
 */
interface NetSheetScenarioInput {
  label: string
  salePrice: number
  commission: number
  closingCosts: number
  mortgagePayoff?: number | null
  other?: number | null
  netProceeds: number
}

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

/**
 * Render + host + record the seller's net sheet as a branded PDF, returning the
 * hosted URL. Files under the seller's contact (and their listing when there is
 * one) in generated_documents, so the agent sees the same piece the client got.
 */
export async function generateNetSheetPdf(params: {
  contactId: string
  propertyAddress: string
  scenarios: NetSheetScenarioInput[]
}): Promise<{ success: boolean; pdfUrl?: string; documentId?: string | null; error?: string }> {
  const access = await requireContactAccess(params.contactId)
  if (!access.ok) return { success: false, error: access.error }

  if (!params.scenarios?.length) {
    return { success: false, error: "No scenarios were supplied — nothing to print." }
  }
  for (const s of params.scenarios) {
    if (
      !isFiniteNumber(s.salePrice) ||
      !isFiniteNumber(s.commission) ||
      !isFiniteNumber(s.closingCosts) ||
      !isFiniteNumber(s.netProceeds)
    ) {
      return { success: false, error: "The net sheet figures are incomplete — check the calculator inputs." }
    }
  }

  const svc = createServiceClient()

  const { data: contact } = await svc
    .from("contacts")
    .select("first_name, last_name, agent_id")
    .eq("id", params.contactId)
    .maybeSingle()

  // The seller's own listing gives the document its listing_id, so the piece
  // files against the right property in the document library.
  const { data: listing } = await svc
    .from("listings")
    .select("id")
    .eq("seller_contact_id", params.contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // generated_documents.agent_id and the brand block both key off the agent's
  // USER id (agents.user_id), not agents.id.
  let agentUserId: string | null = null
  if ((contact as any)?.agent_id) {
    const { data: agent } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", (contact as any).agent_id)
      .maybeSingle()
    agentUserId = (agent as any)?.user_id ?? null
  }

  const brand = await resolvePdfBrand(svc, { brokerageId: access.brokerageId, agentUserId })
  const dateLabel = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })

  const spec = netSheetPdfSpec(
    {
      propertyAddress: params.propertyAddress?.trim() || "Your property",
      sellerName: [(contact as any)?.first_name, (contact as any)?.last_name].filter(Boolean).join(" ") || null,
      scenarios: params.scenarios.map((s) => ({
        label: s.label,
        salePrice: s.salePrice,
        commission: s.commission,
        closingCosts: s.closingCosts,
        mortgagePayoff: isFiniteNumber(s.mortgagePayoff) ? s.mortgagePayoff : null,
        other: isFiniteNumber(s.other) ? s.other : null,
        netProceeds: s.netProceeds,
      })),
    },
    brand,
    dateLabel,
  )

  const produced = await produceClientDocument(svc, {
    brokerageId: access.brokerageId,
    agentUserId,
    contactId: params.contactId,
    listingId: (listing as any)?.id ?? null,
    documentType: "net_sheet",
    spec,
    metadata: { source: "portal_net_sheet_calculator", scenario_count: params.scenarios.length },
  })

  if (!produced.ok || !produced.pdfUrl) {
    return { success: false, error: produced.error ?? "The net sheet PDF could not be generated." }
  }
  return { success: true, pdfUrl: produced.pdfUrl, documentId: produced.documentId }
}

/**
 * Open-house QR preview for the mobile field panel. previewQrAsset is a kernel
 * function (no "use server"), so a client component cannot reach it directly;
 * this is the seam. The brokerage scope comes from the signed-in agent's own
 * context — the panel never receives it as a prop, and taking one from the
 * client would be a tenant-scoping hole anyway.
 */
export async function previewOpenHouseQr(params: { qrCodeId: string }): Promise<{
  success: boolean
  error?: string
  qr?: {
    label: string
    slug: string
    targetUrl: string
    purpose: string
    scanCount: number
    leadCount: number
    isActive: boolean
    expiresAt: string | null
  }
}> {
  if (!params.qrCodeId) return { success: false, error: "No QR code is attached to this open house." }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Please sign in again." }
  if (!ctx.brokerageId) return { success: false, error: "Your account is not attached to a brokerage." }

  const result = await previewQrAsset({ qrCodeId: params.qrCodeId, brokerageId: ctx.brokerageId })
  if (!result.success || !result.data) {
    return { success: false, error: result.error ?? "QR code not found." }
  }
  return { success: true, qr: result.data }
}
