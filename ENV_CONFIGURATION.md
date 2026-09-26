# Smart Engine - Environment Variables Configuration

## Required Environment Variables

### Supabase (Auto-configured via Vercel Integration)
The following are automatically set when you connect Supabase via Vercel:
- `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Public anon key for client-side
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for server-side admin operations

**DEPRECATED (Remove these if present):**
- `SUPABASE_URL` - Use `NEXT_PUBLIC_SUPABASE_URL` instead
- `SUPABASE_ANON_KEY` - Use `NEXT_PUBLIC_SUPABASE_ANON_KEY` instead
- `SUPABASE_PUBLISHABLE_KEY` - Use `NEXT_PUBLIC_SUPABASE_ANON_KEY` instead
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - Use `NEXT_PUBLIC_SUPABASE_ANON_KEY` instead
- `SUPABASE_SECRET_KEY` - Use `SUPABASE_SERVICE_ROLE_KEY` instead
- `SUPABASE_JWT_SECRET` - Not needed for standard operations

### Stripe — one account per TENANT, plus one for the PLATFORM

**OWNER RULING (verbatim): "the stripe account will be per tenant and platform so
no configuration should be hardcoded."**

This section previously described four environment variables as *the* Stripe
configuration. That is the architecture the ruling replaces, and the correction
matters more than a doc edit: a single global key means every brokerage's money —
vendor package fees, vendor job bills, client payments, agent payouts — settles
into the product's Stripe account. That is a receipt naming the wrong merchant, a
refund from the wrong balance and a 1099 from the wrong entity, and it looks
exactly like success from every screen in the app.

**The rule, stated once in code**: `lib/billing/stripe-account-scope.ts`. The
account belongs to the party that **collects** (the payee), never to the party
that triggered the call. `STRIPE_MONEY_PATHS` in that file names every money path
in this repo and which side it is on.

**Resolution**: `lib/billing/resolve-stripe-account.ts`, which reuses the same
ownership cascade every other connector runs on
(`lib/connections/resolve-scoped.ts`: agent → team → brokerage → platform):

- `resolveTenantStripeAccount()` — a brokerage/team/agent's own account, from
  `platform_credentials` (`platform='stripe'`, owner-scoped). It **never reads an
  environment variable**, and it **refuses** rather than descending to the
  platform's account when the tenant has no credential. Tenants connect in
  Settings → Connections.
- `resolvePlatformStripeAccount()` — the platform's own account: a platform-owned
  `platform_credentials` row **first**, then `STRIPE_SECRET_KEY`. It walks a
  cascade containing only the platform tier, so it cannot reach a tenant's
  account even when one is in context.

#### The env vars that remain — PLATFORM SCOPE ONLY

They are kept because the platform is not one of the N tenants: it is a single
known party with exactly one Stripe account, and that account's key must be
readable *before* any database row can be (`platform_credentials` holds zero rows
today, so a DB-only platform credential would be an unbootstrappable product). A
tenant could never want to override them, which is what makes them a credential
rather than a configuration knob. None of them is reachable from a tenant-side
path — `scripts/stripe-account-scope-simulator.ts` asserts that.

- `STRIPE_SECRET_KEY` — the **platform's** secret key, and the platform's floor
  only. A platform-owned `platform_credentials` row overrides it, so rotating the
  platform's Stripe account is a database write rather than a redeploy. Absent
  *and* no platform row ⇒ platform billing refuses with a sentence naming what is
  missing; `lib/billing/stripe-subscription-ops.ts` `isStripeConfigured` no-ops;
  the AI-overage cron refuses with a 503.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — the **platform's** publishable key, read
  at module scope by `app/settings/billing/upgrade-modal.tsx` (the tenant→platform
  subscription checkout). Without it the embedded checkout cannot mount. A tenant
  collecting its own money uses its own account's publishable key, not this one.
- `STRIPE_WEBHOOK_SECRET` — the **platform account's** signing secret for
  `/api/billing/webhook`.
- `STRIPE_VENDOR_WEBHOOK_SECRET` — the **platform account's** signing secret for
  `/api/webhooks/stripe/vendor`. Separate endpoint, separate secret.

#### Webhook secrets are per-account too

Per-tenant Stripe accounts mean per-tenant signing secrets — one secret verifies
exactly one account's deliveries. Both endpoints now resolve the roster and
identify the signer **cryptographically**
(`lib/billing/stripe-webhook-secrets.ts`): the platform's secret is tried first,
then every tenant credential carrying `config.webhook_secret` (or
`config.vendor_webhook_secret` for the vendor endpoint).

The signing account is the **authenticated principal** of the delivery — not
`metadata.brokerage_id`, which is written by whoever owns the signing account.
Both routes therefore refuse a tenant-signed delivery for the platform's ledger,
by name. Three distinct refusals, none of which is "process it anyway": no secret
configured (500), roster unreadable (503, so Stripe retries), signature matched
nothing (400).

A tenant's signing secret goes on that tenant's `platform_credentials` row, never
in an environment variable — there are N tenants and env vars are singular.

**Beyond the env vars** — reconnecting Stripe also needs data that lives in the
database, not in configuration:
- `subscription_tiers.stripe_price_id` is NULL on all four tiers. Checkout does
  not need it (it builds inline `price_data`), but the weekly price-drift cron
  `/api/cron/stripe-drift` and the superadmin repricing path
  (`stripeSwapPrice` on a tier change) both skip silently while it is NULL.
  `publishTierToStripeAction` in `app/actions/superadmin/plan-catalog.ts` fills
  it once a key exists (superadmin → /dashboard/superadmin/plans). These prices
  live on the **platform's** account: the tiers are what tenants pay *us*.
- `platform_credentials` holds ZERO rows as of 2026-08-24, so no Stripe account —
  platform's or any tenant's — is stored in the database yet. The platform's key
  therefore comes from the environment today; every tenant-side path refuses
  until that tenant connects.
- `platform_credentials.scope` could not spell `platform` until **m548** widened
  its CHECK; `owner_type` already admitted it. Both halves are written together,
  so a platform-owned credential used to land labelled as a brokerage's.

**DEPRECATED:**
- `STRIPE_PUBLISHABLE_KEY` - Use `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` instead
- `NEXT_PUBLIC_FEATURE_STRIPE` - REMOVED. It gated nothing (zero readers in the
  tree). See the tombstone in `lib/constants/index.ts`. Note the old claim that
  "`STRIPE_SECRET_KEY` presence is the only switch" is no longer true: it is the
  switch for the PLATFORM's half only.

### PostgreSQL (Auto-configured via Supabase)
These are automatically set but not directly used (Supabase client handles connections):
- `POSTGRES_URL`
- `POSTGRES_PRISMA_URL`
- `POSTGRES_URL_NON_POOLING`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DATABASE`
- `POSTGRES_HOST`

**Note:** These can be removed if you're not using direct PostgreSQL connections.

---

## Optional Service Integrations

### Twilio (SMS/Voice)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`

### SendGrid (Email)
- `SENDGRID_API_KEY`
- `SENDGRID_FROM_EMAIL`

### D-ID (AI Avatar Video)
- `DID_API_KEY`
- `DID_WEBHOOK_SECRET` — the shared secret in the completion callback URL
  (`/api/webhooks/did?secret=…`). D-ID publishes no webhook signature, so this
  secret is the verification. **Unset means the endpoint 404s and no callback is
  registered** — avatars still finish, on the 3-minute poll cron instead of in
  seconds. Requires `NEXT_PUBLIC_APP_URL` to be the https production origin,
  since D-ID's schema rejects a non-https callback.
- `ELEVENLABS_API_KEY` — also sent to D-ID as `x-api-key-external` so our own
  instant voice clones resolve; without it D-ID uses its stock voices.

### Vapi (Voice AI) — LEGACY, migration window only
The voice lane is Twilio-native. These are still read by the ISA console's
readiness banner and by the `vapi_legacy` launch-checklist entry; new tenants
never need them.
- `VAPI_API_KEY`
- `VAPI_ASSISTANT_ID`
- `VAPI_ISA_ASSISTANT_ID`

### Dotloop (Transaction Management)
- `DOTLOOP_API_KEY`
- `DOTLOOP_PROFILE_ID`

### GoHighLevel (CRM & Communications)
- `GHL_API_KEY` - Your Go High Level API key
- `GHL_LOCATION_ID` - Your GHL location/sub-account ID
- `GHL_DEFAULT_EMAIL` - Optional default "from" email address

**DEPRECATED:**
- `GOHIGHLEVEL_API_KEY` - Use `GHL_API_KEY` instead
- `GOHIGHLEVEL_LOCATION_ID` - Use `GHL_LOCATION_ID` instead

### IDX Broker (MLS Integration)
- `IDXBROKER_API_KEY` - Your IDX Broker API key
- `IDXBROKER_API_URL` - Optional, defaults to https://api.idxbroker.com

**DEPRECATED:**
- `IDX_API_KEY` - Use `IDXBROKER_API_KEY` instead
- `IDX_API_BASE_URL` - Use `IDXBROKER_API_URL` instead

### Data Enrichment Services
- `ZENROWS_API_KEY`
- `BATCHDATA_API_KEY`
- `PEOPLEDATA_API_KEY`
- `APIFY_API_KEY`

### Contact Validation
- `ZEROBOUNCE_API_KEY`

### AI Services
- `OPENAI_API_KEY` - For direct OpenAI calls (optional - Vercel AI Gateway is default)

### Application Config
- `NEXT_PUBLIC_APP_URL` - Your app's public URL (e.g., https://yourdomain.com)
- `CRON_SECRET` - Secret for authenticating cron job endpoints

### Feature Flags (Optional)
- `NEXT_PUBLIC_FEATURE_HEYGEN` - Enable HeyGen video generation
- `NEXT_PUBLIC_FEATURE_DOTLOOP` - Enable Dotloop integration
- `NEXT_PUBLIC_FEATURE_AI_CHAT` - Enable AI chat (default: true)
- `NEXT_PUBLIC_FEATURE_CONTENT_GEN` - Enable content generation (default: true)
- `NEXT_PUBLIC_FEATURE_OPEN_HOUSE` - Enable open house automation (default: true)
- `NEXT_PUBLIC_FEATURE_SOCIAL` - Enable social media features (default: true)
- `NEXT_PUBLIC_FEATURE_EMAIL` - Enable email campaigns (default: true)

---

## LEGACY - TO BE REMOVED

### Airtable (Migrated to Supabase)
- `AIRTABLE_API_KEY` - **REMOVE** - No longer used
- `AIRTABLE_BASE_ID` - **REMOVE** - No longer used

### Gemini
- `GEMINI_API_KEY` - **REMOVE** if not actively using Gemini

---

## Minimum Required for Production

1. Supabase Integration (auto-configured)
2. Stripe Integration (auto-configured)
3. `NEXT_PUBLIC_APP_URL`
4. `CRON_SECRET`

All other services are optional and can be added as needed.
