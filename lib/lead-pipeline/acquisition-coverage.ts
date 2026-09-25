// lib/lead-pipeline/acquisition-coverage.ts
//
// ACQUISITION COVERAGE — the one registry of WHAT each scraping/intelligence source finds and HOW it
// enters the OS (lane 82B, wave 82; owner verbatim: "make sure we have covered every area of lead
// acquisition and enrichment scraping opportunities… If we arent doing this another competitor
// will… the lead scraping/intelligence/properties is a linear setup… these scrape searching should
// be territory centric so we only scrape or search individuals in active territories of our tenant
// subscriptions." Platform-paid; no compliance gating on acquisition).
//
// Keyed by SourceKey (source-intent-map.ts) — a new SourceKey does not compile until it declares
// its intents and its entry door here, and scripts/acquisition-coverage-guard.ts then proves the
// door is territory-scoped, feeds the ONE linear pipeline, books platform spend per source, stamps
// cost per record and is scheduled.
//
// RUNTIME READER: app/dashboard/admin/markets/markets-client.tsx renders each source toggle with
// the intents it acquires (`acquisitionIntentLabel`), so the operator switching a source on sees
// what population it buys.

import type { SourceKey } from "./source-intent-map"

/** The five populations the owner named: sellers, buyers, relocators, people shopping for an agent, investors. */
export type AcquisitionIntent = "sell" | "buy" | "relocate" | "realtor_seeking" | "investor"

/**
 * How the source's records enter the OS. Every door is territory-scoped by
 * lib/lead-pipeline/scrape-territories.ts::resolveActiveScrapeTerritories (active-subscription
 * tenants' territories only) or is the tenant's OWN first-party data.
 *   lead_scraping_cron — app/api/cron/lead-scraping/route.ts, per resolved territory, gated by
 *                        enabledSources.has(<gate token>).
 *   batchdata_push     — app/api/webhooks/batchdata-smart-search/route.ts (pooled subscription
 *                        push; each record matched to a resolved territory before ingest).
 *   intent_campaign    — app/api/cron/intent-campaign → lib/kernel/intent-campaign.ts →
 *                        app/actions/lead-intelligence.ts::scrapeExternalBehavior (own territory gate).
 *   inbound_mailbox    — the tenant's own inbound mail (lib/lead-pipeline/unknown-sender-
 *                        identification.ts) — lead/contact direct by the wave-74 ruling, $0.
 */
export type AcquisitionEntry = "lead_scraping_cron" | "batchdata_push" | "intent_campaign" | "inbound_mailbox"

export interface AcquisitionCoverage {
  intents: readonly AcquisitionIntent[]
  entry: AcquisitionEntry
  /**
   * For lead_scraping_cron sources: how the route spells the write — the channel expression passed
   * to insertSocial(…) or `sourceChannel:` (a string literal, or the loop variable for the portal
   * block / chatter lane). `null` = signal-only first-party lane (the person is already a contact;
   * `records` stays empty by design — rental graduation, email engagement).
   */
  routeChannel: string | null
}

export const SOURCE_ACQUISITION: Record<SourceKey, AcquisitionCoverage> = {
  batchdata_motivated:         { intents: ["sell"],                                   entry: "lead_scraping_cron", routeChannel: '"batchdata"' },
  expired_listing:             { intents: ["sell"],                                   entry: "lead_scraping_cron", routeChannel: '"batchdata"' },
  zenrows_zillow:              { intents: ["sell", "buy"],                            entry: "lead_scraping_cron", routeChannel: "site" },
  zenrows_realtor:             { intents: ["sell", "buy"],                            entry: "lead_scraping_cron", routeChannel: "site" },
  zenrows_homes:               { intents: ["sell", "buy"],                            entry: "lead_scraping_cron", routeChannel: "site" },
  nextdoor_intent:             { intents: ["sell", "buy", "relocate", "realtor_seeking"], entry: "lead_scraping_cron", routeChannel: '"nextdoor"' },
  facebook_group:              { intents: ["sell", "buy"],                            entry: "lead_scraping_cron", routeChannel: '"facebook"' },
  facebook_marketplace:        { intents: ["sell"],                                   entry: "lead_scraping_cron", routeChannel: '"facebook_marketplace"' },
  reddit_intent:               { intents: ["buy", "sell"],                            entry: "lead_scraping_cron", routeChannel: '"reddit"' },
  instagram_intent:            { intents: ["buy", "sell"],                            entry: "lead_scraping_cron", routeChannel: '"instagram"' },
  craigslist_fsbo:             { intents: ["sell"],                                   entry: "lead_scraping_cron", routeChannel: '"craigslist"' },
  craigslist_wanted:           { intents: ["buy"],                                    entry: "lead_scraping_cron", routeChannel: '"craigslist_wanted"' },
  google_phrase_intent:        { intents: ["buy", "sell"],                            entry: "lead_scraping_cron", routeChannel: '"google_phrase_intent"' },
  rental_listing:              { intents: ["sell", "investor"],                       entry: "lead_scraping_cron", routeChannel: '"rental"' },
  linkedin_relocation:         { intents: ["relocate", "buy"],                        entry: "lead_scraping_cron", routeChannel: '"linkedin"' },
  exa_buyer_intent:            { intents: ["buy", "relocate"],                        entry: "lead_scraping_cron", routeChannel: '"exa"' },
  tavily_intent:               { intents: ["buy", "sell", "investor"],                entry: "lead_scraping_cron", routeChannel: '"tavily"' },
  osint_signal:                { intents: ["sell"],                                   entry: "lead_scraping_cron", routeChannel: '"osint_signal"' },
  realty_site_chatter:         { intents: ["buy", "realtor_seeking"],                 entry: "lead_scraping_cron", routeChannel: "`${site}_chatter`" },
  reddit_relocation:           { intents: ["relocate", "realtor_seeking"],            entry: "lead_scraping_cron", routeChannel: '"reddit_relocation"' },
  facebook_recommend_realtor:  { intents: ["realtor_seeking"],                        entry: "lead_scraping_cron", routeChannel: '"facebook_recommend_realtor"' },
  agent_seeking_phrase_intent: { intents: ["realtor_seeking"],                        entry: "lead_scraping_cron", routeChannel: '"agent_seeking_phrase_intent"' },
  batchdata_smart_search:      { intents: ["sell"],                                   entry: "batchdata_push",     routeChannel: null },
  batchdata_buybox:            { intents: ["investor"],                               entry: "lead_scraping_cron", routeChannel: null },
  external_behavior:           { intents: ["sell"],                                   entry: "intent_campaign",    routeChannel: null },
  site_visitor_intent:         { intents: ["buy"],                                    entry: "lead_scraping_cron", routeChannel: '"site_visitor_intent"' },
  email_engagement_intent:     { intents: ["buy", "sell"],                            entry: "lead_scraping_cron", routeChannel: '"email_engagement_intent"' },
  new_construction_intent:     { intents: ["buy", "relocate"],                        entry: "lead_scraping_cron", routeChannel: '"new_construction_intent"' },
  inbound_email_unknown:       { intents: ["buy", "sell", "investor", "relocate", "realtor_seeking"], entry: "inbound_mailbox", routeChannel: null },
  permit_prelisting_intent:    { intents: ["sell"],                                   entry: "lead_scraping_cron", routeChannel: '"permit_prelisting_intent"' },
  rental_to_buyer_graduation:  { intents: ["buy"],                                    entry: "lead_scraping_cron", routeChannel: null },
  review_acquisition_intent:   { intents: ["buy", "sell", "realtor_seeking"],         entry: "lead_scraping_cron", routeChannel: '"review_acquisition_intent"' },
  batchdata_cash_buyer:        { intents: ["investor", "buy"],                        entry: "lead_scraping_cron", routeChannel: '"batchdata_cash_buyer"' },
}

const INTENT_LABEL: Record<AcquisitionIntent, string> = {
  sell: "sellers", buy: "buyers", relocate: "relocators", realtor_seeking: "agent-seekers", investor: "investors",
}

/** Runtime reader — the markets panel's per-source caption ("finds sellers · buyers"). */
export function acquisitionIntentLabel(key: SourceKey): string {
  return (SOURCE_ACQUISITION[key]?.intents ?? []).map((i) => INTENT_LABEL[i]).join(" · ")
}
