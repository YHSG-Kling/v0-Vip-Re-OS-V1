/**
 * lib/privacy/visitor-data-erasure.ts — a right-to-delete erasure reaches the WEBSITE VISITOR data too (wave 156,
 * lane 156F).
 *
 * THE GAP. app/actions/privacy/data-subject-requests.ts fulfillDeleteRequestAction anonymized the subject's contact
 * rows (lib/privacy/contact-pii-redaction.ts) and marked the request fulfilled — while the visitor tables kept:
 *   · behavioral_signals.email_captured — the subject's EMAIL in clear (the consented capture, m706), plus the
 *     ip_address and user_agent of every visit, linked by contact_id;
 *   · site_activity — every page the subject read and every search term, linked by contact_id / behavioral_signal_id;
 *   · external_behavior — the off-site activity rows attached to those signals;
 *   · website_visitors — the identified sessions (page, referrer, campaign) linked by contact_id / lead_id.
 * A request closed as "anonymized" with the person's email and browsing history still on file is not an erasure.
 *
 * THE RULE. Inside the request's tenant only (every statement pins brokerage_id), DELETE the visitor rows that the
 * subject's contacts / leads were linked to, and any signal that captured the subject's email. Analytics rows of a
 * deleted person have no retention basis (transaction records — the retention the contact anonymization preserves —
 * live elsewhere). Every delete is `.select('id')`ed and COUNTED (CLAUDE.md §3); a refused statement fails the whole
 * erasure CLOSED and the caller must not mark the request fulfilled.
 *
 * Not server-only: driven with an injected client by scripts/wave156-f-visitor-truth-guard.ts.
 */

type Client = { from: (table: string) => any }

export interface VisitorErasureInput {
  brokerageId: string
  /** contacts.id of every contact row the erasure anonymized. */
  contactIds: string[]
  /** The verified subject email (any case) — a consented capture may predate the contact link. */
  email: string
}

export type VisitorErasureResult =
  | { ok: true; deleted: { behavioral_signals: number; site_activity: number; external_behavior: number; website_visitors: number } }
  | { ok: false; error: string }

export async function eraseVisitorDataForSubject(client: Client, input: VisitorErasureInput): Promise<VisitorErasureResult> {
  const b = input.brokerageId
  const contactIds = [...new Set(input.contactIds.filter(Boolean))]
  const email = input.email.trim().toLowerCase()
  const fail = (what: string, e: { message?: string }) => ({ ok: false as const, error: `${what}: ${e.message ?? "refused"}` })

  // 1. The subject's leads (a session may be linked to the lead, not the contact).
  let leadIds: string[] = []
  if (contactIds.length > 0) {
    const { data, error } = await client.from("leads").select("id").eq("brokerage_id", b).in("contact_id", contactIds)
    if (error) return fail("leads read refused", error)
    leadIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  }

  // 2. The signals: linked to a subject contact, or carrying the subject's captured email.
  const signalIds = new Set<string>()
  if (contactIds.length > 0) {
    const { data, error } = await client.from("behavioral_signals").select("id").eq("brokerage_id", b).in("contact_id", contactIds)
    if (error) return fail("behavioral_signals read refused", error)
    for (const r of (data ?? []) as Array<{ id: string }>) signalIds.add(r.id)
  }
  if (email) {
    const { data, error } = await client.from("behavioral_signals").select("id").eq("brokerage_id", b).eq("email_captured", email)
    if (error) return fail("behavioral_signals read refused", error)
    for (const r of (data ?? []) as Array<{ id: string }>) signalIds.add(r.id)
  }
  const sigs = [...signalIds]

  const deleted = { behavioral_signals: 0, site_activity: 0, external_behavior: 0, website_visitors: 0 }
  async function del(table: keyof typeof deleted, column: string, values: string[]): Promise<string | null> {
    if (values.length === 0) return null
    const { data, error } = await client.from(table).delete().eq("brokerage_id", b).in(column, values).select("id")
    if (error) return `${table} delete refused: ${error.message ?? "refused"}`
    deleted[table] += ((data ?? []) as unknown[]).length
    return null
  }

  // 3. Children first, then the signals, then the sessions. Any refusal stops the erasure (fail closed).
  for (const [table, column, values] of [
    ["site_activity", "behavioral_signal_id", sigs],
    ["site_activity", "contact_id", contactIds],
    ["external_behavior", "behavioral_signal_id", sigs],
    ["external_behavior", "contact_id", contactIds],
    ["behavioral_signals", "id", sigs],
    ["website_visitors", "contact_id", contactIds],
    ["website_visitors", "lead_id", leadIds],
  ] as Array<[keyof typeof deleted, string, string[]]>) {
    const refused = await del(table, column, values)
    if (refused) return { ok: false, error: refused }
  }
  return { ok: true, deleted }
}
