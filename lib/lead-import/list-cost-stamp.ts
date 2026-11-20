/**
 * lib/lead-import/list-cost-stamp.ts — a PURCHASED LIST's cost reaches the tenant's spend
 * (wave 89, lane 89E; m678 lead_imports.list_cost_usd).
 *
 * Owner (wave 88): "spend should be what the tenant spent for that lead, not what was
 * included in their subscription like raw lead acquisition, enrichment which are platform
 * paid." Lane 88B left one tenant-paid part unrepresented — a list the brokerage BOUGHT
 * and imported — and recorded it as the next step. Owner (wave 89): "add any fields
 * necessary if there is a beneficial reason to add."
 *
 * THE RULE. The import records what the list cost (lead_imports.list_cost_usd, whole
 * list). Every row the tenant paid for gets an equal share — created contacts carry it as
 * contacts.acquisition_cost (the ONE tenant-paid figure every report already sums through
 * tenantPaidLeadSpend); a MERGED contact (the row matched someone already in the book) has
 * the share ADDED to what it already carries, because the tenant paid for that record too.
 * The figure is computed through the ONE payer vocabulary (computeLeadAcquisitionCost,
 * purchasedListShare → tenant) so the payer is decided in one place, never here.
 *
 * Server-only, service client, tenant pinned on every write; every `{ error }` read and
 * returned (CLAUDE.md §3). Zero-row matches are reported (a wrong-tenant contact id must
 * not read as "stamped").
 */
import "server-only"
import { computeLeadAcquisitionCost } from "@/lib/lead-pipeline/source-conversion-learning"

/** PURE — one row's share of the list price, in cents-rounded USD; null when the list carried no cost. */
export function purchasedListShareUsd(listCostUsd: number | null | undefined, totalRows: number | null | undefined): number | null {
  if (typeof listCostUsd !== "number" || !Number.isFinite(listCostUsd) || listCostUsd <= 0) return null
  if (typeof totalRows !== "number" || !Number.isFinite(totalRows) || totalRows <= 0) return null
  return computeLeadAcquisitionCost({ purchasedListShare: listCostUsd / totalRows })
}

export interface ListCostStampResult { ok: boolean; stamped: number; error?: string }

/**
 * Stamp one imported contact's share. `merged` adds to the existing tenant figure (the
 * tenant paid for the record whether or not it was already in the book).
 */
export async function stampPurchasedListCost(
  svc: any,
  input: { brokerageId: string; contactId: string; shareUsd: number | null; merged: boolean },
): Promise<ListCostStampResult> {
  if (input.shareUsd === null) return { ok: true, stamped: 0 }
  if (!input.brokerageId || !input.contactId) return { ok: false, stamped: 0, error: "list-cost stamp needs a tenant and a contact" }

  let next = input.shareUsd
  if (input.merged) {
    const { data: existing, error: readErr } = await svc
      .from("contacts")
      .select("acquisition_cost")
      .eq("id", input.contactId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (readErr) return { ok: false, stamped: 0, error: `contact acquisition_cost read refused: ${readErr.message}` }
    if (!existing) return { ok: false, stamped: 0, error: `contact ${input.contactId} is not in brokerage ${input.brokerageId}` }
    const prior = (existing as { acquisition_cost?: number | null }).acquisition_cost
    next = computeLeadAcquisitionCost({
      campaignCostShare: typeof prior === "number" && Number.isFinite(prior) ? prior : null,
      purchasedListShare: input.shareUsd,
    }) ?? input.shareUsd
  }

  const { data: rows, error } = await svc
    .from("contacts")
    .update({ acquisition_cost: next })
    .eq("id", input.contactId)
    .eq("brokerage_id", input.brokerageId)
    .select("id")
  if (error) return { ok: false, stamped: 0, error: `contact acquisition_cost write refused: ${error.message}` }
  const n = Array.isArray(rows) ? rows.length : 0
  if (n === 0) return { ok: false, stamped: 0, error: `contact ${input.contactId} matched no row in brokerage ${input.brokerageId} — nothing stamped` }
  return { ok: true, stamped: n }
}
