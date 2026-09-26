"use server"

/**
 * app/actions/superadmin/active-listing-sources.ts
 *
 * Wave 69 — the PLATFORM-STAFF-ONLY read/write seam for
 * `brokerage_settings.active_listing_sources`. OWNER RULING (verbatim, 2026-09-17): "rentcast
 * is platform provided but idx is for tenant connected if the tenant has this connection
 * instead of rentcast option for for sale properties. the setting page should only allow them
 * to setup their idx connection."
 *
 * This column no longer carries a tenant-chosen idx/rentcast ranking (that is DERIVED — see
 * lib/buyer-search/listing-source-order.ts::resolveActiveListingSources). The one thing left in
 * it is whether this brokerage is opted into the BILLED BatchData on-market pull, and that is a
 * PLATFORM cost decision, not a tenant one — hence superadmin-only, the same gate every other
 * money-affecting lever in app/actions/superadmin/brokerage-management.ts uses.
 *
 * TOMBSTONE — app/actions/settings/active-listing-sources.ts (the wave-68 tenant read/write seam
 * for this column) is DELETED; this file plus
 * lib/buyer-search/listing-source-order.ts::resolveActiveListingSources are the survivors.
 */
import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import {
  normalizeActiveListingSources,
  type ActiveListingSource,
} from "@/lib/buyer-search/listing-source-order"

export interface BrokerageActiveListingSourcesState {
  ok: boolean
  sources: ActiveListingSource[]
  error?: string
}

/** Read-only: does this brokerage's PLATFORM-managed column currently include the billed
 *  BatchData on-market pull? Superadmin-gated like every other tenant-detail read on this page. */
export async function getBrokerageActiveListingSourcesAction(
  brokerageId: string,
): Promise<BrokerageActiveListingSourcesState> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return { ok: false, sources: [], error: auth.error }
  if (!brokerageId) return { ok: false, sources: [], error: "brokerageId required" }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("brokerage_settings")
    .select("active_listing_sources")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (error) return { ok: false, sources: [], error: error.message }
  return {
    ok: true,
    sources: normalizeActiveListingSources(
      (data as { active_listing_sources?: unknown } | null)?.active_listing_sources,
    ),
  }
}

/**
 * Set whether this brokerage is opted into the billed BatchData on-market pull. `sources` is
 * normalized before it is written (drops any unknown value — an "idx"/"rentcast" entry is
 * accepted-and-dropped here too, since the resolver never reads them from this column any more)
 * so a stale client can never persist a value the resolver would ignore anyway.
 */
export async function setBrokerageActiveListingSourcesAction(params: {
  brokerageId: string
  sources: ActiveListingSource[]
}): Promise<BrokerageActiveListingSourcesState> {
  const auth = await requireSuperadmin()
  if (!auth.ok) return { ok: false, sources: [], error: auth.error }
  if (!params.brokerageId) return { ok: false, sources: [], error: "brokerageId required" }

  const normalized = normalizeActiveListingSources(params.sources)
  const svc = createServiceClient()

  const { data: existing } = await svc
    .from("brokerage_settings")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  const { error } = existing
    ? await svc
        .from("brokerage_settings")
        .update({ active_listing_sources: normalized, updated_at: new Date().toISOString() })
        .eq("id", (existing as { id: string }).id)
    : await svc
        .from("brokerage_settings")
        .insert({ brokerage_id: params.brokerageId, active_listing_sources: normalized })
  if (error) return { ok: false, sources: [], error: error.message }

  try {
    await svc.from("superadmin_audit_log").insert({
      actor_user_id: auth.userId,
      actor_email: auth.email,
      action: "brokerage.active_listing_sources_set",
      target_type: "brokerage",
      target_id: params.brokerageId,
      details: { sources: normalized },
    })
  } catch {
    // Non-fatal — the write above already landed; audit failure must not undo it.
  }

  revalidatePath(`/dashboard/superadmin/brokerages/${params.brokerageId}`)
  revalidatePath("/dashboard/settings/integrations/lead-sources")
  return { ok: true, sources: normalized }
}
