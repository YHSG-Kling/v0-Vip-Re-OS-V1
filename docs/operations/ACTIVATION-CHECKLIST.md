# Owner activation checklist (wave 143, lane 143H)

The ordered list of what only the owner can do to turn VIPAgents from "built and proven in-memory" into a live product — and, for each step, the exact command or proof that shows it worked. Nothing here has been done: **wave 143 changed no Vercel setting, created no key, no Stripe product or price, bought no provider and activated no billing** (owner ruling). Every step is either an owner action in a console the repository cannot reach, or a verification you can run from your own shell with a value that never leaves it.

Order matters: **1 → 2 → 3 → 4 → 5 → 6.** Each later step assumes the earlier ones. Use the *inventory* (`docs/operations/ENVIRONMENT-INVENTORY.md`) for every environment name, the *certification* (`docs/operations/PROVIDER-CERTIFICATION.md`) for every provider contract and webhook URL, and the *owner SQL* (`docs/operations/OWNER-SQL.md`) for the held statements.

Conventions. **Owner action** = what you do. **Verify** = how you know. A verification that spends money or sends a message says so and names the safe form. `<prod>` is your production origin (the value of `NEXT_PUBLIC_APP_URL`). Never paste a secret into a chat, a ticket or a commit — the commands below read secrets from your own shell.

## 1. Vercel environment

### 1.1 Confirm the plan and project settings the code depends on
- **Owner action:** In the Vercel project, confirm: (a) the plan allows a **per-minute cron** (`vercel.json` schedules `/api/cron/dispatch` every minute — a once-a-day limit would silently switch the whole autonomy layer off); (b) **Fluid compute / function duration** accepts `maxDuration` 600 (three routes declare it) and 3008 MB for the five render routes; (c) the **Node.js major version** is set (the repo pins none); (d) **Deployment Protection** does not cover the production origin the dispatcher calls itself on (it fans out to `CRON_DISPATCH_BASE_URL`, else `VERCEL_PROJECT_PRODUCTION_URL`, else `VERCEL_URL`); (e) decide the lockfile policy (finding F-1: `--no-frozen-lockfile` today).
- **Verify:** after the first deploy, from your shell: `curl -s -H "Authorization: Bearer $CRON_SECRET" https://<prod>/api/cron/dispatch` prints `{"ok":true,"registered":…,"due":N,"dispatched":N,…}` with `dispatched` equal to `due` apart from long-running jobs (finding F-3 reports those as "timeout"). A protected origin returns a Vercel HTML page instead — that is the failure this step catches.

### 1.2 Generate and set the core secrets
- **Owner action:** Generate (for example `openssl rand -hex 32`, one distinct value per name) and set in Vercel → Environment Variables → Production: `CRON_SECRET`, `INTERNAL_API_SECRET`, `SECRETS_ENCRYPTION_KEY` (64 hex characters — **store a copy offline: losing it makes every stored provider credential unreadable**), and, if the workflow door is used, `WORKFLOW_WEBHOOK_SECRET`. `INTERNAL_API_SECRET` and `WORKFLOW_WEBHOOK_SECRET` are cross-tenant master keys — treat as platform credentials (`docs/SERVICE-SECRETS.md`).
- **Verify:** `vercel env ls production` lists the names (never the values). In the product: Superadmin → Connectors → Launch checklist shows `cron_auth` configured; the tenant readiness contract stops blocking `requiredSecurityState` (`lib/kernel/tenant-readiness.ts`, readiness blocker B1).

### 1.3 Supabase connection and the canonical origin
- **Owner action:** Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase → Project Settings → API (project `hrvaqgvukzxfskkcrwbt`); set `NEXT_PUBLIC_APP_URL` to the **https production origin** (every webhook registration, magic link and QR code resolves against it). `NEXT_PUBLIC_*` values are inlined at **build time** — redeploy after changing them.
- **Verify:** Superadmin → Go-Live Readiness: domains `database`, `storage` and `app_url` read ready; Launch checklist row `supabase_core` is configured (`app/actions/superadmin/go-live-readiness.ts`, `lib/platform/go-live-readiness.ts`).

### 1.4 The AI route
- **Owner action:** Create the Vercel AI Gateway key and set `AI_GATEWAY_API_KEY`. Check every model slug the code defaults to resolves in the Gateway catalog — in particular `DOCUMENT_AUDIT_VISION_FALLBACK_MODEL` defaults to an old-generation snapshot (`anthropic/claude-3-5-sonnet-20241022`); set the variable to a current slug if it does not resolve. Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` only if a direct route is wanted.
- **Verify:** Go-Live Readiness domain `ai_gateway` reads ready; `npm run test:provider-adapter` (adapter + gateway routing proof, no network); AI cost lands in `ai_tool_usage` (that table is the invoice — a wrong number there is a wrong invoice).

### 1.5 Leave four names unset
- **Owner action:** Do **not** define `NEXT_PUBLIC_DEMO_MODE`, `NEXT_PUBLIC_DEMO_PASSWORD`, `INBOUND_SKIP_SIG_VERIFY`, `ALLOW_PROD_MAINTENANCE_ROUTES` in Production. Each is gated off in code (the guard proves the gate), but absent is the stronger posture. Also delete the retired names if an older project carries them: `DOTLOOP_API_KEY`, `DOTLOOP_PROFILE_ID`, `VAPI_ISA_ASSISTANT_ID`.
- **Verify:** `vercel env ls production | grep -E 'DEMO_MODE|DEMO_PASSWORD|INBOUND_SKIP_SIG_VERIFY|ALLOW_PROD_MAINTENANCE_ROUTES'` prints nothing.

### 1.6 Sender identity
- **Owner action:** Set `SENDGRID_FROM_EMAIL`, `OUTBOUND_EMAIL_FROM` and `NEWSLETTER_FROM_DOMAIN` to an address/domain you have **authenticated in SendGrid** (Settings → Sender Authentication). Two of them ship with literal fallbacks (`noreply@vipre.io`, `platform.com`) that are not yours to send from.
- **Verify:** SendGrid shows the domain as authenticated; send one test message to a seed inbox and read the SPF/DKIM/DMARC results in the headers.

### 1.7 Domain, certificate and response headers
- **Owner action:** Add the production domain in Vercel → Domains; wait for the certificate. For tenant custom domains (optional) create a Vercel API token and set `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` — without them the app returns manual DNS instructions and never a fake success.
- **Verify:** `curl -sI https://<prod> | grep -iE 'strict-transport-security|x-content-type-options|referrer-policy'` shows all three (`nosniff` and the referrer policy come from `next.config.ts`; HSTS is the Vercel edge default and is **verified here, not assumed**). If HSTS is missing, add it in Vercel's header rules — do not add `includeSubDomains` for tenant domains.

### 1.8 Post-deploy smoke
- **Owner action:** After steps 2.x, run the post-deploy smoke ritual once (`PRODUCTION-READINESS.md` § "The post-deploy smoke ritual").
- **Verify:** `npm run test:production-smoke` (live-fires a fresh tenant through provision → market → lead → portal and cleans up after itself — run it only against the production database **after** the Supabase steps, and expect it to create and remove one tenant).

## 2. Supabase privileged migrations

### 2.1 Backups before the first real tenant
- **Owner action:** In Supabase → Database → Backups confirm the plan's retention and enable point-in-time recovery if the plan offers it.
- **Verify:** the dashboard shows a recent backup and the PITR window; record both in the launch note (the repository cannot see them).

### 2.2 m739 — drop three superseded indexes (owner SQL)
- **Owner action:** Run script A in `docs/operations/OWNER-SQL.md` in the SQL Editor.
- **Verify:** the *after* query in that section lists only the `extension_listings` indexes.

### 2.3 m771 — drop the Airtable remnant column (owner SQL)
- **Owner action:** Run the *before* count (must be `0`), then script B in `docs/operations/OWNER-SQL.md`.
- **Verify:** the *after* query returns no row; then `npm run schema:regen` and `NODE_OPTIONS=--max-old-space-size=6000 npm run test:schema-cache-drift` are green.

### 2.4 m795 — decide, then apply
- **Owner action:** Decide whether tenant safety findings are a tenant or a platform surface (OWNER-SQL §C). Apply only together with the app change that re-homes its three readers.
- **Verify:** `select policyname, qual from pg_policies where tablename = 'tenant_safety_findings'` shows `is_platform_staff()`; the platform console lists findings; no tenant admin page reads `[]`.

### 2.5 Apply the migrations the lanes wrote
- **Owner action:** Authorise the integrator to apply every `WRITTEN, NOT APPLIED` file that is not owner SQL, one statement per MCP call, never in parallel — wave 143 adds `m840` (doc_type spelling) and `m841` (nullable tenant timezone) plus the other lanes' files.
- **Verify:** each file's own verification query; then `npm run schema:regen`; `npm run test:migration-claim` shows the not-applied count falling by one per file; newest ledger version advances (note: `execute_sql` leaves no ledger row, see PRODUCTION-ARCHITECTURE §15.2).

### 2.6 Auth URL configuration
- **Owner action:** Supabase → Authentication → URL Configuration: set the Site URL to `NEXT_PUBLIC_APP_URL` and add the production origin to the redirect allow-list.
- **Verify:** sign in on `https://<prod>` end to end (email link or OAuth) and land on the dashboard, not a localhost or preview URL.

### 2.7 Storage limits
- **Owner action:** Supabase → Storage → Settings: confirm the project's **global upload size limit** is above your largest planned rendered video (`video-assets` has no bucket cap; `listing-media` is capped at 50 MB by its bucket).
- **Verify:** upload a file just under the limit through the app's media door and confirm it succeeds.

### 2.8 Live cache verification
- **Owner action:** From a shell holding the service key: run the guards that CI cannot (CI has no database credential).
- **Verify:** `NODE_OPTIONS=--max-old-space-size=6000 npm run test:schema-cache-drift` and `npx tsx scripts/migration-ledger-guard.ts` print no failure (a stated SKIP means credentials were absent — that is not a pass).

## 3. Stripe products and prices

> **Owner ruling (wave 143):** prices are not set and no Stripe product or price exists. The code refuses every money move with `price_not_configured` until they do (readiness blocker B3). Take the pricing from `docs/commercial/PRICING-RECOMMENDATION.md` (lane 143I) and decide.

### 3.1 Decide the prices and allowances
- **Owner action:** Choose plan prices, seat package price, metered AI-overage terms, setup fees and vendor prices; enter them through the superadmin plan catalogue (`upsertPlanTierAction`, `upsertAIOverageTermsAction` in `app/actions/superadmin/plan-catalog.ts`) — **no price is a code literal**.
- **Verify:** `npm run test:plan-catalog` and `npm run test:billing-convergence`; a tier with a price reads configured in the catalogue UI.

### 3.2 Create the Stripe products and prices — in TEST mode first
- **Owner action:** With a Stripe **test** secret key set, use the platform's own publish tools (`publishTierToStripeAction`, `publishOverageMeteredPriceAction`, `publishCouponToStripeAction`; `app/actions/superadmin/plan-catalog.ts:199,374`, `coupons.ts:415`) rather than hand-creating objects, so the catalogue and Stripe cannot drift.
- **Verify:** `syncCatalogFromStripeAction({ dryRun: true })` reports no difference; a test-card checkout completes and the subscription row appears.

### 3.3 Register the two webhook endpoints with the EXACT paths
- **Owner action:** In Stripe → Developers → Webhooks register `https://<prod>/api/billing/webhook` (tenant billing — **not** `/api/webhooks/stripe`, which is a 404) and `https://<prod>/api/webhooks/stripe/vendor` (vendor marketplace). Copy each endpoint's own signing secret into `STRIPE_WEBHOOK_SECRET` and `STRIPE_VENDOR_WEBHOOK_SECRET` respectively — a secret verifies only the endpoint it was minted for. The event list for the first is `TENANT_BILLING_WEBHOOK_EVENTS` (`lib/billing/stripe-account-scope.ts:367`).
- **Verify:** use the on-demand drift check on the Launch checklist (`checkStripeWebhookEventsAction`; repair with `registerStripeWebhookEventsAction`); Stripe → "Send test webhook" returns 2xx; `npm run test:stripe-account-scope`.

### 3.4 Switch to live keys
- **Owner action:** When ready for real money: set `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to the **live** pair, re-register both webhooks in live mode and replace both signing secrets. Tenant Stripe accounts are connection rows in the database — never environment variables.
- **Verify:** Go-Live Readiness domain `stripe` reads ready against the live account (and `stripe_tenant_accounts` for connected tenants); `app/api/cron/stripe-drift/route.ts` runs clean on its next tick; one real low-value charge and refund by the owner.

## 4. Provider keys

### 4.1 The four required platform lanes
- **Owner action:** Set the platform keys for **voice/SMS** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`), **email** (`SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`), **payments** (section 3) and **AI** (§1.4). The readiness contract BLOCKS `providerState` while any required lane is dark at platform level.
- **Verify:** Superadmin → Connectors shows each lane configured; Go-Live Readiness domains `twilio_master`, `email`, `email_deliverability`, `stripe` and `ai_gateway` read ready (the readiness contract names the four lanes by provider category: `voice_sms`, `email`, `payments`, `ai_llm`).

### 4.2 Twilio: numbers, A2P registration, webhooks
- **Owner action:** Register the brand and campaign for A2P 10DLC (a platform job; tenants get subaccounts), buy/assign the platform number, and set the Twilio callbacks to the paths in `PROVIDER-CERTIFICATION.md` §3 (`/api/voice/twilio/*`, `/api/sms/inbound-optout`, `/api/webhooks/twilio-sms-status`). Set `TWILIO_STATUS_WEBHOOK_SECRET` and `RELAY_SHARED_SECRET`.
- **Verify:** `PROBE_SPECS.twilio` probe (connector-health cron) reads healthy; a call and an SMS to the platform number are answered; carriers' A2P status shows approved before any marketing SMS.

### 4.3 SendGrid: events and inbound
- **Owner action:** Register the Event Webhook at `/api/webhooks/sendgrid-events` with signature verification (`SENDGRID_WEBHOOK_SECRET`) and, for inbound mail, the Inbound Parse route with its verify key (`SENDGRID_INBOUND_WEBHOOK_VERIFY_KEY`).
- **Verify:** a delivered test message produces an engagement event row; a bounced address lands in suppression.

### 4.4 Data and research providers (launch-degraded, enable in the order you will sell)
- **Owner action:** BatchData (`BATCHDATA_API_KEY` and, if provisioned separately, the listing / skip-trace / MCP / BatchRank tokens), RentCast, People Data Labs (`PEOPLEDATA_API_KEY` — the name the code reads), Versium (`VERSIUM_API_KEY`; the REACH MCP credential model is lane 143D's WAITING_EXTERNAL), Exa, Tavily, Apify/ZenRows/Zyte as the scraping plan needs.
- **Verify:** the provider's row on Superadmin → Connectors turns configured, then `PROBE_SPECS.<provider>` (where one exists) reads healthy; a metered call books to `vendor_usage_tracking`.

### 4.5 Avatar and voice
- **Owner action:** Set `DID_API_KEY`, `DID_WEBHOOK_SECRET`, `DID_CUSTOM_LLM_KEY`, `DID_ALLOWED_ORIGINS` (D-ID Studio), `ELEVENLABS_API_KEY`, optionally `SIMLI_API_KEY`; register `/api/webhooks/did` in D-ID.
- **Verify:** Go-Live Readiness domains `did` and `elevenlabs` ready; the render-pipeline probe (`queueRenderPipelineProbeAction`) produces a playable file; `PROBE_SPECS.did` / `.elevenlabs` healthy.

### 4.6 DocuSign (the platform e-sign default)
- **Owner action:** Create the DocuSign integration key, RSA keypair and platform account; grant the **one-time JWT consent** to the impersonated user; set `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_SECRET_KEY`, `DOCUSIGN_OAUTH_HOST`, `DOCUSIGN_JWT_USER_ID`, `DOCUSIGN_RSA_PRIVATE_KEY`, `DOCUSIGN_PLATFORM_ACCOUNT_ID`, `DOCUSIGN_WEBHOOK_SECRET`; register the Connect URL `/api/webhooks/docusign`.
- **Verify:** `lib/esign/docusign-jwt.ts` reports configured; a test envelope in the DocuSign demo environment completes and its event reaches the door.

### 4.7 OAuth and social apps
- **Owner action:** Create the OAuth apps (Google — sensitive Gmail/Calendar scopes need Google's app verification; Microsoft; Zoom; QuickBooks; Xero) and the social apps (Meta, LinkedIn, X, TikTok, Pinterest — each platform's review process applies); set the pairs listed in the inventory; register redirect URIs under the canonical origin.
- **Verify:** connect a throwaway account from Settings → Integrations for each; a platform whose pair is unset reports "not configured" and never connects. Meta: the webhook handshake succeeds from the Meta console.

### 4.8 Maps and weather
- **Owner action:** Create separate Google Maps keys (server `GOOGLE_MAPS_API_KEY`; browser `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, **restricted by HTTP referrer**), the Mapbox secret and public tokens (`MAPBOX_TOKEN`, `MAPBOX_PUBLIC_TOKEN`) and, for production weather, `OPEN_METEO_API_KEY` (production refuses without it).
- **Verify:** `PROBE_SPECS.mapbox` healthy; readiness blocker B6 reads its declarations and keys present.

### 4.9 Certify the webhook doors that cannot report their own failures
- **Owner action:** For the doors marked **blind** in `PROVIDER-CERTIFICATION.md` §3, send each provider's test delivery after registering and read the response status in the provider console.
- **Verify:** `npm run test:webhook-contract` (scheme truth, offline) plus the console's delivery log; record the result per door in the launch note.

## 5. Tier snapshots

### 5.1 One canonical snapshot per tier
- **Owner action:** For each canonical tier — `solo_agent`, `team`, `brokerage`, `multi_location` — configure a reference tenant the way a new subscriber should look and capture a platform config snapshot (Superadmin → config snapshots; `lib/platform/config-snapshots.ts`).
- **Verify:** readiness blocker B4: `select payload->>'recommendedTier' from platform_config_snapshots` returns all four tiers; the tenant-readiness `snapshot` check no longer blocks.

### 5.2 A new subscriber lands fully provisioned
- **Owner action:** Create a trial tenant per tier through the normal signup.
- **Verify:** each reaches "ready" on the readiness contract (tenant → plan/entitlements → snapshot → settings → website → admin user → seats), the tenant site answers at `/site/<slug>`, and the cron dispatcher ticks for it.

## 6. Launch authorization

### 6.1 The full guard chain on the release commit
- **Owner action:** On the exact commit to be released, run the whole chain with the documented heap and read the **exit code**, not the prose.
- **Verify:** `NODE_OPTIONS="--max-old-space-size=10000" npm run guard > guard.log 2>&1; echo "GUARD_EXIT=$?" >> guard.log` then `grep GUARD_EXIT guard.log` prints `GUARD_EXIT=0` (the log contains the word "fail" hundreds of times in prose — CLAUDE.md §7).

### 6.2 The CI build verdict
- **Owner action:** Confirm the `next-build` job on the release commit. Exit 134 ("Ineffective mark-compacts") is re-run unchanged; escalate after three consecutive failures at the same commit (CLAUDE.md §8).
- **Verify:** green `build.yml` run URL recorded in the launch note.

### 6.3 The readiness gate
- **Owner action:** Clear or accept every BLOCKED / WAITING_EXTERNAL row of the blocker table (B1 key, B2 lanes, B3 prices, B4 snapshots, B5 owner DDL, B6 keys, B11 UI smoke).
- **Verify:** `npm run test:production-readiness` prints `RELEASE: READY` (the external build/CI verdict is the one gate that is recorded, not computed).

### 6.4 UI smoke against the deployed URL
- **Owner action:** Set the repository variable `UI_SMOKE_BASE_URL` to `https://<prod>` (or pass a preview URL when dispatching).
- **Verify:** the `ui-smoke` job in `.github/workflows/e2e.yml` runs the desktop and phone-width `@smoke` specs and passes; a *stated skip* is not a pass.

### 6.5 Pilot first, then authorize
- **Owner action:** Run the pilot brokerage through `docs/PILOT_RUNBOOK.md` (Phase 0 → Phase 1); then give the explicit launch authorization — a dated line in the launch note naming the commit, the Vercel deployment id and the Stripe mode (test or live).
- **Verify:** Go-Live Readiness is green for every required domain; the pilot's first autonomous touchpoint, first inbound webhook and first billing event each have a ledger row (`agent_action_ledger`, `api_response_logs`, the subscription row).

### 6.6 Rehearse the rollback
- **Owner action:** Promote the previous Vercel deployment and then the current one again.
- **Verify:** both promotions complete with no data change; the cron dispatcher keeps ticking across them.

## Appendix — wave-142 open items and where each stands (read at base 21da8e4e, 2026-10-23)

These are not owner actions; they are the engineering loops wave 142 left open. Each row names the lane that owns the code and what this lane (143H) did.

| Wave-142 open item | Owner of the code | Status at this audit |
|---|---|---|
| Platform-Media packet source (`142B SOURCE (a)`): load an approved fillable packet held in platform Media | lane 143B | **Pending.** The canary hook is still pending by design (`scripts/canaries/_registry.ts:40`, contract at `:321`); no platform packet exists under `lib/forms`. Note for the lane: the `brokerage-forms` bucket is **private** live (`lib/storage/bucket-limits.ts:50`), so packets must be served by signed URL (`lib/storage/signed-doc-url.ts`), never `getPublicUrl`. |
| Versium B2B2C result-row field names; REACH MCP | lane 143D | **Open, unchanged.** Request/response *inputs, outputs and billing* are pinned from the vendor docs (`lib/external/versium-client.ts:558-583`); the **result row's field names are UNRESOLVED** (the vendor sample page was unreachable, `:582`) and the REACH MCP is `wired: false` (`:547-556`) because its OAuth dynamic-client-registration handshake is interactive — no server credential exists to configure. WAITING_EXTERNAL. |
| Two settlement `doc_type` spellings | **143H (this lane)** | **Migration written, not applied:** `m840`. The survivor is `preliminary_closing_disclosure`; four coupled code sites in other lanes ship in the same release (file:line in the lane notes). 0 rows live. |
| Tenant timezone column | **143H (this lane)** | **Verdict: no new column.** The tenant timezone already exists (`global_settings.timezone`) but is `NOT NULL DEFAULT 'America/New_York'`, so it cannot say "not chosen". **Migration written, not applied:** `m841` makes it nullable; the CDA reaper (`lib/transactions/cda-delivery-reaper.ts:141`) and the milestone bridge (`lib/kernel/milestone-calendar-bridge.ts:61`) are the readers to wire. |
| YouTube connect backfill | lane 143F | Not in this lane's domain; unchanged by 143H. |
| Compliance execution ordering | lane 143A | Not in this lane's domain; unchanged by 143H. |
| Matcher precision (`lib/forms/state-package-match.ts:60`) | lane 143B | **Open.** The match score is *recall* of the required form's name tokens in the file name (`hit / need.length`), so a longer file name that contains the required name scores the same 1.0 and the first file wins a tie. Proposed change (lane B): keep the 0.6 floor, rank by recall first and break ties on the fewer extra tokens (`ft.size - hit`), or score Jaccard (`hit / (need.length + ft.size - hit)`). |
| Remotion render / player | lane 143F | Not in this lane's domain; unchanged by 143H. |
| `m739` / `m771` / `m795` | **143H** | **Consolidated into `docs/operations/OWNER-SQL.md`** with before/after checks; the guard holds the statements verbatim. |
| Provider credentials; Stripe products and prices | owner | **Sections 3 and 4 above**, each step with its verification. |
