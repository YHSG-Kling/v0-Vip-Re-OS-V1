# AI capability audit — wave 56

Reference: https://homebuyinginstitute.com/mortgage/future-of-ai-in-real-estate/
(2026-01-02, owner-supplied). Six capabilities named there: AVM valuation,
24/7 AI assistant that qualifies leads and schedules viewings,
natural-language property search, computer-vision photo tagging,
personalization from viewed/saved/dismissed, agentic transactions.

Method: for each capability, locate the code, then prove — not assume — that
an autonomous trigger (cron / kernel event / write-time signal), not only a
UI button, drives it. Every claim below cites a real call site (file:line or
a grep match quoted verbatim), and every cron citation is checked against
BOTH `CRON_REGISTRY` (`lib/kernel/cron-dispatch.ts`) and `CRON_MANAGER`
(`lib/kernel/manager-registry.ts:2111`) so "registered" and "owned" aren't
assumed from one side alone.

## Finding, up front

**All six capabilities are already MOUNTED and AUTONOMOUS.** This audit did
not find an unbuilt autonomous half to build. Per CLAUDE.md §2 ("a count that
moves is the finding... fewer = it was accusing live code"), a zero-gap
result is reported with its full evidence trail below rather than as a bare
"looks fine" — every capability's trigger is quoted from the actual registry
entries and the actual call sites, not inferred from a file's presence.

---

## 1. AVM valuation

**Located**: `lib/avm/provider-chain.ts` (399 lines) — `getRentcastAVM`,
`computeEquityRatio`, `parseLengthOfResidence`.

**Consumers, verified by direct grep (not just "file exists"):**
- `lib/kernel/anniversary-equity.ts:458-460` calls `getRentcastAVM({ brokerageId, address })`
  directly and reads `avm.value` / `avm.rangeLow` / `avm.rangeHigh`.
- `lib/predictive-listing/signal-generators.ts:22` imports
  `computeEquityRatio, parseLengthOfResidence` from the same module.

**Autonomous trigger — confirmed in BOTH registries:**
| Cron path | Schedule (`CRON_REGISTRY`) | Owner (`CRON_MANAGER`) |
|---|---|---|
| `/api/cron/anniversary-equity` | `12 13 * * *` (daily) | `sphere_of_influence` (`manager-registry.ts:2217`) |
| `/api/cron/predictive-listing-scoring` | `0 6 * * *` (daily) | `listing_concierge` (`manager-registry.ts:2179`) |
| `/api/cron/predictive-listing-execute` | `0 * * * *` (hourly) | `listing_concierge` (`manager-registry.ts:2180`) |
| `/api/cron/wealth-opportunity-scan` | `0 7 * * *` (daily) | `sphere_of_influence` (`manager-registry.ts:2228`) |

**MOUNTED AND AUTONOMOUS.** No gap.

## 2. 24/7 AI assistant — qualifying + scheduling

**Located**: `lib/voice/reception-brain.ts` (`parseTurnPlan`, turn actions
`book` / `rsvp` / `seller_lead` / `callback` / `transfer` / `hangup`,
`reception-brain.ts:76,104,134-135`), `lib/ai-isa/appointment-scheduler.ts`,
`lib/ai-isa/callback-task.ts` (wave 55).

**Autonomous trigger:**
- **Always-on by construction**: the two live call transports —
  `app/api/voice/twilio/turn/route.ts` (`<Gather>` IVR) and
  `app/api/voice/relay/plan/route.ts` (ConversationRelay) — are inbound
  Twilio webhooks. Per CLAUDE.md §1 ("Cron routes, webhook handlers... are
  unreferenced by design"), these are correctly unreferenced from in-app
  code; reachability is the Twilio phone-number binding
  (`lib/voice/inbound-number-binding.ts`), not an internal caller. This is
  the "24/7" half literally — no human, cron, or button starts an inbound
  call.
- **Scheduling**: `parseTurnPlan`'s `"book"` action carries a `dateTime`
  (`reception-brain.ts:134-135`); `app/actions/ai-isa/schedule-appointment.ts`
  and `lib/ai-isa/book-seller-appointment.ts` wire it to a real appointment
  write.
- **Qualifying → callback loop** (wave 55, re-verified this wave — see §B
  below): `detectCallbackRequest` / the turn model's `callback` action write
  a `tasks` row (`lib/ai-isa/callback-task.ts`), and
  `/api/cron/ai-callback-dispatch` (schedule `*/5 * * * *`, owner `ai_isa` —
  `manager-registry.ts:2144`) autonomously dials it through the EXISTING
  gated door (`placeOutboundAiCall`) when due — proven live in
  `scripts/ai-callback-loop-simulator.ts` (59/59 passing after this wave's
  extension, see Task B section of the delivery report).

**MOUNTED AND AUTONOMOUS.** No gap.

## 3. Natural-language property search

**Located**: `lib/buyer-search/intent-parser.ts` (on-demand NL parse),
`lib/buyer-search/search-engine.ts`, `app/actions` portal search surfaces
(interactive half — a buyer typing a query is inherently request-driven,
same as the article's own "ask the assistant" framing).

**Autonomous half — the proactive re-run, not just the on-demand parse:**
`lib/buyer-search/market-watch.ts` (header, verbatim): "SCHEDULED per-buyer
market watch (the automated matcher). For each active buyer it runs their
saved criteria against OUR listings... and external MLS... System-context
(no user session) — driven by the buyer-market-watch cron." It reads
criteria via `loadBuyerCriteria` (`lib/buyer-search/buyer-criteria.ts:38`,
canonical `property_preferences` reader, see §5) and scores via the pure
`scoreCriteriaFit`.

**Autonomous trigger — confirmed in both registries:**
`/api/cron/buyer-market-watch`, schedule `0 8 * * *` (daily),
owner `shopping_agent` (`manager-registry.ts:2146`).

**MOUNTED AND AUTONOMOUS.** No gap. (The on-demand portal search itself is
correctly interactive — the article's own capability is "the assistant
understands a typed/spoken query," which is inherently request-shaped; the
autonomous requirement is satisfied by the proactive re-match, which exists.)

## 4. Computer-vision photo tagging

**Located**: `lib/listings/photo-intelligence.ts` (633 lines) —
`analyzeListingPhoto` (one vision call: room type, 0-100 quality,
hero-worthiness, lighting, fixable issues, written to `listing_media`),
`enhanceListingPhoto`, `virtualStagePhoto`, `twilightConvertPhoto`.

**Autonomous trigger**: `app/api/cron/photo-intelligence/route.ts`
(verbatim comment): "Photo Intelligence Cron (daily, asset_manager) — real
vision analysis for every photo on an active listing... plus autonomous hero
fill: listings with no `is_hero` photo get the best exterior-front shot
promoted... Bounded per run; the backlog drains across nights." Calls
`runPhotoIntelligenceSweep(svc)` — a SWEEP, not a per-upload single-photo
job, i.e. it finds and processes whatever needs analysis, not only what a
human queued.

**Registries**: `/api/cron/photo-intelligence`, schedule `15 5 * * *`
(daily), owner `asset_manager` (`manager-registry.ts:2285`).

**MOUNTED AND AUTONOMOUS.** No gap.

## 5. Personalization from viewed / saved / dismissed

**Located**: `lib/behavior-learning/preference-updater.ts`
(`updatePreferencesFromSignal`), `lib/behavior-learning/signal-mapping.ts`,
`lib/behavior-learning/prediction-engine.ts`.

**The write-time trigger (event-driven, zero-latency — not a cron, and
correctly so)**: `lib/kernel/forms.ts:914`'s `recordBuyerPropertyAction`
feeds the buyer's own portal save/favorite/dismiss action through
`interestLevelToLearningSignal` into `updatePreferencesFromSignal` the
MOMENT the buyer acts — this is the autonomous trigger; no agent or cron
step is needed because the behavior signal IS the trigger.
`SIGNAL_WEIGHTS` (`preference-updater.ts:35-43`) weighs `saved: 5`,
`love_it: 10`, `dismissed: -3`, `viewed: 0.5`, `not_for_us: -5` — all three
of the article's named signals (viewed, saved, dismissed) are covered, with
`viewed` deliberately weighted low (0.5) rather than ignored — a documented,
reasoned choice (`signal-mapping.ts`: "raw views are 'too weak to act on
here'" — still counted, just lightly).

**The loop actually closes** (verified column-for-column, not assumed):
`preference-updater.ts:198-207` UPSERTs `preferred_price_min/max,
inferred_min_price/max, inferred_beds_min, inferred_baths_min,
inferred_cities, inferred_zip_codes, inferred_property_types,
inferred_must_have_features` into `property_preferences` — and
`lib/buyer-search/buyer-criteria.ts:35`'s `BUYER_CRITERIA_SELECT` reads
`preferred_price_min, preferred_price_max, inferred_min_price,
inferred_max_price, inferred_beds_min, inferred_baths_min, inferred_cities,
inferred_zip_codes, inferred_property_types, inferred_must_have_features,
inferred_deal_breakers, confidence_score` — the EXACT same column set. A
prior wave's comment on the writer (`preference-updater.ts:196-198`) records
that this column-list agreement was itself a fix: "the live table has NO
preferred_bedrooms/bathrooms/cities/features columns, so writing them
errored the ENTIRE upsert and the learned preference was silently lost" —
i.e. this specific write/read drift (CLAUDE.md §2's recurring defect shape)
was already found and closed before this wave, and remains closed today.

**The proactive half re-runs autonomously**: `buyer-market-watch`
(§3 above) reads `property_preferences` via the same `loadBuyerCriteria` on
its daily cron — so a buyer's saved/dismissed history from yesterday
measurably changes what the cron surfaces today, the actual "personalization
that acts on behavior" the article describes, not just a display-time badge.

**Also present, layered on the same signal**:
`lib/agents/offer-ready-detector.ts:35` reads
`.eq("dismissed", false)` on saved-property rows as one input to detecting
offer-readiness, itself invoked from the same `buyer-market-watch` cron
(`grep` confirms `offer-ready-detector` is imported there).

**MOUNTED AND AUTONOMOUS.** No gap. (A prior lane already deleted a redundant
HTTP door here — `POST /api/behavior/signal` — with a tombstone at
`preference-updater.ts:13-32` naming the in-process writers as the survivor;
re-confirmed this wave that the survivor path is the one actually wired, not
just the one the tombstone claims.)

## 6. Agentic transactions

**Located**: `lib/agents/deal-coordinator.ts` — "one Anthropic Managed Agent
per brokerage that runs a per-transaction session from OFFER_ACCEPTED through
CLOSED," reads deal-health/transaction state, drafts buyer+seller updates,
flags human escalations, all documented as composing with the existing
kernel rather than re-implementing it.

**Autonomous trigger**: `lib/kernel/event-reactor.ts:196-202` — on
`KernelEvent.OFFER_ACCEPTED` or `KernelEvent.TRANSACTION_STAGE_CHANGED` for
`entityType === "transaction"`, calls `spawnDealCoordinatorForTransaction`
directly, no human step. The same reactor block (`event-reactor.ts:178-192`,
comment) also spawns two sibling agents the SAME way — Buyer Concierge on
`CONTACT_CREATED` / `BUYER_STATE_CHANGED` / `BUYER_FINANCIALLY_VERIFIED` /
`BUYER_SEARCH_CONFIGURED`, and Listing Concierge on `CONTACT_CREATED` /
`LISTING_STAGE_CHANGED` — with the same idempotency guarantee ("the shared
spawn-helper handles idempotency at both the agent + session layers").

**MOUNTED AND AUTONOMOUS.** No gap.

---

## Cross-cutting note: managers cross-cooperate, correctly

Per LANE_RULES ("a capability owned by one manager may be invoked by another's
loop"), §5's finding that `offer-ready-detector` (an `agents/` module with no
single obvious owner) runs INSIDE the `shopping_agent`-owned
`buyer-market-watch` cron is the expected shape, not a routing defect — the
detector doesn't need its own cron registration because it rides an existing
one that already walks the right rows.

## Unresolved

- This audit checked reachability and autonomy, not OUTPUT quality (e.g.
  whether `analyzeListingPhoto`'s vision-model prompt correctly avoids
  people per the Fair Housing rule stated in its own header) — that is a
  content-correctness question, not a mounting question, and out of this
  audit's scope.
