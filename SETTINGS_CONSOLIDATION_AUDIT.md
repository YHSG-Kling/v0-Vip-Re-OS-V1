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
