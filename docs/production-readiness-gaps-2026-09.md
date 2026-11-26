# Production-readiness gap audit — 2026-09-18 (lane 73C)

Owner's charge, verbatim: "we have covered a large range of this real estate
agentic saas os including autonomous ai but there are areas we have not
covered that we need to be sure are complete and ready for production so find
them and build/merge, etc." This audit walks the four surfaces the wave-73
ruling named (guard-chain proof coverage, cron registry, user-facing flow
proof coverage, env-var parity), finds every gap, and either fixes it in this
lane or records why it could not be fixed in scope (CLAUDE.md §2: a count
without its denominator and exclusions is not a measurement).

---

## Part 1a — every registered proof must run in the guard chain

**Method.** `lib/kernel/manager-registry.ts`'s `MAINTENANCE_DOMAINS` names a
`proof: "test:…"` for every domain a manager is accountable for. Two things
have to be true for that proof to mean anything: (i) it must be a real
`package.json` script, and (ii) it must run inside `npm run guard`, or a
regression in that domain is invisible to CI forever.

**Before.** 557 distinct `proof` values named in `MAINTENANCE_DOMAINS`
(2026-09-17 snapshot, base `4c9176fb`). All 557 were confirmed to be real
`package.json` `test:*` scripts (0 missing — check (i) is clean). Cross-
referencing against the `guard` chain string found **273 registered proofs
that were NOT in the chain** — wave 72 had found and fixed exactly one
(`test:scrapers`); this is the rest of that debt, accumulated across every
earlier wave that registered a `MAINTENANCE_DOMAINS` entry pointing at a
script the chain never grew to include.

**Positive control.** Before trusting "0 missing from package.json", the
comparison script (`comm`) was sanity-checked against a known-present name
(`test:agent-coaching`) via a direct `python3 -c "... 'test:agent-coaching' in
d['scripts']"` — `True`, and `in d['scripts']['guard']` — `False`, matching
the batch finding exactly.

**Fix.** All 273 were run individually in the foreground
(`timeout 60 npm run <name>`, logged to
`missing_proofs_results.log`): **273/273 exited 0** (all pass; none needed a
fix). All 273 were appended to the guard-chain tail, in `package.json`
`scripts.guard`, immediately after `&& npm run test:scrapers` (the wave-73
ruling's anchor point). Guard chain: **363 → 638** entries (a raw count of
`npm run` occurrences in the chain string, verified duplicate-free with a
Python `set()` check).

**Also found while building the flow census (1c below):** two proofs that
cover real production flows — `test:ads-manager` (ads-spend governance) and
`test:stale-recruit-reaper` (recruiting pipeline SLA escalation) — were
registered in `package.json` but had **no `MAINTENANCE_DOMAINS` owner at
all**, so they were invisible to both the guard chain and the ownership
guard. Both pass (12/12 and 15/15 assertions). Both got new
`MAINTENANCE_DOMAINS` entries (`ads_manager_governed_spend` →
`ads_manager`, `stale_recruit_reaper` → `recruiting_manager`) and were added
to the guard tail alongside the 273.

**Guard-tail addition (638 total, +275 net):** the 273 registry-gap proofs
plus `test:ads-manager` and `test:stale-recruit-reaper`, appended verbatim
after `test:scrapers` in `package.json`'s `guard` script. `npm run guard`
itself was **not** run (forbidden — CLAUDE.md §7, lane rules: OOMs in
parallel); every added script was instead run standalone and its exit code
recorded.

---

## Part 1b — cron registry: route file, CRON_SECRET gate, cost, proof

**Method.** `lib/kernel/cron-dispatch.ts`'s `CRON_REGISTRY` is the single
source of truth (one Vercel platform cron, `/api/cron/dispatch`, fans out
internal calls); `test:cron-dispatch` already proves registry↔routes↔
`vercel.json` drift in both directions, and `test:cron-cost` already proves
the registry's invocation volume against a committed baseline. Both are
already in the guard chain (confirmed against `guard_chain_scripts.txt`).

**Findings — this surface was already in good shape, not a gap:**

- **Route file exists:** `test:cron-dispatch` — "every registry path resolves
  to a real route file" — **214 CRON_REGISTRY entries, 203 distinct routes,
  0 drift.** ✅
- **CRON_SECRET gate:** direct grep — `find app/api/cron -name route.ts`
  → **204** route files; `grep -rl "verifyCronAuth\|CRON_SECRET"` over the
  same set → **204**. **204/204**, no gap. ✅
- **Cost justification:** `docs/vercel-cron-usage-2026-09.md` already exists
  (243 lines, last measured 2026-09-14) with totals, per-manager and
  per-frequency-bucket breakdowns, the 15 sub-5-minute entries named and
  justified individually, and a written-baseline invocation count.
  `npm run test:cron-cost` re-derives the SAME numbers live from the
  registry (not from the doc) and compares against a committed baseline:
  **214 entries, 9384.1 invocations/day, delta +0.0/day — at or under
  baseline.** ✅ No new cron has been added since the doc was last measured
  (delta is exactly zero), so the doc did not need re-writing this wave.
- **A proof names it:** every cron path in the registry is exercised by
  `test:cron-dispatch`'s dispatch-matching layer (Layer 1: schedule-due
  matching; Layer 3: dispatch fan-out, Bearer forwarding, per-path failure
  isolation) — there is one proof per registry, not per-route, which is the
  same domain-grained posture `MAINTENANCE_DOMAINS` already takes
  deliberately (see `manager-proof-ownership-guard.ts`'s own header: "most of
  those proofs are unit-level checks of a domain that IS owned — the
  ownership ledger is deliberately domain-grained, not script-grained").

**Verdict: no gap.** `test:cron-dispatch`, `test:cron-cost`, and
`test:cron-status-vocabulary` were already in the guard chain before this
lane touched anything. Nothing to fix here; recorded as a clean surface
rather than skipped.

---

## Part 1c — user-facing flow proof coverage

**Method.** For each named flow, `grep -i <keyword>` over
`guard_chain_scripts.txt` (the 363 pre-existing entries) and separately over
the full 859-script `package.json`, to distinguish "no proof exists" from
"a proof exists but isn't in the chain."

| Flow | Proof(s) found (guard chain, pre-lane) | Gap | Fix |
|---|---|---|---|
| Onboarding | `test:onboarding-ops`, `test:onboarding-steps` | none | — |
| Billing (Stripe webhooks + seats) | `test:billing-access`, `test:stripe-account-scope`, `test:stripe-writethrough`, `test:multi-role-seat`, `test:voice-billing-rail`, `test:governance-privacy-billing-wiring` | none | — |
| Buyer portal | `test:buyer-matching-rails`, `test:buyer-offer-request`, `test:buyer-portal-offer-intent`, `test:buyer-tours`, `test:voice-buyer-search` | none | — |
| Seller portal | `test:seller-decision(-authority)`, `test:seller-listing-wiring`, `test:seller-offer-presentation`, `test:seller-timeline`, `test:batchdata-seller-signals` | none | — |
| **Investor portal** | **0 hits in the guard chain** | `test:investor-offmarket` exists (package.json) and IS `MAINTENANCE_DOMAINS`-owned, but was one of the 273 missing from the chain | fixed by the Part 1a guard-tail append (now in chain, 638-entry set) |
| Vendor portal | `test:vendor-media-wiring`, `test:vendor-orchestration`, `test:vendor-subscription`, `test:vendor-service-area`, `test:vendor-platform-use`, `test:vendor-budget-tier-honesty`, `test:vendor-tenancy-lead-source-billing` | none | — |
| Tenant settings | `test:settings-authz`, `test:territory-settings`, `test:tenant-scope`, `test:tenant-principal-books`, `test:idx-tenant-credential` | none | — |
| Transactions / e-sign | `test:esign-anchors`, `test:esign-execution-loop`, `test:transaction-creation-gate`, `test:transaction-document-wiring` | none | — |
| Notifications / push | `test:parties-notify` | thin (1 hit) but present | not expanded this wave — see "unresolved" |
| Referral OS | `test:referral-consolidation`, `test:referral-os-reachability` | none | — |
| **Recruiting** | **0 hits in the guard chain** | `test:recruit-outreach`, `test:recruiter-agent-mgmt`, `test:recruiting-roi`, `test:vendor-recruitment` are `MAINTENANCE_DOMAINS`-owned but missing from the chain; `test:stale-recruit-reaper` was missing an owner AND missing from the chain | all fixed — 4 by the Part 1a append, `stale-recruit-reaper` by a new `MAINTENANCE_DOMAINS` entry + append |
| Reputation / reviews | `test:license-review`, `test:openhouse-reputation-wiring` | none | — |
| Direct mail | `test:direct-mail-copy`, `test:mail-address-suppression` | none | — |
| **Ads manager** | **0 hits in the guard chain** (matches under "ads manager" were lead-management scripts, not ads-spend proofs) | `test:ads-manager` (governed-spend controls: propose→approve→execute, hard cap, reward-alignment on real leads not vanity metrics) had NO owner and was missing from the chain | new `MAINTENANCE_DOMAINS` entry (`ads_manager_governed_spend` → `ads_manager`) + guard-tail append |
| Video queue | `test:video-queue-terminal`, `test:video-assembly`, `test:video-generation-lane`, `test:video-project-consolidation`, `test:video-repurpose-wiring` | none | — |

**Verdict.** Of the 15 named flows, 12 already had adequate, chain-run
coverage. 3 (investor portal, recruiting, ads manager) came back with **zero**
guard-chain hits on a direct keyword search — every one of them turned out to
have a real, passing, `MAINTENANCE_DOMAINS`-adjacent proof already written;
the actual defect was registration, not missing test coverage. All three are
now fixed by the Part-1a guard-tail append plus the two new
`MAINTENANCE_DOMAINS` entries. **No new proof scripts were authored** for
this wave's flow census, because every flow that looked uncovered by keyword
search turned out to already have one — writing a duplicate "smallest
source-pinned proof" per the task brief's fallback instructions would have
produced a second implementation of an existing, passing check, which §6
(one vocabulary per function) forbids.

**Unresolved, published rather than guessed:** notifications/push has only
one guard-chain hit (`test:parties-notify`) against a much larger surface
(email/SMS/push/in-app notification fan-out spans dozens of files under
`lib/notifications/`, `lib/providers/messaging/`). A dedicated
notification-fan-out proof beyond `parties-notify` was not written this wave
— flagged as a carry, not silently accepted as "covered."

---

## Part 1d — environment variables

`npm run test:env-var-parity` (already in the guard chain, unaffected by
this lane's changes):

```
647 total read site(s) · 185 distinct name(s) read across app/ + lib/
21 distinct name(s) read only under the wave-55 scraping freeze — excluded
174 distinct name(s) documented across .env.example / vercel.json / .github/workflows/*.yml
0 read with NO documented source (live, non-scraping)
3 documented but never read

✅ ENV_VAR_PARITY_PASS — every live process.env read has a documented source
```

**Verdict: no gap.** Every live (non-scraping) `process.env.X` read has a
documented source. The 3 "documented but never read" carries
(`NEXT_TELEMETRY_DISABLED`, `NODE_OPTIONS`, `SUPABASE_URL` — all three
read by CI workflow YAML / build tooling rather than application code) are
pre-existing and were carried forward from wave 59/60's own record of them,
not newly discovered.

**Platform-provided vs must-set, by flow** (derived from `.env.example` +
the flows above; blind spot: a computed `process.env[expr]` is invisible to
the scanner that produced this, so this table is a curated summary, not a
re-derivation):

| Flow | Platform-provided (never in tenant hands) | Must-set (per-environment) |
|---|---|---|
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | — |
| AI surfaces | Vercel AI Gateway creds (ambient on Vercel) | — |
| Property data | `RENTCAST_API_KEY`, BatchData token(s) | — (RentCast/BatchData are platform-paid per wave 69/70 rulings) |
| Voice/SMS | Twilio SID/token, `ELEVENLABS_API_KEY` | tenant's own DID/number (provisioned, not env) |
| Avatar video | D-ID key, Simli key (backup) | — |
| Direct mail | `LOB_API_KEY` | — |
| CRM sync | — | tenant's HubSpot/QuickBooks OAuth tokens (per-brokerage, DB-stored, not env) |
| IDX | — | tenant's IDX credential (DB-stored via settings, not env — wave 69 ruling) |
| Database | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — |
| Cron | `CRON_SECRET` | — |

---

## Part 2 — census round 18

All scripts below were run **individually in the foreground**
(`ORPHAN_EXPORT_BASELINE` was never set; `scripts/orphan-export-baseline.json`
was never committed to). `test:orphan-exports` was run once (it is long —
backgrounded automatically by the tool at its 120s timeout, then polled to
completion rather than blocked on synchronously, honoring both "run it and
record before/after" from the task brief and "don't sit and wait on it" from
the wave-73 integration note).

| Check | BEFORE | AFTER | Moved? | Why |
|---|---|---|---|---|
| `test:orphan-exports` | A=0, C=0 (baseline 889 unreferenced, 9592 exports, D=50 tagged) | unchanged | no | lane touched no exports (only object-literal entries in `MAINTENANCE_DOMAINS` and `bestEffort→sentinelWrite` call-site rewrites — neither adds/removes an export) |
| `test:opposite-missing` | 23 (0 1a / 1 1b / 0 2 / 0 3 / 0 4 / 0 5a / 0 5b / 0 6a / 0 6b / 14 6c / 8 6d) | unchanged, 23 | no | re-run after all edits; identical breakdown |
| `test:readerless-writes` | 0 | 0 | no | — |
| `test:writerless-reads` | 0 (697 tables, 675 with writers) | unchanged | no | — |
| `test:hidden-wires` | a=0 b=0 e=0 (c/d reported not ratcheted: 0 declared-never-passed props, 114 migration-defined-never-called RPCs) | unchanged | no | — |
| `test:orphan-writes` | 0 (675 written / 723 read tables) | unchanged | no | — |
| `test:dead-imports` | 0 | 0 | no | every `bestEffort` import removed this lane was replaced 1:1 with `sentinelWrite`, never left dangling |
| `test:import-export-parity` | 0 missing bindings / 0 missing barrel re-exports | unchanged | no | — |
| `test:anchor-census` | 0 dangling / 0 unverifiable | unchanged | no | — |
| `test:children-census` | 0 | unchanged | no | — |
| `test:orphaned-children` | 2 (OC1 unprotected parent link; OC2/OC3/OC4 all 0) | unchanged, 2 | no | pre-existing carried wire-list item (documented in wave 65+: `journey_states`/`tax_categories` class), out of scope this lane |
| `test:route-response-fields` | 0 returned-unread / 0 read-unreturned | unchanged | no | — |
| `test:unread-state-census` | 0 | unchanged | no | — |
| `test:silent-write` | consequential-table silent writes: 0 new; **wrapper-choice debt: 20** service-only files still calling `bestEffort` instead of `sentinelWrite` | **11** | **YES, 20→9 fewer** | 9 files converted this lane (see below); baseline re-frozen with `WRAPPER_CHOICE_BASELINE=1` |
| `test:proof-ownership` | 298 unowned (298 real, +4 already-fixed-before-this-session = 302 baseline) | **0** | **YES, 298→0** | every unowned proof given a `MAINTENANCE_DOMAINS` entry this lane (298 batch entries + the 2 new ads-manager/stale-recruit-reaper ones already counted in Part 1a); baseline re-frozen at 0 |

### `test:silent-write` — the 9 files converted (bestEffort → sentinelWrite)

All 9 use a **service-role** client (`createServiceClient()`), which per
`lib/kernel/write-sentinel.ts`'s own documented ruling means `sentinelWrite`
is *strictly stronger* (it can reach the `self_heal_events` ledger, so the
loss must be ledgered) — never weaker, so no behavior regressed:

1. `app/actions/contact-intelligence.ts` — `activities` audit-log write after AI-pilot toggle
2. `app/actions/contact-quick-actions.ts` — 2 sites: `contacts.enrichment_profile` cache (deal investigator), `contacts.email_verified` cache
3. `app/actions/auth/signup-brokerage.ts` — `activities` signup audit-log entry
4. `app/api/cron/engagement-scores/route.ts` — `contacts.engagement_score` recompute (platform-wide cron, no single brokerage)
5. `app/api/embed/capture/route.ts` — `contacts.embed_widget_id` attribution stamp
6. `app/api/providers/inbound/route.ts` — `contacts.last_contacted_at` recency stamp
7. `app/api/widget/capture-lead/route.ts` — 2 sites: `lifecycle_events` (`CONTACT_CAPTURED`), `activities` capture note
8. `lib/ai-isa/speed-to-lead.ts` — `contacts` first-touch idempotency claim
9. `app/actions/ai-isa/engage-contact.ts` — 4 sites: `contacts.last_contacted_at` recency stamp after email / SMS / call / voicedrop

Each conversion carries a `table`, `flow` (unique per call site, for the
repair digest), `brokerageId` where one was in scope (omitted only in the
platform-wide cron, where no single tenant applies), and the **original**
`reason` string carried over verbatim (CLAUDE.md §1.1 — give the survivor
what the duplicate had before deleting the pattern). Verified: scoped `tsc`
clean on all 9 files; `test:silent-write` RESULT 26/26 both before and after,
with the debt count the only thing that moved.

**Remaining 11 files, not converted this lane** (carried, not silently
dropped): `app/actions/ai-isa/engage-contact.ts` is now fully converted, so
the surviving 11 are `app/api/agent-assistant/tool-call/route.ts`,
`lib/campaign-sequences/step-executor.ts`,
`lib/contact-pipeline/contact-capture.ts`, `lib/kernel/jobs.ts`,
`lib/kernel/transactions.ts`, `lib/lead-intelligence/signal-extensions.ts`,
`lib/lead-intent/inbound-lead-intent.ts`,
`lib/lead-pipeline/enrichment-orchestrator.ts`,
`lib/platform/deal-room-demo.ts`, `lib/predictive-listing/run-scoring.ts`,
`lib/wealth-advisor/scan-opportunities.ts`. These are core kernel/pipeline
files where a hasty conversion risked touching scraping-adjacent or
transaction-critical code outside a careful read; left for the next wave
rather than rushed.

### `test:proof-ownership` — the 298-entry batch

Every one of the 298 proofs that had **zero** `MAINTENANCE_DOMAINS` ownership
(verified: real, running `package.json` script; confirmed 0 collisions
against existing entry keys before insertion) now has an entry. Manager
assignment was made by domain-keyword match on the proof name against the
existing 720-entry precedent set already in the registry (e.g. `buyer-*` →
`shopping_agent`, `seller-*`/`listing-*` → `listing_concierge`,
`cda-*`/`deal-*`/`transaction-*` → `deal_coordinator`,
`commission-*`/`finance*`/`vendor-payout*` → `finance_manager`,
`compliance*`/`fair-housing*` → `compliance_officer`,
`ads-*`/`ad-*` → `ads_manager`, `academy*`/`onboarding*`/`recruit*` →
`recruiting_manager`, `video*`/`avatar*`/`remotion*` → `asset_manager`,
`campaign-*`/`newsletter*`/`social-*` → `campaign_orchestrator`,
`sphere*`/`referral-*` (non-consolidation) → `sphere_of_influence`,
`cron-*`/`scraper-*` → `cron_manager`; everything else — mostly generic
guard/census/invariant scripts with no single business-flow owner — defaults
to `data_steward`, the existing largest bucket (182/720 before this lane) and
the manager already accountable for platform-wide data integrity). Each
entry's `what` field quotes the proof script's own header comment verbatim
(truthful by construction — it is the file's own stated purpose, not an
invented description) and states plainly that the assignment was made by
keyword match rather than a hand-audited business ruling, so a reviewer knows
which of the 720 pre-existing entries are essay-grade adjudications and which
298 are this wave's mechanical sweep.

**`test:manager-ownership` and `test:manager-signals` both still pass
(73/73 and 8/8)** after the addition — the new entries did not disturb the
manager roster, cross-cooperation rules, or signal-routing invariants those
guards check. `npx tsc --noEmit` on `lib/kernel/manager-registry.ts` alone is
clean. Two collisions were found and fixed during insertion: a JS-illegal
object key (`test:e2e-flows` → key `e2e_flows`, not `e2e:flows`) and one
key that happened to already exist under a different proof
(`buyer_nl_search` already named `test:doc-kernel`; the new entry was
renamed `buyer_nl_search_fh_correctness` to avoid silently overwriting the
existing essay-grade entry).

**Both shrink-only baselines were re-frozen** this lane (their own tooling
explicitly invites this: `--write-baseline` / `WRAPPER_CHOICE_BASELINE=1`),
since both moved in the improving direction and nothing but this lane's own
work explains the movement:
- `scripts/proof-ownership-baseline.json`: 302 → 0
- `scripts/wrapper-choice-baseline.json`: 20 → 11

`scripts/orphan-export-baseline.json` was **never touched** (explicit
instruction).

---

## Files touched this lane

- `package.json` — `scripts.guard` tail: +275 `npm run test:*` entries after `test:scrapers`
- `lib/kernel/manager-registry.ts` — +300 `MAINTENANCE_DOMAINS` entries (298 proof-ownership batch + `ads_manager_governed_spend` + `stale_recruit_reaper`)
- `scripts/proof-ownership-baseline.json` — re-frozen, 302 → 0
- `scripts/wrapper-choice-baseline.json` — re-frozen, 20 → 11
- 9 application files converted `bestEffort` → `sentinelWrite` (listed above)
- `docs/production-readiness-gaps-2026-09.md` — this document

## Unresolved (carried, not guessed away)

1. **Notifications/push** has only one guard-chain proof (`test:parties-notify`) against a much larger fan-out surface. Not expanded this wave.
2. **11 of 20** `bestEffort`-on-service-client files remain unconverted — core kernel/pipeline files that need a careful per-site read, not a mechanical sweep.
3. `test:orphaned-children` OC1's 2-item wire list (unprotected parent links) is a pre-existing carry from wave 65+, untouched this lane.
4. `opposite-missing`'s 8 `6d` UNRESOLVED routes (session-authed/public routes with no proof of an external caller and none against one) remain exactly as documented in prior waves — no new evidence either way was found this lane.
