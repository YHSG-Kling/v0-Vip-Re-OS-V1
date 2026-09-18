// lib/lead-pipeline/rental-graduation-sourcer.ts
//
// RENTAL-TO-BUYER GRADUATION (TENANT SIDE) — lane 74D, closing
// docs/lead-acquisition-coverage-2026-09.md item #24 ("Partial" — the
// landlord/seller half, `rental_listing`, sourced Craigslist `apa` listings
// since wave-pre-65; nothing ever followed the TENANT side: a renter already
// in the brokerage's own contacts/leases who is approaching the point where
// buying starts to look better than renewing).
//
// Owner ruling (task brief, 2026-09-18): "rental-to-buyer graduation is
// TENANT-side (renters in the tenant's own contacts/leases/renter portal
// whose lease end / tenure / income signals suggest buying → signal onto the
// CONTACT via manager signal to ai_isa, never a raw lead — same shape as
// contact_email_reengage)".
//
// THE GAP. This repo has no `leases` table live (scripts/schema-snapshot.ts
// carries no lease/rental-agreement relation at all — confirmed before
// writing this file, not assumed). What DOES exist, first-class, on
// `contacts`: `home_owner_status` ('renter' | 'owner' | …, the SAME
// vocabulary lib/ai-isa/persona-tool-policy.ts::resolveToolPersona already
// reads to route a renter to the RentCast-rental persona) and
// `length_of_residence` (free-text tenure, parsed by the ONE parser this
// repo has for it — lib/avm/provider-chain.ts::parseLengthOfResidence, reused
// here rather than re-derived, CLAUDE.md §6). There is no `lease_end_date`
// column anywhere live, so this lane does NOT claim to know when a lease
// expires — it uses TENURE as the honest proxy the owner's own phrasing
// ("lease end / tenure / income signals") lists as an alternative, not a
// substitute pretending to be the real date. A renter at or past
// RENTAL_GRADUATION_MIN_TENURE_YEARS has very likely faced at least one
// renewal decision already (typical U.S. residential leases run 12 months),
// which is the concrete, stated reasoning for the threshold below — not a
// fabricated lease-end date.
//
// INCOME: `contacts.funds_max_purchase` (a first-class buying-readiness
// column, m-era buyer-intake write — app/api/workflow/buyer-intake/
// submit/route.ts) and `contacts.household_income` (free-text band from
// enrichment) are read as OPTIONAL boost signals, never a gate — this repo
// has no established parser for a household_income band (unlike
// length_of_residence, which does), so no affordability number is invented
// from it; its mere presence is the honest claim ("income data is on file"),
// nothing stronger.
//
// CONTRACT: same shape as lib/lead-pipeline/email-engagement-sourcer.ts —
// `records` is ALWAYS empty (a renter already in `contacts` is never a raw
// lead) and the qualifying signal is routed directly onto the CONTACT via a
// manager signal (shopping_agent, who owns the buyer journey → ai_isa, who
// nurtures contacts), never through ingestRawSourceBatch/raw_scraped_leads.
// TERRITORY: bounded to the calling market's own brokerage (contacts are
// tenant-owned already; there is no "territory" for an existing contact).
// COOLDOWN: unlike email engagement (a fresh event burst each tick),
// home_owner_status/length_of_residence barely change tick to tick, so the
// bus's own "one open signal" dedupe alone would go silent forever the first
// time the ISA consumes it and then never re-signal even a year later. A
// direct RENTAL_GRADUATION_SIGNAL_COOLDOWN_DAYS read of `manager_signals`
// (regardless of open/consumed status) prevents both failure modes: no
// same-tick spam, and a real re-check every quarter.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedScrapedRecord } from './raw-record-types'
import { parseLengthOfResidence } from '@/lib/avm/provider-chain'
import { publishManagerSignal } from '@/lib/kernel/manager-signals'

type Svc = SupabaseClient<any, any, any>

/** A renter at or past this tenure (years, parsed from `length_of_residence`) has very likely
 *  already faced one lease-renewal decision — the concrete, stated reasoning for this number
 *  (typical U.S. residential leases run 12 months). NOT a lease_end_date — this repo has no such
 *  column live; see the file header.
 *  @proofSeam exported so scripts/rental-graduation-sourcer-simulator.ts can assert the bar
 *  directly — used in-file as sourceRentalToBuyerGraduation's default. */
export const RENTAL_GRADUATION_MIN_TENURE_YEARS = 0.8

/** How long a graduation signal for the SAME contact stays suppressed after it was last raised
 *  (regardless of whether the ISA already consumed it) — home_owner_status/length_of_residence
 *  barely change tick to tick, so without this a consumed signal would either never re-fire (if
 *  relying solely on the bus's "one OPEN signal" dedupe) or fire every 6h forever (if relying on
 *  nothing). A quarterly re-check is the reasoned middle: long enough that the ISA's last outreach
 *  is respected, short enough that a renter's situation is periodically reconsidered.
 *  @proofSeam exported for the simulator. */
export const RENTAL_GRADUATION_SIGNAL_COOLDOWN_DAYS = 90

const MAX_CANDIDATES_PER_RUN = 200

// Module-private (no external reader needs the shape by name — callers destructure
// sourceRentalToBuyerGraduation's return value directly).
interface RentalGraduationCandidate {
  contactId: string
  firstName: string | null
  lastName: string | null
  city: string | null
  state: string | null
  homeOwnerStatus: string | null
  lengthOfResidence: string | null
  householdIncome: string | null
  fundsMaxPurchase: number | string | null
}

/** PURE: turns one renter contact into a NormalizedScrapedRecord IF their tenure crosses the
 *  graduation bar. Returns null for a non-renter, a renter with unknown/short tenure, or a row
 *  missing the minimum a scrape record needs. Never invents a lease-end date or an income figure
 *  — see the file header for why. @proofSeam exported so
 *  scripts/rental-graduation-sourcer-simulator.ts can exercise the pure classification without a
 *  DB — called in-file by sourceRentalToBuyerGraduation, the live entry point
 *  app/api/cron/lead-scraping/route.ts calls. */
export function normalizeRentalGraduationSignal(
  c: RentalGraduationCandidate,
  opts: { minTenureYears?: number } = {},
): NormalizedScrapedRecord | null {
  const minTenureYears = opts.minTenureYears ?? RENTAL_GRADUATION_MIN_TENURE_YEARS
  const owner = (c.homeOwnerStatus ?? '').trim().toLowerCase()
  if (owner !== 'renter') return null

  const tenureYears = parseLengthOfResidence(c.lengthOfResidence)
  if (tenureYears === null || tenureYears < minTenureYears) return null

  const intentSignals = ['renter_tenure_threshold']
  const income = (c.householdIncome ?? '').trim()
  const fundsRaw = c.fundsMaxPurchase
  const funds = typeof fundsRaw === 'number' ? fundsRaw : Number(fundsRaw ?? NaN)
  if (income || (Number.isFinite(funds) && funds > 0)) intentSignals.push('income_signal_present')
  if (tenureYears >= minTenureYears * 2) intentSignals.push('long_tenure')

  return {
    sourceRecordId: `rental_graduation-${c.contactId}`,
    source: 'rental_to_buyer_graduation',
    behaviorType: 'rental_to_buyer_graduation',
    // Always buyer — a renter approaching a renewal decision is, by construction, a candidate
    // buyer, never a seller. Fair-Housing-safe: the ONLY input is the contact's own stated
    // home_owner_status + tenure, never a demographic.
    intentType: 'buyer',
    intentSignals,
    firstName: c.firstName,
    lastName: c.lastName,
    city: c.city,
    state: c.state,
    propertyAddress: null,
    motivationScore: null,
    rawPayload: {
      contactId: c.contactId,
      home_owner_status: c.homeOwnerStatus,
      length_of_residence: c.lengthOfResidence,
      tenure_years: tenureYears,
      min_tenure_years: minTenureYears,
      household_income_present: !!income,
      funds_max_purchase_present: Number.isFinite(funds) && funds > 0,
    },
  }
}

interface RentalGraduationSourceResult {
  /** ALWAYS empty — a renter already in `contacts` is never a raw lead (see the header). Kept in
   *  the shape only so callers written against the site_visitor_intent-family contract
   *  (records/cost/rowsExamined) need no special case. */
  records: NormalizedScrapedRecord[]
  /** Always 0 — first-party data already collected, no vendor call. */
  cost: number
  rowsExamined: number
  /** Contacts whose graduation signal was routed to the AI ISA this run. */
  contactsNotified: number
}

/** LIVE: reads `contacts` for ONE brokerage's renter contacts with tenure on file, gates each on
 *  the tenure bar + the per-contact cooldown, and for every qualifying, non-stopped contact
 *  publishes a manager signal (shopping_agent, who owns the buyer journey → ai_isa, who nurtures
 *  contacts) carrying the graduation signals — never a raw lead. Fails closed (empty result) on a
 *  refused read. */
export async function sourceRentalToBuyerGraduation(
  svc: Svc,
  brokerageId: string,
  opts: { minTenureYears?: number; cooldownDays?: number; now?: Date } = {},
): Promise<RentalGraduationSourceResult> {
  const minTenureYears = opts.minTenureYears ?? RENTAL_GRADUATION_MIN_TENURE_YEARS
  const cooldownDays = opts.cooldownDays ?? RENTAL_GRADUATION_SIGNAL_COOLDOWN_DAYS
  const now = opts.now ?? new Date()
  const cooldownStart = new Date(now.getTime() - cooldownDays * 24 * 3600_000).toISOString()

  const { data, error } = await svc
    .from('contacts')
    .select('id, first_name, last_name, city, state, home_owner_status, length_of_residence, household_income, funds_max_purchase, call_stop_flag')
    .eq('brokerage_id', brokerageId)
    .is('deleted_at', null)
    .eq('home_owner_status', 'renter')
    .not('length_of_residence', 'is', null)
    .limit(MAX_CANDIDATES_PER_RUN)

  if (error || !data) return { records: [], cost: 0, rowsExamined: 0, contactsNotified: 0 }

  let contactsNotified = 0
  for (const row of data as Array<{
    id: string; first_name: string | null; last_name: string | null; city: string | null; state: string | null
    home_owner_status: string | null; length_of_residence: string | null; household_income: string | null
    funds_max_purchase: number | string | null; call_stop_flag: boolean | null
  }>) {
    if (row.call_stop_flag) continue
    const rec = normalizeRentalGraduationSignal({
      contactId: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      city: row.city,
      state: row.state,
      homeOwnerStatus: row.home_owner_status,
      lengthOfResidence: row.length_of_residence,
      householdIncome: row.household_income,
      fundsMaxPurchase: row.funds_max_purchase,
    }, { minTenureYears })
    if (!rec) continue

    // Direct cooldown read — see the header for why the bus's own "one OPEN signal" dedupe is
    // not enough here (this signal's underlying facts barely change tick to tick).
    const { data: recent } = await svc
      .from('manager_signals')
      .select('id')
      .eq('brokerage_id', brokerageId)
      .eq('to_manager', 'ai_isa')
      .eq('signal_type', 'contact_rental_graduation_reengage')
      .eq('entity_id', row.id)
      .gte('created_at', cooldownStart)
      .limit(1)
      .maybeSingle()
    if (recent) continue

    const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'This renter contact'
    const res = await publishManagerSignal({
      brokerageId,
      fromManager: 'shopping_agent',
      toManager: 'ai_isa',
      signalType: 'contact_rental_graduation_reengage',
      message: `${name} has rented ${rec.rawPayload && (rec.rawPayload as any).tenure_years} years — a renewal decision is likely due; consider a buy-vs-renew touch.`,
      entityType: 'contact',
      entityId: row.id,
      contactId: row.id,
      payload: {
        intentSignals: rec.intentSignals,
        tenureYears: (rec.rawPayload as any).tenure_years,
        minTenureYears,
      },
      // The direct cooldown read above is the real guard; bus-level dedupe stays on too (harmless
      // — it only additionally protects against a same-tick double-publish race).
    }, svc)
    if (res.ok) contactsNotified++
  }

  return { records: [], cost: 0, rowsExamined: data.length, contactsNotified }
}
