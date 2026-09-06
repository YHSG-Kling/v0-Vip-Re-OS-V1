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
// ── WHAT THE DATABASE ADMITS (project hrvaqgvukzxfskkcrwbt, after m563) ──────
//
//   contacts_contact_type_check CHECK (contact_type = ANY (ARRAY[
//     'lead','prospect','lifetime_customer','sphere','vendor',
//     'referral_partner','investor','buyer','seller','both','other']))
//
// ELEVEN values. m563 removed the twelfth, 'client', on the OWNER RULING:
// "client isn't a type". That ruling REVERSES what m539 and this file built two
// waves earlier — m539 deliberately KEPT 'client' while collapsing the lifetime
// spellings, and 'client' was the first member of both rosters below. It is
// recorded as a reversal, not quietly absorbed.
//
// WHY IT WENT (§6). `contact_type` answers ONE question — which side of a
// transaction is this person on — and every other value answers it. 'client'
// answered a DIFFERENT one ("are they represented?"), which every row can already
// answer more precisely as buyer / seller / both / investor. So it was a second
// spelling with the side thrown away. THE REPRESENTATION FACT IS NOT LOST: it
// lives on contacts.STATUS ('representation' / 'active_transaction' /
// 'under_contract' — the vocabulary lib/kernel/compliance.ts::REPRESENTATION_LOCK_STATES
// gates outbound messaging on) and on contacts.LIFECYCLE_STATE. Neither moved.
//
// Before m539 the CHECK also admitted 'lifetime' and 'past_client' — THREE spellings of
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

/** Every contact_type the live `contacts_contact_type_check` admits (m563). */
export const CONTACT_TYPES = [
  "lead",
  "prospect",
  // TOMBSTONE (§1): 'client' stood here and was REMOVED by m563 on the owner
  // ruling "client isn't a type". It has NO single survivor value — see the
  // header — so it is not re-pointed anywhere; the representation fact it
  // half-carried survives on contacts.status / contacts.lifecycle_state.
  "lifetime_customer",
  "sphere",
  "vendor",
  "referral_partner",
  // TOMBSTONE (§1/§6): 'investor' stood here and was RETIRED by m593 on the
  // owner ruling "investor is a persona and not a contact type". SURVIVOR for
  // the situation: contacts.contact_persona = 'investor' (m589); the SIDE a
  // legacy investor-typed row belonged to is 'buyer' (m593's backfill), which
  // is what RETIRED_CONTACT_TYPES maps the spelling to below.
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
 *
 * `client` (removed from the CHECK by m563) IS DELIBERATELY NOT A KEY HERE, and
 * that is the whole difference between a COLLAPSE and a REMOVAL. m539 collapsed
 * three spellings onto a survivor every row could be mapped to. m563 removed a
 * value whose correct replacement DEPENDS ON THE ROW — a represented buyer is
 * 'buyer', a seller 'seller', a dual-sided move 'both', a closed deal
 * 'lifetime_customer' — so there is nothing honest to put on the right-hand side.
 * `canonicalContactType('client')` therefore returns NULL, which is exactly what
 * the doc below says null means: "we could not read this", a fact worth finding,
 * rather than a silent mislabelling of a represented client as a past one.
 */
export const RETIRED_CONTACT_TYPES: Readonly<Record<string, ContactType>> = Object.freeze({
  lifetime: LIFETIME_CUSTOMER_TYPE,
  past_client: LIFETIME_CUSTOMER_TYPE,
  past_seller: LIFETIME_CUSTOMER_TYPE,
  // m593: the retired investor TYPE maps to its side; the situation it really
  // named lives on contact_persona='investor' (m589) and is written by the
  // creators — the tolerant reader only decides the side.
  investor: "buyer",
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
 *
 * ── m563 SHRANK THIS ROSTER FROM THREE TO TWO, AND THAT IS A BEHAVIOUR CHANGE ──
 * 'client' was the first member and the owner ruled it out of the vocabulary
 * entirely. It is REMOVED here rather than left to rot, because the database now
 * refuses it on write and matches nothing on read — and supabase-js RESOLVES both
 * (CLAUDE.md §3), so a filter naming it would narrow silently, not loudly.
 *
 * WHAT THAT ACTUALLY CHANGES: every `.in("contact_type", LIFETIME_CONTACT_TYPES)`
 * reader below now selects {lifetime_customer, sphere} instead of
 * {client, lifetime_customer, sphere}. On hrvaqgvukzxfskkcrwbt the selected
 * population is UNCHANGED — the live census is buyer 2, lifetime_customer 1,
 * seller 1, with ZERO rows on 'client' and zero on 'sphere' — so the roster
 * resolves to the same one row it did before. The change is real in code and
 * nil in data today; it will not stay nil once tenants have volume.
 */
export const LIFETIME_CONTACT_TYPES = [
  "lifetime_customer",
  "sphere",
] as const

/**
 * The post-close roster PLUS the referral partners who sit beside it. Used by the
 * sphere/gifting/referral surfaces, which address the whole relationship book
 * rather than only people who closed a deal with us.
 *
 * Four members → three, for the same m563 reason as the roster above.
 */
export const SPHERE_CONTACT_TYPES = [
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
