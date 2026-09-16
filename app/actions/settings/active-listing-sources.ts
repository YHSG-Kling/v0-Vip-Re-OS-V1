"use server"

/**
 * app/actions/settings/active-listing-sources.ts
 *
 * Wave 68 — the settings-surface reader/writer for a brokerage's active-listing source order
 * (owner question: "that is a lot of money to spend for leads, is the rentcast with optional idx
 * broker a better implementation for the smart search buyer criteria of on the market active
 * property listings?"). Sits on the same "Lead Sources & Listing Feeds" page as the IDX Broker /
 * RentCast vendor credential slots (app/dashboard/settings/integrations/lead-sources).
 *
 * ★ ACT-AS WRITE SEAM ★ — same shape as the sibling app/actions/settings/integrations.ts: reads
 * resolve through resolveActingContext, writes through resolveWriteContext (read_only
 * impersonation refused), and the brokerage-admin gate runs BEFORE either touches
 * brokerage_settings (CLAUDE.md §4 — gate first, then use the client).
 *
 * Both exports write/read through lib/buyer-search/listing-source-order.ts's OWN normalization
 * (`normalizeActiveListingSources`) so this settings page can never show — or persist — a value
 * the production resolver (`resolveActiveListingSources`, consulted by market-watch.ts,
 * external-match.ts and listings-batchdata-feed.ts) would not honor. One vocabulary (§6).
 */
import { revalidatePath } from "next/cache"
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { requireBrokerageAdmin } from "@/lib/auth/require-brokerage-admin"
import {
  normalizeActiveListingSources,
  DEFAULT_ACTIVE_LISTING_SOURCES,
  type ActiveListingSource,
} from "@/lib/buyer-search/listing-source-order"

export interface ActiveListingSourcesSetting {
  success: boolean
  sources: ActiveListingSource[]
  error?: string
}

/** Read this brokerage's active-listing source order for the settings page. */
export async function getActiveListingSourcesSetting(): Promise<ActiveListingSourcesSetting> {
  const acting = await resolveActingContext()
  if (!acting.ok) return { success: false, sources: [...DEFAULT_ACTIVE_LISTING_SOURCES], error: acting.error }
  const supabase = acting.db

  let brokerageId: string
  try {
    ;({ brokerageId } = await requireBrokerageAdmin(supabase, acting.userId))
  } catch (e) {
    return { success: false, sources: [...DEFAULT_ACTIVE_LISTING_SOURCES], error: e instanceof Error ? e.message : String(e) }
  }

  const { data, error } = await supabase
    .from("brokerage_settings")
    .select("active_listing_sources")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (error) return { success: false, sources: [...DEFAULT_ACTIVE_LISTING_SOURCES], error: error.message }
  return {
    success: true,
    sources: normalizeActiveListingSources((data as { active_listing_sources?: unknown } | null)?.active_listing_sources),
  }
}

/**
 * Persist a brokerage's active-listing source order. `sources` is normalized before it is
 * written — an unknown value is dropped, not stored, so a stale client build can never smuggle a
 * value the resolver would refuse anyway.
 */
export async function updateActiveListingSourcesSetting(
  sources: ActiveListingSource[],
): Promise<{ success: boolean; sources?: ActiveListingSource[]; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  const supabase = ctx.db

  let brokerageId: string
  try {
    ;({ brokerageId } = await requireBrokerageAdmin(supabase, ctx.userId))
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }

  const normalized = normalizeActiveListingSources(sources)

  const { data: existing } = await supabase
    .from("brokerage_settings")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  const { error } = existing
    ? await supabase
        .from("brokerage_settings")
        .update({ active_listing_sources: normalized, updated_at: new Date().toISOString() })
        .eq("id", (existing as { id: string }).id)
    : await supabase
        .from("brokerage_settings")
        .insert({ brokerage_id: brokerageId, active_listing_sources: normalized })

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/settings/integrations/lead-sources")
  return { success: true, sources: normalized }
}
