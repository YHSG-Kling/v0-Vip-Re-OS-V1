// lib/enrichment/protected-research-store.ts
//
// THE SEGREGATED RESEARCH HOME — writer (wave 145, lane 145F; owner ruling 12: "There should be no protected fair housing protected
// attributes holding back any enrichment syncing as it is a major road block when needing that research.").
//
// Enrichment syncing proceeds; the protected / sensitive fields a provider returns are STORED — never dropped, never exposed:
//   · STORE: public.protected_research_attributes (m864) — one row per (contact, provider, the vendor's verbatim field), with the
//     protected class it bears, the BASIS (Versium's are vendor-MODELED — never a self-identified fact), the provenance (provider,
//     capability, retrieved_at, match confidence) and first-observed / value-changed stamps (a re-capture of an unchanged value
//     moves retrieved_at only — the field / provenance CHANGE is what is dated, ruling 11's grain).
//   · ACCESS: RLS — service-role writes only (this module), SELECT for platform staff or a same-tenant compliance_officer (the
//     existing access-control helpers). The roles and the retention period are the owner's decision (Still open in the lane notes).
//   · NEVER EXPOSED: nothing here is copied onto `contacts`, `enrichment_profile`, a persona, a segment or a prompt; no ads /
//     targeting / dispatch / eligibility module may import this file or name its table (scripts/lifetime-signals-guard.ts, with a
//     positive control). Matching / append (this) is a different act from ad activation (lib/kernel/ads.ts, which refuses protected
//     segmentation at the act — lib/lead-governance/protected-class-signals.ts).
// Safe write: tenant-anchored (the contact is read by id AND brokerage_id first), every `{ error }` read, every write COUNTED.
// Never throws.

import type { VersiumProtectedResearchField } from "@/lib/external/versium-client"
import type { FieldProvenance } from "@/lib/lead-pipeline/enrichment-column-map"

type Svc = { from: (table: string) => any }

const TABLE = "protected_research_attributes"

export interface ProtectedResearchWrite {
  ok: boolean
  inserted: number
  changed: number
  unchanged: number
  error?: string
}

/**
 * Store one paid row's protected fields for ONE contact of ONE tenant. Idempotent per (contact, provider, field): an unchanged
 * value re-stamps retrieved_at; a changed value also moves value_changed_at; a new field is inserted with its provenance.
 */
export async function persistProtectedResearch(
  svc: Svc,
  target: { contactId: string; brokerageId: string },
  fields: readonly VersiumProtectedResearchField[],
  provenance: Pick<FieldProvenance, "source" | "capability" | "retrievedAt" | "matchConfidence"> | null,
  opts: { now?: Date } = {},
): Promise<ProtectedResearchWrite> {
  const res: ProtectedResearchWrite = { ok: true, inserted: 0, changed: 0, unchanged: 0 }
  if (fields.length === 0) return res
  if (!target.contactId || !target.brokerageId) return { ...res, ok: false, error: "contactId and brokerageId are both required" }
  if (!provenance) return { ...res, ok: false, error: "no provenance — a research row is never stored without its source" }
  try {
    const now = (opts.now ?? new Date()).toISOString()
    // Tenant anchor: the contact must be THIS brokerage's (the service client bypasses RLS; the predicate is the gate).
    const { data: contact, error: cErr } = await svc.from("contacts").select("id").eq("id", target.contactId).eq("brokerage_id", target.brokerageId).maybeSingle()
    if (cErr) return { ...res, ok: false, error: `contact read refused: ${cErr.message}` }
    if (!contact) return { ...res, ok: false, error: "contact not in this tenant" }

    // What is already held for this contact from this provider — the CHANGE is what gets dated.
    const { data: held, error: hErr } = await svc.from(TABLE).select("id, source_field, attribute_value")
      .eq("brokerage_id", target.brokerageId).eq("contact_id", target.contactId).eq("provider", provenance.source)
    if (hErr) return { ...res, ok: false, error: `research read refused: ${hErr.message}` }
    const byField = new Map(((held ?? []) as Array<{ id: string; source_field: string; attribute_value: string }>).map((r) => [r.source_field, r]))

    for (const f of fields) {
      const prior = byField.get(f.sourceField)
      if (!prior) {
        const { data, error } = await svc.from(TABLE).insert({
          brokerage_id: target.brokerageId, contact_id: target.contactId, provider: provenance.source, capability: provenance.capability,
          source_field: f.sourceField, attribute_value: f.value, attribute_class: f.protectedClass, basis: f.basis, purpose: "research",
          match_confidence: provenance.matchConfidence ?? null, retrieved_at: provenance.retrievedAt, first_observed_at: now, value_changed_at: now,
        }).select("id")
        if (error) return { ...res, ok: false, error: `research insert refused (${f.sourceField}): ${error.message}` }
        if ((data ?? []).length !== 1) return { ...res, ok: false, error: `research insert wrote ${(data ?? []).length} rows (${f.sourceField})` }
        res.inserted++
        continue
      }
      const changed = prior.attribute_value !== f.value
      const patch: Record<string, unknown> = { retrieved_at: provenance.retrievedAt, match_confidence: provenance.matchConfidence ?? null, capability: provenance.capability, updated_at: now }
      if (changed) Object.assign(patch, { attribute_value: f.value, attribute_class: f.protectedClass, value_changed_at: now })
      const { data, error } = await svc.from(TABLE).update(patch).eq("id", prior.id).eq("brokerage_id", target.brokerageId).select("id")
      if (error) return { ...res, ok: false, error: `research update refused (${f.sourceField}): ${error.message}` }
      if ((data ?? []).length !== 1) return { ...res, ok: false, error: `research update matched ${(data ?? []).length} rows (${f.sourceField})` }
      if (changed) res.changed++
      else res.unchanged++
    }
    return res
  } catch (e) {
    return { ...res, ok: false, error: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}
