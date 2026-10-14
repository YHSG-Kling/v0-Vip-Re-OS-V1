// lib/enrichment/field-provenance-store.ts
//
// THE persistence door for field provenance (wave 100, lane 100C — OWNER LAW 2). The SHAPE and the
// writer live in lib/lead-pipeline/enrichment-column-map.ts (stampFieldProvenance — pure, no client);
// this file only lands those stamps for a writer that sets a column WITHOUT already rewriting
// enrichment_profile in the same update: the AVM value writers (app/actions/home-value.ts,
// lib/wealth-advisor/scan-opportunities.ts), staff edits (lib/kernel/crm.ts::updateContactRecord) and
// contact self-edits (app/actions/portal-settings.ts). Writers that already rewrite the profile
// (the enrichment drain, the contact card's "Enrich now", the raw-record path) stamp inline through
// withFieldProvenance and never come here.
//
// Read-modify-write on enrichment_profile, tenant-anchored on both id and brokerage_id. Non-blocking by
// contract: provenance describes a value the caller ALREADY wrote, so a refusal here is returned (and
// the callers log it) — it never undoes or fails the value write.
import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { withFieldProvenance, fieldProvenanceOf, type FieldProvenance } from "@/lib/lead-pipeline/enrichment-column-map"

export async function persistFieldProvenance(
  supabase: SupabaseClient<any, any, any>,
  target: { table: "contacts" | "leads"; id: string; brokerageId: string },
  stamps: Record<string, FieldProvenance>,
): Promise<{ ok: boolean; error?: string }> {
  if (Object.keys(stamps).length === 0) return { ok: true }
  const { data: row, error: readError } = await supabase
    .from(target.table)
    .select("enrichment_profile")
    .eq("id", target.id)
    .eq("brokerage_id", target.brokerageId)
    .maybeSingle()
  if (readError) return { ok: false, error: readError.message }
  if (!row) return { ok: false, error: `${target.table} row not found in this tenant` }
  const prior = ((row as { enrichment_profile?: Record<string, unknown> | null }).enrichment_profile ?? {}) as Record<string, unknown>
  const next = withFieldProvenance(prior, fieldProvenanceOf(prior), stamps)
  // .select() + count: an UPDATE matching nothing also resolves (CLAUDE.md §3).
  const { data: written, error: writeError } = await supabase
    .from(target.table)
    .update({ enrichment_profile: next })
    .eq("id", target.id)
    .eq("brokerage_id", target.brokerageId)
    .select("id")
  if (writeError) return { ok: false, error: writeError.message }
  if (!written || written.length === 0) return { ok: false, error: "provenance write matched no row" }
  return { ok: true }
}
