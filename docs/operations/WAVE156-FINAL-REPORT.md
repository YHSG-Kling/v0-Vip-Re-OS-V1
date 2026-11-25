# Wave 156 — final report

Written by the wave integrator on 2026-11-25. This is the wave's hand-off: the eight mandatory artifacts of the directive, in its order, plus the truth ledger and the cross-lane canaries. Sections 4, 5 and 6 summarize documents that live in their own files; those files are the artifacts.

**Verdict: ENGINEERING READY — OWNER ACTIONS REMAIN** (section 8).

In one paragraph: seventeen lanes built or corrected the things the owner named — the signed-agreement review before any deal exists, the full forms directory, closing attorneys, honest visitor analytics, provider spend control, calculators as lead magnets, the fraud warning network, recruiting integrity, the arbiter's decision record, payout reconciliation and the release-state board. Twelve additive migrations are applied and read back. Thirty cross-lane canaries pass on the integrated tree and twenty-six of them fail on the pre-wave tree. Nothing was deployed, purchased, sent or run as privileged SQL; what stands between this code and a first preview is the owner's sheet (section 6).

## 1. Change ledger

| | |
|---|---|
| Repository / branch | `YHSG-Kling/v0-Vip-Re-OS-V1` · `claude/settings-consolidation-ui-0cd7lo` · pull request #49 |
| Starting commit | `e79a13b8` — local and remote were the same commit when the wave began |
| Integration commit this report was written against | `3e556a92` (230 commits after the start; 496 files changed, 32,472 insertions, 4,767 deletions) |
| Head that carries this report | the commit after it; the pull request records the pushed head and its CI runs |
| Worktrees | one integration worktree and eighteen lane worktrees, all local to the build container; every lane branch is merged; nothing else holds unmerged work |
| Unpushed commits | at the time of writing, all of them: the standing rule pushes only after the chain's own exit line reads 0, and then pushes the whole wave at once. Until that push every commit exists only in the container — see "rebuild losses" |
| Rebuild losses | none: the container was not rebuilt during the wave. The deal-desk commits that preceded the wave are in `e79a13b8`, which was the remote head, with CI green, when the wave began. A rebuild before the push would have lost the whole wave; a work-in-progress branch is an owner decision (section 12) |
| Guard chain | 1,010 steps before the wave, 1,027 after: 17 new `test:wave156-*` steps. An all-steps run on the integrated tree found 11 red steps of 1,027; each was closed at its source (table below) and re-run. The run that gates the push is the real chain on the head commit |
| Type-check | both programs, 0 errors (whole project, one program after the other, during integration and again as the first step of the all-steps run; the real chain repeats it on the head) |
| Import budget | proxy 23 of 40 · heaviest page 1,272 of 1,300 · union 5,250 of 5,300 — ceilings unchanged |
| CI | recorded on the pull request; not knowable from inside the commit that carries this file |

### Migrations

All twelve are additive (new tables, nullable columns, new indexes, checks on new columns or a widened vocabulary). Each was applied to project `hrvaqgvukzxfskkcrwbt` through the Supabase MCP on 2026-11-25 with a before read and an after read, and each file's header says so. No migration of this wave is written and unapplied.

| Migration | Adds |
|---|---|
| m1001 | Unique index: one live transaction per executed offer per tenant |
| m1003 | `transactions.governing_terms_proposals` (extracted terms waiting for a person) |
| m1005 | Form library: provenance, checksum, office and agent scope, provider reference, replacement and retirement |
| m1006 | `form_packet_bundles`, `form_packet_bundle_items` (row security on, three policies each) |
| m1010 | Closing parties: counsel roles, whom each represents, settlement agent and basis, closing checks, document responsibility |
| m1011 | `vendor_assignments.assignment_type` admits `attorney` |
| m1012 | Three single-column closing-check constraints in place of one combined constraint |
| m1019 | `platform_settings.provider_request_caps` |
| m1030 | `movement_signals.stated_destination_*` (what the person typed, structured) |
| m1035 | Nine `fraud_*` tables, row security on all, one read policy (published warnings only) |
| m1036 | `fraud_bulletins.name_review_hold`, `name_review_clearance` |
| m1066 | `content_sha256` on both acceptance tables |

The schema snapshot, foreign-key map, check-vocabulary cache and live-table list were regenerated from live reads after the last application (819 relations).

**Held for the owner (not run):** everything in `docs/operations/OWNER-SQL.md`, including this wave's section S (approval rows append-only; form-library scope; training-progress and recruits policies; the fraud evidence bucket; §R.6 status).

### What integration changed beyond merging

- Fixed a fail-open the merge exposed: the fraud network's metrics read treated a blank tenant id as "every tenant". It now states its scope through `lib/kernel/tenant-scope.ts` and refuses a blank id.
- Classified the private fraud case as evidence that stays with the tenant that filed it when a listing or deal moves (`lib/kernel/brokerage-transfer.ts`).
- Registered every lane's guard key, chain step, maintenance domain and table steward — to existing managers only (13 managers before, 13 after).
- Guard assertions that were pinned to a waypoint (a migration "written, not applied"; "adds exactly one value") or to a shape this wave retired were restated as the rule they meant; each is named in its lane's section of the code proofs. No ceiling was raised and no guard rule was loosened to pass.
- Kept one retired function alive on purpose: `trackExternalActivity` was restored after a lane deleted it without a survivor, and is held as an owner question. Recording it cost one entry in each of three ledgers (the wired-surface baseline, the orphan-export baseline and the parent-child known findings). The export ledger itself went from 1,372 to 1,411 unreferenced exports; none is referenced nowhere (0 before, 0 after). The growth is in-file helpers of new modules that their guards also drive directly, which the guard classes as live code. 46 exports that only their own file used lost the export keyword instead of being admitted (41 at integration, 5 by their lanes). Six functions were retired, each with a named survivor (`estimateMovingCosts`, `calculateAffordability`, `calculateRentVsBuy`, `estimateMonthlyPayment`, `computeNetSheetScenario`, `getRentcastComps`); three moved to another module. The conditional-tenant-predicate allowance shrank by two, and the action-evidence baseline lost the one entry that moved.

### What the all-steps run found, and how each was closed

Before the real chain, every one of the 1,027 steps was run on the integrated commit `1f11e001` without stopping at the first failure: 1,016 green, 11 red. None was closed by a baseline, an exemption or a weaker rule.

| Red step | What it found | How it was closed |
|---|---|---|
| proof-ownership | The seams proof had no accountable manager | Registered under the Compliance Officer with the Deal Coordinator |
| tenant-scope | A fraud metrics read whose tenant filter sat in a wrapper the guard could not see | The scope is stated at each query |
| no-dead-components | A three-line re-export file whose only importer now names the real component | Deleted, with a tombstone naming the survivor |
| readerless-writes | Fifteen audit columns the fraud network wrote and nothing read | Readers built: the staff history and each seat's read state |
| opposite-missing | The same columns, the terms-acceptance fingerprint, and constants nobody imported | Readers built (the acceptance check now compares the fingerprint); constants used in one file lost their export keyword |
| orphan-exports | New exports nothing else names; one retired function | See the export-ledger line above |
| rentcast-eligibility, batchdata-mcp | Two text checks still anchored on the vendor call that moved into the capability | Restated as the rule they meant, with new negative controls; the restated check found three RentCast readers the old hand-typed list had never covered (all three pass) |
| route-response-fields | A voice route returned a budget refusal no caller read | All three callers show the refusal to the person |
| manager-cross-cooperation | Three new registry rows listed co-owners their text did not name | The text names them |
| listing-archive | The fraud case's link to a listing was not in the archive ledger | Added: kept and detached (the case is the reporting tenant's evidence) |

## 2. Owner corrections report

Each correction the owner gave, what the code did before, what it does now, and the proof. "Driven" means the guard calls the real exported product code against an in-memory database with counted stand-ins for every model, provider, payment and e-sign call. None of it is evidence of a deployment.

| # | Owner correction | Before (measured on the pre-wave tree) | Now | Proof |
|---|---|---|---|---|
| 1 | After the fully signed listing agreement is in, the compliance gate comes before a transaction is created | A fully signed flag alone advanced a listing; an executed offer could create a deal with no comparison of terms, and a replayed e-sign delivery could create two | One typed decision (allow / hold / refuse / needs review) compares the executed document with the record. A hold names the form and the term and links the document. A person with closing-approval authority approves the packet before the listing moves or exactly one transaction is created (unique index m1001) | `test:wave156-b-representation-gate`; canaries C01, C02, C03 (all three red on the pre-wave tree) |
| 2 | The forms and packet tool lists every possible form or packet, and the user or a manager can add more | The provider tab stopped at 100 forms | The directory walks the whole provider library with a cursor and a total, and says so when a provider cannot be paged. Staff add a form or packet by upload, state-package pick or provider reference, scoped to the brokerage, an office, a team or one agent; a deal resolves one ordered packet. A retired form or an expired license holds the packet review and names the replacement | `test:wave156-c-forms-directory`, `test:wave156-r-seams`; canaries C04 (250 forms, the 101st and the last found), C05, C27 |
| 3 | In many states it is a closing attorney, not title | The code assumed a title-company seat | The deal page records the closing attorney and every other closing party, whom each lawyer represents, and who the settlement agent is and on what basis. Rules read the sourced state table; a title company recorded as settlement agent on a Georgia or North Carolina deal is saved and opens a counsel-review task that cites the source. An attorney is a vendor category, not a user type | `test:wave156-d-closing-parties`; canaries C06, C07, C08, C09 |
| 4 | An anonymous visitor is identified only when a provider really can; otherwise leave it out | A tracking hit could name any tenant; the site-visitor source could produce a lead from a session | Decision recorded: anonymous-visitor identification is NOT offered (no vendor terms that allow multi-tenant resale were verified, and no independent accuracy audit was found). A visit stays an aggregate. A visit is linked to a person only after that person's own act, and only when exactly one record matches on every identifier. Tracking hits are accepted only from the tenant's registered website | `docs/operations/WAVE156-VISITOR-IDENTITY-DECISION.md`; `test:wave156-f-visitor-truth`; canary C12 |
| 5 | "155R24 names a recruiting manager; there is no recruiting manager, there is a sphere manager" — then amended: "if recruiting manager is correct after auditing, then leave that" | — | Audit: `recruiting_manager` has been a registered manager since migration m215 and owned 65 maintenance domains before this wave. It was not invented by 155R24. It stays; lifetime, past-client and referral work stays with the Sphere Manager. The registry holds the same 13 managers before and after the wave; no key was added, renamed or retired | manager registry read on both trees (13 / 13); canary C22 |
| 6 | The calculators are a lead magnet and an asset for the website | Calculators carried assumed percentages (6% commission, 2% closing costs, tax and insurance fallbacks) and were not publishable | One engine; a calculator is published as an artifact on the tenant's lead-magnet page, website and client portal. A visitor calculates anonymously (events only). One explicit opt-in creates one contact and one hand-off. A figure nobody entered is asked for, or comes from a cited statute, the property's record, the executed agreement or the brokerage's configured rate. The deal-level net sheets (portal, CMA, offers) run on the same engine | `test:wave156-h-calculators`; canaries C13, C14 |
| 7 | Is keeping the app's size small hindering full capability? | The import-size guard was over both ceilings after Batch 1 (1,307 of 1,300; 5,306 of 5,300) | No capability was removed and no ceiling was raised. 87 importers now name the module that defines what they use instead of a re-export index that dragged in every sibling. Heaviest page 1,272 of 1,300; all pages together 5,250 of 5,300. The limit is a build-memory limit of the hosting runner, not a product limit: the real lever is the runner size (an owner decision in `docs/operations/WAVE156-SCALING-AND-CI.md`), and the headroom left is 28 and 50 modules | `test:proxy-graph-budget`, `test:wave156-l`; canary C24 |

Two more owner inputs:

- **Provider price knowledge and the Datafiniti documents.** Reconciled in `docs/operations/WAVE156-PROVIDER-DECISION-PACKET.md` (section 4 of this report). The owner-supplied `/november-2026` page was reachable on 2026-11-25 and was read.
- **A community area where tenants share known fraudsters.** Built as a moderated network that shares fraud TACTICS, not a list of people (section 5). A report that names a private person from an unverified account is refused. This is a deliberate narrowing of the request, required by the directive and by defamation and consumer-reporting exposure; it needs counsel before anyone uses it.

## 3. Code proofs, lane by lane

`docs/operations/WAVE156-CODE-PROOFS.md` carries, for each of the seventeen lanes: what it does now, the canonical code paths (created or reused), the chain from trigger to recovery, the driven guard with one positive and one negative scenario, its migrations, and everything the lane left undone. It is condensed from the lane reports; its opening section lists the statements that integration has since superseded.

Final results of each lane's guard on the integrated tree:

| Lane | Chain key | Integrated tree | Control tree (passed / failed) |
|---|---|---|---|
| 156B | `test:wave156-b-representation-gate` | 135 passed, 0 failed | 21 / 30 |
| 156C | `test:wave156-c-forms-directory` | 106 passed, 0 failed | 4 / 19 |
| 156D | `test:wave156-d-closing-parties` | 154 passed, 0 failed | 66 / 46 |
| 156E | `test:deal-desk` | 332 passed, 0 failed | 228 / 68 |
| 156F | `test:wave156-f-visitor-truth` | 77 passed, 0 failed | 40 / 37 |
| 156G | `test:wave156-g-provider-economics` | 120 passed, 0 failed | 21 / 45 |
| 156H | `test:wave156-h-calculators` | 106 passed, 0 failed | 5 / 81 |
| 156I | `test:wave156-i` | 119 passed, 0 failed | 53 / 47 |
| 156J | `test:wave156-j-fraud-network` | 152 passed, 0 failed | 9 / 143 |
| 156K | `test:wave156-k` | 72 passed, 0 failed | 35 / 34 |
| 156L | `test:wave156-l` | 21 passed, 0 failed | 9 / 6 |
| 156M | `test:wave156-m` | 79 passed, 0 failed | 29 / 24 |
| 156N | `test:wave156-n` | 43 passed, 0 failed | 20 / 23 |
| 156O | `test:wave156-o` | 63 passed, 0 failed | 14 / 22 |
| 156Q | `test:wave156-q` | 46 passed, 0 failed | 10 / 36 |
| 156R | `test:wave156-r-seams` | 53 passed, 0 failed | 7 / 26 |
| 156S | `test:wave156-s` | 125 passed, 0 failed | 29 / 92 |
| 156P | `test:wave156-canaries` | 30 of 30 canaries; 346 checks passed, 0 failed | 4 of 30 canaries; 122 / 69 |

The control tree is the pre-wave commit or, for lanes that started after Batch 1 was merged, the Batch 1 merge; each lane's section in the code proofs says which and which checks were red. A check that is red on the control tree and green here is a defect or a missing door this wave closed. Counts on the control tree are the lane's own latest run; the integrated-tree column was run by the integrator on the commit this report was written against.

## 4. Provider decision packet

`docs/operations/WAVE156-PROVIDER-DECISION-PACKET.md` (267 lines). What it holds, and the answer first:

- **The measure is cost per verified usable person**, not cost per credit or per row. The packet gives the formula and a lower-bound table (RentCast plus a Versium email append) at 10,000 and 50,000 consumers a month and at three match rates. Every match rate is an assumption a pilot must measure; AI and validation costs are unknown, so each figure is a lower bound.
- **RentCast** stays the property and sold-comparables source. Billing is per successful request with paid overage and no vendor-side hard limit, so the platform now enforces its own ceiling (1,000 a month until the owner sets one). The ledger books every request at the Foundation rate of $0.074; once a larger plan is chosen that constant overstates spend by roughly 2 to 4.5 times and must be changed.
- **Versium** is the active enrichment route. Credit packages beat the annual plan at 10,000 consumers a month; the annual plan wins at 50,000. The published price is an indication; reselling to tenants needs the Reseller tier and a signed agreement, and that quote is unknown.
- **Datafiniti** is dormant. Its people-data page no longer lists prices. The free count and schema calls are the only ones the code will make before a license is recorded. The owner-supplied `/november-2026` release page was reachable on 2026-11-25 and was read; the October page was read too.
- **Perplexity.** "Computer" is a consumer agent product and is not usable as a pipeline component; the Search API and the Agent API are separate products. No account exists and no benchmark was authorized, so nothing was changed.
- **Fields × coverage × freshness × rights** per provider are in its section 5; the pilot design (budget UNAPPROVED) in section 7; unknown quotes, keys and decisions in section 8; sources with fetch dates in section 9.

No provider was called, no key was set, nothing was purchased.

## 5. Fraud community safety packet

Code: `lib/fraud-network/network.ts`, `app/actions/fraud-network.ts`, `/dashboard/fraud-network`. Tables: migrations m1035 and m1036 (applied). Posting rules for counsel: `docs/legal/PACKET-7-FRAUD-COMMUNITY-POSTING-RULES.md` — a DRAFT, not published.

- **What it is.** A tenant's staff report a suspected fraud incident privately. Platform safety staff review, redact and publish a warning about the TACTIC: how the scam works, its red flags and how to verify safely. Every other tenant's staff can read published warnings.
- **What it is not.** It is not a list of people, a reputation score or a blacklist. No warning, report or match denies, blocks or cancels a deal, a vendor or an account; the product has no such function. Network information is never used to enrich contacts, build audiences or score people.
- **Threat categories (fourteen, fixed in the schema).** Wire diversion through a look-alike domain; change of wire instructions; vacant-land seller impersonation; deed or ownership impersonation; fake rental deposit; fake listing or photo reuse; cloned title, escrow or attorney identity; fake lender or insurance communication; vendor invoice substitution; credential phishing; forged power of attorney; fake earnest-money instructions; altered payoff or settlement documents; professional recruitment or investment scam.
- **Moderator workflow.** Only platform staff with the support capability publish, through one recorded step. Drafting uses deterministic redaction and no model. Each warning carries one claim class: unverified report, verified operational pattern, or official public warning. A warning text may not contain an email address, phone number, account or identity number, link or street address. Free-text that looks like a name or a business is held for a second staff review. A person or business may be named only when an official public agency named it, the citation is a government source, and legal review is recorded — enforced by a database constraint.
- **Cross-tenant visibility.** Other tenants read a projection of published warnings only: no reporting tenant, no reporter, no case, no evidence, no contact. A private case is readable by its reporter, that tenant's case reviewers and platform safety staff. Contacts and vendors do not take part.
- **Evidence.** The network stores a fingerprint of each evidence file, never the file. Image uploads are stripped of location and text metadata. Storage itself is off until the owner creates the private bucket (owner sheet, Also G) — and that should wait for counsel.
- **Dispute rights.** Any tenant can request a correction from the warning. A person outside the platform can request one through support; staff record it. Staff correct (every earlier version is kept), take down (which also withdraws every content topic derived from it) or decline with reasons. A reporter can withdraw a report or appeal a moderation outcome. Cases are deleted after a retention period (730 days in code, for counsel to confirm).
- **When a live wire matches a warning.** The existing wire-fraud sentinel proposes one high-priority task for the deal's agent: call the settlement party back on an independently obtained number before any money moves. The deal is not changed.
- **Verified example scenario (simulated).** Canary C20: tenant A files a private case; staff publish a warning; tenant B reads it and finds no trace of tenant A or the reporter; a report naming a private person without an official source is refused. Canary C21: a wire matching the warning creates exactly one call-back task and no denial; a replay adds nothing. Both were red on the pre-wave tree.
- **Counsel must sign off before use:** whether any warning could be a consumer report (FCRA; the FTC overview page could not be fetched and is marked not verified); defamation exposure for unverified reports that name no one but describe a recognizable event; retention; the correction response time and the published address for corrections; which sources count as authoritative; state privacy treatment of indicators; fair-housing and state automated-decision laws.

## 6. Owner action sheet

`docs/operations/WAVE156-OWNER-ACTION-SHEET.md` is the ordered sheet. Every step names who runs it and the required role, a before read, the statement or console action, an after read, a rollback and what it unblocks. Executable SQL lives once, in `docs/operations/OWNER-SQL.md`.

| Order | Step | Live today (read 2026-11-25) |
|---|---|---|
| 1 | The five private document buckets: replace bucket-wide policies with owner policies (OWNER-SQL §F, §G, §J) | Five buckets read `open`; 0 objects stored, which is the only reason nothing has leaked |
| 2 | Listing media: restrictive folder policies (§M.1) | 4 permissive, 0 restrictive |
| 3 | §R.6: insert-side policies on the five deal tables | Not applied; the five tables hold no rows |
| 4 | The four portal seed identities (§I) | 4 unlinked, active seed seats |
| 5 | `SECRETS_ENCRYPTION_KEY` in the hosting environment | Not verifiable from here; secret stores hold 0 rows |
| 6 | Counsel: agreements, AI autonomy, data and provider schedule, privacy and marketing (with the nine consent questions), forms rights, fraud posting rules | No sign-off recorded |
| 7 | Provider licenses, keys and spend ceilings | No license recorded; the RentCast ceiling is the 1,000 default |
| 8 | Environment, build machine, domain and render hosting | No deployment exists |
| 9 | First preview and the smoked customer journeys | None run |
| Also A–G | Approval rows append-only; form-library office and agent scope; a retired global index; three retired notification events; a channel rename (held until code lands); training-progress and recruits policies; the fraud evidence bucket | Each re-read live; none blocks release |

Nothing on the sheet was run by this wave.

## 7. Census truth

The coverage census (`scripts/os-coverage-ledger.ts`) lists every executable path: cron routes, event reactors, signals, webhooks, HTTP routes, server actions, assistant tools and provider egress.

| | Rows | Working | Owner-held | Missing (no link) | Partial |
|---|---|---|---|---|---|
| Start (`e79a13b8`) | 3,011 | 2,880 | 72 | 59 | 0 |
| End (integrated tree) | 3,053 | 2,921 | 73 | 59 | 0 |

Reconciliation, by row id (the full lists are in `docs/operations/WAVE156-CENSUS-TRUTH.md`):

- **45 paths added, all working** — each has a trigger, a registered owner, a decision gate, a receipt and a reader, and each names the guard that drives it: 28 Fraud Network doors, 5 closing-team doors, 5 calculator doors, 2 packet-review doors, 2 forms routes, the governing-terms confirmation, the RentCast ceiling setter, and the corridor brief signal. (The held-send approval and the recruiting access check ride doors that already existed, so they add no row.)
- **3 paths retired, each with a named survivor** — `calculateAffordability` and `calculateRentVsBuy` (survivor: `lib/calculators/engine.ts`), and the `trackBehavior` server action (the function moved to `lib/lead-intelligence/track-behavior.ts`; it is no longer a public endpoint).
- **1 path changed state: working → owner-held** — `trackExternalActivity`. It is the only writer of the external-activity rows the lead pipeline still reads, and after this wave nothing calls it. Deleting it would orphan those readers; wiring it needs a product decision on what a legitimate first-party source is. It is held as that one question, not counted as working.
- 3,011 + 45 − 3 = 3,053. Working 2,880 + 45 − 3 − 1 = 2,921. Owner-held 72 + 1 = 73.

**The 73 owner-held rows.** `docs/architecture/WAVE156-OWNER-HELD-ADJUDICATION.md` gives one row per held path with the code evidence and one recommendation: observation-only 25, human or platform authority 17, an existing manager 11, a deterministic rule owner 10, retire onto a survivor 6, wire to product 4. They are recommendations. No owner decision was invented and none was applied; each row stays held until the owner rules.

**The 59 missing rows** are unchanged. Every one is an audit-only event or signal: something publishes it and nothing consumes it. They are observation records, not broken features. The census ratchet freezes them so a 60th cannot appear unnoticed.

A count that moved during integration, and why: the census briefly read 74 owner-held and 2 partial after the paid-call receipts landed. The census follows calls three hops deep, and the receipt had pushed the spend write to the fourth hop, so three voice doors lost their derived owner. The door was restated so the write is back at hop three; no census rule or baseline was changed.

## 8. Release verdict

**ENGINEERING READY — OWNER ACTIONS REMAIN**

Why this one and not the other two. It is not `ENGINEERING BLOCKED`: every defect and missing door the directive named that could be closed without the owner is closed, each proven by a guard that drives the real product code and is red on its control tree; and by the standing rule this commit reaches the remote branch only when the full guard chain's own exit line reads 0 on it. It is not `PREVIEW/PRODUCTION VERIFIED`: nothing was deployed, and no result here was observed on a deployment. What remains in code is listed in section 11. None of it is what stands between this tree and a first preview — the owner's sheet is.

The five release states, which are distinct and never implied by one another:

| State | Status | Evidence |
|---|---|---|
| CODE GREEN | Recorded on the pull request | A file cannot carry the result of the chain that runs on the commit containing it. The commit is pushed only after the chain's exit line reads 0 on that exact commit; pull request #49 shows the pushed head and its CI runs, and the owner sheet's CODE GREEN row is written from those |
| SECURITY READBACK GREEN | NOT MET | Live read 2026-11-25: five private buckets open, listing media has no restrictive policy, §R.6 not applied, four seed seats unlinked |
| LEGAL/LICENSING READY | NOT MET | No counsel sign-off and no provider license is recorded |
| PREVIEW LIVE VERIFIED | NOT MET | No deployment exists; no signed-in journey was run |
| PUBLIC RELEASE AUTHORIZED | NOT MET | The owner has not said go, and the blockers above are open |

Every test result in this report is simulated unless it says "read live". A simulated result is not a live result. The private document buckets must be closed (step 1) before any real deal document is stored.

## 9. Truth ledger, 156A–156P

Categories are the directive's: existing verified · real defect · owner decision · licensed dormant · new implementation · not applicable · retired with survivor.

| Lane | Existing verified | Real defect (fixed this wave) | New implementation | Retired with survivor | Licensed dormant / not applicable | Owner decision |
|---|---|---|---|---|---|---|
| 156A reconcile | 13 registered managers; `recruiting_manager` since m215; no migration number collides; subscription, seat and role vocabulary untouched | A solo or team tenant read "the brokerage pays" | One wording helper picks the payer and the scope from the tenant's shape | — | Not applicable: "remove the recruiting manager invented by 155R24" (audit: it was not invented there) | Recruiting ownership (ruled: stays) |
| 156B gates | Offer compliance loop; document scan; closing-approval authority | Signed flag alone advanced a listing or created a deal; replay could create two | Typed packet decision, review queue and review screen | — | — | Whether a fully verified packet may pass without a person; append-only approval rows (SQL) |
| 156C forms | Packet writer, forms bucket, addendum signature door | Provider library stopped at 100 forms | Paged directory, add form or packet, ordered packet per deal, AI read accepted field by field | — | Dormant: no provider library was called live; three providers' paging is unverified and labeled | Coordinator may propose an addendum; office and agent scope in the read policy (SQL) |
| 156D closing | State closing-participants table; TRID receipt; a valid close without a CDA | A title-company seat was assumed; 20 CDA doors did not ask the deal desk; the portal could state closing parties not on record | Closing Team card; settlement-agent basis; counsel-review task | — | — | Counsel on the state sources |
| 156E deal desk | The one deal-desk decision | An agent off the deal reached the model; extracted terms overwrote a deal | Every single-deal door asks the desk first; extracted terms become proposals a person confirms | `applyContractExtraction` writes → proposals door | — | §R.6 policies (SQL) |
| 156F visitors | First-party form capture | A hit could name any tenant; a session could become a lead | Link decision; site binding; visitor data in privacy export and erasure | `trackBehavior` server action → library module | Not applicable: anonymous identification (declined, with reasons) | Wire or retire `trackExternalActivity` |
| 156G providers | Versium as the active enrichment route; budget gate; usage ledger | Failed requests booked as spend; concurrent duplicate requests; dormant providers shown as connected and reached by failover | Platform request ceiling; pre-pull decision; commitment-aware economics | Second env spellings (`PDL_API_KEY`, `APIFY_API_KEY`) | Dormant: BatchData, PeopleData, Datafiniti (no license recorded; not routed) | Plan, ceiling, price constant, licenses, pilot budget |
| 156H calculators | Lead-magnet publishing rail and its fair-housing scan | Assumed commission, closing-cost, tax, insurance and rate figures; the CMA charged the agent's split on both sides | One engine; calculator artifacts; opt-in hand-off | Seven calculator exports and `lib/cma/net-sheet-math.ts` → `lib/calculators/engine.ts` | — | Who may price the internal net sheet; refuse or ask when no commission term exists |
| 156I market | Topic intake from real events and questions | Withdrawn permits filed as seller signals; unlicensed datasets fetched; a self-declared minor filed; system writes counted as a person's activity; duplicate weekly briefs | Corridor explainer proposal; comparables capability under the ceiling; shortage task naming consented owners | Direct CMA comp pulls → `requestPropertyComparables` | — | Whether a winning piece of content may trigger a refresh |
| 156J fraud | Wire-fraud sentinel | — | Private cases, moderated tactic bulletins, corrections, takedown, verification task | — | Dormant: evidence storage (no bucket) | Evidence bucket (SQL); counsel on the posting rules |
| 156K recruiting | Recruiting Manager ownership; open-house award by held count | A forged "100% watched" earned a certificate; suspended, declined or duplicate recruits were re-filed | Server-credited watch time; intake verdict; funnel from stored records | — | — | Two table policies (SQL) |
| 156L scaling | The import ceilings | A browser path reached the server-secret reader; budget over both ceilings | Importers name defining modules; ledger module split | — | Not done: project references (untested sketch) | Runner size; work-in-progress branch |
| 156M arbiter | Follow-up arbiter, de-confliction and the action ledger as the one decider and the one sink; no second kernel; ArbiterOS not installed | An autonomous payout or CDA release with no decision proceeded; a held send had no door behind it | Decision record on every ledger row; refusals at the sink; approval of a held send as one expiring decision | — | — | The 73 held rows |
| 156N loose ends | Marketing approver; tracked QR on every print producer | A payout could be sent twice after a lost processor answer; representation stood in for consent on campaign texts; CDA writes not pinned or counted; sealed tokens read needlessly; an expired token read "connected" | Reconcile before any re-send; purpose-aware consent | — | — | Counsel's nine consent questions; two social-account rulings |
| 156O release | Release-blocker obligations | The staff board printed GO from configuration probes; terms acceptance kept no hash and accepted a stale version | Five distinct release states; the ordered owner sheet; content hash on acceptance | — | — | Every step of the sheet |
| 156P canaries | C09, C16, C19 and C22 were already correct on the pre-wave tree | — | Thirty driven cross-lane canaries | — | — | — |

## 10. Cross-lane canaries (C01–C30)

Command: `npm run test:wave156-canaries` (`scripts/wave156-canaries.ts`; each canary runs in its own process). Integrated tree: **30 of 30 pass, 346 checks, 0 failed.** Pre-wave tree (`WAVE156P_ROOT` pointed at a checkout of `e79a13b8`): **4 of 30 pass, 122 checks passed, 69 failed.** Both runs were repeated by the integrator. Every result is SIMULATED.

| | Positive that is driven | Negative that is driven | Pre-wave tree |
|---|---|---|---|
| C01 | A solo agent's listing goes to review; approval advances it | A fully signed agreement alone neither advances the listing nor creates a deal | Red — advanced with no review |
| C02 | A changed price or a missing initial holds, naming the term and the document | Nothing is marked complete; an unreadable scan holds | Red |
| C03 | One transaction at the signed price | Two racing deliveries give one row; contradicted, unsigned or unreadable terms give none | Red |
| C04 | The tenant's own packet plus 248 licensed forms over three pages | Forms 101 and 250 are visible; an unlicensed form is refused; a contact or vendor gets 403 | Red — 100 of 250 shown |
| C05 | A coordinator stages an addendum; one executed version is kept; the master is unchanged | An unsigned addendum never governs; contact and vendor refused | Red — door absent |
| C06 | A Georgia attorney closing completes; Georgia and North Carolina cite their sources | No title-company seat is demanded | Red — door absent |
| C07 | Separate buyer and seller attorneys; an outside attorney produces an agent task | One attorney never stands for every party; a vendor seat is refused | Red — door absent |
| C08 | The lender's receipt is lender-confirmed; a corrected Closing Disclosure is required | An agent-created receipt stays pending | Red — door absent |
| C09 | Opting in to a CDA applies going forward; a close without a CDA is valid | A closed deal is not blocked; no placeholder CDA is inserted | Green (already correct) |
| C10 | The agent and the coordinator on the deal reach the model | Vendor, contact, off-deal agent, other tenant: 0 model calls, 0 writes | Red — off-deal agent reached the model |
| C11 | The measured SQL matches the owner SQL and denies cross-tenant inserts; the packet says not applied | A local result written as "applied live" is refused | Red — door absent |
| C12 | A session is recorded as an aggregate | No raw lead; shared or mixed identifiers link nobody | Red |
| C13 | One consented opt-in creates one record; the funnel reads it back | Five anonymous calculations create nothing | Red — door absent |
| C14 | The user's own quote; the cited Florida statute | No invented title, escrow or tax figure; no model call | Red |
| C15 | Records reused from cache; sale date and price kept | One paid request for concurrent reads; a failed call is not billed; missing sale fields stay empty | Red — two requests |
| C16 | The free count runs before any download | A dormant account makes 0 calls | Green (already correct) |
| C17 | Cost per usable person on a fully costed cohort | A published rate is not a signed contract; the minimum binds | Red — door absent |
| C18 | An adult's own public request becomes one raw lead | A minor, a search-trends page and a forum post become no one | Red — a minor was filed |
| C19 | A dated local event and a real question become topics | Competitor copy, "everyone is asking" and undated events are refused | Green (already correct) |
| C20 | A private case; a moderated warning readable by other tenants | A named, unverified report is refused; no trace of who reported | Red — a named topic was stored |
| C21 | A matching bulletin creates one call-back task | No ban or denial anywhere; a replay adds nothing | Red — door absent |
| C22 | The Recruiting Manager owns recruiting (owner ruling of 2026-11-25) | No second owner; tiers and user types unchanged | Green (already correct) |
| C23 | Honest playback earns the certificate; a stored quiz pass earns once | A forged 100% claim, a viewed-only course and a cancelled open house earn nothing | Red — forged certificate |
| C24 | Heaviest page and the union are under their ceilings | No module dropped from the app; no browser code reaches the server secret | Red — browser path to the secret |
| C25 | A payout carrying a recorded decision proceeds | A payout with no decision is held for a person; every proof the ownership matrix cites exists | Red — door absent |
| C26 | A lost processor answer is reconciled; one key per payout | One transfer only; nothing is re-sent when the lookup fails | Red — paid twice |
| C27 | A 15-minute, per-view link | An office, team, role or tenant change revokes access; no stored link | Red — door absent |
| C28 | Five distinct release states | Simulated never counts as live; a key alone never reads "connected" | Red — read "connected" |
| C29 | Solo, team, brokerage and multi-office each pass | No data crosses tenants or offices | Red — door absent |
| C30 | Facts stated from the record; one agent task | No invented lender or attorney name; 0 model calls | Red |

What the canaries do not cover: no page is rendered in a browser; C11 recomputes the fingerprint of a local PostgreSQL measurement and does not touch the database; C24 does not run the production build; C27 covers the forms bucket's link door only; the in-memory database has no row security, constraints, triggers or real concurrency.

## 11. Not done, or not verifiable from here

- **No deployment, no browser session signed in.** There were no test credentials. The deal-page dialogs were driven in Chromium as components with stand-in server actions (20 of 20); no page was rendered against a real server or database.
- **No owner SQL was run.** Storage policies, listing media, §R.6, seeds, and the Also A–G items are written for the owner.
- **No provider, model, payment or e-sign system was called live.** Paging for three form providers (Dotloop, Authentisign, Form Simplicity) could not be confirmed from public documentation and is labeled "possibly truncated" in the product.
- **The compare-and-set on proposed deal terms** filters on a JSON field; that filter was not exercised against the live data API (the deal tables hold no rows). A refusal would surface as an error, never as a silent write.
- **Arbiter coverage.** One of the nine planes is driven end to end (inbound message → hold → a person approves in the Command Center queue → release carrying the approval). The other eight each have their sinks and decisions driven but are not chained as one journey; the code proofs name the missing link for each. Of 73 autonomous call sites, 32 now state where their input came from and how far it is trusted (21 under a shared boundary, 11 at their own door); 41 library functions do not, and that is a published blind spot. A held send older than 30 days drops out of the approval queue without being closed (decision 13).
- **Subscriber wording.** The payer and scope sentences now follow the tenant's shape, but 838 lines that a solo agent or a team can reach still say "your brokerage" (868 before). The guard publishes the count; it does not assert zero.
- **Market intelligence row 8** (refreshing the tenant's own winning content) is open: nothing produces the measured-winner input, and whether a winner may trigger a refresh is an owner decision.
- **Fraud evidence** accepts JPEG and PNG only; other file types are refused until a cleaner exists. The bucket does not exist.
- **Visitor tracking** records nothing live until a tenant declares its website (0 registered sites today), and tenants must re-copy the tracking snippet to get this wave's change. No per-site secret was built: a server that forges the site headers can write only into the tenant whose site it names, under the per-address throttle.
- **RentCast ceiling** can be overshot by the requests in flight between two ledger reads (30 seconds) when several server instances run.
- **Scaling.** Splitting the type-check into project references is an untested sketch in the scaling memo. The production build runs in CI, not here.
- **The capability-surface audit** follows `import … from` but not `export … from`; this wave's rewrite of importers revealed 39 role-surfaces it could not see before. The blind spot is published in the scaling memo and not yet fixed.
- **The browser harness** that drove the deal-page dialogs lives outside the repository; it is not a chain step, so those dialogs are not re-driven on every change.
- **The cloud environment's setup script** was corrected earlier in this session; it is unproven until a container is built fresh.
- **Skills.** The directive names a "saas" skill; none exists in this workspace. The ECC plugin under `plugins/ecc/` was read as reference only; no loop runtime or second kernel was copied into the product, and ArbiterOS was not installed.

## 12. Decisions that are the owner's

Product rulings (each is implemented in its conservative form until ruled):

1. May a packet whose every compared term agrees pass without a person? Today every executed packet waits for a reviewer.
2. May a transaction coordinator propose an addendum? Today only the contract's agent or a brokerage admin may.
3. Wire or retire `trackExternalActivity` (with its readers).
4. Close or keep the three remaining direct doors to dormant PeopleData and the BatchData property step.
5. Who may price the internal seller net sheet (today: the tenant-admin roster plus the agent), and whether a page with no commission term on file should refuse instead of asking for the figure.
6. May a measured winning piece of content start a refresh?
7. Which source is canonical for a brokerage's primary state: `brokerages.state` or the settings value? They disagree in three of four cases, and today only the uncalled reader returns a state.
8. Office staff preparing marketing for one agent (not the brokerage or a team) is not modeled.
9. May a post use a social account connected by another seat of the same tenant? Should "post to all" reach other agents' personal accounts?
10. Should the solo-plan rule also apply when the account has more than one agent seat?
11. Should a writer for privacy-notice acceptances be built? The table has none.
12. The 73 held rows in the adjudication table.
13. Should a held client message nobody reviewed in 30 days be closed automatically (and how), or stay listed until a person declines it? Today it leaves the queue view and stays open.
14. On the brokerage and acquisition dashboards the recruiting money cards are omitted for a seat that may not read the books, with one sentence in their place. Confirm omission rather than a locked card.

Counsel: the posting rules; the nine consent questions; the state closing sources; the tracking snippet's form listener and the Global Privacy Control signal; everything in step 6 of the sheet.

Providers and spend: RentCast plan, ceiling and the price constant; the Versium Reseller agreement; a Datafiniti license; the pilot budget; a Perplexity account, if wanted; Remotion license tier; Simli pricing; a spend cap for platform-paid research.

Hosting: the build runner size; the render worker; whether to authorize a work-in-progress branch so unfinished work survives a container rebuild.
