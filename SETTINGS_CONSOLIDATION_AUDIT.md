# Settings Consolidation & Drift Audit

Branch: `claude/settings-consolidation-ui`
Scope: the settings surface, provider/voice setup navigation, and the tenant/seat +
channel drift called out from the live VM walkthrough and screenshots.

This document records (1) what was **fixed in this PR**, (2) **verified findings** with
exact file references, and (3) a **prioritized resolution plan** for the remaining drift.
It is deliberately concrete — no fix is claimed that was not landed and type-checked.

---

## 1. Fixed in this PR

### 1a. `/settings/general` → "Settings not found" (root cause: settings never seeded)

**Symptom (screenshot):** General Settings loads with defaults, and **Save** returns a red
`Settings not found`.

**Root cause:** three compounding problems in the global-settings path.

- `app/actions/settings/get-global-settings.ts` read with the **service client** and
  `.limit(1)` and **no brokerage filter** — a multi-tenant leak that returned whichever
  brokerage's row sorted first, and returned bare defaults (no `id`, no `brokerage_id`)
  when the table was empty.
- `app/actions/settings/update-global-settings.ts` could only **UPDATE by client-supplied
  `id`**. With defaults there is no `id`, so the row lookup failed → `Settings not found`.
  There was **no INSERT/upsert path**, so a brokerage with no row could never save one.
- The canonical `lib/kernel/global-settings.ts` was brokerage-scoped and admin-gated (good)
  but **threw** `Settings not initialized for this brokerage` when the row was missing — it
  never seeded either.

**Resolution:**
- `lib/kernel/global-settings.ts` is now **self-seeding**. A new `ensureGlobalSettingsRow()`
  helper reads the brokerage row and, if absent, inserts a defaults row (race-safe re-read on
  conflict). `getGlobalSettings` and `updateGlobalSettings` both call it, so first access on a
  fresh brokerage creates the row instead of erroring.
- The two drifted action files now **delegate to the kernel** (single source of truth),
  preserving the form contracts (`get` returns a row, `update` returns `{data}|{error}`). The
  unscoped service-client read and the id-only update are gone.
- `scripts/1107-global-settings-one-per-brokerage.sql` collapses any duplicate rows and adds
  `UNIQUE(brokerage_id)`, making the seed race-safe and enforcing one-row-per-brokerage.

**Verified:** `test:no-dead-components`, `test:no-orphan-actions`, `test:use-server-exports`,
and `test:tenant-scope` all pass. The tenant-scope guard **improved** — this change removes a
previously-unscoped `global_settings` read.

### 1b. "Set up AI calling / Vapi / Lob" prompts dead-ended on `/settings/integrations`

**Symptom:** app-wide warnings route to `/settings/integrations`, but that page only had
Listing Provider / CRM Sync / Social Media tabs — **no voice**. The real voice setup lives at
`/dashboard/settings/isa-calling` (phone numbers, BYOC, IVR, Vapi engine, duty agent), and
Lob/direct-mail at `/settings/direct-mail`.

**Resolution:** added a **Voice & AI Calling** tab to `app/settings/integrations/integrations-content.tsx`
that bridges to those canonical surfaces. Purely additive UI + deep links — no new credential
plumbing, so it cannot regress the existing IDX/GHL/social credential flows. This ends the
dead-end while the deeper consolidation (below) is scheduled.

---

## 2. Verified findings NOT changed here (and why)

### 2a. Seat count "2 of 2" in red for a Brokerage tenant — **data drift, not a code bug**

`lib/kernel/tier-role-matrix.ts` is correct: `brokerage` and `multi_location` seat limits are
`null` (unlimited); `solo_agent = 2`; `team = 5`; and unknown/legacy tiers **fail open** to
unlimited. The "2 of 2 / solo agent" you saw means the tenant's `brokerages.plan_tier` is set
to `solo_agent` in the database, not `brokerage`. **Fix is a data/entitlement change**, not a
code edit — set the demo brokerage's `plan_tier = 'brokerage'` via the platform
tenant-entitlements surface. Changing the (correct) matrix code would mask the real config drift.

### 2b. Two parallel settings trees — `app/settings/*` vs `app/dashboard/settings/*`

This is the largest structural drift. `app/settings/*` (screenshots) and
`app/dashboard/settings/*` (legacy dashboard) both exist, with overlapping General, Branding,
Integrations, Teams. The right end-state is **one tree**; picking a winner and redirecting the
loser requires a dependency sweep (nav configs, command palette, deep links) that must be its
own PR to stay safe. See the plan in §3.

---

## 3. Prioritized resolution plan (next PRs)

Ordered by user-visible impact ÷ risk. Each is a self-contained, testable slice — the repo's
guard suite (`npm run guard`) must stay green after each.

1. **Tenant entitlement data fix** (S) — set the brokerage's `plan_tier`; verify seat counter
   reads "unlimited". Removes the "solo agent" mislabel everywhere it surfaces.
2. **Unify the settings tree** (L) — choose `app/settings/*` as canonical (it matches the
   screenshots and the newer components), 301/redirect legacy `app/dashboard/settings/*`
   routes, and update `app/config/navigation-config.ts`, the command palette, and the
   settings sidebars to point at one tree. Delete legacy pages **only after** grepping every
   deep link. Guard: `test:orphan-routes`, `test:no-dead-components`.
3. **Full voice setup in the canonical settings tree** (M) — promote ISA Calling into
   `/settings/*` (e.g. `/settings/voice`) so voice is a first-class settings section, then
   point every "set up AI calling/Vapi" CTA there. Retire the §1b bridge once the real
   section exists.
4. **ISA campaign channel parity** (S) — `dashboard/isa/campaigns` offers only *video* as a
   channel when creating an ISA campaign, while the engagement feed offers
   email/sms/video/directmail/phone. Unify both against one channel enum (the engagement-feed
   set) so campaign creation and the feed agree.
5. **CDA template upload → Supabase Storage** (M) — the CDA template upload fails with a blob
   error; platform storage is Supabase buckets. Route the upload through the Supabase Storage
   client (same bucket convention the rest of the app uses) rather than a blob provider.
6. **Workflow sequences as first-class steps** (M) — sequences/steps are the core primitives
   of workflows/campaigns but are wired as separate `href` links. Model them as nested
   step components inside the workflow/campaign editor so a sequence is a step list, not a
   sibling page.
7. **Provider settings consolidation** (M) — collapse the several conflicting provider
   settings surfaces into one advanced "Providers" area (`app/settings/providers` is the
   natural home) with per-capability provider selection, so users configure each provider once.

---

## 4. Strategic direction (differentiator vs Rave / Lofty / RealScout)

The moat this codebase already leans toward — and should lean into harder — is a **multi-agent
"command center" that owns the full lifecycle** (scrape → lead → deal → lifetime client) with a
**voice admin that executes commands**, rather than point tools bolted together. Concretely:

- **One command center, many managers.** The kernel already carries manager registries,
  signals, ownership, and dissent tests (`test:manager-*`). Keep every autonomous action
  flowing through the kernel's egress + autonomy gate so the "AI team" is auditable and
  governable — that governance ledger *is* the enterprise differentiator competitors lack.
- **Voice admin as a first-class operator, not a widget.** The legacy `dashboard/voice`
  assistant should be folded into the command center so a spoken command routes through the
  same manager/egress/compliance rails as a clicked action (same authz, same audit).
- **Compliance as a feature, not a footnote.** The `guard:compliance` suite (consent, DNC/TCPA,
  fair-housing, channel-preference) is a genuine edge for brokerage/enterprise buyers. Surface
  it in the UI (a live compliance status per contact/campaign), don't just enforce it silently.
- **Own the creative loop.** Remotion + D-ID + ElevenLabs (platform-locked, no HeyGen — see
  `getPlatformVideoProvider`) means listing/explainer/avatar video can be generated *inside* the
  OS from live listing data. That closes marketing in-house — a capability the incumbents
  outsource.

The through-line: **consolidate the surface, centralize through the kernel, and make the
governance/compliance/voice/creative rails visible.** That is what turns "a lot of features"
into "an OS."

---

## 5. Framework & structure audit (log-driven, 2026-07-22 export)

Audited the attached production log export (1,995 rows) against the platform/tier
architecture. **Audit-only** — the one code change made here is correcting the voice-tab
copy (§5d). Everything else is a finding + recommendation, not a change, per the
"audit before making changes" directive.

### 5a. The "401 storm" is the auth layer working, NOT a broken cron system

1,532 of 1,995 log rows are `401` on individual `/api/cron/*` paths (574 alone on
`/api/cron/poll-heygen-videos`). This looks alarming but is **correct behavior**:

- There is exactly **one** Vercel cron: `/api/cron/dispatch` (`* * * * *` in `vercel.json`).
- `lib/kernel/cron-dispatch.ts` computes what's due and fans out internal calls **with
  `Bearer CRON_SECRET`** (line 298) — the same header Vercel sends.
- `lib/cron-auth.ts` is hardened: missing secret → 500, mismatch → 401 (no fail-open, no
  "Bearer undefined" bypass).

The 401s are on a **preview** deployment (`njrlq6wvc.vercel.app`), where Vercel's scheduler
does **not** run crons. So these are **direct hits to the old per-cron paths without the
secret** — a **stale external scheduler** (or monitor) still pointed at the pre-dispatcher
endpoints. **Action is ops, not code:** decommission the old external cron config so it stops
hammering individual paths; the dispatcher architecture is sound and should be the only caller.

### 5b. Vapi and HeyGen are already formally decommissioned — residual code remains

`lib/platform/provider-posture.ts:566` — `DECOMMISSIONED_PROVIDERS = new Set(["vapi","heygen"])`
— and `lib/marketing/video-provider-resolver.ts` **force-locks video to D-ID** (a stale
`heygen` override can never render). So the platform already enforces "no HeyGen, Vapi is gone."

What remains is **residual surface area** that should be cleaned in a dedicated pass (109 files
reference `vapi`, 47 reference `heygen`, mostly ban-enforcement + gated legacy + the Twilio
relay that replaced Vapi). Live `api.heygen.com` appears in only 2 files (one is the ban
comment; `app/actions/video-generation.ts` has a legacy path to retire). **Do not bulk-delete** —
each reference needs the dependency check the platform's guards demand. Concrete residue to
retire first: the `poll-heygen-videos` cron path (route already gone; a stale scheduler still
calls it) and the "VAPI number" wording on `/dashboard/onboarding/ai-call-setup`.

### 5c. Orphaned cron routes (404s)

`/api/cron/team-heatmap-snapshot`, `/api/cron/engagement-scores`, `/api/cron/earnings-rollup`
return **404** — scheduled/called but the route no longer exists on disk. Either restore the
route or remove it from whatever still calls it (same stale-scheduler cleanup as §5a). The
in-repo `test:orphan-routes` / `test:cron-dispatch` guards are the right place to assert this.

### 5d. Voice-tab copy corrected (the one change in this pass)

The Voice & AI Calling tab added earlier referenced "the Vapi voice engine." Since Vapi is
decommissioned and the platform stack is **Twilio telephony + ElevenLabs voice**, the copy now
says exactly that. No behavior change.

### 5e. Platform vs tenant provider boundary — verify, don't assume (see §6 for the resolution)

The platform holds direct mail, Vercel AI Gateway, D-ID + Remotion video, ElevenLabs voice,
Twilio phone, RentCast default IDX, scrapers, and enrichment. `/settings/providers` currently
exposes tenant-level Email (`sendgrid`) and SMS (`twilio`) provider pickers. If Twilio is a
**platform-held** channel, a tenant-level Twilio SMS provider row is drift — confirm whether
`/settings/providers` should show only tenant-BYO overrides (IDX, own SMTP) and hide
platform-owned channels. Flagged for the provider-consolidation PR (§3.7), not changed here.

---

## 6. Full settings/provider audit + canonical information architecture

Grounded in a 4-agent read-only sweep of every settings surface, the provider registry,
the comms surfaces, and Twin Studio, plus `docs/PHONE-SYSTEM-SETUP.md` and
`lib/providers/tenancy-matrix.ts`. **Audit-first**: the only code change in this pass is the
Twin Studio voice-preview fix (§6e). Everything else is the plan.

### 6a. The canonical authorities (single sources of truth)

- **Routing / which vendor runs:** `resolveProvider()` + `SYSTEM_DEFAULTS` in
  `lib/kernel/providers.ts`. Two tiers:
  - **SYSTEM_ONLY (platform, superadmin-only):** `ai, video, avatar, voice_clone, ai_voice,
    direct_mail, scraper, enrichment`. Tenants must NOT get pickers for these.
  - **Per-tenant cascade (user→team→brokerage→superadmin→default):** `email, sms, phone,
    social, calendar, payment, esign, transaction, crm, accounting, idx`.
- **Ownership (platform-owned vs BYO):** `PROVIDER_TENANCY` in `lib/providers/tenancy-matrix.ts`
  — `platform_metered` / `platform_subaccount` / `user_oauth` / `tenant_optional_key` /
  `byo_top_tier`. Platform-owned (no tenant key): Twilio (subaccount), ElevenLabs, D-ID,
  Remotion, all scrapers, RentCast, Stripe, AI Gateway, Supabase Storage.
- **Connectable lists (the UI must derive from these, never hand-type):**
  `PROVIDER_CATALOG` (esign/transaction) + `CONNECTOR_PROVIDERS`/`field-spec.ts` (Connection Center).

**The "keep the accurate selection" rule:** a settings surface is correct **only** if its
provider list and its `provider_type` key derive from the authorities above. The two surfaces
that *hand-type* lists — `/settings/providers` and `/dashboard/settings/integrations` — are the
primary drift and are the ones to retire, not preserve.

### 6b. The one-home target already exists: the Connection Center

`/settings/connections` (`connection-center-client.tsx` + `app/actions/connections/connection-center.ts`,
driven by `lib/connections/field-spec.ts`) already renders Email, Phone/SMS, Calendar, Social,
CRM, Financial, IDX, Transaction, E-Sign, Showings, Podcast, and Meetings/Zoom **on one page**,
scope-gated per tier/role. This is the "one location, onboarding-simple" hub. Consolidation =
**make it the only connector** and delete the competing dedicated pages.

**Canonical Settings IA (one home per concern), all under `/settings/*`:**

| Concern | Canonical home | Retire / redirect |
|---|---|---|
| App/general config | `/settings/global` | `/settings/general` (subset), dashboard/vertical stubs (already redirect) |
| Branding + auto-website | `/settings/branding` (+ new website section, §6d) | — |
| Users / team / SSO | `/settings/users` | `/dashboard/settings/teams` (redirects) |
| **All provider connections** | `/settings/connections` (Connection Center) | `/settings/phone`, `/settings/crm`, `/settings/integrations`, `/settings/providers`, `/dashboard/settings/integrations`, `/dashboard/settings/calendar` |
| AI Team (assistant + twins + call handling) | one `/settings/ai-team` area | scattered: `/dashboard/settings/assistant`, `/twin-studio`, `/widget`, `/ai-isa/settings`, `onboarding/ai-call-setup` |
| Brand voice | `/settings/brand-voice` | 3 other edit surfaces (studio, admin/brand, onboarding) |
| Notifications | `/settings/notifications` | `/dashboard/settings/notification-rules` (same kernel fn) |
| Commission/financial | `/settings/commission` + `/settings/accounting` | — |

### 6c. The provider-list conflicts to resolve (from the provider map)

The same concern is offered with divergent lists across surfaces. Resolution = one list per
concern, derived from the authorities in §6a:

- **J1 (bug, most serious):** `/dashboard/settings/integrations` writes `provider_type='voice'`
  and `'mls'`, but the kernel reads `'phone'` and `'idx'` → **overrides set there are silent
  no-ops at dispatch.** Fix by retiring that surface (Connection Center replaces it).
- **SMS/phone carriers:** three lists (twilio/signalwire/bandwidth · twilio/bandwidth/vonage ·
  twilio/telnyx/bandwidth); dispatch implements **twilio only**. Keep the kernel/tenancy list;
  since Twilio is platform-owned, tenants pick a **number**, not a carrier key (§6f).
- **Email:** sendgrid/postmark/ses/smtp/mailgun vs sendgrid/mailgun/resend vs gmail/outlook
  (OAuth). The tenant-facing accurate selection is **gmail/outlook OAuth** (Connection Center);
  the SMTP-vendor lists are platform routing detail, not tenant choices.
- **CRM:** ghl-only vs {gohighlevel,lofty,followupboss} vs {+hubspot}; kernel default is
  follow_up_boss. Keep the Connection Center list; it's the superset and matches the kernel.
- **MLS/IDX:** spark/rets/bridge exist only in the legacy dropdown and are unsupported —
  drop them; keep **RentCast (platform default) + IDX Broker (tenant BYO)**.
- **eSign/Transaction (J10):** already correct — both surfaces derive from `PROVIDER_CATALOG`.
  **This is the template every other concern should copy.**

### 6d. Auto-website: settings section is missing + a brand-source drift bug

The public tenant sites (`/site/[slug]`, `/team/[slug]`, `/p/[agentSlug]`) are fully built and
platform-hosted (no tenant DNS). But:
- The only settings surface (`YourWebsiteCard` on `/settings/branding`) just shows the live URL
  + custom-domain management. **Missing:** site on/off toggle, slug editor, about/recruiting-pitch
  copy, and section selection. Add a real **Website** section under `/settings/branding`.
- **Brand-source drift (bug):** `BrandingForm`/`saveBrandColors` writes `brokerage_brand_settings.*`,
  but `/site/[slug]` reads `brokerages.primary_color/about_text/logo_url` — **different tables**,
  so editing branding does not update the live site hero. Reconcile to one brand source.

### 6e. Twin Studio voice preview — FIXED in this pass

`listening-preferences-panel.tsx#previewVoice` called `/api/internal/voice-tts` with only
`{text}` — the route ignores any voiceId and always synthesizes the caller's own self-voice, so
the default-voice Preview played the wrong voice (or nothing without a clone). Now it calls the
canonical, budget-gated `previewAssistantVoiceAction(voiceId)` (the same path the AI Identity
picker uses) and plays the returned data URL. Also two smaller Twin Studio gaps to build later:
avatar step has no "paste a self-recorded video link" path (upload only), and the voice step is
record-only (no "upload an existing sample").

### 6f. Phone/SMS: switch the tenant model from API-key to number/forwarding

`docs/PHONE-SYSTEM-SETUP.md` + `tenancy-matrix.ts` are explicit: the platform owns Twilio and
resells metered; tenants never enter carrier secrets. But `/settings/phone` and the Connection
Center `phone` domain (`field-spec.ts:59-66`) ask for **Account SID + Auth Token**. The correct
model already exists in `admin/phone-settings` (auto-provision + number/forwarding). Fix =
change the Connection Center `phone` domain to number/forwarding, retire the API-key phone form,
keep BYO-Twilio only for the multi-location top tier.

### 6g. Phased execution plan (each = one PR, `npm run guard` green, no stubs)

1. **This PR** — voice-preview fix + this audit/IA (done).
2. **Rename + redirect** — sidebar "Email & Calendar" → "Connections"; `/settings/phone` and
   `/settings/crm` become thin redirects into `/settings/connections`; retire `/settings/integrations`
   (its Voice bridge moves into the Connection Center phone domain).
3. **Phone model** — Connection Center `phone` domain → number/forwarding; delete the API-key form.
4. **Provider de-drift** — retire the two hand-typed catalogues (`/settings/providers`,
   `/dashboard/settings/integrations`); derive every list from the §6a authorities; close J1.
5. **Website** — add the auto-website settings section; reconcile the brand-source table drift.
6. **AI Team** — fold assistant/twin/widget/ai-call/ai-isa into one `/settings/ai-team` area.
7. **Brand voice** — collapse the 4 edit surfaces into `/settings/brand-voice`.
8. **Ops/tech-debt** — Vapi/HeyGen residue retirement (§5b), stale external cron scheduler (§5a),
   orphaned cron routes (§5c), calendar Disconnect no-op button.

---

## 7. Phase 2 execution + email model (investigation results)

### 7a. Shipped: "Email & Calendar" → "Connections"

`SettingsSidebar.tsx` — the hub entry that opens the multi-domain Connection Center was
mislabeled "Email & Calendar" (its #1 confusion: clicking it shows phone/SMS/CRM too). Renamed
to **"Connections"**, which is what the page actually is. Zero-risk label change.

### 7b. The phone/CRM redirect is DEFERRED — credential-table mismatch (dependency finding)

The plan was to redirect `/settings/phone` and `/settings/crm` into the Connection Center. The
required dependency investigation shows that is **not safe yet**: the four connect surfaces write
**three different credential tables**, and the CRM sync reads only two of them.

| Surface | Writes | CRM sync (`lib/crm/sync.ts`) reads it? |
|---|---|---|
| `/settings/crm` (`crm-connect.ts`) | `brokerage_integrations` + `integration_credentials` | ✅ yes (brokerage default) |
| `/settings/integrations` (GHL, `agent-credentials.ts`) | `agent_api_credentials` | ✅ yes (agent scope) |
| `/settings/connections` (Connection Center, API-key providers) | **`platform_credentials`** | ❌ **no** |

So a CRM connected through the Connection Center today would **not** be picked up by the sync.
Redirecting the dedicated pages into it would silently break CRM sync. **Resolution order
corrected:** credential-storage unification (make the Connection Center write — or the sync read —
one canonical location per scope) must land **before** the redirects. This becomes the new
Phase 2.5, ahead of the old Phase 2 redirect step.

### 7c. Email model — CONFIRMED already correct (nothing to build)

The intended model — **platform SendGrid protects transactional/offers email out; inbound email
is captured so the offers system works** — is already implemented:

- **Outbound transactional (protected):** `email` resolves to **sendgrid** by default
  (`SYSTEM_DEFAULTS`), dispatched via `lib/providers/dispatch.ts`. Offers/system mail rides this,
  not a tenant's personal box.
- **Inbound capture:** `app/api/webhooks/inbound-mail/route.ts` handles BOTH classes in one
  endpoint — **transactional (postmark/sendgrid/mailgun/resend, HMAC-verified)** for the
  brokerage domain, AND **per-user Gmail/Outlook OAuth** (push→fetch) for independent agents.
  `lib/inbound-mail/resolve-user-provider.ts` walks user→team→brokerage to pick the right box.
- **Offers pipeline:** `lib/inbound-mail/offer-intake.ts#tryIngestInboundOffer` detects an offer
  email, matches the listing by address, auto-creates the `offers` row when the sender is a known
  contact, stores the PDF in Supabase Storage (`offer-documents`), and kicks AI extraction — with
  a "confirm" fallback (a review notification) when the buyer isn't matched. No stubs.

**So the email work is a SETTINGS-CLARITY task, not a build task:** the Connection Center's email
domain should present two distinct ideas — (1) *personal relationship email* (Gmail/Outlook OAuth,
what the agent sends 1:1 from) and (2) *the brokerage's transactional/offers email* (SendGrid,
platform-managed, not a tenant setting) — so nobody accidentally routes offers mail through a
personal box. Copy/labeling change, scheduled with the Connection Center consolidation; the
routing itself is already correct and protected.

### 7d. Revised phase order

2. **Rename** "Email & Calendar" → "Connections" (done, 7a).
2.5. **Credential-storage unification** (NEW, prerequisite) — one canonical credential location
   per scope so every connect surface + the CRM sync agree (7b). Guard: add a check that the
   sync's read tables ⊇ the Connection Center's write tables.
3. **Redirect** `/settings/phone` + `/settings/crm` into the Connection Center (only after 2.5).
4. Provider de-drift (retire hand-typed catalogues; close J1).
5. Email settings-clarity copy (7c) — personal-OAuth vs platform-transactional split.
6+. Website section + brand-source fix, AI Team consolidation, brand-voice single home, Vapi/
   HeyGen/cron ops cleanup (as in §6g).

---

## 8. Phase 2.5 (credential unification) + email copy — done, with a §7b correction

### 8a. Correction to §7b: the credential cascade was already unified

§7b concluded the phone/CRM redirect would break CRM sync because the Connection Center writes
`platform_credentials` while the sync reads other tables. **On deeper reading that was wrong.**
`lib/connections/resolve-scoped.ts` (`resolveScopedConnection`) is "THE unified connection
resolver": it reads `platform_credentials` by `(owner_type, owner_id)` — exactly where the
Connection Center writes — and falls back to the legacy tables (`agent_api_credentials`,
`integration_credentials`). `lib/crm/sync.ts` already resolves the CRM PROVIDER from all three
tables (lines 98–127), and the Follow Up Boss / Lofty / HubSpot dispatch already pulls the
CREDENTIAL through `resolveScopedConnection` (line 175). So a Connection-Center CRM connection is
honored end-to-end for those providers. The redirect is therefore safer than §7b implied.

### 8b. The one real gap closed: GoHighLevel credential resolution

GHL — the system-default CRM — was the exception. `services/goHighLevelService.ts` resolved its
key ONLY from `process.env.GHL_API_KEY` / `GHL_LOCATION_ID`, so a tenant that connected their own
GHL (Connection Center or `/settings/crm`) had the provider resolved to GHL but then dispatched
with the **platform env key**, ignoring their credential (a multi-tenant bug).

Fix (additive, backward-compatible):
- `syncContactToGHL(contact, credentialOverride?)` and `ghlFetch(endpoint, options, configOverride?)`
  now accept an optional tenant credential; without it they fall back to env, so every existing
  caller (`communications.ts`, `ghl-integration.ts`) is unchanged.
- `lib/crm/sync.ts` GHL branch now resolves the tenant credential via `resolveScopedConnection("ghl", …)`
  (apiKey + locationId from `accountId`/`config.locationId`/`config.location_id`) and passes it in;
  env remains the platform-default fallback.

Net: all four CRM providers (GHL, FUB, Lofty, HubSpot) now dispatch with the tenant's own
credential resolved from one cascade — the credential-unification prerequisite for the phone/CRM
redirect (§7d Phase 2.5) is satisfied for CRM.

### 8c. Email settings-copy split (7c) shipped

`connection-center-client.tsx` now shows per-domain clarifying notes: the **email** card states
that what you connect is your **personal relationship inbox (Gmail/Outlook)**, while transactional
+ offer email is **platform-managed (SendGrid)** and captured for the offers system automatically —
so offers mail is never routed through a personal box. Phone and CRM cards get matching one-liners
(platform-provided number; sync-out-only).

---

## 9. Tier / role access verification across settings (with one fix)

Goal: confirm every settings surface enforces the right access. Two access dimensions:
**subscription tier** (solo/team/brokerage/multi → seats + invitable roles, `tier-role-matrix`)
and **role/ownership scope** (agent/team/brokerage → what each may configure).

### 9a. How access is enforced (the correct pattern)

- `app/settings/layout.tsx` is a **client** component — its `hasAccess` redirect is **UX only**
  (bypassable), NOT a security boundary. It correctly defers: personal-stack sections
  (connections, phone, crm, branding, brand-voice, email-templates, notifications, general) are
  open to any tier; brokerage-wide sections (users, global, commission, accounting, services,
  providers, billing) are for broker/admin; developers is principal-gated server-side.
- **Real enforcement is per page/action, server-side.** Verified correct: `/settings/users`
  (server role check + redirect), `/settings/billing` (broker/admin gate), `/settings/accounting`
  (role check), `/settings/global` (kernel `requireBrokerAdmin` on read+write),
  `provider-settings-actions` (`requireBrokerAdmin`), `revenue-share-setting` (role gate with a
  solo-tier exception), `create-commission-structure` (`CREATE_ROLES`). The Connection Center
  gates connectable domains by `selfConnectableDomains(userType, scope)` and write scope by
  `writeScopeFor` (agent writes agent scope; broker/admin writes brokerage scope). `tier-role-matrix`
  seat limits are correct (solo 2 / team 5 / brokerage+multi unlimited) and `test:tier-entitlement`
  passes (17/0).

### 9b. Gap found + FIXED: commission read was role-less

`list-commission-structures.ts` read commission/rev-share structures with the **service client**
(RLS-bypassing) gated **only by brokerage_id — no role check**. The *write* was role-gated but the
*read* was not, and `/settings/commission` is a client page (bypassable layout redirect), so any
brokerage member (a plain agent) could enumerate the brokerage's split table. Fixed by gating the
read to the same broker/admin roles as the write (`VIEW_ROLES`); the only caller is the admin
commission page, so nothing legitimate regresses. Added to the doc as the pattern to watch:
**service-client reads of brokerage-wide config must gate by role, not just brokerage_id.**

### 9c. Phase 3 status (honest)

The hard redirect of `/settings/phone` + `/settings/crm` into the Connection Center is **not done
this pass**: `/settings/crm` carries a unique "Sync a contact now" tool (`syncContactNowAction`)
the hub lacks, so a redirect+delete would lose a feature and can't be end-to-end tested in this
environment. Correct sequence: port "Sync now" into the Connection Center CRM domain (additive),
switch the phone domain to the number/forwarding model (§6f), THEN redirect and delete the dead
pages/components with the guards (`orphan-routes`, `no-dead-components`, `no-orphan-actions`) green.

---

## 10. Tier-access sweep — remaining role-less config leaks fixed + guarded

A thorough sweep for the §9b pattern (service-client read of brokerage-wide config gated only by
`brokerage_id`, no role) found four more reads and one write. All fixed with the canonical
broker-level gate; a new guard prevents recurrence.

### 10a. Fixes

| File | Function | Table | Was | Now |
|---|---|---|---|---|
| `brokerage-fees.ts` | `listFeeTypes` | `brokerage_fee_types` (fee schedule) | brokerage-only | `isBrokerRole` gate (matches create/toggle) |
| `settings/list-email-templates.ts` | `listEmailTemplates` | `email_templates` | brokerage-only | `isAdminOrBroker` |
| `settings/update-email-template.ts` | `updateEmailTemplate` (WRITE) | `email_templates` | brokerage-ownership only, **no role** | `isAdminOrBroker` |
| `settings/global-settings-actions.ts` | `fetchWidgetScope` | `global_settings` | brokerage-only | `isAdminOrBroker` |
| `settings/global-settings-actions.ts` | `updateWidgetScope` (WRITE) | `global_settings` | **no role** | `isAdminOrBroker` (Forbidden) |
| `settings/global-settings-actions.ts` | `fetchWidgetAgentsAndTeams` | `users`+`teams` roster | brokerage-only | `isAdminOrBroker` |

### 10b. The shared gate was legacy-incomplete (fixed)

`isAdminOrBroker` (lib/auth/resolve-user-role) checked only `["admin","broker","broker_owner","superadmin"]`
and `resolveUserRole` does NOT canonicalize — so a live `broker_admin` / `super_admin` user was
wrongly denied (they canonicalize to broker / superadmin per lib/security/types.ts, and
`create-email-template` + `brokerage-fees.isBrokerRole` already admit them). The helper now admits
the legacy variants explicitly. It is used only by these settings actions, so the change is
zero-blast-radius and strictly more correct.

### 10c. Permanent guard

`scripts/settings-authz-guard.ts` (`npm run test:settings-authz`, added to `npm run guard`, 13/0):
any `app/actions/settings/*` (+ `brokerage-fees.ts`) file that uses `createServiceClient` must
carry a role-gate token or be explicitly EXEMPT with a reason (only `public-site-links.ts`, which
reads public data). New ungated service-client settings actions now fail CI — closing this leak
class for good.

---

## 11. Phase 3 (build, don't delete) — "Sync now" built into the Connection Center, manager-owned

Per the directive "don't delete components if it enhances the feature — build it instead," and
"every change managed by one of the 14 managers, cross-collaborating":

- **Built** the manual "Sync a contact now" tool INTO the Connection Center's CRM domain
  (`connection-center-client.tsx` → `CrmSyncNowCard`), reusing the real `syncContactNowAction`.
  The hub now has feature parity with the legacy `/settings/crm` page — nothing deleted; the
  dedicated page stays until a later redirect can be done losslessly.
- **Manager ownership:** the card is attributed to the **Data Steward** (the CRM/identity
  steward) via the canonical `MANAGERS` registry chip. On a successful manual sync,
  `syncContactNowAction` publishes a governed bus signal **`contact_crm_synced`
  (data_steward → sphere_of_influence, feed_only)** so the push is visible in the Command
  Center "managers talking" feed and cross-collaborates with the lifetime-relationship owner.
  The autonomous per-update sync stays silent (no feed spam); only the human-triggered manual
  sync surfaces. The announcement is best-effort — a bus hiccup never fails the CRM push.
- **Registered + tested:** `contact_crm_synced` is catalogued in `SIGNAL_REGISTRY` (feed_only,
  kind=update, matching `classifyCoordination`). `test:crm-sync-credential` extended (24/0) to
  assert the registration, the valid route, the publish wiring, and that the tool is built into
  the hub attributed to the Data Steward.

Verified: `tsc --noEmit` clean (0 errors); `test:signal-integrity`, `test:manager-signals`,
`test:manager-ownership` (73/0), `test:command-center`, `test:command-bar`,
`test:crm-sync-credential` (24/0), `no-dead-components`, `no-orphan-actions`,
`use-server-exports` all pass.

---

## 12. Phone/SMS domain — platform-provided model + top-tier BYO gate

Resolves §6f (the phone domain asked every tier for a Twilio Account SID + Auth Token,
contradicting the platform-owned model). Build-don't-delete: the carrier form stays for the
tenants who legitimately need it (BYO, top tier), but it's no longer the default.

- **UI (`connection-center-client.tsx`):** the phone card now leads with a
  `PlatformProvidedPhonePanel` — "your number is provided + billed by the platform, no carrier
  API key" — bridging to number/forwarding setup (`/dashboard/admin/phone-settings`) and AI call
  handling (`/dashboard/onboarding/ai-call-setup`). The carrier API-key rows are reframed below
  as **"Advanced — bring your own carrier (top tier)."**
- **Server gate (`connection-center.ts#connectApiKeyProvider`):** BYO carrier for the `phone`
  domain is enforced to the **Multi-Location top tier** (`brokerages.plan_tier === "multi_location"`)
  — a lower tier cannot store carrier secrets even off-UI. Existing connections still resolve
  (read path untouched: `resolve-sms-provider` keeps reading api_key/auth_token/from_number).
- **Tested:** `test:crm-sync-credential` extended (27/0) to assert the platform panel, the BYO
  reframing, and the server-side top-tier gate.

Verified: `tsc --noEmit` clean (0 errors); `test:crm-sync-credential` (27/0),
`no-dead-components`, `no-orphan-actions`, `tenant-scope` all pass.

---

## 13. BYO carrier is subscriber-controlled (correction) + SaaS phone-billing guidance

### 13a. Correction — BYO on every plan, gated by the subscriber (not the tier)

§12 gated BYO carrier to the Multi-Location tier. Corrected per the business rule: **BYO is
available on every plan; the SUBSCRIBER chooses whether their MANAGED agents may BYO.**

- **Gate (`connection-center.ts#connectApiKeyProvider`, phone domain):** a tenancy **principal**
  (a solo agent — their own shop — a team lead, or a broker/admin, via `isTenancyPrincipal`) may
  **always** BYO for themselves. A **managed agent** may BYO only when the brokerage's
  `allow_user_byo_carrier` policy is on. Enforced server-side (a managed agent can't store carrier
  secrets off-UI). No tier check — a solo/team subscriber can BYO exactly like a brokerage.
- **Subscriber toggle (`global-settings-actions.ts`):** `setByoCarrierPolicy` (broker/admin-gated)
  / `getByoCarrierPolicy` (member-readable), stored on `global_settings.additional_settings`.
  Default **off** (platform-provided) until the broker opts in.
- **UI:** the phone panel shows the broker ("brokerage" scope) a "Let your agents bring their own
  carrier" toggle; agents see whether BYO is available to them.
- **Tested:** `test:crm-sync-credential` (30/0) asserts the principal rule, the subscriber policy
  gate (no tier), the broker-gated setter, and the toggle UI.

### 13b. SaaS billing guidance — who bills whom for platform-provided phone

**Principle: bill the SUBSCRIBER (the brokerage/account owner), never the individual agent.** The
platform provisions numbers under the brokerage's Twilio *subaccount*, so usage rolls up to one
billable tenant. Agents never see a bill; the broker does. (BYO is the only case where the agent's
own carrier bills them directly — and the platform then meters nothing for telephony, only runs the
compliance gates.)

**Recommended model — an optional "Voice & SMS" add-on with metered overage** (rides the rails the
repo already has: `tier.features.limits`, `lib/entitlements/resolve.ts`, the `voice_calls` /
`vendor_usage_tracking` cost rollup, and Stripe usage-based billing / `@stripe/token-meter` noted in
`docs/PHONE-SYSTEM-SETUP.md`):

1. **Bundle (predictable, the SaaS default):** a per-seat monthly add-on — e.g. "Voice & SMS pack:
   $X/seat/mo, includes N minutes + M SMS." Sold as a Stripe add-on product/price, toggled per
   brokerage as a feature entitlement. Predictable, high-margin, easy to sell.
2. **Metered overage (fair at scale):** usage beyond the bundle bills per-minute/per-SMS at $Y via
   Stripe usage-based pricing, sourced from the existing `voice_calls` cost rollup — no new meter,
   the numbers are already captured.
3. **Entitlement gate:** number provisioning should check the phone-package entitlement before
   provisioning (so we don't hand out platform numbers to brokerages who haven't bought the pack,
   unless a tier bundles it). The vendor-budget auto-pause per brokerage already exists — reuse it.

**Why not pure pass-through metering only:** it's fair but unpredictable and harder to sell; lead
with the bundle, add metered overage. **Manager ownership:** `finance_manager` owns the add-on
P&L + the metered rollup (it already owns `vendor_usage_tracking`/commissions); `data_steward` owns
the connector/provisioning side. Implementation (Stripe add-on product + entitlement check in
provisioning + overage meter) is a scoped follow-up — the rails are all present.
