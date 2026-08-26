// lib/data-steward/value-normalizer.ts
//
// Data Steward — VALUE normalization for imports. Field-name mapping gets data into
// the right column; this gets the right VOCABULARY into that column. Another CRM's
// "Hot Lead!", "SELLER", "Txt Only", "Pre-Approved!!" must land as our canonical
// 'hot' / 'seller' / 'sms' / 'pre_approved' or reporting and automated runs
// (scorers, ISA routing, segments) silently miss the record forever.
//
// Two tiers:
//   Tier 1 (this module, pure): exact + synonym-table matching. Free, instant,
//     deterministic — covers the common CRM exports.
//   Tier 2 (ai-value-matcher.ts): ONE batched AI call per import run for values
//     tier 1 can't resolve. The AI may only pick from the canonical list below —
//     anything else is rejected by sanitizeEnumValue, so a hallucinated value can
//     never reach a column (the DB check constraint is the last line of defense,
//     not the first).
//
// Unresolved values are NEVER written to the column — the caller preserves them in
// notes, so nothing is dropped and a human (or a later steward pass) can reconcile.
//
// VOCABULARIES ARE GROUNDED IN THE LIVE SCHEMA (do not extend casually):
//   contact_type     — contacts_contact_type_check
//   lead_temperature — contacts_lead_temperature_check
//   lender_status    — contacts_lender_status_check
//   preferred_channel — captureContact's TS contract ('phone'|'email'|'sms')
// buyer_stage / status / lifecycle_state are intentionally NOT importable — they
// are kernel-managed state machines a foreign CRM's labels must not fight.

import { CONTACT_TYPES, LIFETIME_CUSTOMER_TYPE } from "@/lib/contact-types"

export interface EnumVocabulary {
  /** The canonical values — must mirror the live check constraint exactly. */
  canonical: readonly string[]
  /** Lower-cased synonym → canonical. Keys are matched after trim/lowercase/strip-punct. */
  synonyms: Record<string, string>
}

export const ENUM_VOCABULARIES: Record<string, EnumVocabulary> = {
  contact_type: {
    canonical: [
      // m539 collapsed lifetime / lifetime_customer / past_client onto one survivor.
      // m563 REMOVED 'client' entirely (owner: "client isn't a type").
      // This list is the WRITE side: a value outside the live CHECK is refused (23514)
      // and supabase-js resolves the refusal, so the whole imported row is lost silently.
      ...CONTACT_TYPES,
    ],
    synonyms: {
      'new lead': 'lead', 'cold lead': 'lead', 'web lead': 'lead', 'internet lead': 'lead',
      'potential client': 'prospect', 'potential': 'prospect', 'possible client': 'prospect',
      // TOMBSTONE (§1). `'active client' | 'current client' | 'customer' → 'client'`
      // stood here. m563 removed 'client' from contacts_contact_type_check, so all
      // three had become synonyms pointing at a value the DATABASE REFUSES (23514) —
      // and PGRST/postgres refuses the ENTIRE row, so an import row carrying
      // "Active Client" would have been dropped wholesale, silently.
      //
      // THEY ARE NOT RE-POINTED, and that is the same measured decision m563 itself
      // made about the backfill: the correct target depends on the row (a represented
      // buyer is 'buyer', a seller 'seller', a dual-sided move 'both', a closed deal
      // 'lifetime_customer') and this table cannot see the row. Deleting them makes
      // normalizeEnumValue return { value: null, method: null }, which puts the raw
      // string on `unresolved` for the tier-2 matcher and the operator — the vocabulary
      // "we could not read this", which is the fact worth surfacing. Guessing 'buyer'
      // would file a seller under the wrong desk and never be noticed.
      // SURVIVOR of the representation fact: contacts.status / contacts.lifecycle_state.
      'past customer': LIFETIME_CUSTOMER_TYPE, 'previous client': LIFETIME_CUSTOMER_TYPE,
      'closed client': LIFETIME_CUSTOMER_TYPE, 'past client': LIFETIME_CUSTOMER_TYPE,
      'sold': LIFETIME_CUSTOMER_TYPE, 'lifetime': LIFETIME_CUSTOMER_TYPE,
      'lifetime customer': LIFETIME_CUSTOMER_TYPE,
      'soi': 'sphere', 'sphere of influence': 'sphere', 'friend': 'sphere', 'family': 'sphere',
      'personal': 'sphere',
      'home buyer': 'buyer', 'homebuyer': 'buyer', 'purchaser': 'buyer', 'buying': 'buyer',
      'first time buyer': 'buyer',
      'home seller': 'seller', 'homeowner selling': 'seller', 'selling': 'seller',
      'listing client': 'seller', 'fsbo': 'seller',
      'buyer and seller': 'both', 'buyer/seller': 'both', 'buy and sell': 'both',
      'real estate investor': 'investor', 'flipper': 'investor', 'landlord': 'investor',
      'referral': 'referral_partner', 'referral source': 'referral_partner', 'partner': 'referral_partner',
      'contractor': 'vendor', 'service provider': 'vendor',
    },
  },
  lead_temperature: {
    canonical: ['hot', 'warm', 'cold'],
    synonyms: {
      'hot lead': 'hot', 'very hot': 'hot', 'urgent': 'hot', 'a': 'hot', 'a lead': 'hot',
      'high': 'hot', 'high priority': 'hot', '🔥': 'hot',
      'warm lead': 'warm', 'b': 'warm', 'b lead': 'warm', 'medium': 'warm', 'nurture': 'warm',
      'cold lead': 'cold', 'c': 'cold', 'c lead': 'cold', 'low': 'cold', 'long term': 'cold',
      'ice cold': 'cold', 'dormant': 'cold',
    },
  },
  lender_status: {
    canonical: ['cash', 'pre_approved', 'needs_pre_approval', 'unknown'],
    synonyms: {
      'cash buyer': 'cash', 'all cash': 'cash', 'paying cash': 'cash', 'no financing': 'cash',
      'pre-approved': 'pre_approved', 'preapproved': 'pre_approved', 'pre approved': 'pre_approved',
      'approved': 'pre_approved', 'has lender': 'pre_approved', 'pre-qualified': 'pre_approved',
      'prequalified': 'pre_approved', 'pre qual': 'pre_approved',
      'needs financing': 'needs_pre_approval', 'needs lender': 'needs_pre_approval',
      'not approved': 'needs_pre_approval', 'no lender': 'needs_pre_approval',
      'needs pre-approval': 'needs_pre_approval', 'not pre-approved': 'needs_pre_approval',
      'n/a': 'unknown', 'tbd': 'unknown', 'not sure': 'unknown',
    },
  },
  preferred_channel: {
    canonical: ['phone', 'email', 'sms'],
    synonyms: {
      'call': 'phone', 'phone call': 'phone', 'voice': 'phone', 'call me': 'phone',
      'cell': 'phone', 'mobile': 'phone', 'telephone': 'phone',
      'e-mail': 'email', 'email me': 'email', 'mail': 'email',
      'text': 'sms', 'txt': 'sms', 'txt only': 'sms', 'text only': 'sms',
      'text message': 'sms', 'message': 'sms', 'imessage': 'sms', 'whatsapp': 'sms',
    },
  },
}

/** Fields the import path treats as enum-normalizable. */
export const NORMALIZABLE_ENUM_FIELDS = Object.keys(ENUM_VOCABULARIES)

function canon(raw: string): string {
  // trim, lowercase, collapse whitespace, strip trailing/leading punctuation noise
  return raw.trim().toLowerCase().replace(/[!.]+$/g, '').replace(/\s+/g, ' ').trim()
}

export interface NormalizeResult {
  /** The canonical value, or null when unresolved (caller keeps raw in notes). */
  value: string | null
  /** How it resolved — 'exact' | 'synonym' | null (unresolved). */
  method: 'exact' | 'synonym' | null
}

/** Tier 1: exact canonical match, then synonym table. Never guesses. */
export function normalizeEnumValue(field: string, raw: unknown): NormalizeResult {
  const vocab = ENUM_VOCABULARIES[field]
  if (!vocab || typeof raw !== 'string' || !raw.trim()) return { value: null, method: null }
  const c = canon(raw)
  if (vocab.canonical.includes(c)) return { value: c, method: 'exact' }
  // canonical values written with separators ("pre_approved" vs "pre approved")
  const underscored = c.replace(/[\s-]+/g, '_')
  if (vocab.canonical.includes(underscored)) return { value: underscored, method: 'exact' }
  const syn = vocab.synonyms[c]
  if (syn) return { value: syn, method: 'synonym' }
  return { value: null, method: null }
}

/**
 * Gate for tier-2 (AI) output: a proposed canonical value is accepted ONLY if it is
 * literally in the vocabulary. The AI matcher maps through this, so a hallucinated
 * or creative value can never reach a column.
 */
export function sanitizeEnumValue(field: string, proposed: unknown): string | null {
  const vocab = ENUM_VOCABULARIES[field]
  if (!vocab || typeof proposed !== 'string') return null
  const c = canon(proposed)
  return vocab.canonical.includes(c) ? c : null
}

/**
 * scoreToLeadTemperature — score (0–100) → CANONICAL lead_temperature.
 *
 * lead_temperature is a 3-band CHECK (hot/warm/cold) on contacts, leads, AND
 * communication_audit_log. The lead-pipeline urgency scale is 4-band (it adds 'cool'),
 * so a scorer that wrote its 4-band value straight into lead_temperature produced
 * 'cool' — which the CHECK constraint REJECTS, so the score update threw and the
 * score never persisted (silent for every mid-range 40–59 lead). This is the single
 * source for score→temperature so that can't happen: 'cool' collapses into 'cold'.
 */
export function scoreToLeadTemperature(score: number): 'hot' | 'warm' | 'cold' {
  if (score >= 70) return 'hot'
  if (score >= 45) return 'warm'
  return 'cold'
}

export interface RowEnumResult {
  /** field → canonical value (only resolved fields present). */
  resolved: Record<string, string>
  /** Audit lines for values that were TRANSFORMED (raw ≠ canonical). */
  transforms: string[]
  /** Pairs tier 1 could not resolve — candidates for the batched AI matcher. */
  unresolved: Array<{ field: string; raw: string }>
}

/** Run tier-1 normalization over every enum field present in a mapped import row. */
export function normalizeRowEnums(mapped: Record<string, unknown>): RowEnumResult {
  const resolved: Record<string, string> = {}
  const transforms: string[] = []
  const unresolved: Array<{ field: string; raw: string }> = []

  for (const field of NORMALIZABLE_ENUM_FIELDS) {
    const raw = mapped[field]
    if (typeof raw !== 'string' || !raw.trim()) continue
    const r = normalizeEnumValue(field, raw)
    if (r.value) {
      resolved[field] = r.value
      if (canon(raw) !== r.value) {
        transforms.push(`${field}: imported "${raw.trim()}" → "${r.value}"`)
      }
    } else {
      unresolved.push({ field, raw: raw.trim() })
    }
  }
  return { resolved, transforms, unresolved }
}
