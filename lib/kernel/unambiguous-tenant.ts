// lib/kernel/unambiguous-tenant.ts
// ─────────────────────────────────────────────────────────────────────────────
// "WHOSE IS THIS?" WHEN THE ONLY IDENTITY IS AN EMAIL OR A PHONE NUMBER.
//
// An external feed — a provider webhook, an inbound mail relay, an SMS gateway —
// arrives holding a person, not a tenant. The only way back to a brokerage is to
// look the person up in `contacts`. And an email address or a phone number is NOT
// unique across tenants: the same person can be a contact at two brokerages.
//
// The shape that keeps appearing, and the reason this module exists:
//
//     const { data } = await svc.from("contacts").select("id")
//       .eq("phone", payload.phoneNumber).limit(1)      ← whichever sorts first
//     contactId = data?.[0]?.id
//
// `.limit(1)` (and `.maybeSingle()`, which errors instead) does not resolve the
// ambiguity, it HIDES it: PostgREST returns whichever row the planner produced
// first, and the handler then writes to that tenant with total confidence. For a
// suppression feed that means one brokerage's "stop texting me" silences another
// brokerage's contact — a cross-tenant write AND a denial of communication.
//
// ── THE RULE, WHICH IS NOT NEW HERE ─────────────────────────────────────────
// Take the match only when it is UNAMBIGUOUS. Read one row MORE than you need
// (limit(2), not limit(1)) so ambiguity is visible at all, and require every
// candidate to name the SAME brokerage. Two tenants claiming the identity means
// we cannot know whose message this is, and guessing is the bug.
//
// It was already in force in two places, written out twice:
//   · app/api/webhooks/sendgrid-events/route.ts — limit(2)/limit(5) + one distinct
//     brokerage_id, on both the engagement stream and the recency fallback.
//   · app/api/webhooks/inbound-mail/route.ts — the same rule with the
//     same-person-at-two-brokerages case documented in prose.
// CLAUDE.md §6: two spellings of one idea are a defect. This is the survivor they
// merge onto, and it is PURE so a simulator can drive it directly rather than
// re-deriving the rule in a regex.
//
// ── NULL IS A VALUE, NOT AN ABSENCE ─────────────────────────────────────────
// `contacts.brokerage_id` is NULLABLE (verified live on hrvaqgvukzxfskkcrwbt,
// 2026-08-24). A set of candidates that all carry NULL is UNAMBIGUOUS about the
// tenant being unknown — which is a different fact from "they disagree", and a
// caller that must write a tenanted row has to refuse it. `brokerageId` comes back
// null in that case rather than the function inventing one, and
// `requireTenantedUnambiguousTenant` is the fail-closed variant for callers that
// cannot proceed without a real tenant.

/** The sliver of a candidate row this rule reads. */
export interface TenantCandidate {
  brokerage_id: string | null
}

export type UnambiguousTenant<T> =
  | {
      ok: true
      /** The one brokerage every candidate named. NULL when every candidate is untenanted. */
      brokerageId: string | null
      /** All candidates — they are all in the same tenant, so all of them are usable. */
      rows: T[]
    }
  | {
      ok: false
      reason: "no_match" | "ambiguous_tenant" | "untenanted"
      /** How many DISTINCT brokerage_id values the candidates carried. */
      tenantCount: number
      rows: T[]
    }

function distinctTenants<T extends TenantCandidate>(rows: T[]): Set<string | null> {
  return new Set(rows.map((r) => r.brokerage_id ?? null))
}

/**
 * PURE. Accept the candidates only when they all name ONE tenant.
 *
 * Pass rows read with a limit of at least 2 — with `.limit(1)` this function
 * cannot tell an unambiguous match from a truncated ambiguous one, and it will
 * cheerfully report `ok` for the first of five tenants.
 */
export function resolveUnambiguousTenant<T extends TenantCandidate>(
  rows: T[] | null | undefined,
): UnambiguousTenant<T> {
  const list = rows ?? []
  if (list.length === 0) return { ok: false, reason: "no_match", tenantCount: 0, rows: list }
  const tenants = distinctTenants(list)
  if (tenants.size !== 1) return { ok: false, reason: "ambiguous_tenant", tenantCount: tenants.size, rows: list }
  return { ok: true, brokerageId: list[0].brokerage_id ?? null, rows: list }
}

/**
 * The FAIL-CLOSED variant, for a caller that must write a tenanted row: one
 * tenant AND that tenant is not null. "Every candidate is untenanted" is reported
 * as its own reason so the caller can log which of the three things happened
 * rather than collapsing all of them into "not found".
 */
export function requireTenantedUnambiguousTenant<T extends TenantCandidate>(
  rows: T[] | null | undefined,
): UnambiguousTenant<T> & ({ ok: true; brokerageId: string } | { ok: false }) {
  const r = resolveUnambiguousTenant(rows)
  if (!r.ok) return r
  if (r.brokerageId === null) {
    return { ok: false, reason: "untenanted", tenantCount: 1, rows: r.rows }
  }
  return { ok: true, brokerageId: r.brokerageId, rows: r.rows }
}

// ─────────────────────────────────────────────────────────────────────────────
// "WHICH ROW IS THE SUBJECT?" — ONE TENANT, TWO TABLES.
//
// OWNER RULING (2026-08-24), verbatim: "inbound should be checked on contact id
// and leads are pulled from leads (contactid) which should this should be
// checking on contacts and leads since the inbound can be for leads that haven't
// converted yet."
//
// A person the OS is still cold-outreaching has a `leads` row and NO `contacts`
// row — `leads.contact_id` is NULL until the promotion path stamps it. So an
// identity lookup that reads `contacts` alone answers "we do not know this
// person" for exactly the population whose do-not-contact request matters most,
// and the request is dropped in silence.
//
// WIDENING THE SEARCH MAKES AMBIGUITY MORE LIKELY, NOT LESS: the same human can
// be a lead at one brokerage and a contact at another. That is why the candidates
// from both tables are UNIONED and handed to `resolveUnambiguousTenant` ABOVE
// before this function is ever reached — resolving each table separately would
// call each one individually unambiguous and never notice that the two disagree.
// By the time this runs, exactly one tenant is on the table.
//
// PURE, so a simulator can EXECUTE the rule instead of pattern-matching it — the
// same reason the tenant rule itself lives here (CLAUDE.md §2).
// ─────────────────────────────────────────────────────────────────────────────

/** Which table an identity candidate was read from. */
export type IdentityTable = "contacts" | "leads"

export interface IdentitySubjectCandidate extends TenantCandidate {
  id: string
  table: IdentityTable
}

export type IdentitySubject =
  | { kind: "contact"; id: string; brokerageId: string | null }
  | { kind: "lead"; id: string; brokerageId: string | null }

/**
 * PURE. Pick the row to act on from candidates the tenant rule has ALREADY
 * accepted (i.e. they all name one brokerage).
 *
 * THE CONTACT WINS WHEN THERE IS ONE. A converted person owns BOTH rows in that
 * tenant, every contact-side compliance gate reads the CONTACT's flags, and the
 * lead-side writer would only have mirrored back onto the contact anyway. The
 * LEAD is the subject precisely when no contact row exists — which is the case
 * the ruling is about.
 *
 * It is deliberately NOT "take rows[0]": the query order is an implementation
 * detail of whichever table was read first, and a rule that depends on it would
 * suppress the lead and leave the contact reachable the moment the reads are
 * reordered.
 */
export function pickIdentitySubject<T extends IdentitySubjectCandidate>(
  rows: T[] | null | undefined,
): IdentitySubject | null {
  const list = rows ?? []
  const contact = list.find((r) => r.table === "contacts")
  if (contact) return { kind: "contact", id: contact.id, brokerageId: contact.brokerage_id ?? null }
  const lead = list.find((r) => r.table === "leads")
  if (lead) return { kind: "lead", id: lead.id, brokerageId: lead.brokerage_id ?? null }
  return null
}
