/**
 * lib/privacy/visitor-data-erasure.ts — a data-subject request reaches the WEBSITE VISITOR data too (wave 156, lane 156F).
 *
 * THE GAP. app/actions/privacy/data-subject-requests.ts anonymized the subject's contact rows
 * (lib/privacy/contact-pii-redaction.ts) and exported the contact-side tables — while the visitor tables held, and kept:
 *   · behavioral_signals.email_captured — the subject's EMAIL in clear (the consented capture, m706), plus the
 *     ip_address and user_agent of every visit, linked by contact_id;
 *   · site_activity — every page the subject read and every search term, linked by contact_id / behavioral_signal_id;
 *   · external_behavior — the off-site activity rows attached to those signals;
 *   · website_visitors — the identified sessions (page, referrer, campaign) linked by contact_id / lead_id;
 *   · person_identity_evidence — the identification evidence the visitor-identify loop wrote
 *     (lib/lead-intelligence/visitor-email-capture.ts: a `behavioral_signal` row and a `contact` row, source
 *     'visitor_identify'), and a person_identities row that existed ONLY because of that evidence.
 * A request closed as "anonymized" with the person's email and browsing history still on file is not an erasure, and a
 * right-to-know bundle that omits them is not complete.
 *
 * ONE SELECTOR, TWO USES. subjectVisitorData finds the subject's rows (inside the request's tenant only — every
 * statement pins brokerage_id); collectVisitorDataForSubject hands them to the export, eraseVisitorDataForSubject deletes
 * exactly them. Every read destructures its error and every delete is `.select('id')`ed and COUNTED (CLAUDE.md §3); a
 * refused statement fails the whole call CLOSED.
 *
 * Not server-only: driven with an injected client by scripts/wave156-f-visitor-truth-guard.ts.
 */

type Client = { from: (table: string) => any }
type Row = Record<string, unknown> & { id: string }

export interface VisitorSubjectInput {
  brokerageId: string
  /** contacts.id of the subject's contact rows in this tenant. */
  contactIds: string[]
  /** The verified subject email (any case) — a consented capture may predate the contact link. */
  email: string
}

const TABLES = ["website_visitors", "behavioral_signals", "site_activity", "external_behavior", "person_identity_evidence", "person_identities"] as const
type VisitorTable = (typeof TABLES)[number]
type Rows = Record<VisitorTable, Row[]>

/** The subject's visitor rows, read once. person_identities = persons whose ONLY evidence is the visitor identification. */
async function subjectVisitorData(client: Client, input: VisitorSubjectInput): Promise<{ ok: true; rows: Rows } | { ok: false; error: string }> {
  const b = input.brokerageId
  const contactIds = [...new Set(input.contactIds.filter(Boolean))]
  const email = input.email.trim().toLowerCase()
  const rows: Rows = { website_visitors: [], behavioral_signals: [], site_activity: [], external_behavior: [], person_identity_evidence: [], person_identities: [] }
  const seen = new Map<VisitorTable, Set<string>>(TABLES.map((t) => [t, new Set<string>()]))
  let refused: string | null = null
  async function read(table: VisitorTable, build: (q: any) => any): Promise<Row[]> {
    if (refused) return []
    const { data, error } = await build(client.from(table).select("*").eq("brokerage_id", b))
    if (error) { refused = `${table} read refused: ${error.message ?? "refused"}`; return [] }
    const out = (data ?? []) as Row[]
    for (const r of out) if (!seen.get(table)!.has(r.id)) { seen.get(table)!.add(r.id); rows[table].push(r) }
    return out
  }

  let leadIds: string[] = []
  if (contactIds.length > 0) {
    const { data, error } = await client.from("leads").select("id").eq("brokerage_id", b).in("contact_id", contactIds)
    if (error) return { ok: false, error: `leads read refused: ${error.message ?? "refused"}` }
    leadIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  }
  if (contactIds.length > 0) await read("behavioral_signals", (q) => q.in("contact_id", contactIds))
  if (email) await read("behavioral_signals", (q) => q.eq("email_captured", email))
  const sigs = rows.behavioral_signals.map((r) => r.id)
  if (sigs.length > 0) {
    await read("site_activity", (q) => q.in("behavioral_signal_id", sigs))
    await read("external_behavior", (q) => q.in("behavioral_signal_id", sigs))
    await read("person_identity_evidence", (q) => q.eq("entity_type", "behavioral_signal").in("entity_id", sigs))
  }
  if (contactIds.length > 0) {
    await read("site_activity", (q) => q.in("contact_id", contactIds))
    await read("external_behavior", (q) => q.in("contact_id", contactIds))
    await read("website_visitors", (q) => q.in("contact_id", contactIds))
    await read("person_identity_evidence", (q) => q.eq("entity_type", "contact").eq("source", "visitor_identify").in("entity_id", contactIds))
  }
  if (leadIds.length > 0) await read("website_visitors", (q) => q.in("lead_id", leadIds))
  if (refused) return { ok: false, error: refused }

  // A person row that exists only because of this evidence goes with it; a person other evidence still names stays.
  const personIds = [...new Set(rows.person_identity_evidence.map((r) => String(r.person_id ?? "")).filter(Boolean))]
  if (personIds.length > 0) {
    const evIds = new Set(rows.person_identity_evidence.map((r) => r.id))
    const { data, error } = await client.from("person_identity_evidence").select("id, person_id").eq("brokerage_id", b).in("person_id", personIds)
    if (error) return { ok: false, error: `person_identity_evidence read refused: ${error.message ?? "refused"}` }
    const stillNamed = new Set(((data ?? []) as Array<{ id: string; person_id: string }>).filter((r) => !evIds.has(r.id)).map((r) => r.person_id))
    const onlyVisitor = personIds.filter((p) => !stillNamed.has(p))
    if (onlyVisitor.length > 0) await read("person_identities", (q) => q.in("id", onlyVisitor))
    if (refused) return { ok: false, error: refused }
  }
  return { ok: true, rows }
}

export type VisitorDataExport = { ok: true; data: Rows } | { ok: false; error: string }

/** RIGHT TO KNOW — every visitor row held about the subject in this tenant (the rows the erasure would delete). */
export async function collectVisitorDataForSubject(client: Client, input: VisitorSubjectInput): Promise<VisitorDataExport> {
  const r = await subjectVisitorData(client, input)
  return r.ok ? { ok: true, data: r.rows } : r
}

export type VisitorErasureResult =
  | { ok: true; deleted: Record<VisitorTable, number> }
  | { ok: false; error: string }

/** RIGHT TO DELETE — deletes exactly the subject's visitor rows; children first; any refusal stops it (fail closed). */
export async function eraseVisitorDataForSubject(client: Client, input: VisitorSubjectInput): Promise<VisitorErasureResult> {
  const found = await subjectVisitorData(client, input)
  if (!found.ok) return found
  const deleted = Object.fromEntries(TABLES.map((t) => [t, 0])) as Record<VisitorTable, number>
  for (const table of ["site_activity", "external_behavior", "person_identity_evidence", "behavioral_signals", "website_visitors", "person_identities"] as VisitorTable[]) {
    const ids = found.rows[table].map((r) => r.id)
    if (ids.length === 0) continue
    const { data, error } = await client.from(table).delete().eq("brokerage_id", input.brokerageId).in("id", ids).select("id")
    if (error) return { ok: false, error: `${table} delete refused: ${error.message ?? "refused"}` }
    deleted[table] = ((data ?? []) as unknown[]).length
  }
  return { ok: true, deleted }
}
