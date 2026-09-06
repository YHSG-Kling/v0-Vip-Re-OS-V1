/**
 * lib/external/batchdata-seller-signals.ts
 *
 * A SECOND SELLER-SIGNAL SOURCE BESIDE PERMITS — and NOT a second lane.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Owner directive, verbatim: "we need to find another way to find out signs for
 * motivated sellers besides permits, maybe use our connection to batchdata?"
 *
 * lib/external/permit-signals.ts is the current seller-signal source and it has
 * a hard ceiling nobody can code around: a city building permit is only visible
 * where a city publishes one. That lane's registry covers a fixed list of
 * portals, and measured live on 2026-08-20 the tenant table it draws its markets
 * from (`lead_scraping_markets`) holds ZERO rows — so its coverage over the live
 * tenants is not "thin", it is empty, and no amount of work inside that lane
 * changes that. BatchData is national, address-keyed, and already connected
 * (lib/external/batchdata-client.ts, live consumer at lib/kernel/intent-campaign.ts:29).
 *
 * ── WHAT IT IS, AND THE LINE IT DOES NOT CROSS ───────────────────────────────
 * This is a SIGNAL lane, not a sourcing lane. It reads the leads AND CONTACTS
 * the brokerage ALREADY OWNS, looks each one's own address up at the provider,
 * and files what it finds into the ONE existing signal table —
 * `motivated_seller_signals`, the same table permit-signals writes and lead
 * scoring reads. It creates no lead, no contact, and no raw scraped record; lead
 * SOURCING belongs to lib/lead-pipeline and its consent/territory gates and is
 * untouched here.
 *
 * ── TWO BOARDS, ONE TABLE (2026-08-21) ───────────────────────────────────────
 * Owner ruling, verbatim: "motivated sellers source is for leads and contacts."
 * A homeowner does not stop being a possible seller the moment they become a
 * contact, and the contacts board is where an agent actually works.
 *
 * The table could not express that. It carried ONE entity column, `lead_id`, so
 * a contact could only be filed by putting a `contacts.id` into a column every
 * reader treats as `leads(id)` — a mistake this repo has already made and
 * tombstoned (app/actions/lead-intelligence.ts:2444). m517 adds `contact_id`
 * and a CHECK that exactly one of the two is set; `SignalEntityKind` below is
 * the discriminator that carries the answer through this lane.
 *
 * CONVERTED LEADS ARE EXCLUDED FROM THE LEAD SIDE, through the ONE conversion
 * guard (lib/contact-promotion/conversion-finality.ts `excludeConvertedLeads`),
 * never an inline predicate. `leads.contact_id` is a real FK to `contacts(id)`,
 * so after conversion the lead row and the contact row are one person at one
 * address; probing both would derive the same signals twice and lead scoring
 * COUNTS signals. The contact is the survivor.
 *
 * That direction — from OUR lead outward to the provider, never from the
 * provider's market inward — is what keeps the two apart, and it also removes
 * the class of error permit-signals spends a page refusing: there is no
 * market-wide row set to fuzzy-match against, because the query IS the lead's
 * address. The returned property is still checked for EXACT address-key equality
 * (the same `normalizeStreetAddress` the permit lane uses, so there is one
 * address vocabulary), because a provider that "helpfully" returns the nearest
 * match would otherwise attach a neighbour's foreclosure to our lead's record,
 * and every downstream score would then treat it as observed fact.
 *
 * ── FAIR HOUSING IS STRUCTURAL HERE, NOT ADVISORY ────────────────────────────
 * The provider sells a `demographics` dataset — age, gender, hasChildren,
 * singleParent, maritalStatus, recentlyDivorced, religiousAffiliation, income,
 * netWorth (32 fields, read live from its own catalogue on 2026-08-20) — in the
 * same request body and the same response row as the motivation data we want.
 * `min_owner_age: 70` is the same shape of edit as `min_sale_propensity: 70`.
 *
 * So every signal type below is DECLARED through `defineSellerSignalSources`
 * (lib/lead-governance/protected-class-signals.ts), which walks every field the
 * type names as its source AT MODULE LOAD.
 *
 * WHAT THAT CALL DOES CHANGED ON 2026-08-21 AND THIS PARAGRAPH IS THE
 * CORRECTION. It used to REFUSE: a signal sourced from `demographics.age`,
 * `senior-owner`, `inherited` or `min_household_income` made this module throw
 * on import. Owner ruling, verbatim — "do not run the compliance or fair
 * housing on scrapping, enrichment, scoring, sourcing" — removed that refusal
 * from the data lane, and the function is now a LABELLER: it accepts the spec
 * and attaches `protectedClassSources`, the classified subset of its own
 * sources, so a protected fact is VISIBLE at the declaration rather than
 * impossible at it. The refusal did not disappear; it moved to the place the
 * ruling left it — `assertAudienceSegmentationAllowed`, called from
 * lib/audiences/audience-sync.ts before any person is staged into an ad
 * audience. That file names the move at file:line.
 *
 * THIS LANE ADDS NO REFUSAL OF ITS OWN, on the same ruling. What it does keep
 * is honest: it declares every source it reads, so the classifier can label
 * them. Two integrity checks in that function still throw and are NOT
 * fair-housing: a duplicate `signalType` (how a repeating probe starts
 * duplicating rows) and an empty `sources` list (a signal that cannot be
 * classified or explained).
 *
 * ── FINDINGS #297 AND #304 (2026-08-22) — THE LAST REFUSAL, AND WHAT IT WAS
 *    BLOCKING ──────────────────────────────────────────────────────────────
 * Owner rulings, verbatim: "297 just release it from fairhousing.", "all
 * motivatied seller classifiers are necessary for data especially demographics
 * and protected class.", "304 needs inherited and probate."
 *
 * Until 2026-08-22 this file still carried ONE fair-housing refusal, in
 * `realBatchDataPropertyLookup`: it ran the outbound criteria through
 * `stripProtectedClassCriteria` and returned a REFUSED lookup if anything came
 * back removed. #297 released it. The gate is now
 * `screenProtectedClassCriteria(criteria, "data_sourcing")` — an explicit LANE
 * argument, no removal, and the protected criteria come back LABELLED with the
 * classifier's reason sentence. The ad-audience lane of that same function is
 * unchanged and still strips; see lib/lead-governance/protected-class-signals.ts.
 *
 * SO THIS LANE NOW SHIPS FOUR LABELLED SIGNAL TYPES, and that is the intended
 * state rather than a leak. `inherited_property` (#304), `senior_owner`,
 * `recent_divorce` and `household_outgrown` are each derived from a
 * protected-class source, each carries `protectedClassSources` from the
 * declaration gate, and each stored row carries `signal_details.protected_class_basis`
 * — the source AND the classifier's reason sentence — so an auditor reading the
 * table can tell exactly which signals came from protected-class data and on
 * what grounds. The other seventeen still declare zero labelled sources,
 * because they are parcel-and-transaction state, and the simulator asserts BOTH
 * halves of that split rather than either one alone.
 *
 * `redactProtectedClassFields`'s survivor `labelProtectedClassFields` still runs
 * over the stored row and REPORTS rather than refuses.
 * scripts/batchdata-seller-signal-simulator.ts carries the positive control in
 * both directions, and scripts/compliance-scope-simulator.ts proves the ads gate
 * still refuses the very same fields this lane now sources.
 *
 * ── ONE VOCABULARY ───────────────────────────────────────────────────────────
 * `signal_strength` is the four-value ladder owned by
 * lib/lead-governance/seller-signal-strength.ts — weak | moderate | strong |
 * urgent — and nothing here invents a competing number. (m500 made that a live
 * CHECK constraint; verified against project hrvaqgvukzxfskkcrwbt on
 * 2026-08-20.) The provider's own 0-100 sale-propensity score is READ as a
 * number and BANDED onto that ladder before storage; the raw number rides in
 * signal_details where a reader can see it, never in the strength column.
 *
 * Two of the ten signal types below are DELIBERATELY NOT NEW: `high_equity` and
 * `market_timing` are already written by app/actions/lead-intelligence.ts:1197
 * and :1180 for exactly these facts, with exactly these thresholds. A second
 * spelling of one idea is the defect CLAUDE.md §6 names, so this lane reuses
 * theirs rather than adding `equity_position` and `ownership_tenure` beside them.
 */

import { normalizeStreetAddress } from "./permit-signals"
import { excludeConvertedLeads } from "@/lib/contact-promotion/conversion-finality"
import type { SellerSignalStrength } from "@/lib/lead-governance/seller-signal-strength"
import {
  defineSellerSignalSources, screenProtectedClassCriteria, labelProtectedClassFields,
  protectedClassBasisBySignalType,
  type SellerSignalSourceSpec, type ProtectedClassBasis,
} from "@/lib/lead-governance/protected-class-signals"

// ─────────────────────────────────────────────────────────────────────────────
// THE SIGNAL TYPES — declared through the fair-housing gate
// ─────────────────────────────────────────────────────────────────────────────

export const SALE_PROPENSITY_SIGNAL_TYPE = "sale_propensity"
export const PREFORECLOSURE_SIGNAL_TYPE = "preforeclosure"
export const TAX_DELINQUENT_SIGNAL_TYPE = "tax_delinquent"
export const INVOLUNTARY_LIEN_SIGNAL_TYPE = "involuntary_lien"
export const VACANCY_SIGNAL_TYPE = "vacancy"
export const ABSENTEE_OWNER_SIGNAL_TYPE = "absentee_owner"
export const TIRED_LANDLORD_SIGNAL_TYPE = "tired_landlord"
export const LISTING_WITHDRAWN_SIGNAL_TYPE = "listing_withdrawn"
/** REUSED, not coined — app/actions/lead-intelligence.ts:1197 already writes it. */
export const HIGH_EQUITY_SIGNAL_TYPE = "high_equity"
/** REUSED, not coined — app/actions/lead-intelligence.ts:1180 already writes it
 *  for "Long-term ownership" at the same 120-month threshold. */
export const MARKET_TIMING_SIGNAL_TYPE = "market_timing"

// ── ADDED 2026-08-21, on the owner's second request for more motivated-seller
//    signs. Every one is a PROPERTY-AND-TRANSACTION-STATE fact from the same
//    quicklist catalogue the ten above are read from; each is declared through
//    the same gate and each is added to BATCHDATA_SIGNAL_TYPES, which is what
//    the m517 dedupe index is widened from. Declaring a kind without widening
//    the index is how a repeating probe starts duplicating (m499, m514, m517
//    are three files on that one lesson).
/** Demonstrated intent to sell with NO representation — the strongest actionable
 *  signal this lane can read, and the one an agent may lawfully approach. */
export const FSBO_SIGNAL_TYPE = "for_sale_by_owner"
export const BELOW_MARKET_LISTING_SIGNAL_TYPE = "listed_below_market"
export const CORPORATE_OWNED_SIGNAL_TYPE = "corporate_owned"
export const FIX_AND_FLIP_SIGNAL_TYPE = "fix_and_flip"
export const VACANT_LOT_SIGNAL_TYPE = "vacant_lot"
/**
 * TRUST-OWNED. Added after auditing this lane's coverage against the provider's
 * LIVE dataset catalogue rather than against memory: of the 38 `quickLists`
 * flags the provider publishes, this lane sourced 27, and `trustOwned` was the
 * one genuine motivated-seller signal among the eleven it did not.
 *
 * WHY IT IS NOT PROTECTED-CLASS, stated explicitly because the flag next to it
 * in the provider's catalogue IS. `tokenizeFieldPath("quickLists.trustOwned")`
 * yields ["quick","lists","trust","owned"] — no token in PROTECTED_CLASS_TOKENS.
 * It is a TITLE FACT read off a recorded deed: the grantee is a trust. Compare
 * `quickLists.inherited`, which IS banned ("inherited" is in the list under the
 * probate ruling), and `quickLists.seniorOwner`, banned on "senior". Those two
 * describe a PERSON's circumstances; this one describes how a parcel is held.
 *
 * WHY A TRUST SELLS: a trust is an instrument for holding and then DISTRIBUTING
 * an asset. Trustees have a duty to the beneficiaries, real estate is the least
 * divisible thing a trust can hold, and the ordinary way to divide it is to sell
 * it. That is a structural reason to transact, and it is legible from the deed
 * without knowing anything about who the beneficiaries are.
 */
export const TRUST_OWNED_SIGNAL_TYPE = "trust_owned"
/**
 * THE SUPPRESSION KIND — a row that argues AGAINST prospecting, filed in the
 * same table as the rows that argue for it.
 *
 * The provider flags a property already on the market. Soliciting a seller who
 * is already under an exclusive agreement with another broker is an NAR Code of
 * Ethics Article 16 problem, not just a wasted call, so the fact is STORED
 * where an agent and a scorer can both see it rather than dropped.
 * lib/lead-governance/seller-signal-strength.ts names it in
 * SUPPRESSION_SELLER_SIGNAL_TYPES and excludes it from the strong-signal count,
 * because a row meaning "leave this person alone" must never be able to push a
 * prospecting score up.
 */
export const ACTIVE_LISTING_SIGNAL_TYPE = "active_listing"

// ─────────────────────────────────────────────────────────────────────────────
// ADDED 2026-08-22 — THE FOUR THAT ARE DERIVED FROM PROTECTED-CLASS SOURCES
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner rulings, verbatim: "304 needs inherited and probate.", "all motivatied
// seller classifiers are necessary for data especially demographics and
// protected class.", "297 just release it from fairhousing."
//
// These four are the first signal types in this lane that the classifier labels
// PROTECTED. That is not a leak — it is the ruling. What makes it safe is that
// the classification did not weaken: `PROTECTED_CLASS_TOKENS` still contains
// "inherited", "probate", "heir", "deceased", "senior", "divorce", "child" and
// "household", and `PROTECTED_CLASS_NAMESPACES` still covers the whole
// `demographic` dataset. The ad-audience gate reads that same vocabulary and
// still REFUSES every one of these. Sourced here, labelled here, refused there.
//
// THE CONSERVATISM DOCTRINE APPLIES TO THESE EXACTLY AS IT DOES TO THE OTHERS.
// A fact true of a large fraction of all homes produces no row, because lead
// scoring COUNTS rows and a signal that fires for everybody is a constant. That
// is why `senior_owner` bands the bare flag at "weak" and reserves "moderate"
// for a measured age, and why household composition is read as OVERCROWDING
// against the parcel's own bedroom count rather than as "has children" — roughly
// 40% of US households have a child under 18, so `demographics.hasChildren`
// alone would be a constant wearing a signal's costume.

/**
 * INHERITED / PROBATE — finding #304, the owner's explicit ask.
 *
 * ONE TYPE FOR BOTH WORDS, DELIBERATELY (CLAUDE.md §6). The owner said
 * "inherited and probate"; the provider publishes ONE surface for them. Read
 * live from BatchData's own catalogue on 2026-08-22:
 *   · `list_property_dataset_fields quicklist` → 39 entries, one of which is
 *     `quickLists.inherited`. There is NO field, filter or quickList slug named
 *     "probate" anywhere in the provider's catalogue — not in quicklist, not in
 *     deed, not in foreclosure, not in core.
 *   · the search API's `quicklist` enum lists `inherited` and has no probate
 *     member either.
 * So `quickLists.inherited` IS the provider's probate list. The corroborating
 * evidence is the DEED INSTRUMENT: a probate transfer is recorded as a personal
 * representative's / executor's / administrator's deed, which arrives in
 * `deedHistory.documentType` and `sale.lastSale.documentType`. Coining a second
 * `probate` signal type beside this one would be the six-spellings defect that
 * CLAUDE.md §6 names, with the added problem that nothing would ever write it.
 */
export const INHERITED_SIGNAL_TYPE = "inherited_property"

/**
 * SENIOR OWNER — life-stage. `quickLists.seniorOwner` and `demographics.age`.
 *
 * This is the exact fact the owner's standing scope ruling was about: "we
 * determine the kind of education in channels by the age group". It is sourced
 * and stored so lib/agents/education-delivery-producer.ts can band it; it may
 * never choose who sees an ad.
 */
export const SENIOR_OWNER_SIGNAL_TYPE = "senior_owner"

/**
 * RECENT DIVORCE — `demographics.recentlyDivorced`.
 *
 * A dissolution divides an indivisible asset, and the ordinary way to divide a
 * house is to sell it. Among the highest-motivation seller circumstances there
 * is, and the reason the deleted OSINT lane kept trying to infer it from
 * scraped court records — a generated sentence no field-name classifier could
 * ever label (the tombstone at app/actions/lead-intelligence.ts:2444). Read as
 * a declared provider FIELD it is labellable, which is what makes storing it
 * auditable rather than merely possible.
 */
export const RECENT_DIVORCE_SIGNAL_TYPE = "recent_divorce"

/**
 * HOUSEHOLD OUTGROWN — household size measured AGAINST THE PARCEL's bedroom
 * count, never household composition on its own.
 *
 * `demographics.householdSize` is a person-fact and is classified protected on
 * the token "household". `building.bedroomCount` is a parcel fact. The SIGNAL
 * is the relation between them: a household larger than the house can seat is a
 * household with a structural reason to move. Reading either side alone would
 * produce a constant (see the doctrine note above).
 */
export const HOUSEHOLD_OUTGROWN_SIGNAL_TYPE = "household_outgrown"

/**
 * EVERY signal type this lane may write, with the EXACT provider field paths it
 * is derived from. Field paths were read live from the provider's own dataset
 * catalogue on 2026-08-20 (`list_property_dataset_fields` for core, quicklist,
 * batchrank, foreclosure, mortgage-liens, valuation, listing).
 *
 * `defineSellerSignalSources` gates every one of these strings at module load.
 * That call is the enforcement; this array is the thing enforced.
 */
export const BATCHDATA_SELLER_SIGNAL_SOURCES: readonly SellerSignalSourceSpec[] =
  defineSellerSignalSources([
    {
      signalType: SALE_PROPENSITY_SIGNAL_TYPE,
      label: "Sale propensity",
      sources: ["intel.salePropensity", "intel.salePropensityCategory", "min_sale_propensity"],
      why: "The provider's purpose-built probability-of-sale model, 0-100. It is a prediction about a TRANSACTION, trained on transaction history — the single most direct answer to 'is this property likely to sell', and the reason this lane exists at all.",
    },
    {
      signalType: PREFORECLOSURE_SIGNAL_TYPE,
      label: "Foreclosure filing",
      sources: [
        "quickLists.preforeclosure", "quickLists.noticeOfDefault", "quickLists.noticeOfLisPendens",
        "quickLists.noticeOfSale", "quickLists.activeAuction",
        "foreclosure.status", "foreclosure.auctionDate", "foreclosure.recordingDate",
        "foreclosure.caseNumber", "foreclosure.documentNumber",
      ],
      why: "A recorded legal proceeding against the PROPERTY with a public filing date and, at auction stage, a public sale date. Dated, verifiable, and the strongest non-speculative reason a sale is coming.",
    },
    {
      signalType: TAX_DELINQUENT_SIGNAL_TYPE,
      label: "Property tax delinquency",
      sources: ["tax.taxDelinquentYear", "tax.taxYear", "quickLists.taxDefault", "min_tax_delinquent_year"],
      why: "Unpaid property tax is a public assessor record attached to the parcel. Multiple delinquent years is carrying cost the owner has stopped paying — pressure on the property, not a judgement about the person.",
    },
    {
      signalType: INVOLUNTARY_LIEN_SIGNAL_TYPE,
      label: "Involuntary lien",
      sources: [
        "quickLists.involuntaryLien", "involuntaryLien.liens.lienType",
        "involuntaryLien.liens.lienAmount", "involuntaryLien.liens.filingDate",
        "involuntaryLien.liens.documentNumber",
        "openLien.totalOpenLienCount", "openLien.totalOpenLienBalance",
        "involuntary_lien_type", "min_total_open_lien_count", "min_total_open_lien_balance",
      ],
      why: "A tax, mechanic, HOA or judgment lien is filed AGAINST THE PARCEL by a third party and clouds title. It must be cleared to sell, which is why an owner carrying one talks to an agent.",
    },
    {
      signalType: VACANCY_SIGNAL_TYPE,
      label: "Vacancy",
      sources: ["general.vacant", "quickLists.vacant", "general.mailingAddressVacant", "quickLists.mailingAddressVacant"],
      why: "A vacant home is carrying cost with no occupant and no income. USPS-derived and recorded against the address.",
    },
    {
      signalType: ABSENTEE_OWNER_SIGNAL_TYPE,
      label: "Absentee owner",
      sources: [
        "quickLists.absenteeOwner", "quickLists.absenteeOwnerOutOfState",
        "quickLists.absenteeOwnerInState", "quickLists.outOfStateOwner",
        "owner.ownerOccupied", "owner.mailingAddress.state",
      ],
      why: "The owner's mailing address is not the property's. A comparison of two recorded ADDRESSES — it says where mail goes, and nothing whatsoever about who the owner is.",
    },
    {
      signalType: TIRED_LANDLORD_SIGNAL_TYPE,
      label: "Tired landlord",
      sources: ["quickLists.tiredLandlord"],
      why: "The provider's own composite over long-held non-owner-occupied rentals. A property-holding pattern, and a well-understood listing trigger.",
    },
    {
      signalType: LISTING_WITHDRAWN_SIGNAL_TYPE,
      label: "Listing withdrawn unsold",
      sources: [
        "quickLists.expiredListing", "quickLists.canceledListing", "quickLists.failedListing",
        "listing.failedListingDate", "listing.status", "listing.statusCategory",
        "listing.daysOnMarket", "listing.originalListingDate", "min_days_on_market",
      ],
      why: "The owner ALREADY tried to sell and it did not complete. Demonstrated intent, evidenced by a real MLS record rather than inferred from anything.",
    },
    {
      signalType: HIGH_EQUITY_SIGNAL_TYPE,
      label: "Equity position",
      sources: [
        "valuation.equityPercent", "valuation.equityCurrentEstimatedBalance", "valuation.estimatedValue",
        "quickLists.highEquity", "quickLists.freeAndClear", "min_equity_percent", "max_equity_percent",
      ],
      why: "Equity is the CAPACITY to transact — a seller underwater usually cannot move even when they want to. Computed from the parcel's assessed value and its recorded open liens.",
    },
    {
      signalType: MARKET_TIMING_SIGNAL_TYPE,
      label: "Ownership tenure",
      sources: [
        "intel.lengthOfResidenceYears", "intel.lengthOfResidenceMonths",
        "owner.lengthOfResidenceYears", "owner.ownershipStartDate",
        "min_length_of_residence_years",
      ],
      why: "Years since the recorded ownership start date. Tenure past the typical holding period is when a move becomes statistically likely — a date arithmetic on a deed, carrying no information about the owner.",
    },
    {
      signalType: FSBO_SIGNAL_TYPE,
      label: "For sale by owner",
      sources: ["quickLists.forSaleByOwner", "listing.status", "listing.statusCategory"],
      why: "The owner has PUBLICLY LISTED the property themselves and is not represented. Demonstrated intent to sell, evidenced by a live listing rather than inferred, and the one on-market state an agent may lawfully approach — Article 16's prohibition is on soliciting a seller already subject to another broker's exclusive agreement, which by definition an unrepresented seller is not.",
    },
    {
      signalType: BELOW_MARKET_LISTING_SIGNAL_TYPE,
      label: "Listed below market",
      sources: [
        "quickLists.listedBelowMarketPrice", "listing.listPrice", "listing.status",
        "valuation.estimatedValue",
      ],
      why: "The asking price sits under the provider's own valuation of the parcel. A price is a transaction term, publicly published, and a seller pricing under the model is a seller optimising for SPEED — the definition of motivation, read off the listing rather than guessed about the person.",
    },
    {
      signalType: CORPORATE_OWNED_SIGNAL_TYPE,
      label: "Corporate owner",
      sources: ["quickLists.corporateOwned", "owner.ownerOccupied"],
      why: "Title is held by an entity rather than a natural person. An entity has no residence to be attached to and disposes of assets on a schedule — and, being an entity, it has no protected class to be profiled on at all.",
    },
    {
      signalType: TRUST_OWNED_SIGNAL_TYPE,
      label: "Held in trust",
      sources: ["quickLists.trustOwned", "deedHistory.documentType", "deedHistory.buyers"],
      why: "Title is vested in a TRUST — a recorded fact about the grantee on a public deed, not a fact about a person. A trust exists to hold an asset and eventually distribute it, and real property is the least divisible thing it can hold, so the ordinary route to distribution is a sale. It stays sourced from the deed alone and NOT from quickLists.inherited — not because inherited is refused (finding #297 released that on 2026-08-22 and inherited_property below now sources it), but because they are two different facts: this one is legible without knowing anything about the beneficiaries, and collapsing them would lose that distinction and put a protected-class label on a title fact that does not carry one.",
    },
    {
      signalType: FIX_AND_FLIP_SIGNAL_TYPE,
      label: "Fix and flip",
      sources: ["quickLists.fixAndFlip"],
      why: "The provider's composite over recently-acquired properties held for resale. An owner whose whole purpose for the parcel is to sell it again is a seller with a date on it — a HOLDING PATTERN, not a personal circumstance.",
    },
    {
      signalType: VACANT_LOT_SIGNAL_TYPE,
      label: "Vacant lot",
      sources: ["quickLists.vacantLot", "general.propertyTypeCategory"],
      why: "Unimproved land: carrying cost, property tax and no use. The recorded parcel classification, and one of the most commonly-transacted holdings once an owner stops planning to build.",
    },
    {
      signalType: ACTIVE_LISTING_SIGNAL_TYPE,
      label: "Already listed with a broker (SUPPRESSION)",
      sources: [
        "quickLists.activeListing", "quickLists.onMarket", "quickLists.pendingListing",
        "quickLists.forSaleByOwner", "listing.status", "listing.statusCategory",
      ],
      why: "SUPPRESSION, not motivation. The property is on the market and NOT for sale by owner, so a listing broker holds the representation. This is filed so an agent and a scorer can both see the reason NOT to pitch — NAR Code of Ethics Article 16. `quickLists.forSaleByOwner` is named as a source because it is what DISQUALIFIES the suppression: an unrepresented seller is not somebody else's client.",
    },

    // ── THE FOUR PROTECTED-CLASS-DERIVED TYPES (findings #297 / #304) ───────
    // Every source string below was read live from BatchData's own catalogue on
    // 2026-08-22 — `list_property_datasets` plus `list_property_dataset_fields`
    // for quicklist (39 entries), demographic (32), deed (27) and core (258),
    // and the property-search criteria enum for the filter names. None of them
    // is remembered or guessed.
    //
    // Each is CLASSIFIED PROTECTED by defineSellerSignalSources and comes back
    // carrying `protectedClassSources`. That label is what
    // BATCHDATA_PROTECTED_CLASS_BASIS turns into the stored
    // `signal_details.protected_class_basis`.
    {
      signalType: INHERITED_SIGNAL_TYPE,
      label: "Inherited / probate",
      sources: [
        "quickLists.inherited",
        "deedHistory.documentType", "deedHistory.documentTypeCode",
        "sale.lastSale.documentType",
      ],
      why: "OWNER RULING #304, verbatim: '304 needs inherited and probate'. `quickLists.inherited` is the provider's probate list — its catalogue publishes no field, filter or slug named 'probate' at all — and the deed document type carries the recorded probate INSTRUMENT (personal representative's, executor's, administrator's deed, affidavit of death). Heirs are the archetypal motivated seller: they hold an asset they did not choose, usually at a distance, usually alongside co-heirs, and usually with carrying cost running. CLASSIFIED PROTECTED and sourced anyway: 'inherited' is a familial-status proxy — the fact it encodes is a death in a family — so the row carries its protected_class_basis and the ad-audience gate still refuses to segment on it.",
    },
    {
      signalType: SENIOR_OWNER_SIGNAL_TYPE,
      label: "Senior owner",
      sources: [
        "quickLists.seniorOwner", "demographics.age",
        "min_owner_age", "max_owner_age",
      ],
      why: "Life-stage. Downsizing, moving nearer family and moving into care are among the most common reasons a long-held home reaches the market, and none of them is legible from the parcel. CLASSIFIED PROTECTED on 'age' and 'senior' and sourced under the owner's standing ruling — 'we determine the kind of education in channels by the age group and other ways to use it without violating the rules' — which is exactly what this row feeds: lib/agents/education-delivery-producer.ts reads a BAND, never the raw age, and the ad-audience gate refuses it outright.",
    },
    {
      signalType: RECENT_DIVORCE_SIGNAL_TYPE,
      label: "Recent divorce",
      sources: ["demographics.recentlyDivorced", "demographics.maritalStatus"],
      why: "A dissolution has to divide an asset that cannot be divided, and the ordinary route is a sale — frequently a court-ordered one with a date on it. CLASSIFIED PROTECTED on 'divorce' and 'marital' (marital status is protected by statute in many of our markets) and sourced under the wave-15 and #297 rulings. Read as a DECLARED PROVIDER FIELD, which is what makes it labellable at all: the deleted OSINT lane tried to infer the same fact from scraped court text and produced it as a generated sentence no field-name classifier could ever label (tombstone at app/actions/lead-intelligence.ts:2444).",
    },
    {
      signalType: HOUSEHOLD_OUTGROWN_SIGNAL_TYPE,
      label: "Household outgrown the home",
      sources: [
        "demographics.householdSize", "demographics.childCount", "demographics.hasChildren",
        "building.bedroomCount", "has_children",
      ],
      why: "The household is larger than the parcel can seat. This is a RELATION between a person-fact and a parcel-fact, and it is deliberately not either one alone: about 40% of US households include a child, so `demographics.hasChildren` on its own fires for a huge fraction of all homes and a signal that fires for everybody is a constant, not a signal. CLASSIFIED PROTECTED on 'household' and 'child' — familial status, 42 U.S.C. § 3604 — and sourced under #297; the ad-audience gate refuses every one of these fields.",
    },
  ] as const)

/** Every signal_type this lane writes — the set the idempotency read and the
 *  m514 unique index cover. Adding a kind above without adding it to the index
 *  is how a repeating probe starts duplicating (the defect m499 fixed for the
 *  permit lane, arriving here for the same reason). */
export const BATCHDATA_SIGNAL_TYPES: readonly string[] =
  BATCHDATA_SELLER_SIGNAL_SOURCES.map((s) => s.signalType)

/**
 * signal_type → the protected-class sources it is derived from, each with the
 * classifier's REASON SENTENCE. Computed from the declaration above, never
 * hand-written.
 *
 * THIS IS THE HONESTY HALF OF FINDING #297. The ruling released the refusal on
 * this lane; it did not release the record-keeping, and a lane that stores a
 * protected-class-derived fact without saying so leaves an auditor no way to
 * find it afterwards. `buildBatchDataSignalRow` writes the entry for each
 * signal's own type into `signal_details.protected_class_basis`, so the
 * provenance is ON THE ROW rather than only in this file — a row outlives the
 * code that wrote it.
 *
 * DERIVED, NOT DECLARED, and that is the whole safety property. A future author
 * who adds a protected source to any spec above gets the stored provenance for
 * free and cannot forget it; one who removes the last protected source stops
 * writing a basis that is no longer true. There is no second list to keep in
 * step (CLAUDE.md §6).
 *
 * Absent key = that signal type is derived purely from parcel-and-transaction
 * state. Seventeen of the twenty-one are.
 */
export const BATCHDATA_PROTECTED_CLASS_BASIS: Readonly<Record<string, readonly ProtectedClassBasis[]>> =
  Object.freeze(protectedClassBasisBySignalType(BATCHDATA_SELLER_SIGNAL_SOURCES))

/** `detected_via` — the provider. Matches the connector id used by
 *  lib/agentic-os/connector-gateway and by app/actions/lead-intelligence.ts:1188. */
export const BATCHDATA_DETECTED_VIA = "batchdata"

// ─────────────────────────────────────────────────────────────────────────────
// PURE — tolerant readers over one provider property row
// ─────────────────────────────────────────────────────────────────────────────

/** PURE. Dotted-path read. Returns undefined rather than throwing on a gap. */
export function at(row: unknown, path: string): unknown {
  let node: any = row
  for (const key of path.split(".")) {
    if (node === null || node === undefined) return undefined
    node = node[key]
  }
  return node
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[$,%\s,]/g, ""))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * PURE. Read one quickList flag.
 *
 * TWO WIRE SHAPES, BOTH REAL, and this is a live defect in the neighbouring
 * file. The provider's Property Search returns `quickLists` as an OBJECT of
 * camelCase booleans — confirmed from its own field catalogue on 2026-08-20:
 * `quickLists.preforeclosure`, `quickLists.tiredLandlord`, 39 fields — and
 * lib/external/batchdata-client.ts:394 reads it that way. But
 * `normalizeBatchDataProperty` at lib/external/batchdata-client.ts:181 reads the
 * SAME field as `Array.isArray(p.quickLists)` and produces `undefined` for every
 * object-shaped response. One file, two beliefs about one field. This reader
 * accepts both shapes rather than picking a side it cannot prove for every
 * endpoint, and the disagreement is reported rather than silently worked around.
 */
export function readQuickList(row: unknown, camelName: string): boolean {
  const ql = at(row, "quickLists") ?? at(row, "quick_lists")
  if (ql && typeof ql === "object" && !Array.isArray(ql)) {
    return (ql as Record<string, unknown>)[camelName] === true
  }
  const kebab = camelName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
  const list: unknown[] = Array.isArray(ql) ? ql : Array.isArray(at(row, "tags")) ? (at(row, "tags") as unknown[]) : []
  return list.some((v) => typeof v === "string" && (v === camelName || v.toLowerCase() === kebab))
}

/** PURE. The provider's 0-100 probability-of-sale score, or null when absent. */
export function readSalePropensity(row: unknown): number | null {
  const n = num(at(row, "intel.salePropensity"))
  if (n === null) return null
  // Refuse an out-of-range value rather than banding it. A score outside 0-100
  // is a shape change at the provider, and banding it would launder that into a
  // confident-looking signal.
  return n >= 0 && n <= 100 ? n : null
}

/** PURE. Equity as a percentage 0-100, or null. */
export function readEquityPercent(row: unknown): number | null {
  const direct = num(at(row, "valuation.equityPercent"))
  if (direct !== null && direct >= 0 && direct <= 100) return direct
  const equity = num(at(row, "valuation.equityCurrentEstimatedBalance"))
  const value = num(at(row, "valuation.estimatedValue"))
  if (equity === null || value === null || value <= 0) return null
  const pct = (equity / value) * 100
  return pct >= 0 && pct <= 100 ? Math.round(pct) : null
}

/** PURE. Whole years the current owner has held the property, or null. */
export function readTenureYears(row: unknown, todayIso?: string): number | null {
  const years = num(at(row, "intel.lengthOfResidenceYears")) ?? num(at(row, "owner.lengthOfResidenceYears"))
  if (years !== null && years >= 0) return Math.floor(years)
  const months = num(at(row, "intel.lengthOfResidenceMonths")) ?? num(at(row, "owner.lengthOfResidenceMonths"))
  if (months !== null && months >= 0) return Math.floor(months / 12)
  const start = at(row, "owner.ownershipStartDate")
  if (typeof start === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(start)
    const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(todayIso ?? "")
    if (m && t) {
      let y = Number(t[1]) - Number(m[1])
      if (Number(t[2]) < Number(m[2]) || (t[2] === m[2] && Number(t[3]) < Number(m[3]))) y--
      return y >= 0 ? y : null
    }
  }
  return null
}

/** PURE. The most recent delinquent tax year, or null. */
export function readTaxDelinquentYear(row: unknown): number | null {
  const y = num(at(row, "tax.taxDelinquentYear"))
  // A four-digit year or nothing. `0` is the provider's "not delinquent", and
  // treating it as year zero would file every clean parcel as decades overdue.
  return y !== null && y >= 1900 && y <= 2200 ? y : null
}

export interface LienReading {
  count: number | null
  balance: number | null
  types: string[]
  /** Filing handle of the most identifiable lien, for dedupe. */
  handle: string | null
}

/** PURE. The property's open involuntary-lien position. */
export function readLiens(row: unknown): LienReading {
  const liens = at(row, "involuntaryLien.liens")
  const arr: any[] = Array.isArray(liens) ? liens : []
  const types = [...new Set(arr.map((l) => l?.lienType).filter((t): t is string => typeof t === "string" && !!t.trim()))]
  const handleParts = arr
    .map((l) => (typeof l?.documentNumber === "string" && l.documentNumber) || (typeof l?.filingDate === "string" && l.filingDate) || null)
    .filter((h): h is string => !!h)
    .sort()
  return {
    count: num(at(row, "openLien.totalOpenLienCount")) ?? (arr.length > 0 ? arr.length : null),
    balance: num(at(row, "openLien.totalOpenLienBalance")),
    types,
    handle: handleParts.length > 0 ? handleParts.join("+").slice(0, 120) : null,
  }
}

export interface ForeclosureReading {
  /** The furthest stage the record proves. Null when nothing foreclosure-shaped. */
  stage: "auction" | "notice_of_sale" | "lis_pendens" | "notice_of_default" | "preforeclosure" | null
  auctionDate: string | null
  status: string | null
  /** Stable handle for this filing: case number, else document number, else recording date. */
  handle: string | null
}

/**
 * PURE. The property's foreclosure position, read STAGE-FIRST.
 *
 * The stages are ordered because they are a real sequence and the provider can
 * flag several at once: a property at auction is still, truthfully, in
 * preforeclosure. Reading "the first true flag" in declaration order would let
 * an auction with a date read as a generic preforeclosure and lose the only
 * fact in the record that carries a deadline.
 */
export function readForeclosure(row: unknown): ForeclosureReading {
  const stage: ForeclosureReading["stage"] =
    readQuickList(row, "activeAuction") ? "auction"
    : readQuickList(row, "noticeOfSale") ? "notice_of_sale"
    : readQuickList(row, "noticeOfLisPendens") ? "lis_pendens"
    : readQuickList(row, "noticeOfDefault") ? "notice_of_default"
    : readQuickList(row, "preforeclosure") ? "preforeclosure"
    : null
  const str = (p: string) => { const v = at(row, p); return typeof v === "string" && v.trim() ? v.trim() : null }
  const auctionRaw = str("foreclosure.auctionDate")
  const auctionDate = auctionRaw ? (/^(\d{4}-\d{2}-\d{2})/.exec(auctionRaw)?.[1] ?? null) : null
  return {
    stage,
    auctionDate,
    status: str("foreclosure.status"),
    handle: str("foreclosure.caseNumber") ?? str("foreclosure.documentNumber") ?? str("foreclosure.recordingDate"),
  }
}

/**
 * The recorded deed instruments that mean A DEATH MOVED THIS TITLE.
 *
 * These are DEED DOCUMENT TYPES, not marketing words: each is the name a county
 * recorder puts on the instrument by which a decedent's real property passes.
 * `deedHistory.documentType` and `sale.lastSale.documentType` are free-text
 * strings that vary by county, so this matches on lowercase SUBSTRING rather
 * than exact equality — "Personal Representative's Deed", "PERSONAL REP DEED"
 * and "Deed of Personal Representative" are the same instrument in three
 * counties' spellings, and an exact list would have to be per-county forever.
 *
 * SUBSTRING IS SAFE HERE AND IS NOT SAFE IN THE CLASSIFIER, which is worth
 * stating because the two live in the same lane and the distinction has already
 * cost this repo time. `protectedClassReasonFor` matches WHOLE TOKENS because a
 * substring "age" is inside `mortgageHistory`. This list matches substrings
 * because every entry is a multi-word phrase with no shorter word inside it that
 * names something else: "warranty deed", "quit claim", "grant deed" and
 * "trustee's deed" contain none of them. The simulator holds that as a control.
 *
 * "estate" is DELIBERATELY ABSENT. "Real Estate Deed" and "Estate of ..." are
 * both common, the first names no death at all, and it is the one entry that
 * would turn this list into a substring trap.
 */
export const PROBATE_DEED_DOCUMENT_TERMS: readonly string[] = [
  "personal representative", "personal rep deed", "executor", "executrix",
  "administrator", "administratrix", "probate", "affidavit of death",
  "affidavit of heirship", "transfer on death", "beneficiary deed",
]

/**
 * PURE. The probate deed instrument recorded against this parcel, or null.
 *
 * Reads the deed dataset first and the core `sale.lastSale` block second, and
 * returns the MATCHED PHRASE rather than a boolean so the stored row can say
 * which instrument it saw. Both paths were read live from the provider's own
 * catalogue on 2026-08-22 (`deed` → 27 fields, `core` → 258).
 *
 * ── WHY THIS AND ITS TWO SIBLINGS ARE EXPORTED WITH NO PRODUCT CALLER ────────
 * `readProbateDeedInstrument`, `readOwnerAge` and `readHouseholdPressure` are
 * used in-file by `deriveSellerSignals` and asserted individually by
 * scripts/batchdata-seller-signal-simulator.ts. Nothing in app/ or lib/ calls
 * them, and nothing should: each takes a RAW BATCHDATA PROVIDER ROW, and this
 * module is the only place in the repo that ever holds one. The product-facing
 * surface is `ingestBatchDataSellerSignals` / `realBatchDataPropertyLookup`.
 *
 * That is why `scripts/orphan-export-baseline.json` carries 17 rather than 14
 * for this file. The alternative was to stop exporting them and drive the proofs
 * through `deriveSellerSignals`, which is STRICTLY WEAKER: a household reading
 * with no bedroom count emits no signal at all, so "measured, not overcrowded"
 * and "never read" become the same observation. Losing that distinction to move
 * a number is the trade CLAUDE.md §1 forbids in the other direction, and it is
 * no better here.
 *
 * WHAT WOULD RETIRE THE EXEMPTION — and it is a real open loop, not a shrug.
 * These readers write `signal_details.observed.owner_age_band`,
 * `probate_deed_instrument` and `household_size`, and NOTHING READS THOSE YET.
 * The owner's stated purpose for sourcing this data at all is to pick an
 * education channel by age group; the selector that should consume it,
 * lib/agents/education-delivery-producer.ts, still bands from
 * `contacts.age_range` on a different vocabulary. Wiring that is the missing
 * half (CLAUDE.md §1 — build it). Note it would NOT reference these readers
 * either, so it does not change this count; it closes the writerless-column
 * gap, which is the defect that actually matters.
 */
export function readProbateDeedInstrument(row: unknown): string | null {
  for (const path of ["deedHistory.documentType", "sale.lastSale.documentType"]) {
    const raw = at(row, path)
    // deedHistory can arrive as an ARRAY of deeds (a history) or as one object
    // flattened to its latest entry. Both shapes are read; neither is assumed.
    const candidates = Array.isArray(raw) ? raw : [raw]
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || !candidate.trim()) continue
      const lower = candidate.toLowerCase()
      const hit = PROBATE_DEED_DOCUMENT_TERMS.find((t) => lower.includes(t))
      if (hit) return candidate.trim()
    }
  }
  return null
}

/**
 * PURE. The owner's age as the provider reports it, or null.
 *
 * PROTECTED-CLASS READ, and it exists so the value can be BANDED before it is
 * stored (lib/agents/education-delivery-producer.ts reads a band, never a raw
 * age). Range-checked rather than trusted: an age outside 18-120 is a provider
 * shape change, and banding it would launder that into a confident signal — the
 * same refusal `readSalePropensity` makes about an out-of-range score.
 */
export function readOwnerAge(row: unknown): number | null {
  const n = num(at(row, "demographics.age"))
  if (n === null) return null
  return n >= 18 && n <= 120 ? Math.floor(n) : null
}

/**
 * PURE. Household size measured against the parcel's own bedroom count.
 *
 * Returns both numbers and the verdict, because "we could not read one of them"
 * and "they were read and the house is big enough" must not look the same to
 * the caller. `overcrowded` is true only when BOTH sides were read.
 *
 * THE THRESHOLD IS size > bedrooms + 1, and the +1 is the couple. Two people in
 * a one-bedroom is the ordinary case, not a signal; four people in a
 * two-bedroom is a household with a structural reason to move. Reading it as
 * `size > bedrooms` would fire on every couple in the country — the constant
 * this lane's doctrine refuses to file.
 */
export function readHouseholdPressure(row: unknown): {
  householdSize: number | null
  bedroomCount: number | null
  overcrowded: boolean
} {
  const rawSize = num(at(row, "demographics.householdSize"))
  const householdSize = rawSize !== null && rawSize >= 1 && rawSize <= 20 ? Math.floor(rawSize) : null
  const rawBeds = num(at(row, "building.bedroomCount"))
  const bedroomCount = rawBeds !== null && rawBeds >= 0 && rawBeds <= 50 ? Math.floor(rawBeds) : null
  return {
    householdSize,
    bedroomCount,
    overcrowded: householdSize !== null && bedroomCount !== null && householdSize > bedroomCount + 1,
  }
}

/** PURE. The property address the provider actually returned, or null. */
export function readProviderAddress(row: unknown): string | null {
  const street = at(row, "address.street") ?? at(row, "address.formattedStreet") ?? at(row, "address.streetNoUnit")
  return typeof street === "string" && street.trim() ? street.trim() : null
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — strength banding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The strength levels THIS LANE emits — the full four-value ladder owned by
 * lib/lead-governance/seller-signal-strength.ts.
 *
 * UNLIKE THE PERMIT LANE, THIS ONE CAN SPELL "urgent", and only in one place.
 * permit-signals.ts narrows itself to weak|moderate|strong with a stated reason:
 * "urgent" is a judgement about a PERSON'S situation and a building permit is a
 * fact about a STRUCTURE. That reasoning holds, and a scheduled foreclosure
 * auction passes it — a recorded trustee's sale with a DATE is the owner's
 * situation, publicly filed, with a deadline on it, and it is read rather than
 * judged. Nothing else here reaches the top of the ladder: a propensity score is
 * a model probability, not an event, and it is capped at "strong" no matter how
 * high it runs.
 */
export type BatchDataSignalStrength = SellerSignalStrength

/** PURE. Band the provider's 0-100 propensity onto the ladder, or null when the
 *  score is too low to be worth a row at all. */
export function bandSalePropensity(score: number | null): BatchDataSignalStrength | null {
  if (score === null) return null
  if (score >= 90) return "strong"
  if (score >= 75) return "moderate"
  if (score >= 60) return "weak"
  // Below 60 the model is not saying anything. Filing it as "weak" would put a
  // row on the record of every property the provider has ever scored, and lead
  // scoring COUNTS these rows — a signal that fires for everyone is a constant,
  // not a signal.
  return null
}

/** PURE. Band equity onto the ladder. Thresholds are lifted verbatim from the
 *  existing writer at app/actions/lead-intelligence.ts:1203 (>0.75 strong,
 *  >0.5 moderate) so the two writers of `high_equity` cannot disagree. */
export function bandEquity(percent: number | null, freeAndClear: boolean): BatchDataSignalStrength | null {
  if (freeAndClear) return "strong"
  if (percent === null) return null
  if (percent > 75) return "strong"
  if (percent > 50) return "moderate"
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — derivation
// ─────────────────────────────────────────────────────────────────────────────

export interface DerivedSellerSignal {
  signalType: string
  strength: BatchDataSignalStrength
  /**
   * What makes ONE occurrence of this fact different from the next one.
   *
   * THE DEDUPE UNIT, and the reason this lane can be re-run without inflating a
   * lead's score. A state that persists (vacant, absentee) has a constant
   * variant, so re-probing files nothing new. An EVENT (a new lien, a second
   * failed listing, a further delinquent year) carries its own handle, so a
   * genuinely new occurrence is a genuinely new row. A moving SCORE carries its
   * band, so a lead that climbs from moderate to strong files a second row and
   * a lead that merely stays high does not.
   */
  variant: string
  /** Fixed sentence. Nothing in this lane is authored by a model. */
  reason: string
  /** The read values behind the verdict, for the operator and the scorer. */
  observed: Record<string, unknown>
}

/**
 * PURE. Every seller signal one provider property row supports.
 *
 * DELIBERATELY CONSERVATIVE, in the same direction as the permit lane. A fact
 * that is true of a large fraction of all homes (any equity at all, five years
 * of ownership) produces NO row rather than a weak one, because lead scoring
 * counts rows and a signal that fires for everybody moves every lead equally —
 * which is the same as moving none of them, while looking like coverage.
 */
export function deriveSellerSignals(
  row: unknown,
  opts?: { todayIso?: string },
): DerivedSellerSignal[] {
  const out: DerivedSellerSignal[] = []
  const today = opts?.todayIso ?? new Date().toISOString().slice(0, 10)

  // ── sale propensity ──
  const propensity = readSalePropensity(row)
  const propensityBand = bandSalePropensity(propensity)
  if (propensityBand) {
    out.push({
      signalType: SALE_PROPENSITY_SIGNAL_TYPE,
      strength: propensityBand,
      variant: `band:${propensityBand}`,
      reason: "Provider sale-propensity model scores this property as likely to transact",
      observed: {
        sale_propensity: propensity,
        sale_propensity_category: at(row, "intel.salePropensityCategory") ?? null,
      },
    })
  }

  // ── foreclosure ──
  const fc = readForeclosure(row)
  if (fc.stage) {
    // "urgent" ONLY where the record carries a SALE, and only where that sale is
    // still ahead of us. A trustee's sale that already happened is history, not
    // a deadline, and calling it urgent would send an agent at a property that
    // has already changed hands.
    const dated = fc.stage === "auction" || fc.stage === "notice_of_sale"
    const futureAuction = !!fc.auctionDate && fc.auctionDate >= today
    const strength: BatchDataSignalStrength =
      dated && futureAuction ? "urgent"
      : dated ? "strong"
      : fc.stage === "lis_pendens" || fc.stage === "notice_of_default" ? "strong"
      : "moderate"
    out.push({
      signalType: PREFORECLOSURE_SIGNAL_TYPE,
      strength,
      variant: fc.handle ? `f:${fc.handle}` : `s:${fc.stage}`,
      reason: "Recorded foreclosure filing against this property",
      observed: {
        stage: fc.stage,
        auction_date: fc.auctionDate,
        foreclosure_status: fc.status,
        auction_is_upcoming: fc.auctionDate ? futureAuction : null,
      },
    })
  }

  // ── tax delinquency ──
  const delinquentYear = readTaxDelinquentYear(row)
  if (delinquentYear !== null || readQuickList(row, "taxDefault")) {
    const currentYear = Number(today.slice(0, 4))
    const yearsBehind = delinquentYear !== null ? currentYear - delinquentYear : null
    out.push({
      signalType: TAX_DELINQUENT_SIGNAL_TYPE,
      strength: yearsBehind !== null && yearsBehind >= 3 ? "strong" : "moderate",
      variant: delinquentYear !== null ? `y:${delinquentYear}` : "q:tax-default",
      reason: "Unpaid property tax recorded against this parcel",
      observed: { tax_delinquent_year: delinquentYear, years_behind: yearsBehind, tax_year: at(row, "tax.taxYear") ?? null },
    })
  }

  // ── involuntary liens ──
  const liens = readLiens(row)
  const hasLien = readQuickList(row, "involuntaryLien") || (liens.count ?? 0) > 0 || liens.types.length > 0
  if (hasLien) {
    const heavy = (liens.count ?? 0) >= 2 || (liens.balance ?? 0) >= 25_000
    out.push({
      signalType: INVOLUNTARY_LIEN_SIGNAL_TYPE,
      strength: heavy ? "strong" : "moderate",
      variant: liens.handle ? `l:${liens.handle}` : `n:${liens.count ?? 1}`,
      reason: "Involuntary lien filed against this property by a third party",
      observed: { open_lien_count: liens.count, open_lien_balance: liens.balance, lien_types: liens.types },
    })
  }

  // ── vacancy ──
  const vacant = at(row, "general.vacant") === true || readQuickList(row, "vacant")
  const mailVacant = at(row, "general.mailingAddressVacant") === true || readQuickList(row, "mailingAddressVacant")
  if (vacant || mailVacant) {
    out.push({
      signalType: VACANCY_SIGNAL_TYPE,
      // A vacant PROPERTY is carrying cost with nobody in it. A vacant MAILING
      // address is a weaker, second-hand read — the owner's mail is undeliverable,
      // which is suggestive and not the same observation.
      strength: vacant ? "strong" : "moderate",
      variant: vacant ? "v:property" : "v:mailing",
      reason: vacant ? "Property is recorded vacant" : "Owner's mailing address is recorded vacant",
      observed: { property_vacant: vacant, mailing_address_vacant: mailVacant },
    })
  }

  // ── absentee ──
  const outOfState = readQuickList(row, "absenteeOwnerOutOfState") || readQuickList(row, "outOfStateOwner")
  const absentee = outOfState || readQuickList(row, "absenteeOwner") || readQuickList(row, "absenteeOwnerInState")
  if (absentee) {
    out.push({
      signalType: ABSENTEE_OWNER_SIGNAL_TYPE,
      strength: outOfState ? "moderate" : "weak",
      variant: outOfState ? "a:out-of-state" : "a:in-state",
      reason: outOfState
        ? "Owner's mailing address is in another state"
        : "Owner's mailing address is not the property address",
      observed: { out_of_state: outOfState, owner_occupied: at(row, "owner.ownerOccupied") ?? null },
    })
  }

  // ── tired landlord ──
  if (readQuickList(row, "tiredLandlord")) {
    out.push({
      signalType: TIRED_LANDLORD_SIGNAL_TYPE,
      strength: "moderate",
      variant: "q:tired-landlord",
      reason: "Provider flags a long-held non-owner-occupied rental",
      observed: { tired_landlord: true },
    })
  }

  // ── listing withdrawn unsold ──
  const expired = readQuickList(row, "expiredListing")
  const canceled = readQuickList(row, "canceledListing")
  const failed = readQuickList(row, "failedListing")
  if (expired || canceled || failed) {
    const failedDateRaw = at(row, "listing.failedListingDate")
    const failedDate = typeof failedDateRaw === "string" ? (/^(\d{4}-\d{2}-\d{2})/.exec(failedDateRaw)?.[1] ?? null) : null
    const kind = expired ? "expired" : canceled ? "canceled" : "failed"
    out.push({
      signalType: LISTING_WITHDRAWN_SIGNAL_TYPE,
      strength: "strong",
      variant: failedDate ? `d:${failedDate}` : `k:${kind}`,
      reason: "A prior listing on this property came off the market without selling",
      observed: {
        withdrawal_kind: kind,
        failed_listing_date: failedDate,
        days_on_market: num(at(row, "listing.daysOnMarket")),
        original_listing_date: at(row, "listing.originalListingDate") ?? null,
      },
    })
  }

  // ── equity (REUSED signal_type: high_equity) ──
  const equityPercent = readEquityPercent(row)
  const freeAndClear = readQuickList(row, "freeAndClear")
  const equityBand = bandEquity(equityPercent, freeAndClear)
  if (equityBand) {
    out.push({
      signalType: HIGH_EQUITY_SIGNAL_TYPE,
      strength: equityBand,
      variant: `band:${equityBand}`,
      reason: "High equity position",
      observed: {
        equity_percent: equityPercent,
        free_and_clear: freeAndClear,
        estimated_value: num(at(row, "valuation.estimatedValue")),
      },
    })
  }

  // ── tenure (REUSED signal_type: market_timing) ──
  const tenure = readTenureYears(row, today)
  if (tenure !== null && tenure >= 10) {
    out.push({
      signalType: MARKET_TIMING_SIGNAL_TYPE,
      // "moderate" matches the existing writer at lead-intelligence.ts:1183,
      // which emits moderate at >= 120 months. Same fact, same word.
      strength: "moderate",
      variant: `band:${tenure >= 20 ? "20y" : "10y"}`,
      reason: "Long-term ownership",
      observed: { tenure_years: tenure, ownership_start_date: at(row, "owner.ownershipStartDate") ?? null },
    })
  }

  // ── for sale by owner ──
  //
  // THE STRONGEST ACTIONABLE ONE, and the only on-market state this lane treats
  // as an opportunity: the seller has published intent and has no broker.
  const fsbo = readQuickList(row, "forSaleByOwner")
  if (fsbo) {
    out.push({
      signalType: FSBO_SIGNAL_TYPE,
      strength: "strong",
      variant: "q:fsbo",
      reason: "Property is listed for sale by the owner, with no listing broker",
      observed: { for_sale_by_owner: true, listing_status: at(row, "listing.status") ?? null },
    })
  }

  // ── listed below the provider's own valuation ──
  const belowMarket = readQuickList(row, "listedBelowMarketPrice")
  if (belowMarket) {
    const listPrice = num(at(row, "listing.listPrice"))
    const estimated = num(at(row, "valuation.estimatedValue"))
    // A DISCOUNT WIDE ENOUGH TO BE A DECISION, not a rounding difference. Under
    // 10% is inside the noise of any AVM, and banding it "strong" would file the
    // provider's estimation error as the owner's motivation. With no readable
    // pair of prices we keep the provider's flag at "moderate" and say so in
    // `observed` — never inflate a verdict on a number we could not read.
    const discountPct = listPrice !== null && estimated !== null && estimated > 0
      ? Math.round(((estimated - listPrice) / estimated) * 100)
      : null
    out.push({
      signalType: BELOW_MARKET_LISTING_SIGNAL_TYPE,
      strength: discountPct !== null && discountPct >= 10 ? "strong" : "moderate",
      variant: discountPct !== null ? `d:${discountPct >= 10 ? "10pct" : "under10pct"}` : "q:below-market",
      reason: "Asking price is below the provider's valuation of this property",
      observed: { list_price: listPrice, estimated_value: estimated, discount_percent: discountPct },
    })
  }

  // ── corporate owner ──
  if (readQuickList(row, "corporateOwned")) {
    out.push({
      signalType: CORPORATE_OWNED_SIGNAL_TYPE,
      strength: "weak",
      variant: "q:corporate-owned",
      reason: "Title is held by an entity rather than a natural person",
      observed: { corporate_owned: true, owner_occupied: at(row, "owner.ownerOccupied") ?? null },
    })
  }

  // ── held in trust ──
  // "moderate", not "strong": a trust is a REASON to transact eventually, not
  // evidence that anything is happening now. Preforeclosure and tax default get
  // "strong" because a clock is running; a trust may hold a house for a decade.
  if (readQuickList(row, "trustOwned")) {
    out.push({
      signalType: TRUST_OWNED_SIGNAL_TYPE,
      strength: "moderate",
      variant: "q:trust-owned",
      reason: "Title is vested in a trust rather than in a natural person",
      observed: {
        trust_owned: true,
        latest_deed_type: at(row, "deedHistory.documentType") ?? null,
      },
    })
  }

  // ── fix and flip ──
  if (readQuickList(row, "fixAndFlip")) {
    out.push({
      signalType: FIX_AND_FLIP_SIGNAL_TYPE,
      strength: "moderate",
      variant: "q:fix-and-flip",
      reason: "Provider flags a property held for resale rather than occupation",
      observed: { fix_and_flip: true },
    })
  }

  // ── vacant lot ──
  if (readQuickList(row, "vacantLot")) {
    out.push({
      signalType: VACANT_LOT_SIGNAL_TYPE,
      strength: "weak",
      variant: "q:vacant-lot",
      reason: "Unimproved land carrying tax and no use",
      observed: { vacant_lot: true, property_type_category: at(row, "general.propertyTypeCategory") ?? null },
    })
  }

  // ── inherited / probate (findings #297 + #304) ──
  //
  // TWO SOURCES, ONE SIGNAL TYPE. The quickList flag is the provider's own
  // probate list; the deed instrument is the county's recorded evidence for the
  // same event. Either alone files a row; both together file ONE row whose
  // variant names the deed, because a lead's signal count must not double
  // merely because two sources agree.
  const inheritedFlag = readQuickList(row, "inherited")
  const probateDeed = readProbateDeedInstrument(row)
  if (inheritedFlag || probateDeed) {
    out.push({
      signalType: INHERITED_SIGNAL_TYPE,
      // "strong" when the provider's own list says so — heirs sell, and this is
      // a state the provider maintains against recorded transfers. A deed
      // instrument WITHOUT the flag is "moderate": it proves a probate transfer
      // happened, but the provider has not concluded the property is in the
      // inherited population, and the transfer may be old.
      strength: inheritedFlag ? "strong" : "moderate",
      variant: probateDeed ? `d:${probateDeed.toLowerCase().slice(0, 60)}` : "q:inherited",
      reason: "Property was inherited — a recorded probate transfer or the provider's inherited list",
      observed: {
        inherited: inheritedFlag,
        probate_deed_instrument: probateDeed,
        latest_deed_type: at(row, "deedHistory.documentType") ?? null,
      },
    })
  }

  // ── senior owner ──
  //
  // The BARE FLAG is banded "weak" on purpose. The provider's senior-owner list
  // is broad, so filing it "moderate" would move a large share of all owners
  // equally — which is the same as moving none of them, while looking like
  // coverage. A MEASURED age at or past 75 is a narrower population and a real
  // life-stage read, so that is where the ladder moves.
  const seniorFlag = readQuickList(row, "seniorOwner")
  const ownerAge = readOwnerAge(row)
  if (seniorFlag || (ownerAge !== null && ownerAge >= 65)) {
    const band = ownerAge === null ? "flag" : ownerAge >= 75 ? "75plus" : "65to74"
    out.push({
      signalType: SENIOR_OWNER_SIGNAL_TYPE,
      strength: band === "75plus" ? "moderate" : "weak",
      variant: `band:${band}`,
      reason: "Owner is in a life stage where downsizing and relocation are common",
      observed: {
        senior_owner: seniorFlag,
        // THE BAND, NOT THE RAW AGE, is what a downstream selector reads — the
        // raw value rides alongside it for the operator and the auditor, in the
        // same way the raw 0-100 propensity rides beside its band. The
        // education selector at lib/agents/education-delivery-producer.ts reads
        // bands; nothing downstream should ever branch on the number.
        owner_age_band: band,
        owner_age: ownerAge,
      },
    })
  }

  // ── recent divorce ──
  if (at(row, "demographics.recentlyDivorced") === true) {
    out.push({
      signalType: RECENT_DIVORCE_SIGNAL_TYPE,
      // "strong", the same band the lane gives a withdrawn listing: a
      // dissolution has to divide an asset that cannot be divided, and the
      // ordinary route is a sale. Not "urgent" — urgent in this lane means a
      // recorded event with a FUTURE DATE on it (a trustee's sale), and a
      // divorce flag carries no date.
      strength: "strong",
      variant: "d:recent",
      reason: "Owner household recently dissolved — an indivisible asset with two claims on it",
      observed: {
        recently_divorced: true,
        marital_status: at(row, "demographics.maritalStatus") ?? null,
      },
    })
  }

  // ── household outgrown the home ──
  const household = readHouseholdPressure(row)
  if (household.overcrowded) {
    out.push({
      signalType: HOUSEHOLD_OUTGROWN_SIGNAL_TYPE,
      // "weak" unless the gap is two bedrooms' worth of people. A household one
      // over the line is a nudge; a household three or more over it is a
      // household actively short of rooms.
      strength: (household.householdSize! - household.bedroomCount!) >= 3 ? "moderate" : "weak",
      variant: `g:${Math.min(household.householdSize! - household.bedroomCount!, 9)}`,
      reason: "Household is larger than the property has bedrooms to seat",
      observed: {
        household_size: household.householdSize,
        bedroom_count: household.bedroomCount,
        surplus_people: household.householdSize! - household.bedroomCount!,
        child_count: at(row, "demographics.childCount") ?? null,
      },
    })
  }

  // ── SUPPRESSION: already represented ──
  //
  // FSBO IS THE DISQUALIFIER, and it is the whole reason this is not simply
  // `if (onMarket)`. Article 16 forbids soliciting a seller subject to ANOTHER
  // BROKER'S exclusive agreement. An unrepresented seller is not that, and
  // suppressing them would delete the strongest opportunity in this file two
  // branches above. On-market AND not-FSBO is the condition that means somebody
  // else holds the listing.
  const onMarket = readQuickList(row, "activeListing") || readQuickList(row, "onMarket")
  const pending = readQuickList(row, "pendingListing")
  if ((onMarket || pending) && !fsbo) {
    out.push({
      signalType: ACTIVE_LISTING_SIGNAL_TYPE,
      // "weak" is the FLOOR of the ladder and it is deliberate: the strength
      // column ranks MOTIVATION, and this row is not a motivation reading at
      // all. The exclusion that actually protects the score lives in
      // lib/lead-governance/seller-signal-strength.ts, which drops this
      // signal_type from the strong count outright — a strength word alone is
      // not a gate, because the next author to band it "strong" would silently
      // turn "do not call" into thirty points of "ready to sell".
      strength: "weak",
      variant: pending && !onMarket ? "l:pending" : "l:active",
      reason: "Property is already listed with a broker — do not solicit (NAR Code of Ethics Article 16)",
      observed: {
        active_listing: onMarket,
        pending_listing: pending,
        for_sale_by_owner: false,
        listing_status: at(row, "listing.status") ?? null,
        suppression: true,
      },
    })
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — the row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PURE. Stable identity for one (fact, lead) pair.
 *
 * Keyed on the FACT's own variant, never on the run date. A daily or weekly
 * re-probe of the same unchanged property therefore produces the same key and
 * writes nothing — which is the whole reason the m514 index exists, and the same
 * lesson m490/m499 taught the permit lane: lead scoring COUNTS these rows, so a
 * re-read that files a second copy is a scoring defect wearing a duplicate-row
 * costume.
 */
export function batchDataSignalDedupeKey(params: {
  signal: DerivedSellerSignal
  entity: SignalEntityKind
  entityId: string
}): string {
  // THE ENTITY KIND IS PART OF THE KEY. Two id namespaces meet in this table —
  // `leads.id` and `contacts.id` are disjoint uuid spaces — and a key that named
  // only the id would be ambiguous about which table it pointed at the moment a
  // contact and a lead ever shared one. Naming the kind also makes the key
  // readable in the row: an operator can see which board a signal is on.
  //
  // THIS KEY FORMAT CHANGED on 2026-08-21 (the tail gained `lead:` / `contact:`).
  // That is safe ONLY because the live table is empty — measured against project
  // hrvaqgvukzxfskkcrwbt on 2026-08-21: `select count(*) from
  // motivated_seller_signals` → 0. With rows present, changing the key would
  // have re-filed every one of them on the next rotation.
  return `batchdata|${params.signal.signalType}|${params.signal.variant}|${params.entity}:${params.entityId}`
}

/**
 * The row as written. EXACTLY ONE of `lead_id` / `contact_id` is present — the
 * other is omitted entirely rather than sent as null, because PGRST204 refuses
 * an INSERT naming an absent column and an omitted column simply takes its
 * default. m517 adds `contact_id` and the CHECK that makes "exactly one" a
 * database fact rather than a convention this file happens to keep.
 */
export interface BatchDataSignalRow {
  lead_id?: string
  contact_id?: string
  brokerage_id: string
  signal_type: string
  signal_strength: BatchDataSignalStrength
  detected_via: string
  signal_details: Record<string, unknown>
}

/**
 * PURE. Build the `motivated_seller_signals` row. Columns verified against the
 * live table (project hrvaqgvukzxfskkcrwbt, 2026-08-20): lead_id, brokerage_id,
 * signal_type, signal_strength, detected_via, signal_details jsonb, detected_at
 * (defaults now()). PGRST204 refuses an INSERT naming an absent column ENTIRELY,
 * so this row names those seven and nothing else.
 *
 * `observed` is passed through `labelProtectedClassFields` on the way in.
 *
 * IT LABELS, IT DOES NOT REMOVE. Owner ruling — "do not run the compliance or
 * fair housing on scrapping, enrichment, scoring, sourcing" — turned this into a
 * LABELLER on 2026-08-21, and it
 * now returns the row intact alongside the paths that name a protected class.
 * (This sentence used to name the `redactProtectedClassFields` shim, which was
 * already not what the code below called; the shim was deleted 2026-09-03 —
 * tombstone at lib/lead-governance/protected-class-signals.ts, above
 * `assertAudienceSegmentationAllowed`.)
 * Those paths are stored as `signal_details.protected_class_fields` — renamed
 * from `protected_class_redacted` on 2026-08-21, because the old name asserted
 * a redaction that no longer happens, in persisted data a reader would trust.
 * The array means "protected-class fields PRESENT in this row", never "fields
 * removed from it". An empty array means nothing protected was present, not
 * that something was stripped.
 *
 * It is still called, and still on every row, for the reason it always was: the
 * derivation reads no protected field, so this is expected to come back empty,
 * and a labeller that only runs after somebody makes the mistake tells you
 * nothing. The refusal that used to live here now lives at
 * `assertAudienceSegmentationAllowed`, on the ad-audience path.
 */
export function buildBatchDataSignalRow(params: {
  signal: DerivedSellerSignal
  entity: SignalEntityKind
  entityId: string
  brokerageId: string
  leadAddressKey: string
  providerAddress: string | null
}): BatchDataSignalRow {
  // `labelProtectedClassFields`, NOT the `redactProtectedClassFields` shim.
  // The shim's own header names this one as the survivor; calling the survivor
  // means the name at this call site cannot go on implying a redaction that has
  // not happened since 2026-08-21.
  const { value: observed, paths: protectedFields } = labelProtectedClassFields(params.signal.observed)
  return {
    // ONE KEY, NEVER BOTH AND NEVER NEITHER. The other column is omitted rather
    // than set to null: m517's CHECK enforces the same rule in the database, so
    // a row that got this wrong would be REFUSED rather than filed where no
    // reader can see it — which is the exact failure recorded at
    // app/actions/lead-intelligence.ts:2444 (a contacts id written into
    // `lead_id`, producing rows no reader could ever reach).
    ...(params.entity === "contact"
      ? { contact_id: params.entityId }
      : { lead_id: params.entityId }),
    brokerage_id: params.brokerageId,
    signal_type: params.signal.signalType,
    signal_strength: params.signal.strength,
    detected_via: BATCHDATA_DETECTED_VIA,
    signal_details: {
      reason: params.signal.reason,
      dedupe_key: batchDataSignalDedupeKey({
        signal: params.signal, entity: params.entity, entityId: params.entityId,
      }),
      source: "batchdata_property",
      variant: params.signal.variant,
      // The entity kind is repeated INSIDE signal_details as well as being
      // implied by which column is populated. Cheap, and it makes a row
      // self-describing in a jsonb dump where the null column is invisible.
      entity: params.entity,
      address_key: params.leadAddressKey,
      provider_address: params.providerAddress,
      observed: observed as Record<string, unknown>,
      // RENAMED 2026-08-21 from `protected_class_redacted`, at the integrator's
      // request, because that name had become a lie in PERSISTED DATA — the
      // worst place for one. Owner ruling — "do not run the compliance or fair
      // housing on scrapping, enrichment, scoring, sourcing" — turned
      // protected-class handling on this path from a REDACTION into a LABEL, so
      // this array now names the protected-class fields PRESENT ON THIS ROW. It
      // is not evidence that anything was removed; nothing was.
      //
      // NO STORED ROW CARRIES THE OLD KEY, so there is no dual-read to write and
      // the rename drops nothing. Measured live against project
      // hrvaqgvukzxfskkcrwbt on 2026-08-21: `select count(*) from
      // motivated_seller_signals` → 0. Had rows existed, a reader would have had
      // to accept both spellings rather than the old ones going quiet.
      //
      // An empty array is the EXPECTED state and says the labeller ran and found
      // nothing protected — never that it did not run.
      protected_class_fields: protectedFields,
      // ── ADDED 2026-08-22, findings #297 + #304 ────────────────────────────
      // WHY THE STORED ROW NEEDS ITS OWN COPY, and not just a lookup into
      // BATCHDATA_PROTECTED_CLASS_BASIS. Two reasons, both about honesty over
      // time. First, a row outlives the code: an auditor asking "which of these
      // signals came from protected-class data" a year from now must be able to
      // answer it from the table, without the spec table in front of them and
      // without hoping it still says what it said the day the row was written.
      // Second, the classifier returns a REASON SENTENCE rather than a boolean
      // precisely so a caller that LABELS can write down what it labelled and on
      // what grounds — a stored boolean would record that something was
      // protected and lose why.
      //
      // THIS IS DISTINCT FROM `protected_class_fields` ABOVE, and the two are
      // easy to confuse. That one says which fields of THIS PROVIDER ROW are
      // protected — an observation about the payload, usually empty. This one
      // says which DECLARED SOURCES this SIGNAL TYPE is derived from — a fact
      // about the derivation, and it is non-empty for exactly the four types
      // findings #297/#304 added. A signal can have one without the other.
      //
      // `[]` means this signal is derived purely from parcel-and-transaction
      // state. It never means "nobody classified it": the key is on every row.
      protected_class_basis: BATCHDATA_PROTECTED_CLASS_BASIS[params.signal.signalType] ?? [],
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB — the ingest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH BOARD A SIGNAL BELONGS TO. Owner ruling, 2026-08-21: "motivated sellers
 * source is for leads and contacts."
 *
 * `leads.id` and `contacts.id` are DISJOINT uuid namespaces, and until m517
 * this table had exactly one entity column — `lead_id` — so a contact could
 * only be filed by lying about which table its id came from. That lie has
 * already been made and paid for once here; the tombstone is at
 * app/actions/lead-intelligence.ts:2444. This type is the discriminator that
 * makes it unnecessary.
 */
export type SignalEntityKind = "lead" | "contact"

/** The minimum a lead OR contact row must carry to be probed. */
export interface ProbeableEntity {
  /** Which table `id` came from. There is no default: an entity whose kind
   *  nobody stated is an entity nobody can file, and guessing is the defect. */
  entity: SignalEntityKind
  id: string
  address: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
}

/** The adapter envelope, matching the shape permit-signals' two providers share. */
export interface PropertyLookupResult {
  ok: boolean
  status: number | null
  data: Record<string, unknown> | null
  error: string | null
}

/** Injectable seam: one entity's address → one provider property row. Real
 *  implementation below; the simulator supplies its own so the proof costs
 *  nothing and never depends on a vendor's uptime. */
export type PropertyLookup = (entity: ProbeableEntity) => Promise<PropertyLookupResult>

/**
 * PURE. Which of a tenant's leads to probe on a given day.
 *
 * ROTATION, NOT A CURSOR, and the reason is a measurement one. A lead the
 * provider knows nothing about produces NO row, so "we checked and found
 * nothing" leaves no trace to read back — a last-checked timestamp derived from
 * the signal table would re-probe those leads every single day forever and bill
 * for it, while a lead WITH a signal was never looked at again.
 *
 * So the selection is a deterministic rotation over the tenant's leads, sorted
 * by id and offset by the day. Every lead is probed once per
 * ceil(total / perRun) days, spend is bounded by `perRun` regardless of how many
 * leads the tenant has, and the schedule is reproducible from the date alone —
 * no state, nothing to drift.
 */
export function selectLeadsToProbe(params: {
  leads: ProbeableEntity[]
  perRun: number
  dayIso: string
}): ProbeableEntity[] {
  const usable = params.leads
    .filter((l) => !!normalizeStreetAddress(l.address))
    // Sorted on (entity, id) rather than id alone. The two namespaces are
    // disjoint uuids, so sorting on id would interleave them arbitrarily and the
    // rotation's day-offset would land on a different mix each time the tenant's
    // roster changed. Keyed this way the order is stable and a run is still
    // reproducible from the date alone.
    .sort((a, b) => {
      const ka = `${a.entity}:${a.id}`, kb = `${b.entity}:${b.id}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  if (usable.length === 0 || params.perRun <= 0) return []
  if (usable.length <= params.perRun) return usable
  const days = Math.floor(Date.parse(`${params.dayIso}T00:00:00Z`) / 86_400_000)
  const offset = ((days * params.perRun) % usable.length + usable.length) % usable.length
  const out: ProbeableEntity[] = []
  for (let i = 0; i < params.perRun; i++) out.push(usable[(offset + i) % usable.length])
  return out
}

export interface BatchDataSignalIngestResult {
  brokerageId: string
  // ── THE TWO ENTITY KINDS, COUNTED APART ──────────────────────────────────
  // A single `leadsAvailable` covering both boards would make "this tenant has
  // 400 contacts and no leads" indistinguishable from the reverse, and the
  // owner ruling that produced this lane is precisely that the two are
  // different populations. UNCONVERTED leads only — see the ingest.
  leadsAvailable: number
  contactsAvailable: number
  leadsProbed: number
  contactsProbed: number
  /** Leads excluded because they have already been converted to a contact
   *  (`leads.contact_id` set). NOT a failure — the contact is probed instead,
   *  and this counter is what keeps that visible rather than looking like a
   *  shrinking lead base. */
  leadsSkippedConverted: number
  /** Probes the provider REFUSED. Distinct from `probesNotFound` on purpose:
   *  "the provider said no" and "the provider has nothing on this address" are
   *  two different facts and collapsing them is how a dead connector reads as a
   *  quiet market. */
  lookupsRefused: number
  /** Probes that served but returned no property for the address. */
  probesNotFound: number
  /** Probes whose returned property did NOT match the entity's address key. */
  probesAddressMismatch: number
  /** Probes that served a matching property carrying no qualifying signal. */
  probesNoSignal: number
  signalsDerived: number
  alreadyRecorded: number
  signalsWritten: number
  /** Per signal_type counts of what was WRITTEN — the breakdown a total hides. */
  writtenByType: Record<string, number>
  /** Written rows split by which board they landed on. The counter that makes
   *  "contacts are covered" a measurement rather than a claim. */
  writtenByEntity: Record<SignalEntityKind, number>
  /** Protected-class field paths the storage LABELLER found in the provider
   *  rows. Expected empty — this lane reads only parcel-and-transaction state.
   *  Since 2026-08-21 these fields are LABELLED, not removed (owner ruling), so
   *  a non-empty list means "the provider sent demographics we never asked for
   *  and they are ON the stored row", not "…and they were stripped". Renamed
   *  from `protectedClassRedacted` alongside the stored key, 2026-08-21. */
  protectedClassFields: string[]
  /**
   * signal_type → how many WRITTEN rows of that type were derived from a
   * protected-class source. Added 2026-08-22 with findings #297/#304.
   *
   * NOT a duplicate of `writtenByType` (CLAUDE.md §6): that one counts every
   * type, this one counts only the protected-derived subset, and the two are
   * read by different people. `writtenByType` answers "what did the probe
   * find"; this answers "how much of what we stored today came from data about
   * a PERSON" — the number a compliance reviewer asks for, and the one that
   * would otherwise have to be reconstructed by joining the run report against
   * the spec table.
   *
   * `{}` means nothing protected-derived was written this run. It is derived
   * from the ROW's own stored basis, never from a variable the loop happened to
   * be holding, for the same reason `writtenByEntity` is read off the row: a
   * counter derived from intent proves only what the loop believed.
   */
  protectedClassDerivedByType: Record<string, number>
  /** Every refusal, verbatim. A run with errors NEVER reports a clean success. */
  errors: string[]
}

/** Minimal client surface — accepts the SSR or service supabase client. */
type SupabaseLike = { from: (table: string) => any }

export const MAX_LEADS_READ = 5000
export const DEFAULT_LOOKUPS_PER_RUN = 200
const MAX_SIGNALS_PER_RUN = 500

/**
 * Run the BatchData seller-signal probe for ONE brokerage over its OWN leads.
 *
 * TENANT SCOPING: `brokerageId` is a parameter of this function and the CALLER
 * takes it from the session or from the cron's own tenant loop — never from a
 * request body (the IDOR shape CLAUDE.md §4 names). Every read filters
 * `.eq("brokerage_id", brokerageId)` and every written row carries it, so a
 * property fact can only ever attach to a lead the same brokerage owns.
 *
 * REFUSALS: supabase-js RESOLVES a refused query, so every call destructures
 * `{ data, error }` and pushes the message onto `errors`. A refused lead read or
 * a refused idempotency read returns with nothing written — never as "0 signals".
 */
export async function ingestBatchDataSellerSignals(params: {
  supabase: SupabaseLike
  brokerageId: string
  lookup: PropertyLookup
  /** `YYYY-MM-DD`. Drives the rotation and the "is this auction still ahead" read. */
  dayIso: string
  lookupsPerRun?: number
}): Promise<BatchDataSignalIngestResult> {
  const { supabase, brokerageId, lookup, dayIso } = params
  const perRun = params.lookupsPerRun ?? DEFAULT_LOOKUPS_PER_RUN
  const result: BatchDataSignalIngestResult = {
    brokerageId,
    leadsAvailable: 0,
    contactsAvailable: 0,
    leadsProbed: 0,
    contactsProbed: 0,
    leadsSkippedConverted: 0,
    lookupsRefused: 0,
    probesNotFound: 0,
    probesAddressMismatch: 0,
    probesNoSignal: 0,
    signalsDerived: 0,
    alreadyRecorded: 0,
    signalsWritten: 0,
    writtenByType: {},
    writtenByEntity: { lead: 0, contact: 0 },
    protectedClassFields: [],
    protectedClassDerivedByType: {},
    errors: [],
  }

  // ── 1a. The tenant's own UNCONVERTED leads ────────────────────────────────
  //
  // `.is("contact_id", null)` IS LOAD-BEARING, not tidiness. `leads.contact_id`
  // REFERENCES contacts(id) (verified live on project hrvaqgvukzxfskkcrwbt,
  // constraint leads_contact_id_fkey), so a converted lead and its contact are
  // THE SAME PERSON at THE SAME ADDRESS. Probing both would derive the identical
  // signal set twice, under two different dedupe keys — and lead scoring COUNTS
  // signals, so one foreclosure would become two independent reasons to believe
  // somebody is selling. The owner ruled separately that after conversion only
  // the contact is acted on, so the CONTACT is the survivor and the lead row is
  // excluded here rather than deduplicated afterwards.
  //
  // THE PREDICATE IS NOT SPELLED HERE. `excludeConvertedLeads`
  // (lib/contact-promotion/conversion-finality.ts) is the ONE conversion guard,
  // and it owns the marker column: three converters in this tree disagree about
  // which "converted" flag they write, and `leads.contact_id` is the only one
  // every path sets. Spelling `.is("contact_id", null)` inline here would be a
  // second copy of that decision, which is how one of the copies later stops
  // matching (CLAUDE.md §6).
  const { data: leadRows, error: leadsError } = await excludeConvertedLeads(
    supabase
      .from("leads")
      .select("id, address, city, state, zip_code")
      .eq("brokerage_id", brokerageId),
  )
    .not("address", "is", null)
    .limit(MAX_LEADS_READ)
  if (leadsError) {
    result.errors.push(`leads read refused: ${leadsError.message}`)
    return result
  }
  const leads: ProbeableEntity[] = ((leadRows ?? []) as Array<Omit<ProbeableEntity, "entity">>)
    .map((l) => ({ ...l, entity: "lead" as const }))
  result.leadsAvailable = leads.length

  // How many leads the exclusion removed. Counted with a SEPARATE query rather
  // than inferred, because "we filtered some out" and "this tenant has fewer
  // leads than it did" look identical in a single number.
  const { count: convertedCount, error: convertedError } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)
    .not("contact_id", "is", null)
    .not("address", "is", null)
  if (convertedError) {
    // Not fatal: this is a REPORTING number, not a gate. But it is never
    // silently reported as zero.
    result.errors.push(`converted-lead count refused: ${convertedError.message}`)
  } else {
    result.leadsSkippedConverted = convertedCount ?? 0
  }

  // ── 1b. …and the tenant's own CONTACTS ────────────────────────────────────
  //
  // Owner ruling, verbatim: "motivated sellers source is for leads and
  // contacts." `contacts.id` is the PRIMARY KEY and the column
  // `leads.contact_id` points at — NOT `contacts.contact_id`, the secondary
  // unique uuid this schema also carries (CLAUDE.md §3: picking the wrong one
  // produces a query that always returns nothing). Measured live 2026-08-21:
  // all 4 contact rows have id <> contact_id, so the two are genuinely
  // different values and the choice is not academic.
  //
  // `deleted_at` is respected: contacts is soft-deleted, and probing a deleted
  // person would spend provider budget to file a signal onto a record the
  // product has already retired.
  const { data: contactRows, error: contactsError } = await supabase
    .from("contacts")
    .select("id, address, city, state, zip_code")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .not("address", "is", null)
    .limit(MAX_LEADS_READ)
  if (contactsError) {
    result.errors.push(`contacts read refused: ${contactsError.message}`)
    return result
  }
  const contacts: ProbeableEntity[] = ((contactRows ?? []) as Array<Omit<ProbeableEntity, "entity">>)
    .map((c) => ({ ...c, entity: "contact" as const }))
  result.contactsAvailable = contacts.length

  // ONE ROTATION OVER BOTH BOARDS, not one rotation each. The cap is a SPEND
  // cap — the provider bills per lookup — so splitting it into two independent
  // rotations would double a tenant's daily bill the day contacts were added.
  const batch = selectLeadsToProbe({ leads: [...leads, ...contacts], perRun, dayIso })
  if (batch.length === 0) return result

  // ── 2. Already-filed BatchData signals for this tenant (idempotency) ──
  //
  // `.in`, not `.eq` — this lane writes ten signal types and reading back only
  // one would re-file the other nine on every rotation. m514 widens the unique
  // index to the same set; this read is the fast path in front of it.
  const { data: existingRows, error: existingError } = await supabase
    .from("motivated_seller_signals")
    .select("signal_details")
    .eq("brokerage_id", brokerageId)
    .in("signal_type", BATCHDATA_SIGNAL_TYPES)
  if (existingError) {
    // Without the existing set we cannot tell a new fact from one filed last
    // rotation. Writing anyway would duplicate a lead's whole signal set every
    // pass and inflate its score, so this refuses instead.
    result.errors.push(`existing-signal read refused: ${existingError.message}`)
    return result
  }
  const alreadyKeys = new Set<string>()
  for (const row of (existingRows ?? []) as Array<{ signal_details: { dedupe_key?: string } | null }>) {
    const k = row?.signal_details?.dedupe_key
    if (typeof k === "string" && k) alreadyKeys.add(k)
  }

  // ── 3. Probe, verify the address, derive ──
  const toWrite: BatchDataSignalRow[] = []
  for (const lead of batch) {
    if (lead.entity === "contact") result.contactsProbed++
    else result.leadsProbed++
    const leadKey = normalizeStreetAddress(lead.address)
    const res = await lookup(lead)
    if (!res.ok) {
      result.lookupsRefused++
      result.errors.push(`${lead.entity} ${lead.id}: provider refused (${res.status ?? "network"}): ${res.error ?? "no reason given"}`)
      continue
    }
    if (!res.data) { result.probesNotFound++; continue }

    // EXACT key equality, the same refusal permit-signals makes. A provider free
    // to return "the closest match" would otherwise put a neighbour's foreclosure
    // on this record, and every downstream score would read it as fact.
    const providerAddress = readProviderAddress(res.data)
    if (normalizeStreetAddress(providerAddress) !== leadKey) {
      result.probesAddressMismatch++
      continue
    }

    const derived = deriveSellerSignals(res.data, { todayIso: dayIso })
    if (derived.length === 0) { result.probesNoSignal++; continue }
    result.signalsDerived += derived.length

    for (const signal of derived) {
      const key = batchDataSignalDedupeKey({ signal, entity: lead.entity, entityId: lead.id })
      if (alreadyKeys.has(key)) { result.alreadyRecorded++; continue }
      alreadyKeys.add(key) // also dedupes WITHIN this run
      const row = buildBatchDataSignalRow({
        signal, entity: lead.entity, entityId: lead.id, brokerageId,
        leadAddressKey: leadKey, providerAddress,
      })
      const labelled = (row.signal_details as { protected_class_fields?: string[] }).protected_class_fields ?? []
      for (const r of labelled) if (!result.protectedClassFields.includes(r)) result.protectedClassFields.push(r)
      toWrite.push(row)
      if (toWrite.length >= MAX_SIGNALS_PER_RUN) break
    }
    if (toWrite.length >= MAX_SIGNALS_PER_RUN) break
  }

  if (toWrite.length === 0) return result

  // ── 4. Write ──
  //
  // m514 adds the partial UNIQUE index on (signal_type, signal_details->>'dedupe_key')
  // for this lane's types. The read in step 2 is the fast path; the index is the
  // guarantee. A batch INSERT is ONE statement, so a single duplicate (a
  // concurrent run, a re-dispatch) rejects the whole batch — a 23505 therefore
  // falls back to per-row inserts, which lets every genuinely-new signal through
  // and counts the collisions as what they are. Any OTHER error is reported.
  const countWritten = (rows: BatchDataSignalRow[]) => {
    for (const r of rows) {
      result.writtenByType[r.signal_type] = (result.writtenByType[r.signal_type] ?? 0) + 1
      // Counted from WHICH COLUMN THE ROW ACTUALLY CARRIES, not from a variable
      // we happened to be holding. The point of the split counter is to prove
      // contacts really are landing in `contact_id`; deriving it from anything
      // other than the row itself would prove only that the loop believed so.
      result.writtenByEntity[r.contact_id ? "contact" : "lead"]++
      // READ OFF THE ROW, like writtenByEntity above and for the same reason.
      // The basis is what was actually persisted; counting from
      // BATCHDATA_PROTECTED_CLASS_BASIS here would prove the spec table agrees
      // with itself rather than that the stored row says so.
      const basis = (r.signal_details as { protected_class_basis?: unknown }).protected_class_basis
      if (Array.isArray(basis) && basis.length > 0) {
        result.protectedClassDerivedByType[r.signal_type] =
          (result.protectedClassDerivedByType[r.signal_type] ?? 0) + 1
      }
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("motivated_seller_signals")
    .insert(toWrite)
    .select("id")

  if (!insertError) {
    result.signalsWritten = (inserted ?? []).length
    countWritten(toWrite)
    return result
  }
  if ((insertError as { code?: string }).code !== "23505") {
    result.errors.push(`motivated_seller_signals insert refused: ${insertError.message}`)
    return result
  }

  for (const row of toWrite) {
    const { data: one, error: oneError } = await supabase
      .from("motivated_seller_signals")
      .insert(row)
      .select("id")
      .maybeSingle()
    if (!oneError) { if (one) { result.signalsWritten++; countWritten([row]) } ; continue }
    if ((oneError as { code?: string }).code === "23505") { result.alreadyRecorded++; continue }
    result.errors.push(`motivated_seller_signals insert refused: ${oneError.message}`)
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// The real provider adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provider datasets this lane requests. Every name is a member of the
 * provider's own dataset list, read live on 2026-08-22 via
 * `list_property_datasets` (15 datasets).
 *
 * `demographic` USED TO BE CONSPICUOUSLY ABSENT AND THIS PARAGRAPH IS THE
 * CORRECTION. Owner ruling, verbatim: "all motivatied seller classifiers are
 * necessary for data especially demographics and protected class." Not asking
 * for the dataset was described here as "the cheapest of the three fair-housing
 * gates"; under the ruling it is not a gate at all, it is the lane declining to
 * collect the input the owner wants collected. `senior_owner`, `recent_divorce`
 * and `household_outgrown` all read `demographics.*`, and a declared source that
 * never arrives is a reader with no writer — the orphan class CLAUDE.md §1 names.
 *
 * `deed` was added in the same edit for the same reason and it is NOT a
 * fair-housing question at all: `trust_owned` has declared `deedHistory.*` as a
 * source since it shipped, and `inherited_property` reads the probate deed
 * instrument, but the dataset carrying those fields was never requested — so
 * both read undefined on live traffic no matter what the property recorded.
 *
 * The two gates that remain are the ones that were always doing the work: the
 * declaration LABELLER (which is why the four new types arrive labelled) and the
 * storage labeller. The refusal is on the ad-audience lane and nowhere else.
 */
export const BATCHDATA_SIGNAL_DATASETS: readonly string[] = [
  "core", "quicklist", "batchrank", "foreclosure", "mortgage-liens", "valuation", "listing",
  "deed", "demographic",
]

/**
 * Look one lead's own address up at the provider. NEVER THROWS — it returns the
 * same `{ ok, status, data, error }` envelope the injectable seam declares, so a
 * vendor outage is a counted refusal rather than a dead cron.
 *
 * ── THE REFUSAL THAT WAS RELEASED HERE (finding #297, 2026-08-22) ────────────
 * Owner ruling, verbatim: "297 just release it from fairhousing." And the
 * standing scope ruling it rests on: "do not run the compliance or fair housing
 * on scrapping, enrichment, scoring, sourcing because we determine the kind of
 * education in channels by the age group and other ways to use it without
 * violating the rules."
 *
 * WHAT THIS CODE USED TO DO:
 *
 *     const { criteria, removed } = stripProtectedClassCriteria({ query })
 *     if (removed.length > 0) {
 *       return { ok: false, …, error: `protected-class criteria refused: …` }
 *     }
 *
 * That was the LAST fair-housing refusal on the data lane. It is gone. The call
 * now names its LANE — `"data_sourcing"` — and that lane removes nothing: a
 * protected-class criterion is returned intact and LABELLED with the
 * classifier's reason sentence.
 *
 * THIS IS NOT A DELETION, AND THE DISTINCTION IS THE POINT (CLAUDE.md §1). The
 * same function called with `"ad_audience"` still strips, byte for byte, and
 * that lane is where choosing who a housing ad is SHOWN TO lives. Releasing the
 * refusal by deleting it outright would have released it there too. DO NOT
 * "fix" this back by removing the lane argument or by reinstating the `removed`
 * check: the ruling is dated and named above, and the boundary it draws is
 * pinned in both directions by scripts/batchdata-seller-signal-simulator.ts and
 * scripts/compliance-scope-simulator.ts.
 *
 * The labels are still READ rather than swallowed. `labelled` is non-empty only
 * when a future edit adds a protected criterion to this payload — today the
 * function assembles `{ query: "<address>…" }` and nothing in it is
 * classifiable — so it is reported on the envelope's error channel as a NOTE
 * with `ok: true`, never as a refusal.
 */
export async function realBatchDataPropertyLookup(lead: ProbeableEntity): Promise<PropertyLookupResult> {
  try {
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const query = [lead.address, lead.city, lead.state, lead.zip_code].filter(Boolean).join(", ")
    // LANE: data_sourcing. Nothing is removed; protected criteria are labelled.
    const { criteria, labelled } = screenProtectedClassCriteria({ query }, "data_sourcing")
    const res = await callConnector<any>({
      connector: "batchdata",
      baseUrl: "https://api.batchdata.com/api/v1",
      path: "property/search",
      method: "POST",
      auth: { style: "bearer", token: process.env.BATCHDATA_API_KEY ?? "" },
      body: { searchCriteria: criteria, options: { take: 1, skip: 0 }, datasets: BATCHDATA_SIGNAL_DATASETS },
    })
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: res.error ?? "batchdata refused" }
    }
    const properties: any[] = res.data?.results?.properties ?? res.data?.results ?? []
    return {
      ok: true,
      status: res.status,
      data: (properties[0] as Record<string, unknown>) ?? null,
      // A NOTE, NOT A REFUSAL — `ok` stays true. The ingest pushes a non-null
      // `error` onto its `errors` list only for a lookup that came back `ok:
      // false`, so this text reaches an operator without failing a run. It is
      // written at all because a label nobody can read is a write with no
      // reader: the day somebody adds `min_owner_age` to this payload, the run
      // should say so out loud rather than the criterion travelling silently.
      error: labelled.length > 0
        ? `protected-class criteria SOURCED and labelled (data_sourcing lane, owner ruling #297): ${labelled.map((l) => l.source).join(", ")}`
        : null,
    }
  } catch (e) {
    return { ok: false, status: null, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}
