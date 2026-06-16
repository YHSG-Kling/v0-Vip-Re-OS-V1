// lib/intelligence/offer-doc-completeness.ts
//
// OFFER DOC COMPLETENESS (pure) — the final gate of the offer e-sign flow. When the signatures land,
// a human assistant would scan the packet: are ALL the forms we need present, and are ALL the
// signatures/initials actually complete? Only then is it safe to tell the agent "ready to send to the
// listing agent." This does that scan — required-vs-present and signed-vs-unsigned — and refuses to
// declare ready on incomplete data (if we don't even know what's required, it is NOT ready, honestly).
// Pure (no I/O), unit-tested directly; the runner pulls the offer's forms + signed documents.

export interface RequiredForm {
  /** stable key to match a present document by (form id, document_type, or normalized name). */
  key: string
  label?: string
}

export interface PresentDoc {
  key: string
  /** the document's status — 'signed' means signatures/initials are complete on it. */
  status: string
}

export interface DocCompletenessResult {
  /** do we actually know what forms this offer requires? (no → cannot declare ready). */
  knownRequirements: boolean
  /** all required forms present AND every one signed. */
  complete: boolean
  readyForListingAgent: boolean
  /** required forms with no matching document present. */
  missingForms: string[]
  /** required forms present but not yet fully signed. */
  unsignedForms: string[]
  reasons: string[]
}

function norm(s: string): string { return (s ?? "").trim().toLowerCase() }

/** Scan an offer packet for completeness: all required forms present + all signed. Pure. */
export function scanOfferDocCompleteness(required: RequiredForm[], present: PresentDoc[]): DocCompletenessResult {
  const reasons: string[] = []
  const knownRequirements = (required ?? []).length > 0
  if (!knownRequirements) {
    return {
      knownRequirements: false, complete: false, readyForListingAgent: false,
      missingForms: [], unsignedForms: [],
      reasons: ["the required-forms list for this offer is unknown — cannot certify the packet is complete"],
    }
  }

  const byKey = new Map<string, PresentDoc>()
  for (const d of present ?? []) byKey.set(norm(d.key), d)

  const missingForms: string[] = []
  const unsignedForms: string[] = []
  for (const r of required) {
    const doc = byKey.get(norm(r.key))
    if (!doc) { missingForms.push(r.label ?? r.key); continue }
    if (norm(doc.status) !== "signed") unsignedForms.push(r.label ?? r.key)
  }

  if (missingForms.length) reasons.push(`missing ${missingForms.length} required form(s): ${missingForms.join(", ")}`)
  if (unsignedForms.length) reasons.push(`${unsignedForms.length} form(s) not fully signed: ${unsignedForms.join(", ")}`)

  const complete = missingForms.length === 0 && unsignedForms.length === 0
  if (complete) reasons.push("all required forms present and fully signed")

  return {
    knownRequirements: true,
    complete,
    readyForListingAgent: complete,
    missingForms,
    unsignedForms,
    reasons,
  }
}
