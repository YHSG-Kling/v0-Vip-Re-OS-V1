// lib/forms/legal-description.ts — THE LEGAL DESCRIPTION A CONTRACT FORM NEEDS (wave 141, lane 141C).
//
// Owner verbatim: "some forms need address AND legal description. PROPERTY → legal description →
// canonical transaction/form model → provider field. Never invent it: use an approved property-data
// capability if it legitimately provides it, else ask a human; the form stays incomplete until the
// data exists."
//
// SURVIVORS EXTENDED, nothing rebuilt:
//   · the FIELD MAPPING already existed — lib/intelligence/offer-property-prefill.ts PROPERTY_PATTERNS
//     recognises a "Legal Description" AcroForm field and buildPropertyPrefill fills it from
//     KnownPropertyFacts.legalDescription (or names it in `unresolved`);
//   · the RECORD now carries it — m768 adds legal_description (+ _source) to listings and transactions,
//     the two property records resolveKnownPropertyFacts (offer-property-prefill-runner.ts) walks;
//   · the CAPABILITY is RentCast's property record (lib/property/rentcast.ts
//     getRentcastPropertyDetailWithOutcome → legalDescription — gated, metered and cached there; the
//     owner's primary property-record provider since wave 92). BatchData's adapter maps no legal
//     description (lib/external/batchdata-*.ts) and Versium's property facts are year built / dwelling
//     type / purchase date only (lib/avm/provider-chain.ts fillPropertyFactGaps) — neither legitimately
//     provides it, so neither is asked (and no BatchData where a cheaper lookup exists);
//   · the HUMAN ASK is the existing task rail (`tasks`, the listing-lifecycle writers' shape).
//
// The PURE half (requirement / gate) is what the proof asserts and what the ONE dispatch core
// (lib/esign/dispatch-packet.ts) refuses an incomplete packet on; the I/O half resolves, writes back
// (COUNTED, tenant-pinned) and asks.

import type { KnownPropertyFacts } from "@/lib/intelligence/offer-property-prefill"
import type { PdfFieldValue } from "@/lib/forms/pdf-form-fill"

/** The same recogniser PROPERTY_PATTERNS uses for the legalDescription key (one vocabulary, §6). */
const LEGAL_DESCRIPTION_FIELD_RE = /legal.?descri|legal.?desc\b/i

/** Who may supply a legal description — the m768 CHECK's mirror. Never a model.
 *  @proofSeam the proof holds it equal to the migration's CHECK (§F); the product writes its members. */
export const LEGAL_DESCRIPTION_SOURCES = ["agent", "rentcast"] as const
type LegalDescriptionSource = (typeof LEGAL_DESCRIPTION_SOURCES)[number]

/** The task rail's source key for the human ask (tasks.source) — ONE spelling, read by the dedupe.
 *  @proofSeam the proof pins the spelling (§F); the writer and the dedupe below are its readers. */
export const LEGAL_DESCRIPTION_TASK_SOURCE = "legal_description_request"

interface LegalDescriptionRequirement {
  /** The form carries a legal-description field. */
  required: boolean
  /** The field names that need it (empty when not required). */
  fields: string[]
  /** A known value exists to fill them. */
  satisfied: boolean
}

/** PURE: does this form NEED a legal description, and do we HAVE one? */
export function legalDescriptionRequirement(fieldNames: readonly string[], facts: Pick<KnownPropertyFacts, "legalDescription">): LegalDescriptionRequirement {
  const fields = (fieldNames ?? []).filter((n) => typeof n === "string" && LEGAL_DESCRIPTION_FIELD_RE.test(n))
  const value = typeof facts?.legalDescription === "string" ? facts.legalDescription.trim() : ""
  return { required: fields.length > 0, fields, satisfied: fields.length === 0 || value.length > 0 }
}

/** PURE: the value the agent typed for the legal description, if any, from the wizard's field panel. */
export function typedLegalDescription(fieldValues: Record<string, string> | null | undefined): string | null {
  for (const [name, value] of Object.entries(fieldValues ?? {})) {
    if (LEGAL_DESCRIPTION_FIELD_RE.test(name) && typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

interface LegalDescriptionGateVerdict {
  complete: boolean
  /** The blank legal-description fields, by document. */
  blank: Array<{ document: string; field: string }>
  /** The refusal the send returns — the agent reads it in the wizard. */
  reason: string | null
}

/**
 * PURE — THE INCOMPLETE-FORM GATE: a filled PDF whose legal-description field is still blank must
 * not be sent for signature ("the form stays incomplete until the data exists"). Takes each
 * document's current text fields (lib/forms/pdf-form-fill.ts readPdfTextFields).
 */
export function legalDescriptionGate(documents: Array<{ name: string; fields: readonly PdfFieldValue[] }>): LegalDescriptionGateVerdict {
  const blank: Array<{ document: string; field: string }> = []
  for (const d of documents) {
    for (const f of d.fields) {
      if (LEGAL_DESCRIPTION_FIELD_RE.test(f.name) && !(f.value ?? "").trim()) blank.push({ document: d.name, field: f.name })
    }
  }
  if (blank.length === 0) return { complete: true, blank, reason: null }
  const named = blank.map((b) => `"${b.document}" → ${b.field}`).join("; ")
  return {
    complete: false,
    blank,
    reason: `INCOMPLETE — the legal description is blank on ${named}. It is never invented: enter it in the Fill step (or complete the open task), then send.`,
  }
}

// ─── I/O: resolve → write back (counted) → or ask a human ───────────────────────────────────────

interface ResolveLegalDescriptionArgs {
  brokerageId: string
  /** The agent filling the form (users.id) — the human who is asked when no source has it. */
  userId: string
  listingId?: string | null
  transactionId?: string | null
  contactId?: string | null
  /** The subject property as the wizard knows it — the capability is asked by full postal address. */
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  /** The value the agent TYPED (typedLegalDescription) — persisted as source 'agent'; wins. */
  typedValue?: string | null
}

interface ResolveLegalDescriptionResult {
  value: string | null
  source: LegalDescriptionSource | null
  /** The record the value was written to (counted), when one exists. */
  persisted: "listing" | "transaction" | null
  /** A human was asked (an open task exists for the agent). */
  asked: boolean
  taskId: string | null
  /** Why no source provided it (the sentence the wizard shows). */
  reason: string | null
}

type Svc = { from: (table: string) => any }

/** The record the value lives on (listing first — our own inventory — then the transaction). */
async function readRecordValue(svc: Svc, args: ResolveLegalDescriptionArgs): Promise<{ value: string | null; source: LegalDescriptionSource | null; refused: string | null }> {
  const read = async (table: "listings" | "transactions", id: string) => {
    const { data, error } = await svc.from(table).select("legal_description, legal_description_source").eq("id", id).eq("brokerage_id", args.brokerageId).maybeSingle()
    // A refused read (42703 before m768 is applied; RLS) is said, never read as "unknown".
    if (error) return { value: null, source: null, refused: `${table}: ${error.message}` }
    const v = typeof data?.legal_description === "string" && data.legal_description.trim() ? data.legal_description.trim() : null
    const s = (data?.legal_description_source as LegalDescriptionSource | null) ?? null
    return { value: v, source: v ? s : null, refused: null }
  }
  let refused: string | null = null
  if (args.listingId) { const r = await read("listings", args.listingId); if (r.value) return r; refused = r.refused ?? refused }
  if (args.transactionId) { const r = await read("transactions", args.transactionId); if (r.value) return r; refused = r.refused ?? refused }
  return { value: null, source: null, refused }
}

/** THE WRITER — tenant-pinned, COUNTED (CLAUDE.md §3: a matched-nothing update also resolves). */
async function writeRecordValue(svc: Svc, args: ResolveLegalDescriptionArgs, value: string, source: LegalDescriptionSource): Promise<"listing" | "transaction" | null> {
  const targets: Array<["listings" | "transactions", string]> = []
  if (args.listingId) targets.push(["listings", args.listingId])
  if (args.transactionId) targets.push(["transactions", args.transactionId])
  let persisted: "listing" | "transaction" | null = null
  for (const [table, id] of targets) {
    const { data, error } = await svc.from(table)
      .update({ legal_description: value, legal_description_source: source, updated_at: new Date().toISOString() })
      .eq("id", id).eq("brokerage_id", args.brokerageId)
      .select("id")
    if (error) { console.error(`[legal-description] ${table}.legal_description write refused: ${error.message}`); continue }
    if (!data || data.length === 0) { console.error(`[legal-description] ${table} ${id} matched no row in brokerage ${args.brokerageId} — nothing written`); continue }
    persisted = persisted ?? (table === "listings" ? "listing" : "transaction")
  }
  return persisted
}

/** The agent's own agents.id (tasks.assigned_to_agent_id FKs agents) — tenant-pinned. */
async function agentIdForUser(svc: Svc, brokerageId: string, userId: string): Promise<string | null> {
  const { data, error } = await svc.from("agents").select("id").eq("user_id", userId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[legal-description] agents read refused: ${error.message}`); return null }
  return (data?.id as string | undefined) ?? null
}

/** THE HUMAN ASK on the existing task rail — ONE open task per record (deduped), the agent's. */
async function askHuman(svc: Svc, args: ResolveLegalDescriptionArgs, reason: string): Promise<{ asked: boolean; taskId: string | null; reason: string }> {
  const agentId = await agentIdForUser(svc, args.brokerageId, args.userId)
  if (!agentId) return { asked: false, taskId: null, reason: `${reason} No agent record for the signed-in user to assign the request to.` }
  const subject = [args.address, args.city, args.state].filter(Boolean).join(", ") || "this property"
  const title = `Enter the legal description for ${subject}`
  let q = svc.from("tasks").select("id").eq("brokerage_id", args.brokerageId).eq("source", LEGAL_DESCRIPTION_TASK_SOURCE).is("completed_at", null)
  if (args.listingId) q = q.eq("listing_id", args.listingId)
  else if (args.transactionId) q = q.eq("transaction_id", args.transactionId)
  else q = q.eq("title", title)
  const { data: open, error: openErr } = await q.limit(1).maybeSingle()
  if (openErr) return { asked: false, taskId: null, reason: `${reason} (the task rail refused the read: ${openErr.message})` }
  if (open?.id) return { asked: true, taskId: open.id as string, reason }
  const { data: inserted, error } = await svc.from("tasks").insert({
    brokerage_id: args.brokerageId,
    assigned_to_agent_id: agentId,
    listing_id: args.listingId ?? null,
    transaction_id: args.transactionId ?? null,
    contact_id: args.contactId ?? null,
    title,
    description: `A contract form for ${subject} needs the property's legal description and no record or approved property-data source carries it. Enter it in the form's Fill step (Legal Description) — it is saved on the record and the form can then be sent. Never guess it: read it from the deed, the title commitment or the county record.`,
    priority: "high",
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    source: LEGAL_DESCRIPTION_TASK_SOURCE,
    status: "pending",
    auto_generated: true,
  }).select("id").maybeSingle()
  if (error || !inserted?.id) return { asked: false, taskId: null, reason: `${reason} (the task could not be created: ${error?.message ?? "no row returned"})` }
  return { asked: true, taskId: inserted.id as string, reason }
}

/** Close the open ask(s) for this record once a value exists — counted, tenant-pinned. */
async function completeAsks(svc: Svc, args: ResolveLegalDescriptionArgs): Promise<void> {
  let q = svc.from("tasks").update({ completed_at: new Date().toISOString(), status: "completed", updated_at: new Date().toISOString() })
    .eq("brokerage_id", args.brokerageId).eq("source", LEGAL_DESCRIPTION_TASK_SOURCE).is("completed_at", null)
  if (args.listingId) q = q.eq("listing_id", args.listingId)
  else if (args.transactionId) q = q.eq("transaction_id", args.transactionId)
  else return
  const { error } = await q.select("id")
  if (error) console.error(`[legal-description] could not complete the open ask: ${error.message}`)
}

/**
 * Resolve the legal description for a form, in the owner's order, writing back what a legitimate
 * source supplies and asking the agent when none does. Never invents a value. Never throws.
 *   1. the agent's TYPED value (source agent) → written to the record, open asks completed;
 *   2. the record (listings / transactions legal_description);
 *   3. RentCast's property record (gated + metered inside lib/property/rentcast.ts) → written
 *      (source rentcast), open asks completed;
 *   4. else the form is INCOMPLETE: one open task for the agent (the existing task rail).
 */
export async function resolveLegalDescriptionForForm(svc: Svc, args: ResolveLegalDescriptionArgs): Promise<ResolveLegalDescriptionResult> {
  try {
    const typed = args.typedValue?.trim() || null
    if (typed) {
      const persisted = await writeRecordValue(svc, args, typed, "agent")
      if (persisted) await completeAsks(svc, args)
      return { value: typed, source: "agent", persisted, asked: false, taskId: null, reason: null }
    }

    const onRecord = await readRecordValue(svc, args)
    if (onRecord.value) return { value: onRecord.value, source: onRecord.source ?? "agent", persisted: null, asked: false, taskId: null, reason: null }

    // The approved capability — only when the record carries a full postal address to ask by.
    const addressLine = [args.address, args.city, [args.state, args.zip].filter(Boolean).join(" ")].filter((p) => p && String(p).trim()).join(", ")
    let capabilityReason = "no approved property-data source carries it"
    if (args.address && (args.zip || (args.city && args.state))) {
      try {
        const { getRentcastPropertyDetailWithOutcome } = await import("@/lib/property/rentcast")
        const rc = await getRentcastPropertyDetailWithOutcome({ brokerageId: args.brokerageId, agentUserId: args.userId, address: addressLine, systemSource: "forms_legal_description", contactId: args.contactId ?? null })
        const value = rc.detail?.legalDescription?.trim() || null
        if (value) {
          const persisted = await writeRecordValue(svc, args, value, "rentcast")
          if (persisted) await completeAsks(svc, args)
          return { value, source: "rentcast", persisted, asked: false, taskId: null, reason: null }
        }
        capabilityReason = rc.detail
          ? "RentCast's property record carries no legal description for this address"
          : `RentCast did not answer (${rc.outcome}${rc.eligibility?.reason ? `: ${rc.eligibility.reason}` : ""})`
      } catch (e) {
        capabilityReason = `the property-data lookup failed: ${e instanceof Error ? e.message : String(e)}`
      }
    } else {
      capabilityReason = "the property's full postal address is not known yet, so no property-data source can be asked"
    }

    const reason = `The legal description is not on the record and ${capabilityReason}${onRecord.refused ? ` (record read refused: ${onRecord.refused})` : ""}. The form is INCOMPLETE until a person enters it.`
    const ask = await askHuman(svc, args, reason)
    return { value: null, source: null, persisted: null, asked: ask.asked, taskId: ask.taskId, reason: ask.reason }
  } catch (e) {
    return { value: null, source: null, persisted: null, asked: false, taskId: null, reason: `legal description resolution failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
