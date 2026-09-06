/**
 * lib/notifications/transaction-parties-packet.ts
 *
 * PURE composition + AUDIENCE REDACTION for the "transaction created — here are
 * the terms, dates, contingencies and who is on this deal" notice.
 *
 * Why this module exists separately from notify-helpers.ts (which owns the I/O
 * fan-out): every rule that decides WHAT A GIVEN AUDIENCE MAY SEE is a pure
 * function of (roster, terms, viewer) and must be provable without a database.
 * notify-helpers.ts is `import "server-only"` — a proof cannot import it. These
 * functions have no I/O, no server-only import, and are the single source of the
 * redaction rules, so the guard can assert the BOUNDARY itself rather than the
 * spelling of one call site.
 *
 * THE BOUNDARY (owner ruling, wave 10 — "parties contact info"):
 *   · STAFF (our licensed people + the TC) see the FULL roster: every party on
 *     the deal, including both principals' email/phone. They are the file's
 *     custodians; this is the internal packet.
 *   · A PRINCIPAL (buyer / seller — a CONTACT, not staff) sees the professional
 *     roster (agents, TC, lender, title/escrow, inspector) plus their OWN row.
 *     The COUNTERPARTY PRINCIPAL is removed entirely — not their email, not
 *     their phone, not their name. Our CRM's copy of the other side's personal
 *     contact details is not ours to hand over; whatever the executed contract
 *     discloses, it discloses on its own.
 *   · AN OUTSIDE PROFESSIONAL (the cooperating agent, an outside lender/title
 *     officer) sees the professional roster ONLY — no principal on either side.
 *     They reach their own client through their own file.
 *
 * Anything that leaves the building carries the professional-only roster; the
 * principals' personal details never ride an outbound message.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PartyContact {
  /** transaction_participants.role — buyer, seller, buyer_agent, seller_agent,
   *  lender, title_company, inspector, escrow, tc, … (free text in the schema). */
  role:            string
  name:            string
  company?:        string | null
  email?:          string | null
  phone?:          string | null
  license_number?: string | null
}

export interface TransactionTerms {
  dealName:            string | null
  propertyAddress:     string | null
  purchasePrice:       number | null
  earnestMoney:        number | null
  /** Calendar date the earnest deposit is due (never the amount). */
  earnestMoneyDue:     string | null
  contractDate:        string | null
  closingDate:         string | null
  inspectionDeadline:  string | null
  appraisalDeadline:   string | null
  financingDeadline:   string | null
  /** Every contingency written into the offer, display-cased. */
  contingencies:       string[]
  titleCompany:        string | null
}

export interface PartiesPacket {
  terms:   TransactionTerms
  parties: PartyContact[]
}

export type ViewerRole = "buyer" | "seller" | null

/** The two roles that are CLIENTS of the deal rather than professionals on it. */
export const PRINCIPAL_ROLES = ["buyer", "seller"] as const

/** Notification / activity vocabulary — one spelling, imported by every writer
 *  and by the reader that dedupes on it. */
export const PARTIES_NOTIFIED_NOTIFICATION_TYPE = "transaction.parties_notified"
export const PARTIES_NOTIFIED_ACTIVITY_TYPE     = "transaction_parties_notified"
/** Per-recipient audit row for the OUTBOUND leg (one per professional emailed),
 *  which is also its idempotency key — email has no row of its own to dedupe on. */
export const PARTIES_EMAILED_ACTIVITY_TYPE      = "transaction_parties_emailed"

export function isPrincipalRole(role: string | null | undefined): boolean {
  const r = (role ?? "").toLowerCase().trim()
  return (PRINCIPAL_ROLES as readonly string[]).includes(r)
}

// ─── Audience redaction ─────────────────────────────────────────────────────

/** STAFF: the whole roster, unredacted. */
function rosterForStaff(parties: PartyContact[]): PartyContact[] {
  return [...parties]
}

/**
 * A PRINCIPAL (our buyer or our seller): professionals + their own row. The
 * counterparty principal is dropped whole — never name, never email, never phone.
 * When the viewer's own side is unknown (null), BOTH principals are dropped:
 * an unresolved viewer must never be the reason one side's details leak.
 */
export function rosterForPrincipal(parties: PartyContact[], viewer: ViewerRole): PartyContact[] {
  return parties.filter(p => {
    if (!isPrincipalRole(p.role)) return true
    if (!viewer) return false
    return p.role.toLowerCase().trim() === viewer
  })
}

/** AN OUTSIDE PROFESSIONAL: professionals only — no principal from either side. */
function rosterForCounterparty(parties: PartyContact[]): PartyContact[] {
  return parties.filter(p => !isPrincipalRole(p.role))
}

// ─── Formatting (honest about what is missing) ──────────────────────────────

function formatRoleLabel(role: string): string {
  return role
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => (w.toLowerCase() === "tc" ? "TC" : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ")
}

function formatMoney(n: number | null | undefined): string {
  return n == null || Number.isNaN(Number(n)) ? "not recorded" : `$${Number(n).toLocaleString("en-US")}`
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "not recorded"
  return String(d).slice(0, 10)
}

/**
 * The terms + dates block. Money/time-critical facts (price, earnest deposit +
 * its due date, contract date, closing date) ALWAYS appear — "not recorded"
 * when we don't have them, because a missing closing date is information the
 * recipient needs, not a line to hide. Optional deadlines appear only when the
 * contract actually carries them.
 */
function composeTermsLines(t: TransactionTerms): string[] {
  const lines: string[] = [
    `Purchase price: ${formatMoney(t.purchasePrice)}`,
    `Earnest deposit: ${formatMoney(t.earnestMoney)} — due ${formatDate(t.earnestMoneyDue)}`,
    `Contract date: ${formatDate(t.contractDate)}`,
    `Closing date: ${formatDate(t.closingDate)}`,
  ]
  if (t.inspectionDeadline) lines.push(`Inspection deadline: ${formatDate(t.inspectionDeadline)}`)
  if (t.appraisalDeadline)  lines.push(`Appraisal deadline: ${formatDate(t.appraisalDeadline)}`)
  if (t.financingDeadline)  lines.push(`Financing deadline: ${formatDate(t.financingDeadline)}`)
  if (t.titleCompany)       lines.push(`Title / escrow: ${t.titleCompany}`)
  lines.push(
    t.contingencies.length > 0
      ? `Contingencies: ${t.contingencies.join(", ")}`
      : "Contingencies: none recorded on the offer",
  )
  return lines
}

/** One line per party: role — name, company · email · phone. */
function composeRosterLines(parties: PartyContact[]): string[] {
  return parties.map(p => {
    const who = [p.name, p.company && p.company !== p.name ? p.company : null].filter(Boolean).join(", ")
    const reach = [p.email, p.phone].filter(Boolean).join(" · ")
    return `${formatRoleLabel(p.role)} — ${who}${reach ? ` · ${reach}` : " · no contact details on file"}`
  })
}

function block(header: string, lines: string[]): string {
  return `${header}\n${lines.map(l => `• ${l}`).join("\n")}`
}

export function composeSubject(t: TransactionTerms): string {
  const where = t.propertyAddress ?? t.dealName ?? "a new transaction"
  return `Under contract: ${where}`
}

/** INTERNAL packet — full roster, everything on the file. */
export function composeStaffMessage(packet: PartiesPacket): string {
  const roster = rosterForStaff(packet.parties)
  return [
    block("Terms and dates", composeTermsLines(packet.terms)),
    roster.length > 0
      ? block("Parties on this deal", composeRosterLines(roster))
      : "Parties on this deal\n• No participant records resolved yet — add them on the transaction.",
  ].join("\n\n")
}

/** CLIENT packet — their deal, their deadlines, their team. */
export function composeClientMessage(packet: PartiesPacket, viewer: ViewerRole): string {
  const roster = rosterForPrincipal(packet.parties, viewer)
  const opening =
    viewer === "seller"
      ? "Your home is under contract. Here are the agreed terms, the dates that now govern the deal, and how to reach everyone working on it."
      : "You're under contract. Here are the agreed terms, the dates that now govern the deal, and how to reach everyone working on it."
  return [
    opening,
    block("Terms and dates", composeTermsLines(packet.terms)),
    roster.length > 0
      ? block("Your deal team", composeRosterLines(roster))
      : "Your deal team\n• Your agent will confirm the full team shortly.",
  ].join("\n\n")
}

/** OUTSIDE-PROFESSIONAL packet — professional roster only. */
export function composeCounterpartyMessage(packet: PartiesPacket): string {
  const roster = rosterForCounterparty(packet.parties)
  return [
    "The contract is executed and the file is open on our side. Here are the terms and dates we have recorded, and the professionals working the file.",
    block("Terms and dates", composeTermsLines(packet.terms)),
    roster.length > 0
      ? block("Working the file", composeRosterLines(roster))
      : "Working the file\n• Contact details will follow from the listing side.",
    "If anything below differs from your copy of the contract, reply to this message so we can reconcile before the first deadline.",
  ].join("\n\n")
}

/** Plain text → minimal HTML (the email gate wants html; no markup in our text). */
export function toHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return esc
    .split("\n\n")
    .map(p => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("\n")
}

// ─── Contingency normalisation (display) ────────────────────────────────────

/**
 * offers.contingencies is a free-text array (agent- or AI-populated). Fold the
 * spellings for display without inventing any: unknown values pass through
 * title-cased so nothing the contract said is dropped from the notice.
 */
export function displayContingencies(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const s = String(item ?? "").trim()
    if (!s) continue
    const label = formatRoleLabel(s.replace(/[-]+/g, " "))
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}
