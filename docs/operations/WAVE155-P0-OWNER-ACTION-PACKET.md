# Wave 155 — P0 owner action packet (lane 155A, 2026-11-19; merged state, lane 155L, 2026-11-20)

**Verdict today: RELEASE BLOCKED.** Production audit (local evidence only, ECC `production-audit` lens): Blocked, capped below
50 because authorization is missing on sensitive data at the storage layer (five private document buckets are open to every
signed-in account) and no deployment exists to roll back to. Nothing on this page has been run by a lane or the integrator.
Project `hrvaqgvukzxfskkcrwbt`. **Executable SQL is NOT copied here.** It lives once, in `docs/operations/OWNER-SQL.md`,
held verbatim to its migration files by the guards. Each item names its section and line range (as of base `9d9626b9`).
A second copy could drift from those files.

## 0. Baseline: what the live database says today (LIVE-VERIFIED 2026-11-19 21:38 UTC, read-only SQL via Supabase MCP)

| Read | Live answer | Query |
|---|---|---|
| Can the MCP / default SQL session alter `storage.objects`? | `postgres`, `can_alter_storage_objects = false` → **use route B** | OWNER-SQL §K Q1 (l.621-622) |
| Prerequisite functions (m854, m874, readiness, `is_tenant_staff_seat`) | all present | §K Q2 (l.624-630) |
| `storage_bucket_policy_readiness()` | agent-documents, brokerage-forms, client-documents, offer-documents, transaction-documents = **open**; documents = service_only | §K Q3 (l.632-633) |
| Bucket-wide rules on the five / owner policies / bucket-agnostic | **19 / 0 / 0** (39 policies on `storage.objects` in all) | §K Q5 (l.642-648) |
| Objects stored in any bucket | **0** in all 12 buckets (the only reason nothing has leaked) | §K Q6 (l.650-652) |
| listing-media | 4 PERMISSIVE (`bucket_id = 'listing-media'` only), **0 RESTRICTIVE** rows | §N.1c (l.943-948) |
| Portal seed contact seats | **4 of 4 unlinked**, drift guard `ok_pairs = 4`, 4 active, 0 banned, 0 sign-ins since 2026-11-01, 0 invitations | §K Q7-Q9 (l.654-678) |
| competitor_ads unique indexes | old global `uq_competitor_ads_source_provider_id` **present**; tenant `uq_competitor_ads_tenant_source_provider` present; 0 rows | §P.1 (l.1227-1231) |
| m968 grants | `award_agent_points` / `_once`: anon **no**, authenticated **no**, service_role **yes**; the agents points trigger present | catalog `has_function_privilege` |
| m973 / m974 / m988 | `circle_tactic_shares` exists; follow-on index 1; the 4 inferable indexes 4 (the 4 old partial ones also still 4, §P.2 optional) | `pg_indexes` / `to_regclass` |
| `personal-videos`, `receipts` buckets | do not exist yet (born private on first write, §H / §N.1d) | §K Q6 |

Migration stamps agree with the database: m854, m874, m968, m973, m974, m987 and m988 read APPLIED LIVE on line 1 (**do not
re-run**); m855 and m875 read WRITTEN, NOT APPLIED. These two are yours.

## 1. P0-1 — The five private document buckets (OWNER-SQL §F then §G, then §J) — RELEASE-BLOCKING

- **What:** the per-seat rules for `brokerage-forms` (§F, m855) and `agent-documents`, `client-documents`,
  `transaction-documents`, `offer-documents` (§G, m875; the offer bucket gets NO policy, it is service-only).
- **Why it blocks:** today any signed-in account of any tenant (a portal contact, any vendor) can list, read, overwrite
  and delete every client's bank statement, every offer, every deal file and every license. The buckets are empty today.
  The first real upload is the first leak.
- **Who:** the owner, signed in to the Supabase dashboard (route B: **Storage → Policies**; route A is refused, see §0).
- **Before (expected today):** §F "Before" (l.118-127) and §G "Before" (l.245-256): every `to_regprocedure` non-null; 4 + 15
  bucket-wide names listed; readiness = five `open`.
- **Do:** §F route B (l.176-188): delete the 4 `auth … brokerage-forms` policies, then create the 4 `brokerage-forms owner *`
  policies exactly per the table. Then §G route B (l.334-349): delete the 15 `auth … <bucket>` policies, create the 7
  `… owner …` policies. Route A text if ever usable: §F l.133-174, §G l.262-332 (one transaction each).
- **After (expected):** §J steps 1-3 (l.580-595): agent-documents / brokerage-forms / client-documents /
  transaction-documents `owner_scoped`, documents / offer-documents `service_only`, every array empty; bucket-wide = **0**;
  owner policies = **11**. Positive control: if §K Q5 had read below 19 BEFORE you started, the finder was blind. Stop.
- **JWT tests (SQL editor, impersonation as written):** §F "Verify afterwards" (l.204-222): a contact gets `false,false`; an
  agent gets `true,true,true,false`. §G (l.367-402): a contact `false,false`; a vendor seat `false,false`; the deal's agent
  `true,true`; the TC `true`; the contact sees only its own offers (0 today).
- **Real-session test (browser, after one test upload):** as the deal's agent, upload one PDF to a seed deal in the app. Its
  link opens through `/api/documents/open?ref=…` → **opens** (302). Then, signed in as (a) another tenant's admin, (b) a vendor
  seat of the same tenant, (c) a contact who is not a party → each **"This document isn't available."** (404). Positive and
  negative rows are also executed in code: `test:document-links-sign-on-read` and `test:wave155-access-canaries`.
- **Rollback / stop:** if a create fails midway, STOP. With no policy left on a bucket, every session is refused (fail
  closed), and the server keeps working (service role). Undo §G only to repair a broken apply: §G "Rollback" (l.406-434).
  It re-opens the exposure, so say so. §F rollback: see OWNER-SQL §Q.2 (added this wave; it restores the 4 measured
  policies).
- **Then (integrator):** flip line 1 of m855 / m875 to APPLIED LIVE, lower `NOT_APPLIED_BASELINE`, re-run
  `test:release-blockers` (O1 discharged only from those stamps) and record ledger row R9 (ACTIVATION-CHECKLIST §6.7).

## 2. P0-2 — listing-media RESTRICTIVE folder policies (OWNER-SQL §M.1) — RELEASE-BLOCKING

- **What / why:** listing photos are public to READ by design; today any signed-in seat of any tenant can WRITE, overwrite
  or DELETE any listing's media. The amend narrows writes to tenant staff, and the booked photographer only into its listing.
- **Who:** owner, as `supabase_storage_admin` in the SQL editor, or Dashboard → Storage → Policies (`postgres` is refused).
- **Before:** §M.1 pre-check (l.904-906) lists `current_user_brokerage_id` and `is_tenant_staff_seat` (both present today);
  §N.1c (l.945-948) shows 4 PERMISSIVE and **no** `listing-media tenant listing folder *` row.
- **Do:** the §M.1 block (l.841-900) as ONE transaction. **Not** §L L3 (l.724-758): it is superseded, too wide.
- **After:** §N.1c lists the 3 RESTRICTIVE rows beside the 4 permissive ones. Then change §M.1's status line (l.827) to
  `- Status: RESOLVED <YYYY-MM-DD> — N.1c shows the 3 RESTRICTIVE rows` (the guards read only that line).
- **JWT tests (browser sessions):** §M.1 l.913. Tenant-A agent → own listing folder **200**, tenant-B folder **403**; a contact
  → **403**; photographer with a `confirmed` booking for L → `<A>/<L>/` **200**, another listing **403**; `booked` only →
  **403**; a stager → **403**.
- **Rollback:** `DROP POLICY IF EXISTS "listing-media tenant listing folder insert" ON storage.objects;` (and `… update`,
  `… delete`). The four permissive policies were never touched, so this restores today's state exactly.

## 3. P0-3 — The four portal seed identities (OWNER-SQL §I) — RELEASE-BLOCKING

- **What / why:** four `users` rows typed `contact` in the showcase tenant have no linked Contact. After P0-1 they sign in
  to a portal that resolves to nobody, and a real client must never inherit a seed identity.
- **Who:** owner (data decision). **Route A — LINK (recommended):** each pairing is exact (same tenant, same email, same
  name). **Route B — ARCHIVE:** set `status = 'inactive'` and ban the four auth users. B removes the sign-in but leaves the
  census at 4, so the item stays blocking by design.
- **Before:** §K Q8 ALONE (l.660-671) must read `ok_pairs = 4` (true today); Q7 = 4 rows; Q9 = no new sign-ins.
- **Do:** route A = §I Remediation A (l.519-547), one block; it returns exactly 4 rows or raises. Route B = §I l.565-571.
- **After:** §I verify (l.495-497) = **0** (route A). Flip §I's status line (l.502) to `- Status: RESOLVED <date> — census 0`.
- **JWT test:** sign in as one linked seed (`bu***@vip.demo` in the inventory). The portal shows Sarah M's own Contact.
  Opening another seed's document through the door → 404. Under route B, sign-in is refused.
- **Rollback:** §I Rollback A (l.551-560) restores exactly what A linked; Rollback B is on l.571.
- **Correction recorded:** §I l.489-490 ("2b REMOVE — delete the auth user") contradicts l.574 ("neither remediation deletes
  anything"). Deletion is NOT a scripted route. It needs your explicit authorization (OWNER-SQL §Q.1).

## 4. P0-4 — The first preview deployment and the domain (WAVE154 action sheet item 4) — RELEASE-BLOCKING

- **What / why:** there is no production deployment, so no real sign-in, cron tick, timer or storage read has ever run.
- **Who:** owner (Vercel login; build-machine pricing is yours). Nothing here may be done by a lane (no deploy, no env change).
- **Settings to confirm (from the repository, not invented):** Node **22.x** (`package.json` engines; set the Vercel project
  to 22). Build command `NODE_OPTIONS='--max-old-space-size=16384' next build --webpack` and install `npm ci` (`vercel.json`).
  The build machine needs RAM above 16384 + 5120 MB of off-heap (`scripts/release-rules.ts` BUILD_OFF_HEAP_MB), so a
  16 GB machine is refused (guard E4). Record the machine and its RAM in ledger row M1, and the custom domain in M2.
- **Environment names (values never written anywhere in the repository):** `NEXT_PUBLIC_APP_URL` (set before the build; it
  is inlined), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
  `SECRETS_ENCRYPTION_KEY` (P0-5), `AI_GATEWAY_API_KEY`. Leave `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` unset (no live
  billing), and `SENDGRID_API_KEY` / `TWILIO_ACCOUNT_SID` until you decide to send. The full list is in
  `docs/operations/ENVIRONMENT-INVENTORY.md`.
- **Before:** Vercel shows no READY production deployment; ledger R5 / R6 / M1 / M2 read NOT OBSERVED.
- **Do:** deploy a **preview** first, from the commit whose `npm run guard` log reads `GUARD_EXIT=0`. Attach the domain. Promote
  only when you choose.
- **After (expected):** deployment READY. `GET /api/health` → 200 with `commit` = the deployed 7-character SHA (proves the
  server, not the database). Then, signed in as platform staff, `/api/admin/health-status` answers (proves the database is
  reachable; ECC addition). One real browser sign-in (R6), one cron tick (R8) recorded with ids (`dpl_…`, run ids).
- **Negative test:** an anonymous request to `/api/documents/open?ref=…` → redirected to sign-in, never a file. A preview URL
  behind Deployment Protection → refused without the bypass.
- **Rollback / stop:** a preview is never live. If a promoted deployment misbehaves: Vercel → Deployments → the previous READY
  one → **Instant Rollback** (no rebuild). Before the first promotion there is nothing to roll back to, so keep it preview-only
  until R5 / R6 are observed.

## 5. P0-5 — `SECRETS_ENCRYPTION_KEY` is really configured — BLOCKS live credential use and outside-recipient share links

- **What / why:** this key seals every stored provider credential and every share grant an outside recipient (a lead, an
  outside agent, an appraiser) opens. Without it both fail closed: the connect action refuses, and the send is refused with
  its reason. **A placeholder is not configuration:** `lib/security/secret-crypto.ts` derives a key from ANY string, so
  `changeme` would "work" and be guessable. A name in a list proves nothing.
- **Who:** owner only. Generate the value yourself: `openssl rand -hex 32` (64 hex characters). Store it in Vercel as a
  **Sensitive** variable for Production and Preview, and keep one offline copy. Losing it makes every sealed credential
  unreadable. Never paste it into chat, a ticket or the repository.
- **Before (expected today):** unknown. The repository cannot see project variables; ledger has no row for it.
- **After — verify WITHOUT printing it:** (1) Vercel → Settings → Environment Variables lists the name, marked Sensitive, for
  Production and Preview. (2) Behavior on the preview deployment: send yourself a lead-magnet or market-report email. Its link
  carries `&g=enc%3Av1%3A…` and opens the PDF in a private window with no session (302). (3) The negative test: the same link
  with one character changed → "This document isn't available." (404). (4) The OS sentinel's daily posture stops reporting
  the key missing. If you rotate later, move the old value to `SECRETS_ENCRYPTION_KEY_PREVIOUS` first.
- **Status line (read by `test:release-blockers` section G; RESOLVED needs a date, a `dpl_` deployment id and the 302):**
- SEK status: HELD — not verified on any deployment (no deployment exists)
- **Rollback / stop:** never delete the key once a credential is sealed. If it leaked, rotate (new value, old one to
  `_PREVIOUS`), then let the sentinel re-seal.

## 6. P0-6 — Legal texts reviewed and published (LEGAL) — BLOCKS live subscription activation

- **What / why:** the sign-up agreement, privacy policy, AI disclosure, third-party data terms and marketing / consent terms must be
  attorney-reviewed and published before any live subscription is activated. Code records acceptance; it cannot certify the words.
- **Who:** the owner with counsel. No lane edits or publishes legal text.
- **Before (today):** `/legal` and `/privacy` serve the current drafts; no counsel sign-off is recorded anywhere.
- **Do:** counsel reviews; you publish the reviewed versions; then write the status line with the date and the review reference.
- **After:** `- LEGAL status: RESOLVED <YYYY-MM-DD> — counsel sign-off <reference>, versions published` (read by `test:production-readiness` L).
- **Rollback / stop:** restore the previous text; never activate live billing on an unreviewed text.
- LEGAL status: HELD — no counsel sign-off recorded

## 7. P0-7 — Provider credentials, licenses and cost ceilings (LICENSES) — BLOCKS each paid provider it names

- **What / why:** for each provider you enable: the credential (by variable name, never a value), the license where the data is
  licensed (Datafiniti's four datasets, licensed listing / IDX photos, Remotion hosted render and its terms) and a cost ceiling.
  A connection that reads READY does not make a simulated fixture provider-live.
- **Who:** the owner. A paid smoke call happens only after your explicit approval, one call per provider.
- **Before (today):** `test:production-readiness` prints WAITING_EXTERNAL per variable name (O5); Datafiniti reads LICENSE-HELD,
  `dormant_pending_rights` (`test:datafiniti-connector` N1: 12 of 12 refused at rights, zero charged calls).
- **After:** `- LICENSES status: RESOLVED <YYYY-MM-DD> — license <providers> recorded, ceilings set` (list only what you enabled).
- **Rollback / stop:** unset the variable; the connection fails closed and the paid door refuses with its reason.
- LICENSES status: HELD — no provider license recorded

## 8. P0-8 — Live probes on a deployment (LIVE-PROBES) — the only route to CONTROLLED PRODUCTION VERIFIED

- **What / why:** green CI and the SIMULATED canaries (`test:wave155-e2e-canaries`) never verify production. After P0-1…P0-5 on a
  preview: the storage JWT tests (P0-1, P0-2), one seed sign-in (P0-3), `/api/health` + admin health (P0-4), the share link 302
  and tampered 404 (P0-5), one portal question, one printed QR scanned through `/api/qr/scan`, one cron tick.
- **Who:** the owner, signed in, on a preview (the demo script: `docs/operations/WAVE155-DEMO-SCRIPT.md`).
- **Before (today):** nothing observed; no deployment exists.
- **After:** `- LIVE-PROBES status: RESOLVED <YYYY-MM-DD> — dpl_<id> storage / seed / health / share / QR / cron observed`.
- **Rollback / stop:** a preview is never live; stop at the first failed probe and record it.
- LIVE-PROBES status: HELD — no deployment exists

## 9. Optional for launch — §P.1 the old global competitor-ads index

- Not a P0. Required only before two tenants can each store the same outside ad (until then the second run reports "held").
  Before: §P.1 read-back (l.1227-1231) = `1 · 1`. Do: `DROP INDEX public.uq_competitor_ads_source_provider_id;` (§P.1 l.1221-1223).
  After: `0 · 1`. Two-tenant check that writes nothing: OWNER-SQL §Q.3. Rollback statement: §Q.3.
- P.1 status: HELD — old global index present (live 2026-11-19)

## 10. What lifts RELEASE BLOCKED (each a read-back, never CI)

1. §J steps 1-3 as expected → m855 / m875 stamps flipped → O1. 2. §N.1c three RESTRICTIVE rows → §M.1 RESOLVED → O1-LM.
3. §I census 0 → RESOLVED → O2. 4. Ledger R5 / R6 / M1 / M2 observed with ids → O3. 5. SEK line RESOLVED (date, `dpl_`, 302).
6-8. LEGAL, LICENSES, LIVE-PROBES lines RESOLVED as written above. `test:release-blockers` prints PRODUCTION-LIVE: YES only with zero obligations. `test:production-readiness` block L reads all eight
as launch gates: each stays EXTERNAL until its evidence exists, and a green simulation alone never unlocks launch (check L2).
Verdict vocabulary (directive §L3): ENGINEERING BLOCKED — CODE GAPS REMAIN while a P0 / P1 code gap is listed or the arbitration
census measures one; ENGINEERING READY — OWNER ACTIONS REMAIN once neither does; CONTROLLED PRODUCTION VERIFIED only after 1-8 are evidenced.

## 11. Owner SQL named by the final lanes (OWNER-SQL §R) — not release-blocking, written, never run

- **R.1** rename `campaign_sequence_steps.channel` → `step_kind` (§R l.1389-1406). HELD: 28 runtime files read the old name; the
  integrator lands that code first, then you run it in the same window.
- **R.2** restate the `notification_rules.trigger_event` CHECK without the three retired events (§R l.1407-1427). Read-back: 0 rules
  name them; then regenerate the CHECK vocabulary cache.
- **R.3** re-key live `website_question:` topic rows onto `ti:customer_question:<theme>` (§R l.1428-1445), collisions first.
- **R.4** retarget the m705 "First Appointment" badge to `SIGNED_AGREEMENT_APPOINTMENT` (§R l.1446-1460); default: shown unavailable.
- **R.5** (optional) drop the empty `title_company_users` table: nothing writes or reads it now; the block refuses if it is not empty.
- **R.6** (HELD — audit first) five deal tables accept an INSERT from any signed-in seat of a tenant, on any deal id, because the agent policy's WITH CHECK names only the tenant; the block aligns the CHECK with the deal and the roster with the deal desk. Not run, not yet tested live.

## 12. Engineering record (no owner action)

- FIXED this wave: the document door mirrors the live row rule (a laned title / lender / vendor opens only its own upload or the CDA
  delivered to it) and re-reads the seat on every click; stored long-lived signed URLs were removed in 154M (one hour max, view 5 min).
- Lane 155K: the appraiser packet send exists (7-day `appraiser_packet` share grant through the governed email egress) and needs
  P0-5; every outside send also needs the email provider key you have not set ("refused with its reason", never queued as sent);
  a packet with AI-web-search comparables is refused on purpose (CLAUDE.md §5). `/api/cron/local-intel` also visits tenants
  without a territory (first-party topics only) — expect `firstParty` counts on the first cron tick. m984 is integrator-applied.
- Lane 155L: six SIMULATED end-to-end scenarios run in `test:wave155-e2e-canaries`; nothing there is LIVE-VERIFIED.

## Decisions · owners · next steps

| # | Decision / action | Owner | Next step | Read-back that closes it |
|---|---|---|---|---|
| 1 | Apply §F + §G by route B | Owner | Storage → Policies, today | §J 1-3 |
| 2 | Apply §M.1 | Owner | SQL editor as storage admin | §N.1c = 3 RESTRICTIVE |
| 3 | Seeds: LINK (A) or ARCHIVE (B) | Owner decides; A recommended | §K Q8, then §I A | census 0 |
| 4 | Preview deploy, machine, domain | Owner | Vercel, preview first | R5 / R6 / M1 / M2 |
| 5 | Generate + set the encryption key | Owner | `openssl rand -hex 32` → Sensitive var | SEK status line |
| 6 | Counsel review + publish legal texts | Owner + counsel | before any live subscription | LEGAL status line |
| 7 | Licenses, keys, ceilings per provider | Owner | only providers you enable | LICENSES status line |
| 8 | Live probes on the preview | Owner | after 1-5 | LIVE-PROBES status line |
| 9 | §P.1 drop (optional); §R.1-R.5 | Owner | when needed | §P.1 `0 · 1`; §R read-backs |
| 10 | Flip stamps, re-run guards | Integrator | after each owner step | `test:release-blockers`, `test:production-readiness` |
