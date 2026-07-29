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
// PERSONA is the buyer/seller axis the product already uses to pick content —
// engage-contact.ts resolves exactly this from contact_type when it chooses a
// situational portal message. Same four values, one resolver, so a sequence and
// an ISA touch cannot disagree about who they are talking to.

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

// ── Persona ──────────────────────────────────────────────────────────────────

/**
 * The audience axis a sequence targets. Matches the persona engage-contact.ts
 * already derives from contact_type for situational portal messages.
 */
export const CAMPAIGN_PERSONAS = ["buyer", "seller", "both", "lifetime"] as const
export type CampaignPersona = (typeof CAMPAIGN_PERSONAS)[number]

export function isCampaignPersona(v: string | null | undefined): v is CampaignPersona {
  return !!v && (CAMPAIGN_PERSONAS as readonly string[]).includes(v)
}

/** contacts.contact_type values that mean an established, post-close relationship. */
const LIFETIME_TYPES = new Set(["lifetime", "lifetime_customer", "past_client", "client", "sphere"])

/**
 * PURE — the persona for a contact, from its contact_type. Defaults to `buyer`,
 * which is what the ISA's own resolver does: an unknown type is treated as a
 * buyer rather than dropped, so a capture never falls out of the funnel.
 */
export function personaForContactType(contactType: string | null | undefined): CampaignPersona {
  const t = (contactType ?? "").trim().toLowerCase()
  if (t === "seller") return "seller"
  if (t === "both") return "both"
  if (LIFETIME_TYPES.has(t)) return "lifetime"
  return "buyer"
}

/**
 * PURE — the persona a home-value capture implies. Someone asking what their
 * home is worth is a seller, whatever their contact_type says on the way in.
 */
export function personaForSource(
  source: CampaignKeyedSource,
  contactType: string | null | undefined,
): CampaignPersona {
  if (source === CONTACT_SOURCE_HOME_VALUE) {
    // A home-value lead who is ALSO a known buyer is 'both', not a plain seller.
    return personaForContactType(contactType) === "buyer" ? "seller" : personaForContactType(contactType)
  }
  return personaForContactType(contactType)
}
