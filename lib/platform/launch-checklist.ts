// lib/platform/launch-checklist.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE LAUNCH ENV CHECKLIST — the platform's env-var launch requirements as a
// LIVE SURFACE instead of tribal knowledge. The OS is built on honest-absence
// gates (no key → the feature states its gap and stands down); this module
// enumerates those gates in one place: for each capability, WHICH env vars
// feed it, whether they're configured RIGHT NOW (presence only — values are
// NEVER read into the result, never echoed, never logged), what lights up
// when set, and how missing it ranks for launch.
//
// COMPANION, not replacement, to lib/platform/go-live-readiness.ts: the
// go-live board LIVE-PROBES vendors (a wrong key looks configured until the
// vendor rejects it — that's the probe's job); this checklist is the cheap,
// zero-egress PRESENCE map that renders on page load and tells you which
// probes are even worth running. Rows derive from the provider tenancy
// matrix (lib/providers/tenancy-matrix.ts) + the known env gates; every
// envVar listed here actually appears as process.env.<VAR> in the codebase
// (enforced by scripts/launch-checklist-simulator.ts — no aspirational rows).
//
// TIER VOCABULARY (exactly three):
//   launch-blocking  — the platform cannot honestly onboard a paying tenant
//                      without it (core auth/DB, app URL, cron auth, Stripe,
//                      the AI gateway, and the email/SMS egress rails).
//   launch-degraded  — launch is possible; a visible capability lane runs in
//                      its honest fallback/absent mode (voice, video, zoom,
//                      enrichment, push).
//   optional         — nice-to-have rails (osint/research, stock media,
//                      direct mail, social/accounting OAuth apps).

export type LaunchTier = "launch-blocking" | "launch-degraded" | "optional"

export interface LaunchChecklistItem {
  key: string
  /** The capability this env gate feeds. */
  capability: string
  /** Env var name(s). ALL must be present unless anyOf. Names only — never values. */
  envVars: string[]
  /** When true, ANY ONE of envVars present counts as configured. */
  anyOf?: boolean
  /** Presence-only boolean, computed live. */
  configured: boolean
  /** What turns on when this is configured (or what honestly degrades without it). */
  whatLightsUp: string
  tier: LaunchTier
}

export interface LaunchChecklist {
  generatedAt: string
  blockingConfigured: number
  blockingTotal: number
  degradedConfigured: number
  degradedTotal: number
  optionalConfigured: number
  optionalTotal: number
  items: LaunchChecklistItem[]
}

/** The ONLY place this module touches process.env — presence check, value discarded. */
const isSet = (name: string): boolean => {
  const v = process.env[name]
  return typeof v === "string" && v.trim().length > 0
}

interface RowDef {
  key: string
  capability: string
  envVars: string[]
  anyOf?: boolean
  whatLightsUp: string
  tier: LaunchTier
}

// Every envVar below is grep-verified against the codebase by the simulator.
const ROWS: RowDef[] = [
  // ── launch-blocking: core auth / DB / cron / money / model / egress ───────
  {
    key: "supabase_core",
    capability: "Supabase core (auth + database + service rails)",
    envVars: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"],
    whatLightsUp: "Every login, every RLS-scoped read, every service-role rail. Nothing runs without all three.",
    tier: "launch-blocking",
  },
  {
    key: "app_url",
    capability: "Canonical app URL",
    envVars: ["NEXT_PUBLIC_APP_URL"],
    whatLightsUp: "Webhook registration targets, magic-link invites, portal links, QR destinations — all resolve against it.",
    tier: "launch-blocking",
  },
  {
    key: "cron_auth",
    capability: "Cron dispatcher auth",
    envVars: ["CRON_SECRET"],
    whatLightsUp: "The entire autonomous layer — every scheduled job authenticates with it; unset means no cron runs.",
    tier: "launch-blocking",
  },
  {
    key: "stripe",
    // ── CORRECTED BY OWNER RULING ────────────────────────────────────────────
    // "the stripe account will be per tenant and platform so no configuration
    // should be hardcoded."
    //
    // This row used to read "Stripe billing (secret key)" and light up "Stripe
    // Connect payouts" — i.e. it presented ONE env var as the switch for every
    // Stripe path in the product, tenant money included. That is worse than an
    // inaccuracy on a LAUNCH board: it goes GREEN on one key and reads as "money
    // is wired", while every tenant-side path is still unresolvable. A go-live
    // checklist that goes green on the wrong architecture is worse than one that
    // fails.
    //
    // What this row can honestly gate is the PLATFORM half, and only that. The
    // TENANT half is not an env var and cannot be — there are N tenants and env
    // vars are singular. Each tenant connects their own Stripe in
    // Settings → Connections; until they do,
    // lib/billing/resolve-stripe-account.ts REFUSES their charges by name rather
    // than settling them on the platform's account, which is the fail-closed
    // behaviour a launch board should WANT and cannot itself verify.
    capability: "Stripe billing — the PLATFORM's own account (secret key)",
    envVars: ["STRIPE_SECRET_KEY"],
    whatLightsUp:
      "The money the PLATFORM is the payee on: signup checkout, subscriptions, dunning, AI overage, vendor marketplace tiers, and the Connect PLATFORM that mints tenant acct_… ids. A platform-owned platform_credentials row (owner_type='platform', platform='stripe') overrides this var and is the preferred home once one exists. It does NOT cover tenant-side money — a brokerage's vendor bills, client payments and agent payouts run on that brokerage's OWN Stripe account, connected per tenant in Settings → Connections.",
    tier: "launch-blocking",
  },
  {
    key: "stripe_webhook",
    capability: "Stripe webhook verification — PLATFORM account (tenant billing)",
    envVars: ["STRIPE_WEBHOOK_SECRET"],
    // THE URL WAS WRONG, AND IT IS THE ONLY INSTRUCTION AN OPERATOR GETS.
    // This row said "register https://<app>/api/webhooks/stripe". No such route
    // exists — app/api/webhooks/stripe/ contains ONLY vendor/route.ts, so
    // /api/webhooks/stripe is a 404. The tenant billing webhook lives at
    // /api/billing/webhook. An operator who followed this line exactly would
    // register a dead endpoint, every checkout.session.completed and
    // customer.subscription.* delivery would fail, paid signups would never
    // activate — and this very checklist would have gone GREEN, because it
    // checks that the SECRET is set and cannot see where it was pointed.
    whatLightsUp: "Paid signups actually ACTIVATE — register https://<app>/api/billing/webhook in the PLATFORM's Stripe dashboard (events: checkout.session.completed, invoice.paid, invoice.payment_failed, customer.subscription.updated, customer.subscription.deleted, account.updated) and set its signing secret here. This is the PLATFORM account's secret only: /api/billing/webhook now identifies the signing account cryptographically (lib/billing/stripe-webhook-secrets.ts) and refuses to write the platform's billing ledger from a tenant-signed delivery, so a tenant's own webhook secret belongs on that tenant's platform_credentials row (config.webhook_secret), never here.",
    tier: "launch-blocking",
  },
  {
    // The VENDOR marketplace webhook is a SECOND Stripe endpoint with its OWN
    // signing secret, and it was absent from this checklist entirely — so an
    // operator could complete every launch-blocking row and still have vendor
    // subscriptions silently unreconciled (payment_failed → past_due and
    // cancellation → suspend never arrive).
    key: "stripe_vendor_webhook",
    capability: "Stripe webhook verification — PLATFORM account (vendor marketplace)",
    envVars: ["STRIPE_VENDOR_WEBHOOK_SECRET"],
    whatLightsUp: "Vendor subscription status stays true — register https://<app>/api/webhooks/stripe/vendor as a SEPARATE endpoint on the PLATFORM's Stripe account (events: customer.subscription.*, invoice.payment_succeeded, invoice.payment_failed) and set its own signing secret. The vendor marketplace tier is money the vendor pays the PLATFORM (VENDOR_PLATFORM_TIER), so this endpoint accepts platform-signed deliveries only. Without a secret — here or on the platform credential's config.vendor_webhook_secret — the route refuses every delivery with a 500 naming what is missing.",
    tier: "launch-blocking",
  },
  {
    key: "ai_gateway",
    capability: "AI model gateway",
    // ONE key, not "any one of four". The provider SDKs are gone: every
    // text/object/image/transcription call resolves through the Vercel AI Gateway,
    // so ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY no longer reach a model
    // and must not read as a satisfied launch requirement.
    // (ANTHROPIC_API_KEY still has ONE job — Anthropic's Managed Agents API in
    // lib/agents/managed-agents-egress.ts, which the gateway does not proxy — but
    // that is an agent-session surface, not the model lane this row gates.)
    envVars: ["AI_GATEWAY_API_KEY"],
    whatLightsUp: "Every AI manager, copilot, widget chat, and content lane — the routing table selects per feature.",
    tier: "launch-blocking",
  },
  {
    key: "email_egress",
    capability: "Transactional email egress (SendGrid)",
    envVars: ["SENDGRID_API_KEY"],
    whatLightsUp: "Invites, dunning, digests, alerts. Without it every email send honestly no-ops — blocking for egress.",
    tier: "launch-blocking",
  },
  {
    key: "email_from",
    capability: "Platform sender identity",
    envVars: ["SENDGRID_FROM_EMAIL"],
    whatLightsUp: "The From address on platform email; unset falls back to a placeholder domain that will not pass DMARC.",
    tier: "launch-blocking",
  },
  {
    key: "sms_voice_egress",
    capability: "Twilio master account (SMS + voice egress)",
    envVars: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    whatLightsUp: "SMS, calls, tenant subaccounts, A2P registration — the whole comms brain. Blocking for egress.",
    tier: "launch-blocking",
  },
  {
    key: "platform_line",
    capability: "Platform reception line",
    envVars: ["TWILIO_PHONE_NUMBER"],
    whatLightsUp: "The platform's own AI reception number (inbound voice + platform SMS sender).",
    tier: "launch-blocking",
  },

  // ── launch-degraded: voice / video / zoom / push / enrichment ─────────────
  {
    key: "elevenlabs",
    capability: "ElevenLabs TTS + voice clones",
    envVars: ["ELEVENLABS_API_KEY"],
    whatLightsUp: "Narrated videos, voice clones, audio briefings. Without it those lanes stay honestly text-only.",
    tier: "launch-degraded",
  },
  {
    key: "did_avatars",
    capability: "D-ID avatars + live embed twins",
    envVars: ["DID_API_KEY"],
    whatLightsUp: "Avatar video generation and the live avatar embed widget.",
    tier: "launch-degraded",
  },
  {
    key: "zoom_oauth",
    capability: "Zoom connection (meetings + transcripts)",
    envVars: ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"],
    whatLightsUp: "Zoom OAuth connect, meeting scheduling, transcript ingestion into the deal record.",
    tier: "launch-degraded",
  },
  {
    key: "zoom_webhook",
    capability: "Zoom webhook verification",
    envVars: ["ZOOM_WEBHOOK_SECRET_TOKEN"],
    whatLightsUp: "Zoom event callbacks (recording ready, transcript ready) verify and land automatically.",
    tier: "launch-degraded",
  },
  {
    key: "web_push",
    capability: "Browser push (VAPID)",
    envVars: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
    whatLightsUp: "Web-push notifications drain to subscribed browsers; without all three the drain gates itself off.",
    tier: "launch-degraded",
  },
  {
    key: "records_provider",
    capability: "Public-records provider (BatchData)",
    envVars: ["BATCHDATA_MCP_URL", "BATCHDATA_API_KEY"],
    anyOf: true,
    whatLightsUp: "Phone scrub (DNC/TCPA), address verification, comparables, motivated-seller sourcing.",
    tier: "launch-degraded",
  },
  {
    key: "avm_feed",
    capability: "Property feed + AVM chain (RentCast)",
    envVars: ["RENTCAST_API_KEY"],
    whatLightsUp: "The default for-sale feed and paid AVM rung; the free cascade still answers without it.",
    tier: "launch-degraded",
  },
  {
    key: "maps",
    capability: "Maps + geocoding (Google)",
    envVars: ["NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_API_KEY"],
    anyOf: true,
    whatLightsUp: "Map views and paid-tier geocoding; free OSM geocoding remains the fallback.",
    tier: "launch-degraded",
  },
  {
    key: "secrets_at_rest",
    capability: "Tenant-secret encryption at rest",
    envVars: ["SECRETS_ENCRYPTION_KEY"],
    whatLightsUp: "Per-tenant credentials (OAuth tokens, SMTP passwords) encrypt on write (AES-256-GCM). Fail-safe no-op without it — but set it before real tenants connect accounts.",
    tier: "launch-degraded",
  },
  {
    key: "sendgrid_events",
    capability: "SendGrid event webhook verification",
    envVars: ["SENDGRID_WEBHOOK_SECRET"],
    whatLightsUp: "Bounce/open/click events verify and feed deliverability + suppression.",
    tier: "launch-degraded",
  },
  {
    key: "voice_streaming",
    capability: "ConversationRelay streaming voice lane",
    envVars: ["CONVERSATION_RELAY_WSS_URL", "RELAY_SHARED_SECRET"],
    whatLightsUp: "The low-latency streaming voice lane; the serverless Gather lane answers without it (fully functional).",
    tier: "launch-degraded",
  },
  {
    key: "contact_enrichment",
    capability: "Contact enrichment (PeopleData)",
    envVars: ["PEOPLEDATA_API_KEY"],
    whatLightsUp: "Lead-pipeline person enrichment; absent, records stay un-enriched and honestly labeled.",
    tier: "launch-degraded",
  },

  // ── optional: osint / research / media / mail / OAuth apps ────────────────
  {
    key: "scraper_fleet",
    capability: "Scraper fleet (Apify + ZenRows)",
    envVars: ["APIFY_API_TOKEN", "ZENROWS_API_KEY"],
    anyOf: true,
    whatLightsUp: "FSBO/expired direct-site sourcing lanes; the free OSINT lane runs regardless.",
    tier: "optional",
  },
  {
    key: "research_search",
    capability: "Neural search / research (Exa · Tavily)",
    // PERPLEXITY_API_KEY was named here and has NO reader left in production:
    // Perplexity's search-augmented models (perplexity-sonar / perplexity-sonar-pro
    // in AI_TASK_ROUTING) are reached through the AI Gateway on AI_GATEWAY_API_KEY
    // like every other model. A checklist row that green-lights on a key nothing
    // reads is a row that lies.
    envVars: ["EXA_API_KEY", "TAVILY_API_KEY"],
    anyOf: true,
    whatLightsUp: "Buyer-intent discovery, competitor intelligence, research-backed content lanes.",
    tier: "optional",
  },
  {
    key: "direct_mail",
    capability: "Direct mail (Lob)",
    envVars: ["LOB_API_KEY"],
    whatLightsUp: "Postcard/letter campaigns behind the CASS gate.",
    tier: "optional",
  },
  {
    key: "stock_media",
    capability: "Stock media (Pexels)",
    envVars: ["PEXELS_API_KEY"],
    whatLightsUp: "Stock photo/video search for content lanes.",
    tier: "optional",
  },
  {
    key: "meta_app",
    capability: "Meta app (social publishing + lead webhooks)",
    envVars: ["META_APP_ID", "META_APP_SECRET"],
    whatLightsUp: "Facebook/Instagram OAuth publishing and Meta leadgen/DM webhooks.",
    tier: "optional",
  },
  {
    key: "google_oauth_app",
    capability: "Google OAuth app (Gmail / Calendar connections)",
    envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    whatLightsUp: "Agents connect their own Gmail/Calendar — the preferred agent-identity email lane.",
    tier: "optional",
  },
  {
    key: "microsoft_oauth_app",
    capability: "Microsoft OAuth app (Outlook connections)",
    envVars: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    whatLightsUp: "Agents connect Outlook/Microsoft 365 for the same agent-identity lane.",
    tier: "optional",
  },
  {
    key: "quickbooks_app",
    capability: "QuickBooks OAuth app (accounting sync)",
    envVars: ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET"],
    whatLightsUp: "Tenant + platform accounting connections.",
    tier: "optional",
  },
]

/** Build the live checklist — presence only; env values are never carried into the result. */
export function buildLaunchChecklist(): LaunchChecklist {
  const items: LaunchChecklistItem[] = ROWS.map((r) => ({
    key: r.key,
    capability: r.capability,
    envVars: [...r.envVars],
    ...(r.anyOf ? { anyOf: true } : {}),
    configured: r.anyOf ? r.envVars.some(isSet) : r.envVars.every(isSet),
    whatLightsUp: r.whatLightsUp,
    tier: r.tier,
  }))

  const count = (tier: LaunchTier) => {
    const rows = items.filter((i) => i.tier === tier)
    return { configured: rows.filter((i) => i.configured).length, total: rows.length }
  }
  const b = count("launch-blocking")
  const d = count("launch-degraded")
  const o = count("optional")

  return {
    generatedAt: new Date().toISOString(),
    blockingConfigured: b.configured,
    blockingTotal: b.total,
    degradedConfigured: d.configured,
    degradedTotal: d.total,
    optionalConfigured: o.configured,
    optionalTotal: o.total,
    items,
  }
}
