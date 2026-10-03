# Provider matrix — 2026-09 (wave 70B)

Owner ruling (verbatim, 2026-09-17): *"for any of our providers for platform,
if there is an sdk option, we should use that… try to use an sdk or mcp if it
is provided but keeping pricing in mind. vercel sdk can be used with ai
gateway."*

SDKs never change per-call price — the vendor's meter is on the request, not
the client library. "Adopt SDK" below is a transport change only; metering
(`meterVendorSpend` / `vendor-governance/usage-logger`) is unchanged in effect
at every migrated call site.

Discovery method: `grep -rn "api\.[a-z-]*\.\(com\|io\|ai\)" lib --include=*.ts
-oh | sort | uniq -c | sort -rn` (full counts below), cross-referenced against
`package.json` for an already-installed SDK and against each vendor's public
docs for an official Node package.

## Legend

- **Credential**: `platform` (platform-owned key, billed to the platform,
  metered per-brokerage for cost attribution) or `tenant` (brokerage's own
  credential).
- **Transport today**: SDK / MCP / typed OpenAPI client / raw REST (through
  `lib/agentic-os/connector-gateway.ts`, the single-egress chokepoint).
- **Verdict**: adopt SDK now (done this wave) / keep REST (with reason) /
  already SDK or MCP (no change needed).

## Core providers (named in the task)

| Provider | Credential | Transport today | Official SDK | Unit price constant (metering site) | Verdict |
|---|---|---|---|---|---|
| BatchData | platform | REST (typed client, `lib/external/batchdata-client.ts`) + **MCP** (`mcp.batchdata.com`, agent-copilot tool lane, `lib/external/batchdata-mcp.ts`, `@modelcontextprotocol/sdk` already in `package.json`) | No official REST SDK; official MCP server | `BATCHDATA_COMPS_COST_CENTS=5¢` (`lib/external/batchdata-client.ts:1400`), `MCP_TOOL_CALL_COST_USD=$0.05` (`lib/external/batchdata-ai-tools.ts:53`); `meterVendorSpend` | **Already MCP** (wave 67/68) for the agent-tool lane; bulk/production pulls stay typed REST (no official REST SDK exists, and MCP calls are billed as ordinary API requests plus LLM tokens — production volume stays off the LLM path). No change this wave. |
| RentCast | **platform** (`RENTCAST_API_KEY`) | Typed OpenAPI client (`lib/external/rentcast-typed.ts`) + **MCP** (`developers.rentcast.io/mcp`, copilot-only, `lib/external/rentcast-mcp.ts`) | No official npm SDK; generated OpenAPI client is the SDK-equivalent; official MCP server exists | `RENTCAST_USD_PER_REQUEST=$0.074` (`lib/property/rentcast.ts:124`); `meterVendorSpend` | **Already typed-client + MCP** (wave 69 ruling: "MCP calls are API requests at the same per-request price PLUS LLM tokens... production pulls stay on the typed REST client"). No change this wave. |
| ElevenLabs | platform (`ELEVENLABS_API_KEY`) | Was raw REST at ~13 call sites; browser SDK `@elevenlabs/client` already present for client-side widgets | **`@elevenlabs/elevenlabs-js`** (server) | `ELEVENLABS_USD_PER_1K_CHARS=$0.10` (`lib/video/realism-profile.ts:1294`), `PLATFORM_VENDOR_RATES.elevenlabs=$0.00018/char` (`lib/vendor-governance/meter-vendor.ts:70`); `meterVendorSpend` | **Adopted this wave.** Installed `@elevenlabs/elevenlabs-js@2.68.0`. One adapter `lib/providers/elevenlabs/client.ts`. 5 call sites migrated (buffered TTS ×3, with-timestamps ×1, voice listing ×1). Streaming TTS and two multipart endpoints (voice clone, Scribe STT) **kept on REST** — see §"Not migrated" below. |
| Twilio | platform (master) / **tenant** (BYO / subaccount — resolved by `lib/voice/twilio-tenancy.ts`, the one resolver) | Was raw REST at ~9 real egress call sites (form-encoded through the connector gateway) | **`twilio`** (official) | `PLATFORM_VENDOR_RATES.twilio_voice=$0.02/min` (`lib/vendor-governance/meter-vendor.ts:71`); Twilio local number ≈ $1.15/mo (`lib/voice/twilio-tenancy.ts:155`) | **Adopted this wave.** Installed `twilio@6.1.1`. One adapter `lib/providers/twilio/client.ts`. 9 call sites migrated across 6 files (subaccount create, number webhook bind, dial, hangup, number search/purchase/release, warm-transfer bridge dial, live-call recording arm). `lib/voice/a2p-registration.ts`'s ~600-line TrustHub/Messaging ISV step machine **kept on REST** — see below. |
| D-ID | platform | Raw REST (`lib/providers/dispatch.ts`, `lib/did/*`) | **No official Node SDK** (only a browser `@d-id/client-sdk`, already installed and unrelated — server-side talk/stream calls have no server SDK) | `DID_USD_PER_STREAMING_MINUTE` derived from the official Scale-monthly plan table (`lib/video/realism-profile.ts:1335`, ≈$0.495/min); `DID_USD_PER_VIDEO_SECOND=$0.05` | **Keep REST** — no vendor-published server SDK exists. Confirmed by prior-wave research (LANE_RULES wave 70: "D-ID has no official Node SDK (REST stays)"). Never touched `app/api/did/create-avatar` / `lib/did/consent.ts` per lane restriction. |
| Simli | platform | Raw REST (`lib/providers/simli/*`) for the face-render API; `simli-client` (browser WebRTC SDK) already installed for the live-stream leg | `simli-client` covers the **browser** streaming leg only; no server SDK for `/faces/trinity` compose/generation-status | n/a — backup provider, not yet in production traffic (wave 62: D-ID primary, Simli fail-over) | **Keep REST** for the server-side compose/generation-status calls — no server SDK exists; `simli-client` (already installed) is correctly scoped to the browser leg only. |
| ZenRows | platform (`ZENROWS_API_KEY`) | Was raw REST at 2 call sites | **`zenrows`** (official) | `ZENROWS_CALL_COST_USD=$0.01/call` (`app/actions/lead-intelligence.ts:721`), `cost: 0.01` in `lib/external/zenrows-client.ts`; `meterVendorSpend` | **Adopted this wave.** Installed `zenrows@2.0.3` (small dep tree — `fastq`, `fetch-retry`). One adapter `lib/providers/zenrows/client.ts`. 2 call sites migrated (`lib/external/zenrows-client.ts::scrapeWithZenRows`, `app/actions/lead-intelligence.ts` Nextdoor scrape). |
| Zyte | platform (`ZYTE_API_KEY`) | Raw REST (`lib/external/zyte-client.ts`, ZenRows fallback per wave 65) | **No official Node SDK** (Zyte publishes a Python `zyte-api` package and a Scrapy integration; no npm package) | Not yet in production volume (fallback-only) | **Keep REST** — no official SDK exists for Node. |
| Apify | platform (`APIFY_API_TOKEN`, resolved via `lib/env/aliases.ts`) | Was raw REST at 3 call sites | **`apify-client`** (official) | `cost: 0.50` per actor run (`lib/external/apify-client.ts`); `meterVendorSpend`/vendor ledger at call sites | **Adopted this wave.** Installed `apify-client@2.25.0` (heavier dep tree — `@crawlee/types`, `proxy-agent`, `ws`, `@apify/*` — all server-only, never bundled to the browser; see bundle note below). One adapter `lib/providers/apify/client.ts`. 3 call sites migrated (`lib/external/apify-client.ts::runApifyActor`, `lib/external/apify-actors.ts::checkActorExists`, `lib/content-intel/apify-scraper.ts::runApifyScrape`). |
| Exa | platform (`EXA_API_KEY`) | Was raw REST at 2 call sites | **`exa-js`** (official) | `costDollars.total` returned per-call (actual), `0.005 × numResults` fallback estimate; `meterVendorSpend` | **Adopted wave 70B.** Installed `exa-js@2.21.0`. One adapter `lib/providers/exa/client.ts` (a typed `neuralSearch` plus a `rawSearch` escape hatch for the content-intel caller's extra params — type/useAutoprompt/category/excludeDomains/includeText). Call sites: `lib/external/exa-client.ts::exaSearch`, `lib/content-intel/exa-scraper.ts::exaSearch`, and (**lane 73D**, wave 73 owner ruling "exa is good at looking for leads like permit") `lib/lead-pipeline/permit-sourcer.ts::sourcePermitPrelistingIntent` — territory-centric permit/probate/coming-soon/contractor-bid seller-intent search via `exaSearch`, same adapter, same unit price, no second Exa client. **Bundle note**: `exa-js` pulls in `openai` as a transitive dependency (unused by this adapter) — server-only, dynamically imported, never shipped to the browser; see below. |
| Stripe | platform | **SDK** (`stripe@20.4.1`) + `@stripe/stripe-js`/`@stripe/react-stripe-js` (client) | `stripe` | Stripe's own metered billing | **Already SDK.** No change. |
| Supabase | platform | **SDK** (`@supabase/supabase-js@2.76.1`, `@supabase/ssr`) | `@supabase/supabase-js` | n/a (project-hosted) | **Already SDK.** No change. |
| Vercel AI Gateway | platform | **SDK** (`ai@6.x`, `@ai-sdk/gateway`, `@ai-sdk/react`) — every model call in `lib/ai/models.ts` | `@ai-sdk/gateway` (owner-designated, wave 59: "AI SDK 6 IS the chosen SDK") | Per-model prices in `lib/ai/cost-tracking.ts` | **Already SDK, owner-mandated.** No change; no provider SDK is ever used for model calls (`streamTextRouted`/`generateTextRouted` only). |
| PeopleData(Labs) | platform | **SDK** (`peopledatalabs@14.6.0`, `lib/providers/peopledata/client.ts::enrichPerson`) for person/enrich; REST kept for email/validate | `peopledatalabs` | `meterVendorSpend`-adjacent cost constants stay in `lib/external/peopledata-client.ts` (0.25/0.10/0.01 per call-kind, unchanged) | **Adopted wave 71A.** `lib/external/peopledata-client.ts::skipTraceWithPeopleData` migrated. `validateEmailViaPeopleData` (GET `email/validate`) **stays REST** — the SDK exposes no `email` namespace at all (verified by reading its bundled `dist/index.cjs`: `person`/`company`/`school`/`location`/`autocomplete`/`jobTitle`/`jobPosting`/`ip` only, no email-validation method). |
| Google Ads connector | tenant (brokerage's own ad account, OAuth) | Raw REST (`lib/ads/connectors/google.ts`) | Google's official Node library is `google-ads-api` (community-maintained wrapper around the gRPC/REST API) — no first-party lightweight Google package; OAuth token refresh already hand-rolled here | Ad spend is the brokerage's own (not platform-metered) | **Keep REST** — no first-party Google SDK for Ads API in Node exists; adding a third-party wrapper is a new trust boundary for a tenant-credentialed, OAuth-token-bearing connector. Recorded as unresolved-for-adoption rather than migrated. |
| Meta (Graph + Marketing API) | tenant (brokerage's own ad account / social page, OAuth) | **SDK** (`facebook-nodejs-business-sdk@24.0.1`, `lib/providers/meta/client.ts` — the generic `FacebookAdsApi.call()` transport, not entity-typed classes) for 15 of 20 call sites; REST kept for OAuth code/long-lived-token exchange (5 sites) | `facebook-nodejs-business-sdk` | Ad spend / social posting is the brokerage's own (not platform-metered) | **Adopted wave 71A** across `lib/ads/connectors/meta.ts`, `lib/ads/ad-lead-intake.ts`, `lib/social/{analytics-sync,dm-dispatch,publisher}.ts`, `lib/platform/platform-social.ts` (5 of its 6 sites), `app/api/cron/audience-sync-runner/route.ts`, `app/api/integrations/oauth/[provider]/route.ts` (1 of its 2 sites). **Kept on REST**: `lib/social/token-refresh.ts` (`fb_exchange_token` sweep), `lib/social/oauth-config.ts` (config string, no live call), `platform-social.ts::exchangeMetaLongLivedToken`, the shared multi-provider OAuth code exchange in `app/api/integrations/oauth/[provider]/route.ts` — `FacebookAdsApi` always requires an access token already in hand to construct, so it structurally cannot express the call that MINTS/renews one. **Version note**: the SDK pins Graph API v24.0; migrated call sites were previously pinned to v18.0/v19.0 raw REST — Graph API versions are additive/back-compatible for the fields used here, and riding the SDK's own current version is the intended behavior of adopting it, not a side effect. **v25 caveat** (integrator research): Advantage+ Shopping/App campaigns cannot be created via the Marketing API at all as of v25 — a platform-side restriction, not a consequence of this migration; noted in `lib/ads/connectors/meta.ts`. **No TypeScript types ship with the package** (no `"types"` field, no `.d.ts`, no `@types` package) — `types/facebook-nodejs-business-sdk.d.ts` declares only the `FacebookAdsApi` surface this adapter uses. |
| HubSpot CRM | tenant (brokerage's own private-app token) | **SDK** (`@hubspot/api-client@14.0.1`, `lib/providers/hubspot/client.ts`) | `@hubspot/api-client` | Tenant's own HubSpot plan (not platform-metered) | **Adopted wave 71A; sync-OUT ONLY as of wave 72A.** `lib/crm/providers/hubspot.ts::syncContactToHubSpot` (batch-upsert-by-email + plain create) is the ONLY HubSpot direction. Wave 72A retired the inbound pull (`lib/crm/import-pull.ts::pullHubSpot` + the adapter's `listContactsPage`) per the owner's verbatim ruling: "hubspot is only sync out to hubspot." Tombstones: `lib/crm/import-pull.ts` (header) and `lib/providers/hubspot/client.ts` (above `upsertContactByEmail`), both naming `lib/crm/providers/hubspot.ts:25` as the survivor. The superadmin white-glove migration panel (`tenant-crm-pull-panel.tsx`) no longer lists HubSpot as an import source — only Follow Up Boss / Lofty / GoHighLevel remain inbound-pullable. |
| Lob (US address verification) | platform (`LOB_API_KEY`) | **SDK** (already-installed `lob@^6.6.3`, `lib/providers/lob/client.ts`) | `lob` | `LOB_USD_PER_VERIFICATION≈$0.0025` (production; free in test mode) — `lib/external/lob-address-verify.ts` | **Adopted wave 71A** — the SAME already-installed SDK `lib/providers/dispatch.ts` already used for postcard/letter sends, now also used for `lib/external/lob-address-verify.ts::verifyAddressViaLob` (`us_verifications`), which had been hand-building that one call through the connector gateway despite the SDK sitting unused in `package.json`. No new package installed. `lob@6.6.3`'s own `engines` field requires Node `>= 10.0.0` (verified via `npm view lob@6.6.3 engines`) — compatible with this repo's Node 22; the lob-node README's "Node >= 24.15.0" notice describes the LATER v8.x line (verified `npm view lob version` = 8.1.1), which this repo deliberately stays off per the task's instruction to keep v6. |
| QuickBooks (Intuit) | tenant (brokerage/team/agent/vendor's own QBO company, OAuth) + platform (company books, `platform_quickbooks` key) | **SDK** (`intuit-oauth@4.2.5`, `lib/providers/quickbooks/client.ts`) for the OAuth token-REFRESH call only; REST kept for the QBO business-object calls and the OAuth code exchange | `intuit-oauth` (Intuit's ONLY official Node package) | Tenant's own QBO plan (not platform-metered) | **Adopted wave 71A**, narrowly. `intuit-oauth` is Intuit's only official package and covers OAuth 2.0/OpenID lifecycle (authorize URL, token exchange, refresh, revoke) — NOT the QBO accounting-object REST surface (customer/invoice/purchase/journal-entry/company-info). `node-quickbooks@2.0.50` (the community REST wrapper, author Michael Cohen, NOT Intuit) was verified via `npm view` and its API shape inspected (installed, then **uninstalled** once this split was confirmed) — declined under the official-SDK ruling because it is not Intuit's own package. `lib/providers/accounting/quickbooks.ts::refreshAccessToken` and `lib/connections/accounting-scopes.ts::ensureFreshQuickBooksToken` both migrated to `refreshQuickBooksToken`. **Kept on REST**: both files' business-object `request()`/`qboRequest()` methods (`quickbooks.api.intuit.com`) — no official Intuit SDK exists for that surface — and the shared multi-provider OAuth CODE exchange in `app/api/integrations/oauth/[provider]/route.ts` (not QuickBooks-specific code). |

## Other vendors found via the grep sweep (lower volume — not individually researched this wave unless noted)

`api.twitter.com`(3), `api.linkedin.com`(3), `api.sendgrid.com`(7),
`api.hubapi.com` — **adopted wave 71A**, see the core-providers table above
(`@hubspot/api-client`), `api.pinterest.com`(2), `api.lob.com` — **adopted
wave 71A** (the already-installed `lob@^6.6.3`, not `@lob/lob-typescript-sdk`
— that package was never installed; this repo's existing `lob` dependency
already covers the same v1 API), `api.intuit.com` — **adopted wave 71A** for
the OAuth token-refresh leg only (`intuit-oauth`; `node-quickbooks` verified
and declined as a community, non-Intuit package — see the core-providers
table above), `api.idxbroker.com`(3, tenant IDX credential — no SDK published),
`api.skyslope.com`(4), `api.brokermint.com`(3), `api.formsimplicity.com`(2),
`api.showingtime.com`(2), `api.followupboss.com`(2), `api.geoapify.com`(2),
`api.tavily.com`(2), `api.qrserver.com`(2, unauthenticated QR image
generator — no SDK needed), `api.perplexity.ai`(1, AI provider — routes
through the AI Gateway per the wave-59 ruling, not a direct SDK candidate),
`api.openai.com`(3, same — Gateway-routed), `api.heygen.com`(1, dead/legacy
per the HeyGen purge, kept only for a training-video URL check),
`api.zillow.com`/`api.trulia.com`/`api.redfin.com`/`api.realtor.com`/`api.mls.com`
(1 each — comparison/attribution text, not live egress), `api.telnyx.com`(1),
`api.slybroadcast.com`(1), `api.xero.com`(1), `api.vercel.com`(1, deployment
API), `api.anthropic.com`(3 — prose/comments, model calls are Gateway-routed
per wave 59, never a direct Anthropic SDK call in this repo).

None of these were migrated this wave — recorded as **unresolved** (§1 orphan
doctrine: prove before deciding, not guess) rather than a verdict, because
none were in the task's named list and none were researched deeply enough
this wave to state a priced verdict.

## Adopted this wave — packages installed

| Package | Version | Adapter |
|---|---|---|
| `twilio` | ^6.1.1 | `lib/providers/twilio/client.ts` |
| `@elevenlabs/elevenlabs-js` | ^2.68.0 | `lib/providers/elevenlabs/client.ts` |
| `apify-client` | ^2.25.0 | `lib/providers/apify/client.ts` |
| `zenrows` | ^2.0.3 | `lib/providers/zenrows/client.ts` |
| `exa-js` | ^2.21.0 | `lib/providers/exa/client.ts` |

`npm install` updated `package-lock.json`; no other `package.json` scripts
changed (per lane rule, proof registration lines are listed for the
integrator in the lane report, not self-applied).

## Wave 71A — the remaining five vendors

Owner ruling (verbatim, repeated 2026-09-17 wave 71): *"for any of our
providers for platform, if there is an sdk option, we should use that…
keeping pricing in mind."* Closes the five vendors wave 70B time-boxed
(PeopleDataLabs, Meta, HubSpot, Lob, QuickBooks) — see the core-providers
table above for the per-vendor verdict rows, now updated in place. This
section carries the packages installed, the bundle notes, and the call-site
counts specific to this wave; lane report has the full per-file detail.

### Packages verified + installed

| Package | Verified version (`npm view`) | Adapter | Verdict |
|---|---|---|---|
| `peopledatalabs` | 14.6.0 | `lib/providers/peopledata/client.ts` | Installed. |
| `facebook-nodejs-business-sdk` | 24.0.1 | `lib/providers/meta/client.ts` | Installed. |
| `@hubspot/api-client` | 14.0.1 | `lib/providers/hubspot/client.ts` | Installed. Loaded via `createRequire` with a narrow local type surface — a type-space import of the SDK root walks its 2,938 generated `.d.ts` files and pushed the full `tsc --noEmit` past the 10,000 MB heap (GUARD_EXIT=134, wave-71 chain 1). |
| `intuit-oauth` | 4.2.5 | `lib/providers/quickbooks/client.ts` | Installed. |
| `node-quickbooks` | 2.0.50 | — | **Verified, installed, then UNINSTALLED.** Community package (Michael Cohen), not published by Intuit — declined under the official-SDK ruling once `intuit-oauth`'s narrower, actually-official split (token lifecycle only) was confirmed as correct. Its API shape (`QuickBooks(consumerKey, consumerSecret, token, tokenSecret, realmId, useSandbox, debug, minorversion, oauthversion, refreshToken)`, callback-style `createCustomer`/`createInvoice`/`createPurchase`/`createJournalEntry`/`getCompanyInfo`) was inspected before the decision, not skipped. |
| `lob` | already `^6.6.3` in `package.json` | `lib/providers/lob/client.ts` | Kept at v6, per the task's instruction — NOT upgraded to the current 8.1.1. `lob@6.6.3`'s own `engines` field requires Node `>= 10.0.0` (verified via `npm view lob@6.6.3 engines`), compatible with this repo's Node 22 runtime; the lob-node README's "Node >= 24.15.0" notice describes the v8.x line this repo deliberately stays off. |

`npm install` / `npm uninstall` updated `package.json` + `package-lock.json`
(1607 packages added, 12 removed on the `node-quickbooks` uninstall).
`package.json` scripts + the `guard` chain tail + `MAINTENANCE_DOMAINS` ARE
self-applied this wave (per this lane's explicit task instructions, which
supersede the general "list lines for the integrator" lane convention) — see
`test:sdk-rollout-2` / `sdk_rollout_part2` in `lib/kernel/manager-registry.ts`.

### Bundle-impact notes (wave 71A packages)

- `facebook-nodejs-business-sdk` ships NO TypeScript types (no `"types"`
  field, no `.d.ts` anywhere in its published tree, no `@types` package on
  the registry). `types/facebook-nodejs-business-sdk.d.ts` declares only the
  `FacebookAdsApi` transport surface `lib/providers/meta/client.ts` actually
  calls — not the full SDK.
- `@hubspot/api-client`'s HTTP transport (`Transport.js`) calls the global
  `fetch` directly (no axios/node-fetch dependency) — the ONE wave-71A
  adapter whose network calls a `globalThis.fetch` mock can still intercept,
  though the SDK's stricter Response contract (it reads
  `response.headers.forEach(...)`) means a bare `{ok, status, json}` mock
  object is not enough; a real `Headers` instance is required, which is why
  `scripts/scraper-simulator.ts`'s HubSpot block moved off a request-shape
  mock onto source-text assertions rather than trying to satisfy that
  contract.
- `facebook-nodejs-business-sdk` and `intuit-oauth` both transport over
  `axios`, NOT `globalThis.fetch` — a fetch mock cannot intercept either.
  Both adapters' own explicit `if (!credential) return { ok: false, … }`
  guards (proved in `scripts/sdk-rollout-part2-simulator.ts` §1) are what
  actually proves "no network call without a credential" for these two.
- `lob` and `peopledatalabs` are lightweight (a handful of direct
  dependencies each, `axios`-based) — no concern.
- No provider's SDK was rejected for being heavy this wave either; all four
  installed packages are reached only from server-side code (adapters,
  server actions, API routes, cron routes), never a client component.

### Call-site migration counts (wave 71A)

| Provider | Adapter file | Call sites migrated | Kept on REST (documented) | Files touched |
|---|---|---|---|---|
| PeopleDataLabs | `lib/providers/peopledata/client.ts` | 1 | 1 (`email/validate` — no SDK method) | `lib/external/peopledata-client.ts` |
| Lob | `lib/providers/lob/client.ts` | 1 | 0 | `lib/external/lob-address-verify.ts` |
| HubSpot | `lib/providers/hubspot/client.ts` | 1 | 0 | `lib/crm/providers/hubspot.ts` (1) — sync-OUT only as of wave 72A; `lib/crm/import-pull.ts`'s inbound pull was retired (tombstone naming this survivor) |
| QuickBooks | `lib/providers/quickbooks/client.ts` | 2 | 4 (QBO business-object calls in both files, ×2 each) | `lib/providers/accounting/quickbooks.ts` (1), `lib/connections/accounting-scopes.ts` (1) |
| Meta | `lib/providers/meta/client.ts` | 15 | 5 (OAuth code + long-lived-token exchange across 4 files) | `lib/ads/connectors/meta.ts` (the shared `graph()` helper — all of that file's calls route through it), `lib/ads/ad-lead-intake.ts` (1), `lib/social/analytics-sync.ts` (2), `lib/social/dm-dispatch.ts` (2), `lib/social/publisher.ts` (4), `lib/platform/platform-social.ts` (5 of 6), `app/api/cron/audience-sync-runner/route.ts` (1), `app/api/integrations/oauth/[provider]/route.ts` (1 of 2) |

**21 call sites migrated across 12 files, 5 new adapter files (1 vendor,
Lob, reusing the already-installed package), 4 packages installed + 1
uninstalled.** No request shape, no price, no metering behavior changed at
any migrated call site — only the transport under each one (Meta's Graph API
VERSION did move from v18.0/v19.0 to the SDK's own v24.0 — see the
core-providers table row above for why that is the intended behavior of
adopting the SDK, not a regression).

### ElevenLabs re-judgment (wave 70B carve-outs, revisited)

The task asked this wave to re-judge the four wave-70B "kept on REST"
ElevenLabs/health-probe carve-outs. Verified live against the installed
`@elevenlabs/elevenlabs-js@2.68.0`: the SDK DOES now expose methods for all
three ElevenLabs sites (`textToSpeech.stream`/`streamWithTimestamps`,
`speechToText.convert`, `voices.ivc.create`) — so none of the three is "kept
on REST because no SDK method exists." Each is re-affirmed on REST for the
SAME reason wave 70B gave, which a version bump does not change:

1. **Streaming TTS** (`lib/voice/elevenlabs-tts.ts::synthesizeSpeechStream`).
   The SDK's `.stream()` exists, but `scripts/elevenlabs-egress-guard.ts`
   still pins exactly ONE raw `fetch` literal as its wave-62-lesson positive
   control — migrating the call site without first re-anchoring that guard
   would blind it, not just change its shape. A guard rewrite is a
   coordinated change outside this lane's scope; re-affirmed REST.
2. **Multipart uploads** (Instant Voice Clone `voices.ivc.create`, Scribe STT
   `speechToText.convert`). The SDK now has both methods, but the connector
   gateway's multipart path (m333) still carries self-healing field-rename
   detection and connector-health telemetry on a real-money,
   durable-asset-creating call that neither SDK method replaces — migrating
   would remove that telemetry for no price change. Re-affirmed REST.
3. **ElevenLabs Conversational AI + the cross-vendor health-probe
   framework.** Unchanged from wave 70B's reasoning — the probes
   deliberately treat every provider identically through the gateway so one
   health-check contract covers all vendors; Conversational AI's
   agent/knowledge-base management (797 lines) was not re-scoped this wave.
   Re-affirmed REST, still architecturally out of scope for a per-vendor
   adapter pass.

## Bundle-impact check (heavy/incompatible dependency review)

- `apify-client` pulls `@crawlee/types`, `@apify/log`, `@apify/consts`,
  `proxy-agent`, `ws`, `ansi-colors`, `async-retry`, `content-type`,
  `type-fest`, `ow` — none of these are browser-safe assumptions, but every
  call site that imports `lib/providers/apify/client.ts` is itself a server
  action / API route / cron-only lib file (never a client component), so
  webpack never pulls it into a client chunk. `npm install` reported 1541
  packages added in total across all five installs combined (transitive,
  mostly from `apify-client`'s Crawlee-family tree and `twilio`'s
  `https-proxy-agent`/`jsonwebtoken` chain) — none flagged as incompatible
  with a Next.js server route; no `npm ls` peer-dependency conflict was
  reported.
- `exa-js` pulls in `openai` (unused by this adapter — `exa-js` uses it only
  for its own OpenAI-tool-format helpers, which this repo never calls). Kept
  because every caller reaches it through a dynamic `await import(...)` from
  server-only code; the extra install-size cost is real but does not reach
  the client bundle.
- `zenrows` and `@elevenlabs/elevenlabs-js` are lightweight (2-3 direct
  dependencies each) — no concern.
- `twilio`'s dependency tree (`axios`, `jsonwebtoken`, `xmlbuilder`, `qs`,
  `dayjs`, `https-proxy-agent`) is the vendor's own standard shape — no
  surprises.

No provider's SDK was rejected for being heavy — every one of the five
adopted here is reached only from server-side code, and none of it reaches a
client bundle. **None of the five new adapters carries an `import
"server-only"` directive**, deliberately: that directive throws
unconditionally under plain Node/tsx execution (outside Next's webpack build,
where it is normally a no-op until client-bundled), and this repo's proof
scripts load modules directly via tsx — a static import of an adapter from a
file a proof script statically reaches (found live: `lib/external/apify-
client.ts`, reachable from `lib/platform/provider-posture.ts`'s chain, which
`test:provider-readiness` walks) would crash that proof for a directive with
no real client-bundling risk to guard against here. See each adapter file's
own header for the full reasoning.

## Not migrated — explicit reasons (kept on REST)

1. **`lib/voice/a2p-registration.ts`** (Twilio TrustHub/Messaging ISV step
   machine, ~600 lines). The Node SDK does cover TrustHub/Messaging, but this
   file is a resumable, multi-step, contract-verified-line-by-line filing
   pipeline against an hours-to-days-async carrier review (10DLC brand +
   campaign + CNAM/SHAKEN). Re-deriving every field mapping in one lane pass
   is a correctness risk with no price or capability upside (an SDK swap
   changes neither). Left on its existing `twilio()` REST helper over the
   connector gateway.
2. **ElevenLabs streaming TTS** (`lib/voice/elevenlabs-tts.ts::synthesizeSpeechStream`).
   Documented single-egress exception (must hand back a live `Response` to
   stream chunks, which the buffering connector gateway can't express either
   way — REST or SDK). `scripts/elevenlabs-egress-guard.ts` pins exactly ONE
   raw `fetch(\`https://api.elevenlabs.io/...stream${suffix}\`)` literal as
   its positive control (wave 62 lesson) — replacing it with the SDK's
   `.stream()` would blind that guard, not just change its shape. Left as-is.
3. **ElevenLabs multipart uploads** — `app/api/elevenlabs/voice-clone/route.ts`
   (Instant Voice Clone, `/voices/add`) and `lib/repurpose/transcribe-core.ts`
   (Scribe STT, `/speech-to-text`). Both carry an explicit prior-wave comment
   committing to the connector gateway's multipart path (m333) specifically
   for its self-healing field-rename detection and connector-health
   telemetry on a real-money, durable-asset-creating call. Migrating would
   remove that telemetry for no price change. Left on REST.
4. **ElevenLabs Conversational AI** (`lib/elevenlabs/conv-ai.ts`, 797 lines —
   agent/knowledge-base management) and the **cross-vendor health-probe
   framework** (`lib/agentic-os/connector-probe.ts`, `connector-registry.ts`,
   `lib/platform/go-live-readiness.ts`, `app/api/admin/system/providers/test/route.ts`)
   — the probes deliberately treat every provider identically through the
   gateway so one health-check contract covers all vendors; making ElevenLabs
   (or Twilio) probes SDK-shaped would fragment that shared contract for a
   health ping, not a business call. Not migrated — time-boxed and
   architecturally out of scope for a per-vendor adapter pass.

## Call-site migration counts (this wave)

| Provider | Adapter file | Call sites migrated | Files touched |
|---|---|---|---|
| ElevenLabs | `lib/providers/elevenlabs/client.ts` | 5 | `lib/voice/elevenlabs-tts.ts` (2), `lib/providers/dispatch.ts` (1), `app/actions/avatar-voice-catalog.ts` (1), `app/actions/podcast-generation.ts` (1) |
| Twilio | `lib/providers/twilio/client.ts` | 9 | `lib/voice/twilio-tenancy.ts` (1), `lib/voice/twilio-voice.ts` (1), `lib/voice/twilio-outbound.ts` (2), `lib/voice/number-provisioning.ts` (3), `lib/voice/warm-transfer.ts` (1), `lib/voice/call-recording.ts` (1) |
| Apify | `lib/providers/apify/client.ts` | 3 | `lib/external/apify-client.ts` (1), `lib/external/apify-actors.ts` (1), `lib/content-intel/apify-scraper.ts` (1) |
| ZenRows | `lib/providers/zenrows/client.ts` | 2 | `lib/external/zenrows-client.ts` (1), `app/actions/lead-intelligence.ts` (1) |
| Exa | `lib/providers/exa/client.ts` | 2 | `lib/external/exa-client.ts` (1), `lib/content-intel/exa-scraper.ts` (1) |

**21 call sites migrated across 15 files, 5 new adapter files, 5 packages
installed.** No request shape, no price, no metering behavior changed at any
migrated call site — only the transport under each one.
