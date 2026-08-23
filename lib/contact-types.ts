// lib/contact-types.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CONTACT-TYPE VOCABULARY. ONE DEFINITION, DEFINED SO IT CANNOT DRIFT.
//
// OWNER, on contact_type admitting three spellings of one idea: "collapse".
// OWNER: "vocabulary needs to be defined to prevent drifting."
//
// PURE — no I/O, no `server-only` — so scripts/contact-vocabulary-guard.ts can
// import it directly and hold it against the live database.
//
// ── WHAT THE DATABASE ADMITS (project hrvaqgvukzxfskkcrwbt, after m539) ──────
//
//   contacts_contact_type_check CHECK (contact_type = ANY (ARRAY[
//     'lead','prospect','client','lifetime_customer','sphere','vendor',
//     'referral_partner','investor','buyer','seller','both','other']))
//
// Before m539 it also admitted 'lifetime' and 'past_client' — THREE spellings of
// "a person we have already closed with". CLAUDE.md §6: two spellings of one idea
// are a defect, because a scorer cannot match a writer across them. It had already
// cost behaviour here — migration 433 renamed past_client → lifetime_customer and
// left the `contact_type === 'lifetime'` readers behind, so canonical past clients
// were silently classed as BUYERS and got the wrong reel, voicemail and portal
// persona.
//
// ── THE ASYMMETRY THAT MAKES THIS SAFE ──────────────────────────────────────
// READERS stay TOLERANT: a row imported from a CRM sync, a legacy export or a
// hand-typed CSV may still say `past_client`, and `canonicalContactType` maps it
// forward rather than dropping the person on the floor.
// WRITERS and DB FILTERS must name only a SURVIVOR: the database refuses a
// retired spelling on write (23514) and matches nothing on read, and supabase-js
// RESOLVES both — the row is lost, or the query is empty, in silence.
// scripts/contact-vocabulary-guard.ts enforces exactly that split.
//
// TOMBSTONE: app/lib/contact-types.ts was a byte-identical copy of this file's
// first eight lines with no importer anywhere. Deleted; this file is the survivor.

/** Every contact_type the live `contacts_contact_type_check` admits (m539). */
export const CONTACT_TYPES = [
  "lead",
  "prospect",
  "client",
  "lifetime_customer",
  "sphere",
  "vendor",
  "referral_partner",
  "investor",
  "buyer",
  "seller",
  "both",
  "other",
] as const

export type ContactType = (typeof CONTACT_TYPES)[number]

const CONTACT_TYPE_SET = new Set<string>(CONTACT_TYPES)

/** The canonical "we have already closed with this person" contact_type. */
export const LIFETIME_CUSTOMER_TYPE = "lifetime_customer" as const

/**
 * Audience-segment string used by app-layer filters (campaigns, automations, AI
 * prompts) and by the `lifetime_customers` ad source rule. NOT a contact_type and
 * NOT DB-enforced — a different function, deliberately spelled differently so the
 * two are never confused at a call site.
 */
export const LIFETIME_CUSTOMER_SEGMENT = "lifetime_customers" as const

/**
 * RETIRED SPELLINGS → their survivor. THE ONLY PLACE a retired spelling is named.
 *
 * `lifetime` and `past_client` were removed from the CHECK by m539; `past_seller`
 * never was a legal contact_type at all (it was written by the listing-close path
 * before migration 433 and is kept here so an old row still reads correctly).
 *
 * A guard asserts that NO key here is a value the live CHECK still admits, and
 * that EVERY value here is one it does — so this table can never quietly become a
 * map onto something the database also refuses.
 */
export const RETIRED_CONTACT_TYPES: Readonly<Record<string, ContactType>> = Object.freeze({
  lifetime: LIFETIME_CUSTOMER_TYPE,
  past_client: LIFETIME_CUSTOMER_TYPE,
  past_seller: LIFETIME_CUSTOMER_TYPE,
})

/**
 * PURE — the storable contact_type for any spelling, or `null` when the value is
 * not a contact_type at all.
 *
 * Returning `null` rather than guessing is deliberate: an unrecognised value is
 * NOT quietly mapped to `other`, because "we could not read this" and "this person
 * declared no type" are different facts and only the first one is a bug worth
 * finding. Callers that need a fallback pick it themselves, visibly.
 */
export function canonicalContactType(contactType: string | null | undefined): ContactType | null {
  const t = (contactType ?? "").trim().toLowerCase()
  if (!t) return null
  if (CONTACT_TYPE_SET.has(t)) return t as ContactType
  return RETIRED_CONTACT_TYPES[t] ?? null
}

/** PURE — is this a contact_type the database will accept, exactly as written? */
export function isStorableContactType(contactType: string | null | undefined): contactType is ContactType {
  return CONTACT_TYPE_SET.has((contactType ?? "").trim().toLowerCase())
}

/**
 * PURE — canonical test for "is this contact_type the lifetime customer".
 *
 * Deliberately TOLERANT of the retired spellings (see the asymmetry note above):
 * it reads stored data, it does not author it. Every persona resolver in the OS
 * goes through this — reel persona, situational voicemail, portal role, the sphere
 * agent — so that a legacy row cannot get a buyer's script.
 */
export function isLifetimeCustomerType(contactType: string | null | undefined): boolean {
  return canonicalContactType(contactType) === LIFETIME_CUSTOMER_TYPE
}

/**
 * contact_type values that mean an ESTABLISHED, POST-CLOSE relationship — the
 * roster the sphere/referral/win-back/audience lanes all select on.
 *
 * ── ONE SET, FOUR PLACES THAT USED TO SPELL IT SEPARATELY (CLAUDE.md §1, §6) ──
 * This lived, independently, as:
 *   lib/campaigns/contact-sources.ts   LIFETIME_CONTACT_TYPES (tuple, 5 values)
 *   lib/kernel/returning-customer.ts   LIFETIME_CONTACT_TYPES (Set, 5 values)
 *   lib/kernel/referral-radar.ts       PAST_CLIENT_TYPES      (tuple, 5 values)
 *   app/api/cron/lifetime-npv-forecast-rollup/route.ts LIFETIME_CONTACT_TYPES
 *                                                             (3 values — different!)
 * Four copies, three of which named `lifetime`/`past_client`, which m539 retired:
 * every one of those `.in("contact_type", …)` / `.or("contact_type.eq.…")` filters
 * was about to start selecting on values the column can never hold. The fourth had
 * already drifted to a different membership, so the "lifetime roster" meant three
 * different populations depending on which lane you asked.
 *
 * All four now import THIS. Every member is admitted by the live CHECK, and the
 * guard proves it.
 */
export const LIFETIME_CONTACT_TYPES = [
  "client",
  "lifetime_customer",
  "sphere",
] as const

/**
 * The post-close roster PLUS the referral partners who sit beside it. Used by the
 * sphere/gifting/referral surfaces, which address the whole relationship book
 * rather than only people who closed a deal with us.
 */
export const SPHERE_CONTACT_TYPES = [
  "client",
  "lifetime_customer",
  "sphere",
  "referral_partner",
] as const

const LIFETIME_TYPE_SET = new Set<string>(LIFETIME_CONTACT_TYPES)

/** PURE — is this contact an established, post-close relationship? Tolerant of retired spellings. */
export function isLifetimeRelationshipType(contactType: string | null | undefined): boolean {
  const c = canonicalContactType(contactType)
  return c !== null && LIFETIME_TYPE_SET.has(c)
}
