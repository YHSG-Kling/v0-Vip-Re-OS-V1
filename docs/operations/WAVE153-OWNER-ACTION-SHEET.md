# Wave 153 — owner action sheet

Every owner-only action left after wave 153, **in the order to do them** (lane 153L, closing, 2026-11-16). **No lane and no integrator
has run anything on this page.** Supabase project `hrvaqgvukzxfskkcrwbt`. The executable SQL is NOT restated here: it lives once,
verbatim, in `docs/operations/OWNER-SQL.md` (§F, §G, §I, §K, §M.1, §N, §O). Guards hold those sections to their source, and a second
copy could drift. This sheet gives, for each item: **what** is blocked, **where** to act, the **prerequisite**, the exact **action**,
the **read-back** to expect, the **risk** if skipped, **who** can do it, the **cost**, whether a **credential** is needed, and the
**canary** (or guard) that proves it afterwards.

**Where wave 153 stands (2026-11-16).** Engineering: every owner ruling of 2026-11-14 (1–17) and 2026-11-16 (B1–B14) that changed
code is certified in-repo by `test:production-readiness` (the wave-153 gate block). The integrated journeys run end to end, SIMULATED,
in `test:wave153-canaries`. Migrations m900 m901 m902 m905 m907 m931 m933 m949 m951 are APPLIED LIVE and were read back read-only on
2026-11-16 (columns, trigger, index, CHECK, defaults). Release: **NOT production-live.** No provider is activated and nothing was
purchased. No live provider call, mailing, outreach, deploy or billing action has happened. Lanes 153R (marketing-census gaps) and 153T (Datafiniti wiring, arbitration follow-ups,
retired scrapes) are integrated; the decisions they and the integration raised are in Priority 14.

Read-only measurements behind this sheet (lane 153L, 2026-11-16, Supabase MCP `execute_sql`, SELECT only; Vercel MCP read tools):
- `public.storage_bucket_policy_readiness()`: `agent-documents`, `brokerage-forms`, `client-documents`, `transaction-documents`,
  `offer-documents` = **open** (unscoped `auth …` policies; owner policies missing). `documents` = `service_only`.
- Portal seed accounts with no linked Contact (`users.user_type='contact'` and no `contacts.contact_user_id`): **4**.
- Vercel project `v0-supabase-client-initialization` (repo `v0-Vip-Re-OS-V1`): Node `24.x`, `live: false`, no custom domain. The last
  five deployments are all **CANCELED** previews from an old branch. **There is no production deployment.**
- `ai_isa_settings.require_broker_approval` column default = `false` (m951); 0 rows exist, so every tenant runs on the code default.

---

## 0 — Integrator steps before any owner step (not owner work, listed so the order is clear)

1. DONE — lanes 153R and 153T are integrated; their contract proofs are in `WAVE153_CONTRACT_PROOFS`
   (`scripts/production-readiness-guard.ts`) and the `MAINTENANCE_DOMAINS` row for `test:wave153-canaries` exists.
2. The generated docs are regenerated and the full chain runs once: `NODE_OPTIONS="--max-old-space-size=14336" npm run guard`,
   with `GUARD_EXIT` read from the log. This sheet is pushed only on `GUARD_EXIT=0`, so a pushed copy is itself that evidence.
3. After the push: watch build + guard CI on the pushed SHA (re-run `next-build` unchanged on exit 134; see CLAUDE.md §8).

---

## Priority 1 — O1: storage policies on the five private document buckets (OWNER-SQL §F, §G)

- **What is blocked:** cross-tenant isolation of stored documents. Until the policies exist, any authenticated session can read
  objects in the five buckets across tenants.
- **Where:** Supabase Dashboard → SQL editor (Route A) or Storage → Policies (Route B).
- **Prerequisite:** run OWNER-SQL §K Q1–Q6 (read-only). Q1 says which route works.
- **Action:** §F then §G exactly as written, each with its "Before" and "Verify afterwards" blocks; then the §J close-out.
- **Read-back:** `SELECT bucket_id, verdict, missing_policies, unscoped_policies FROM public.storage_bucket_policy_readiness() ORDER BY bucket_id;`
  — **expect** the four owner buckets `owner_scoped`, `documents` and `offer-documents` `service_only`, both arrays empty
  (measured today: five `open`).
- **Risk if skipped:** a document leak between tenants. This is release-blocking.
- **Who:** the owner (storage policies are owner SQL; a lane may not run them). **Cost:** none. **Credential:** Supabase dashboard login.
- **Proves it:** `npm run test:release-blockers` (O1 reads the m854/m855/m874/m875 stamps the integrator writes after your read-back)
  and `test:production-readiness` "OWNER OBLIGATIONS".

## Priority 2 — O1-LM: listing-media RESTRICTIVE folder policies (OWNER-SQL §M.1)

- **What:** `listing-media` folders — tenant staff only into their own listing folders, the assigned photographer only into its booked listing.
- **Where:** Supabase Dashboard → SQL editor, run as `supabase_storage_admin` (§M.1 says how).
- **Prerequisite:** Priority 1 done (same session, same read-back habit).
- **Action:** the §M.1 block, in one transaction. Then write §M.1's status line as `RESOLVED <date> — N.1c shows the 3 RESTRICTIVE rows`.
- **Read-back:** OWNER-SQL §N.1c — **expect** the three RESTRICTIVE rows.
- **Risk if skipped:** one tenant's staff or photographer can write into another listing's media. Release-blocking.
- **Who:** owner. **Cost:** none. **Credential:** Supabase dashboard login.
- **Proves it:** `test:release-blockers` (O1-LM reads the §M.1 status line through `listingMediaPoliciesResolved`).

## Priority 3 — O2: the four unlinked portal-contact seed accounts (OWNER-SQL §I)

- **What:** four `users` rows typed `contact` with no linked Contact (measured today: **4**). They can sign in to a portal that resolves to nobody.
- **Where:** Supabase SQL editor.
- **Prerequisite:** decide, per account, whether to link it to its Contact or remove it.
- **Action:** §I's census query, then link (`contacts.contact_user_id = <user id>`) or delete each account. Write §I's status line
  `RESOLVED <date> — census 0`.
- **Read-back:** §I census returns **0**.
- **Risk if skipped:** confusing portal sign-ins; test identities left in production data. Release-blocking.
- **Who:** owner. **Cost:** none. **Credential:** Supabase dashboard login.
- **Proves it:** `test:release-blockers` (O2 reads §I's status line).

## Priority 4 — O3: the first Vercel deployment (build machine, Node, domain)

- **What:** there is no production deployment. The project is `live: false`, has no custom domain, and its recent builds were canceled.
- **Where:** Vercel → project `v0-supabase-client-initialization` → Settings (General: Node.js Version; Build & Deployment: Build
  Machine; Domains), then Deployments.
- **Prerequisite:** item 0 (`GUARD_EXIT=0` on the pushed SHA and green CI). Read ACTIVATION-CHECKLIST §1.9 and §6.7 rows M1 / M2.
- **Action:** choose the build machine that matches the heap in `vercel.json` (ACTIVATION-CHECKLIST §6.7 M1). Confirm Node matches
  `engines` (observed: `24.x` on Vercel). Attach the custom domain (M2). Deploy a **preview** first. Promote to production only when
  you choose to (this wave authorizes no public release).
- **Read-back:** the deployment reads READY; `GET /api/health` answers 200 on the preview URL. Record M1 and M2 in ACTIVATION-CHECKLIST §6.7.
- **Measured on the pushed commit (2026-11-17, CI run 43986529213):** each half of the CI build peaks at 14.1–14.7 GB of memory
  on GitHub's free 15 GB runner. The first attempt stalled and was cancelled at 40 minutes; the unchanged re-run passed. The
  CI build gate is real but not reliable on that runner, and a whole-app build (what Vercel runs) needs more than a half does.
  Two machine choices follow, both yours and both paid: a larger GitHub runner for CI (repo variable `BUILD_RUNNER`, your
  2026-10-03 "Both" ruling), and a Vercel build machine with enough memory for the single pass (§6.7 M1). The full reading
  is in `.github/workflows/build.yml` (2026-11-17 entry).
- **Risk if skipped:** nothing is reachable; the render-route bundling fix (next.config tracing) is unproven until a real build.
- **Who:** owner. **Cost:** Vercel plan / build-machine pricing (yours to choose). **Credential:** Vercel login.
- **Proves it:** `test:release-blockers` (O3 = `deriveO3`: heap + Node + machine + domain).

## Priority 5 — Remotion: render hosting, company licence, bundled font

- **What:** video renders. The routes now trace sources, composition packages, compositor binaries and the bundled Inter font
  (`next.config.ts`). 34 of 34 compositions rendered playable **locally** (lanes 153J + 153Q, sandbox renders — not production).
  Expert advice (B14): keep `remotion` + `@remotion/renderer` + the composition packages actually imported. Do **not** install every
  Remotion package: it buys nothing the compositions use and grows the function bundle.
- **Where:** a hosting decision (Vercel function vs a dedicated render worker vs Remotion Lambda); remotion.dev → licensing.
- **Prerequisite:** Priority 4 (a real build proves the tracing fix).
- **Action:** (a) choose hosting. Recommendation: a dedicated render worker or Remotion Lambda for anything longer than a short reel —
  a long render inside a near-limit Vercel function is fragile. (b) Decide on the Remotion **company licence** (required for a company
  of your size; owner purchase, not authorized this wave). (c) Keep or veto the bundled Inter font (`public/fonts/inter`, SIL OFL 1.1,
  licence file included) — it replaces the font CDN at render time.
- **Read-back:** one authorized production render of `ComingSoonReel` → `remotion_composition_renders` row `succeeded` with
  `claimed_at` set (m933), and a playable file.
- **Risk if skipped:** renders fail on deploy, or are unlicensed.
- **Who:** owner. **Cost:** the licence and the render compute (yours to price). **Credential:** Remotion licence; AWS if Lambda.
- **Proves it:** `test:remotion-deploy-trace`, `test:render-queue-recovery`, then the live render read-back above.

## Priority 6 — Datafiniti People Data: licensing and key (B1)

- **What:** the connector is BUILT (client, producer, registries, RawData door, proofs) and **NOT activated**. It is
  `PROVIDER_ACTIVATION.datafiniti = dormant_pending_rights`, and both routes read "awaiting license". The rights gate refuses every
  pull before any call (canary D1).
- **Where:** Datafiniti account (datafiniti.co → plans; Web Portal → API token); the provider registry change is a reviewed code change.
- **Prerequisite:** read Datafiniti's data licence for multi-tenant SaaS use (resale, storage on tenant records, AI processing,
  outreach use, retention). m949 is applied. Note: m949 sorts before m975 but must stay applied **after** it. Re-running m975 would
  drop `datafiniti` from the CHECK.
- **Action:** decide the plan. Put `DATAFINITI_API_TOKEN` in the Vercel env yourself (never paste it in chat). Ask for the one-line
  activation change (`dormant_pending_rights` → `active` with the rights summary you read).
- **Read-back:** the free account-health read and a free count (`num_records: 0`) succeed. The first paid pull books one spend row.
- **Risk if skipped:** none to safety; no people data from this source.
- **Who:** owner. **Cost:** a Datafiniti plan (paid). **Credential:** yes — `DATAFINITI_API_TOKEN`.
- **Proves it:** `test:datafiniti-connector`, canary D1, then a supervised live smoke.

## Priority 7 — Nextdoor written agreement (B2) and the portal scraping holds

- **What:** Nextdoor fetches ride the Zyte / ZenRows transport (built) but are **held** as LICENSE_REQUIRED. Nextdoor's Member
  Agreement forbids unauthorized collection. The terms-restricted portal hosts (Zillow, Realtor.com, Redfin, Google, Facebook,
  classifieds) are held the same way.
- **Where:** a written agreement with the site; then a one-line reviewed change to `SCRAPE_TARGET_AGREEMENTS` in
  `lib/providers/scrape-checkpoint.ts` (reference, date, scope).
- **Prerequisite:** counsel reads the agreement (Priority 11).
- **Action:** record the agreement; the integrator adds the one line. Nothing else changes: the transport, robots, spend and freshness rules already apply.
- **Read-back:** canary X2 flips from `held_terms` to a fetched page for that host only.
- **Risk if skipped:** none; scraping that host stays off (the lawful default).
- **Who:** owner + counsel. **Cost:** whatever the site charges. **Credential:** none in the repo.
- **Proves it:** `test:online-hunting`, `test:scrapers`, canary X2.

## Priority 8 — Provider selection and keys (RentCast, Versium, Exa, Zyte, ZenRows, BatchData, PeopleData …)

- **What:** every row of the provider capability matrix reads **simulated**, **awaiting key** or **awaiting license** (canary P1:
  no row claims live). The 76-adapter census is a code fact, not 76 working connections.
- **Where:** `docs/operations/PROVIDER-SELECTION-WAVE151.md` §9 (generated matrix); each provider's own console; Vercel env (yours).
- **Prerequisite:** pick providers per lane (data provider first when it holds the fact — B3).
- **Action:** for each chosen provider: accept its terms, create the key, set the env variable yourself, then ask for a supervised smoke.
- **Read-back:** that provider's matrix row moves from simulated to verified only after a recorded live call.
- **Risk if skipped:** acquisition runs on simulated seams only.
- **Who:** owner. **Cost:** each provider's plan (paid). **Credential:** yes, one key per provider (never in chat).
- **Proves it:** `test:provider-gap-matrix`, canaries D1 / X1 / X2, then supervised smoke tests.

## Priority 9 — The lead-approval default is now OFF (owner ruling B7, m951)

- **What:** an arbiter-decided routine follow-up now goes out without a broker click, on every tenant (column default `false`; code
  default `require_broker_approval: false`). Consent, DNC, quiet hours, the content screen, the de-confliction rule and the explicit
  `approval_required` manager posture still hold. Money, offer, lender, signature and legal questions still go to a person.
- **How a broker turns approval back ON:** Settings → ISA calling → the **Lead follow-up approval** card
  ("Require my approval before the AI ISA sends a lead follow-up"). The switch writes `ai_isa_settings.require_broker_approval`
  through `saveAIISASettings` (tenant write roles and platform staff only; the tenant comes from the session), and
  `app/dashboard/voice/isa/page.tsx` reads the stored value. No support SQL is needed.
- **Read-back:** `SELECT require_broker_approval FROM public.ai_isa_settings WHERE brokerage_id = '<tenant id>';` → `true`.
- **Risk:** a broker who expects to approve every lead touch is not asked until they turn the switch on.
- **Who:** owner decides whether the default should be announced to tenants before launch. **Cost:** none. **Credential:** none.
- **Proves it:** `test:os-arbitration-canaries` (C13), canary L2.

## Priority 10 — Finance decisions still open (OWNER-SQL §O.6)

Each is built on its safe default. Nothing below needs SQL until you rule.
- **Brokerage-entity estimated taxes** (153A D1): today the planner estimates agents' / solos' quarterly reserves only, on rates the
  person enters. A brokerage entity's taxes stay with its accountant.
- **Per-campaign expense attribution** (153A D3): today expenses roll up by office; campaign cost is ad spend + direct-mail piece cost.
  Building it needs `business_expenses.marketing_campaign_id` + a receipt field + dedupe against `ad_performance`.
- **Commission statement document class** (153D D5): the required-documents packet uses the existing classes. Say whether a
  "commission statement" class must be on it.
- **Who:** owner. **Cost:** none. **Credential:** none. **Proves it:** `test:tax-planning`, `test:expense-office-rollup`,
  `test:closing-readiness` (each holds the current default).

## Priority 11 — Legal packets and counsel review

- **What:** the wave-151 platform-agreement drafts are drafts. Changes since then that counsel should read: QR scan tracking; receipt AI
  extraction; e-sign of proposed addenda; CD / TRID receipt handling (the lender's evidence, the agent's report); people data
  (Datafiniti); using an author's own published contact point from a public forum (B4 — recorded on the rule as your accepted risk);
  refurbished content on a self-attested licence; no-approval routine follow-up (B7).
- **Where:** counsel. **Prerequisite:** none. **Action:** counsel approves or amends; publish only approved text.
- **Read-back:** approved packet versions recorded in ACTIVATION-CHECKLIST.
- **Risk if skipped:** publishing unapproved terms. **Who:** owner + counsel. **Cost:** counsel's fees. **Credential:** none.
- **Proves it:** `test:operations-docs` (documents stay drafts until stamped).

## Priority 12 — OWNER-SQL §O read-backs and decisions (convergence rows)

- §O.1 row 9: the anonymous SESSION probe (privileged; the catalog half is verified). §O.2 row 85: the contract reader stays 0/0 until
  real executed contracts exist. §O.3 row 89: the first production run of the public-record facts is the live validation. §O.4 row 91:
  persist listing coordinates — options (a)/(b)/(c), your spend / usage-policy call. §O.5 rows 84 / 78: IDX photo licences.
- **Where:** OWNER-SQL §O. **Who:** owner. **Cost:** none for SQL; geocoding / IDX are paid choices. **Credential:** Supabase; IDX vendor.
- **Proves it:** `test:open-loop-ledger`, `test:release-blockers`.

## Priority 13 — Live smoke tests, only when you authorize them

After Priorities 1–4 (and the provider items you choose): one supervised smoke per channel and provider, with a budget you set.
- Email (SendGrid), SMS (Twilio), one direct-mail proof (Lob test mode first).
- One e-sign envelope; one Remotion render; one Datafiniti free count; one Exa search.
- **Each records:** the provider reference, the cost, and the ledger row. A smoke that is not recorded did not happen.
- **Cost:** per provider. **Credential:** each provider's key (set by you). **Proves it:** the provider's matrix row and the release
  ledger (ACTIVATION-CHECKLIST §6.7).

## Priority 14 — Smaller decisions recorded during integration (each is built on its safe default)

Nothing here blocks release. Each line says what the code does today; rule only where you want it changed.
- **A person's own published contact point is usable (B4).** Your ruling reverses a wave-151 compliance rule; it is recorded on the
  rule as your accepted risk. Counsel reads it under Priority 11.
- **Person search and court-filing scans** stay off: they are not part of "public chatter about a real-estate need" (B3). An
  **agent licence lookup** is the one named exception, because it reads a regulator's public register about a licensee.
- **Bundles do not start themselves.** `campaign_bundles` has no trigger column: the first item starts when a person chooses whom
  to send it to, and the arbiter starts each follow-on. Starting a bundle on an event (a listing status, a new Contact type) is a
  product decision and a migration.
- **Omnipresence spacing** uses the existing minimum-hours-between-touches guardrail (default 48 hours) between platforms for the
  same source, so four platforms take six days. There is no separate broadcast-spacing setting.
- **Refurbished content** runs on a licence the tenant states themselves; nothing verifies it.
- **SMS return on investment reads N/A** until a caller sends an SMS under a marketing campaign: the attribution step is built, but
  no sender passes a campaign yet (a bundle's SMS keeps its own bundle attribution). Podcast reach also reads N/A — listens are not
  read back from the host. No figure is invented in either place.
- **`LIFETIME_EDUCATION_DELIVERED`** is an older event name with no writer and no reader. The new in-transaction lesson uses
  `CLIENT_EDUCATION_DELIVERED`. Decide whether after-close education should ride that same event (then the old name is removed)
  or be built on the old one; it was reported, not touched.
- **Type-check memory.** The whole-project type-check now needs a 14336 MB cap, the last step a 16 GB machine can take. The durable
  fix is splitting the program with project references — an engineering task for a later wave, not an owner purchase.
- **`@remotion/google-fonts`** is no longer imported (the bundled Inter font replaced it) but is still listed in `package.json`;
  removing it is a dependency change left for your go-ahead.
- **Who:** owner. **Cost:** none. **Credential:** none. **Proves it:** `test:online-hunting`, `test:marketing-loops`,
  `test:campaign-bundle-follow-on`, `test:roi-outcome-ledger` (each holds the current default); canary L2.

---

## After you act

Tell the integrator which items you did. The integrator re-runs the read-backs read-only, writes the stamps / status lines the guards
read, and re-runs `test:release-blockers` and `test:production-readiness`. "OWNER OBLIGATIONS: 0/5 RELEASE-BLOCKING" is the release
signal; CI green alone is never production-live.
