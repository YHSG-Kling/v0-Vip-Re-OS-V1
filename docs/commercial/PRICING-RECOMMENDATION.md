# Pricing Recommendation — conservative / balanced / premium

**Wave 143, lane 143I. PROPOSAL ONLY — owner approval pending.** Nothing in this document, and nothing this lane did, creates a Stripe
product or price, edits `subscription_tiers` / `plan_limits`, sets an environment variable, buys a provider plan, or charges anyone. All
dollar figures here are *recommended values to approve*. Price read date for provider costs: **2026-10-23**; evidence is in
[`PROVIDER-COST-REPORT.md`](./PROVIDER-COST-REPORT.md).

> **Two registers in one file, kept apart on purpose.** §4–§7 and §9 are **INTERNAL** (they name providers and unit costs). §8 is the
> **customer-facing language** and never names a provider (owner: provider-cost attribution stays separate from customer-facing language).

---

## 1. The recommendation on one page

**Adopt the BALANCED column.** It prices the product as what it is — a CRM, website, compliance and transaction desk *plus* AI managers, video,
voice and data — while keeping the worst realistic month profitable. Conservative is viable only for solo/small-team and loses money at the
vendor ceiling for brokerage-size tenants; premium assumes the market will pay ~3× a CRM and has no evidence yet.

| Monthly list price (annual = 10 × monthly, "two months free") | Conservative | **Balanced (recommended)** | Premium |
|---|---:|---:|---:|
| **Solo Agent** — 2 producer seats | $149 | **$249** | $399 |
| **Team** — 10 producer seats | $599 | **$899** | $1,399 |
| **Brokerage** — 30 producer seats | $1,499 | **$2,499** | $3,999 |
| **Multi-location** — custom (floor, up to 3 locations / 80 seats) | $4,500 | **$7,500** | $12,000 |
| One-time **setup fee** (Solo / Team / Brokerage / Multi from) | $149 / $349 / $999 / $2,500 | **$299 / $599 / $1,999 / $4,500** | $499 / $999 / $2,999 / $7,500 |
| **Extra seats** — package (Team / Brokerage) | 5 × $59 · 10 × $49 | **5 × $69 · 10 × $59** | 5 × $99 · 10 × $79 |
| Non-producing staff / admin seats | free | **free** | free |
| Modelled gross margin, typical month, 250 tenants (Solo / Team-5 / Team-10 / Brokerage-22 / Multi-80) | 54 / 60 / 34 / 37 / 29 % | **71 / 72 / 55 / 61 / 56 %** | 81 / 81 / 70 / 74 / 71 % |
| Same, **heavy** month *with the vendor ceiling binding* | 17 / 30 / 2 / **−5** / **−15** % | **49 / 52 / 34 / 36 / 30 %** | 67 / 68 / 56 / 58 / 55 % |

*Gross margin* = list price − provider cost − per-tenant fixed (numbers, A2P, site traffic) − support hours − allocated platform fixed − Stripe (3.6% + $0.30).
It **excludes** acquisition cost, R&D, salaries, G&A, refunds, trials and tax. Every usage input is a labelled assumption (§4); replace them with measured p50/p90 using
the SQL in §11 before launch.

**Four things the owner must decide, in order of money at stake** (full list §10): (1) pick the column; (2) fix the video overage — today's $0.50/min is below the
$1.25/min cost of an avatar minute; (3) decide whether messages, voice minutes and data credits are *included allowances + packs* (recommended) or *pass-through*;
(4) scale the per-tier vendor ceiling with purchased seats (today it does not).

---

## 2. What is already decided (this proposal must not contradict it)

| Ruling / survivor | Where it lives | Consequence for pricing |
|---|---|---|
| Four canonical tiers `solo_agent`, `team`, `brokerage`, `multi_location` | `lib/billing/plan-catalog.ts:70` (`CANONICAL_TIERS`) | no fifth tier is proposed; "enterprise" **is** `multi_location` |
| **Seats = licensed producers**: solo **2**, team **10**, brokerage **30**, multi-location **custom**; staff/admin (non-producing) are **free**; more seats via **seat packages**, or upgrade/downgrade | owner 2026-09-23 (wave 79A), `plan-catalog.ts:111` `TIER_SEAT_BANDS`; m660 | price is per tier band + packages; no per-staff charge |
| **"The fee is setup fee"** | same ruling | a one-time setup fee column is part of every plan |
| Tiers differ by **seat count, not feature set** — solo and team get brokerage-level features | m527 | no feature-gating to defend a price; the lever is **allowances** |
| Multi-location is **custom-priced**; list price is never shown; self-serve checkout refused | `plan-catalog.ts:155-175` (`isCustomPricedTier`, `customPricingCheckoutRefusal`) | §6.5 gives a quote formula + a floor, not a list price |
| **AI is platform-covered**; the tier sets an included monthly token quota; usage past it is **served and billed** as overage | m479; quotas **2M / 10M / 30M / 100M** tokens (`scripts/1054-ai-fair-use-quotas.sql`) | AI cost is inside the price up to the quota, then billed |
| **Video is tier-metered**, overage billed: **30 / 150 / 300 / unlimited** minutes; overage today **$0.50/min** | m666 (applied live), m669 | see §6.3 — rate is below avatar cost |
| Scraping, behaviour monitoring, social/brand listening, operational intelligence are **platform-covered**, never billed separately | `cost-normalizer.ts:36-41` (`CostCoverage`) | data/research cost sits in margin, governed by the vendor ceiling |
| Per-tier **vendor ceiling** on non-AI platform spend: **$50 / $200 / $750 / $2,500 per month** | `lib/vendor-governance/budget-eval.ts:9` | the engineered worst case; §7 |
| **Stripe tier pricing is not set; nothing may hard-code a tier price**; an unset price resolves to `price_not_configured` | `plan-catalog.ts:186-215` | this document is not a source of prices for code |
| Commission is off agent-facing display; Stripe SaaS ≠ commission payments | CLAUDE.md §5; wave 143C | no commission-based pricing is proposed |
| Impersonation, lender/title seat model, etc. | CLAUDE.md §4 | unaffected |

---

## 3. Market anchors (what a buyer compares us to)

| Product | Published price | Source, date |
|---|---|---|
| Follow Up Boss (Zillow Group) — CRM, no website/IDX | Grow **$69/user/mo** ($58 annual) · **Pro $499/mo incl. 10 users** (+$49 each) · **Platform $1,000/mo incl. 30 users** (+$20 each) · Calling add-on $39/user | followupboss.com/pricing, read 2026-10-23 |
| Sierra Interactive — IDX site + CRM | $299.95 – $599.95/mo, 12-month agreement | brokerage.getverticalos.com/pricing, verified 2026-10-12 |
| Real Geeks — IDX site + CRM | $399/mo + **$500 setup** (range $10 – $599) | theprotoolkit.com 2026-06-15; getverticalos 2026-10-12 |
| Lofty (formerly Chime) | quote-only; third-party estimate ≈ $449/mo + $299 – $1,499 setup; AI Sales Agent from ≈ $60/mo (200 leads) | getverticalos 2026-10-12; rainautomation.com 2026-07-03 (**estimates**) |
| BoldTrail (kvCORE) | quote-only; estimates ≈ $249 – $499 solo, $499 – $999 team, $2,500+ brokerage, ≈ $999 onboarding | vendor says no public list (2026-06-05); **estimates** |
| SkySlope (transactions/compliance) | $340/mo | getverticalos 2026-10-12 |
| dotloop | $0 – $34.99/user/mo | same |
| Wise Agent | $49 – $69/mo | same |

**Reading.** CRM-only tools sit at **$33 – $108 per user per month** (FUB Platform at the low end, Grow + Calling at the high end). Website+CRM suites sit at
**$300 – $600 per month** for an agent or small team. Nothing in this set bundles autonomous AI follow-up, avatar/template video, voice agents, a compliance
and closing desk, CDA and a tenant website. Balanced Team ($899 for up to 10 seats = **$90/seat**) is ≈ 1.8× FUB Pro's $499 and ≈ 2.7× FUB Platform per seat — a premium that
must be earned by the bundle. **This is a hypothesis, not evidence of willingness to pay.** §9 proposes a priced pilot to test it.

---

## 4. Cost basis (INTERNAL)

### 4.1 Unit costs used (each traces to PROVIDER-COST-REPORT.md)

| Unit | Cost | Basis |
|---|---:|---|
| AI inference, blended per 1M tokens (today's routing, 4:1 input:output) | **$2.96** | Sonnet 4.6 30% · Haiku 4.5 35% · GPT-4o 15% · GPT-4o-mini 5% · GPT-5-mini 5% · Gemini 2.5 Flash 5% · Sonar 5% (assumption A2: from the lane reasons in `lib/ai/models.ts`, **not measured**) |
| …after re-routing to Sonnet 5.5 / Haiku 5.5 (tokenizer +30% applied) | **$2.20** (−26%) | report §3.1 |
| Avatar-presenter video minute | **$1.25** | D-ID Scale $297 ÷ 1,200 credits × 15 s = $0.99/min list; + voice 900 chars × $0.08/1K = $0.07; + 20% void-credit slack (A3) |
| Template (Remotion) video minute | **$0.12** | ≤ $0.0134 render function + $0.07 voice + storage/CDN slack (A4) |
| Live avatar minute (D-ID streaming) / live assistant minute | $0.515 / $0.12 | $297 ÷ 600 streaming min; ElevenLabs Agents $0.08/min + tokens |
| AI voice-call minute (Twilio ConversationRelay lane) | **$0.088** | carrier $0.014 + ConversationRelay $0.07 + LLM ≈ $0.004 |
| SMS segment (US 10DLC, outbound) | **$0.0131** | $0.0083 + average carrier fee $0.0045 + failed/other slack |
| Email | $0.0009 | SendGrid Pro $89.95 ÷ 100k |
| Enrichment per new contact | $0.13 | repo `ESTIMATED_ENRICHMENT_COST_USD` $0.16 / lead $0.10 (`contact-enrichment-core.ts:79`, `lead-enrichment-core.ts:96`) |
| Market-data lookup | $0.05 | RentCast $0.074 (Foundation) … $0.018 (Scale), BatchData/maps blend (A5) |
| Support hour (loaded) | $45 | assumption A6; AI-triaged, so hours are small |
| Stripe | 3.6% + $0.30 (card) · ≈ $5 + 0.7% (ACH) | report §3.7 |
| Platform fixed commitments | **$637/mo at launch**, stepping to $850 / $1,700 / $5,200 at ≈ 50 / 250 / 1,000 tenants (A8) | report §4 |

### 4.2 Usage per producer seat per month (ASSUMPTIONS A7 — replace with telemetry)

| | Light | **Typical** | Heavy |
|---|---:|---:|---:|
| AI tokens (M) | 0.5 | **2.0** | 6.0 |
| Avatar video (min) | 0.5 | **2** | 8 |
| Template video (min) | 3 | **10** | 30 |
| Live avatar (min) | 3 | **8** | 25 |
| AI voice calls (min) | 15 | **40** | 120 |
| SMS segments | 60 | **200** | 800 |
| Emails | 400 | **1,500** | 6,000 |
| New contacts enriched | 15 | **40** | 150 |
| Data lookups | 15 | **40** | 150 |
| Web research / storage ($) | 0.3 / 0.2 | **1.0 / 0.6** | 4.0 / 2.5 |
| **Cost per seat (all vendors incl. AI)** | **$9.68** | **$30.04** | **$104.20** |
| …of which non-AI vendor spend | $8.20 | $24.11 | $86.42 |

For calibration: the quotas the platform already ships (AI 2M / 10M / 30M tokens) are ≈ **1M tokens per seat**. "AI is the main function" — autonomous managers that
reason on every inbound event — will plausibly run at 2–6M per seat; §9 shows the margin if it runs 3× hot.

### 4.3 Archetypes

| Archetype | Producer seats | Tier | Support h/mo (typical) | Phone numbers |
|---|---:|---|---:|---:|
| Solo agent | 1 | solo_agent | 0.25 | 2 |
| Small team | 5 | team | 0.75 | 3 |
| Large team | 10 (top of band) | team | 1.5 | 4 |
| Brokerage | 22 | brokerage | 3.0 | 8 |
| Multi-location | 80 (3 locations) | multi_location | 8.0 | 24 |

Per-tenant fixed: phone numbers $1.15 each, A2P campaign ≈ $6/mo, A2P one-time $61 amortised over 24 months, website traffic $1 – $300 by intensity and size.

---

## 5. Modelled economics (INTERNAL)

### 5.1 Monthly cost per tenant, 250 tenants on the platform (before Stripe)

`*` = the per-tier vendor ceiling binds; the figure shown is the ceiling, and the uncapped modelled vendor spend is after the slash.

| Archetype | Light | Typical | Heavy |
|---|---:|---:|---:|
| Solo (1 seat) | $35 | **$63** | $118 * (vendor 50/86) |
| Small team (5) | $96 | **$218** | $399 * (200/432) |
| Large team (10) | $174 | **$372 *** (200/241) | $564 * (200/864) |
| Brokerage (22) | $372 | **$893** | $1,519 * (750/1,901) |
| Multi-location (80) | $1,216 | **$3,049** | $5,005 * (2,500/6,913) |

At 50 tenants the same table is higher by the fixed-allocation difference only ($10 – $255 per tenant): Solo typical $73, Small team $238, Brokerage $975, Multi $3,304.

### 5.2 Gross margin at list price (250 tenants) — all three columns

| Column · archetype | List/mo | Light | Typical | Heavy (ceiling binds) |
|---|---:|---:|---:|---:|
| Conservative · Solo | $149 | 72.7% | 54.0% | 16.7% |
| Conservative · Team (5 seats) | $599 | 80.3% | 60.0% | 29.8% |
| Conservative · Team (10 seats) | $599 | 67.3% | 34.2% | 2.1% |
| Conservative · Brokerage (22) | $1,499 | 71.6% | 36.8% | **−5.0%** |
| Conservative · Multi (80) | $4,500 | 69.4% | 28.6% | **−14.8%** |
| **Balanced · Solo** | **$249** | **82.2%** | **71.0%** | **48.7%** |
| **Balanced · Team (5)** | **$899** | 85.7% | 72.2% | 52.0% |
| **Balanced · Team (10)** | **$899** | 77.0% | 55.0% | 33.6% |
| **Balanced · Brokerage (22)** | **$2,499** | 81.5% | 60.7% | 35.6% |
| **Balanced · Multi (80)** | **$7,500** | 80.2% | 55.7% | 29.7% |
| Premium · Solo | $399 | 87.5% | 80.6% | 66.6% |
| Premium · Team (5 / 10) | $1,399 | 89.5% / 84.0% | 80.8% / 69.8% | 67.9% / 56.0% |
| Premium · Brokerage (22) | $3,999 | 87.1% | 74.1% | 58.4% |
| Premium · Multi (80) | $12,000 | 86.3% | 71.0% | 54.7% |

At 50 tenants, Balanced typical is 66.9 / 69.9 / 51.5 / 57.4 / 52.3% (Solo / Team-5 / Team-10 / Brokerage / Multi).

**Why the ceiling matters: Balanced heavy month if the ceiling were removed** — Solo 34.1%, Team-5 26.2%, Team-10 **−40.3%**, Brokerage **−10.5%**, Multi **−29.2%**.
The $50 / $200 / $750 / $2,500 ceiling (`budget-eval.ts:9`) is what keeps a runaway month from going negative; it is also what a heavy customer will *feel* as a limit.

### 5.3 Included-allowance exposure (what if every allowance in §6.2 were fully used in one month)

| Tier | Cost if all allowances are fully used | …after the vendor ceiling | Gross margin at the Balanced price (before support / fixed) |
|---|---:|---:|---:|
| Solo | $82 (AI $6, vendor $76 vs ceiling $50) | $56 | 73.8% |
| Team | $410 (AI $30, vendor $380 vs ceiling $200) | $230 | 70.8% |
| Brokerage | $1,249 (AI $89, vendor $1,160 vs ceiling $750) | $839 | 62.8% |

**Finding:** the allowances, if all consumed, sum to **more than the engineered vendor ceiling** in every tier (Solo $76 vs $50; Team $380 vs $200; Brokerage $1,160 vs $750). The ceiling
therefore binds before the allowances do for a customer who uses everything — product behaviour to design for (§7), not a pricing error.

### 5.4 Break-even

Contribution before fixed allocation at Balanced / typical: Solo ≈ **$184**, Small team ≈ **$662** per tenant per month. The launch floor with avatar video switched on is
$637 + $297 (D-ID) = **$934/month** → **6 solo tenants, or 2 small-team tenants, cover it.** (Conservative: D-ID is also charged per minute inside the variable cost, so it is counted twice here. Excludes the founders' time and CAC.)

---

## 6. Plan design (Balanced)

### 6.1 Plans

| | **Solo Agent** | **Team** | **Brokerage** | **Multi-location** |
|---|---|---|---|---|
| Monthly / annual | **$249 / $2,490** | **$899 / $8,990** | **$2,499 / $24,990** | custom — floor **$7,500** |
| Setup fee (one-time) | $299 | $599 | $1,999 | from $4,500 |
| Producer seats included | 2 | 10 | 30 | custom (negotiated, `subscriptions.custom_seat_limit`) |
| Extra seats | — upgrade to Team | 5 for $345/mo ($69 each) | 10 for $590/mo ($59 each) | $49 each (floor), negotiated |
| Staff / admin / non-producing broker seats | free | free | free | free |
| Everything else (CRM, website + landing pages, AI managers, compliance, transactions, CDA, vendors, education) | included | included | included | included |

The setup fee covers: onboarding hours (1 / 3–4 / 8 / 24 at $45), A2P registration ($61 one-time), number provisioning and data import. Modelled cost to deliver: Solo $106,
Team $196 – $241, Brokerage $421, Multi $1,141 → the fees above are 2.8× / 2.5–3.1× / 4.7× / 3.9× cost.

### 6.2 Included monthly allowances (pooled per tenant)

Existing, **BUILT** (keep): AI tokens 2M / 10M / 30M / 100M; video minutes 30 / 150 / 300 / unlimited; active users 2 / 10 / 30 / custom; live assistant minutes 60 / 300 / 1,500 / unlimited
(`scripts/1021-agent-assistant-sessions.sql`). The rest are **recommended**; `plan_limits` live values for these metrics were not readable in this lane.

| Allowance (customer label) | Solo | Team | Brokerage | Multi |
|---|---:|---:|---:|---|
| AI credits (tokens) — BUILT | 2M | 10M | 30M | 100M+ |
| Video minutes (all kinds) — BUILT | 30 | 150 | 300 | custom |
| of which presenter-video minutes — **new sub-cap, needs a meter** | 6 | 30 | 60 | custom |
| Live assistant minutes — BUILT | 60 | 300 | 1,500 | custom |
| Live presenter minutes | 10 | 50 | 150 | custom |
| Voice-call minutes | 100 | 500 | 1,500 | custom |
| Text messages (segments) | 500 | 2,500 | 7,500 | custom |
| Emails | 5,000 | 25,000 | 75,000 | custom |
| Lead-enrichment credits | 100 | 500 | 1,500 | custom |
| Market-data lookups | 200 | 1,000 | 3,000 | custom |
| Storage | 25 GB | 100 GB | 300 GB | custom |

### 6.3 Overage and add-ons (Balanced)

Rule: **every overage price ≥ 2× its modelled cost** (margin ≥ 50%); if a price is below 2× cost the row says so.

| Meter | Customer price | Modelled cost | Margin | Status |
|---|---:|---:|---:|---|
| AI credits over quota | **$20 / M tokens** (2¢ per 1K) Solo & Team · **$10 / M** (1¢ per 1K) Brokerage & Multi | $2.96 / M ($2.20 after re-route) | 85% / 70% (89% / 78%) | **BUILT** (m479 seeds) — keep. Constraint: the column is integer cents per 1K, so **$10 / M is the lowest possible rate** |
| Video minute over quota — **today** | $0.50 / min | $0.12 template · **$1.25 avatar** | 76% / **−150%** | BUILT (m666) — **wrong for avatar** |
| Video minute over quota — **interim recommendation** | **$1.00 / min** (`overage_rate_cents_per_1k = 100000`) | typical mix $0.31 · all-avatar $1.25 | 69% typical · **−25%** all-avatar | edit one row; still loses on a pure-avatar tenant |
| Video minute — **target** (split metric) | template **$0.50** · presenter **$2.50** | $0.12 · $1.25 | 76% · 50% | needs a new billed metric (`OVERAGE_BILLED_METRICS`), a `plan_limits` row per tier and a Stripe meter — **code + migration, not done here** |
| Live presenter pack | 60 min / **$59** | $0.515 / min | 48% | new add-on |
| Live assistant pack | 300 min / **$75** | $0.12 / min | 52% | new add-on |
| Voice-call pack | 500 min / **$99** | $0.088 / min | 56% | new add-on |
| Text-message pack | 1,000 segments / **$29** | $0.0131 | 55% | new add-on |
| Emails over allowance | **$2 / 1,000** | $0.9 / 1,000 | 55% | new |
| Lead-enrichment pack | 500 credits / **$149** | $0.13 | 56% | new add-on |
| Market-data pack | 1,000 lookups / **$99** | $0.05 | 49% | new add-on |
| Dedicated phone number | **$5 / mo** (toll-free $8) | $1.15 (toll-free $2.15) per number; the A2P campaign fee ($1.50 – $10 / mo per campaign) is shared by every number on the campaign and sits in the per-tenant fixed line | 77% (73%) on the number alone | new |
| Direct mail (if sold) | pass-through at provider list + 20% (4×6 postcard ≈ $0.78 at the Startup rate) | $0.649 + $260 / mo plan | thin below ≈ 1,700 pieces / mo | optional; the plan fee must be amortised or the tenant uses their own account |
| Extra location (Multi, beyond 3) | **$750 / mo** | ≈ support + site | negotiated | custom |

### 6.4 Seat packages and the vendor ceiling

A seat package adds seats but **not** vendor budget: `MONTHLY_VENDOR_BUDGET_USD` is per tier, not per seat (`lib/vendor-governance/budget-eval.ts:9`). A Team that buys 10 extra seats still has a
$200 ceiling for 20 producers. **Recommendation:** raise the effective ceiling by **$20 per purchased extra seat (Team) / $25 (Brokerage)** — owner decision #4. An extra seat costs ≈ $30 at typical use,
so $69 / $59 gives ≈ 48% / 40% margin before support.

### 6.5 Multi-location (enterprise) quote formula

```
monthly_quote = max( FLOOR ,
                     ( modelled_cost_at_typical(seats, locations) + 1 CSM allocation )
                     / ( 1 − target_GM − stripe_pct ) )         target_GM = 0.55 – 0.60, stripe_pct ≈ 0.01 by ACH
              + $49 × seats above 30  +  $750 × locations above 3  +  add-on packs
FLOOR (Balanced) = $7,500     (= cost-plus at ≈ 58% GM for the 80-seat / 3-location archetype, modelled cost $3,049)
setup           = from $4,500  (modelled cost $1,141)
billing         = annual contract, invoiced by ACH (saves ≈ 2.7 points vs card), vendor ceiling set per contract
```

### 6.6 What changes in Conservative and Premium

Conservative: same allowances, prices ×0.6 (Solo $149, Team $599, Brokerage $1,499, Multi $4,500) — viable only if the vendor ceiling for Brokerage/Multi is cut ≈ 35% or
allowances are trimmed (otherwise the heavy-month margin is negative, §5.2). Premium: same allowances, prices ×1.6; justified only by a pilot showing buyers pay it; adds a dedicated
success manager at Brokerage and above.

---

## 7. Guardrails and the high-use risk

1. **Margin policy (proposed):** target ≥ 60% gross margin at typical usage and ≥ 30% at the vendor ceiling for every plan; no included allowance whose full-use cost exceeds 35% of the tier price;
   every overage ≥ 2× cost; **re-price when any cost line drifts > 15%** (the drift register in the cost report is the trigger list).
2. **The ceiling is a feature boundary, not just a safety valve.** When `checkVendorBudget` refuses (`blocked`), the tenant sees a *limit reached* message and an add-on offer — never a provider error. The ledger already carries
   `degraded` / `degradedTier` / `degradedSpend` flags (`budget-eval.ts`) so a *read failure* fails open for consented client communication; confirm that is acceptable for spend caps.
3. **Avatar video is the single largest unit-cost risk** ($1.25/min, credits void monthly, $297 floor). Until the metric is split: cap presenter video inside the 30/150/300 minutes, do not sell unlimited video below
   Multi-location, and set the interim overage to $1.00.
4. **Staff seats are free but not free of cost.** They draw on the same pooled tokens and vendor ceiling; the pooling is the protection.
5. **AI running hot.** If autonomous managers consume 3× the typical tokens, margin drops 5 – 14 points (§9) — still positive; the token quota + overage already prices it.
6. **A change in model routing moves the ledger, the price table and the margin together** (`MODEL_CONFIG` + `getModelPricing` in one commit).
7. **Trial economics.** A 14-day trial of a typical Solo costs ≈ $30 – $35 in provider + fixed cost; plan CAC accordingly (not modelled).

---

## 8. Customer-facing language (no provider names)

Meters shown to the customer, in the customer's words. Provider attribution never appears on the pricing page, in the plan card, in an upgrade prompt or in an invoice line.

| Customer sees | Unit | Internal meter |
|---|---|---|
| **AI credits** | monthly pool of AI usage | `ai_tokens_monthly` |
| **Video minutes** | minutes of finished video | `video_minutes` |
| **Presenter-video minutes** (proposed) | minutes of on-screen-presenter video | new |
| **Live assistant minutes** | minutes of live voice assistant | `live_assistant_minutes` |
| **Voice-call minutes** | minutes of AI-handled calls | a voice meter (the legacy `vapi_minutes` name is the only one in the `plan_limits` vocabulary and Vapi is decommissioned — renaming it is a vocabulary decision for the integrator, CLAUDE.md §6) |
| **Messages** | text messages sent | `sms_sent` |
| **Emails** | emails sent | `emails_sent` |
| **Lead-enrichment credits** | new contacts completed with verified details | enrichment meter (none yet in `plan_limits`) |
| **Market-data lookups** | property / market lookups | none yet |
| **Producer seats** | licensed producing agents | `active_users` / `max_agents` |

Plan card copy (Balanced, illustrative — final wording is a marketing decision):

> **Team — $899 / month** (or $8,990 / year, two months free) · one-time setup $599
> Up to **10 producing agents** — non-producing staff are always free. Your own tenant website with landing pages, AI team members that follow up on every lead, video, voice and messaging,
> compliance and closing desk, commission statements, vendor network.
> Includes each month: **10M AI credits · 150 video minutes · 30 presenter-video minutes · 300 live-assistant minutes · 500 voice-call minutes · 2,500 messages · 500 lead-enrichment credits**.
> Need more? Add a pack, or upgrade — nothing stops mid-conversation with a customer.
> *Add 5 more producing agents for $345 / month.*

At a limit the product says "You've used this month's lead-enrichment credits — add 500 for $149 or they reset on the 1st." It never says which vendor.

---

## 9. Sensitivities (Balanced, typical, 250 tenants — gross margin %)

| Scenario | Solo | Team-10 | Brokerage |
|---|---:|---:|---:|
| Baseline | 71.0 | 55.0 | 60.7 |
| AI tokens per seat ×3 | 66.2 | 41.8 | 50.2 |
| AI re-routed to Sonnet 5.5 / Haiku 5.5 | 71.6 | 56.7 | 62.0 |
| Avatar-video credit utilisation 50% (cost ×1.6) | 70.4 | 55.0 | 59.3 |
| SMS + voice carrier fees +50% | 69.8 | 55.0 | 58.0 |
| Enrichment $0.28 per contact (PDL-only path) | 68.6 | 55.0 | 55.4 |
| Support hours ×2 | 66.5 | 47.4 | 55.3 |
| **Combined downside** (AI ×3, avatar ×1.6, support ×2, enrichment $0.28) | **58.7** | **34.3** | **38.2** |

Break-even volumes: BatchData skip-trace subscription ($2,000/mo) beats $0.07 pay-per-match above ≈ 28,571 matches/month (if the pay-per-match rate is real — unverified); a Versium annual subscription ($5,000) beats
$0.05 credits above ≈ 100,000 matches/year. Card vs ACH on a $2,499 invoice: $90.26 vs $22.49.

**Pilot to replace the hypothesis in §3:** the first ~30 tenants are offered the three columns at random (Solo and Team only), with setup fees waived for a "founding" cohort that agrees to share usage telemetry. Metrics: conversion by column,
realised usage vs §4.2, ceiling hits per tenant, support hours per tenant, 90-day retention. Decide the price list after 60 days, not before.

---

## 10. Owner decisions and what is not done

**Decisions needed (ordered by money at stake):**

1. Choose the column (recommended: Balanced) and approve the list prices, setup fees and annual discount (§1, §6.1).
2. Video overage: approve the **interim $1.00/min** (one `plan_limits` row each for Solo/Team/Brokerage) and the build of a **presenter-video** metric (code + migration + Stripe meter) for the $0.50 / $2.50 split.
3. Include **messages, voice minutes, enrichment and data lookups** as allowances with packs (recommended) vs pass-through; approve the pack prices (§6.3).
4. Scale the vendor ceiling with purchased seats (+$20 / +$25 per extra seat) or accept a fixed ceiling.
5. Multi-location floor and quote formula (§6.5).
6. Buy the D-ID Scale plan only when presenter video is sold; re-read its price page first (the 2026-09-12 reading is the owner's; the page renders client-side).
7. AI model routing: approve a quality evaluation of Sonnet 5.5 / Haiku 5.5 (−26% blended cost).
8. Licences to confirm before launch: Remotion (free vs $100/mo + $0.01/render), Mapbox Commercial Application License, BatchData per-record quote, Versium credit weights.
9. Whether SMS/voice carrier surcharges are passed through at cost (an alternative to the pack prices). **E-signature envelopes are deliberately in no allowance**: a platform DocuSign account is wired
   (`DOCUSIGN_PLATFORM_ACCOUNT_ID`) and its integrator envelope rate is unpublished; decide tenant-pays vs platform-pays once quoted.
10. Founding-customer discounts (not modelled).

**Nothing was done:** no Stripe product/price/meter/coupon, no `subscription_tiers` / `plan_limits` write, no env var, no provider purchase, no public release.

**Values to enter when approved (Balanced; integer cents, the repo's money unit) — NOT APPLIED:**

| Tier | `monthly_price_cents` | `annual_price_cents` | `setup_fee_cents` | `seat_package_size` | `seat_package_price_cents` |
|---|---:|---:|---:|---:|---:|
| solo_agent | 24900 | 249000 | 29900 | — (null, not sold) | — |
| team | 89900 | 899000 | 59900 | 5 | 34500 |
| brokerage | 249900 | 2499000 | 199900 | 10 | 59000 |
| multi_location | custom (`isCustomPricedTier`; any catalogue value is internal only) | — | from 450000 | — | negotiated |

`plan_limits` overage (cents per 1K units): `ai_tokens_monthly` 2 / 2 / 1 / 1 (**already live**, unchanged); `video_minutes` **100000** (interim; live value 50000).
Stripe objects these map to (names only, **not created**): one product per tier with monthly, annual and one-time setup prices; one licensed seat price per tier; metered prices for AI credits and video minutes
(columns `stripe_metered_price_id`, `stripe_metered_rate_cents_per_1k` exist on `plan_limits`). The activation order belongs to the lane-143H checklist.

---

## 11. Calibration SQL (read-only) — replace the assumptions with measured numbers

Run in the Supabase SQL editor (project `hrvaqgvukzxfskkcrwbt`); nothing here writes.

```sql
-- 1. AI cost and tokens per tenant per month, last three closed months (ai_tool_usage is the cost ledger).
select b.plan_tier, a.brokerage_id, date_trunc('month', a.created_at) as month,
       sum(a.tokens_used) as tokens, round(sum(a.cost_cents) / 100.0, 2) as ai_usd
from ai_tool_usage a join brokerages b on b.id = a.brokerage_id
where a.created_at >= date_trunc('month', now()) - interval '3 months'
  and a.created_at <  date_trunc('month', now())
group by 1, 2, 3 order by 3, 5 desc;

-- 2. Non-AI vendor spend per vendor per month (platform ledger).
select date_trunc('month', v.created_at) as month, v.vendor_name,
       count(*) as rows, sum(v.units_used) as units, round(sum(v.total_cost)::numeric, 2) as usd
from vendor_usage_tracking v
where v.created_at >= date_trunc('month', now()) - interval '3 months'
  and v.created_at <  date_trunc('month', now())
group by 1, 2 order by 1, 5 desc;

-- 3. Distribution to size the allowances: p50 / p90 monthly usage per tenant by tier and metric.
select b.plan_tier, c.metric,
       percentile_cont(0.5) within group (order by c.value) as p50,
       percentile_cont(0.9) within group (order by c.value) as p90, count(*) as tenant_months
from usage_counters c join brokerages b on b.id = c.brokerage_id
where c.period_start >= date_trunc('month', now()) - interval '3 months'
group by 1, 2 order by 1, 2;

-- 4. Producer seats actually used vs the band.
select b.plan_tier, count(*) filter (where a.is_active) as active_agents, b.id as brokerage_id
from brokerages b left join agents a on a.brokerage_id = b.id
group by b.plan_tier, b.id order by 1, 2 desc;
```

Caveat: only two live tenants existed when the repo last recorded it (`m534`); the first read will be a sample of two, not a distribution. Treat §4.2 as the prior and these queries as the likelihood.

---

## 12. Method, reproducibility and blind spots

- **Model.** A closed-form spreadsheet-style model (blend formula `(4·in + 1·out)/5` for tokens; per-seat variable cost = Σ usage × unit cost; vendor spend capped at `MONTHLY_VENDOR_BUDGET_USD`; tenant fixed;
  support; allocated platform fixed; Stripe). It was computed in a scratch script whose full output is reproduced in the tables above; the formulas in §4 are sufficient to recompute it by hand.
- **Assumption register** — A1 token mix 4:1 input:output · A2 lane token shares · A3 D-ID void-credit slack 20% · A4 template-video cost · A5 data-lookup blend · A6 $45 / hour support · A7 usage per seat (§4.2) ·
  A8 platform fixed steps · A9 fixed-allocation footprint weights (1 / 2 / 3 / 8 / 25) · A10 live-assistant $0.12 / min. **Each can be wrong; none is measured.**
- **Not modelled:** CAC, free trials, refunds/chargebacks (Stripe dispute fee $15), taxes, FX, annual-plan cash timing, partner/reseller margin, Vercel overage above the $20 credit beyond the scheduler estimate, tenant-paid provider costs
  (CRM, MLS, DocuSign, ad spend), vendor-marketplace revenue share (a revenue line, `lib/commission/waterfall/09-revenue-share.ts`), commission/CDA services.
- **Fair-housing scope:** no pricing or allowance logic here touches CDA, commission, agreements, ledgers or closing reconciliation; fair-housing checks stay on public copy and housing-ad audiences only.
- **Market anchors** mix vendor pages (FUB, dated) and third-party summaries (marked *estimates*). They are context for the decision, not inputs to the cost model.
