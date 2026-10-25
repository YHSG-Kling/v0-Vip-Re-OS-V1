# Versium REACH — capability matrix (product semantics, wiring, MCP tool list)

**Wave 144, lane 144E.** Internal. Documentation of what the code already holds — nothing here configures Versium, buys
credits, sets a key or changes a price. **The code is the source of truth**: `lib/external/versium-client.ts`
`VERSIUM_PRODUCT_MATRIX` and `VERSIUM_REACH_MCP`. `scripts/versium-capability-matrix-guard.ts` section O fails if a row
below disagrees with the code (status per product, every MCP tool listed). Supersedes the wave 143D framing in two places
the owner corrected (ruling 10): the **Estimate API is a count**, and **Online Audience Append is a match + append, not
targeting**.

**Sources read 2026-10-25** (Exa fetch / direct GET; the vendor pages carry no publication date):
api-documentation.versium.com — `/llms.txt`, `/docs/the-versium-api-landscape`, `/reference/online-audience-append-api-new`,
`/reference/output-sample-new`, `/reference/estimates-api`, `/reference/b2c-listgen-demographic-filter-parameters`,
`/reference/demographic-append-api`, `/reference/demographic-output-sample`, `/reference/hashed-input-support`;
reach-help.versium.com — `/docs/match-value-conversion-table`, `/docs/create-an-online-audience`, `/docs/mcp-overview`,
`/docs/setup-with-claude`; versium.com — `/versium-reach-mcp/`, `/blog/versium-launches-versium-reach-mcp-server/`;
glama.ai — `/mcp/connectors/com.versium.app/versium-reach` (third-party registry, OAuth-authenticated inspection, last
tested 2026-10-25); live unauthenticated probes of `app.versium.com` OAuth metadata (2026-10-25).

---

## 1. What each product IS (the semantics the code now encodes)

| Family | What it returns | What it is NOT | Code |
|---|---|---|---|
| **Contact Append** (`/v2/contact`) | e-mail / phone / mobile / address for a person we hold; 1 credit per matched output | not a list; a `phone` may be a landline (the DNC / line-type scrub decides dialling) | `appendVersiumContact` → `owner_contact`, `reverse_contact` |
| **Demographic Append** (`/v2/demographic`: `demographic`, `financial`, `lifestyle`, `political`, `full_demographic`) | basic (DOB **year + month only**, age range, gender, education, marital…), household / financial / auto (income, net worth, modeled credit rating, home + mortgage facts), lifestyle, political / donor; 1 credit per category (cap 2 per record), full demographic 3 | the modeled credit band is a marketing estimate (never a decision input); political / donor is never bought; protected characteristics never leave the adapter | `appendVersiumDemographics`, `appendVersiumFinancial`, `appendVersiumRealEstateIndicators` |
| **Property facts** (address-keyed `financial`) | year built, dwelling type, purchase date | never a valuation (RentCast → BatchData own `property_valuation`) | `appendVersiumPropertyFacts` → `property_facts` |
| **Online Presence** (`full_demographic` allow-list) | "Online Presence Indicator - Real Estate", investing, tenure, home-improvement, online purchasing, mortgage purchase / refinance dates | a research / intent signal, never a targeting segment | `online_presence` → `online-presence-store.ts` |
| **Online Audience Append** (`/v2/onlineAudience`) | a **MATCH** of a person we already hold to their online profiles, and the matched **hashed identifiers** (SHA-256; MD5 for AdRoll) per ad platform — facebook, google, linkedin, tiktok, adroll, generic, original; 1 credit per matched record | **not targeting** (it selects nobody); **not an address** — the vendor: "not appropriate for direct email campaigns"; plaintext the vendor returns (Google Zip/Country, LinkedIn names/title/employer) is **dropped** | `appendVersiumOnlineAudience` → `online_audience_match` → `online-audience-store.ts` (appended to `contacts.enrichment_profile.online_audience`) |
| **B2C ListGen Estimates** (`/v2/b2cListGen/estimate`) | a **NUMBER**: estimated records, records available, the match credits the LIST JOB would bill, the job's run time — free, unlimited | **no contact is returned, imported, enriched or purchased**; the masked preview is never requested | `estimateVersiumAudience` → `audience_estimate` (typed `kind: "count"`, `contactsReturned: 0`, provenance: query_id + criteria + retrieved-at) |
| **B2C ListGen job** (`/v2/jobs`, download) | a purchased consumer list ("you agree to be charged based on the results") | never unattended — a human approves money | not built (OWNER_DECISION) |
| **Email Validation** | deliverability (0.5 credit) | — | PeopleData ($0.01) is the cheaper survivor |
| **Firmographic · C2B · IP-to-Domain · HEM-to-Business-Domain** | business facts / domains (3 credits; HEM 1) | no consumer real-estate flow needs them | not built (no caller / not applicable) |
| **ABM / B2B Persona list gen** | paid B2B lists (incl. an `oa` online-audience output) | — | not built (no caller) |
| **Data Prep · Dedupe · Suppression Lists · Bulk jobs** | file-level hygiene / suppression for Versium-generated lists | — | in-house survivors / no caller |

**Credit weights** — `VERSIUM_CREDIT_WEIGHTS`, from the vendor's Match Credits Value Conversion Table; one credit is booked at the
credit-package ceiling `$0.05` (`VERSIUM_MATCH_CREDIT_USD`); a no-match is free.

## 2. The matrix (generated from `VERSIUM_PRODUCT_MATRIX`)

| Product | Name | Interface · endpoint | Status | Capability | Caller | Credits (published) |
|---|---|---|---|---|---|---|
| `contact_append` | Contact Append | rest · GET /v2/contact | WIRED | owner_contact | lib/ai-isa/property-lookup-rail.ts `runVersiumContactLeg` | contact_email 1, contact_phone 1, contact_email_multi_per_email 1 |
| `demographic_append` | Demographic Append (basic, household / financial / auto) | rest · GET /v2/demographic | WIRED | owner_contact | lib/ai-isa/property-lookup-rail.ts `appendVersiumDemographics` | demographic_category 1, demographic_multi_category_cap 2, financial 1 |
| `property_facts` | Property facts (address-keyed financial output) | rest · GET /v2/demographic?output[]=financial (address) | WIRED | property_facts | lib/avm/provider-chain.ts `appendVersiumPropertyFacts` | financial 1 |
| `full_demographic` | Full Demographic Insights — Online Presence Indicator (Real Estate) and online behaviour | rest · GET /v2/demographic?output[]=full_demographic | WIRED_143D | online_presence | lib/kernel/lookalike-audience.ts `runVersiumOnlinePresenceLeg` | full_demographic 3 |
| `b2b2c_append` | B2B2C Crosswalk Append | rest · GET\|POST /v2/b2b2cAppend | WIRED | business_identity | app/actions/business-card/business-card-actions.ts `runVersiumBusinessIdentityLeg` | b2b2c_business_email 2, b2b2c_consumer_mobile 1, b2b2c_consumer_email 1, b2b2c_consumer_address 1, b2b2c_crosswalk 1 |
| `b2c_listgen_estimate` | B2C ListGen (Consumer Audience Builder) — Estimates API | rest · GET /v2/b2cListGen/estimate | WIRED_143D | audience_estimate | lib/kernel/lookalike-audience.ts `runVersiumAudienceEstimateLeg` | — (free) |
| `b2c_listgen_job` | B2C ListGen — list-generation job + status + download | rest_async_job · POST /v2/jobs · GET /v2/jobs/{id} · GET /v2/lists/{id}/download | OWNER_DECISION | — | — | cab_per_contact_point 1, cab_per_demographic_category 1 |
| `bulk_append_jobs` | Bulk Upload API (file-based contact / demographic append jobs) | rest_async_job · POST /v2/lists · POST /v2/jobs?operation=b2cContactAppend\|b2cDemographicAppend | NOT_BUILT_NO_CALLER | — | — | contact_email 1, contact_phone 1, demographic_category 1 |
| `online_audience_append` | Online Audience Append (hashed identifiers for ad platforms) | rest · GET /v2/onlineAudience | WIRED_144E | online_audience_match | lib/enrichment/online-audience-store.ts `runVersiumOnlineAudienceLeg` | online_audience 1 |
| `predictive_scores` | Predictive Scores (wealth, DIY, online shopper, new-tech, green, travel, auto-finance, donor) | rest · GET /v2/predictiveScores | WAITING_EXTERNAL | — | — | — (weight unpublished) |
| `email_validation` | Email Validation API | rest · GET /v2/emailValidation | NOT_ROUTED_SURVIVOR | email_validation | — | email_validation 0.5 |
| `b2b_append_family` | Firmographic Append · Consumer-to-Business (C2B) Append | rest · GET /v2/firmographic · GET /v2/c2b | NOT_BUILT_NO_CALLER | — | — | firmographic 3, c2b 3 |
| `visitor_to_company` | IP-to-Domain (+ Firmographic) · HEM-to-Business-Domain | rest · GET /v2/ip2domain · GET /v2/hemToBusinessDomain | NOT_APPLICABLE | — | — | ip2domain_firmographic 3, hem_to_business_domain 1 |
| `abm_persona_listgen` | Account-Based List (ABM) · B2B Persona list generation | rest_async_job · POST /v2/jobs (b2b list gen) | NOT_BUILT_NO_CALLER | — | — | abm_business_email 2, persona_business_email 2, online_audience 1 |
| `dataprep_dedupe` | Data Prep · Deduplication | rest_async_job · POST /v2/jobs?operation=dedupe · DataPrep API | NOT_ROUTED_SURVIVOR | — | — | — |
| `suppression_lists` | Suppression List API | rest · POST\|GET\|DELETE /v2/suppression-lists | NOT_BUILT_NO_CALLER | — | — | — |
| `reach_mcp` | Versium REACH MCP server | mcp · https://app.versium.com/mcp/reach | WAITING_EXTERNAL | — | — | — |
| `sdk` | Official SDK | sdk · — | NOT_APPLICABLE | — | — | — |

## 3. The Online Audience Append — what lands on the record, and what never does

- **Asked only on a REQUIRED GAP** (`online-audience-store.ts appendOnlineAudienceForContact`, run by the contact enrichment
  pass after its own write): the tenant runs a governed customer-list audience (`facebook_custom_audiences` with a consent
  basis, not a look-alike, approved / synced / pending review) on a platform Versium serves; only those platforms' sections
  are requested (`rcfg_oa_services[]`); the contact's block is absent or older than 180 days (`PROVIDER_FRESHNESS_DAYS`). A
  tenant that advertises nowhere pays nothing.
- **Stored**: `contacts.enrichment_profile.online_audience` — `{ provider, captured_at, matched, services_asked, identifiers:
  { <service>: { email_sha256[], phone_sha256[], first_name_sha256[], …, email_md5[], maid_idfa[], maid_gaid[] } },
  identifier_count, query_id, dropped }`, provenance at `field_provenance.online_audience`. No column is written.
- **Never**: an e-mail address or a phone number (hash shapes only, re-validated on read); a plaintext name / title / employer;
  an input to any e-mail / SMS / voice resolver (the guard proves no channel module imports the store or reads the key).
- **Only the asked sections are stored** — a vendor answer wider than the request never widens the record.
- **Downstream targeting** is the separate governed act — `lib/kernel/ads.ts syncAudience` (consent basis, fair-housing refusal,
  persona basis) — which may add the stored keys for its platform (`online-audience-store.ts onlineAudienceMatchKeysFor`, the
  `HashedMatchKey` shape of `lib/ads/connectors/pii.ts`) beside the keys it hashes itself. That read is NOT wired at HEAD
  (outside this lane's files): the function stays module-private — it feeds `onlineAudienceSummary.matchKeysByPlatform` — until
  the wire that exports and reads it lands.

## 4. The REACH MCP — transport, auth, and the ACTUAL tool list

- **Endpoint** `https://app.versium.com/mcp/reach`; **transport** Streamable HTTP (vendor: "The agent must support the Streamable
  HTTP transport method and OAuth dynamic client registration"; registry: "Streamable HTTP · MCP 2025-11-25").
- **Auth** (probed 2026-10-23 and 2026-10-25, identical): protected-resource metadata `scopes_supported ["mcp:use"]`;
  authorization server `grant_types ["authorization_code","refresh_token"]`, PKCE `S256`, registration `/oauth/register`;
  unauthenticated `initialize` → `401 WWW-Authenticate: Bearer realm="mcp"`. **No client-credentials grant → no server-side
  credential model → `WAITING_EXTERNAL`** (`VERSIUM_REACH_MCP.waitingOn`: an API-enabled subscription, one interactive OAuth
  consent, and the owner's decision on platform-vs-tenant ownership plus an encrypted refresh-token store).
- **Vendor exclusions** (versium.com/versium-reach-mcp FAQ): Data Prep (Cleanse/Dedupe), **Online Audience Append**, ABM list
  generation, **look-alike list generation** — verified ABSENT from the tool list below.
- **Tool list** (20 tools; `VERSIUM_REACH_MCP.tools`): `tools/list` needs a Bearer this platform cannot mint, so it is read from
  the vendor's MCP Server Overview ("Available Tools") and the Glama registry's authenticated inspection. Every tool performs an
  operation the REST API already exposes — not wiring the MCP loses no capability.

| MCP tool | Read-only | Same operation over REST (matrix product) | Verdict |
|---|---|---|---|
| `contact_append` | yes | `contact_append` | REST_SURVIVOR |
| `demographic_append` | yes | `demographic_append` | REST_SURVIVOR |
| `b2b2c_append` | yes | `b2b2c_append` | REST_SURVIVOR |
| `b2c_listgen_estimate` | yes | `b2c_listgen_estimate` | REST_SURVIVOR |
| `b2c_listgen_options` | yes | `b2c_listgen_estimate` | NO_CALLER |
| `b2b_listgen_estimate` | yes | `abm_persona_listgen` | NO_CALLER |
| `b2b_listgen_options` | yes | `abm_persona_listgen` | NO_CALLER |
| `c2b_append` | yes | `b2b_append_family` | NO_CALLER |
| `firmographic_append` | yes | `b2b_append_family` | NO_CALLER |
| `ip_to_domain_append` | yes | `visitor_to_company` | NOT_APPLICABLE |
| `email_validation` | yes | `email_validation` | SURVIVOR_ELSEWHERE |
| `create_job` | **no** | `b2c_listgen_job` | OWNER_DECISION |
| `job_status` | yes | `b2c_listgen_job` | OWNER_DECISION |
| `create_project` | **no** | `b2c_listgen_job` | OWNER_DECISION |
| `list_projects` | yes | `b2c_listgen_job` | OWNER_DECISION |
| `show_project` | yes | `b2c_listgen_job` | OWNER_DECISION |
| `list_lists` | yes | `b2c_listgen_job` | OWNER_DECISION |
| `show_list` | yes | `b2c_listgen_job` | OWNER_DECISION |
| `preview_list` | yes | `b2c_listgen_job` | OWNER_DECISION |
| `docs_search` | yes | — | NOT_APPLICABLE |

**Research ≠ activation.** Research (look-alike denominators), list generation (purchase), audience estimation (a count), append
(identifiers / facts onto a record we hold), enrichment, lawful outreach and ad deployment are distinct capabilities, each behind
its own gate; none of them authorises another.

## 5. Blind spots

- No Versium credential exists in this environment: no live append, estimate or MCP tool call was made. Response shapes are the
  vendor's documented samples re-typed; the MCP tool list is secondary (registry + vendor overview), not a live `tools/list`.
- The vendor pages carry no publication date; "read 2026-10-25" is the read date, not the page's.
- Predictive Scores' credit weight is unpublished (WAITING_EXTERNAL: the account representative's rate card).
