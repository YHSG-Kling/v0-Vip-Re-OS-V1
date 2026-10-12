"use server"

// app/actions/address-suggestions.ts
// ─────────────────────────────────────────────────────────────────────────────
// ADDRESS SUGGESTIONS — the server door for the address boxes (wave 140, lane 140P).
//
// Before this, app/components/ui/address-autocomplete.tsx and the offer-initiation flow
// fetched nominatim.openstreetmap.org straight from the BROWSER: outside the connector
// gateway (no outcome row, no provider health, no tenant on the call), two parsers, and a
// published raw-fetch exception in scripts/provider-adapter-guard.ts. Agents request
// CAPABILITIES, not vendors (OS-CONSTITUTION law 3): the client asks this action for
// suggestions; the action rides the osint_free survivor lib/external/nominatim-geocode.ts
// (suggestAddressesDetailed — gateway egress, courtesy pacer, skipWhenFailing) and books the
// call on the free ledger the same way the enrichment lane does (trackVendorUsageService,
// vendor osint_free, $0 by construction — the row records the work, never invents spend).
//
// Tenant: the SESSION (requireCaller). No brokerageId parameter — none is accepted.
// Fail closed: no session → no suggestions, no egress.

import { requireCaller } from "@/lib/auth/require-caller"
import { suggestAddressesDetailed, type AddressSuggestion } from "@/lib/external/nominatim-geocode"
import { trackVendorUsageService } from "@/lib/vendor-governance/track-vendor-usage"

export type AddressSuggestionsResult =
  | { ok: true; suggestions: AddressSuggestion[]; outcome: "ok" | "no_data" | "not_attempted" }
  | { ok: false; suggestions: []; outcome: "unreachable" | "refused"; error: string }

/**
 * Suggest US addresses for a partial query the user typed. Returns an empty list (never an
 * error the box must handle) for a short query or no match; `ok: false` only when the
 * provider was unreachable / skipped for health, or the caller has no session.
 */
export async function suggestAddresses(query: string): Promise<AddressSuggestionsResult> {
  const caller = await requireCaller()
  if (!caller.ok) return { ok: false, suggestions: [], outcome: "refused", error: caller.error }

  const probe = await suggestAddressesDetailed(String(query ?? ""), { brokerageId: caller.brokerageId })

  // Book the call on the free ledger when a request actually left (not_attempted = nothing left).
  // Same shape as lib/lead-pipeline/enrichment-orchestrator.ts's osint_free booking — $0 by the
  // VENDOR_PRICING row, never the unknown-vendor fallback. Never blocks the answer.
  if (probe.outcome !== "not_attempted") {
    try {
      await trackVendorUsageService({
        vendor: "osint_free",
        systemSource: "address_autocomplete",
        unitCount: 1,
        brokerageId: caller.brokerageId,
        agentId: caller.userId,
        metadata: { lane: "osint_free", connector: "nominatim", cost: 0, outcome: probe.outcome, status: probe.status, results: probe.value?.length ?? 0 },
      })
    } catch (err) {
      console.error("[address-suggestions] usage booking failed (answer still returned):", err instanceof Error ? err.message : err)
    }
  }

  if (probe.outcome === "unreachable") {
    return { ok: false, suggestions: [], outcome: "unreachable", error: probe.error ?? "address lookup unavailable" }
  }
  return { ok: true, suggestions: probe.value ?? [], outcome: probe.outcome }
}
