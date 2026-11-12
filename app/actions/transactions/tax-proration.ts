"use server"

// THE PRORATION INPUT SCREEN'S DOORS (wave 145, lane 145Z — lane 145C requirement 7; m873). The settlement agent's
// property-tax proration instruction for ONE deal: read with the line it produces, and recorded by the deal's TC / agent
// with its source. The one writer and reader is lib/transactions/tax-proration.ts; the math is lane 144D's engine
// (estimateSellerClosingCosts({ taxProration })). Tenant from the SESSION (§4); the deal is read under the session's
// brokerage before anything else; a write that matches no row is an error (§3). No jurisdiction default is ever filled in.
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isBrokerageFinanceAdminGrantRole } from "@/lib/auth/resolve-user-role"
import {
  CLOSING_DAY_OWNERS, PRORATION_DAY_BASES, TAX_PAYMENT_TIMINGS,
  parseTaxProrationInstruction, persistTaxProration, prorationLineFor, readTaxProration,
  type StoredTaxProration,
} from "@/lib/transactions/tax-proration"
import type { SellerCostLine } from "@/lib/offers/seller-closing-costs"

export interface TaxProrationView {
  instruction: StoredTaxProration | null
  line: SellerCostLine | null
  closeDateDiffers: boolean
  dealCloseDate: string | null
  canEdit: boolean
  /** m873 not applied: the screen says so instead of offering a save that cannot land. */
  notApplied: boolean
  /** The engine's own vocabularies, handed to the form (never retyped in the client). */
  options: { timings: readonly string[]; closingDayOwners: readonly string[]; dayBases: readonly string[] }
}

/** Who may RECORD the instruction: the deal's own agent, its TC, and the brokerage's books roster (the same seats the deal
 *  page admits, minus compliance_officer, who reads the books and never keeps them — CLAUDE.md §4). */
function mayEdit(identity: { agentId: string | null; userType: string }, dealAgentId: string | null): boolean {
  return (!!identity.agentId && identity.agentId === dealAgentId) || identity.userType === "tc" || isBrokerageFinanceAdminGrantRole(identity.userType)
}

function mayRead(identity: { agentId: string | null; userType: string }, dealAgentId: string | null): boolean {
  return mayEdit(identity, dealAgentId) || identity.userType === "compliance_officer"
}

export async function getTaxProrationAction(transactionId: string): Promise<{ ok: true; view: TaxProrationView } | { ok: false; error: string }> {
  if (typeof transactionId !== "string" || !transactionId) return { ok: false, error: "transactionId is required" }
  const identity = await getAgentContext()
  if (!identity.isAuthenticated || !identity.brokerageId || !identity.userId) return { ok: false, error: "Not signed in to a brokerage" }
  const supabase = await createClient()
  const read = await readTaxProration(supabase as never, { transactionId, brokerageId: identity.brokerageId })
  if (!read.ok) return { ok: false, error: read.error }
  if (!mayRead(identity, read.deal.agentId)) return { ok: false, error: "This deal's closing figures are for its agent, its TC and the brokerage's principals" }
  const { line, closeDateDiffers } = prorationLineFor(read.instruction, read.deal)
  return {
    ok: true,
    view: {
      instruction: read.instruction, line, closeDateDiffers,
      dealCloseDate: read.deal.closeDate ? read.deal.closeDate.slice(0, 10) : null,
      canEdit: mayEdit(identity, read.deal.agentId), notApplied: !read.columnPresent,
      options: { timings: TAX_PAYMENT_TIMINGS, closingDayOwners: CLOSING_DAY_OWNERS, dayBases: PRORATION_DAY_BASES },
    },
  }
}

export async function saveTaxProrationAction(input: {
  transactionId: string
  annualTax: number | string
  periodStart: string
  timing: string
  closeDate: string
  closingDayOwner: string
  dayBasis: string
  source: string
}): Promise<{ ok: true; view: TaxProrationView } | { ok: false; error: string; missing?: string[] }> {
  if (!input || typeof input.transactionId !== "string" || !input.transactionId) return { ok: false, error: "transactionId is required" }
  const identity = await getAgentContext()
  if (!identity.isAuthenticated || !identity.brokerageId || !identity.userId) return { ok: false, error: "Not signed in to a brokerage" }
  const supabase = await createClient()
  const read = await readTaxProration(supabase as never, { transactionId: input.transactionId, brokerageId: identity.brokerageId })
  if (!read.ok) return { ok: false, error: read.error }
  if (!mayEdit(identity, read.deal.agentId)) return { ok: false, error: "Only this deal's agent, its TC or the brokerage's principals record the proration instruction" }
  if (!read.columnPresent) return { ok: false, error: "The proration instruction cannot be saved yet — its column (m873) is not applied" }

  const parsed = parseTaxProrationInstruction(input)
  if (!parsed.ok) return { ok: false, error: `Still needed: ${parsed.missing.join("; ")}`, missing: parsed.missing }

  // Gate first (session identity, the deal read under the session's RLS and brokerage, the seat), THEN the service client
  // for the one write — pinned to the session brokerage and row-counted inside persistTaxProration (CLAUDE.md §4).
  const saved = await persistTaxProration(createServiceClient() as never, { transactionId: input.transactionId, brokerageId: identity.brokerageId, value: parsed.value, recordedBy: identity.userId })
  if (!saved.ok) return { ok: false, error: saved.error }

  const back = await getTaxProrationAction(input.transactionId)
  return back.ok ? back : { ok: false, error: `Saved, but it could not be read back: ${back.error}` }
}
