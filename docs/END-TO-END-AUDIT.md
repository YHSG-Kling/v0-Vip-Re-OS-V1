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
- **Offer-execution features, NOT a delete cluster** (8 × `buyer-offer/*`) — investigation corrected an
  earlier wrong hypothesis: these are substantial unwired **capabilities**, several **compliance-critical**:
  `acknowledge-commission` (buyer commission disclosure — post-NAR-settlement legal requirement),
  `handle-multi-offer` (duplicate / over-limit guardrails), `sync-documents` (e-sign doc sync),
  `rollback-offer`, `handle-offer-response`, `create-dotloop-loop`, `resolve-property-prefill`,
  `create-offer` (likely superseded by `buyer-offers.createOffer` — the one confirm-then-delete candidate).
  These touch the critical offer/compliance path → resolve in a **dedicated focused pass** (wire the
  compliance/multi-offer features; confirm-then-delete only `create-offer`). Do NOT bulk-delete.
- **Burn-down in progress (wiring dormant features live, not deleting):** `revenue-pipeline` →
  `/dashboard/financials/pipeline`; `instant-property-alerts` → SMS-first alerts + CRM "Text First Look";
  `property-buyer-matching` → "Matching Buyers" listing panel; `marketing-intelligence` → Market
  Intelligence page; `lead-readiness/evaluate-readiness` → Lead Readiness panel; `acknowledge-commission`
  → NAR-2024 commission-disclosure dialog (unblocked submit-for-signature); `buyer-portal-matches` →
  portal TopMatches; `ai-document-intelligence` → contract-review "Analyze with AI"; `fb-audience-templates`
  → Ads audience gallery; `handle-multi-offer` → buyer offers multi-offer status banner. Each has a pure
  test + a baseline shrink. **Method:** sensitive offer/egress/compliance orphans done solo; safer display
  orphans fanned out to parallel sub-agents (with strict no-commit / no-shared-file rules, integrated by
  the parent). Baseline 55 → **~42** and shrinking.
- **Unwired features → wire if valuable** (`instant-property-alerts`, `ai-isa/{classify-outcome,schedule-
  appointment}`, `lead-assignment/*`, `lead-promotion/*`, `lead-readiness/*`, `contact-promotion/*`,
  `voice-engine/process-voice-call`, `scrape-social-media`, `marketing-intelligence`, `property-buyer-
  matching`, `revenue-pipeline`, `newsletter/*`, `settings/*-integration-credentials`, `video/generate-
  script`, `neighbor-notifications`, `creditWorkflows`, …). Each needs a home (UI/cron/kernel) or deletion.

### ✅ ORPHAN BURN-DOWN COMPLETE — baseline 55 → **0** (zero orphaned server actions)
`test:no-orphan-actions` now reports `NO_ORPHAN_ACTIONS_PASS` (full pass, not just a ratchet) — every
file under `app/actions` is imported by something. The final 7 were resolved by grounded investigation:
- **Wired (valuable, unwired):** `scrape-social-media` → Lead-Intake Cockpit `SocialScrapeTrigger`
  (feeds `raw_scraped_leads` → the raw-leads review/promote panel); `agentic-tokens` (mint/list/revoke
  AGIS Bearer tokens consumed by `/api/agentic-os/*` via `resolveAgenticCaller`) → new superadmin
  **API Tokens** page (`/dashboard/superadmin/api-tokens`, scope-checkboxes + show-once raw token).
- **Deleted (superseded/dead):** `listing/submit-listing-for-signature` (superseded by the governed
  forms-kernel path — `TransactionFormEsignFlow` → `forms-kernel.ts`, wired in `ListingFormsPanel`);
  `onboarding/assistant` (superseded by the streaming `/api/onboarding/assistant` route + `knowledge/
  search.ts`); `ai.ts` (dead 19-line wrapper over `runPipelineSimple`, no callers); `settings/list|
  update-integration-credentials` (superseded by per-provider governed surfaces — CRM `getCrmStatus/
  connectCrm/disconnectCrm` at `/settings/crm`, Accounting at `/settings/accounting`).
- **Exempted (go-live decision):** `demo-login`, `demo-contacts` — demo scaffolding, in the guard's
  `EXEMPT` set with a "REMOVE AT GO-LIVE" note. Everything else is now wired or gone.
The drift ratchet stays armed: any NEW orphan fails CI at baseline 0.

### ✅ DRIFT-CONSOLIDATION PASS (2026-06-23) — four flagged items, grounded in the LIVE schema
A fresh four-pillar audit (governance / lead-gen / video+voice / lifecycle+compliance) flagged four
"drift" items. Verifying each against the **live** DB (not the audit's prose) is exactly what kept us
from manufacturing risky changes — two were stale flags, one was a non-issue, one was real:
- **#1 `app/actions/lead-intelligence.ts` "schema drift"** → **stale documentation, not code drift.**
  All 20 tables it writes exist live with the columns the code uses (`behavioral_signals.visitor_id`,
  `site_activity.behavioral_signal_id`, `social_intelligence.ai_intent_score`, `google_search_intelligence`,
  …); the schema was migrated forward. The 80-line "SCHEMA-DRIFT WARNING" header was itself the drift —
  it even misled the audit agent. Replaced with an accurate, dated, verified-against-live note. No code
  change (the code is correct).
- **#2 State Fair-Housing not consulted on live outbound** → **REAL gap, fixed.** State protected
  classes (`state_protected_classes`: 49 active rules across CA/CO/IL/MA/MD/NJ/NY/WA — e.g. source-of-
  income "no Section 8") were only checked in the marketing-content action, NOT on the two biggest live
  surfaces: the client-message dissent path (`manager-dissent.ts:runManagerDissent`) and the social/ads
  gate (`real-estate-compliance-gate.ts:runComplianceGate`), which ran national `FAIR_HOUSING_PATTERNS`
  only. Wired `evaluateStateProtectedClasses` into both (advisory weight; national-clear+state-flagged ⇒
  dissent), behind one shared pure formatter (`state-fair-housing-format.ts`). Proven against live CA data
  + `test:state-fair-housing` (pure + creds-gated self-cleaning live layer) in the guard tier.
- **#3 `buyer_stage='BUYER_LIFETIME'` never auto-set on close** → **not a functional gap.** `portal.ts`
  resolves lifetime via THREE harmonized reads (`buyer_stage` OR closed-transaction-no-active fallback OR
  `contact_type`), and the close path already sets `contact_type='lifetime_customer'`. Cosmetic-only;
  not worth a risky change to the frozen lifecycle state machine. Recorded as verified.
- **#4 Five sphere runners can each propose in one week** → **not customer-facing.** All five propose to
  the approval queue (never auto-send), and the de-conflict gate runs on all five dispatch paths
  (`dispatch.ts` 161/328/446/562/705), capping actual sends. At worst queue clutter, not spam. Recorded.

### ✅ FRONTIER ROADMAP #1–#3 (2026-06-23)
- **#1 Governed Autonomy Loop — SHIPPED.** dispatch.ts now enforces each manager's trust
  posture (lib/managers/autonomy-gate.ts): autonomous send by an `approval_required` manager is
  HELD; broker override wins; eval-derived posture persisted to managed_agents.config for
  closed-loop enforcement; human-approved sends bypass; absence of signal ⇒ allow (zero day-one
  regression). Gate inferred from systemSource so it's live across autonomous senders without
  rewiring. Proof: test:autonomy-gate (12), egress-send-guard still 21, build exit 0.
- **#2 AI Intent at Ingest — SHIPPED.** pipeline-processor now reads record content with the LLM
  (lib/lead-pipeline/ai-intent-classifier.ts) and FUSES intent into the existing lead fields
  (lead_score lifted → cascades to urgency_level; lead_type filled on ambiguous social/search
  sources) — NO new columns (verified vs live `leads`: only lead_score/lead_type/urgency_level/
  motivation_confidence exist there; intent_score/etc. live on `contacts`). Injectable analyzer
  seam = deterministic tests, zero model spend; best-effort (source score is the floor). Proof:
  test:ai-intent-ingest (24).
- **#3 Video Team Coordination — ALREADY COMPLETE (stale audit flag).** lib/kernel/video-
  coordination.ts already emits campaign_orchestrator:video_ready (always) + ads_manager:
  video_ready (promotable kinds) + campaign_orchestrator:video_compliance_failed (failure),
  called from poll-did-videos on completion AND failure. Verified green: test:video-coordination
  (12), test:video-director (23), test:video-qr (18).

- **Returning-Customer Re-Engagement with Memory — SHIPPED** (the "lifetime" loop closer). When a
  past client becomes active again (a CONTACT reactivation signal — fired by the inbound-intent
  classifier when a lifetime contact shows positive intent, or any other source), the right
  manager re-engages them WITH their prior-deal memory: Shopping Agent for a returning buyer,
  Listing Concierge for a returning seller, recalling role/price-band/area/months-since-close from
  their closed `transactions`. Gated (proposeClientMessage → approval queue, autonomy-gated by #1),
  withdrawn excluded, idempotent per (contact)/60d. lib/kernel/returning-customer.ts +
  app/api/cron/returning-customer-reengagement (registered in CRON_REGISTRY, daily) + a detect
  hook in inbound-intent-classifier. Proof: test:returning-customer (20 pure + creds-gated
  self-cleaning live layer); tsc 0; harness 8/8; build exit 0. No competitor re-engages a past
  client in hours, with their prior-deal context, fully governed.

- **Deal-Save Huddle — SHIPPED** (the DEAL phase, the "no boring single workflow" play). The deal
  phase was mature on MONITORING (deal-health-scorer, closing-war-room, watchtower, financing-pit-
  stop) but a risk-tier change emitted ONE generic event (staff notifications) — a lonely workflow,
  not a team response. Now when a deal WORSENS into at_risk/critical, the Deal Coordinator convenes
  a coordinated huddle (lib/kernel/deal-save-huddle.ts) routed by the FAILING health component:
  LENDER/EARNEST_MONEY → Finance Manager (opens a financing drive-to-done task), DEADLINES/
  COMPLIANCE/INSPECTION → Compliance Officer (flags the contingency-clock exposure to the broker),
  TITLE/DOCUMENTS/MILESTONES → the coordinator's own task. Delegated over the manager-signals bus
  (visible in the "managers talking" feed; new signal deal_save_huddle catalogued + handled +
  classified as escalation). Triggered from the scorer on a worsening tier change, best-effort.
  ROUTING (per owner correction): recipients are always the Transaction Coordinator + the deal's
  AGENT (NOT the broker — operational, their job); earnest money is the TC's job AND proposes an
  URGENT gated buyer warning; the loan is Finance's analysis, deadlines/contingencies are
  Compliance's — but both keep the TC + agent aware (notifyDealTeam resolves TC via coordinator_id
  and agent via agent_id→agents.user_id). Internal drive-to-done + one gated client warning only.
  Proof: test:deal-save-huddle (17 pure + creds-gated self-cleaning live layer that seeds a
  TC+agent+buyer and asserts TC/agent notified, broker not, buyer warning proposed); signal-
  integrity 5/5; harness 8/8; build exit 0. THIS is the human-deal-team-in-software differentiator:
  a deal wobbles → the AI team huddles, each on its part, the right humans aware.

- **DATA GUARD — SHIPPED** (the 5th security layer, the model-boundary twin of the Egress Guard).
  The owner's security model names five guards; the Data Guard (classify + restrict sensitive data)
  was the only one not formalized. Built lib/data-guard: redactSensitive/classifySensitive strip
  high-confidence secrets (SSN/ITIN, EIN, card PAN, bank account/routing) from any system/prompt
  BEFORE it reaches an LLM — conservatively (names, addresses, prices, phones untouched → zero
  functional loss). Wired at every model chokepoint: lib/ai/models.ts (executeModelCall +
  generateTextRouted + generateObjectRouted) and lib/ai/generate.ts (generateObject +
  generateAIObject), plus a guardedGenerateText wrapper for direct callers. A CI ratchet
  (test:data-guard-guard, in harness:integrity) proves each chokepoint redacts AND freezes the
  surface: no NEW file may import the raw "ai" SDK call outside the chokepoints (35 legacy raw-SDK
  importers baselined → burned down to 32 by migrating the 3 highest-PII paths: license-verifier,
  inbound-intent-classifier, them-first/validator). Proof: test:data-guard (20 pure redaction) +
  test:data-guard-guard (6); harness:integrity now 10 structural guards; tsc 0; build exit 0.
  The five guards are now all real in code: Kernel (orchestrator + connector-gateway + AGIS tokens),
  Data (lib/data-guard + RLS), Manager (autonomy-gate + manager-registry), Compliance (national+state
  FH + TCPA + ledger), Egress (dispatch.ts + egress-send-guard).

- **MANAGER LEARNING LOOP — SHIPPED** (the loop that turns a GRADED team into a SELF-IMPROVING one).
  Outcomes were measured (strategy_outcomes, marketing weekly, rubric, lost-deal categories) but
  never fed back into future behavior. lib/managers/learning-loop.ts reads a brokerage's recent
  outcomes (lost-deal categories + strategy outcomes), derives LEARNED ADJUSTMENTS, and writes them
  to brokerage_settings.settings.learned_adjustments (the shared store — NOT new schema, NOT
  managed_agents pollution). Honest: below MIN sample it derives nothing. First WIRED consumer is
  multi-manager: financing_risk_sensitivity=high (set when a brokerage keeps losing deals on
  financing) tightens the Deal-Save Huddle's lender/earnest-money threshold (85 vs 70), so the NEXT
  deal convenes the huddle — and notifies the lender — EARLIER. Past losses → future behavior, the
  loop CLOSES. Cron manager-learning (weekly, CRON_REGISTRY). Proof: test:manager-learning (11 pure
  derivation + consumption, + creds-gated self-cleaning live layer: seed lost-on-financing deals →
  learn → assert written → run the huddle on a BORDERLINE financing deal and assert it now convenes).
  harness:integrity stays 10/10; cron-dispatch 17; build exit 0.

### ✅ DEEP-GAP BATCH (2026-06-23) — second-order gaps from a 4-domain deep hunt
A fresh exhaustive 4-domain gap hunt (lead-gen / deal / marketing-video-voice / lifetime-governance)
surfaced ~30 second-order gaps; verifying each against live code (prior audits over-flag), the
verified, highest-value, multi-manager batch was shipped:
- **offer_posture loop CLOSED** — the Manager Learning Loop wrote offer_posture but nothing read it
  (verified dangling loop). The Shopping Agent kickoff (lib/agents/shopping-agent.ts) now consumes
  it via the veto-aware getLearnedAdjustment chokepoint: a brokerage whose offers keep getting
  rejected aggressively gets a "recommend CLOSER TO ASK" posture line in every buyer session.
- **Human off-switch over the learning loop** — the managers learned + acted, but the broker
  couldn't SEE or VETO what they learned (governance blind spot). Added listLearnedAdjustments +
  setLearnedAdjustmentVeto (lib/managers/learning-loop.ts), wired admin actions
  (getLearnedAdjustmentsForBrokerage / vetoLearnedAdjustment), and a "What your managers learned"
  card on /dashboard/admin/manager-trust with a per-adjustment Veto/Restore. The veto is enforced at
  the SINGLE getLearnedAdjustment read chokepoint, so vetoing one learned behavior instantly
  disables it across EVERY consumer (proven: veto financing sensitivity → the huddle stops convening
  on a borderline deal).
- **rate_lock_watch: feed_only → handled (multi-manager)** — an expiring rate lock was published to
  campaign_orchestrator as a feed-only item nobody acted on. Re-routed deal_coordinator →
  finance_manager, flipped to handled, added the finance handler that opens a gated drive-to-done
  task to confirm an extension/relock before the rate (or deal) is lost.
Proof: test:manager-learning (now 14 — adds veto off-switch + visibility) ; signal-integrity 5/5
(56 catalogued, rate_lock_watch now handled) ; harness:integrity 10/10 ; tsc 0 ; build exit 0.
QUEUED (verified, next batch): referral_reciprocity feed_only→handled, voiceCutPromo→video_ready
coordination, closing-orchestration pending_actions→bus, format-learning→Marketing Agent snapshot.

### ✅ DEEP-GAP BATCH #2 (2026-06-23) — deal-coordination + cross-manager, with heavy verification
A second deep hunt added tier/org + onboarding/platform domains. Verifying each against live (the
biggest-sounding claims were over-flagged), the shipped, verified, multi-manager subset:
- **Closing pending-actions → the bus** — closing-orchestration wrote transaction_pending_actions
  with a suggested_recipient but never published to the bus; urgent lender/title/escrow/inspection
  items were TC-dashboard-only. Now a HIGH/URGENT action routes by recipient to the right manager:
  lender → finance_manager (opens a gated closing task), title/escrow/inspection → compliance_officer
  (flags the TC + agent). New signal transaction_action_pending (handled, escalation), 2 handlers,
  TC keeps buyer/seller/agent items in the closing-concierge UI.
- **Format-learning → the Marketing Agent** — the Video Director learned which composition × channel
  × mood converts (real QR + engagement) but the Marketing Agent was blind to it. Added pure
  summarizeTopFormats (lib/video/format-learning.ts) + a "LEARNED FORMAT WINNERS" block in the
  Marketing Agent's weekly kickoff, so it biases renders toward proven winners. Director → Marketing
  loop closed.
VERIFIED-NOT-GAPS (dropped after grounding — the audit value of NOT building): voiceCutPromo already
feeds the remotion_pending → render → D-ID → poll-did-videos pipeline that publishes the coordination
signals on completion (no double-publish needed); referral_reciprocity feed_only is defensible (the
partner has no contact record + the agent is already notified — reciprocation is human judgment);
and "onboarding doesn't provision the 11 managed_agents" is BY DESIGN — spawn-helper.ts:182 creates
managed_agents rows LAZILY per session (0 rows = pre-release, not a bug; bulk-provisioning would just
create idle sessions). Proof: test:deal-coordination-extras (11 pure + creds-gated live Finance
handler) ; signal-integrity 5/5 (57 catalogued) ; harness:integrity 10/10 ; tsc 0 ; build exit 0.
QUEUED (real, larger surface — next focused passes): team_members CRUD + Finance team-split guard;
location-scoped reporting (egress-scope into reporting.ts); connector-healing apply step; onboarding
setup-assistant escalation surface; license-verification manual-review queue.

### ✅ TEAM MANAGEMENT — member write-path closed (2026-06-23)
The org schema was fully present (teams/team_members/locations + agents.team_id/location_id) and
location CRUD already existed (app/actions/admin/locations.ts, test:locations). The REAL gap: teams
could be created (multi-persona.createTeam) and BOTH the team dashboard (getTeamDashboard) and the
Finance commission waterfall (lib/commission/waterfall/08-team-split.ts:applyTeamSplit — verified
WIRED into lib/commission/index.ts + engine.ts, and it already handles the empty case + a
negative-balance guard) READ team_members, but NOTHING wrote it — so every team's commission split
was a silent no-op. Closed it: lib/teams/membership.ts (pure split-validation + the >100%
agent-funded cap), app/actions/admin/team-members.ts (addTeamMember / removeTeamMember /
listTeamMembers — broker/admin/team-lead gated, brokerage+team scoped, cross-tenant safe), and a
/dashboard/team/members management UI (team picker → assign agent + role + split + source) linked
from the team dashboard. Multi-manager loop: the team lead / Recruiting Manager builds the roster →
the Finance Manager splits deals by it. Proof: test:team-membership (8 pure rules + a creds-gated
self-cleaning live layer that seeds members and asserts applyTeamSplit consumes them — agent-funded
deducted, brokerage-funded tracked-not-deducted). tsc 0; harness:integrity 10/10; build exit 0.
NOTE (flagged, NOT changed — out of scope): applyTeamSplit queries team_members by the CLOSING
agent's own membership row; whether the split should distribute to the team LEAD vs back to the
closing agent is a commission-math question for a separate, careful Finance pass.

PATTERN (recurring): the four-pillar audits repeatedly over-flagged "gaps/drift" that grounding
in the LIVE code/schema disproved (#3 here; lead-intelligence + buyer_stage + sphere dedupe in the
consolidation pass). Always verify the audit's prose against the live DB + actual modules before
building — that verification IS the deliverable as much as the code.

### Earlier orphan disposition map (historical) — investigated; each needed a decision, NOT a bulk delete
The easy + medium tiers are done (29 resolved: 19 wired live, 10 deleted dead/redundant). The remainder
is the architectural tier — investigated and characterized so the call is informed:
- **Governed, built, but UNWIRED orchestrators** (`respond-to-contact`, `classify-outcome`,
  `orchestrate-post-assignment`, `ai-transaction-coordinator`, `outbound-dispatch`, `voice-engine/
  process-voice-call`, `promote-lead` is now WIRED). Each overlaps a canonical kernel/cron path
  (`respond-to-contact`↔`ingestMessage`; `classify-outcome`↔`lib/kernel/ai-isa`; `outbound-dispatch`
  routes through `dispatch.ts`) but is NOT an exact duplicate — superseded-leaning. Resolution = either
  wire to its trigger (cron/webhook/command-bar) or confirm the canonical fully covers it, then delete.
  Do NOT bulk-delete (would remove governed, working capability).
- **`buyer-offer/*` compliance cluster** (create-offer, handle-offer-response, sync-documents,
  rollback-offer, create-dotloop-loop, resolve-property-prefill) — dedicated offer-flow pass.
- **Egress senders — ALL GOVERNED** (audited): `lender-status-request` (B2B allowlist),
  `neighbor-notifications` (direct_mail_campaigns pipeline), `publish-guide-to-gbp` (social approval
  queue, never auto-publishes), `outbound-dispatch` (gate). No ungoverned holes. `scrape-social-media`
  + `voice-engine` are inbound, not egress.
- **Credential code** (`settings/list|update-integration-credentials`) — security/supersession review.
- **Demo files** (`demo-login`, `demo-contacts`) — product decision: keep for sales-demo mode vs delete.
- **`ai.ts`** — catch-all; needs export-by-export investigation.

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
