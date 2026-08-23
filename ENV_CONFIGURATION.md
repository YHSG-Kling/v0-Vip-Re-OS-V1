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

### Stripe (Auto-configured via Vercel Integration)

All four are read by live code. The first two alone are NOT enough — with the
webhook secrets absent the checkout completes at Stripe and the account is never
activated locally, because `app/api/billing/webhook/route.ts` returns 500 on a
missing `STRIPE_WEBHOOK_SECRET` and Stripe's delivery simply fails.

- `STRIPE_SECRET_KEY` - Server-side Stripe API key. This ONE variable is the
  product's real Stripe on/off switch (`lib/billing/stripe-subscription-ops.ts`
  `isStripeConfigured`). Absent ⇒ the subscription write-through ops no-op, the
  AI-overage cron refuses with a 503, and `lib/stripe.ts` throws on first use.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` - Client-side publishable key. Read at
  module scope by `app/settings/billing/upgrade-modal.tsx`; without it the
  embedded checkout cannot mount.
- `STRIPE_WEBHOOK_SECRET` - Signing secret for the TENANT billing webhook
  (`/api/billing/webhook`). Required for checkout completion, invoice paid /
  payment failed, subscription updated / deleted, and Connect `account.updated`.
- `STRIPE_VENDOR_WEBHOOK_SECRET` - Signing secret for the VENDOR marketplace
  webhook (`/api/webhooks/stripe/vendor`). Separate endpoint, separate secret.

**Beyond the env vars** — reconnecting Stripe also needs data that lives in the
database, not in configuration:
- `subscription_tiers.stripe_price_id` is NULL on all four tiers. Checkout does
  not need it (it builds inline `price_data`), but the weekly price-drift cron
  `/api/cron/stripe-drift` and the superadmin repricing path
  (`stripeSwapPrice` on a tier change) both skip silently while it is NULL.
  `publishTierToStripeAction` in `app/actions/superadmin/plan-catalog.ts` fills
  it once a key exists (superadmin → /dashboard/superadmin/plans).
- `platform_credentials` holds ZERO rows, so nothing Stripe-related is stored in
  the database either — the key must come from the environment.

**DEPRECATED:**
- `STRIPE_PUBLISHABLE_KEY` - Use `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` instead
- `NEXT_PUBLIC_FEATURE_STRIPE` - REMOVED. It gated nothing (zero readers in the
  tree); `STRIPE_SECRET_KEY` presence is the only switch. See the tombstone in
  `lib/constants/index.ts`.

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
