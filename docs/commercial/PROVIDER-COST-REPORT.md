# Provider Cost Report — verified prices, booked rates, and the gap between them

**Wave 143, lane 143I.** Research and documentation only. Nothing in this document configures a provider,
creates a Stripe object, buys a plan, sets an environment variable, or changes what a customer is charged.
**Price read date: 2026-10-23** unless a row says otherwise. Companion document:
[`PRICING-RECOMMENDATION.md`](./PRICING-RECOMMENDATION.md) (proposal, owner approval pending).

> This report is **INTERNAL**. It names providers and their unit costs. Customer-facing plan language lives in
> `PRICING-RECOMMENDATION.md` §8 and never names a provider (owner: provider-cost attribution stays separate
> from customer-facing language).

---

## 0. How to read this report

**Price states** (the repo's own vocabulary, `lib/vendor-governance/cost-normalizer.ts:32` — `fixed | variable | unknown | free`):

| Label | Meaning here |
|---|---|
| **OFFICIAL** | read this session from the provider's own page / docs / catalog JSON (URL in the row or §10) |
| **OWNER** | supplied by the owner earlier and not re-fetchable (page renders client-side); carried forward, flagged |
| **REPORTED** | a third party's restatement of a provider page; used only where no primary text could be read, always flagged |
| **UNKNOWN** | contract-specific, quote-only, or not published as text. **No number is invented.** |

**Payer:** **P** = the platform pays (platform key, booked on the platform ledger and attributed per brokerage);
**T** = the tenant pays under its own account/credential; **P/T** = depends on how the tenant is configured.

**Verdict vs the repo** (column "Repo booked"): **MATCH** · **REPO LOW** (we under-book; wrong direction for a margin
decision) · **REPO HIGH** (we over-book; the safe wrong direction under CLAUDE.md §5) · **UNVERIFIED** · **n/a**.

Prices are USD, list, before tax, before negotiated discounts. A price you will not actually pay (volume bands, plan
tiers) is shown as a range, never collapsed to one number.

---

## 1. What this research found (the findings, ranked by money at stake)

1. **The cost of the product is dominated by usage that is not in the monthly platform bill.** At the modelled "typical"
   intensity, per producer seat per month: AI inference ≈ $5.93, enrichment ≈ $5.20, live avatar/assistant ≈ $4.12,
   voice ≈ $3.52, SMS ≈ $2.62, avatar video ≈ $2.50 — about **$30 per seat**, of which the fixed infrastructure
   (Vercel + Supabase + subscriptions ≈ $637/month at launch) is a small share once there are a few dozen tenants.
   See `PRICING-RECOMMENDATION.md` §5. (Usage figures are labelled assumptions; no production telemetry was read.)
2. **Video overage is priced below its own cost for the expensive kind of video.** `plan_limits` overage for
   `video_minutes` is **$0.50/min** (m666, applied live, `supabase/migrations/m666-video-is-tier-metered-and-overage-billed.sql`).
   A template (Remotion) minute costs ≈ **$0.12**; an avatar-presenter minute costs ≈ **$1.25** (D-ID Scale plan
   $0.99/min list + voice + void-credit slack). One metric, two cost classes: the overage **loses ≈ $0.75 per avatar
   minute**. Recommendation in `PRICING-RECOMMENDATION.md` §6.3.
3. **The anthropic generation the code routes to is one generation behind the cheaper family.**
   `MODEL_CONFIG` routes `claude-sonnet-4.6 ($3/$15)`, `claude-haiku-4.5 ($1/$5)`, `claude-opus-4.6 ($5/$25)`
   (`lib/ai/models.ts:74-76`). Current catalog: **Sonnet 5.5 $2/$10**, **Haiku 5.5 $0.10/$0.50** (prompts ≤100k tokens),
   **Opus 5.5 $4/$20**. After Anthropic's note that 4.7+ models emit ≈30% more tokens for the same text, the like-for-like
   saving is ≈13% on the Sonnet lanes and ≈87% on the Haiku lanes (modelled blended token cost $2.96/M → $2.20/M, −26%).
   Re-routing is a quality-evaluated product decision (lane owner/integrator), not made here.
4. **A routed model is no longer in the AI Gateway catalog.** `perplexity-sonar-pro` (`lib/ai/models.ts:84`,
   used by `market_insight_generation`, `neighborhood_research`, `competitive_monitoring`) → `perplexity/sonar-pro`.
   The Gateway's live model list (`https://ai-gateway.vercel.sh/v1/models`, 484 ids, read 2026-10-23) contains
   `perplexity/sonar` but **no `sonar-pro`**. Those three lanes cannot be served as written and fall to their
   `claude-sonnet` fallback. Not a price issue; a certification finding. → Outside-lane (notes).
5. **Four booked rates are wrong against the primary page** (drift register, §9): Twilio SMS (REPO LOW 36–44%),
   Lob address verification (REPO LOW 3.6×–20×), the AI-voice budget estimate (REPO LOW ≈4× if the ConversationRelay lane
   is live), ElevenLabs TTS (REPO HIGH 25%). One more was corrected in this lane (Apify).
6. **Provider subscriptions are the unavoidable launch floor, and several are optional until volume exists.**
   The launch floor modelled here is **$637/month** (Vercel Pro seats, Supabase Pro + Large compute + PITR, Remotion
   Automators minimum, RentCast Foundation, podcast hosting, Apify, ZenRows, amortised Versium package). Add **$297**
   (D-ID Scale) the moment avatar video is sold; add **$260** (Lob Startup) the moment direct mail is sold.
7. **Unknowns that block a final number** (§8): BatchData pay-as-you-go rate, DocuSign/Dotloop integrator terms,
   Mapbox Commercial Application License, Open-Meteo commercial plan amount, Slybroadcast API price, Vercel/Supabase
   enterprise terms, the Vercel AI Gateway card payment-processing fee, ElevenLabs/D-ID/Twilio committed-use discounts.

---

## 2. Platform infrastructure

### 2.1 Vercel (hosting, functions, CDN, storage) — payer P
Source: <https://vercel.com/pricing> (page carries no date; read 2026-10-23). Repo facts: `vercel.json` (one cron
`* * * * *`, five functions at `memory: 3008`, `maxDuration: 300`), `docs/vercel-cron-usage-2026-09.md`.

| Item | Official price | Notes for this product |
|---|---|---|
| Pro plan | **$20 per Developer seat / month**, includes a **$20 usage credit**; unlimited Viewer seats; 1 Billing seat | Team size is the platform's own staff, not tenants |
| Fast Data Transfer | 1 TB / month included, then **from $0.15 / GB** | Tenant sites, landing pages, media delivery |
| CDN requests | 10M / month included, then **from $2 / 1M** | Tenant website traffic |
| Function invocations | **from $0.60 / 1M** | Cron dispatcher + every fan-out call is one invocation |
| Fluid Active CPU | **from $0.128 / hour** | Previously "not in the facts handed" (`docs/vercel-cron-usage-2026-09.md` §2) — now sourced |
| Fluid Provisioned Memory | **from $0.0106 / GB-hour** | 3008 MB reservation on the render routes |
| Blob storage | **$0.023 / GB-month**; simple ops from $0.40/M; advanced ops $5/M | Rendered video/audio/PDF artifacts |
| Image transformations | from $0.05 / 1K (5K free on Hobby) | Listing photos |
| Observability Plus | $1.20 / 1M events, 30-day retention | Optional; logs/traces |
| SAML SSO / HIPAA BAA | $300 / mo / $350 / mo | Only if an enterprise tenant requires |
| Builds | Basic $0.007/min · Standard $0.014 · Enhanced $0.028 · Turbo $0.105 | CI/CD |

**Derived estimates (labelled ASSUMPTION — real durations are unresolved in `docs/vercel-cron-usage-2026-09.md`):**
- Fixed scheduler load: **329,231 invocations / month** (`docs/vercel-cron-usage-2026-09.md` §2: 43,800 dispatcher ticks +
  285,431 fan-out calls; the registry has since grown to 218 entries per `scripts/cron-cost-baseline.json`, so treat it as a floor). At an assumed 1.5 s active CPU and 0.5 GB average: CPU ≈ 137 h × $0.128 = **$17.6**, memory ≈ 69 GB-h × $0.0106 =
  **$0.73**, invocations **$0.20** → **≈ $18.5/month**, i.e. inside the $20 credit. At 5 s average it is ≈ $60/month. **Measure before relying on it.**
- One in-process Remotion render at the configured ceiling (3008 MB, 300 s): CPU 0.0833 h × $0.128 = $0.0107 + memory
  0.2507 GB-h × $0.0106 = $0.0027 → **≤ $0.0134 per render function run** (upper bound; most renders finish sooner).

### 2.2 Supabase (database, auth, storage, realtime) — payer P
Source: <https://supabase.com/pricing> (no page date; read 2026-10-23). Live project `hrvaqgvukzxfskkcrwbt` (CLAUDE.md §3).

| Item | Official price |
|---|---|
| Pro | **from $25 / month**, includes **$10 compute credit** (one Micro) |
| Team | from $599 / month |
| Database size | 8 GB / project included, then **$0.125 / GB** |
| Egress | 250 GB included, then **$0.09 / GB** (cached egress $0.03 / GB) |
| File storage | 100 GB included, then **$0.0213 / GB** |
| MAU | 100,000 included, then $0.00325 / MAU |
| Realtime | 500 concurrent peak connections (then $10 / 1,000); 5M messages (then $2.50 / M) |
| Edge Function invocations | 2M included, then $2 / M |
| Compute add-ons / month | Micro $10 · Small $15 · **Medium $60** · **Large $110** · XL $210 · 2XL $410 · 4XL $960 · 8XL $1,870 |
| PITR | **$100 / month** per 7 days of retention (daily backups, 7 days, are included) |
| Branching | $0.01344 / branch-hour |

Launch configuration modelled: Pro + Large compute (net $100 after credit) + PITR 7 d = **$225 / month**. Steps up with tenant
count (assumption A8: XL at ≈ 50 tenants, 2XL at ≈ 250).

### 2.3 Vercel AI Gateway — payer P (the AI route, owner-mandated)
Source: <https://vercel.com/docs/ai-gateway/pricing> (`last_updated: 2026-09-08`, read 2026-10-23).
- **No markup and no platform fee on tokens**, including BYOK. You pay the provider list price from AI Gateway Credits.
- Free tier: a monthly free credit on a subset of models, lower rate limits; buying credits moves the team to the paid tier.
- **You are responsible for payment-processing fees** on credit top-ups (rate **not stated** → UNKNOWN); Enterprise can invoice (no fee).
- Optional add-ons (off by default): team-wide Zero Data Retention **$0.10 / 1,000 requests**; team-wide provider allowlist
  $0.10 / 1,000; Custom Reporting $0.075 / 1,000 tag writes and $5 / 1,000 queries; Trace Drains $0.05 / 1,000 traces + $0.50 / GB.
  Per-request ZDR / `only` filter carry no extra cost on Pro/Enterprise.
- Volume discounts on token spend are available by contract (UNKNOWN).

---

## 3. Provider cost matrix

### 3.1 AI models via the Gateway (per 1M tokens, input / output) — payer P

Prices below are the Gateway catalog JSON (`https://ai-gateway.vercel.sh/v1/models`, read 2026-10-23; equal to the provider list
price because the Gateway adds nothing) cross-checked to the provider's own page where one was readable. **Repo booked** =
`getModelPricing()` in `lib/ai/cost-tracking.ts` (the ledger's price survivor).

| Gateway id (as routed) | Official in / out | Cache read | Repo booked | Verdict | Successor / note |
|---|---|---|---|---|---|
| `anthropic/claude-sonnet-4.6` | $3 / $15 | $0.30 | $3 / $15 (`cost-tracking.ts:36`) | MATCH | **Sonnet 5.5 $2 / $10** (cache read $0.10; 0.05× on 5.5), Sonnet 5 $2 / $10 (the $3/$15 step-up scheduled for 2026-09-01 was cancelled) |
| `anthropic/claude-haiku-4.5` | $1 / $5 | $0.10 | $1 / $5 (`:52`) | MATCH | **Haiku 5.5 $0.10 / $0.50** for prompts ≤ 100k tokens ($0.50 / $2.50 above); cache read $0.01 |
| `anthropic/claude-opus-4.6` | $5 / $25 | $0.50 | $5 / $25 (`:45`) | MATCH | **Opus 5.5 $4 / $20**; Opus 5 $5 / $25; Fable 5.1 $10 / $50 (frontier tier) |
| `openai/gpt-4o` | $2.50 / $10 | $1.25 | $2.50 / $10 (`:60`) | MATCH | GPT-6 Sol $2 / $10; GPT-5.6 Terra $2 / $12; GPT-5.6 Luna $0.20 / $1.20 |
| `openai/gpt-4o-mini` | $0.15 / $0.60 | $0.075 | $0.15 / $0.60 (`:73`) | MATCH | GPT-6 Luna $0.10 / $0.50 |
| `openai/gpt-4-turbo` | $10 / $30 | — | $10 / $30 (`:66`) | MATCH | legacy; no lane needs it |
| `openai/gpt-5-mini` | $0.25 / $2.00 | $0.025 | $0.25 / $2.00 (`:80`) | MATCH | GPT-5.4 nano $0.20 / $1.25 |
| `google/gemini-2.5-pro` | $1.25 / $10 (≤200k) · $2.50 / $15 (>200k) | $0.125 | $1.25 / $10 (`:88`) | MATCH | Gemini 3.1 Pro $2 / $12 |
| `google/gemini-2.5-flash` | $0.30 / $2.50 | $0.03 | $0.30 / $2.50 (`:95`) | MATCH | Gemini 3.8 Flash $0.75 / $3.75 until 2026-12-31, **then $1.50 / $7.50**; 3.1 Flash-Lite $0.25 / $1.50; 2.5 Flash-Lite $0.10 / $0.40 |
| `perplexity/sonar` | **$0.25 / $2.50** + **$2.50 per 1,000 web searches** | — | $1.00 / $1.00 (`:103`) | **REPO DIFFERS** | both directions: input over-booked 4×, output under-booked 2.5×; search fee unbooked |
| `perplexity/sonar-pro` | **not in the Gateway catalog** | — | $3 / $15 (`:110`) | **NOT SERVABLE** | direct Perplexity Search API is $5.00 / 1,000 requests ($1.00 fast); sonar-pro token rates not retrievable |

Sources: Anthropic <https://platform.claude.com/docs/en/about-claude/pricing> (read 2026-10-23); Gateway JSON as above;
Google <https://ai.google.dev/gemini-api/docs/pricing> ("last updated 2026-10-22 UTC"); OpenAI list reproduced by the Gateway and by
LiveKit Inference's published table (`mcp__live_kit__get_pricing_info`, 2026-10-23) — **OpenAI's own pricing page returned HTTP 403**,
so OpenAI rows are Gateway-sourced; Perplexity <https://docs.perplexity.ai/docs/getting-started/pricing>.

**Modifiers that change the real bill** (Anthropic, same page):
- Prompt caching: cache write 1.25× (5 min) / 2× (1 h); **cache read 0.1× (0.05× on Sonnet 5.5 / Opus 5.5 / 0.025× on Fable 5.1)**.
- Batch API **−50%** on input and output (no fast mode); the Gateway exposes `-batch` ids (e.g. `openai/gpt-4o-batch`, `google/gemini-2.5-flash-batch`).
- US-only inference (`inference_geo: "us"`) **×1.1** on Claude 4.6+ models.
- Tokenizer: **Claude 4.7 and later produce ≈ 30% more tokens for the same text** — compare price per *text*, not per token.
- Web search tool **$10 per 1,000 searches** on top of tokens.
- Long context: the 1M window is standard price for Claude 4.6+ except Haiku 5.5, which steps up above 100k prompt tokens.

**Image generation** (Gateway JSON): `openai/gpt-image-1` $5 text-in / $40 image-out per 1M tokens; `openai/gpt-image-2` $5 / $30.
Repo: `lib/vendor-governance/cost-normalizer.ts:99-107` books gpt-image-1 token rates ✓ (MATCH) and per-image estimates ($0.042 medium square).
`gpt-image-2` is cheaper on output; not routed. DALL-E 3 per-image rows could not be re-verified (OpenAI pages 403) → UNVERIFIED.

### 3.2 Messaging and voice — payer P (platform numbers) / T (BYO number, own subaccount)

| Provider · item | Official price | Source / date | Repo booked | Verdict |
|---|---|---|---|---|
| **Twilio SMS**, US, outbound, per segment | **$0.0083** (long code, toll-free and short code) + **carrier fee per message: AT&T $0.0035, T-Mobile $0.0045, Verizon $0.005, other $0.0042** → all-in ≈ **$0.0118 – $0.0133** | twilio.com/en-us/sms/pricing/us — "current as of October 2026" | `$0.0075` (`cost-normalizer.ts:289`, `lib/providers/dispatch.ts:160`) | **REPO LOW 36–44%** |
| Twilio SMS inbound | $0.0083 + carrier fee $0.0025 – $0.007 | same | not separately booked | UNVERIFIED |
| Twilio MMS outbound | $0.022 + carrier $0.009 – $0.01 | same | not booked | n/a |
| Twilio failed-message fee | $0.001 per failed message | same | not booked | n/a |
| **Twilio voice**, outbound US local / toll-free | **$0.0140 / min** | twilio.com/en-us/voice/pricing/us — "current as of August 2026" | `$0.014` (`cost-normalizer.ts:282`, `twilio-outbound.ts:142`) | MATCH |
| Twilio voice, inbound local / toll-free | $0.0085 / min · $0.0220 / min | same | not booked | n/a |
| Twilio phone numbers | local **$1.15 / mo** · toll-free **$2.15 / mo** · BYO $0.50 / mo | SMS + voice pages | `~$1.15` (`lib/voice/twilio-tenancy.ts`) | MATCH |
| Twilio **ConversationRelay** (AI voice agent) | **$0.07 / min** on top of carrier minutes | same voice page | `PLATFORM_VENDOR_RATES.twilio_voice` = **$0.02 / min** (`meter-vendor.ts:115`) used for the call-budget estimate (`outbound-call-gates.ts:295`) | **REPO LOW ≈4×** if the ConversationRelay lane (chosen in `docs/twilio-vs-elevenlabs-voice-2026-09.md`) is live |
| Twilio recording / transcription | $0.0025 / min · storage $0.0005 / min-mo · $0.05 / min add-on · Conversation Intelligence $0.024 – $0.027 / min | voice page | not booked | n/a |
| **A2P 10DLC** (US long-code SMS registration) | Brand: **$4.50** TCR fee (+ **$41.50** standard-brand vetting, one-time); low-volume standard / sole-prop brand ≈ **$4**; campaign vetting **$15** one-time; campaign **$1.50 – $10 / month** (sole-prop $2) | twilio.com/en-us/phone-numbers/a2p-10dlc (Standard "$44 one-time brand") and twilio.com/docs/trust-hub/registrations/a2p-10dlc-brand ($4.50 + $41.50) — the two pages differ by ≈ $2; both recorded | not booked | n/a — one-time ≈ **$61** per tenant (modelled), covered by the setup fee |
| **SendGrid** (platform email) | Essentials **from $19.95 / mo** (50k–100k fits); Pro **from $89.95 / mo** (1 dedicated IP, 2,500 validations); Premier custom; free trial 60 days | twilio.com/en-us/products/email-api/pricing (no date) | `$0.001` / email (`cost-normalizer.ts:270`, `dispatch.ts:159`) | REPO HIGH (effective $0.0004 – $0.0009) — conservative, keep |
| **Resend** (inbound + outbound alt.) | Free 3,000 / mo · Pro **$20 (50k)** / $35 (100k), overage **$0.90 / 1k** · Scale $90 – $1,150 (100k – 2.5M), overage $0.90 → $0.46 / 1k · dedicated IP $30 / mo (Scale); **inbound counts toward the quota** | resend.com/pricing (no date) | `$0.001` (`cost-normalizer.ts:275`) | REPO HIGH — conservative, keep |
| Postmark / Mailgun (inbound webhooks only) | — | — | — | UNKNOWN — whichever the tenant/platform wires; not re-researched |
| Telnyx / Bandwidth / Plivo / Sinch (BYO SMS) | — | — | — | T — tenant's own account; UNKNOWN |
| LiveKit Cloud (evaluated alternative; **not a dependency**) | Build $0 · Ship **$50 / mo** · Scale **$500 / mo**; agent session **$0.01 / min** beyond included; telephony inbound $0.01 / min; inference at model rates (e.g. STT $0.0025 – $0.0095 / min) | `mcp__live_kit__get_pricing_info`, 2026-10-23 | n/a | n/a — cross-check only: LiveKit's own worked example for a phone agent is ≈ **$0.04 / min** (open-weight LLM, Nova-3 STT, Inworld TTS) vs ConversationRelay ≈ **$0.09 / min**; the voices differ, so this is not like-for-like |

### 3.3 Data, enrichment and research — payer P

| Provider · item | Official price | Source / date | Repo booked | Verdict |
|---|---|---|---|---|
| **Versium REACH** | Pay-as-you-go **$0.075 → $0.05 / match credit** (≥ $125 per file, no API/MCP); Credit packages **from $250**, 5,000 – 500,000 credits, **$0.05 → $0.02**, never expire, all data tools + API + MCP; Annual subscriptions **from $5,000 / yr**, ≥ 250,000 allowance, "as low as **$0.017**" | versium.com/pricing (© 2026, no date) | `$0.05` per match (`cost-normalizer.ts:245`, `versium-client.ts:113`) | MATCH at the package ceiling. Per-product credit weights are PUBLISHED (reach-help.versium.com "Match Credits Value Conversion Table" + the B2B2C output sample's Billing table, read 2026-10-23) and booked from ONE table, `VERSIUM_CREDIT_WEIGHTS` (`versium-client.ts:131`): contact append e-mail / phone **1** · demographic category **1** (2+ categories capped at **2** per record) · Full Demographic Insights (where the Online Presence Indicator – Real Estate lives) **3** · B2B2C business e-mail **2**, consumer mobile / e-mail (per address) / address **1**, crosswalk **1** · online audience **1** · e-mail validation **0.5** · firmographic / C2B / IP-to-domain **3** · a no-match is free. Still unpublished: Predictive Scores (WAITING_EXTERNAL) |
| **RentCast** API | Developer **$0** (50 req, then $0.20) · Foundation **$74** (1,000 req, then $0.06) · Growth **$199** (5,000, then $0.03) · Scale **$449** (25,000, then $0.015) | rentcast.io/api (© 2020-2026, no date) | `$0.074` per request (`rentcast.ts:121`, `property-lookup-rail.ts:315`) | MATCH at Foundation; effective $0.0398 at Growth, $0.018 at Scale |
| **BatchData** — skip trace | **Subscriptions only on the page:** Growth $2,000 / mo (100k) · Professional $5,000 (300k) · Scale $10,000 (750k) · Enterprise $20,000 (3M) → implied $0.020 → $0.0067 per trace; reverse skip trace $3,000 (100k, **per matched record**) … $30,000 (3M); BatchData's skip-tracing page says "pay-as-you-go for the matches you receive" **without publishing the rate** | batchdata.io/pricing (read 2026-10-23) + batchdata.io/skip-tracing; secondary: scoutdata.com (2026-10-03) | `$0.07` per matched record (`batchdata-client.ts:1440`, "pay-per-match floor", earlier research) | **UNVERIFIED** — current page cannot confirm $0.07; PAYG rate **UNKNOWN (contract/quote)** |
| BatchData — property data / search / buy-box / comps | Subscriptions: Property Data $1,000 (100k records) → $10,000 (3M) (≈ $0.01 → $0.003 / record); Buy Box $1,500 (7,500 matched) → $15,000 (150,000) (≈ $0.20 → $0.10); add-ons e.g. Comps $1,250 / mo flat | same | `VENDOR_PRICING.batchdata` **$0.50** "per motivated seller record" (`cost-normalizer.ts:224`); `BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD` $0.05 | **UNVERIFIED** — no current page supports $0.50; per-record API price **UNKNOWN** |
| **People Data Labs** person enrichment | Pro monthly tiers **$0.28 / $0.265 / $0.25 per credit** (350 – 8,333 credits); annual tiers **$0.224 → $0.20**; Person Identify $0.55 → $0.40; **one credit only on a successful (200) match — a 404 no-match is free** | support.peopledatalabs.com "Pricing & credits" (2025-10-24); peopledatalabs.com blog (2026-02-20) "~$0.20 – $0.28 per profile" | `$0.25` per match, `$0` no-match (`peopledata-client.ts:23-24`) | MATCH (Tier 3 monthly) |
| **Exa** | Search **$7 / 1,000** (`auto`/`fast`; ≤10 results, +$1/1k results above); `lite`/`instant` $4; Deep $12; **Agent** (research/list-building) fixed-effort $0.012 (minimal) – $1.00 (xhigh) per request, metered `auto` ($5 default cap) / `ultra` ($20); contents $1 / 1k pages; Answer $5 / 1k; **$10 free credit each month** | exa.ai/pricing (no date) | `$0.007` per search (`cost-normalizer.ts:186`, `exa-client.ts:69`) | MATCH |
| **Tavily** | Search 1 credit (basic) / 2 (advanced); **PAYG $0.008 / credit**; Researcher 1,000 free credits; Project $30 (4,000, $0.0075) · Bootstrap $100 · Startup $220 · Growth **$500 (100,000, $0.005)** | docs.tavily.com/documentation/api-credits (no date) | `$0.008` / credit (`cost-normalizer.ts:78`) | MATCH |
| **Zyte API** | HTTP response body **$0.13 – $1.27 / 1,000** by tier (PAYG; $0.06 at the $500 commitment); browser-rendered **$1.01 – $16.08 / 1,000** (Tier 3 **$4.02**; $1.92 at $500 / mo); $5 trial credit | zyte.com/pricing (no date) | `$0.004` browser / `$0.00044` HTTP (`cost-normalizer.ts:72`) | MATCH (Tier-3 PAYG) |
| **ZenRows** | Credits: standard 1 · JS render 5 · premium proxy 10 · both 25; plans Free 5,000 · Build **$19 / $29 / $39** (45k / 80k / 120k) · Launch $69 – $129 · Growth $199 – $399 · Scale $549 – $2,999 → $0.42 / 1k standard (Build 45k) … $0.07 (Scale 45M) | zenrows.com/pricing (no date) | `$0.01` / request (`cost-normalizer.ts:178`) | REPO HIGH for most requests; ≈ a JS+premium request on Build ($0.0105) — conservative, keep |
| **Apify** | Compute unit **$0.20** (Free, Starter $19), **$0.16** (Scale $199), **$0.13** (Business $999); residential proxy $8 → $7 / GB; prepaid usage = plan price, expires monthly | apify.com/pricing (read 2026-10-23, raw page text) | was `$0.25` → **changed to `$0.20`** in this lane (`cost-normalizer.ts:216`) | **CORRECTED** (§9, D2) |
| Keyless / free: Nominatim · Overpass · US Census ACS · FRED · Socrata · ArcGIS · Pexels | $0 (usage policies apply) | — | `osint_free` $0 (`cost-normalizer.ts:262`) | MATCH by construction; commercial-use terms not re-read → UNVERIFIED |
| NewsAPI.ai (Event Registry) | **$90 / mo** for 5,000 tokens (article search = 1 token recent / 5 per searched year archive); free 2,000 searches; overage **$0.015 / token** | newsapi.ai/plans (no date) | not booked | n/a — P if the news lane is enabled; usage UNKNOWN |

### 3.4 Maps, geo, weather — payer P

| Provider · item | Official price | Source / date | Repo booked | Verdict |
|---|---|---|---|---|
| **Mapbox** Static Images | **100,000 / mo free**, then **$1.50 / 1,000** (100,001 – 500,000), $1.20 (500k – 1M), $0.90 (1M+) | mapbox.com/pricing, raw page text, read 2026-10-23 | `$0.0015` (`cost-normalizer.ts:92`) | MATCH |
| Mapbox GL JS map loads | 50,000 / mo free, then $5.00 / 1,000 (prior reading, 2026-10-11); **the numbers did not render in this session's raw text** | repo comment `cost-normalizer.ts:86-91` | `$0.005` | **UNVERIFIED this run** (a summarising fetch returned a conflicting table — 50,000 free static + $1.00 — which contradicts the raw page and was rejected) |
| Mapbox **Commercial Application License** | annual subscription (+ seat-based part) **required for real-estate use**; price set by sales | mapbox.com/pricing | — | **UNKNOWN (quote)** — a launch prerequisite, not a rounding error |
| **Google Maps Platform** (fallback) | Essentials, 10,000 free / SKU / mo then (10,001 – 100,000): Static Street View **$7.00 / 1k**, Static Maps **$2.00**, Dynamic Maps (loads) **$7.00**, Geocoding $5.00, Place Details Essentials $5.00, Autocomplete $2.83; steps down to $0.53 / $0.15 above 5M | developers.google.com/maps/billing-and-pricing/pricing, **"Last updated 2026-10-21 UTC"** | `$0.007 / $0.002 / $0.007` (`cost-normalizer.ts:83`) | MATCH |
| **Open-Meteo** commercial | free tier **non-commercial only**; commercial plans by call budget (Standard 1M / mo, Professional 5M, Enterprise > 50M) at a **fixed monthly price whose amount is not published as text** | open-meteo.com/en/pricing | `unknown` state (`cost-normalizer.ts:350`) | MATCH (honestly UNKNOWN) |

### 3.5 Video, avatar, voice, audio, books — payer P

| Provider · item | Official price | Source / date | Repo booked | Verdict |
|---|---|---|---|---|
| **D-ID** API (offline render + live agent) | Build **$18 / mo** (64 credits) · Launch **$50 / $99 / $149** (180 / 360 / 540) · Scale **$198 / $248 / $297** (800 / 1,000 / 1,200) · Enterprise custom; **1 credit = 15 s of rendered video or 30 s of streaming**; credits renew monthly and **unused credits are void**; annual ≈ −20% to −30% ($207.90 / mo on the $297 plan). Commercial API use starts at Launch | **OWNER**-supplied 2026-09-12 reading (`lib/video/realism-profile.ts:1585-1620`); consistent with REPORTED third-party restatement (creatify.ai, 2026). d-id.com/pricing/api renders client-side → **not re-fetchable** | Scale list-derived: **$0.0165 / s ≈ $0.99 / min** render; **$0.495 / min** streaming (`realism-profile.ts:1603, 1722`) | MATCH to the owner's reading; **re-verify on the page before the first purchase** |
| **Simli** (backup live face) | Hobby **$0.01 / min** · Pro **$0.0095** · Scale **$0.009** · Enterprise from **$0.005**; **50 minutes free each month**; render leg only (STT/LLM/TTS are ours) | simli.com (read 2026-10-23) | `$0.009` / min (`realism-profile.ts:1738`) | MATCH (Scale tier) |
| **ElevenLabs** TTS (API) | **v3 $0.08 / 1K chars · Multilingual v2 $0.08 · v4 $0.08 · v4 Turbo $0.04 · Flash/Turbo $0.04 · v3 Conversational $0.04**; Scribe v2 STT **$0.22 / hour** (Realtime $0.39); Agents / Speech Engine **$0.08 / min** connected (burst $0.16); plans Starter $6 · Creator $22 · **Pro $99 (1.238M chars)** · Scale $299 · Business $990 (12.4M) | elevenlabs.io/pricing/api (no date; lists Eleven v4 as new) | **$0.10 / 1K** (`realism-profile.ts:1640`, feeding `VENDOR_PRICING.elevenlabs` and `PLATFORM_VENDOR_RATES.elevenlabs`) | **REPO HIGH 25%** — the code comment says v3 / multilingual_v2 are "the $0.10 row"; the page now lists $0.08 |
| **Remotion** (render engine, in-process on Vercel) | License: **free** for individuals and for-profit organisations of **≤ 3 employees**; **Creators $25 / seat / mo**; **Automators $0.01 / render, $100 / mo minimum**; Enterprise from **$500 / mo** | remotion.dev/docs/license/pricing and LICENSE.md (free tiers confirmed in raw text); **dollar figures REPORTED** from the official pricing component, which did not render here | not booked (compute only: ≤ $0.0134 / render function run) | **UNVERIFIED — confirm with Remotion which licence applies to automated rendering for customers** |
| AWS Lambda (if Remotion Lambda is ever adopted) | **$0.0000166667 / GB-second** (x86, us-east-1), **$0.20 / 1M requests**, free tier 1M req + 400,000 GB-s | aws.amazon.com/lambda/pricing | n/a | n/a — a 2 GB × 40 s render ≈ $0.0013 compute, cheaper than the Vercel path but adds an AWS account |
| **Transistor** (podcast hosting) | Starter **$19** (20k downloads, 250 GB) · Professional **$49** (100k, 500 GB) · Business **$99** (250k, 1 TB) · Enterprise 1 – 8 **$199 – $899**; unlimited shows per account; downloads/storage pooled across all shows; no overage fee (upgrade emailed) | support.transistor.fm plan table; transistor.fm/pricing | not booked | P — one platform account hosting tenant shows would pool every tenant's downloads |
| **YouTube Data API v3** | Default quota **10,000 units / day** for general calls; `videos.insert` has its **own bucket, 100 calls / day by default**; `search.list` 100 / day; `playlistItems.insert` 50 units; `captions.insert` 400 units; the quota page states **no price** | developers.google.com/youtube/v3/determine_quota_cost ("Last updated 2026-10-15 UTC") | $0 | **A capacity ceiling, not a cost**: one Google Cloud project = ~100 uploads / day across **all** tenants until a quota extension is granted → WAITING_EXTERNAL |
| OpenAI image generation | see §3.1 | | | |
| Vercel Blob / Supabase Storage (media at rest) | $0.023 / GB-mo · $0.0213 / GB-mo | §2 | — | — |

### 3.6 Forms, e-signature, transactions — payer **T** by ruling (tenant-selected provider + tenant credentials), **P/T for DocuSign**

The platform's cost for these is **$0** where the tenant brings its own account. **Exception to resolve:** `.env.example:307` declares `DOCUSIGN_PLATFORM_ACCOUNT_ID`, i.e. a
platform DocuSign account is wired as the default, so envelopes sent through it are **platform-paid at an integrator rate that is not published** (UNKNOWN; anecdotal third-party
figures of $1.25 – $4.80 per envelope were found and are **not** used). Until quoted, e-signature envelopes are **left out of every included allowance** in the pricing proposal.
The prices below are otherwise the *tenant's* cost and a packaging input (the plan must not look like it double-charges a vendor the tenant already pays).

| Provider | Published price | Source / date | Status |
|---|---|---|---|
| DocuSign eSignature API (developer plans) | Starter **$50** shown (40 envelopes / mo; period label not rendered); Intermediate (100 / mo), Advanced, Enhanced — **prices not rendered**; envelope billing depends on the integration classification chosen at Go-Live | ecom.docusign.com/plans-and-pricing/developer ; developers.docusign.com Go-Live | **UNKNOWN** beyond Starter |
| DocuSign web plans (reference) | Standard $25 / user / mo (annual) · Business Pro $40 · ~100 envelopes / user / yr | docusign pricing (secondary summaries) | REPORTED |
| Dotloop (Zillow Group) | $0 – $34.99 / user / mo (free: 10 transactions); API/partner terms not published | brokerage.getverticalos.com/pricing (2026-10-12) | **UNKNOWN** for integrators |
| SkySlope | $340 / mo | same source | T |
| Form Simplicity · Authentisign (Lone Wolf) · Brokermint (BoldTrail BackOffice) · Lofty/FUB/HubSpot CRMs · IDX Broker · ShowingTime | quote-only or tenant-negotiated | — | **UNKNOWN**, T |

### 3.7 Payments — Stripe (SaaS billing only; commission payouts are NOT Stripe)

Source: <https://stripe.com/pricing>, <https://stripe.com/connect/pricing> (no page dates; © 2026; read 2026-10-23).

| Item | Price |
|---|---|
| Card (domestic) | **2.9% + $0.30** per successful charge; international +1.5%; currency conversion +1% |
| ACH Direct Debit | **0.8%, capped at $5.00** |
| Stripe Billing | **0.7%** of Billing volume (pay-as-you-go); annual contracts from $620 / mo |
| Stripe Tax | Basic 0.5% (no-code) or $0.50 / transaction (API); Complete from $90 / mo |
| Invoicing | Starter 0.4% per paid invoice |
| Radar | from $10 / mo, or $0.05 per screened transaction |
| Disputes | $15 per dispute received (+ $15 countered, refunded if won) |
| Connect (platform sets pricing) | $2 per monthly active account · payout 0.25% + 25¢ · instant payout 1% · 1099 e-file $2.99 |
| Instant Payouts | 1.5% (min 50¢) |

Effective cost on a subscription invoice used throughout this documentation: **3.6% + $0.30** on card (2.9% + 0.7% Billing + $0.30);
on a $2,499 invoice that is **$90.26**; by ACH it is **$22.49** (0.8% capped at $5 + 0.7%). Enterprise invoicing by ACH is therefore worth ≈ 2.7 points of margin.

### 3.8 Print, mail, voicemail — payer P (optional product line)

| Provider · item | Official price | Source / date | Repo booked | Verdict |
|---|---|---|---|---|
| **Lob** plans | Developer $0 (≤ 6,000 mailings / yr) · **Startup $260 / mo** ($225 annual; ≤ 75,000) · **Growth $550 / mo** ($480 annual; ≤ 150,000) · Enterprise custom | lob.com/pricing; help.lob.com/print-and-mail "Pricing details" (published 2026-09-29) | — | fixed commitment only if direct mail is sold |
| Lob print + postage, postcard 4×6 First Class | **$0.905** Developer · **$0.645** Startup · **$0.615** Growth → **$0.909 / $0.649 / $0.619 effective 2026-11-01**; 6×9 FC $1.026 / $0.706 / $0.656; 6×11 FC $1.290 / $0.950 / $0.910; letter from $0.828 / $0.658 / $0.628 | same | **$0.78** postcard (`cost-normalizer.ts:63`, "reconciled against Lob's invoice") | plan-dependent; $0.78 sits between Developer and Startup → keep; **plan fee is not in the per-piece rate** |
| Lob **US address verification** | per additional request: **$0.05** Developer (300 / mo included) · **$0.025** Startup (1,000 incl. for $25 / mo) · **$0.012** Business (10,000 for $120) · **$0.009** Growth (50,000 for $450); annual billing $0.020 / $0.010 / $0.008 | help.lob.com "AV pricing" (page "last updated 2 years ago") + lob.com/pricing | **$0.0025** (`lib/external/lob-address-verify.ts:53`) | **REPO LOW 3.6× – 20×** (D4) |
| Slybroadcast (ringless voicemail) | no primary-source API price (third-party $0.04 – $0.10 per delivery) | repo `cost-normalizer.ts:316` | `unknown` | MATCH (honestly UNKNOWN) |

### 3.9 Other providers present in the code (`lib/kernel/provider-adapters.ts` ADAPTER_FACTS, 73 declarations)

| Class | Providers | Payer | Price status |
|---|---|---|---|
| Social publishing / ads APIs | Meta (Graph, Marketing, WhatsApp), LinkedIn, X, TikTok, Pinterest, YouTube, Google Ads, Buffer, OpenAI Ads, streaming-TV ads | T (tenant OAuth + tenant ad spend) | API access: no per-call charge was **verified** this run (UNVERIFIED); ad spend is the tenant's. Minimum ChatGPT daily budget $25 is a repo constant (`lib/integrations/ad-campaign-vocabulary.ts:84`) |
| Calendar / mail / drive | Google Workspace APIs, Microsoft Graph, Nylas, Zoom | T | no platform cost verified (UNVERIFIED); quota-limited |
| CRMs and back-office | Follow Up Boss, Lofty, GoHighLevel, HubSpot, SkySlope, Brokermint, Dotloop, QuickBooks, Xero | T | tenant's own plans; sync-out only for HubSpot; QuickBooks API OAuth refresh only is SDK |
| MLS / listing data | IDX Broker, listing portals, ShowingTime | T | tenant-contracted; UNKNOWN |
| Property valuation staff test | HouseCanary | P (connection test only) | UNKNOWN |
| Decommissioned | HeyGen, Vapi | — | `DECOMMISSIONED_PROVIDERS` (`lib/platform/provider-posture.ts:599`); rows kept only as epitaphs (Vapi publishes $0.05 / min hosting + provider pass-through; not used) |
| Internal/infra | Web Push (VAPID), Vercel Domains API, custom-domain attach | P | no per-use charge verified; **custom domains: connect only (owner), no registrar** → tenant buys its own domain |

### 3.10 Support tooling and observability

**UNKNOWN / none configured.** `package.json` has no helpdesk SDK (no Intercom/Zendesk/Help Scout/Crisp) and no error-tracking SDK
(no Sentry); support is the in-platform ticketing + AI triage (wave 142G survivors) and staff time. Observability is `@vercel/analytics`
plus Vercel logs. Cost is therefore **staff hours** (modelled at $45 / hour loaded, assumption A6) plus the optional Vercel Observability Plus
($1.20 / 1M events).

---

## 4. Fixed monthly commitments at launch (platform-level; what must be paid before the first tenant)

| Commitment | Monthly | Status | Needed when |
|---|---:|---|---|
| Vercel Pro, 3 developer seats | $60 | required (usage credit $20 offsets overage) | day 1 |
| Supabase Pro + Large compute (net of $10 credit) + PITR 7 d | $225 | required | day 1 |
| Remotion Automators minimum (or $0 if the free ≤ 3-employee licence applies) | $100 | UNVERIFIED licence class | first customer render |
| RentCast Foundation | $74 | optional (Developer tier is $0 for 50 req) | first property lookup |
| Podcast hosting (Transistor Business assumed; Starter is $19) | $99 | optional | first podcast |
| Apify Starter | $19 | optional | first social-intent scrape |
| ZenRows Build (120k credits) | $39 | optional | first scrape |
| Versium credit package ($250 / yr, amortised) | $21 | optional | first financial append |
| **Launch floor modelled** | **$637** | | |
| D-ID Scale (monthly) | $297 | commitment **when avatar video is sold**; credits void monthly | first avatar render |
| Lob Startup | $260 | only if direct mail is sold | first mailing |
| SendGrid Pro (if volume > Essentials) | $89.95 | instead of $0.0009 / email variable | volume |
| BatchData Skip Tracing Growth | $2,000 | **only above ≈ 28,571 matches / mo** vs $0.07 PAYG (if PAYG is real) | volume |
| Versium annual subscription | $417 ($5,000 / yr) | only above ≈ 100,000 matches / yr vs $0.05 credits | volume |
| Mapbox Commercial Application License | UNKNOWN | **required for real-estate production use** | before public maps |
| LiveKit Ship | $50 | alternative only | n/a |

The ElevenLabs Pro plan ($99) and D-ID are treated as **variable** in the economics (priced per character / per minute at list); the
D-ID plan is nevertheless a **floor of $297 / month** until usage reaches ≈ 300 rendered minutes (1,200 credits × 15 s).

---

## 5. Cost levers already available (no new vendor)

| Lever | Effect | Where |
|---|---|---|
| Re-route Haiku lanes to Haiku 5.5 | −87% on those tokens (like-for-like, after tokenizer) | `lib/ai/models.ts` `MODEL_CONFIG` + `getModelPricing` together (one commit; the ledger price must move with the model) |
| Re-route Sonnet lanes to Sonnet 5.5 | −13% like-for-like | same |
| Prompt caching on portal/agent chat system prompts | cache read is 0.1× (0.05× on 5.5) of input | `streamTextRouted` lanes |
| Batch API / `-batch` ids for non-urgent lanes (nightly coaching, 4-hourly deal health) | −50% | `generateTextRouted` lanes |
| Cheaper-adequate model per step (owner wave 86) | gpt-5-mini $0.25/$2.00 vs sonnet | already in the lane table |
| Credit-package → subscription at volume (Versium, BatchData) | $0.05 → ≈ $0.017 / $0.07 → ≈ $0.02 | break-evens in §4 |
| Per-tier vendor ceiling | caps platform spend per tenant: **$50 / $200 / $750 / $2,500** | `lib/vendor-governance/budget-eval.ts:9` |
| Per-tier AI quota with billed overage | 2M / 10M / 30M / 100M tokens | `plan_limits` (`scripts/1054-ai-fair-use-quotas.sql`, m479) |

---

## 6. What the repo already meters (so the report maps onto the ledger, not a second cost model)

- **AI**: `ai_tool_usage` (`cost_cents`, `tokens_used`, `model_used`, `feature`, `platform_paid`) — written by `logAIUsage` from `getModelPricing`;
  feeds `meter_readings.ai_tokens` and the overage projection (CLAUDE.md §5).
- **Non-AI vendors**: `vendor_usage_tracking` (`vendor_name`, `units_used`, `cost_per_unit`, `total_cost`) via `meterVendorSpend`; typed
  `price_state` / `cost_basis` / `coverage` (wave 139).
- **Customer meters**: `usage_counters` / `usage_events` → `meter_readings` (`lib/finance/usage-metering.ts`); overage billed through
  `lib/billing/ai-overage.ts` for `ai_tokens_monthly` and `video_minutes` (m479, m666, m669).
- The measured cost per tenant is therefore already derivable. **Calibration SQL** (read-only) is in `PRICING-RECOMMENDATION.md` §11 so the
  assumptions can be replaced with p50/p90 the day telemetry exists.

---

## 7. Method

1. Read the repo's price tables (`cost-normalizer.ts`, `meter-vendor.ts`, `cost-tracking.ts`, `realism-profile.ts`, client constants) and the
   provider declarations (`provider-adapters.ts`).
2. For each provider, fetched the **primary** pricing page; where the page renders client-side, fetched the raw text through a second reader
   or used the provider's own machine-readable catalog (Gateway JSON; LiveKit's pricing endpoint). A summarising reader is **not** accepted as
   a source when it conflicts with raw text (Mapbox, §3.4).
3. Compared to what the code books and wrote the drift register (§9).
4. Where a price is contract-specific, recorded UNKNOWN and what would resolve it (§8).

## 8. UNKNOWN register — what to ask, and of whom

| Item | Why it matters | Resolve by |
|---|---|---|
| BatchData pay-as-you-go skip-trace / property / search rates | `VENDOR_PRICING.batchdata` ($0.50) and `$0.07` cannot be confirmed; subscriptions start at $1,000 – $2,000 / mo | quote from BatchData sales (state volume, ask for per-record API rate) |
| Versium Predictive Scores credit weight | the only Versium product whose weight is not in the published "Match Credits Value Conversion Table" (every other weight — Online Presence Indicator via Full Demographic 3, B2B2C business e-mail 2, online audience 1, e-mail validation 0.5 … — is published and booked from `VERSIUM_CREDIT_WEIGHTS`, `versium-client.ts:131`) | Versium support (ask for the Predictive Scores weight) |
| Mapbox Commercial Application License | required for real-estate use; sets a recurring floor | Mapbox sales |
| Remotion licence class | $0 vs $100 / mo minimum + $0.01 / render | Remotion (licence FAQ / sales) |
| D-ID current plan page | owner reading dated 2026-09-12 | open d-id.com/pricing/api in a browser before purchase |
| DocuSign integrator envelope billing (platform account `DOCUSIGN_PLATFORM_ACCOUNT_ID`); Dotloop partner terms | decides whether e-signature is a platform cost or a tenant cost, and whether it can sit in an allowance | DocuSign / Zillow partner managers |
| Vercel AI Gateway card top-up fee | adds to every AI dollar | Vercel billing (or use Enterprise invoicing) |
| Twilio committed-use discounts; ConversationRelay volume tiers | voice is the second-largest variable line | Twilio sales at > $1k / mo |
| Open-Meteo commercial monthly amount | unknown fixed monthly | Open-Meteo (info@open-meteo.com) |
| Slybroadcast API price | ringless voicemail | Slybroadcast |
| YouTube upload quota extension | 100 uploads / day shared by all tenants | Google Cloud quota request (WAITING_EXTERNAL) |
| Live production telemetry (tokens, minutes, vendor $ per tenant) | replaces every usage assumption | read-only SQL, `PRICING-RECOMMENDATION.md` §11 |

---

## 9. Drift register — booked rate vs primary source

| # | Item | Repo (file:line) | Official | Direction | Disposition |
|---|---|---|---|---|---|
| D1 | Twilio SMS per segment | $0.0075 — `cost-normalizer.ts:289` **and** `lib/providers/dispatch.ts:160` (the table row says "keep in lockstep") | $0.0083 + carrier fee $0.0035 – $0.005 → $0.0118 – $0.0133 | REPO LOW 36–44% | **Not changed here**: editing one half would break the declared lockstep. Outside-lane: change both in one commit (dispatch.ts is not in this lane's domain) |
| D2 | Apify compute unit | was $0.25 — `cost-normalizer.ts:216` | $0.20 Free/Starter, $0.16 Scale, $0.13 Business | was REPO HIGH vs every published plan | **Changed in this lane** → `$0.20`, `variable`, sourced + dated. `scripts/cost-completeness-guard.ts` 47/0, `provider-adapter-guard.ts` 160/0, `provider-cost-routing-guard.ts` 115/0 |
| D3 | ElevenLabs TTS per 1K chars | $0.10 — `lib/video/realism-profile.ts:1640` | $0.08 (v3, v2, v4); $0.04 (Flash/Turbo, v4 Turbo) | REPO HIGH 25% | Outside-lane (lane 143F domain): one constant, comment must be rewritten (it asserts the $0.10 row) |
| D4 | Lob US address verification | $0.0025 — `lib/external/lob-address-verify.ts:53` (and the "≈ $0.0025" prose in `lib/agents/marketing-agent.ts:279`, `lib/providers/mailing-cass-gate.ts:14`) | $0.05 → $0.008 per request by plan/billing | REPO LOW 3.6× – 20× | Outside-lane |
| D5 | AI-voice call budget estimate | $0.02 / min — `lib/vendor-governance/meter-vendor.ts:115`, used at `lib/voice/outbound-call-gates.ts:295` | carrier $0.014 + ConversationRelay $0.07 = $0.084 + LLM | REPO LOW ≈ 4× **iff** ConversationRelay is the live lane | Not changed (changes a budget-gate verdict; the live lane is a configuration fact). Owner decision recorded in notes |
| D6 | Perplexity Sonar | $1 / $1 — `lib/ai/cost-tracking.ts:103-108` | $0.25 / $2.50 + $2.50 / 1,000 searches | both | Outside-lane (`lib/ai`) |
| D7 | Perplexity Sonar Pro | `perplexity/sonar-pro` — `lib/ai/models.ts:84`, `cost-tracking.ts:110` | not in Gateway catalog | lane cannot be served | Outside-lane; certification finding for 143H |
| D8 | AI Gateway adapter price | `VENDOR_PRICING.anthropic_claude` $20 / 1M tokens — `cost-normalizer.ts:168`, the `priceKey` at `provider-adapters.ts:170` | per-model prices (`getModelPricing`) are the survivor | display-only twin, ~7× the blended token cost | Outside-lane (143H): derive the adapter's AI price from `getModelPricing` (orphan doctrine §1) |
| D9 | Legacy token rows `openai_gpt4` $30 / M, `openai_gpt35` $2 / M | `cost-normalizer.ts:157, 163` | not an official price of any routed model | stale | Outside-lane; verify no reader, then tombstone onto `getModelPricing` |
| D10 | BatchData `$0.50` / `$0.07` | `cost-normalizer.ts:224`; `batchdata-client.ts:1440` | page shows subscriptions only | UNVERIFIED | Owner/contract (§8) |
| D11 | Mapbox GL JS map load | $0.005 — `cost-normalizer.ts:92` | not readable this session | UNVERIFIED | none |
| D12 | Lob postcard | $0.78 — `cost-normalizer.ts:63` | $0.905 / $0.645 / $0.615 by plan (+$0.004 on 2026-11-01) | plan-dependent | none; plan fee excluded from per-piece |
| D13 | Remotion licence | not booked | $0 / $0.01 per render | unbooked | owner, §8 |

Counts (denominator = the 37 rows in §3 that name a figure the repo books): **23 MATCH** · **4 REPO HIGH** (3 conservative and kept: SendGrid, Resend, ZenRows; 1 outside-lane:
ElevenLabs) · **3 REPO LOW** (Twilio SMS, the AI-voice estimate, Lob verification — all outside this lane's files) · **2 AI-catalog differences** (Sonar price; Sonar-Pro not servable) ·
**3 UNVERIFIED** (BatchData ×2, Mapbox GL load) · **1 plan-dependent** (Lob postcard) · **1 corrected here** (Apify). 23 + 4 + 3 + 2 + 3 + 1 + 1 = 37. Exclusions are in §11.

## 10. Sources (all read 2026-10-23 unless a date is shown)

Anthropic pricing — <https://platform.claude.com/docs/en/about-claude/pricing> · Vercel AI Gateway pricing — <https://vercel.com/docs/ai-gateway/pricing> (updated 2026-09-08) ·
Gateway model catalog — <https://ai-gateway.vercel.sh/v1/models> and <https://vercel.com/ai-gateway/models> · Google Gemini — <https://ai.google.dev/gemini-api/docs/pricing> (updated 2026-10-22) ·
Perplexity — <https://docs.perplexity.ai/docs/getting-started/pricing> · LiveKit Cloud/Inference (endpoint) · Vercel — <https://vercel.com/pricing> · Supabase — <https://supabase.com/pricing> ·
Twilio SMS — <https://www.twilio.com/en-us/sms/pricing/us> ("current as of October 2026") · Twilio voice — <https://www.twilio.com/en-us/voice/pricing/us> ("current as of August 2026") ·
Twilio A2P — <https://www.twilio.com/en-us/phone-numbers/a2p-10dlc>, <https://www.twilio.com/docs/trust-hub/registrations/a2p-10dlc-brand> · SendGrid — <https://www.twilio.com/en-us/products/email-api/pricing> ·
Resend — <https://resend.com/pricing> · Versium — <https://versium.com/pricing> · RentCast — <https://www.rentcast.io/api> · BatchData — <https://batchdata.io/pricing>, <https://batchdata.io/skip-tracing> ·
People Data Labs — <https://support.peopledatalabs.com/hc/en-us/articles/25794271805211-Pricing-credits> (2025-10-24) · Exa — <https://exa.ai/pricing> · Tavily — <https://docs.tavily.com/documentation/api-credits> ·
Zyte — <https://www.zyte.com/pricing/> · ZenRows — <https://www.zenrows.com/pricing> · Apify — <https://apify.com/pricing> · Mapbox — <https://www.mapbox.com/pricing> ·
Google Maps — <https://developers.google.com/maps/billing-and-pricing/pricing> (updated 2026-10-21) · Open-Meteo — <https://open-meteo.com/en/pricing> · Simli — <https://www.simli.com/> ·
ElevenLabs — <https://elevenlabs.io/pricing/api> · Remotion — <https://www.remotion.dev/docs/license/pricing>, <https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md> ·
AWS Lambda — <https://aws.amazon.com/lambda/pricing/> · Transistor — <https://support.transistor.fm/en/article/how-do-storage-limits-work-tr6fpa/> ·
YouTube quota — <https://developers.google.com/youtube/v3/determine_quota_cost> (updated 2026-10-15) · Stripe — <https://stripe.com/pricing>, <https://stripe.com/connect/pricing> ·
Lob — <https://www.lob.com/pricing>, <https://help.lob.com/print-and-mail/ready-to-get-started/pricing-details> (2026-09-29), <https://help.lob.com/address-verification/ready-to-start-av/av-pricing> ·
DocuSign developer plans — <https://ecom.docusign.com/plans-and-pricing/developer> · NewsAPI.ai — <https://newsapi.ai/plans> · Vapi (decommissioned) — <https://vapi.ai/pricing> ·
Real-estate software anchors — <https://www.followupboss.com/pricing>, <https://brokerage.getverticalos.com/pricing/> (2026-10-12). D-ID: owner reading 2026-09-12 (`lib/video/realism-profile.ts:1585`).

## 11. Blind spots and exclusions (published beside the numbers)

- **Denominator.** 73 provider declarations exist in `provider-adapters.ts`; this report prices the **platform-paid** ones with a primary page (≈ 30) and
  classifies the rest (tenant-paid, free, decommissioned, unknown). It does **not** price every tenant-paid CRM/MLS/ad API.
- **Not readable:** OpenAI's own pricing page (HTTP 403 → Gateway-sourced), D-ID's API page (client-rendered), Remotion's pricing component, DocuSign Intermediate/Advanced,
  Mapbox GL JS load price in raw text, Lob's current-year AV table (page marked "updated 2 years ago").
- **A summarising page reader was used for several pages** (Twilio, Vercel, Supabase, Versium, RentCast, BatchData, Exa, Zyte, ZenRows, Tavily, Stripe, Resend, ElevenLabs). It
  produced one demonstrably wrong table (Mapbox), caught by a raw-text fetch. Rows with only a summarised source and a material consequence are marked in the notes for a
  second human read before purchase.
- **No negotiated discounts, no taxes, no FX, no card-network surcharges** are modelled. Provider prices change without notice; every row carries its read date.
- **No live database access.** `plan_limits` live values for metrics other than AI tokens, video minutes and seats were not read; the repo's seeds are cited as such.
- **Usage (not price) is assumed** in the companion document; this report contains no usage claims except the scheduler invocation count taken from the repo's own census.
