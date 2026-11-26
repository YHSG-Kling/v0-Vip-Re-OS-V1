# Wave 152 — owner action sheet

Prioritized owner actions after wave 152 (lane 152L, closing, 2026-11-12). **Nothing on this page has been run by a lane or by the
integrator.** Supabase project `hrvaqgvukzxfskkcrwbt`. The executable SQL is NOT restated here: it lives once, verbatim, in
`docs/operations/OWNER-SQL.md` (§F, §G, §I, §K, §M.1, §N) — guards hold those sections to their source, and a second copy could
drift. This sheet gives the order, the exact place in each product UI, the read-back you should expect, and how the repository
records that the item is done (which is what `npm run test:release-blockers` and `npm run test:production-readiness` read).

**Where wave 152 stands.** Engineering: every wave-152 requirement that changed code is certified in-repo by
`test:production-readiness` (the wave-152 gate block) and exercised end to end, SIMULATED, by `test:wave152-canaries`. Release:
**NOT production-live.** Open owner obligations today: **O1** (five document buckets), **O1-LM** (listing-media), **O2** (seed
accounts), **O3** (deployment build). **O4** (install parity) is discharged on the code side. None of the nine C42 release rows
(R1–R9) is observed on this tree. No provider is activated, nothing was purchased, and no live provider call has been made.

---

## Priority 1 — O1: storage policies on the five private document buckets (OWNER-SQL §F, §G)

**Why it blocks:** until these policies exist, an authenticated browser session can read objects across tenants in
`brokerage-forms`, `client-documents`, `transaction-documents`, `agent-documents` and `offer-documents`.

1. Read-only first: run OWNER-SQL §K Q1–Q6 in the Supabase SQL editor (or ask the integrator to run them through Supabase MCP
   `execute_sql`). Q1 tells you which route you can use.
2. §F (`brokerage-forms`): run "Before", then **Route A** (SQL editor) only if Q1 shows `can_alter_storage_objects = true`;
   otherwise **Route B**: Supabase Dashboard → Storage → Policies → create each policy exactly as §F lists it.
3. §F "Verify afterwards", then §G (the four document buckets + the offer row) the same way, then §G "Verify afterwards".
4. Read-backs (OWNER-SQL §N.1a / §N.1b):
   - `SELECT bucket_id, verdict, missing_policies, unscoped_policies FROM public.storage_bucket_policy_readiness() ORDER BY bucket_id;`
     **expect** `agent-documents`, `brokerage-forms`, `client-documents`, `transaction-documents` = `owner_scoped`;
     `documents`, `offer-documents` = `service_only`; both arrays empty. (Before: the five buckets read `open`.)
   - §N.1b census: **expect** `bucket_wide_on_five = 0` and `owner_policies = 11` (before: ≥ 19 and 0 — if it reads 0 while
     §N.1a still says `open`, the census is blind; stop and tell the integrator).
5. Run the §J close-out in order. **Repository record:** the integrator stamps `m854`, `m855`, `m874`, `m875` line 1
   `APPLIED LIVE <date>` and lowers `NOT_APPLIED_BASELINE` in `scripts/migration-claim-guard.ts`; ledger row **R9** in
   `docs/operations/ACTIVATION-CHECKLIST.md` §6.7 gets the readiness-function output. O1 closes only on those stamps.

## Priority 1b — O1-LM: the `listing-media` RESTRICTIVE folder policies (OWNER-SQL §M.1)

**Why it blocks:** today any authenticated seat of a tenant (a contact or any vendor) may write into any listing folder of that
tenant. §M.1 admits tenant staff into their own listing folders and the assigned photographer into exactly its booked listing.

1. Supabase Dashboard → Storage → Policies (or the SQL editor connected as `supabase_storage_admin` — `postgres` is refused 42501).
2. Run the §M.1 block exactly as written (one transaction).
3. Read-back §N.1c: **expect** the three RESTRICTIVE rows `listing-media tenant listing folder insert / update / delete`
   beside the four existing PERMISSIVE rows.
4. **Repository record:** change OWNER-SQL §M.1's status line to
   `- Status: RESOLVED <YYYY-MM-DD> — N.1c shows the 3 RESTRICTIVE rows`. `test:release-blockers` (B′) and
   `test:production-readiness` (O1-LM) read that line through one shared rule (`scripts/release-rules.ts`
   `listingMediaPoliciesResolved`); a line without the date or without the read-back does not close it.

## Priority 1c — the private `receipts` bucket (read-back only, no action expected)

Lane 152D's receipts are uploaded and read through the service client only. Read-back §N.1d: **expect** `public = false`
(or no row before the first receipt) and **0** `storage.objects` policies naming `receipts`. A policy row there means a browser
session door exists — tell the integrator. No owner SQL is needed for this bucket.

## Priority 2 — O2: the four unlinked portal-contact seed accounts (OWNER-SQL §I)

1. Run §K Q7, then Q8 **alone**, then Q9 (read-only; no email is selected).
2. **Expect** Q7 = 4 rows (`a0…13` … `a0…16`), Q8 `ok_pairs = 4`, Q9: `…14` last signed in 2026-04-02, the other three never,
   0 invitations.
3. If Q8 reads 4: run §I **REMEDIATION A** (link) as one block — it returns exactly 4 rows or raises; keep §I ROLLBACK A beside
   it. If you decide these identities must never sign in, run **REMEDIATION B** (archive, reversible, no deletion) instead. If Q8
   reads anything else: stop and re-decide — never link on a drifted pairing.
4. Afterwards Q7 must read **0** rows.
5. **Repository record:** flip §I's status line to `- Status: RESOLVED <YYYY-MM-DD> — census 0` (the date and the zero are
   required by both guards).

## Priority 3 — O3 / O4: hosting, domain, deployment, real smoke

What the repository states (derived by `scripts/release-rules.ts`, printed by `test:release-blockers`):

| Fact | Stated in the repo | Observed live |
|---|---|---|
| Build pass and heap | `vercel.json`: single pass at 16384 MB (the CI compile cap that aborted is 14336 MB) | not observed — no Vercel build of this tree exists (ledger R4) |
| Node major | `package.json` engines 22.x = CI 22 | not observed on Vercel |
| Build machine RAM | must hold the heap + off-heap | NOT OBSERVED (ledger M1: RAM not reported) |
| Custom production domain outside Deployment Protection | required | NOT OBSERVED (ledger M2: only *.vercel.app domains attached, 2026-11-06) |
| Install (O4) | Vercel runs `npm` against a lockfile that covers every dependency; CI runs `npm ci` frozen | discharged on the code side; the first Vercel build of it is R4 |

Steps (owner; each needs your authorization — the platform does not deploy itself):
1. Vercel → Project → Settings → Build & Development → **Build Machine**: choose one whose RAM holds the configured heap plus
   off-heap; record its RAM in ACTIVATION-CHECKLIST §6.7 row **M1**.
2. Vercel → Project → Settings → **Domains**: attach the production custom domain outside Deployment Protection; record it in
   row **M2**.
3. Configure the deployment's environment by NAME (never paste a value into the repository or a chat): `NEXT_PUBLIC_APP_URL`,
   `SECRETS_ENCRYPTION_KEY`, `CRON_SECRET`, and the provider keys you decide to activate (Priority 4).
4. Authorize one preview deploy of the release commit, then record, each with the ids the owner can re-open (`dpl_…`, `wrun_…`,
   run ids): **R4** clean build, **R5** preview deploy + production smoke, **R6** one real browser sign-in, **R7** an observed
   Vercel Workflow timer, **R8** an observed cron tick through Deployment Protection; re-run the full guard chain on that commit
   for **R1–R3**.
5. **Expect** `test:release-blockers` to print `O3 … discharged` and `RELEASE GATES: 9 of 9 C42 rows observed` only after all of
   the above; `PRODUCTION-LIVE: YES` additionally needs O1, O1-LM and O2 discharged. CI green alone is never production-live.

## Priority 4 — providers, keys, rights, pilot cost, tenant accounts (nothing is selected or activated)

`PROVIDER_SELECTION_STATUS.selected` is `null`; the paid pilot cap is **not approved** (OWNER-SQL §N.4 L6.6). Each item below is a
decision of yours; nothing in the code fakes it. Names only — never a value.

| Capability | What waits | Where you act | Expected readback |
|---|---|---|---|
| Acquisition (platform) | provider selection (L6.5 / L6.6); `BATCHDATA_API_KEY` activation | Vercel env (owner) + the platform caps (`platform_settings.acquisition_budget_caps`; null means stop) | the acquisition plan shows BatchData's own count from paid pulls once any runs; every platform-paid pull refuses until caps are set |
| Acquisition (tenant-owned) | a tenant's own BatchData token under its own license | the tenant: Settings → Integrations → Lead sources | the panel reads "Connected" only after the free account read confirms it |
| Proposed-addendum signatures | an e-sign provider credential (the platform's DocuSign default or a tenant's own connection) | Vercel env / the tenant's Settings → Integrations | a SANDBOX envelope in the provider's demo account shows buyer then seller; the request row moves sent → completed |
| Document / receipt reading | the AI gateway credential and the routed vision lane | Vercel env (owner) | a test receipt photo returns page-located values held for review; nothing posts without approval |
| Receipt auto-post | an approved grant (default: none) | your ruling; the integrator writes `receipt_autopost:receipt:max_usd=<n>` on finance_manager's policy row | without it every receipt is reviewed by a person |
| QR region on mail | `LOB_TEST_API_KEY` and the four `LOB_*_TEMPLATE_ID` layouts printing `qr_destination_url` | Lob dashboard (TEST mode) + Vercel env | one TEST proof per format shows the code and its token; no live mailing |
| IDX saved homes outside the account's sets | IDX Broker BulkData (a separate agreement + MLS approval) — default: no | IDX Broker | those homes stay held by name |
| Saved-home metered re-reads | a tenant-approved `rentcast_saved_home_recheck` plan line, or your platform-paid ruling (L6.10) | plan approval | re-reads stay HELD and recorded until then |

## Priority 5 — legal sign-off (review the EXISTING draft packets; do not rewrite them)

The draft packets (`docs/legal/PACKET-*`, reviewed through `docs/operations/LEGAL-REVIEW-PACKET.md`) are DRAFT — NOT APPROVED.
Ask counsel to approve them, and to confirm these wave-152 behaviors are covered by the existing terms (add a clause only where
counsel says one is missing):
1. **QR tracking:** a scan stores the referring host, a coarse device class, a traffic class and a one-way daily visitor key —
   never a raw IP address or full browser string; a scan never creates a Contact; consent comes only from the form.
2. **Document and receipt AI:** uploaded receipts, contracts and statements may be read by a routed AI vision provider; values are
   drafts held for a person; the AI summary is labelled a reading aid, not a record; the spend is booked to the account.
3. **AI autonomy:** the arbiter may hold, hand off or time a message; a spoken financial confirmation counts only against a
   persisted read-back; every decision is audited.
4. **E-signature on proposed addenda:** signer routing (the other side signs through its own agent), the provider's attestation
   as the signature record, the signed copy's hash.
5. **Closing Disclosure wording:** the platform compares and requests; the lender / title company / closing attorney issues and
   corrects official documents; the corrected-CD vs new-waiting-period distinction (12 CFR 1026.19(f)(2)) and escalation to the
   lender when the documents do not decide it.
6. **Receipt retention** in the private `receipts` bucket.
**Repository record:** approval is a recorded act through the existing approval gate (`platform_contract_templates` approval
columns, m959); nothing activates a draft.

## Priority 6 — decisions still open (each already built on a safe default; nothing waits on code)

Full text and the exact questions: OWNER-SQL §N.3 / §N.4 and the lane notes. In short:
- **L6.4** — may the CDA coach repeat the agent's own entered figures? (default: yes, never engine-computed amounts)
- **L6.13** — CDA policy change: which moment decides a deal's policy (default: the deal's `created_at`), future-dating (no),
  who switches one deal (the brokerage-wide finance admin), an approved CDA on opt-out (kept)
- **Addendum evidence — refuse or flag** (default: record + HOLD); **152E D2** (a later settlement date without an executed
  extension — default: flag, not hold); **D3** (team-lead override — default: no)
- **152G D2–D5** — one governed waiver may satisfy the settlement hold (yes); which missing terms block (price, EMD, seller
  credit, agent credits); the settlement hold also at CDA brokerages (yes); an unread transaction-documents statement holds (yes)
- **152F** — which money terms need the broker before signature (commission terms only); request expiry (14 days)
- **152D** — receipt auto-post grant (none); narrowing receipt documents under RLS to the uploader or a finance admin (proposal)
- **152A** — what makes payer wording "brokerage" (the tenant's own plan tier); the provider-failure re-check window (6 hours)
- **152C** — the external QR destination allow-list (six hosts); who may retire a code; the repeat window
- **Row 71** — bundle follow-on items as sequence steps (proposal: one additive column; default: order only)
- **Row 91** — persist listing coordinates through the free geocoder (adds a third-party call per listing write)
- **L6.1, L6.5–L6.12** — carried unchanged (OWNER-SQL §N.4)

---

After anything on this page is done, ask the integrator to run, in order: `test:release-blockers`, `test:production-readiness`,
then the full guard chain at 12288 MB (CLAUDE.md §7). The release verdict changes only when the stamps, status lines and ledger
rows above say so — never because this page was read.
