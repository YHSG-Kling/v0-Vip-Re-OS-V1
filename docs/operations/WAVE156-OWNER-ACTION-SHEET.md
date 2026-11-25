# Wave 156 — the owner's ordered action sheet (lane 156O, 2026-11-25)

**For:** the owner (privileged SQL, Vercel, counsel, provider accounts). **Prepared by:** wave 156, lane 156O. Nothing on this
sheet has been run by a lane or by the integrator. Every "Live today" fact below was READ (catalog reads and row COUNTS only,
no row contents) on project `hrvaqgvukzxfskkcrwbt` on 2026-11-25 between 16:09 and 16:20 UTC through the Supabase MCP
`execute_sql` as `postgres`. A lane can read; it cannot verify a deployment, a Vercel variable, a counsel sign-off or a
provider license — those are marked "not verifiable from this lane — owner step".

Required order (directive, mandatory final artifacts item 6): "critical Storage/Media policies; §R.6 if not applied; seed accounts; encryption; counsel; provider licenses/keys; environment/build/render hosting; first preview and actual smoked customer journeys."

`test:release-blockers` §H and `test:wave156-o` read this file: each step's **Category** must be one of the phrases above, in
that order; each step names who, a before read, the statement or console action, an after read, a rollback and what it
unblocks. Executable storage and seed SQL stays ONCE in `docs/operations/OWNER-SQL.md` (held verbatim to its migration files
by the guards); this sheet names the section and carries the exact before / after reads.

## The five release states (one source: `lib/platform/go-live-readiness.ts` `RELEASE_STATES`)

They are distinct. No state implies another; a simulated or local result never satisfies a live one; `SECURITY READBACK
GREEN` needs a dated read on the live project by a named reader; `PUBLIC RELEASE AUTHORIZED` needs the other four and the
owner's word. Write a row `MET` only with the evidence its rule names (origin one of `ci`, `local_chain`, `live_read`,
`counsel`, `owner`, `deployment`). The guard re-judges every row; a row it refuses prints NOT MET with the reason.

<!-- release-states:start -->
| State | Status | Date | Origin | Reader | Evidence |
|---|---|---|---|---|---|
| CODE GREEN | MET | 2026-11-25 | ci | integrator | head 962fa005: chain log final line GUARD_EXIT=0 (1,027 steps, 22:25–23:14 UTC); build run 45719879166 green, both halves |
| SECURITY READBACK GREEN | NOT MET | 2026-11-25 | live_read | lane 156O | read 2026-11-25: five private buckets open, listing-media 0 RESTRICTIVE, §R.6 not applied, 4 seed seats unlinked |
| LEGAL/LICENSING READY | NOT MET | — | — | — | no counsel sign-off and no provider license recorded |
| PREVIEW LIVE VERIFIED | NOT MET | — | — | — | no deployment exists |
| PUBLIC RELEASE AUTHORIZED | NOT MET | — | — | — | the owner has not said go; blockers are open |
<!-- release-states:end -->

The board at `/dashboard/superadmin/connectors` (Go-live readiness) answers configuration only; it names these five states
and no longer prints "GO". Nothing in the product or these documents may announce the OS as releasable while a blocker is open.

## Step 1 — the five private document buckets (OWNER-SQL §F, then §G, then §J)

- **Category:** critical Storage/Media policies
- **Live today:** `storage_bucket_policy_readiness()`: agent-documents, brokerage-forms, client-documents, offer-documents,
  transaction-documents = `open`; documents = `service_only`. 19 bucket-wide `auth …` policies on the five (3 + 4 + 4 + 4 + 4),
  0 owner policies, 39 policies on `storage.objects` in all. 0 objects in all 12 buckets. `storage.objects` is owned by
  `supabase_storage_admin`. Unchanged since the wave-155 read of 2026-11-19, and no migration since m988 touches it — §F / §G are still the right statements.
- **Who:** the owner, Supabase Dashboard → Storage → Policies (route B). Route A (SQL as `postgres`) was refused in wave 155.
- **Before:**
  ```sql
  select bucket_id, verdict, unscoped_policies from public.storage_bucket_policy_readiness() order by 1;
  -- expect five 'open' and documents 'service_only'
  select count(*) from storage.objects;  -- expect 0 (nothing stored yet: the only reason nothing has leaked)
  ```
- **Do:** OWNER-SQL §F route B (delete the 4 `auth … brokerage-forms` policies, create the 4 `brokerage-forms owner *`), then
  §G route B (delete the 15 `auth … <bucket>` policies, create the 7 `… owner …`; the offer bucket gets none, service-only).
- **After:**
  ```sql
  select bucket_id, verdict, unscoped_policies, missing_policies from public.storage_bucket_policy_readiness() order by 1;
  -- expect agent / brokerage-forms / client / transaction = owner_scoped; documents, offer-documents = service_only; every array empty
  ```
  Then OWNER-SQL §J steps 1-3 (0 bucket-wide, 11 owner policies) and the §F / §G impersonation checks.
- **Rollback:** a failed create leaves a bucket with no policy (every session refused, server unaffected) — stop and report.
  Undo only a broken apply: §G "Rollback" and §Q.2 (re-opens the exposure; say so).
- **Unblocks:** obligation O1; part of SECURITY READBACK GREEN. Integrator then flips m855 / m875 to APPLIED LIVE.

## Step 2 — listing-media RESTRICTIVE folder policies (OWNER-SQL §M.1, read-back §N.1c)

- **Category:** critical Storage/Media policies
- **Live today:** four PERMISSIVE listing-media policies (`Public can read`, `Agents can upload / update / delete listing
  media`), 0 RESTRICTIVE policies anywhere on `storage.objects`; `current_user_brokerage_id()` and `is_tenant_staff_seat()` exist.
- **Who:** the owner, SQL editor as `supabase_storage_admin` (or Dashboard → Storage → Policies).
- **Before:**
  ```sql
  select policyname, permissive, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects'
   and (coalesce(qual,'') || coalesce(with_check,'')) like '%listing-media%' order by 1;  -- expect 4 PERMISSIVE, 0 RESTRICTIVE
  ```
- **Do:** the §M.1 block as one transaction. Not §L L3 (superseded, too wide).
- **After:** the same query lists the 3 `listing-media tenant listing folder *` RESTRICTIVE rows beside the 4 permissive ones
  (§N.1c). Write §M.1's status line `- Status: RESOLVED <date> — N.1c shows the 3 RESTRICTIVE rows` (integrator edits OWNER-SQL).
- **Rollback:** `DROP POLICY IF EXISTS "listing-media tenant listing folder insert" ON storage.objects;` and the same for
  `… update` and `… delete` (the four permissive policies were never touched).
- **Unblocks:** obligation O1-LM; part of SECURITY READBACK GREEN.

## Step 3 — §R.6, the five deal tables' INSERT-side policies (if not applied)

- **Category:** §R.6 if not applied
- **Live today (NOT applied):** `transaction_participants`, `transaction_deadlines`, `transaction_title_escrow`,
  `transaction_repair_negotiations`, `transaction_timeline`: row security on (not forced), 2 policies each, 0 rows in all five.
  Every `trx_agent_*` CHECK reads `(brokerage_id = current_user_brokerage_id())`; every `trx_broker_*` names
  `broker, admin, super_admin, tc`. The text is exactly what §R.6 and the 156E packet recorded; the only migrations applied
  since 2026-11-20 are m1001, m1003, m1005, m1006, m1010, m1011, m1019 — none touches these tables' policies. Nothing supersedes §R.6.
- **Who:** the owner, Supabase SQL editor (`postgres`, the table owner).
- **Before:** packet `docs/operations/WAVE156-R6-DEAL-TABLE-POLICY-PACKET.md` §6 step 2:
  ```sql
  select tablename, policyname, cmd, with_check from pg_policies where schemaname = 'public'
   and tablename in ('transaction_participants','transaction_deadlines','transaction_title_escrow','transaction_repair_negotiations','transaction_timeline') order by 1, 2;
  -- expect 10 rows exactly as above; save the output — it is the rollback text. If it differs, STOP.
  ```
- **Do:** the `begin; … commit;` block of packet §3 verbatim (sha256 `41350c1715b02ece98c084a0deda6248420a4311e7b7b39a399fa521c99c47ad`,
  held by `test:deal-desk` §F). Ten `ALTER POLICY` statements, one transaction.
- **After:** packet §6 step 4 (expect 10 rows, every `trx_agent_*` `check_names_the_deal = true`, every `trx_broker_*`
  `roster_is_desk_tier = true`; five tables, row security on, 2 policies each), then the step-5 two-tenant script, which ends
  in ROLLBACK: the five "expect REFUSED" lines must read REFUSED.
- **Rollback:** packet §7, narrowest first: R-1 (widen one roster), R-2 (relax the agent CHECK to the tenant's deals), R-3
  (full revert — re-opens cross-tenant inserts; only on an explicit, recorded owner decision).
- **Unblocks:** obligation R6; part of SECURITY READBACK GREEN.
- **Status line** (read by `scripts/release-rules.ts` `r6AppliedLive`; it lifts R6 only when it reads `APPLIED LIVE <date> —`
  with the project id, the AFTER read-back's `10 rows` and the two-tenant `REFUSED` lines; a line describing a local or
  simulated measurement never lifts it):
- R6 status: HELD — not applied on the live project (read 2026-11-25); the PostgreSQL 16.15 measurement in the packet is evidence for the design, not for production

## Step 4 — the four portal seed identities (OWNER-SQL §I)

- **Category:** seed accounts
- **Live today:** 4 `users` rows typed `contact` with no linked Contact — ids `a0000000-0000-0000-0000-000000000013`, `…014`,
  `…015`, `…016`; all 4 `status = 'active'`; 0 sign-ins since 2026-11-01. Same four as the §I inventory.
- **Who:** the owner (data decision), SQL editor. Route A LINK is recommended; route B ARCHIVE leaves the census at 4 by design.
- **Before:**
  ```sql
  select count(*) from public.users u where u.user_type = 'contact'
     and not exists (select 1 from public.contacts c where c.contact_user_id = u.id);   -- expect 4
  ```
  and OWNER-SQL §K Q8 alone (`ok_pairs = 4`).
- **Do:** §I Remediation A (one block; returns exactly 4 rows or raises). Route B: §I Remediation B, then ban the four auth users.
- **After:** the Before query reads **0** (route A). Write §I's status line `- Status: RESOLVED <date> — census 0`.
- **Rollback:** §I Rollback A (restores exactly what A linked); Rollback B (`status = 'active'`). Neither deletes anything.
- **Unblocks:** obligation O2; part of SECURITY READBACK GREEN.

## Step 5 — `SECRETS_ENCRYPTION_KEY`

- **Category:** encryption
- **Live today:** the four secret stores (`agent_api_credentials`, `integration_credentials`, `platform_credentials`,
  `social_media_accounts` — `SECRET_STORE_COLUMNS`, `lib/security/credential-rotation.ts:161`) hold **0 rows**: 0 sealed,
  0 legacy plaintext. Nothing needs re-sealing; a fresh key loses nothing. Whether the variable is set in Vercel is **not
  verifiable from this lane — owner step**.
- **Code-side inventory:** one envelope (`lib/security/secret-crypto.ts`: AES-256-GCM, `enc:v1:`, writes fail closed with no
  key, reads try the current key then `SECRETS_ENCRYPTION_KEY_PREVIOUS`); one re-seal job (`lib/security/secret-migration.ts`
  `migrateLegacyPlaintextSecrets`, verified round-trip before replace; doors `app/actions/superadmin/secret-migration.ts` and
  the daily sentinel); the posture census `reportSecretStoragePosture`. Readers of the variable: 16 files under app/ and lib/
  (`grep -rln SECRETS_ENCRYPTION_KEY app lib`), including the share-link signer `lib/storage/signed-doc-url.ts`.
- **Who:** the owner only. Generate with `openssl rand -hex 32`; never paste it into chat, a ticket or the repository.
- **Before:**
  ```sql
  select 'platform_credentials' t, count(*) total, count(*) filter (where api_key like 'enc:v1:%' or access_token like 'enc:v1:%' or refresh_token like 'enc:v1:%') sealed from public.platform_credentials;
  -- expect 0 · 0 today (repeat for the other three stores; counts only, never values)
  ```
- **Do:** Vercel → Settings → Environment Variables: `SECRETS_ENCRYPTION_KEY`, Sensitive, Production and Preview. Keep one offline copy.
- **After:** on the preview (step 9): a lead-magnet share link carries `&g=enc%3Av1%3A…` and opens with no session (302); one
  character changed → 404. The Before query, after the first credential is connected, shows `sealed = total`.
  Write the wave-155 packet's `- SEK status: RESOLVED <date> — dpl_<id> share link 302, tampered 404`.
- **Rollback:** never delete the key once anything is sealed. Rotate: move the old value to `SECRETS_ENCRYPTION_KEY_PREVIOUS`, set the new one.
- **Unblocks:** obligation SEK; outside-recipient share links; storing any provider credential; part of PREVIEW LIVE VERIFIED.

## Step 6 — counsel: agreements, AI autonomy, data / provider schedule, privacy and marketing, forms rights, Fraud Network posting rules

- **Category:** counsel
- **Live today (acceptance machinery):** `platform_tos_acceptances` records email, `tos_version`, time, IP and user agent —
  **no content hash** of the accepted text (0 rows; `platform_settings.tos_version = '2026-07-01'`). `privacy_acceptances`
  records version, time and the acceptance text — no hash (0 rows). `contact_consent_events` records `consent_text_hash`
  and `consent_text_version` (0 rows). The six drafts under `docs/legal/` and `docs/operations/LEGAL-REVIEW-PACKET.md`
  (v0.1.0-draft, every file bannered DRAFT, held by `test:legal-packets`) are unreviewed. The Fraud Network posting rules are
  drafted at `docs/legal/PACKET-7-FRAUD-COMMUNITY-POSTING-RULES.md` (DRAFT, not published) and the nine questions on
  representation consent for counsel at `docs/legal/TCPA-REPRESENTATION-CONSENT-COUNSEL-MEMO-DRAFT.md` (DRAFT).
- **What counsel must approve (not legal advice — the list counsel works from):** the Platform Subscription and Services
  Agreement and its five schedules (AI autonomy and authority; acquisition, enrichment, data rights and third-party
  integration; privacy notice / DPA / subprocessors; acceptable use and marketing — including the directive's TCPA question
  on `lib/kernel/compliance/active-representation.ts`; tenant-owned provider connections); legal-forms rights; and the Fraud
  Network posting rules — defamation and evidence standards, dispute and takedown rights, whether any warning could be a
  consumer report (FCRA), fair-housing exposure, and state automated-decision laws that name housing (for example Colorado SB 24-205).
- **Who:** the owner with counsel. No lane edits or publishes legal text.
- **Before:**
  ```sql
  select tos_version from public.platform_settings where id = true;            -- today '2026-07-01'
  select count(*) from public.platform_tos_acceptances;                         -- today 0
  ```
- **Do:** counsel redlines and signs off (LEGAL-REVIEW-PACKET §8); the owner publishes the approved versions and bumps
  `tos_version`. The content hash is now built (wave 156, lane 156O round 2): both writers in
  `app/actions/public/tos-acceptance.ts` compute the sha256 of the served terms text server-side
  (`servedTermsDocument`, `lib/branding/platform-rights-notice.ts`) and refuse a version that is not the current one. It lands
  on the row: **m1066** (`content_sha256` on `platform_tos_acceptances` and `privacy_acceptances`) was applied on 2026-11-25
  after the read above and read back (both columns present, 0 rows). `privacy_acceptances` still has no writer.
  The hash is READ (round 3): the re-acceptance check asks again when the stored hash differs from the text served now (a row
  without a hash is labeled "text not fingerprinted" and not asked again; an unreadable row asks again), and the ToS
  Acceptance Log (`/dashboard/superadmin/tos-acceptances`) shows each row's version, accepted-at, hash and whether it covers
  the text served now.
  After m1066: `select count(*) filter (where content_sha256 is null) from public.platform_tos_acceptances where accepted_at > '<apply time>';` — expect 0.
- **After:** the wave-155 packet's `- LEGAL status: RESOLVED <date> — counsel sign-off <reference>, versions published`;
  `select tos_version …` reads the published version.
- **Rollback:** restore the previous text and version; never activate live billing on an unreviewed text.
- **Unblocks:** LEGAL; half of LEGAL/LICENSING READY.

## Step 7 — provider licenses, keys and spend ceilings

- **Category:** provider licenses/keys
- **Live today:** `platform_settings.provider_request_caps` is NULL (m1019 applied), so the RentCast cutoff is the code default
  of 1,000 successful requests per month. No provider license is recorded anywhere. Which keys are set in Vercel is **not
  verifiable from this lane — owner step**.
- **Who:** the owner. A paid smoke call happens only with your explicit approval, one lawful query per provider.
- **Before:**
  ```sql
  select provider_request_caps from public.platform_settings where id = true;   -- today NULL
  ```
- **Do:** choose providers from `docs/operations/WAVE156-PROVIDER-DECISION-PACKET.md`. Set the RentCast ceiling on the
  platform console (`/dashboard/superadmin/connector-healing`, RentCast panel — receipted `platform.provider_caps.set`).
  Fallback only if the console is unavailable:
  `UPDATE public.platform_settings SET provider_request_caps = jsonb_build_object('rentcast', jsonb_build_object('monthly_requests', <n>, 'set_by', '<your users.id>', 'set_at', now())) WHERE id = true;`
  Change `RENTCAST_USD_PER_REQUEST` to the chosen plan. Record Versium / Datafiniti terms before any key is set.
- **After:** the Before query shows your ceiling; the wave-155 packet's `- LICENSES status: RESOLVED <date> — license <providers> recorded, ceilings set`.
- **Rollback:** `UPDATE public.platform_settings SET provider_request_caps = NULL WHERE id = true;` (back to 1,000); unset a key and its door refuses with its reason.
- **Unblocks:** LICENSES; the other half of LEGAL/LICENSING READY.

## Step 8 — environment, build machine and render hosting

- **Category:** environment/build/render hosting
- **Live today:** no deployment exists; ledger rows M1 (build machine RAM) and M2 (custom domain) read NOT OBSERVED
  (`docs/operations/ACTIVATION-CHECKLIST.md` §6.7). Vercel project settings are **not verifiable from this lane — owner step**.
- **Who:** the owner (Vercel login; machine pricing is yours).
- **Before:** `npx tsx scripts/release-blockers-guard.ts` prints O3 and O4 RELEASE-BLOCKING with the open parts named.
- **Do:** Node 22.x; build command and install as `vercel.json` states; a build machine with RAM above the compile heap plus
  5120 MB off-heap (guard E4); the custom domain outside Deployment Protection; the environment names in
  `docs/operations/ENVIRONMENT-INVENTORY.md` (values never in the repository); render hosting per
  `docs/operations/WAVE156-RENDER-AND-QUEUE.md` once lane 156S lands it.
- **After:** ACTIVATION-CHECKLIST §6.7 rows M1 (`<machine>, <n> MB RAM`) and M2 (domain, `NEXT_PUBLIC_APP_URL`, `/login` 200)
  written OBSERVED with a date; the guard prints O3 / O4 discharged.
- **Rollback:** a preview is never live; revert a setting in Vercel.
- **Unblocks:** O3, O4; the build half of PREVIEW LIVE VERIFIED.

## Step 9 — first preview and the smoked customer journeys

- **Category:** first preview and actual smoked customer journeys
- **Live today:** no deployment; ledger rows R4–R8 NOT OBSERVED.
- **Who:** the owner, signed in, on a preview deployed from the commit whose chain log reads the chain's own exit line.
- **Before:** ledger rows R4–R8 read NOT OBSERVED; this sheet's PREVIEW LIVE VERIFIED row reads NOT MET.
- **Do:** deploy a preview; `GET /api/health` (commit matches); `/api/admin/health-status` as platform staff; one browser
  sign-in; one cron tick through `/api/cron/dispatch`; the storage JWT tests of steps 1–2; one linked seed sign-in (step 4); the
  share link 302 / tampered 404 (step 5); then the journeys in `docs/operations/WAVE155-DEMO-SCRIPT.md`: a buyer, a seller, one
  deal through e-sign and compliance, one finance step. Stop at the first failure and record it.
- **After:** ledger R4–R8 OBSERVED with `dpl_` / run ids; the wave-155 packet's `- LIVE-PROBES status: RESOLVED <date> — dpl_<id> …`;
  this sheet's PREVIEW LIVE VERIFIED row written MET with origin `deployment`.
- **Rollback:** Vercel → Deployments → previous READY → Instant Rollback; before the first promotion stay preview-only.
- **Unblocks:** LIVE-PROBES and PREVIEW LIVE VERIFIED; with every other state met, the owner may write PUBLIC RELEASE AUTHORIZED.

---

## Also — owner SQL that does not block release (run when convenient; each re-read live 2026-11-25)

### Also A — `compliance_events` approval rows append-only (lane 156B)

- **Live today:** row security on; four tenant policies exactly as 156B recorded; 0 `representation_review` rows. Still the right statement.
- **Who:** the owner, SQL editor (`postgres`, the table owner).
- **Before:** `select policyname, cmd, qual, with_check from pg_policies where schemaname='public' and tablename='compliance_events' order by 1;`
- **Do:** the three `ALTER POLICY` statements lane 156B wrote (its report, round 2 item 7; the integrator folds them into OWNER-SQL), one transaction:
  ```sql
  BEGIN;
  ALTER POLICY compliance_events_tenant_insert ON public.compliance_events
    WITH CHECK (((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())) AND is_tenant_staff_seat() AND gate_name <> 'representation_review');
  ALTER POLICY compliance_events_tenant_update ON public.compliance_events
    USING (((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())) AND gate_name <> 'representation_review')
    WITH CHECK (((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())) AND gate_name <> 'representation_review');
  ALTER POLICY compliance_events_tenant_delete ON public.compliance_events
    USING (((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())) AND gate_name <> 'representation_review');
  COMMIT;
  ```
- **After:** the Before query; insert / update / delete each end in `AND (gate_name <> 'representation_review'::text)`; select unchanged.
- **Rollback:** the three statements with the Before text (156B report, item 7 ROLLBACK).

### Also B — `brokerage_form_library` office and agent scope (lane 156C)

- **Live today:** m1005 is APPLIED (`location_id`, `scope_user_id` exist); the select policy and
  `brokerage_forms_registered_packet_readable(text)` do not yet read them; 0 library rows; 0 users with a `location_id`. Still the right statements.
- **Who:** the owner, SQL editor (`postgres`).
- **Before:** `select qual from pg_policies where tablename='brokerage_form_library' and policyname='brokerage_form_library_tenant_select';`
  and `select pg_get_functiondef('public.brokerage_forms_registered_packet_readable(text)'::regprocedure);`
- **Do:**
  ```sql
  BEGIN;
  ALTER POLICY brokerage_form_library_tenant_select ON public.brokerage_form_library USING (brokerage_id = current_user_brokerage_id() AND brokerage_forms_seat_active() AND ((is_brokerage_admin() AND COALESCE(current_user_type(),'') <> 'team_lead') OR ((team_id IS NULL OR team_id = resolve_team_id(auth.uid(), NULL::uuid)) AND (location_id IS NULL OR location_id = (SELECT u.location_id FROM public.users u WHERE u.id = auth.uid())) AND (scope_user_id IS NULL OR scope_user_id = auth.uid()))));
  CREATE OR REPLACE FUNCTION public.brokerage_forms_registered_packet_readable(p_name text)
   RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
  AS $function$
    SELECT coalesce(EXISTS (
      SELECT 1 FROM public.brokerage_form_library l
       WHERE l.storage_path = p_name
         AND split_part(p_name, '/', 4) = l.id::text
         AND l.brokerage_id = public.current_user_brokerage_id()
         AND (
              (public.is_brokerage_admin() AND coalesce(public.current_user_type(), '') <> 'team_lead')
           OR (l.team_id IS NOT NULL AND l.team_id = public.current_user_led_team_id())
           OR (l.is_active
               AND (l.license_expires_at IS NULL OR l.license_expires_at >= current_date)
               AND (l.location_id IS NULL OR l.location_id = (SELECT u.location_id FROM public.users u WHERE u.id = auth.uid()))
               AND (l.scope_user_id IS NULL OR l.scope_user_id = auth.uid())
               AND (l.team_id IS NULL
                    OR (l.team_id = public.resolve_team_id(auth.uid(), NULL::uuid)
                        AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = l.team_id AND t.deleted_at IS NULL))))
         )
    ), false);
  $function$;
  COMMIT;
  ```
- **After:** the two Before queries show the `location_id` / `scope_user_id` predicates.
- **Rollback:** `ALTER POLICY … USING (<the Before qual verbatim>)` and `CREATE OR REPLACE` the function with its Before definition.

### Also C — the retired global competitor-ads index (OWNER-SQL §P.1, two-tenant check §Q.3)

- **Live today:** `uq_competitor_ads_source_provider_id` (global, partial) and `uq_competitor_ads_tenant_source_provider`
  both present; 0 rows. Code needs nothing first: the only upsert (`app/api/cron/competitor-ads-exa/route.ts`) targets
  `brokerage_id,source_platform,provider_ad_id`; the Apify mirror inserts per tenant.
- **Who:** the owner, SQL editor. **Before / After:** §P.1 read-back (today `1 · 1`, after `0 · 1`). **Do:** `DROP INDEX public.uq_competitor_ads_source_provider_id;`
- **Rollback:** §Q.3's `CREATE UNIQUE INDEX uq_competitor_ads_source_provider_id ON public.competitor_ads USING btree (source_platform, provider_ad_id) WHERE (provider_ad_id IS NOT NULL);`

### Also D — `notification_rules.trigger_event` without the three retired events (OWNER-SQL §R.2)

- **Live today:** the CHECK admits 73 values; 48 rules over 15 events; 0 rules name `enrichment_failed`,
  `raw_lead_viability_passed` or `raw_lead_viability_failed`, and no code emits them (tombstones in `lib/kernel/events.ts`).
  The source of truth is the kernel event enum; `app/components/settings/NotificationRulesForm.tsx` takes free text and the
  CHECK refuses the rest, so no app change is needed first. §R.2's 70-value list equals the live list minus the three
  (`test:wave156-o` derives this from `scripts/check-vocabularies.ts`).
- **Who:** the owner, SQL editor. **Before / Do / After / Rollback:** §R.2 as written; then the integrator regenerates the CHECK vocabulary cache.

### Also E — `campaign_sequence_steps.channel` holds step kinds (OWNER-SQL §R.1) — HELD, code first

- **Live today:** the CHECK admits 25 values mixing channels (`email`, `sms`, `in_app`, `direct_mail`) with artifacts and
  steps (`video`, `newsletter`, `wait`, `condition`, `assign_task` …); 0 rows. No code under app/ or lib/ names `step_kind` yet
  (grep, 2026-11-25), and the files that read the table read `channel` (§R.1 counted 28 on 2026-11-20), so the rename would
  break the runtime. Source of truth: the step-kind vocabulary;
  the channel is derived per kind. Do nothing until the integrator lands the `step_kind` readers.
- **Who:** the owner, after the code. **Before / Do / After / Rollback:** §R.1 as written.

### Also F — training progress server-written only; `recruits` limited to the tenant-admin roster (OWNER-SQL §S.3, lane 156K)

- **Live today:** read 2026-11-25 — `video_completion_tracking` carries `vct_insert`, `vct_select`, `vct_update` and an ALL
  isolation policy; `recruits` carries one ALL policy, `recruits_brokerage_isolation`, which admits every signed-in user of
  the tenant — a Contact or a vendor seat included. The application already writes watch progress through the server after
  its gate, so the session INSERT / UPDATE policies have no remaining caller.
- **Who:** the owner, SQL editor (`postgres`, the table owner).
- **Before:** `select tablename, policyname, cmd, qual, with_check from pg_policies where tablename in ('video_completion_tracking','recruits') order by 1, 2;`
- **Do:** OWNER-SQL §S.3 as written (block A, then block B).
- **After:** the Before query shows `vct_select` plus a SELECT-only isolation policy, and `recruits_tenant_admin` plus `recruits_recruiter_read`.
- **Rollback:** §S.3's rollback lines (drop the three new policies, recreate the four originals verbatim from the Before read).

### Also G — the Fraud Network's private evidence bucket (OWNER-SQL §S.4, lane 156J)

- **Live today:** read 2026-11-25 — no `fraud-evidence` bucket and no `storage.objects` policy naming it. The network keeps a
  fingerprint of each evidence file and the evidence door answers "Evidence storage is not enabled yet".
- **Who:** the owner, SQL editor (`postgres` inserts the bucket row). No `storage.objects` policy is created: the bucket is service-only.
- **Before:** `select id, public from storage.buckets where id = 'fraud-evidence';` — expect 0 rows.
- **Do:** OWNER-SQL §S.4 as written; then the integrator regenerates `lib/storage/bucket-limits.ts`, which is what opens the upload door.
- **After:** the Before query returns one private row (10 MB, JPEG / PNG); `storage_bucket_policy_readiness()` lists it `service_only`.
- **Rollback:** `DELETE FROM storage.buckets WHERE id = 'fraud-evidence';` — only while it holds 0 objects.
- **Do not run before counsel signs the posting rules (step 6):** stored evidence about a named person is the part of the network with legal exposure.
