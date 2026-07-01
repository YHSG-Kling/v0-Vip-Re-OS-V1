// ─── ZENROWS (web scraping) ───────────────────────────────────────────────────
export type { ZenRowsResponse } from "./zenrows-client"
export { ZenrowsClient, scrapeWithZenRows, retryWithApifyFallback, extractContactsFromHtml } from "./zenrows-client"

// ─── BATCHDATA (motivated seller / property data) ─────────────────────────────
export type { BatchDataRecord } from "./batchdata-client"
export { BatchDataClient, fetchMotivatedSellers, searchProperties, enrichPropertyWithBatchData, batchDataTriggersFor, BATCHDATA_MOTIVATION_TYPES } from "./batchdata-client"

// ─── PEOPLEDATA (skip trace / enrichment) ─────────────────────────────────────
export type { PeopleDataEnrichment } from "./peopledata-client"
export { PeopleDataClient, skipTraceWithPeopleData } from "./peopledata-client"

// ─── APIFY (social / reddit scraping) ────────────────────────────────────────
export { ApifyClient, runApifyActor, scrapeFacebookGroupPosts, scrapeRedditPosts } from "./apify-client"
