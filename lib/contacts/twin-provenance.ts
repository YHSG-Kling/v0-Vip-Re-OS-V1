// lib/contacts/twin-provenance.ts
//
// CLIENT TWIN PROVENANCE (data_steward) — the formalization pass on the
// client model the OS already keeps (personas, addressing, stages, scanned
// legal names): every field the agent is about to ACT on gets labeled with
// HOW we know it. Verified-by-document ≠ stated-by-them ≠ inferred-by-the-OS,
// and the pre-call brief now says which is which — so an agent never opens a
// call asserting a guess as a fact. Pure classification, no new tables: the
// provenance lives in signals the rows already carry (legal_name_source,
// preferred_name presence, persona/stage being derived fields).

export type TwinProvenance = "document_verified" | "stated" | "inferred"

export interface TwinField {
  field: string
  value: string
  provenance: TwinProvenance
}

export interface TwinContactRow {
  legal_first_name?: string | null
  legal_last_name?: string | null
  legal_name_source?: string | null
  preferred_name?: string | null
  contact_persona?: string | null
  buyer_stage?: string | null
}

/** PURE: label each known twin field with how we know it. Absent = absent (never invented). */
export function classifyTwinFields(c: TwinContactRow): TwinField[] {
  const out: TwinField[] = []
  const legal = [c.legal_first_name, c.legal_last_name].filter(Boolean).join(" ").trim()
  if (legal) {
    out.push({
      field: "legal name",
      value: legal,
      provenance: c.legal_name_source === "document_scan" ? "document_verified" : "stated",
    })
  }
  if (c.preferred_name?.trim()) {
    out.push({ field: "goes by", value: c.preferred_name.trim(), provenance: "stated" })
  }
  if (c.contact_persona?.trim()) {
    out.push({ field: "persona", value: c.contact_persona.replace(/_/g, " "), provenance: "inferred" })
  }
  if (c.buyer_stage?.trim()) {
    out.push({ field: "stage", value: c.buyer_stage.replace(/_/g, " "), provenance: "inferred" })
  }
  return out
}

/** PURE: the one pre-call line — verified facts stated as facts, inferences flagged to confirm live. */
export function composeProvenanceNote(fields: TwinField[]): string | null {
  const verified = fields.filter((f) => f.provenance !== "inferred")
  const inferred = fields.filter((f) => f.provenance === "inferred")
  if (verified.length === 0 && inferred.length === 0) return null
  const parts: string[] = []
  if (verified.length > 0) {
    parts.push(`Known: ${verified.map((f) => `${f.field} "${f.value}"${f.provenance === "document_verified" ? " (from their signed documents)" : ""}`).join("; ")}.`)
  }
  if (inferred.length > 0) {
    parts.push(`The OS INFERS (confirm live, don't assert): ${inferred.map((f) => `${f.field} "${f.value}"`).join("; ")}.`)
  }
  return parts.join(" ")
}
