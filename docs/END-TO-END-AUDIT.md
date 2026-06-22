# End-to-End Application Audit — Real Estate Agentic OS

> Living audit of the One Command Center multi-manager egress OS. Backed by the live Supabase project
> (`hrvaqgvukzxfskkcrwbt`) via MCP introspection + the full simulator suite. Keep this updated; it is the
> single source of truth for "where are the gaps."

## 1. Architecture (what makes this the category leader)

- **One egress, governed end-to-end.** Every consumer-reaching action funnels through a single gate
  (`lib/providers/dispatch.ts` + the connector-gateway): consent / opt-out / DNC / quiet-hours /
  de-confliction, then a tamper-proof **compliance ledger** (`compliance_events`), owned by an
  accountable manager. Proven on every commit by `test:egress-send-guard` (no ungoverned send across
  email/SMS/voice/social; no connector bypass; no consent-skip backdoor).
- **13 accountable managers** (`lib/kernel/manager-registry.ts`): 11 lead-working agent-kinds + 2
  back-office oversight managers (**Compliance Officer**, **Finance Manager**). Every Command Center
  queue / table / burn-domain maps to one (zero orphans — `test:manager-ownership`, 694 tables).
- **One Command Center** = the operator surface: live manager sessions, the approval queue with the
  **Compliance Officer pre-flight badge** (clear/advisory/blocked, Approve disabled on a hard block),
  the managers-talking feed, the **command bar** (text shares one dispatch with the voice admin), and
  the **Compliance Ledger** view.
- **Differentiator vs RealScout / Lofty / Rave / MoxiWorks:** they ship *tools*; this ships an
  **accountable AI management team** whose every outbound touch is consent-checked, Fair-Housing-cleared,
  audited, and **CI-proven** — including an accountable **Compliance Officer** none of them have.

## 2. Business-process coverage (scrape → lifetime)

| Stage | Owner(s) | Code + simulator | Live rows (DB) |
|---|---|---|---|
| 1 Scrape / leadgen | AI ISA, Data Steward | `test:speed-to-lead`, `test:source-conversion` | leads **0** (un-run) |
| 2 Qualify (AI ISA) | AI ISA | `test:isa-qualification`, `test:inbound-intent` | ai_daily_briefings 3 |
| 3 Contact spine | Data Steward | `test:data-steward`, `test:conversation-memory` | contacts 4, activities 12 |
| 4 Buyer journey | Shopping Agent | `test:buyer-intent-conversion`, `test:offer-net-sheet`, `test:tour-optimizer` | offers/tours **0** |
| 5 Seller / listings | Listing Concierge | `test:listing-appt-prep`, `test:net-sheet-surprise` | listings 3, showings 0 |
| 6 Deal / closing | Deal Coordinator, Compliance Officer | `test:closing-watchtower`, `test:fire-drill`, `test:compliance-gate` | transactions 2, milestones 10 |
| 7 Lifetime | Sphere Manager | `test:anniversary-equity`, `test:referral-radar` | referrals **0** |
| 8 Marketing / content | Campaign Orchestrator, Marketing, Asset, Ads | `test:campaign-center`, `test:promo-composition`, `test:ads-manager` | social_posts 3, rest 0 |
| 9 Governance / egress | Compliance Officer, all | `test:manager-dissent`, `test:compliance-ledger`, `test:egress-send-guard` | compliance_events 6 |
| 10 Command Center | all | `test:command-center`, `test:partners-meeting` | managed_agents **0** |

**234 simulators green** (`npm run guard` + `guard:compliance` + the full suite). **Build green** (Next 16
/ Turbopack, 431 pages). **Live schema conformance:** 729 base tables, **RLS enabled on every one**;
snapshot reconciled to live (687 → 694).

## 3. THE headline gap — the pipeline has never run on the live DB

The live DB is a **fresh seed**, not an exercised system:

- `managed_agents` **0**, `managed_agent_sessions` **0** → the AI managers have never been spawned here.
- `manager_signals` **0** → no inter-manager coordination has occurred.
- `agent_client_messages` **0** → the approval queue has never held a proposal.
- `leads` **0**, `offers` **0**, `tours` **0**, `commissions` **0**, marketing tables **0**.

**Meaning:** the code + simulators prove the logic works; they do **not** prove the journey has flowed
through the real database end-to-end. This is the difference between "tests pass" and "the OS has run."
Closing it requires **running the pipeline against the DB** — which needs a DB-reachable environment
(this audit's sandbox blocks the DB host via network egress policy).

**Action:** seed a demo brokerage and run the journey end-to-end via the **`e2e` workflow** (already
wired; needs the Supabase service-role secret in GitHub Actions) — OR a one-shot "demo seed + run"
script executed where the DB is reachable. This is the single most valuable validation left.

## 4. Gaps found & closed in this audit cycle

| # | Gap | Resolution |
|---|---|---|
| 1 | ~480 tables unowned (orphan egress activities) | Zero-orphans burn — every snapshot table → an accountable manager |
| 2 | No "command the team" surface | Command bar sharing the voice dispatch |
| 3 | Compliance & finance diffused into Data Steward | Added Compliance Officer + Finance Manager (11→13) |
| 4 | Pre-flight verdict not attributed / not visible | Compliance Officer pre-flight badge + ledger + on-demand view |
| 5 | Outbound copy not all pre-flighted | Extended pre-flight to all 7 outbound-copy queues |
| 6 | Ungoverned client sends (5 raw senders) | Routed through the gate; `egress-send-guard` freezes the surface |
| 7 | CCPA: opted-out contacts uploaded to Meta audiences | `isAudienceUploadEligible` live re-check (audience-eligibility guard) |
| 8 | Consent simulators not enforced in CI | `guard:compliance` tier (12 sims) added to CI |
| 9 | **Production build FAILED** (Remotion bundler in client) | Split pure net-sheet calc out of the server runner; build green |
| 10 | Finance export returned a fake URL | Real CSV/PDF data-URI export + cap anniversary rollover |
| 11 | 226 dead/duplicate components (drift) | Removed (reachability-verified); `test:no-dead-components` locks it |
| 12 | 7 live tables unguarded by schema-drift | Reconciled snapshot to live schema (introspected columns) |
| 13 | Differentiator invisible | Partners' Meeting recap reel (composition + props + render request, tested) |
| 14 | Headline e2e proof had no runner | `demo:seed-run` — turnkey seed→`processRawRecord`→assert→self-clean script (proves the pipeline on a real DB) |
| 15 | Academy learner side missing (reader/quiz/cert) | `/academy/module/[id]` reader→quiz→`agent_certifications`; de-mocked the hub; `test:academy-learning` |
| 16 | User support was a static mock | Real Help Center + ticketing wired to `support_tickets`/`knowledge_articles`/`help_topics_kb`; admin triage queue; `test:support` |
| 17 | Multi-location was an orphan schema | Office CRUD + agent↔office assignment on `locations`/`agents.location_id`; `test:locations` |
| 18 | **Manager evals written but never surfaced** | Manager Trust Scorecard over `agent_outcome_evaluations` → trust tier → recommended autonomy posture; `test:manager-trust` — the certifiable-governance moat |

### Drift investigated this cycle (NOT consolidated — both sides legitimately used)
- `notification-actions.ts` (markOneRead/markAllRead, used by `/notifications`) vs `notifications.ts`
  (getNotifications/createNotification, used by the bell): two thin kernel wrappers with different
  callers — marginal benefit, real regression risk; left as-is.

### Drift resolved (full dependency investigation first — two "delete" candidates were FALSE)
- **DELETED `app/actions/offer-management.ts`** — `@deprecated DO NOT USE`, zero importers (verified:
  no import path, no barrel re-export; the `submitOffer` hits were a local wizard fn), superseded by
  the compliance-gated `seller-offers.ts`. tsc/build green after removal.
- **KEPT `app/actions/buyer-offer/` (19 files)** — a sweep flagged it "dead code"; precise grep proved
  it's **heavily used** (lib/kernel/offers, buyer-broker/gate, em-receipt-watcher cron, form wizards,
  offer-bridge). Deleting it would have broken the offer lifecycle. Investigation prevented a regression.
- **KEPT `ai-offer-creation.ts` + `buyer-offers.ts` separate** — complementary layers (AI strategy/
  orchestration vs canonical CRUD), both actively imported; merging = high-risk churn, low benefit.
- **DELETED `app/actions/marketing-campaigns.ts`** (850 lines) — precise grep (the first pass matched
  the *separate* `marketing-campaigns-admin.ts` by substring) proved it has **zero importers**: no
  barrel re-export, no callers of its exports (the `createMarketingCampaign` namesake in
  `lib/kernel/marketing.ts` is a distinct kernel-level fn; the admin page uses `-admin.ts`). It was the
  orphaned **ungoverned** legacy shadow of the compliance-gated `marketing-studio.ts` (live UI at
  `/dashboard/marketing/studio`). Removing it closes an ungoverned campaign path. tsc/build green.
- **KEPT showings trio separate** (`showings` buyer-intake / `dispatch-showing` connector / `ai-showing-
  management` agent tours) — distinct stages, no overlapping exports.

### Orphaned server actions — durable ratchet + burn-down backlog (NEW)
A module-graph reachability guard (`test:no-orphan-actions`, in the `guard` CI tier) proves every file
under `app/actions` is imported by something (app/lib/scripts). It found **55** action files imported by
**nothing** — real drift, but mostly **unwired features, not dead duplicates** (e.g. `creditWorkflows.ts`
has live credit-referral fns; bulk-deletion would destroy intended functionality). Resolution follows the
strict rule: investigate each → **wire if it benefits, delete only if dead/superseded**. The 55 are frozen
in `scripts/orphan-action-baseline.json`; the guard **fails on any NEW orphan** (stops drift now) and nudges
to shrink the baseline as debt is burned down. Categories for the burn-down:
- **Demo scaffolding** (`demo-login`, `demo-contacts`) — product decision (keep for sales-demo mode, or delete).
- **Partial refactor** (8 × `buyer-offer/*`: create-offer, handle-offer-response, handle-multi-offer,
  rollback-offer, sync-documents, acknowledge-commission, create-dotloop-loop, resolve-property-prefill) —
  the *wired* siblings (submit-for-signature, track-offer-lifecycle, prefill-offer, convert-to-transaction)
  are live; confirm these 8 are superseded by `buyer-offers.ts` before deleting (watch multi-offer/rollback).
- **Burned down so far:** `revenue-pipeline.ts` → wired into `/dashboard/financials/pipeline` (broker
  probability-weighted 30/60/90-day GCI forecast); math extracted to the pure
  `lib/financials/revenue-projection.ts` + `test:revenue-pipeline` (13 checks). Baseline 55 → **54**.
- **Unwired features → wire if valuable** (`instant-property-alerts`, `ai-isa/{classify-outcome,schedule-
  appointment}`, `lead-assignment/*`, `lead-promotion/*`, `lead-readiness/*`, `contact-promotion/*`,
  `voice-engine/process-voice-call`, `scrape-social-media`, `marketing-intelligence`, `property-buyer-
  matching`, `revenue-pipeline`, `newsletter/*`, `settings/*-integration-credentials`, `video/generate-
  script`, `neighbor-notifications`, `creditWorkflows`, …). Each needs a home (UI/cron/kernel) or deletion.

### Verified NOT gaps (backend + UI both exist — code-grep "orphan" lists were stale)
- Commissions/earnings: `app/dashboard/financials/*` (9 pages incl. commissions, payouts, agent, reports).
- Gamification: `/dashboard/leaderboard` + `components/gamification/*` (PointsBadge, BadgeGrid).
- Always reconcile candidate gaps against the **live DB + actual pages** before building (see §3 lesson).

## 5. Remaining gaps / open items (prioritized)

1. **Run the pipeline on the live DB** (§3) — the real end-to-end proof. *(needs DB-reachable env)*
2. **Partners' Meeting render last-mile** — insert the queued render row + a "▶ Watch" Command Center
   card + the Sunday cron, so the avatar recap actually ships. *(needs DB + render endpoint + D-ID creds)*
3. **Supabase Preview CI check** — fails on migration-naming drift (timestamp vs `m###`); run
   `supabase db pull` or disable the integration. Informational, not a code gate. See `MIGRATIONS.md`.
4. **2 minor `financial.ts` TODOs** — agent-cap edge cases (non-blocking).

## 6. Recommendation — the next step to lead the category

The architecture is **done, deployable, governed, and CI-proven**. The remaining work is **operational**,
not architectural. In order:

1. **Deploy to a Vercel preview + seed a demo brokerage**, then **run the `e2e` workflow** with the
   Supabase secret → exercises every stage against the real DB (closes §3, the headline gap).
2. **Wire the Partners' Meeting render last-mile** (§5.2) — turns the tested reel into a weekly avatar
   briefing that *proves the AI-team thesis* and can truthfully narrate the compliance disposition.
3. **Then** scale the scraping tier + continuous-learning loops on real traffic.

No competitor can claim — let alone CI-prove — "nothing reaches a consumer outside one consent-governed,
Fair-Housing-cleared, audited gate, narrated back to the broker by the AI team that did the work."
That is the moat. Ship it.

## 7. Trigger & reachability sweep (running log)

### Closed
- **AI ISA inbound-intent capstone was unwired** (FIXED). `processInboundEmail` (reply → classify
  intent → convert) had zero callers; `app/api/providers/inbound` fired `ISA_REPLY_RECEIVED` (recorded
  + read by ghost-reengagement) but the event-reactor never classified/converted. Now wired: lead
  email replies call `processInboundEmail` (signature-verified ingress forwards `CRON_SECRET`),
  negative→halt / ambiguous→nurture / positive→convert. Idempotent, best-effort.
- **10 orphan admin pages** wired into a "Brokerage Ops & Insights" submenu (§4 #..).
- **`onboarding/ai-call-setup`** (a complete broker AI-call-handling page with zero inbound links)
  wired into the admin nav as "AI Call Handling". Onboarding is otherwise already substantial
  (~8,600 lines) — buildout focused on the genuinely-thin areas (Academy learner, Support, Locations).

### Open — for the dedicated UI pass (investigate before wiring; possible drift)
- `dashboard/superadmin/platform` — ⚠ likely **duplicate** of the linked `/admin/platform`. Decide
  canonical, merge or remove the other (do NOT just add a 2nd nav entry).
- `dashboard/compliance/queue` — may overlap the compliance nav's existing `/approvals` ("Approvals
  Queue"). Confirm distinct purpose before linking.
- `dashboard/documents/contract-review`, `dashboard/ai-isa/settings` — feature pages with no inbound
  link; confirm intended entry point.
- Settings sub-pages on the `/dashboard/settings/*` path (`required-documents`, etc.) and ISA wizard
  sub-pages (`isa/calling/dial`, `isa/campaigns/new`, `onboarding/ai-call-setup`) — likely reached via
  section sidebars / wizards (computed hrefs); verify each in the UI pass.

### Open — product decisions (not code gaps)
- `scrapeCraigslist`, `scrapeBatchDataMotivated` — built scraper integrations with 0 callers; not in
  the active `lead-scraping` cron path. Wire as sources, or prune as deprecated.
- **SMS inbound is opt-out-only** by design (no general SMS reply→intent handler). If SMS-reply
  auto-conversion is desired, add an SMS-channel sibling to `processInboundEmail`.

### Pass 2 — orphan pages (investigate-then-consolidate)
WIRED (genuine top-level surfaces, kept + linked):
- `dashboard/superadmin/platform` (rich platform-overview; distinct from the `/admin/platform` hub) →
  added to the hub's Platform Controls + superadmin sidebar as "Platform Overview".
- `dashboard/ai-isa/settings` (462-line Master Control) → AI-ISA Console nav "ISA Settings".
- `dashboard/compliance/queue` (distinct from `/approvals`) → compliance nav "Compliance Queue".

REMOVAL CANDIDATES — confirmed DUPLICATE/SUPERSEDED by investigation (0 path-refs + a canonical
replacement exists). Do NOT wire (would re-introduce drift); confirm no unique richer functionality,
then delete:
- `dashboard/isa/campaigns/new` — the campaigns client already has an inline "New Campaign" modal
  (`setShowCreate`); this standalone page is the orphaned duplicate creation surface.
- `dashboard/isa/calling/dial` — the calling page's CTA links to `/dashboard/voice/isa`; this dial
  page is the superseded variant.

NEEDS A HOME/DUP DECISION (thin or ambiguous; investigate in the focused UI pass before wiring/removing):
- `dashboard/documents/contract-review` (44 lines), `dashboard/onboarding/ai-call-setup`,
  `dashboard/financials/agent/fees`, `dashboard/settings/required-documents` (note: SettingsSidebar
  uses the `/settings/*` path space, not `/dashboard/settings/*`).

Confirmed reachable (not orphans): `dashboard/calculators`, `dashboard/support`.
