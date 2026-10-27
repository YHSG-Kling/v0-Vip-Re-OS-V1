# Test matrix (wave 143, lane 143K) — measured at 21da8e4e

What was tested without new credentials or prices, in which mode, with what result, and what was NOT tested and why. The reading is point-in-time (2026-10-23, HEAD 21da8e4e, Node 22, 4 CPU, no application credentials). `scripts/test-matrix-guard.ts` (`test:test-matrix`, key pending registration — see the lane notes) holds this document in agreement with the code: every proof it names exists, every unperformed test carries its dependency, and no simulated run is labelled live. The guard does NOT re-run proofs; the results below are evidence, and the Reproduce section regenerates them.

## Evidence rules

1. **The exit code is the signal** (CLAUDE.md §7). A proof that prints `skipped` and exits 0 is SKIPPED, never PASS. Verdict vocabulary: PASS, PASS (live layer skipped), SKIPPED, FAIL, TIMEOUT. PASS (live layer skipped) means the layers that could run passed and the proof announced that another layer — its database layer, or in `test:canaries` the Playwright smoke — did not run for lack of Supabase credentials or a running app.
2. **Mode** is what the proof's code actually reaches. STATIC reads source, migrations or documents and executes no application code. IN-MEMORY executes real application modules against in-memory fakes. NONE means no proof exists to run. LIVE-TEST reaches a provider's sandbox or test mode with real credentials (Tier 2). LIVE reaches production (Tier 3). Every Tier 1 row is STATIC and/or IN-MEMORY, or NONE where nothing ran; none is LIVE-TEST or LIVE, and nothing here may be quoted as a live-provider success.
3. **Tiers.** Tier 1: no external access. Tier 2: an existing authorized safe integration, no spend, only where its credential already exists in the environment (checked by NAME only, never by value). Tier 3: needs owner configuration.
4. **Every unperformed test** is a row of the Not-performed register: NAME, DEPENDENCY, TESTED INSTEAD, FUTURE VALIDATION, RISK.
5. **A lane that is still building its proof** is listed under Pending proofs. It is neither run nor counted here.
6. **Counts are derived, not pinned.** A number in this document names its denominator and its exclusions; the guard asserts rules, never a count.

## Credential census

Names only. "Set here" is a reading of `process.env` key presence in the 143K environment; no value was read into any output. All 33 names below were unset, so no Tier 2 test could run and no Tier 1 result can be a live-provider result. The sandbox's own ANTHROPIC_BASE_URL routes the agent to its host; it is not an application credential and was not used.

| Name | Needed by | Set here |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | every live layer, proxy.ts, the UI | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the UI and the session client | no |
| `SUPABASE_URL` | live-schema drift, migration ledger, simulators' live layers | no |
| `SUPABASE_SERVICE_ROLE_KEY` | live-schema drift, migration ledger, simulators' live layers | no |
| `CRON_SECRET` | cron route authentication | no |
| `AI_GATEWAY_API_KEY` | the Vercel AI Gateway (the one AI egress) | no |
| `ANTHROPIC_API_KEY` | direct Anthropic calls where configured | no |
| `OPENAI_API_KEY` | direct OpenAI calls where configured | no |
| `STRIPE_SECRET_KEY` | Stripe platform client | no |
| `STRIPE_WEBHOOK_SECRET` | billing webhook signature | no |
| `STRIPE_VENDOR_WEBHOOK_SECRET` | vendor webhook signature | no |
| `SENDGRID_API_KEY` | outbound email | no |
| `SENDGRID_WEBHOOK_SECRET` | email event webhook | no |
| `SENDGRID_INBOUND_WEBHOOK_VERIFY_KEY` | inbound email webhook | no |
| `TWILIO_ACCOUNT_SID` | SMS and voice | no |
| `TWILIO_AUTH_TOKEN` | SMS and voice | no |
| `VERSIUM_API_KEY` | Versium enrichment | no |
| `RENTCAST_API_KEY` | RentCast valuation | no |
| `BATCHDATA_API_KEY` | BatchData property data | no |
| `DOCUSIGN_INTEGRATION_KEY` | DocuSign e-sign | no |
| `DOCUSIGN_WEBHOOK_SECRET` | DocuSign event webhook | no |
| `DOTLOOP_API_KEY` | Dotloop transaction provider | no |
| `DID_API_KEY` | D-ID avatar video | no |
| `ELEVENLABS_API_KEY` | ElevenLabs voice | no |
| `EXA_API_KEY` | Exa research | no |
| `GOOGLE_CLIENT_ID` | Google OAuth and YouTube | no |
| `GOOGLE_CLIENT_SECRET` | Google OAuth and YouTube | no |
| `QUICKBOOKS_CLIENT_ID` | QuickBooks OAuth | no |
| `QUICKBOOKS_CLIENT_SECRET` | QuickBooks OAuth | no |
| `MAPBOX_TOKEN` | Mapbox | no |
| `UI_SMOKE_BASE_URL` | the deployed Playwright smoke | no |
| `E2E_BASE_URL` | Playwright against a running app | no |
| `E2E_AUTH_STATE` | the authenticated Playwright flow | no |

## Tier 1 — no external access

One row per capability the lane brief lists. "Survivor proofs" are proofs that exist at the base commit and were run (see the run record for each). "Pending" is the proof a wave-143 lane is building. The Disposition column carries the reading.

| Capability | Mode | Survivor proofs | Pending (wave 143) | Disposition and reading |
|---|---|---|---|---|
| TypeScript | STATIC | the scoped compile of this lane's one new file (`scripts/test-matrix-guard.ts`) | — | RAN scoped, result in the lane notes. The whole-project `npm run type-check` is NOT RUN here (NR-01, integrator). |
| Schema and migration | STATIC | `test:schema-drift`, `test:schema-cache-drift`, `test:check-vocabulary`, `test:vocabulary-drift`, `test:migration-claim`, `test:vocabulary-snapshot`, `test:migration-ledger` | — | RAN. Code and the COMMITTED snapshot agree; the live database was not compared (NR-03, NR-04). `test:migration-ledger` is SKIPPED (credential-gated). |
| RLS and tenant isolation | STATIC + IN-MEMORY | `test:rls-public-grant`, `test:rls-anon-escape`, `test:secrets-rls`, `test:tenant-scope`, `test:conditional-tenant-predicate`, `test:sessionless-use-server-census`, `test:brokerage-identity`, `test:tenant-isolation`, `test:signed-upload-tenancy`, `test:proxy-sessionless-doors`, `test:provider-tenancy-model`, `test:readiness-tenant-scope`, `test:support-isolation` | — | RAN. Policies are read from migration files and code, not from `pg_policies`; `test:child-tenant-scope` (the live policy census) is SKIPPED (NR-05). |
| Platform roles | STATIC + IN-MEMORY | `test:platform-discriminator`, `test:role-vocabulary`, `test:platform-staff`, `test:lender-in-transaction`, `test:page-role-gate-roster`, `test:lead-visibility-roster`, `test:multi-role-seat`, `test:staff-onboarding`, `test:user-type-tool-surfaces`, `test:contact-scope-role-gate` | — | RAN. Two proofs that no CI runner reaches pin the retired `user_type='superadmin'` spelling and FAIL (see Findings F1 and F2). |
| Commission waterfall, referral, residual, revenue share, effective-dated agreements | IN-MEMORY | `test:commission-finalization`, `test:commission-ledger-sync`, `test:commission-cap`, `test:commission-orphan-dist`, `test:commission-set-in-stone`, `test:commission-tracking`, `test:commission-agreement`, `test:referral-payouts`, `test:referral-consolidation`, `test:residual-economics`, `test:revenue-share-board`, `test:team-lead-split`, `test:lifetime-ledger`, `test:financial-export` | PENDING 143C `scripts/agreement-waterfall-guard.ts` | RAN for the waterfall, referral, residual and revenue-share arithmetic. UNPROVEN at the base: no proof asserts that a calculation uses the agreement in force on the transaction's date (effective-dating) — that is the pending proof. |
| Subscriber and seat convergence | IN-MEMORY | `test:subscriber-convergence`, `test:seat-user-convergence`, `test:tenant-provisioning-loops`, `test:tenant-baseline`, `test:tenant-readiness`, `test:tenant-creation`, `test:subscriber-door`, `test:subscriber-conversion`, `test:billing-convergence`, `test:seat-cap` | — | RAN, plus the canaries `subscriber`, `seat`, `user-invite` inside `test:canaries`. |
| Stripe event idempotency | IN-MEMORY | `test:billing-convergence` (layer 4: a replayed event id applies once, a thrown delivery is re-claimable, a tenantless event is flagged unledgered), `test:stripe-webhook-events`, `test:webhook-subscriptions`, `test:webhook-contract`, `test:coupons-and-handoff`, `test:stripe-writethrough`, `test:stripe-account-scope`, `test:billing-access`, `test:plan-catalog` | — | RAN. The ledger is `withStripeEventLedger` over an in-memory action-ledger client; Stripe itself, signature verification with a real secret, and event payload drift are NOT exercised (NR-09). |
| Listing intake | IN-MEMORY | `test:listing-offer-lifecycle`, `test:listing-compliance-loop`, `test:listing-stage-gate`, `test:listing-stage-reader`, `test:listing-activation-gate`, `test:listing-draft-gate`, `test:listing-documents-gate`, `test:listing-doc-upload`, `test:listing-status-two-senses` | PENDING 143A `scripts/outside-offer-loop-guard.ts` | RAN, plus the `listing-lifecycle` canary. The MLS live date (planned vs verified) and the one `fully_executed` vocabulary are lane 143A work and are not provable at the base. |
| Outside offer and counter | IN-MEMORY | `test:inbound-offer-lane`, `test:offer-email-intake`, `test:offer-compliance-loop`, `test:offer-packet-gate`, `test:offer-auto-execute`, `test:offer-gate-enforcement`, `test:transaction-creation-gate` | PENDING 143A `scripts/outside-offer-loop-guard.ts` | RAN for the inbound outside-buyer-agent lane and the offer gates. The outbound loop to an OUTSIDE listing agent and the buyer-side counter-back loop have no proof at the base. |
| Email matching | IN-MEMORY | `test:offer-email-intake`, `test:inbound-intent`, `test:inbound-seller-intent`, `test:inbound-suppression-lead-identity`, `test:webhook-contract` | PENDING 143A `scripts/outside-offer-loop-guard.ts` | RAN on fixtures: street-number plus name matching, intent classification, suppression. Thread-id and sender-verification matching for the outside-offer replies is pending; real inbound mail is NR-11. |
| Compliance matrices | IN-MEMORY | `test:compliance-ledger`, `test:compliance-scope`, `test:compliance-checkpoints`, `test:compliance-gate`, `test:final-compliance-check`, `test:vendor-doc-compliance`, `test:unread-compliance-verdict`, `test:state-fair-housing`, `test:fair-housing-phrase-gate`, `test:trid-clock`, `test:seller-doc-vocabulary` | PENDING 143B `scripts/closing-compliance-guard.ts` | RAN. The brokerage required-document list by state, contract type, representation and stage is not provable at the base. |
| State roles | NONE | — | PENDING 143B `scripts/closing-compliance-guard.ts` | NOT RUN: no proof exists at the base for state-dependent closing participants (title company, settlement agent, buyer and seller closing attorneys). UNSUPPORTED by this lane until 143B cites a source per state. |
| Contract precedence | NONE | — | PENDING 143A `scripts/outside-offer-loop-guard.ts` | NOT RUN: no proof exists at the base for `governingContractTerms` or for an executed counter superseding earlier terms. |
| Closing compliance | IN-MEMORY | `test:final-compliance-check`, `test:closing-orchestration-integrity`, `test:closing-watchtower`, `test:closing-war-room`, `test:closing-overdue-reaper` | PENDING 143B `scripts/closing-compliance-guard.ts` | RAN for the signature, initial and document gate that precedes CDA submission. The settlement-versus-governing-terms comparison (price, commission, title owner's-policy payer, credits) has no proof at the base. |
| CDA and HUD corrections | IN-MEMORY | `test:cda-flow`, `test:cda-process-chain`, `test:cda-closing-flow`, `test:cda-esign`, `test:cda-delivery`, `test:cda-signing-flow`, `test:cda-delivery-reaper`, `test:cda-storage`, `test:cda-pdf-fill`, `test:cda-template-fields`, `test:cda-field-classifier`, `test:cda-fee-deduction`, `test:cda-commission-approval`, `test:cda-financial-wiring` | PENDING 143C `scripts/agreement-waterfall-guard.ts` | RAN, plus the canaries `cda-closing`, `cda-esign`, `preliminary-cd`. The preliminary HUD/CD correction loop with version history is pending. |
| FormWizard and PDF persistence | IN-MEMORY | `test:form-wizard-esign`, `test:pdf-form-fill`, `test:cda-pdf-fill`, `test:offer-esign-flow`, `test:offer-property-prefill` | PENDING 143B `scripts/closing-compliance-guard.ts` | RAN, plus the `form-wizard` canary. The platform-Media packet source (wave-142 hook `142B SOURCE (a)`, the one hook still pending in `test:canaries`) is not provable until 143B lands. |
| E-sign event simulation | IN-MEMORY | `test:esign-execution-loop`, `test:esign-default-rule`, `test:esign-anchors`, `test:google-esign-completion`, `test:transaction-provider-matrix`, `test:cda-esign`, `test:offer-esign-flow` | — | RAN. Provider events are simulated; no real signature, envelope or provider webhook was produced or received (NR-15). |
| Scanner and identity | IN-MEMORY | `test:entity-types`, `test:qr-and-card-scanner`, `test:qr-registry`, `test:business-card-classification`, `test:person-identity`, `test:identity-class`, `test:lead-identity-gate`, `test:identity-fallback` | PENDING 143D `scripts/versium-capability-matrix-guard.ts` | RAN, plus the `business-card` canary. Whether the scanner asks the type BEFORE scanning is lane 143D work. |
| Enrichment triggering | IN-MEMORY | `test:immediate-enrichment`, `test:enrichment-one-rail`, `test:enrichment-suppression`, `test:enrichment-retry`, `test:conversion-gate-enrichment`, `test:lookalike`, `test:acquisition-coverage`, `test:raw-lead-promotion`, `test:fuzzy-dedup`, `test:provider-cost-routing`, `test:connector-gateway` | PENDING 143D `scripts/versium-capability-matrix-guard.ts` | RAN on fakes and the one route table. No Versium, RentCast or BatchData call was made (NR-12). |
| Marketing assets | IN-MEMORY | `test:autonomous-marketing`, `test:asset-production`, `test:social-approval`, `test:content-approval`, `test:marketing-qr`, `test:content-safety`, `test:marketing-package`, `test:fair-housing-phrase-gate` | PENDING 143F `scripts/public-media-scope-guard.ts` | RAN, plus the `autonomous-marketing` canary. The negative guard (fair-housing checks never run on CDA, commission, agreements or ledgers) is pending. |
| Lead magnet and book export | IN-MEMORY | `test:lead-magnet-creation`, `test:lead-magnet-flow`, `test:lead-magnet-embed`, `test:lead-magnet-routing`, `test:lead-magnet-copy`, `test:ai-disclosure-export`, `test:import-export-parity` | PENDING 143F `scripts/public-media-scope-guard.ts` | RAN for lead magnets. NOT RUN for book export: no proof exists at the base for an EPUB or PDF book export (pending 143F; third-party validation is a future step). |
| Remotion local render | STATIC + IN-MEMORY | `test:render`, `test:remotion-setup`, `test:remotion-asset-math`, `test:section-render`, `test:video-pipeline-truth`, `test:video-pipeline-reaper`, `test:rendered-empty-states`, `test:render-from-approval`, `test:render-cache`, `test:video-timeline-integrity` | PENDING 143F `scripts/public-media-scope-guard.ts` | RAN: the dispatch layer, geometry agreement and the failure census. A local `remotion bundle` of the whole composition tree exited 0 in 19 s with no warning. A FRAME render is NOT RUN (NR-13): the headless shell and ffmpeg exist, but the page cannot load Google Fonts through this sandbox (see Findings F5). |
| Support and AI routing | IN-MEMORY | `test:support`, `test:support-console`, `test:support-lane`, `test:support-isolation`, `test:ai-by-your-side`, `test:ai-routing-coverage`, `test:ai-gateway-lane`, `test:ai-spend-booked`, `test:cost-completeness`, `test:persona-tool-realism`, `test:autonomy-gate`, `test:did-live-agent`, `test:manager-routing` | — | RAN. No model was called; routing, tool risk classes, spend booking and tenant scope are proven on fakes (NR-08). |
| UI and mobile | STATIC | `test:ui-wiring-census`, `test:mobile-readiness`, `test:no-dead-components`, `test:dangling-links`, `test:orphan-routes`, `test:portal-e2e`, `test:e2e-lifecycle` | PENDING 143J `scripts/feature-certification-guard.ts` | RAN the static census. `npx playwright test --list` compiled 12 tests (6 per project, 2 projects) in 3 files. No browser test ran (NR-06, NR-07). |
| Self-healing | IN-MEMORY | `test:self-healing`, `test:healing-policy`, `test:os-health`, `test:law-rule-healing`, `test:connector-healer`, `test:reaper-net`, `test:identity-self-heal` | — | RAN, plus the `self-healing` canary. |

## Tier 1 run record

Every row below was executed by this lane, ONE proof at a time with `NODE_OPTIONS=--max-old-space-size=6000`, at 21da8e4e. "CI chain" is derived from package.json (`guard` and `guard:compliance` are the two chains the per-push CI runs; `none` means no chain names it). "Via sweep" applies to the `none` rows only: `yes` means the CI simulator sweep (`test:sweep`, a step of `guard`) reaches it, `no` means its command shape is outside the sweep's filter and no `guard` step runs it. The Result line is the proof's own verdict line, cut to 96 characters; the full logs are in the lane scratchpad.

**Run summary.** 439 proofs run, 288 PASS, 146 PASS (live layer skipped), 3 SKIPPED, 2 FAIL, 0 TIMEOUT; 16421 assertions counted from the proofs' own "N passed" lines (a size indicator, not coverage); 1044 s of proof wall time. The `guard` chain holds 811 distinct steps (the type-check, then the `test:*` proofs); this lane ran 222 of them and did NOT run 589. 210 of 1028 registered `test:*` proofs are in no chain; this lane ran 207 of those. Exclusions: `test:e2e`, `test:e2e:ui` (a browser and a running app) and `test:production-smoke` (writes to the real database) were not run.

| Proof | Group | CI chain | Via sweep | Exit | Verdict | Result line |
|---|---|---|---|---|---|---|
| `test:schema-drift` | G1 schema / migration | guard | - | 0 | PASS | RESULT: 160 passed, 0 failed |
| `test:schema-cache-drift` | G1 schema / migration | guard | - | 0 | PASS (live layer skipped) | RESULT: 43 passed, 0 failed |
| `test:check-vocabulary` | G1 schema / migration | guard | - | 0 | PASS | RESULT: 51 passed, 0 failed |
| `test:vocabulary-drift` | G1 schema / migration | guard | - | 0 | PASS | RESULT: 5 passed, 0 failed |
| `test:migration-claim` | G1 schema / migration | guard | - | 0 | PASS (live layer skipped) | RESULT: 14 passed, 0 failed |
| `test:migration-ledger` | G1 schema / migration | guard | - | 0 | SKIPPED | ○ migration-ledger guard skipped (no Supabase credentials in this environment) |
| `test:vocabulary-snapshot` | G1 schema / migration | guard | - | 0 | PASS | RESULT: 16 passed, 0 failed |
| `test:rls-public-grant` | G2 RLS / tenant isolation | guard | - | 0 | PASS | PASSED |
| `test:rls-anon-escape` | G2 RLS / tenant isolation | guard | - | 0 | PASS | PASSED |
| `test:secrets-rls` | G2 RLS / tenant isolation | guard | - | 0 | PASS | RESULT: PASS — 82 passed, 0 failed |
| `test:tenant-scope` | G2 RLS / tenant isolation | guard | - | 0 | PASS | ✅ CLAIMED_TENANT_PASS — every caller-claimed tenant is decided by the one survivor (decideClaime |
| `test:conditional-tenant-predicate` | G2 RLS / tenant isolation | guard | - | 0 | PASS | ✅ CONDITIONAL_TENANT_PREDICATE_PASS — the optional-tenant-predicate surface can only shrink |
| `test:sessionless-use-server-census` | G2 RLS / tenant isolation | guard | - | 0 | PASS | SESSIONLESS "use server" CENSUS —102 passed, 0 failed · 16 findings (16 adjudicated, 0 open, 0 n |
| `test:brokerage-identity` | G2 RLS / tenant isolation | guard | - | 0 | PASS | RESULT: 126 passed, 0 failed |
| `test:tenant-isolation` | G2 RLS / tenant isolation | guard | - | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:child-tenant-scope` | G2 RLS / tenant isolation | guard | - | 0 | SKIPPED | ⊘ SKIPPED — no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env |
| `test:readiness-tenant-scope` | G2 RLS / tenant isolation | guard | - | 0 | PASS (live layer skipped) | RESULT: 87 passed, 0 failed, 1 skipped |
| `test:signed-upload-tenancy` | G2 RLS / tenant isolation | guard | - | 0 | PASS | RESULT: 44 passed, 0 failed |
| `test:proxy-sessionless-doors` | G2 RLS / tenant isolation | guard | - | 0 | PASS | RESULT: 57 passed, 0 failed |
| `test:provider-tenancy-model` | G2 RLS / tenant isolation | guard | - | 0 | PASS | ASSERTIONS 5 passed, 0 failed |
| `test:support-isolation` | G2 RLS / tenant isolation | guard | - | 0 | PASS (live layer skipped) | RESULT: 48 passed, 0 failed |
| `test:platform-discriminator` | G3 platform roles | guard | - | 0 | PASS | ✅ PLATFORM_DISCRIMINATOR_PASS — one definition; the re-spelling surface can only shrink |
| `test:role-vocabulary` | G3 platform roles | guard | - | 0 | PASS | RESULT: 13 passed, 0 failed |
| `test:platform-staff` | G3 platform roles | guard | - | 0 | PASS (live layer skipped) | RESULT: 18 passed, 0 failed |
| `test:lender-in-transaction` | G3 platform roles | guard | - | 0 | PASS (live layer skipped) | RESULT: 11 passed, 0 failed |
| `test:page-role-gate-roster` | G3 platform roles | guard | - | 0 | PASS | RESULT: 60 passed, 0 failed |
| `test:lead-visibility-roster` | G3 platform roles | guard | - | 0 | PASS | RESULT: 130 passed, 0 failed |
| `test:multi-role-seat` | G3 platform roles | guard | - | 0 | PASS (live layer skipped) | RESULT: 48 passed, 0 failed |
| `test:staff-onboarding` | G3 platform roles | guard | - | 0 | PASS (live layer skipped) | RESULT: 10 passed, 0 failed |
| `test:user-type-tool-surfaces` | G3 platform roles | guard | - | 0 | PASS | RESULT: 98 passed, 0 failed |
| `test:contact-detail-role-gate` | G3 platform roles | guard | - | 0 | PASS | ASSERTIONS 6 passed, 0 failed |
| `test:contact-scope-role-gate` | G3 platform roles | guard | - | 0 | PASS | ASSERTIONS 10 passed, 0 failed |
| `test:role-union-nav` | G3 platform roles | guard | - | 0 | PASS | RESULT: 57 passed, 0 failed |
| `test:commission-finalization` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 18 passed, 0 failed |
| `test:commission-ledger-sync` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 36 passed, 0 failed |
| `test:commission-cap` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 118 passed, 0 failed |
| `test:commission-orphan-dist` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | ORPHAN DISTRIBUTION — 7 passed, 0 failed |
| `test:commission-gross-rate` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 4 passed, 0 failed |
| `test:commission-agreement` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 27 passed, 0 failed |
| `test:commission-forecaster` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 38 passed, 0 failed |
| `test:commission-set-in-stone` | G4 commission / referral / residual / re | none | yes | 0 | PASS | RESULT: 76 passed, 0 failed |
| `test:commission-tracking` | G4 commission / referral / residual / re | none | yes | 0 | PASS (live layer skipped) | RESULT: 20 passed, 0 failed |
| `test:commission-dispute` | G4 commission / referral / residual / re | none | yes | 0 | PASS (live layer skipped) | RESULT: 12 passed, 0 failed |
| `test:commission-disclosure` | G4 commission / referral / residual / re | none | yes | 0 | PASS | RESULT: 15 passed, 0 failed |
| `test:cda-commission-approval` | G4 commission / referral / residual / re | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:cda-fee-deduction` | G4 commission / referral / residual / re | none | yes | 0 | PASS | RESULT: 23 passed, 0 failed |
| `test:referral-payouts` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 71 passed, 0 failed |
| `test:referral-consolidation` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 51 passed, 0 failed |
| `test:referral-closer` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:referral-reciprocity` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 12 passed, 0 failed |
| `test:referral-os-reachability` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 51 passed, 0 failed |
| `test:agent-referral` | G4 commission / referral / residual / re | none | yes | 0 | PASS (live layer skipped) | RESULT: 11 passed, 0 failed |
| `test:residual-economics` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 52 passed, 0 failed |
| `test:revenue-share-board` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 97 passed, 0 failed |
| `test:team-lead-split` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 45 passed, 0 failed |
| `test:lifetime-ledger` | G4 commission / referral / residual / re | guard | - | 0 | PASS | LIFETIME LEDGER — 40 passed, 0 failed |
| `test:financial-export` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 12 passed, 0 failed |
| `test:cap-crush` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | RESULT: 12 passed, 0 failed |
| `test:cda-financial-wiring` | G4 commission / referral / residual / re | guard | - | 0 | PASS (live layer skipped) | CDA/FINANCIAL WIRING — 45 passed, 0 failed |
| `test:commission-leak-reaper` | G4 commission / referral / residual / re | none | yes | 0 | PASS (live layer skipped) | RESULT: 8 passed, 0 failed |
| `test:vendor-payout-completion` | G4 commission / referral / residual / re | guard | - | 0 | PASS | RESULT: 35 passed, 0 failed |
| `test:conversion-finality` | G4 commission / referral / residual / re | guard | - | 0 | PASS | ✅ conversion-finality: 55 passed, 0 failed |
| `test:subscriber-convergence` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 49 passed, 0 failed |
| `test:seat-user-convergence` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 73 passed, 0 failed |
| `test:tenant-provisioning-loops` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 45 passed, 0 failed |
| `test:tenant-baseline` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 52 passed, 0 failed |
| `test:tenant-readiness` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 85 passed, 0 failed |
| `test:tenant-creation` | G5 subscriber / seat convergence | guard | - | 0 | PASS (live layer skipped) | RESULT: 38 passed, 0 failed |
| `test:subscriber-door` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 60 passed, 0 failed |
| `test:subscriber-conversion` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 72 passed, 0 failed |
| `test:billing-convergence` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 60 passed, 0 failed |
| `test:seat-cap` | G5 subscriber / seat convergence | guard | - | 0 | PASS (live layer skipped) | RESULT: 110 passed, 0 failed |
| `test:seat-bands` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 72 passed, 0 failed |
| `test:seat-display` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 140 passed, 0 failed |
| `test:seat-packages` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 85 passed, 0 failed |
| `test:seat-producer-roles` | G5 subscriber / seat convergence | guard | - | 0 | PASS | RESULT: 52 passed, 0 failed |
| `test:stripe-webhook-events` | G6 Stripe events / billing | guard | - | 0 | PASS | RESULT: 54 passed, 0 failed |
| `test:webhook-subscriptions` | G6 Stripe events / billing | guard | - | 0 | PASS | RESULT: 67 passed, 0 failed |
| `test:webhook-contract` | G6 Stripe events / billing | guard | - | 0 | PASS | RESULT: 240 passed, 0 failed |
| `test:coupons-and-handoff` | G6 Stripe events / billing | guard | - | 0 | PASS | RESULT: 61 passed, 0 failed |
| `test:billing-access` | G6 Stripe events / billing | guard | - | 0 | PASS (live layer skipped) | RESULT: 80 passed, 0 failed |
| `test:plan-catalog` | G6 Stripe events / billing | guard | - | 0 | PASS (live layer skipped) | RESULT: 16 passed, 0 failed |
| `test:overage-stripe-metering` | G6 Stripe events / billing | guard | - | 0 | PASS | 82 passed, 0 failed |
| `test:stripe-writethrough` | G6 Stripe events / billing | guard | - | 0 | PASS (live layer skipped) | RESULT: 25 passed, 0 failed |
| `test:stripe-account-scope` | G6 Stripe events / billing | guard | - | 0 | PASS | ✅ stripe-account-scope: 116 passed, 0 failed |
| `test:listing-offer-lifecycle` | G7 listing intake | guard | - | 0 | PASS | RESULT: PASS — 84 passed, 0 failed |
| `test:listing-compliance-loop` | G7 listing intake | guard | - | 0 | PASS | RESULT: 38 passed, 0 failed |
| `test:listing-stage-gate` | G7 listing intake | guard | - | 0 | PASS (live layer skipped) | LISTING STAGE GATES — 36 passed, 0 failed |
| `test:listing-stage-reader` | G7 listing intake | guard | - | 0 | PASS (live layer skipped) | LISTING STAGE READER — 10 passed, 0 failed |
| `test:listing-activation-gate` | G7 listing intake | guard | - | 0 | PASS | SOURCE + BEHAVIOUR 33 passed, 0 failed |
| `test:listing-draft-gate` | G7 listing intake | guard | - | 0 | PASS | RESULT: 45 passed, 0 failed |
| `test:listing-documents-gate` | G7 listing intake | guard | - | 0 | PASS | RESULT: 29 passed, 0 failed |
| `test:listing-doc-upload` | G7 listing intake | guard | - | 0 | PASS | RESULT: 56 passed, 0 failed |
| `test:listing-status-two-senses` | G7 listing intake | guard | - | 0 | PASS | RESULT: 69 passed, 0 failed |
| `test:listings-kernel-wiring` | G7 listing intake | guard | - | 0 | PASS (live layer skipped) | Layer 1+2 assertions : 23 passed, 0 failed |
| `test:listing-archive` | G7 listing intake | guard | - | 0 | PASS | RESULT: 104 passed, 0 failed |
| `test:listing-media-consolidation` | G7 listing intake | guard | - | 0 | PASS (live layer skipped) | LISTING MEDIA CONSOLIDATION — 47 passed, 0 failed |
| `test:listing-appointment` | G7 listing intake | guard | - | 0 | PASS | RESULT: 81 passed, 0 failed |
| `test:listing-appt-prep` | G7 listing intake | guard | - | 0 | PASS (live layer skipped) | RESULT: 12 passed, 0 failed |
| `test:listing-status-sync` | G7 listing intake | none | yes | 0 | PASS | RESULT: 26 passed, 0 failed |
| `test:listing-capture` | G7 listing intake | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:offer-compliance-loop` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 37 passed, 0 failed |
| `test:offer-packet-gate` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 70 passed, 0 failed |
| `test:inbound-offer-lane` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 206 passed, 0 failed |
| `test:offer-gate-enforcement` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 59 passed, 0 failed |
| `test:offer-ready` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 7 passed, 0 failed |
| `test:offer-flag-loop` | G8 offers / outside offers / counters | guard | - | 0 | PASS (live layer skipped) | RESULT: 55 passed, 0 failed |
| `test:offer-net-sheet` | G8 offers / outside offers / counters | guard | - | 0 | PASS (live layer skipped) | RESULT: 10 passed, 0 failed |
| `test:offer-rejection` | G8 offers / outside offers / counters | guard | - | 0 | PASS (live layer skipped) | RESULT: 9 passed, 0 failed |
| `test:offer-batch-derivation` | G8 offers / outside offers / counters | guard | - | 0 | PASS | ASSERTIONS 9 passed, 0 failed |
| `test:offer-auto-execute` | G8 offers / outside offers / counters | none | yes | 0 | PASS | RESULT: 34 passed, 0 failed |
| `test:offer-email-intake` | G8 offers / outside offers / counters | none | yes | 0 | PASS | RESULT: 12 passed, 0 failed |
| `test:offer-esign-flow` | G8 offers / outside offers / counters | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:offer-property-prefill` | G8 offers / outside offers / counters | none | yes | 0 | PASS (live layer skipped) | RESULT: 14 passed, 0 failed |
| `test:multi-offer-rules` | G8 offers / outside offers / counters | none | yes | 0 | PASS | RESULT: 8 passed, 0 failed |
| `test:stranded-offer-reaper` | G8 offers / outside offers / counters | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:transaction-creation-gate` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 91 passed, 0 failed |
| `test:buyer-offer-request` | G8 offers / outside offers / counters | guard | - | 0 | PASS | 50 passed, 0 failed |
| `test:buyer-portal-offer-intent` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 62 passed, 0 failed |
| `test:seller-offer-presentation` | G8 offers / outside offers / counters | guard | - | 0 | PASS | RESULT: 24 passed, 0 failed |
| `test:inbound-intent` | G9 email matching / inbound | guard | - | 0 | PASS (live layer skipped) | RESULT: 21 passed, 0 failed |
| `test:inbound-seller-intent` | G9 email matching / inbound | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:inbound-suppression-lead-identity` | G9 email matching / inbound | guard | - | 0 | PASS | INBOUND SUPPRESSION LEAD IDENTITY — 42 passed, 0 failed |
| `test:workflow-inbound-events-reader` | G9 email matching / inbound | guard | - | 0 | PASS | RESULT: 8 passed, 0 failed |
| `test:mailbox-owner-preference` | G9 email matching / inbound | guard | - | 0 | PASS | RESULT: 66 passed, 0 failed |
| `test:mail-unsubscribe` | G9 email matching / inbound | guard | - | 0 | PASS | RESULT: 128 passed, 0 failed |
| `test:compliance-ledger` | G10 compliance matrices | guard | - | 0 | PASS (live layer skipped) | RESULT: 10 passed, 0 failed |
| `test:compliance-scope` | G10 compliance matrices | guard | - | 0 | PASS | 74 passed, 0 failed |
| `test:compliance-checkpoints` | G10 compliance matrices | guard | - | 0 | PASS | RESULT: 29 passed, 0 failed |
| `test:compliance-gate` | G10 compliance matrices | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 15 passed, 0 failed |
| `test:final-compliance-check` | G10 compliance matrices | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:compliance-flag-reaper` | G10 compliance matrices | none | yes | 0 | PASS (live layer skipped) | RESULT: 15 passed, 0 failed |
| `test:vendor-doc-compliance` | G10 compliance matrices | guard | - | 0 | PASS (live layer skipped) | RESULT: 46 passed, 0 failed |
| `test:unread-compliance-verdict` | G10 compliance matrices | guard | - | 0 | PASS | ✅ UNREAD_COMPLIANCE_VERDICT_PASS — every compliance verdict computed is read |
| `test:state-fair-housing` | G10 compliance matrices | guard | - | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:fair-housing-phrase-gate` | G10 compliance matrices | guard | - | 0 | PASS | RESULT: 39 passed, 0 failed |
| `test:trid-clock` | G10 compliance matrices | guard | - | 0 | PASS (live layer skipped) | RESULT: 17 passed, 0 failed |
| `test:seller-doc-vocabulary` | G10 compliance matrices | guard | - | 0 | PASS | RESULT: 25 passed, 0 failed |
| `test:cda-closing-flow` | G12 closing / CDA / HUD | guard | - | 0 | PASS | RESULT: PASS — 61 passed, 0 failed |
| `test:cda-flow` | G12 closing / CDA / HUD | guard | - | 0 | PASS (live layer skipped) | RESULT: 17 passed, 0 failed |
| `test:cda-process-chain` | G12 closing / CDA / HUD | guard | - | 0 | PASS | RESULT: 36 passed, 0 failed |
| `test:cda-esign` | G12 closing / CDA / HUD | guard | - | 0 | PASS | RESULT: 7 passed, 0 failed |
| `test:cda-delivery` | G12 closing / CDA / HUD | guard | - | 0 | PASS | RESULT: 25 passed, 0 failed |
| `test:cda-storage` | G12 closing / CDA / HUD | guard | - | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:cda-pdf-fill` | G12 closing / CDA / HUD | guard | - | 0 | PASS | RESULT: 16 passed, 0 failed |
| `test:cda-signing-flow` | G12 closing / CDA / HUD | none | yes | 0 | PASS | RESULT: 15 passed, 0 failed |
| `test:cda-template-fields` | G12 closing / CDA / HUD | none | yes | 0 | PASS | RESULT: 21 passed, 0 failed |
| `test:cda-field-classifier` | G12 closing / CDA / HUD | none | yes | 0 | PASS | RESULT: 22 passed, 0 failed |
| `test:cda-delivery-reaper` | G12 closing / CDA / HUD | none | yes | 0 | PASS (live layer skipped) | RESULT: 9 passed, 0 failed |
| `test:closing-orchestration-integrity` | G12 closing / CDA / HUD | guard | - | 0 | PASS | RESULT: 33 passed, 0 failed |
| `test:closing-watchtower` | G12 closing / CDA / HUD | guard | - | 0 | PASS (live layer skipped) | RESULT: 20 passed, 0 failed |
| `test:closing-war-room` | G12 closing / CDA / HUD | guard | - | 0 | PASS (live layer skipped) | RESULT: 23 passed, 0 failed |
| `test:closing-overdue-reaper` | G12 closing / CDA / HUD | none | yes | 0 | PASS (live layer skipped) | RESULT: 14 passed, 0 failed |
| `test:deal-save-huddle` | G12 closing / CDA / HUD | guard | - | 0 | PASS (live layer skipped) | RESULT: 25 passed, 0 failed |
| `test:form-wizard-esign` | G13 FormWizard / PDF / e-sign | guard | - | 0 | PASS | RESULT: 109 passed, 0 failed |
| `test:pdf-form-fill` | G13 FormWizard / PDF / e-sign | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:esign-anchors` | G13 FormWizard / PDF / e-sign | guard | - | 0 | PASS | RESULT: 28 passed, 0 failed |
| `test:esign-default-rule` | G13 FormWizard / PDF / e-sign | guard | - | 0 | PASS | RESULT: 54 passed, 0 failed |
| `test:esign-execution-loop` | G13 FormWizard / PDF / e-sign | guard | - | 0 | PASS | RESULT: 35 passed, 0 failed |
| `test:google-esign-completion` | G13 FormWizard / PDF / e-sign | guard | - | 0 | PASS | RESULT: 20 passed, 0 failed |
| `test:transaction-provider-matrix` | G13 FormWizard / PDF / e-sign | guard | - | 0 | PASS | RESULT: PASS — 61 passed, 0 failed |
| `test:transaction-document-wiring` | G13 FormWizard / PDF / e-sign | guard | - | 0 | PASS (live layer skipped) | STATIC 21 passed, 0 failed |
| `test:entity-types` | G14 scanner / identity | guard | - | 0 | PASS | RESULT: 54 passed, 0 failed |
| `test:qr-and-card-scanner` | G14 scanner / identity | guard | - | 0 | PASS | RESULT: 79 passed, 0 failed |
| `test:qr-registry` | G14 scanner / identity | guard | - | 0 | PASS | RESULT: 26 passed, 0 failed |
| `test:business-card-classification` | G14 scanner / identity | guard | - | 0 | PASS | RESULT: 72 passed, 0 failed |
| `test:person-identity` | G14 scanner / identity | guard | - | 0 | PASS | RESULT: 144 passed, 0 failed |
| `test:identity-class` | G14 scanner / identity | guard | - | 0 | PASS | IDENTITY CLASS — 114 passed, 0 failed |
| `test:lead-identity-gate` | G14 scanner / identity | guard | - | 0 | PASS | RESULT: 99 passed, 0 failed |
| `test:identity-fallback` | G14 scanner / identity | guard | - | 0 | PASS | IDENTITY FALLBACK — 78 passed, 0 failed |
| `test:immediate-enrichment` | G15 enrichment triggering | guard | - | 0 | PASS | RESULT: 54 passed, 0 failed |
| `test:enrichment-one-rail` | G15 enrichment triggering | guard | - | 0 | PASS | RESULT: 144 passed, 0 failed |
| `test:enrichment-suppression` | G15 enrichment triggering | guard | - | 0 | PASS (live layer skipped) | ENRICHMENT SUPPRESSION — 199 passed, 0 failed |
| `test:enrichment-retry` | G15 enrichment triggering | none | yes | 0 | PASS | RESULT: 23 passed, 0 failed |
| `test:conversion-gate-enrichment` | G15 enrichment triggering | guard | - | 0 | PASS | CONVERSION GATE + AUTO ENRICHMENT — 70 passed, 0 failed |
| `test:lookalike` | G15 enrichment triggering | guard | - | 0 | PASS | RESULT: 2 passed, 0 failed |
| `test:acquisition-coverage` | G15 enrichment triggering | guard | - | 0 | PASS | RESULT: 89 passed, 0 failed |
| `test:raw-lead-promotion` | G15 enrichment triggering | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:fuzzy-dedup` | G15 enrichment triggering | none | yes | 0 | PASS | RESULT: 11 passed, 0 failed |
| `test:provider-cost-routing` | G15 enrichment triggering | guard | - | 0 | PASS | RESULT: 115 passed, 0 failed |
| `test:connector-gateway` | G15 enrichment triggering | guard | - | 0 | PASS | RESULT: 26 passed, 0 failed |
| `test:autonomous-marketing` | G16 marketing assets | guard | - | 0 | PASS | RESULT: 61 passed, 0 failed |
| `test:asset-production` | G16 marketing assets | guard | - | 0 | PASS | RESULT: 144 passed, 0 failed |
| `test:social-approval` | G16 marketing assets | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:content-approval` | G16 marketing assets | none | yes | 0 | PASS (live layer skipped) | RESULT: 16 passed, 0 failed |
| `test:marketing-qr` | G16 marketing assets | guard | - | 0 | PASS (live layer skipped) | RESULT: 13 passed, 0 failed |
| `test:content-safety` | G16 marketing assets | guard | - | 0 | PASS (live layer skipped) | RESULT: 19 passed, 0 failed |
| `test:marketing-package` | G16 marketing assets | none | yes | 0 | PASS | RESULT: 29 passed, 0 failed |
| `test:lead-magnet-creation` | G17 lead magnet / book / export | guard | - | 0 | PASS | RESULT: 69 passed, 0 failed |
| `test:lead-magnet-flow` | G17 lead magnet / book / export | guard | - | 0 | PASS | RESULT: 24 passed, 0 failed |
| `test:lead-magnet-embed` | G17 lead magnet / book / export | guard | - | 0 | PASS | RESULT: 22 passed, 0 failed |
| `test:lead-magnet-routing` | G17 lead magnet / book / export | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:lead-magnet-copy` | G17 lead magnet / book / export | none | yes | 0 | PASS | RESULT: 31 passed, 0 failed |
| `test:ai-disclosure-export` | G17 lead magnet / book / export | guard | - | 0 | PASS | RESULT: 23 passed, 0 failed |
| `test:import-export-parity` | G17 lead magnet / book / export | guard | - | 0 | PASS | ✅ IMPORT_EXPORT_PARITY_PASS |
| `test:render` | G18 remotion / render | none | yes | 0 | PASS | RESULT: 50 passed, 0 failed |
| `test:remotion-setup` | G18 remotion / render | guard | - | 0 | PASS (live layer skipped) | REMOTION SETUP — 133 passed, 0 failed |
| `test:remotion-asset-math` | G18 remotion / render | guard | - | 0 | PASS | RESULT: 461 passed, 0 failed |
| `test:section-render` | G18 remotion / render | none | yes | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed (skipped — no DB credentials) |
| `test:video-pipeline-truth` | G18 remotion / render | guard | - | 0 | PASS | RESULT: 117 passed, 0 failed |
| `test:video-pipeline-reaper` | G18 remotion / render | none | yes | 0 | PASS | RESULT: 11 passed, 0 failed |
| `test:rendered-empty-states` | G18 remotion / render | guard | - | 0 | PASS | RESULT: 23 passed, 0 failed |
| `test:render-from-approval` | G18 remotion / render | guard | - | 0 | PASS | render-from-approval: 70 passed, 0 failed (denominator 70) |
| `test:render-cache` | G18 remotion / render | guard | - | 0 | PASS | RENDER CACHE — 155 passed, 0 failed |
| `test:face-render-seam` | G18 remotion / render | guard | - | 0 | PASS | RESULT: 85 passed, 0 failed |
| `test:video-stitching` | G18 remotion / render | guard | - | 0 | PASS | VIDEO STITCHING — 83 passed, 0 failed |
| `test:video-assembly` | G18 remotion / render | guard | - | 0 | PASS | RESULT: 393 passed, 0 failed |
| `test:video-timeline-integrity` | G18 remotion / render | guard | - | 0 | PASS | video-timeline-integrity: 480 passed, 0 failed (denominator 480) |
| `test:support` | G19 support / AI routing | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:support-console` | G19 support / AI routing | guard | - | 0 | PASS (live layer skipped) | RESULT: 17 passed, 0 failed |
| `test:support-lane` | G19 support / AI routing | guard | - | 0 | PASS (live layer skipped) | RESULT: 32 passed, 0 failed |
| `test:ai-by-your-side` | G19 support / AI routing | guard | - | 0 | PASS | 103 passed, 0 failed |
| `test:ai-routing-coverage` | G19 support / AI routing | guard | - | 0 | PASS | 19 passed, 0 failed |
| `test:ai-gateway-lane` | G19 support / AI routing | guard | - | 0 | PASS | PASSED |
| `test:ai-spend-booked` | G19 support / AI routing | guard | - | 0 | PASS | RESULT: 31 passed, 0 failed |
| `test:cost-completeness` | G19 support / AI routing | guard | - | 0 | PASS | RESULT: 47 passed, 0 failed |
| `test:persona-tool-realism` | G19 support / AI routing | guard | - | 0 | PASS | RESULT: 153 passed, 0 failed |
| `test:autonomy-gate` | G19 support / AI routing | guard | - | 0 | PASS (live layer skipped) | RESULT: 17 passed, 0 failed |
| `test:did-live-agent` | G19 support / AI routing | guard | - | 0 | PASS | RESULT: 50 passed, 0 failed |
| `test:manager-routing` | G19 support / AI routing | guard | - | 0 | PASS | RESULT: 80 passed, 0 failed |
| `test:ui-wiring-census` | G20 UI / mobile | guard | - | 0 | PASS | RESULT: 38 passed, 0 failed |
| `test:mobile-readiness` | G20 UI / mobile | guard | - | 0 | PASS | RESULT: 51 passed, 0 failed |
| `test:no-dead-components` | G20 UI / mobile | guard | - | 0 | PASS | RESULT: 1 passed, 0 failed |
| `test:dangling-links` | G20 UI / mobile | guard | - | 0 | PASS | ✅ DANGLING_LINK_PASS — every literal internal link reaches a route |
| `test:orphan-routes` | G20 UI / mobile | guard | - | 0 | PASS | ✅ no NEW orphan routes |
| `test:e2e-flows` | G20 UI / mobile | none | no | 0 | PASS (live layer skipped) | RESULT: 13 passed, 0 failed RESULT: 9 passed, 0 failed |
| `test:portal-e2e` | G20 UI / mobile | guard | - | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed |
| `test:e2e-lifecycle` | G20 UI / mobile | guard | - | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:self-healing` | G21 self-healing | guard | - | 0 | PASS | RESULT: SELF_HEALING_PASS — 126 passed, 0 failed |
| `test:healing-policy` | G21 self-healing | guard | - | 0 | PASS | RESULT: HEALING_POLICY_PASS — 65 passed, 0 failed |
| `test:os-health` | G21 self-healing | guard | - | 0 | PASS | RESULT: 104 passed, 0 failed |
| `test:law-rule-healing` | G21 self-healing | guard | - | 0 | PASS | RESULT: 52 passed, 0 failed |
| `test:connector-healer` | G21 self-healing | guard | - | 0 | PASS | RESULT: 102 passed, 0 failed |
| `test:reaper-net` | G21 self-healing | guard | - | 0 | PASS (live layer skipped) | RESULT: 38 passed, 0 failed |
| `test:identity-self-heal` | G21 self-healing | guard | - | 0 | PASS | RESULT: 22 passed, 0 failed |
| `test:canaries` | G22 cross-cutting | guard | - | 0 | PASS (live layer skipped) | RESULT: canaries 34, passed 34, failed 0; steps 479/479; hooks pending 1; rows deleted 820 |
| `test:production-readiness` | G22 cross-cutting | guard | - | 0 | PASS | RESULT: 105 passed, 0 failed |
| `test:proof-ownership` | G22 cross-cutting | none | yes | 0 | PASS | ✅ PROOF_OWNERSHIP_PASS — no new feature shipped without an owner |
| `test:orphan-exports` | G22 cross-cutting | guard | - | 0 | PASS | ✅ ORPHAN_EXPORT_PASS — no NEW unwired export (0 orphaned A+C on the wire-list, 1101 live interna |
| `test:no-orphan-actions` | G22 cross-cutting | guard | - | 0 | PASS | RESULT: 1 passed, 0 failed |
| `test:use-server-exports` | G22 cross-cutting | guard | - | 0 | PASS | RESULT: 4 passed, 0 failed |
| `test:expired-listing-source` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 15 passed, 0 failed |
| `test:repurpose-shorts` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 13 passed, 0 failed |
| `test:motivated-triggers` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 15 passed, 0 failed |
| `test:stuck-campaign-reaper` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 22 passed, 0 failed |
| `test:newsletter-cadence` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 11 passed, 0 failed |
| `test:social-cadence` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:tax-planning` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 33 passed, 0 failed |
| `test:lead-flow` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 42 passed, 0 failed |
| `test:geo` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 47 passed, 0 failed |
| `test:charts` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 31 passed, 0 failed |
| `test:portal-milestone-visibility` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 10 passed, 0 failed |
| `test:milestone-education-tie` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 61 passed, 0 failed |
| `test:milestone-seeder-consolidation` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 42 passed, 0 failed |
| `test:lead-contact-type` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 74 passed, 0 failed |
| `test:scraper-territory-gate` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 11 passed, 0 failed |
| `test:adaptive-reengagement` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 18 passed, 0 failed |
| `test:lead-outreach` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 14 passed, 0 failed |
| `test:revenue-pipeline` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 13 passed, 0 failed |
| `test:first-look-text` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 8 passed, 0 failed |
| `test:property-buyer-match` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:lead-readiness-handoff` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 7 passed, 0 failed |
| `test:cma-presentation` | unchained / satellite chain | none | yes | 0 | PASS | 22 passed, 0 failed |
| `test:schedule-appointment` | unchained / satellite chain | none | yes | 0 | PASS | Results: 19 passed, 0 failed |
| `test:video-script` | unchained / satellite chain | none | yes | 0 | PASS | 29 passed, 0 failed |
| `test:lead-signal-ingest` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 26 passed, 0 failed |
| `test:fb-audience-templates` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 15 passed, 0 failed |
| `test:academy-learning` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:locations` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:manager-trust` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 12 passed, 0 failed |
| `test:outcome-attribution` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 38 passed, 0 failed |
| `test:neighbor-notification` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 14 passed, 0 failed |
| `test:schedule-newsletter` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 22 passed, 0 failed |
| `test:command-center-scope` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 4 passed, 0 failed |
| `test:geo-gap` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 8 passed, 0 failed |
| `test:geo-remediation` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:source-reallocation` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:buyer-saves` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed |
| `test:intelligence-report` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 61 passed, 0 failed |
| `test:retention-board` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 16 passed, 0 failed |
| `test:delivery-format` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 17 passed, 0 failed |
| `test:retention-outcomes` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 17 passed, 0 failed |
| `test:org-recipients` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 12 passed, 0 failed |
| `test:voice-execute` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:broker-brief-intel` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 4 passed, 0 failed |
| `test:readiness-gate` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:certification-issued` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:avatar-loop` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 11 passed, 0 failed |
| `test:cma-data` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 19 passed, 0 failed |
| `test:cma-compliance` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 26 passed, 0 failed |
| `test:presentation-drip` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 34 passed, 0 failed |
| `test:section-narration` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 34 passed, 0 failed |
| `test:asset-capture` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed (skipped — no DB credentials) |
| `test:stock-scope` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:narration-orchestrator` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:prelisting-release` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 10 passed, 0 failed |
| `test:ad-connector` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 23 passed, 0 failed |
| `test:ad-payload` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 25 passed, 0 failed |
| `test:client-message` | unchained / satellite chain | none | yes | 0 | SKIPPED | ✅ (pure layer: none — this flow is DB-driven) |
| `test:listing-ad-handoff` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:closing-testimonial` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:portal-fanout` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 20 passed, 0 failed |
| `test:letter-strength` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 18 passed, 0 failed |
| `test:tour-followup` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:offer-strategy` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:buyer-welcome` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 4 passed, 0 failed |
| `test:buyer-match-reel` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 8 passed, 0 failed |
| `test:market-watch` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:external-match` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 14 passed, 0 failed |
| `test:buyer-reel-delivery` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 4 passed, 0 failed |
| `test:federal-holidays` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 20 passed, 0 failed |
| `test:step-palette-consolidation` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 58 passed, 0 failed |
| `test:ai-call-adapter` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed |
| `test:touch-provenance` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:commission-video-step` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:touch-provenance-standup` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:material-change` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 7 passed, 0 failed |
| `test:decision-receipts` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:variant-winner` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 6 passed, 0 failed |
| `test:coordination-kind` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 11 passed, 0 failed |
| `test:ab-variant` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 14 passed, 0 failed |
| `test:dry-run-cockpit` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 7 passed, 0 failed |
| `test:relationship-health` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:source-health` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:source-lifetime-health` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:second-opinion` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:steer-my-day` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:health-lifecycle` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 12 passed, 0 failed |
| `test:winback-personalization` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:consensus-memory` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 8 passed, 0 failed |
| `test:consensus-memory-runner` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 3 passed, 0 failed |
| `test:consult-outcome-resolver` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 2 passed, 0 failed |
| `test:showing-feedback-routing` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:listing-stall-predictor` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:open-house-lead-routing` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:listing-marketing-handoff` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:buyer-stall-predictor` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:stuck-stage-detector` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 9 passed, 0 failed |
| `test:predictor-learning` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:predictor-outcome-resolver` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 5 passed, 0 failed |
| `test:loan-milestone-sync` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 14 passed, 0 failed |
| `test:lifetime-touchpoint-reaper` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:lifetime-persona` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 12 passed, 0 failed |
| `test:client-testimonial` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 7 passed, 0 failed |
| `test:deal-type-resolver` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 5 passed, 0 failed |
| `test:home-wealth` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 30 passed, 0 failed |
| `test:next-move` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 19 passed, 0 failed |
| `test:home-assistant` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 39 passed, 0 failed |
| `test:home-maintenance` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 36 passed, 0 failed |
| `test:climate` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 19 passed, 0 failed |
| `test:standup-narrative` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 14 passed, 0 failed |
| `test:stuck-social-post-reaper` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 10 passed, 0 failed |
| `test:stuck-ad-action-reaper` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 9 passed, 0 failed |
| `test:voice-task-command` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 18 passed, 0 failed |
| `test:voice-campaign-command` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 8 passed, 0 failed |
| `test:voice-bus` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 14 passed, 0 failed |
| `test:voice-overlay-parity` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:lifetime-segment` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 20 passed, 0 failed |
| `test:learning-outcomes` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 2 passed, 0 failed |
| `test:voice-report` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 8 passed, 0 failed |
| `test:lead-warmth` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 6 passed, 0 failed |
| `test:manager-standup` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 4 passed, 0 failed |
| `test:persona-render` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 9 passed, 0 failed |
| `test:sequence-persona-copy` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed |
| `test:offer-accelerator` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 28 passed, 0 failed |
| `test:affordability` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 30 passed, 0 failed |
| `test:urgent-sla` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 10 passed, 0 failed |
| `test:comps-animation` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 19 passed, 0 failed |
| `test:client-framing` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 18 passed, 0 failed |
| `test:home-comparison` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 13 passed, 0 failed |
| `test:preference-learning` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 11 passed, 0 failed |
| `test:address-analysis` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 13 passed, 0 failed |
| `test:saved-home-nudge` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 18 passed, 0 failed |
| `test:showing-cancellation` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 12 passed, 0 failed |
| `test:notification-preferences` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 14 passed, 0 failed |
| `test:fit-badge` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 7 passed, 0 failed |
| `test:showing-feedback-learning` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 32 passed, 0 failed |
| `test:seller-equity` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 14 passed, 0 failed |
| `test:seller-scenarios` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 16 passed, 0 failed |
| `test:signal-reaper` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:deal-doc-router` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 18 passed, 0 failed |
| `test:seller-conversion` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 16 passed, 0 failed |
| `test:listing-metrics` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 8 passed, 0 failed |
| `test:market-pulse` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 18 passed, 0 failed |
| `test:stale-workflow-run` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 9 passed, 0 failed |
| `test:seller-team-activity` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 13 passed, 0 failed |
| `test:mls-number-reminder` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 4 passed, 0 failed |
| `test:seller-weekly-report` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 17 passed, 0 failed |
| `test:marketing-channels` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 15 passed, 0 failed |
| `test:seller-journey-copy` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 16 passed, 0 failed |
| `test:transaction-stage-status` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 62 passed, 0 failed |
| `test:regional-closing-costs` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 40 passed, 0 failed |
| `test:prediction-accuracy` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 120 passed, 0 failed |
| `test:manager-deliberation` | unchained / satellite chain | none | yes | 0 | PASS (live layer skipped) | RESULT: 124 passed, 0 failed |
| `test:seller-closing-costs` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 44 passed, 0 failed |
| `test:accounting-scopes` | unchained / satellite chain | none | no | 1 | FAIL | ❌ accounting-scopes simulator: 85 passed, 1 failed |
| `test:vendor-scope-charging` | unchained / satellite chain | none | yes | 0 | PASS | ✅ vendor-scope-charging simulator: 62 passed, 0 failed |
| `test:accuracy-gate-telemetry` | unchained / satellite chain | none | no | 0 | PASS | ✅ accuracy-gate telemetry simulator: 30 passed, 0 failed |
| `test:territory-coverage` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 39 passed, 0 failed |
| `test:zoom-lane` | unchained / satellite chain | none | no | 1 | FAIL | ❌ zoom-lane simulator: 77 passed, 1 failed |
| `test:zoom-embed` | unchained / satellite chain | none | no | 0 | PASS | 48 passed, 0 failed |
| `test:territory-marketplace` | unchained / satellite chain | none | yes | 0 | PASS | Territory marketplace simulator: 35 passed, 0 failed |
| `test:meeting-followthrough` | unchained / satellite chain | none | yes | 0 | PASS | 64 passed, 0 failed |
| `test:meeting-recap` | unchained / satellite chain | none | yes | 0 | PASS | 53 passed, 0 failed |
| `test:launch-checklist` | unchained / satellite chain | none | yes | 0 | PASS | 28 passed, 0 failed |
| `test:onboarding-readiness` | unchained / satellite chain | none | yes | 0 | PASS | onboarding-readiness simulator: 149 passed, 0 failed |
| `test:dispatcher-load` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 6 passed, 0 failed |
| `test:vendor-w9` | unchained / satellite chain | none | yes | 0 | PASS | vendor-w9 simulator: 68 passed, 0 failed |
| `test:deal-room-demo` | unchained / satellite chain | none | yes | 0 | PASS | RESULT: 88 passed, 0 failed |
| `test:consent-recovery` | unchained / satellite chain | guard | - | 0 | PASS (live layer skipped) | RESULT: 9 passed, 0 failed |
| `test:channel-preference` | unchained / satellite chain | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 10 passed, 0 failed |
| `test:sequence-response-stop` | unchained / satellite chain | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 1 passed, 0 failed |
| `test:phone-scrub` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 24 passed, 0 failed |
| `test:ad-creative-consent` | unchained / satellite chain | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 6 passed, 0 failed |
| `test:manager-outbound-eval` | unchained / satellite chain | guard | - | 0 | PASS (live layer skipped) | RESULT: 7 passed, 0 failed |
| `test:governance-surfaces` | unchained / satellite chain | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 14 passed, 0 failed |
| `test:agent-governance` | unchained / satellite chain | guard | - | 0 | PASS (live layer skipped) | RESULT: 23 passed, 0 failed |
| `test:spend-governance` | unchained / satellite chain | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 21 passed, 0 failed |
| `test:direct-mail-channel` | unchained / satellite chain | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed |
| `test:lead-recipient` | unchained / satellite chain | guard:compliance | - | 0 | PASS (live layer skipped) | RESULT: 0 passed, 0 failed |
| `test:manager-ownership` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 73 passed, 0 failed |
| `test:signal-integrity` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 6 passed, 0 failed |
| `test:event-flow` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 1 passed, 0 failed |
| `test:back-on-market-promo` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 33 passed, 0 failed |
| `test:data-guard` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 20 passed, 0 failed |
| `test:data-guard-guard` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 11 passed, 0 failed |
| `test:egress-send-guard` | unchained / satellite chain | guard | - | 0 | PASS | RESULT: 41 passed, 0 failed |
| `test:webhook-contract` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | RESULT: 240 passed, 0 failed |
| `test:outbound-call-gates` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | OUTBOUND CALL GATES — 58 passed, 0 failed |
| `test:ai-gateway-lane` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | PASSED |
| `test:custom-domain-flow` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | 116 passed, 0 failed RESULT: custom-domain-flow PASS |
| `test:ui-delivery` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | UI DELIVERY — 29 passed, 0 failed |
| `test:credential-migration` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | RESULT: PASS — 54 passed, 0 failed |
| `test:domain-api` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | RESULT: PASS 63/63 |
| `test:provider-adapter` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | RESULT: 160 passed, 0 failed |
| `test:integration-status` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | RESULT: 30 passed, 0 failed |
| `test:env-var-parity` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | ✅ ENV_VAR_PARITY_PASS — every environment read in every runtime root has a documented source |
| `test:tenant-entitlements` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS (live layer skipped) | RESULT: 32 passed, 0 failed |
| `test:tier-entitlement` | G23 provider / webhook / entitlement con | guard | - | 0 | PASS | RESULT: 49 passed, 0 failed |

## Tier 2 — existing safe integrations, no spend

Run only where the credential already exists in the environment. None did, so every row is NOT RUN. A row that is later run must quote the credential NAMES found present, the command, the date and the commit.

| Test | Credential names | Command when present | Status here |
|---|---|---|---|
| NR-03 Live schema drift | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `npx tsx scripts/check-live-schema-drift.ts` | NOT RUN |
| NR-04 Migration ledger against the live database | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `npx tsx scripts/migration-ledger-guard.ts` | NOT RUN |
| NR-05 Live RLS policy census | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `npm run test:child-tenant-scope` | NOT RUN |
| NR-06 Browser UI smoke, desktop and phone | `UI_SMOKE_BASE_URL` | `UI_SMOKE_BASE_URL=<deployed url> npx playwright test --grep @smoke` | NOT RUN |
| NR-07 Authenticated offer-to-transaction browser flow | `E2E_AUTH_STATE`, `E2E_BASE_URL` | `E2E_AUTH_STATE=e2e/.auth/agent.json npx playwright test offer-to-transaction` | NOT RUN |
| NR-08 AI gateway live call | `AI_GATEWAY_API_KEY` | `npx tsx scripts/vision-gateway-smoke.ts` | NOT RUN |
| NR-09 Stripe test-mode webhook round trip | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_VENDOR_WEBHOOK_SECRET` | the Stripe CLI against a preview deployment, test mode only | NOT RUN |
| NR-10 Email provider test send | `SENDGRID_API_KEY` | a provider sandbox-mode send through the existing dispatch rail | NOT RUN |
| NR-11 Inbound email webhook | `SENDGRID_INBOUND_WEBHOOK_VERIFY_KEY` | a signed inbound-parse post to a preview deployment | NOT RUN |
| NR-12 Provider contract and health (Versium, RentCast, BatchData) | `VERSIUM_API_KEY`, `RENTCAST_API_KEY`, `BATCHDATA_API_KEY` | one documented-schema call per provider through `routeCapability`, budget-capped | NOT RUN |
| NR-13 Remotion frame render | none; needs an egress path the browser trusts | `npx remotion still remotion/index.ts <id> out.png` with a trusted browser | NOT RUN |
| NR-14 QuickBooks sandbox | `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | the OAuth connect flow against the Intuit sandbox company | NOT RUN |

## Tier 3 — owner configuration later

| Test | Owner action | Dependency | Status here |
|---|---|---|---|
| NR-15 Real e-signature | connect the DocuSign (default) or Dotloop account | `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_WEBHOOK_SECRET`, `DOTLOOP_API_KEY` | NOT RUN |
| NR-16 Real SMS and voice | provision a number and complete A2P | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | NOT RUN |
| NR-17 Real title delivery of a CDA | a real title contact and a sending domain | `SENDGRID_API_KEY` | NOT RUN |
| NR-18 YouTube publish | authorize the channel | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | NOT RUN |
| NR-19 Live Stripe payment and renewal | create the products and prices (owner not ready) | `STRIPE_SECRET_KEY` | NOT RUN |
| NR-20 Live Vercel environment, domain and SSL | set the production environment, point DNS | `CRON_SECRET`, `NEXT_PUBLIC_SUPABASE_URL` | NOT RUN |
| NR-21 Production smoke drill | owner-authorized run against the real database | `SUPABASE_SERVICE_ROLE_KEY` | NOT RUN |
| NR-22 Avatar video and voice generation | enable the providers and a budget | `DID_API_KEY`, `ELEVENLABS_API_KEY` | NOT RUN |

## Not-performed register

NAME, DEPENDENCY, TESTED INSTEAD, FUTURE VALIDATION, RISK. Nothing here is a skipped check disguised as a pass.

| Name | Dependency | Tested instead | Future validation | Risk |
|---|---|---|---|---|
| NR-01 Whole-project type-check | a machine with a heap of 10 GB or more used by nothing else (CLAUDE.md §7); the integrator runs it | a scoped compile of this lane's one new file | `NODE_OPTIONS="--max-old-space-size=10000" npm run type-check` after integration | LOW for this lane (one new script); MEDIUM for the wave |
| NR-02 Full guard chain | an exclusive machine and about 16 minutes; the integrator runs it | each chained proof the run record names, one at a time; the run summary states how many of the guard chain's distinct steps this lane did not run | `NODE_OPTIONS="--max-old-space-size=10000" npm run guard`, then grep GUARD_EXIT from the log | MEDIUM: ordering effects between steps and every step this lane did not run are untested |
| NR-03 Live schema drift | `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` | `test:schema-drift` and `test:schema-cache-drift` against the committed snapshot | the nightly `e2e` workflow once the repository secrets exist, or a read-only live schema read by the integrator | MEDIUM: DDL applied to the live database since the snapshot (for example the m739, m771 and m795 owner SQL and any wave-143 migration) is invisible |
| NR-04 Migration ledger against the live database | `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` | `test:migration-claim` (each unapplied file carries a WRITTEN, NOT APPLIED header) | `npx tsx scripts/migration-ledger-guard.ts` with credentials; it exits 0 with a skip message otherwise | MEDIUM: a file in `supabase/migrations/` that was never applied reads as done |
| NR-05 Live RLS policy census | `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` | `test:rls-public-grant`, `test:rls-anon-escape`, `test:secrets-rls`, `test:tenant-scope` (source and migration text) | `npm run test:child-tenant-scope` with credentials (reads `pg_policies`) | MEDIUM: a permissive policy on a child table is visible only in the live catalog |
| NR-06 Browser UI smoke, desktop and phone | a reachable application instance: `UI_SMOKE_BASE_URL`, or a local server with Supabase configured. Playwright browsers ARE preinstalled in this sandbox | `npx playwright test --list` (12 tests compile) plus the static census proofs | Actions, then e2e, then Run workflow with `ui_smoke_base_url` | MEDIUM: rendering, hydration and viewport behaviour are unobserved |
| NR-07 Authenticated offer-to-transaction browser flow | a seeded test agent session in `E2E_AUTH_STATE` and a running app | the `offer-lifecycle` canary and `test:offer-auto-execute` (in memory) | `E2E_AUTH_STATE=e2e/.auth/agent.json npx playwright test offer-to-transaction` | MEDIUM |
| NR-08 AI gateway live call | `AI_GATEWAY_API_KEY` and a few cents of spend authorized | `test:ai-gateway-lane`, `test:ai-routing-coverage`, `test:ai-spend-booked` (static and fake client) | `npx tsx scripts/vision-gateway-smoke.ts` once, then a metered text call | MEDIUM: model-id or gateway request-shape drift is invisible |
| NR-09 Stripe test-mode webhook round trip | `STRIPE_SECRET_KEY` (test mode), `STRIPE_WEBHOOK_SECRET`, `STRIPE_VENDOR_WEBHOOK_SECRET`, and an owner decision to create any test-mode object (the owner has not set prices) | `test:billing-convergence` layer 4 (replay on an in-memory ledger) and `test:stripe-webhook-events` | Stripe CLI `stripe trigger` against a preview deployment in test mode, replaying one event id twice | MEDIUM: real signature verification and payload shape are unobserved |
| NR-10 Email provider test send | `SENDGRID_API_KEY` and a verified sender | the dispatch gates (`test:autonomy-gate`, `test:outbound-call-gates`, `test:channel-preference`) | a sandbox-mode send through `lib/providers/dispatch.ts` | MEDIUM |
| NR-11 Inbound email webhook | `SENDGRID_INBOUND_WEBHOOK_VERIFY_KEY` and an inbound-parse route configured in the provider console | `test:offer-email-intake` and `test:inbound-intent` on fixture messages; `test:webhook-contract` for the signature census | a signed inbound-parse post to a preview deployment, replayed twice for idempotency | HIGH: the outside-offer loop is triggered by real inbound mail, which has never been received here |
| NR-12 Provider contract and health (Versium, RentCast, BatchData) | `VERSIUM_API_KEY`, `RENTCAST_API_KEY`, `BATCHDATA_API_KEY` and a per-call budget | `test:provider-cost-routing`, `test:connector-gateway`, `test:enrichment-one-rail` (route table and fakes) | one documented-schema call per provider through `routeCapability`, budget-capped | MEDIUM: documented-versus-actual response drift is unobserved |
| NR-13 Remotion frame render | a trusted egress path for `fonts.gstatic.com` (the sandbox proxy CA is rejected by the headless shell; the only workaround disables TLS verification and was not used) | `remotion bundle` of the whole tree (exit 0), `test:render`, `test:remotion-setup`, `test:video-pipeline-truth` | `npx remotion still` on a network where the font host is trusted, then a playability probe on an MP4 | MEDIUM: a real frame, encode and playback are unobserved |
| NR-14 QuickBooks sandbox | `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` and an Intuit sandbox company | `test:accounting-scopes` (source and fakes; see Findings F1) | the OAuth connect flow in the Intuit sandbox | MEDIUM |
| NR-15 Real e-signature | `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_WEBHOOK_SECRET` or `DOTLOOP_API_KEY` and a tenant account | `test:esign-execution-loop`, `test:esign-default-rule`, `test:form-wizard-esign`, `test:cda-esign` (provider-agnostic, events simulated) | a demo-account envelope completed end to end, signature evidence retrieved | HIGH: completion events and evidence formats are simulated only |
| NR-16 Real SMS and voice | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, a number and A2P approval | the outbound consent, quiet-hours and TCPA gates (`test:outbound-call-gates`) | a message to an owner-controlled number | HIGH |
| NR-17 Real title delivery of a CDA | a real title contact and a sending domain | `test:cda-delivery`, `test:cda-delivery-reaper` | one CDA delivered to an owner-controlled address | HIGH |
| NR-18 YouTube publish | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and channel authorization | `test:video-pipeline-truth`, `test:social-approval` | a private upload with an explicit privacy status | MEDIUM |
| NR-19 Live Stripe payment and renewal | `STRIPE_SECRET_KEY` (live), products and prices (the owner has not set them) | `test:billing-convergence`, `test:plan-catalog`, `test:billing-access` | a first payment and a renewal on a real subscription | HIGH |
| NR-20 Live Vercel environment, domain and SSL | the production environment, DNS and certificate | `test:tenant-baseline`, `test:custom-domain-flow`, `test:production-readiness` | the activation checklist (lane 143H) with its verification commands | HIGH |
| NR-21 Production smoke drill | an owner-authorized run: it writes a synthetic tenant to the real database and cleans it up | `test:tenant-provisioning-loops`, `test:tenant-creation` (in memory) | `npm run test:production-smoke` after the owner authorizes it | MEDIUM |
| NR-22 Avatar video and voice generation | `DID_API_KEY`, `ELEVENLABS_API_KEY` and a budget | `test:avatar-loop`, `test:did-live-agent`, `test:video-pipeline-reaper` | one metered generation, then a playability probe | MEDIUM |

## Wave 144 owner-ruling canaries

Lane 144J (wave 144). Fourteen IN-MEMORY canaries on the existing harness (`scripts/canaries/_harness.ts`, `_registry.ts`, `run-canaries.ts`), run by `scripts/wave144-canaries.ts` (`CANARY_WAVE=144`; the default roster `test:canaries` is unchanged). Each step that encodes an owner ruling names its owner and is NEVER pending: false is RED. The runner prints a verdict table (green / red-awaiting-lane-X / red-defect). Mode: IN-MEMORY (STATIC for the source-rule steps); no live payment, outreach, provider call or publication.

"Integrated" = 967a4866 + the published patches of lanes 144A, 144B, 144C, 144D, 144E, 144G, 144H and 144I applied together in the lane-144J worktree and reverted after the run (144F had published notes, no patch). Totals: HEAD 115 ruling steps — 60 green, 51 red-awaiting-lane, 4 red-defect; integrated — 96 green, 15 red-awaiting-lane, 4 red-defect.

| Canary | File | Rulings | HEAD verdict at 967a4866 | Integrated |
|---|---|---|---|---|
| seller journey (+ the verified-closing tail) | `scripts/canaries/seller-journey.ts`, `scripts/canaries/_verified-closing.ts` | 19, 13 | red-awaiting-lane-144B×6, 144I×1, red-defect×2 | red-defect×2 (activateComingSoon ungated; the coming-soon policy is not read at the door) |
| taxonomy | `scripts/canaries/taxonomy.ts` | 1, 17 | red-awaiting-lane-144A×5, 144C×1, red-defect×1 | 144A×1 (A + I interaction: the vocabulary approval door passes no approver role and 144I's proposal kernel now requires one), 144C×1 (literal financing picker), red-defect×1 (preference patterns). With 144A alone: 9/11 |
| buyer journey | `scripts/canaries/buyer-journey.ts` | 19 | red-defect×1 | red-defect×1 (BBA not bound at the offer write) |
| counter | `scripts/canaries/counter-offer.ts` | 2 | red-awaiting-lane-144C×2 | 144C×1 (the accepted counter's own unsigned paper does not block when the checklist omits counters) |
| forms | `scripts/canaries/form-packets.ts` | 3 | red-awaiting-lane-144C×2 | green (driven through 144C's brokerage / team library, m853) |
| concessions | `scripts/canaries/concessions.ts` | 4 | red-awaiting-lane-144D×4 | green |
| financials | `scripts/canaries/financials.ts`, `scripts/canaries/_commission-deal.ts` | 5–9 | red-awaiting-lane-144D×6 | green |
| Versium | `scripts/canaries/versium.ts` | 10 | red-awaiting-lane-144E×3 | 144E×1 (the research-only home for protected fields is an owner decision per 144E) |
| channels | `scripts/canaries/channels.ts` | 11, 12 | red-awaiting-lane-144F×4 | 144F×4 (no patch) |
| first touch | `scripts/canaries/first-touch.ts` | 13 | red-awaiting-lane-144F×2 | 144F×2 (no patch) |
| AI journeys | `scripts/canaries/ai-journeys.ts` | 11, 12, 18 | red-awaiting-lane-144F×3 | 144F×3 (no patch) |
| local intelligence | `scripts/canaries/local-intel.ts` | 14 | red-awaiting-lane-144G×4 | 144G×1 (the proposal-awaits-approval half is not wired) |
| publishing | `scripts/canaries/publishing.ts` | 15, 16, 18 | red-awaiting-lane-144H×5 | 144H×1 (no logo / colours in the lead-magnet book's rendered data) |
| graph | `scripts/canaries/graph.ts` | 18, laws 2 + 5 | red-awaiting-lane-144I×2, 144D×1 | green |
| lifetime (default roster, `test:canaries`) | `scripts/canaries/lifetime.ts` | 13 | green-after-seed (14/14): the deal is seeded to pass the integrated close gate (contract_date, compliance_passed_at, no CDA required, closing compliance clean) and the closing agent is signed in (`setSessionUser`), so the real gate runs | green-after-seed (14/14) |
| form wizard SOURCE (a) (default roster, `test:canaries`) | `scripts/canaries/form-wizard.ts` | 3 | red at 967a4866 alone (the step now asserts owner ruling 3, which 144C delivers): `test:canaries` 33/34 | green: `test:canaries` 34/34 — the step and 144C must land together |

A capability with no survivor at HEAD is probed on STRIPPED source (`findLanded` in `scripts/canaries/_registry.ts`, positive + negative control in the graph canary); a landed file is evidence, never a pass — the step stays red until its behavioural assertion is wired at its `WAVE144 WIRE (integrator)` line. Where a lane's module has landed with a published contract (144A, 144C, 144D, 144E, 144G, 144H), the canary drives it through `landedModule` (`scripts/canaries/_harness.ts`): only a missing FILE reads as "not landed", and a file that fails to load throws. So the same step is red at the base commit and green on the landed behaviour, with no edit in between. The full per-step table and the counts are in the lane-144J notes.

## Wave 145 owner-ruling canaries

Lane 145J (wave 145). Eight IN-MEMORY canaries, one per area of the "Required proofs" list, on the SAME harness (`scripts/canaries/_harness.ts`, `_registry.ts` — `canary()`, `canaryClient`, `cleanupCanary`, `landedModule`, `rulingVerdict`, `findLanded`), run by `scripts/wave145-canaries.ts` (the wave-144 runner's selection, verdict table and RESULT line; roster `WAVE145_CANARY_KEYS` in `scripts/canaries/wave145-harness.ts`). Every step asserts an owner RULING of 2026-10-27 or a cross-lane CONTRACT (C1–C7) by its spec name — never a lane's internal shape. A ruling step is never pending: false is red-awaiting-lane-145X (the lane whose brief carries it) or red-defect; a step that waits on an OWNER decision is pending-owner (counted apart, never a pass, never a failure). A contract binds by FILE + exported NAMES (`bindContract`): absent file = red-awaiting with the contract named; a file that fails to load = red; landed = the canary drives it. Mode: IN-MEMORY (STATIC for the source-rule steps); no live payment, outreach, provider call or publication.

| Canary | File | Rulings / contracts | HEAD verdict at b364eb4b | Integrated (lanes 145A–I patches applied) |
|---|---|---|---|---|
| security | `scripts/canaries/wave145-security.ts` | 23, 24 · §4 | red-awaiting-lane-145A×6, 145I×1, pending-owner×1 | green, pending-owner×2 (the live storage.objects policies — owner SQL editor, release-blocking; Step 0 authorization of the safety batch) |
| listings | `scripts/canaries/wave145-listings.ts` | 1, 2 · C7 | red-awaiting-lane-145B×5, integrator×1 | red-awaiting-lane-integrator×1 (the MLS live-date kernel event — 145B / 145I Outside-lane) |
| financial onboarding | `scripts/canaries/wave145-financial.ts`, `scripts/canaries/_commission-deal.ts` | 3–9 · C6, C7 | red-awaiting-lane-145C×10 | green, pending-owner×1 (m858–m861 applied) |
| providers / channels | `scripts/canaries/wave145-providers.ts` | 13 · C1, C5 | red-awaiting-lane-145D×9, 145E×1 | red-awaiting-lane-145D×1 (email outcomes are ledgered but never claimed), pending-owner×1 (m862) |
| lead / contact | `scripts/canaries/wave145-lead-contact.ts` | 15, 16, 17 · C2, C3 | red-awaiting-lane-145E×7, 145H×1 | green |
| signals | `scripts/canaries/wave145-signals.ts` | 11, 12, 14 · C2 | red-awaiting-lane-145F×7, pending-owner×1 | green, pending-owner×1 (who reads the research store) |
| marketing | `scripts/canaries/wave145-marketing.ts` | 19, 20, 22, 13/22 · C4, C5 | red-awaiting-lane-145G×7 | green |
| compliance / UX | `scripts/canaries/wave145-compliance-ux.ts` | 18, 21, §6 · C3 | red-awaiting-lane-145H×7, 145E×1, pending-owner×1 | red-awaiting-lane-145E×1 (`ageGroupChannelAffinity`, routed by 145H), pending-owner×2 (m869; state preset citations) |

Totals at b364eb4b: 83 ruling steps — 17 green, 63 red-awaiting-lane, 0 red-defect, 3 pending-owner (` RESULT: canaries 8, passed 0, failed 8; steps 19/82; hooks pending 0; pending owner decision 3; rows deleted 68`). Integrated, with all nine lane patches applied together: 89 ruling steps — 79 green, 3 red-awaiting-lane, 0 red-defect, 7 pending-owner (` RESULT: canaries 8, passed 5, failed 3; steps 81/84; hooks pending 0; pending owner decision 7; rows deleted 68`). The integrated run has more steps because a pending-owner step for a migration, and the per-lane new-table census, appear only once that lane's migration exists. The per-step table is in the lane-145J notes.

## Pending proofs

Wave-143 lanes that are still building a proof. Recorded, not run. Each lands as `scripts/<name>.ts`; when the file exists, run it and add its rows here.

| Lane | Proof | Covers | Status at 21da8e4e |
|---|---|---|---|
| 143A | `scripts/outside-offer-loop-guard.ts` | MLS live date, outside-offer loop, email matching, contract precedence, the `fully_executed` vocabulary | pending 143A |
| 143B | `scripts/closing-compliance-guard.ts` | brokerage required documents, closing compliance, state closing participants, FormWizard sources | pending 143B |
| 143C | `scripts/agreement-waterfall-guard.ts` | effective-dated agreements, the deterministic waterfall, HUD/CD corrections | pending 143C |
| 143D | `scripts/versium-capability-matrix-guard.ts` | Versium capability map, scanner type-first, enrichment triggering | pending 143D |
| 143E | `scripts/intent-driven-followup-guard.ts` | intent-driven follow-up, review request at verified closing | pending 143E |
| 143F | `scripts/public-media-scope-guard.ts` | fair-housing scope negative guard, podcasts, book export, lead magnets, Remotion root cause | pending 143F |
| 143J | `scripts/feature-certification-guard.ts` | advertised-feature certification, dead controls | pending 143J |
| 144J | `scripts/wave144-canaries.ts` (`test:wave144-canaries`, key to register) | the fourteen wave-144 owner-ruling canaries (section "Wave 144 owner-ruling canaries") | written; package.json key + chain membership are the integrator's |
| 145J | `scripts/wave145-canaries.ts` (`test:wave145-canaries`, key to register) | the eight wave-145 owner-ruling canaries (section "Wave 145 owner-ruling canaries") | written; package.json key is the integrator's — NOT in the guard chain until the verdict table reads green |

## Credential-gated proofs

These exit 0 with a skip message when the named credentials are absent. In `npm run guard` output a skip is indistinguishable from a pass unless the line is read, so they are listed here. The list is SOUND (the guard proves each entry reads the environment and has a skip path) but not proven complete: the 146 runs marked PASS (live layer skipped) in the run record are a second, broader class — proofs whose pure layers passed and whose database layer did not run.

| Proof | Gate | Meaning of exit 0 here |
|---|---|---|
| `test:migration-ledger` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | skipped: nothing was compared with the live ledger |
| `test:child-tenant-scope` | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | skipped: `pg_policies` was not read |
| `test:client-message` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | skipped: the whole flow is database-driven, so it asserted nothing |
| `scripts/check-live-schema-drift.ts` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | skipped: the committed snapshot was not compared with live DDL |
| `scripts/vision-gateway-smoke.ts` | `AI_GATEWAY_API_KEY` | skipped: no gateway call was made |

## Findings

F1. **Two registered proofs that no CI runner reaches are failing, and the code is right.** `test:accounting-scopes` (85 passed, 1 failed) and `test:zoom-lane` (77 passed, 1 failed) both assert `connectionScopeForUserType("superadmin").scope === "platform"`. Since 2026-09-02 that function answers `agent` for the legacy `user_type='superadmin'` and `platform` only for the live identity (`user_type='admin'`, `platform_role='superadmin'`), which is what CLAUDE.md §4 requires (it fails closed). The proofs pin the retired spelling. With the assertion corrected to `("admin", "superadmin")` plus a fail-closed control, both pass (86 and 78). Neither file is in this lane's domain, so the correction is shipped as a separate optional patch (see the lane notes), not applied.

F2. **The CI simulator sweep cannot see a proof whose command carries a flag.** 210 of the 1028 registered proofs are in no chain. `test:sweep` (a step of `guard`) is meant to run them all, and it does reach 202 of the 207 this lane ran, but its target filter (`scripts/simulator-sweep.ts`, the `.test(pkg.scripts[s] ...)` regex) requires the command to read `tsx scripts/<file>.ts`, so a command written `tsx --conditions=react-server scripts/<file>.ts` is silently outside it. Four unchained proofs have that shape — `test:accounting-scopes`, `test:accuracy-gate-telemetry`, `test:zoom-lane`, `test:zoom-embed` — and no CI runner reaches them. Two of the four are the failing ones in F1: they rotted in the dark exactly as the sweep's own header describes. Of the 207 chainless proofs this lane ran, 204 passed (80 with a skipped live layer), 2 fail (F1) and 1 is SKIPPED. `test:e2e` and `test:e2e:ui` (a browser and a running app) were not run; `test:e2e-flows` is run directly by the nightly `e2e` workflow, not by `guard`. The fix is a one-line widening of the sweep filter, which must land together with the F1 assertion fix or `guard` turns red (see the lane notes, Outside-lane). Measured with that optional patch applied: `npm run test:sweep` reached 215 proofs (211 before) and reported `RESULT: 214 passed, 1 failed (299s)`; the four newly reached proofs passed and the one failure was `test:dispatcher-load` TIMEOUT after the sweep's 120 s limit, on a shared 4-CPU sandbox at a load average near 17 (the same proof passed alone in 52 s) — an environment timeout, not evidence of a code defect.

F3. **No evidence that the live layers have ever run in CI.** 146 of this lane's 439 runs passed with the database layer skipped. The only scheduled workflow, the nightly `e2e`, runs on the default branch `main` (f18bce18, 2026-07-21 — 1535 commits behind this work, so it cannot evidence it). Its run 39779867978 (2026-10-22, conclusion success) printed 35 live-layer skip lines, one of them `live-schema drift check skipped (no Supabase credentials in this environment)`, so the repository secrets named in `e2e.yml` were not available to that run: a green nightly is a skip. The per-push `guards` workflow supplies no database credentials by design. WAITING_EXTERNAL: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` as repository secrets.

F4. **A skip reads as a pass.** `test:migration-ledger`, `test:child-tenant-scope` and `test:client-message` exit 0 having asserted nothing. The Reproduce section's runner classifies them SKIPPED from the output.

F5. **A failed Google Fonts fetch took down the whole Remotion composition listing.** `remotion/ProductPromoReel.tsx:36` calls `loadFont(...)` at module scope and `remotion/Root.tsx` imports that file, so the font request is made when the root is evaluated, for every composition, not only for that reel. Measured here: `remotion compositions` against the local bundle exited 1 in 4 s with `net::ERR_CERT_AUTHORITY_INVALID` on the `fonts.gstatic.com` URL and `NetworkError: A network error occurred.`; no composition was listed. Not tested: whether the failure comes from the unhandled rejection or from a `delayRender` handle, and whether a self-hosted font would avoid it — lane 143F owns the investigation (it already owns the render-failure census, `lib/remotion/render-failure-census.ts`).

F6. **Playwright is ready and has no target.** Browsers are preinstalled (`PLAYWRIGHT_BROWSERS_PATH`), 12 tests compile across the `chromium` and `mobile-chromium` projects, and no application instance exists to point them at.

## Blind spots

1. Results are point-in-time at 21da8e4e. A later commit can change any of them; the guard checks that the document names real proofs, not that the readings are current.
2. This lane ran 439 proofs; the guard chain holds 811 distinct steps, of which this lane ran 222. The other 589 were not run here (NR-02). A proof outside both sets was not looked at.
3. PASS (live layer skipped) is detected by a pattern over each proof's output (a skip line naming Supabase or credentials). A proof that skips silently, or one that mentions skipping for another reason, can be classified wrongly in either direction.
4. Mode is the author's classification of what each proof's code reaches. The sandbox had no provider or database credentials, so no Tier 1 result can have reached one, but the document does not prove a proof cannot reach the network.
5. Assertion counts (the run summary) add the `N passed` figure from each proof's own result line; proofs with a different output format contribute zero. They are a size indicator, not a coverage measure.
6. Nothing here measures whether a proof's assertions are the right ones. A proof that pins a retired spelling passes or fails on the spelling (F1).
7. The GitHub run evidence in F3 is metadata read from one workflow run; secrets may have been added since.
8. The Playwright listing proves the specs compile and are discovered, not that they pass.
9. "Via sweep" is derived by applying the sweep's own filter (read from `scripts/simulator-sweep.ts`) to each command, not by executing the sweep. A run of `npm run test:sweep` is the authority.

## Reproduce

One proof at a time, heap capped, skip-aware. The runner writes one log per proof and classifies by exit code first; a zero exit that prints only a skip line is SKIPPED.

```bash
# one proof
NODE_OPTIONS=--max-old-space-size=6000 npm run test:schema-drift

# a list of proofs, sequentially, with the exit code and the proof's own verdict line
while IFS= read -r key; do
  NODE_OPTIONS=--max-old-space-size=6000 timeout 900 npm run "$key" > "logs/${key//:/_}.log" 2>&1
  echo "$key exit=$?"
done < runlist.txt

# find proofs that exited 0 but only skipped
grep -l -E "skipped \(no [^)]*credentials|SKIPPED —" logs/*.log

# the canaries (in memory, 34 business chains)
NODE_OPTIONS=--max-old-space-size=6000 npm run test:canaries

# Playwright discovery (no browser launched)
npx playwright test --list
```

The whole chain is `NODE_OPTIONS="--max-old-space-size=10000" npm run guard`; read `GUARD_EXIT` from the log, never the prose.
