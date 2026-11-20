/**
 * lib/contact-promotion/conversion-finality.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE conversion guard. Owner ruling, verbatim:
 *
 *   "if a lead converted to a contact, then only the contact gets updated
 *    because once a lead converts, all communication/updates or schedules are
 *    to cease and only contacts get the actions."
 *
 * WHY IT KEYS ON `leads.contact_id` AND NOTHING ELSE
 *
 * There are three converters and they do NOT agree on what a conversion looks
 * like. Measured, not assumed:
 *
 *   marker            crm.ts:convertLeadToContact   promote-lead-to-contact   handleLeadAssigned
 *   leads.contact_id            ✓                            ✓                       ✓
 *   converted_at                ✓                            ✓                       ✓
 *   is_active=false             ✗ (fixed in this pass)       ✓                       ✓
 *   ai_isa_owner=false          ✗ (fixed in this pass)       ✓                       ✗ (fixed)
 *   lifecycle_state             'assigned'                   —                       —
 *   status='converted'          never written by anything (the only such literal
 *                               in the tree is demo seed data)
 *
 * `contact_id` is the ONLY marker written on EVERY path, it is the FK migration
 * 039's `contact_lead_history` view joins on, and it is what the two existing
 * correct call sites (lib/kernel/communications.ts:418,
 * app/api/voice/twilio/inbound/route.ts) already filter on. So it is the marker,
 * and every other spelling of "converted" is a derived convenience at best.
 *
 * FAIL CLOSED. A gate that cannot run must refuse (CLAUDE.md §4). Every read
 * here destructures `{ data, error }` — supabase-js RESOLVES a refusal — and an
 * unreadable lead comes back `allowed: false` with `converted: null`, never
 * `allowed: true`. "Nobody checked" must never render as "checked and fine".
 *
 * EVERY REFUSAL IS REPORTABLE. `reason` is always populated when `allowed` is
 * false and `contactId` carries the row that now owns the action, so a caller
 * can either SAY why it did nothing or RE-ROUTE the action to the contact.
 * Dropping an action silently is the failure mode this file exists to prevent —
 * the ruling says the CONTACT gets the action, not that the action disappears.
 *
 * TWO SHAPES, because call sites come in two shapes:
 *   (a) BATCH — a job selecting leads to work: `excludeConvertedLeads(query)`
 *       (the `.is("contact_id", null)` idiom) and `partitionConvertedLeads`.
 *   (b) SINGLE — one lead, by row or by id: `conversionVerdictForRow` (pure,
 *       for callers that already read the row) and `assertLeadNotConverted`
 *       (reads it, fails closed).
 */

/** The ONE conversion marker column on `leads`. Never spell it inline. */
export const CONVERSION_MARKER_COLUMN = "contact_id" as const

/** Machine-readable outcomes. `open` is the only one that permits the action. */
export type ConversionVerdictCode =
  | "open"                   // not converted — the lead-keyed action may proceed
  | "lead_converted"         // converted — the CONTACT owns every action now
  | "lead_missing"           // no such lead (or not in this tenant) — fail closed
  | "conversion_unreadable"  // the read was refused/threw — fail closed

export interface ConversionVerdict {
  /** May a LEAD-keyed communication / update / schedule proceed? */
  allowed: boolean
  /** true / false, or null when it could not be determined (never treated as false). */
  converted: boolean | null
  /** The contact that owns every action for this person, when one is known. */
  contactId: string | null
  code: ConversionVerdictCode
  /** ALWAYS populated when `allowed` is false. Callers must be able to say why. */
  reason: string
}

/** The shape of a leads row this guard needs. Anything wider is fine. */
export interface LeadConversionRow {
  id?: string | null
  contact_id?: string | null
}

const OPEN: ConversionVerdict = {
  allowed: true,
  converted: false,
  contactId: null,
  code: "open",
  reason: "",
}

/**
 * PURE. The verdict for a leads row the caller has ALREADY read — no second
 * query. Use this wherever the row is in hand; `assertLeadNotConverted` exists
 * for the paths that only hold an id.
 *
 * A `null`/`undefined` ROW is not "not converted": it is "unknown", and the
 * verdict refuses.
 */
export function conversionVerdictForRow(
  row: LeadConversionRow | null | undefined,
  leadId?: string | null,
): ConversionVerdict {
  const label = leadId ?? row?.id ?? "unknown"
  if (!row) {
    return {
      allowed: false,
      converted: null,
      contactId: null,
      code: "lead_missing",
      reason: `Lead ${label} could not be read — refusing the lead-keyed action rather than assuming it is unconverted.`,
    }
  }
  const contactId = (row.contact_id ?? null) as string | null
  if (contactId) {
    return {
      allowed: false,
      converted: true,
      contactId,
      code: "lead_converted",
      reason:
        `Lead ${label} converted to contact ${contactId} — all communication, updates and schedules ` +
        `cease on the lead; the contact gets the action.`,
    }
  }
  return OPEN
}

/**
 * Reads the lead and returns the verdict. FAILS CLOSED on a refused read, on a
 * throw, and on a missing row.
 *
 * `brokerageId` is optional but SHOULD be passed wherever the caller has a
 * session tenant: it pins the read the same way the calling path is pinned, so
 * a cross-tenant id cannot answer this question either way.
 */
export async function assertLeadNotConverted(
  supabase: any,
  leadId: string | null | undefined,
  opts?: { brokerageId?: string | null },
): Promise<ConversionVerdict> {
  if (!leadId) {
    // No lead in play at all — there is nothing for this guard to refuse. A
    // contact-only path is exactly what the ruling wants.
    return OPEN
  }
  try {
    let q = supabase
      .from("leads")
      .select(`id, ${CONVERSION_MARKER_COLUMN}`)
      .eq("id", leadId)
    if (opts?.brokerageId) q = q.eq("brokerage_id", opts.brokerageId)
    // supabase-js RESOLVES refusals — the error is READ, never dropped.
    const { data, error } = await q.maybeSingle()
    if (error) {
      return {
        allowed: false,
        converted: null,
        contactId: null,
        code: "conversion_unreadable",
        reason: `Conversion check for lead ${leadId} was refused (${error.message}) — failing closed.`,
      }
    }
    return conversionVerdictForRow(data as LeadConversionRow | null, leadId)
  } catch (e: any) {
    return {
      allowed: false,
      converted: null,
      contactId: null,
      code: "conversion_unreadable",
      reason: `Conversion check for lead ${leadId} threw (${e?.message ?? "unknown error"}) — failing closed.`,
    }
  }
}

/**
 * BATCH shape (a). Adds the `.is("contact_id", null)` predicate to a PostgREST
 * query so a sweep never SELECTS a converted lead in the first place.
 *
 * Typed loosely on purpose: the supabase-js filter builder's `is()` returns its
 * own long generic chain, and pinning it here would force every caller to name
 * that type. The call itself is one method — there is nothing for the looser
 * type to hide.
 */
export function excludeConvertedLeads<Q>(query: Q): Q {
  return (query as any).is(CONVERSION_MARKER_COLUMN, null) as Q
}

export interface ConvertedPartition {
  /** Leads that are still open — safe for lead-keyed actions. */
  open: string[]
  /** leadId → contactId for the converted ones. Re-route here; never drop. */
  converted: Map<string, string>
  /** Leads whose state could not be determined. FAIL CLOSED: not in `open`. */
  unreadable: string[]
  /** Populated when the batch read itself was refused. */
  error?: string
}

/**
 * BATCH shape (a), by id list — for sweeps that already hold ids (an SLA table,
 * a detector's output) and cannot re-shape their query.
 *
 * FAIL CLOSED: on a refused read EVERY id lands in `unreadable` and `open` is
 * empty, so a broken read stops the sweep instead of releasing it.
 */
export async function partitionConvertedLeads(
  supabase: any,
  leadIds: readonly string[],
): Promise<ConvertedPartition> {
  const ids = [...new Set(leadIds.filter(Boolean))] as string[]
  if (ids.length === 0) return { open: [], converted: new Map(), unreadable: [] }
  try {
    const { data, error } = await supabase
      .from("leads")
      .select(`id, ${CONVERSION_MARKER_COLUMN}`)
      .in("id", ids)
    if (error) {
      return {
        open: [],
        converted: new Map(),
        unreadable: ids,
        error: `Conversion partition refused (${error.message}) — failing closed on all ${ids.length} lead(s).`,
      }
    }
    const seen = new Map<string, string | null>()
    for (const r of (data ?? []) as LeadConversionRow[]) {
      if (r.id) seen.set(r.id, (r.contact_id ?? null) as string | null)
    }
    const open: string[] = []
    const converted = new Map<string, string>()
    const unreadable: string[] = []
    for (const id of ids) {
      if (!seen.has(id)) { unreadable.push(id); continue }
      const contactId = seen.get(id) ?? null
      if (contactId) converted.set(id, contactId)
      else open.push(id)
    }
    return { open, converted, unreadable }
  } catch (e: any) {
    return {
      open: [],
      converted: new Map(),
      unreadable: ids,
      error: `Conversion partition threw (${e?.message ?? "unknown error"}) — failing closed on all ${ids.length} lead(s).`,
    }
  }
}

/**
 * One line a caller can log, return, or push into a warnings array. Exists so a
 * refusal is never silent: a path that did nothing must be able to say why.
 */
export function describeConversionRefusal(v: ConversionVerdict, action: string): string {
  return `[conversion-finality] ${action} not performed on the lead: ${v.reason}`
}
