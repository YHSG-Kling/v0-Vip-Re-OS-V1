# Lead-intake provider recommendation — wave 64 (lane 64D audit)

Research + a recommendation only. **No provider was added, removed, or
switched in code by this task** — the scraping freeze covers
`lib/lead-pipeline/*`, `lib/external/*`, `lib/kernel/scraping.ts` and
`app/api/cron/lead-scraping`, none of which this document edits.

Facts below were fetched 2026-09-15 and are transcribed, not embellished —
prices, percentages and feature claims are as stated by each vendor/source at
fetch time and are not independently re-verified against a live call (see
Blind spots).

## What exists in this OS today

Every lead-intake source lane writes into `raw_scraped_leads` and walks the
same pipeline: dedupe → enrich → dedupe → gate (territory + identity) →
promote to `leads`. The nine scraping/intelligence child tables this same
lane's orphaned-child audit covers — `google_search_activity`,
`lead_behavioral_data`, `lead_intelligence`, `lead_osint_data`,
`lead_people_data`, `lead_property_ownership`, `lead_property_searches`,
`motivated_seller_signals`, `nextdoor_activity` — are that pipeline's
evidence trail per source. This recommendation does not collapse or rename
any existing source lane; it evaluates what, if anything, should be added
alongside them.

## Providers researched

### PropertyRadar (fetched 2026-07-28)
- "Likely Transactions" scores, 0–100, across four separate propensities:
  Likely to Sell, Likely to Purchase, Likely to Refinance, Likely to HELOC.
- Rescored monthly.
- Public API now available on the Solo, Team, and Business plans (previously
  a higher-tier-only feature).
- Ships Claude/ChatGPT skill packs; an MCP server is in private beta as of
  August 2026.
- ~160M properties covered.
- Skip trace priced at $0.10/record.
- OwnerGraph entity resolution (linking an owner across properties/entities).
- Plans start from $49/mo.

### BatchData
- REST API at `https://api.batchdata.com/api/v1/`, Bearer-token
  authenticated.
- `property/search` — sync or async with webhook delivery.
- `property/lookup`.
- `property/skip-trace` — up to 100 records per call; includes DNC + TCPA
  litigator scrubbing; vendor-claimed 76% right-party-contact (RPC) rate.
- `phone/address verification` endpoints.
- Smart Search — event-driven push (new/changed records pushed to the
  caller rather than polled).
- BatchRank — a sale-propensity scoring API, vendor-claimed 82% accuracy
  measured August–October 2025.
- SDKs for Python and Node.
- An MCP server is available.
- Bulk delivery via S3, SFTP, or Snowflake.
- ~155M properties, 700+ attributes per property.

### Offrs and SmartZip
- Same parent company (Constellation).
- Pricing: $300–800/mo vs. $1,000–1,500/mo.
- Contract terms: 6-month vs. 12-month.
- Vendor-claimed accuracy: 65–72%.
- No developer API for either.
- Consumer-behavior inputs are named as the weakest part of both models —
  cookie-based, which is a degrading signal class (see Industry stance
  below).

### Likely.AI and Catalyze AI
- Independent predictive-scoring providers — each scores an existing
  database the customer already owns, rather than supplying new raw leads.

### REDX
- Expired-listing and FSBO high-intent prospecting data.
- $60–349/mo.
- Vendor-claimed 20–44% list rate.

### PropertyReach
- Bundles skip trace with "PropPulse" AI scoring.
- Plans start from $79/mo.

### PropStream
- Largest dataset of the set reviewed.
- Skip trace priced at $0.12/record.
- Sibling product to BatchLeads.

## Industry stance (as researched)

- Signal-stacking — combining a predictive propensity score, behavioral
  signal (landing-page visits, valuation-tool intent), and MLS-sourced
  expired/FSBO listings — outperforms reliance on any single source.
- Third-party cookie-based behavioral data is a degrading signal class
  industry-wide (the same weakness named against Offrs/SmartZip above).

## Recommendation for this OS

1. **Keep every existing source lane distinct.** Nothing here proposes
   merging or retiring a current scraping/intelligence source; each stays
   its own lane feeding the shared `raw_scraped_leads` → dedupe → enrich →
   dedupe → gate → `leads` pipeline.
2. **Add BatchRank + Smart Search as lane B builds** (this wave's
   scraping-lane ownership — not built by this audit lane).
3. **Add PropertyRadar's Likely Transactions API as a THIRD, distinct
   predictive lane** — suggested, **not built this wave**. It would sit
   alongside BatchRank as an independent propensity signal rather than
   replacing it: two vendors independently scoring likelihood-to-transact is
   exactly the signal-stacking pattern the research above names as the
   industry's actual edge, versus trusting one vendor's model alone.
4. **Keep this OS's own first-party intent capture — home-valuation tool,
   lead-magnet forms, website widget, portal behavior — as the strongest
   signal available**, because it is first-party (not the degrading
   cookie-based behavioral data the research flags against Offrs/SmartZip)
   and already lands in the same pipeline every scraped source does.
5. **Every provider row, new or existing, lands in `raw_scraped_leads` and
   walks the one pipeline**: dedupe → enrich → dedupe → gate. No provider
   gets a second, parallel intake path.

Offrs/SmartZip, Likely.AI/Catalyze AI, REDX, PropertyReach, and PropStream
were researched for completeness and are not recommended for adoption this
wave: the first two lack a developer API entirely (a hard blocker for an
autonomous-loop OS that writes every source into one pipeline
programmatically); Likely.AI/Catalyze AI score an existing database rather
than supplying new raw leads, which is a different capability than the
provider gap being evaluated here; REDX/PropertyReach/PropStream were not
found to offer a materially different capability than BatchData/PropertyRadar
already cover for this OS's shape.

## Blind spots

- **No live API calls were made to any vendor** — every figure above (price,
  accuracy percentage, dataset size, record count) is as published by the
  vendor or cited source at fetch time (2026-07-28 for PropertyRadar,
  2026-09-15 for the rest), not independently reproduced against a live
  response.
- **Prices are list prices.** Enterprise/volume pricing, contract minimums,
  and per-state or per-market variation were not researched.
- Vendor-claimed accuracy figures (BatchRank 82%, Offrs/SmartZip 65–72%,
  REDX 20–44% list rate) are self-reported by each vendor over the window
  each vendor names; no independent third-party audit of any of these
  figures was located or reviewed.
- PropertyRadar's MCP server is stated as private beta (August 2026) — its
  general-availability status, if any, was not re-checked as of this
  document's fetch date.
- This document does not evaluate data-licensing, DNC/TCPA compliance
  posture, or state-by-state legality for any provider beyond what each
  vendor states about its own product (e.g., BatchData's stated DNC/TCPA
  litigator scrub) — a full compliance review is out of scope for this
  audit lane.
