// lib/campaigns/contact-sources.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL contacts.source VOCABULARY — the key a campaign sequence is
// selected by.
//
// OWNER RULING: "the home value and lead magnet contacts should have a source and
// the campaign sequence should be keyed on source. persona column should be
// present. the campaigns should be automatically keyed off when the contact signs
// up for those campaigns automatically (autonomous)."
//
// WHY THIS MODULE HAD TO COME FIRST. contacts.source is free text — no CHECK — so
// nothing stopped one feature writing it two ways. The home-value capture does
// exactly that: app/actions/home-value.ts inserts a contact with
// source: "home_value" in one branch and source: "home_value_tool" in another.
// Keying a sequence on a value the writers do not agree on cannot work: half the
// captures would silently never enrol. So the sources are pinned here, both
// writers use the constant, and the loose spellings already in the database are
// mapped forward by normalizeContactSource() rather than orphaned.
//
// TWO AXES, NOT ONE. See below — contact_type (buyer/seller/both/lifetime) and
// persona (first_time/divorce/probate/fsbo/downsize/…) are independent, and m294
// corrects an earlier migration of mine that conflated them.

/** Canonical capture sources that a campaign sequence can be keyed on. */
export const CONTACT_SOURCE_HOME_VALUE = "home_value"
export const CONTACT_SOURCE_LEAD_MAGNET = "lead_magnet"

export const CAMPAIGN_KEYED_SOURCES = [
  CONTACT_SOURCE_HOME_VALUE,
  CONTACT_SOURCE_LEAD_MAGNET,
] as const

export type CampaignKeyedSource = (typeof CAMPAIGN_KEYED_SOURCES)[number]

/**
 * Loose spellings already written into contacts.source, mapped onto the canonical
 * key. `home_value_tool` is the one home-value's second insert branch produced.
 * Lead-magnet callers may pass `lead_magnet:<magnet_type>`; the prefix is the key.
 */
const SOURCE_ALIASES: Record<string, CampaignKeyedSource> = {
  home_value: CONTACT_SOURCE_HOME_VALUE,
  home_value_tool: CONTACT_SOURCE_HOME_VALUE,
  home_value_page: CONTACT_SOURCE_HOME_VALUE,
  home_valuation: CONTACT_SOURCE_HOME_VALUE,
  lead_magnet: CONTACT_SOURCE_LEAD_MAGNET,
}

/**
 * PURE — the canonical campaign key for a raw contacts.source value, or null when
 * the source is not one a sequence is keyed on (website, referral, sphere, …).
 * Null is the honest answer: it means "no keyed campaign for this contact",
 * not "enrol them in something arbitrary".
 */
export function normalizeContactSource(raw: string | null | undefined): CampaignKeyedSource | null {
  const t = (raw ?? "").trim().toLowerCase()
  if (!t) return null
  if (SOURCE_ALIASES[t]) return SOURCE_ALIASES[t]
  // `lead_magnet:home_valuation` and friends — the prefix before ':' is the key.
  const prefix = t.split(":")[0]
  return SOURCE_ALIASES[prefix] ?? null
}

// ── The TWO audience axes ────────────────────────────────────────────────────
//
// OWNER: "persona is like a first time home buyer, divorce, probate, expired,
// fsbo, downsizer, senior, etc and contact type is seller, buyer, both,
// lifetime."
//
// They are INDEPENDENT and a campaign needs both. A downsizing seller and a
// first-time buyer are different campaigns — and so are a downsizing seller and
// a divorcing seller. lib/agents/campaign-orchestrator.ts already composes each
// campaign by "trigger + persona + consent state"; this is that persona.

/** WHO they are to us. campaign_sequences.contact_type (m294). */
export const CAMPAIGN_CONTACT_TYPES = ["buyer", "seller", "both", "lifetime"] as const
export type CampaignContactType = (typeof CAMPAIGN_CONTACT_TYPES)[number]

export function isCampaignContactType(v: string | null | undefined): v is CampaignContactType {
  return !!v && (CAMPAIGN_CONTACT_TYPES as readonly string[]).includes(v)
}

/**
 * WHAT SITUATION brought them to the market. Mirrors the `Persona` union in
 * lib/kernel/types.ts exactly — one vocabulary, two places that must agree, and
 * scripts/campaign-auto-enroll-simulator.ts pins them together.
 */
export const CAMPAIGN_PERSONAS = [
  "first_time", "relocated", "luxury", "fsbo", "probate", "upsize",
  "downsize", "military", "divorce", "senior", "expired", "foreclosure", "other",
] as const
export type CampaignPersona = (typeof CAMPAIGN_PERSONAS)[number]

export function isCampaignPersona(v: string | null | undefined): v is CampaignPersona {
  return !!v && (CAMPAIGN_PERSONAS as readonly string[]).includes(v)
}

/** contacts.contact_type values that mean an established, post-close relationship. */
const LIFETIME_TYPES = new Set(["lifetime", "lifetime_customer", "past_client", "client", "sphere"])

/**
 * PURE — the campaign contact_type for a contact. Defaults to `buyer`, matching
 * the resolver engage-contact.ts already uses for situational portal messages:
 * an unknown type is treated as a buyer rather than dropped, so a capture never
 * falls out of the funnel.
 */
export function contactTypeForContact(contactType: string | null | undefined): CampaignContactType {
  const t = (contactType ?? "").trim().toLowerCase()
  if (t === "seller") return "seller"
  if (t === "both") return "both"
  if (LIFETIME_TYPES.has(t)) return "lifetime"
  return "buyer"
}

/**
 * PURE — the contact_type a home-value capture implies. Someone asking what
 * their home is worth is a seller, whatever their type said on the way in — but
 * a known lifetime customer stays lifetime.
 */
export function contactTypeForSource(
  source: CampaignKeyedSource,
  contactType: string | null | undefined,
): CampaignContactType {
  const resolved = contactTypeForContact(contactType)
  if (source === CONTACT_SOURCE_HOME_VALUE && resolved === "buyer") return "seller"
  return resolved
}

/**
 * contacts.contact_persona is free text and has ALREADY drifted from the Persona
 * union — live rows carry `first_time_buyer`, `luxury_buyer`, `listing_seller`,
 * `past_client`, none of which are Persona values. These map the drifted
 * spellings forward; a spelling that encodes a CONTACT TYPE rather than a
 * situation (listing_seller, past_client) has no persona and returns null, so it
 * is never mistaken for one.
 */
const PERSONA_ALIASES: Record<string, CampaignPersona> = {
  first_time_buyer: "first_time",
  firsttime: "first_time",
  first_time_seller: "first_time",
  luxury_buyer: "luxury",
  luxury_seller: "luxury",
  downsizer: "downsize",
  downsizing: "downsize",
  upsizer: "upsize",
  upsizing: "upsize",
  relocation: "relocated",
  veteran: "military",
  pre_foreclosure: "foreclosure",
  expired_listing: "expired",
  for_sale_by_owner: "fsbo",
}

/**
 * PURE — the canonical persona for a raw contacts.contact_persona, or null when
 * the value names no situation. Null means "no persona-specific campaign", which
 * a persona-agnostic sequence still serves.
 */
export function normalizeContactPersona(raw: string | null | undefined): CampaignPersona | null {
  const t = (raw ?? "").trim().toLowerCase()
  if (!t) return null
  if (isCampaignPersona(t)) return t
  return PERSONA_ALIASES[t] ?? null
}
