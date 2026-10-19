// lib/forms/legal-description.ts — THE LEGAL DESCRIPTION A CONTRACT FORM NEEDS (wave 141, lane 141C;
// sources widened wave 142, lane 142C).
//
// Owner verbatim (141): "some forms need address AND legal description. PROPERTY → legal description →
// canonical transaction/form model → provider field. Never invent it: use an approved property-data
// capability if it legitimately provides it, else ask a human; the form stays incomplete until the
// data exists."
// Owner verbatim (142): "legal description can also be found with osint … should be part of address
// fill from the active listing in rentcast or idx" — ruling: "part of the ADDRESS FILL from the active
// listing (RentCast / IDX / MLS), county/public record, approved property research (OSINT), or
// human-verified entry — with provenance. Never invented, never the street address."
//
// SURVIVORS EXTENDED, nothing rebuilt:
//   · the FIELD MAPPING already existed — lib/intelligence/offer-property-prefill.ts PROPERTY_PATTERNS
//     recognises a "Legal Description" AcroForm field and buildPropertyPrefill fills it from
//     KnownPropertyFacts.legalDescription (or names it in `unresolved`);
//   · the RECORD carries it — m768 put legal_description (+ _source) on listings and transactions, the
//     two property records resolveKnownPropertyFacts (offer-property-prefill-runner.ts) walks; m786
//     (the lane stamp) widens the source CHECK and adds legal_description_provenance;
//   · the SOURCES, in the owner's order, each with provenance:
//       agent         — the human's typed entry (the human-verified entry; who + when)
//       listing       — the canonical LISTING record (our own MLS/IDX-synced inventory) copied onto the
//                       transaction when the linked listing already carries it
//       rentcast      — RentCast's property record (lib/property/rentcast.ts
//                       getRentcastPropertyDetailWithOutcome → legalDescription — gated, metered and
//                       cached there; the owner's primary property-record provider since wave 92)
//       public_record — the approved public-record research module (lib/property/address-lookup.ts:
//                       county assessor / recorder pages through the AI gateway, booked to ai_tool_usage).
//                       Accepted ONLY with a cited source, a legal-description SHAPE (lot / block / plat
//                       / section-township-range / metes-and-bounds — never a street address) and not
//                       low confidence; flagged VERIFICATION REQUIRED and the agent is asked to verify
//                       it against the deed / title commitment. This is the owner's "osint" source.
//     BatchData's adapter maps no legal description and Versium's property facts are year built /
//     dwelling type / purchase date only (lib/avm/provider-chain.ts fillPropertyFactGaps) — neither
//     legitimately provides it, so neither is asked (and no BatchData where a cheaper lookup exists);
//   · the HUMAN ASK is the existing task rail (`tasks`, the listing-lifecycle writers' shape).
//
// The PURE half (requirement / gate / shape) is what the proofs assert and what the ONE dispatch core
// (lib/esign/dispatch-packet.ts) refuses an incomplete packet on; the I/O half resolves, writes back
// (COUNTED, tenant-pinned, with provenance) and asks.

import { looksLikeLegalDescription, type KnownPropertyFacts } from "@/lib/intelligence/offer-property-prefill"
import type { PdfFieldValue } from "@/lib/forms/pdf-form-fill"

/** The same recogniser PROPERTY_PATTERNS uses for the legalDescription key (one vocabulary, §6). */
const LEGAL_DESCRIPTION_FIELD_RE = /legal.?descri|legal.?desc\b/i

/** Who may supply a legal description — the latest defining migration's CHECK (m786), mirrored. Never a model.
 *  @proofSeam the proofs hold it equal to the latest migration's CHECK; the product writes its members. */
export const LEGAL_DESCRIPTION_SOURCES = ["agent", "listing", "rentcast", "public_record"] as const
type LegalDescriptionSource = (typeof LEGAL_DESCRIPTION_SOURCES)[number]

/** The task rail's source key for the human ask (tasks.source) — ONE spelling, read by the dedupe.
 *  @proofSeam the proof pins the spelling (§F); the writer and the dedupe below are its readers. */
export const LEGAL_DESCRIPTION_TASK_SOURCE = "legal_description_request"

/** What rides beside every value (m786 legal_description_provenance). */
interface LegalDescriptionProvenance {
  source: LegalDescriptionSource
  at: string
  /** users.id of the human who entered / will verify it; null for a provider-supplied value nobody has verified. */
  by: string | null
  evidence: Record<string, unknown>
  confidence: "verified" | "provider" | "research"
  verification_required: boolean
}

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

// THE SHAPE RULE (never the street address) lives beside the field mapping it protects:
// lib/intelligence/offer-property-prefill.ts looksLikeLegalDescription — imported above, applied to every
// non-human source below.

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

// ─── I/O: resolve → write back (counted, with provenance) → or ask a human ──────────────────────

interface ResolveLegalDescriptionArgs {
  brokerageId: string
  /** The agent filling the form (users.id) — the human who is asked when no source has it. */
  userId: string
  listingId?: string | null
  transactionId?: string | null
  contactId?: string | null
  /** The subject property as the wizard knows it — the capabilities are asked by full postal address. */
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
  /** Where the value came from, for the record and the form (null when nothing resolved). */
  provenance: LegalDescriptionProvenance | null
  /** The record the value was written to (counted), when one exists. */
  persisted: "listing" | "transaction" | null
  /** The value came from research and must be verified by a human against the deed / title commitment. */
  verificationRequired: boolean
  /** A human was asked (an open task exists for the agent) — to ENTER it, or to VERIFY a researched value. */
  asked: boolean
  taskId: string | null
  /** Why no source provided it (the sentence the wizard shows); null when a value exists. */
  reason: string | null
}

type Svc = { from: (table: string) => any }
type RecordTable = "listings" | "transactions"

interface RecordRead {
  value: string | null
  source: LegalDescriptionSource | null
  provenance: LegalDescriptionProvenance | null
  refused: string | null
}

/** One record's legal description (+ provenance; the provenance column may not exist before m786 — the read falls back). */
async function readOneRecord(svc: Svc, table: RecordTable, id: string, brokerageId: string): Promise<RecordRead> {
  const run = async (columns: string) => svc.from(table).select(columns).eq("id", id).eq("brokerage_id", brokerageId).maybeSingle()
  let { data, error } = await run("legal_description, legal_description_source, legal_description_provenance")
  if (error && /legal_description_provenance/.test(error.message ?? "")) {
    ;({ data, error } = await run("legal_description, legal_description_source"))
  }
  // A refused read (RLS; 42703 before m768) is said, never read as "unknown".
  if (error) return { value: null, source: null, provenance: null, refused: `${table}: ${error.message}` }
  const v = typeof data?.legal_description === "string" && data.legal_description.trim() ? data.legal_description.trim() : null
  const s = (data?.legal_description_source as LegalDescriptionSource | null) ?? null
  const p = data?.legal_description_provenance && typeof data.legal_description_provenance === "object" ? (data.legal_description_provenance as LegalDescriptionProvenance) : null
  return { value: v, source: v ? s : null, provenance: v ? p : null, refused: null }
}

/** THE WRITER — tenant-pinned, COUNTED (CLAUDE.md §3: a matched-nothing update also resolves), provenance beside the value. */
async function writeRecordValue(
  svc: Svc,
  args: ResolveLegalDescriptionArgs,
  value: string,
  provenance: LegalDescriptionProvenance,
  only?: RecordTable,
): Promise<"listing" | "transaction" | null> {
  const targets: Array<[RecordTable, string]> = []
  if (args.listingId && (!only || only === "listings")) targets.push(["listings", args.listingId])
  if (args.transactionId && (!only || only === "transactions")) targets.push(["transactions", args.transactionId])
  let persisted: "listing" | "transaction" | null = null
  for (const [table, id] of targets) {
    const base = { legal_description: value, legal_description_source: provenance.source, updated_at: new Date().toISOString() }
    const attempt = async (payload: Record<string, unknown>) => svc.from(table).update(payload).eq("id", id).eq("brokerage_id", args.brokerageId).select("id")
    let { data, error } = await attempt({ ...base, legal_description_provenance: provenance })
    // Before m786 is applied the provenance column is absent (PGRST204 refuses the WHOLE update): retry
    // without it so the value still lands; the vocabulary refusal (23514 for 'listing' / 'public_record'
    // before the CHECK is widened) is logged and the value still flows to the form.
    if (error && /legal_description_provenance/.test(error.message ?? "")) {
      console.warn(`[legal-description] ${table}.legal_description_provenance not persisted — m786 not applied yet`)
      ;({ data, error } = await attempt(base))
    }
    if (error) { console.error(`[legal-description] ${table}.legal_description write refused (source ${provenance.source}): ${error.message}`); continue }
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

/**
 * THE HUMAN ASK on the existing task rail — ONE open task per record (deduped), the agent's.
 *   enter  — no source has the value: the agent reads it off the deed / title commitment / county record
 *   verify — research supplied a value with a citation: the agent confirms it against the same documents
 */
async function askHuman(svc: Svc, args: ResolveLegalDescriptionArgs, reason: string, kind: "enter" | "verify", researched?: { value: string; sources: string[] }): Promise<{ asked: boolean; taskId: string | null; reason: string }> {
  const agentId = await agentIdForUser(svc, args.brokerageId, args.userId)
  if (!agentId) return { asked: false, taskId: null, reason: `${reason} No agent record for the signed-in user to assign the request to.` }
  const subject = [args.address, args.city, args.state].filter(Boolean).join(", ") || "this property"
  const title = kind === "verify" ? `Verify the legal description for ${subject}` : `Enter the legal description for ${subject}`
  let q = svc.from("tasks").select("id").eq("brokerage_id", args.brokerageId).eq("source", LEGAL_DESCRIPTION_TASK_SOURCE).is("completed_at", null)
  if (args.listingId) q = q.eq("listing_id", args.listingId)
  else if (args.transactionId) q = q.eq("transaction_id", args.transactionId)
  else q = q.eq("title", title)
  const { data: open, error: openErr } = await q.limit(1).maybeSingle()
  if (openErr) return { asked: false, taskId: null, reason: `${reason} (the task rail refused the read: ${openErr.message})` }
  if (open?.id) return { asked: true, taskId: open.id as string, reason }
  const description = kind === "verify"
    ? `Public-record research found a legal description for ${subject}: "${researched?.value ?? ""}" (cited: ${(researched?.sources ?? []).join(", ") || "county/public pages"}). It was filled into the form flagged VERIFICATION REQUIRED. Confirm it word-for-word against the deed, the title commitment or the county record before the form is sent; correct it in the Fill step if it differs.`
    : `A contract form for ${subject} needs the property's legal description and no record or approved property-data source carries it. Enter it in the form's Fill step (Legal Description) — it is saved on the record and the form can then be sent. Never guess it: read it from the deed, the title commitment or the county record.`
  const { data: inserted, error } = await svc.from("tasks").insert({
    brokerage_id: args.brokerageId,
    assigned_to_agent_id: agentId,
    listing_id: args.listingId ?? null,
    transaction_id: args.transactionId ?? null,
    contact_id: args.contactId ?? null,
    title,
    description,
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

function provenanceFor(source: LegalDescriptionSource, by: string | null, evidence: Record<string, unknown>): LegalDescriptionProvenance {
  const confidence: LegalDescriptionProvenance["confidence"] = source === "agent" ? "verified" : source === "public_record" ? "research" : "provider"
  return { source, at: new Date().toISOString(), by, evidence, confidence, verification_required: source === "public_record" }
}

/**
 * Resolve the legal description for a form, in the owner's order, writing back what a legitimate
 * source supplies (with provenance) and asking the agent when none does. Never invents a value. Never
 * the street address. Never throws.
 *   1. the agent's TYPED value (source agent — the human-verified entry) → written to the record(s),
 *      open asks completed;
 *   2. the record: the linked LISTING (our canonical inventory record) → copied onto the TRANSACTION
 *      as source 'listing' when the transaction lacks it; else the transaction's own value;
 *   3. RentCast's property record (gated + metered inside lib/property/rentcast.ts) → written
 *      (source rentcast), open asks completed;
 *   4. the approved public-record research (lib/property/address-lookup.ts) → accepted only with a
 *      citation, a legal-description SHAPE and not-low confidence → written (source public_record),
 *      flagged VERIFICATION REQUIRED, the agent asked to verify;
 *   5. else the form is INCOMPLETE: one open task for the agent (the existing task rail).
 */
export async function resolveLegalDescriptionForForm(svc: Svc, args: ResolveLegalDescriptionArgs): Promise<ResolveLegalDescriptionResult> {
  const none = (reason: string, ask: { asked: boolean; taskId: string | null }): ResolveLegalDescriptionResult =>
    ({ value: null, source: null, provenance: null, persisted: null, verificationRequired: false, asked: ask.asked, taskId: ask.taskId, reason })
  try {
    const typed = args.typedValue?.trim() || null
    if (typed) {
      const provenance = provenanceFor("agent", args.userId, { entered_in: "form_fill" })
      const persisted = await writeRecordValue(svc, args, typed, provenance)
      if (persisted) await completeAsks(svc, args)
      return { value: typed, source: "agent", provenance, persisted, verificationRequired: false, asked: false, taskId: null, reason: null }
    }

    // 2. The records — listing first (our own inventory), then the transaction.
    let refused: string | null = null
    const listing = args.listingId ? await readOneRecord(svc, "listings", args.listingId, args.brokerageId) : null
    const transaction = args.transactionId ? await readOneRecord(svc, "transactions", args.transactionId, args.brokerageId) : null
    refused = listing?.refused ?? transaction?.refused ?? null
    if (listing?.value) {
      let persisted: "listing" | "transaction" | null = null
      if (args.transactionId && transaction && !transaction.value) {
        // THE ADDRESS FILL FROM THE ACTIVE LISTING: the transaction inherits the listing's value, source 'listing'.
        persisted = await writeRecordValue(svc, args, listing.value, provenanceFor("listing", null, { listing_id: args.listingId, listing_source: listing.source }), "transactions")
        if (persisted) await completeAsks(svc, args)
      }
      const provenance = listing.provenance ?? provenanceFor(listing.source ?? "listing", null, { listing_id: args.listingId })
      return { value: listing.value, source: listing.source ?? "listing", provenance, persisted, verificationRequired: provenance.verification_required, asked: false, taskId: null, reason: null }
    }
    if (transaction?.value) {
      const provenance = transaction.provenance ?? provenanceFor(transaction.source ?? "agent", null, { transaction_id: args.transactionId })
      return { value: transaction.value, source: transaction.source ?? "agent", provenance, persisted: null, verificationRequired: provenance.verification_required, asked: false, taskId: null, reason: null }
    }

    // 3 + 4. The approved capabilities — only when the record carries a full postal address to ask by.
    const addressLine = [args.address, args.city, [args.state, args.zip].filter(Boolean).join(" ")].filter((p) => p && String(p).trim()).join(", ")
    const reasons: string[] = []
    if (args.address && (args.zip || (args.city && args.state))) {
      try {
        const { getRentcastPropertyDetailWithOutcome } = await import("@/lib/property/rentcast")
        const rc = await getRentcastPropertyDetailWithOutcome({ brokerageId: args.brokerageId, agentUserId: args.userId, address: addressLine, systemSource: "forms_legal_description", contactId: args.contactId ?? null })
        const value = rc.detail?.legalDescription?.trim() || null
        if (value) {
          const provenance = provenanceFor("rentcast", null, { provider: "rentcast", outcome: rc.outcome })
          const persisted = await writeRecordValue(svc, args, value, provenance)
          if (persisted) await completeAsks(svc, args)
          return { value, source: "rentcast", provenance, persisted, verificationRequired: false, asked: false, taskId: null, reason: null }
        }
        reasons.push(rc.detail
          ? "RentCast's property record carries no legal description for this address"
          : `RentCast did not answer (${rc.outcome}${rc.eligibility?.reason ? `: ${rc.eligibility.reason}` : ""})`)
      } catch (e) {
        reasons.push(`the RentCast lookup failed: ${e instanceof Error ? e.message : String(e)}`)
      }

      // 4. Public-record research (the owner's "osint") — cited, shaped, not low-confidence, verified by a human.
      try {
        const { lookupPropertyByAddress } = await import("@/lib/property/address-lookup")
        const research = await lookupPropertyByAddress({ address: String(args.address), city: String(args.city ?? ""), state: String(args.state ?? ""), zip: args.zip ?? undefined, brokerageId: args.brokerageId, userId: args.userId })
        const candidate = research.legalDescription?.trim() || null
        const shape = looksLikeLegalDescription(candidate)
        const cited = (research.legalDescriptionSource ?? "").trim()
        if (candidate && shape.ok && cited && research.dataConfidence !== "low") {
          const sources = Array.from(new Set([cited, ...(research.sources ?? [])].filter(Boolean)))
          const provenance = provenanceFor("public_record", null, { module: "lib/property/address-lookup.ts", source_urls: sources, data_confidence: research.dataConfidence })
          const persisted = await writeRecordValue(svc, args, candidate, provenance)
          if (persisted) await completeAsks(svc, args)
          const verify = await askHuman(svc, args, "verification required", "verify", { value: candidate, sources })
          return { value: candidate, source: "public_record", provenance, persisted, verificationRequired: true, asked: verify.asked, taskId: verify.taskId, reason: null }
        }
        reasons.push(!candidate
          ? "the public-record research found no legal description"
          : !shape.ok
            ? `the public-record research returned a value that is not a legal description (${shape.reason}) — refused, never the street address`
            : !cited
              ? "the public-record research cited no source for the legal description — refused"
              : "the public-record research was low-confidence — refused")
      } catch (e) {
        reasons.push(`the public-record research failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      reasons.push("the property's full postal address is not known yet, so no property-data source can be asked")
    }

    const reason = `The legal description is not on the record and ${reasons.join("; ")}${refused ? ` (record read refused: ${refused})` : ""}. The form is INCOMPLETE until a person enters it.`
    const ask = await askHuman(svc, args, reason, "enter")
    return none(ask.reason, ask)
  } catch (e) {
    return none(`legal description resolution failed: ${e instanceof Error ? e.message : String(e)}`, { asked: false, taskId: null })
  }
}
