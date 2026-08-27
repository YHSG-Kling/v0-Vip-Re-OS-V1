// lib/providers/webhook-contract.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE INBOUND WEBHOOK CONTRACT — one module, one row per inbound webhook route.
//
// Owner ruling, verbatim: "any webhook url needs to be researched to find the
// latest path which is part of the connection self heal since providers change
// or update their connection methods as their way of keeping up with
// technology."
//
// This is the missing half of that self-heal (§1.2): the fleet posture layer
// already watches per-NUMBER webhook drift (lib/platform/provider-posture.ts:
// expectedWebhookTargets / classifyNumberBinding — Twilio voice+sms only,
// probe-able because Twilio's API exposes each number's SmsUrl/VoiceUrl). For
// every OTHER provider the binding lives in a console we cannot read, so the
// self-heal half we CAN own is a canonical, human-readable contract: for each
// inbound route, the path we serve, the verification scheme the route really
// implements (held in agreement by scripts/webhook-contract-guard.ts, which
// derives the scheme from the route files' stripped source rather than
// trusting this table), the env vars carrying its secrets, the provider's
// protocol version where one exists, and where to paste the URL. The
// superadmin connectors page renders these rows so a human re-pointing a
// console has ONE place to read the canonical URL.
//
// BLIND SPOT, published with the number (§2): this contract asserts what WE
// serve. Console-side drift (a provider still pointed at an old path) is
// detectable only by delivery failures; the `failureVisibility` field names
// the surface that would show them, or is null where nothing would — the
// honest remaining gap per provider.
//
// PURE MODULE — no server-only imports; safe for guards, server components,
// and posture code alike.

export type WebhookVerificationScheme =
  /** HMAC-SHA256 of the raw body with a shared secret, compared timing-safe. */
  | "hmac-sha256"
  /** Ed25519 (or HMAC fallback) signature of the raw body — GHL 2026 scheme. */
  | "ed25519-or-hmac-sha256"
  /** Twilio: HMAC-SHA1 over full URL + sorted POST params (X-Twilio-Signature). */
  | "twilio-url-hmac-sha1"
  /** Meta: hub.verify_token GET handshake + X-Hub-Signature-256 HMAC on POST. */
  | "meta-hub-plus-sha256"
  /** Meta-style GET handshake only — POST payloads arrive UNVERIFIED (gap). */
  | "hub-verify-token-only"
  /** A static shared secret compared verbatim (query param or header). */
  | "shared-secret"
  /** Stripe-Signature scheme (t=...,v1=... HMAC-SHA256), per-endpoint secret. */
  | "stripe-signature"
  /** Zoom: HMAC-SHA256 over v0:timestamp:body, plus URL-validation challenge. */
  | "zoom-hmac-sha256"
  /** Multi-provider ingress — per-provider schemes inside one route. */
  | "multi-provider"
  /** No caller verification at all — recorded, never hidden. */
  | "none"

export interface WebhookContractEntry {
  /** Canonical provider key (matches connector/posture naming where one exists). */
  provider: string
  /** What the provider delivers here — provider+eventKind is UNIQUE across the
   *  contract (the duplicate-pair defect this contract closes) unless a compat
   *  marker names the survivor. */
  eventKind: string
  /** Public path this repo serves. */
  path: string
  /** Repo-relative route file — the source of truth the guard scans. */
  routeFile: string
  /** The verification the route implements. */
  scheme: WebhookVerificationScheme
  /** Header (or query) names the route reads for caller verification. */
  verificationHeaders: string[]
  /** Env vars holding the secret(s)/key(s). Empty = secretless (recorded gap). */
  secretEnv: string[]
  /** Repo-relative module(s) actually implementing verification / secret
   *  resolution when the route delegates; the guard scans these files (with
   *  the route file) for the crypto construct and env names. */
  implementedIn?: string[]
  /** Provider protocol/API version where one exists, with research date. */
  protocolVersion?: string
  /** Where a human pastes the canonical URL. */
  consoleField: string
  /** Where a delivery failure would become visible, or null = blind (§2). */
  failureVisibility: string | null
  /** Set when this route deliberately duplicates another entry's
   *  provider+eventKind: names the surviving path and why this one persists. */
  compat?: { survivorPath: string; reason: string }
  notes?: string
}

/** Canonical absolute URL for one contracted route. */
export function canonicalWebhookUrl(appUrl: string, entry: Pick<WebhookContractEntry, "path">): string {
  return `${appUrl.replace(/\/$/, "")}${entry.path}`
}

/** Lookup by public path (exact). */
export function findWebhookContractEntry(path: string): WebhookContractEntry | null {
  return WEBHOOK_CONTRACT.find((e) => e.path === path) ?? null
}

export const WEBHOOK_CONTRACT: WebhookContractEntry[] = [
  // ── Meta (one app shell; tenants connect their own pages/accounts) ─────────
  {
    provider: "meta",
    eventKind: "messenger-instagram-dm",
    path: "/api/webhooks/meta-dm",
    routeFile: "app/api/webhooks/meta-dm/route.ts",
    scheme: "meta-hub-plus-sha256",
    verificationHeaders: ["x-hub-signature-256"],
    secretEnv: ["META_WEBHOOK_VERIFY_TOKEN", "META_VERIFY_TOKEN", "META_APP_SECRET", "FACEBOOK_APP_SECRET"],
    protocolVersion: "Graph API v25.0 current (2026-08-27); handshake + X-Hub-Signature-256 are version-independent",
    consoleField: "Meta App Dashboard → Webhooks → Callback URL (Messenger + Instagram `messages` subscriptions)",
    failureVisibility: null,
    notes: "Survivor of the meta/meta-dm duplicate pair (2026-08-27) — tombstone in the route header.",
  },
  {
    provider: "meta",
    eventKind: "lead-ads",
    path: "/api/webhooks/meta-leadgen",
    routeFile: "app/api/webhooks/meta-leadgen/route.ts",
    scheme: "hub-verify-token-only",
    verificationHeaders: [],
    secretEnv: ["META_WEBHOOK_VERIFY_TOKEN"],
    protocolVersion: "Graph API v25.0 current (2026-08-27)",
    consoleField: "Meta App Dashboard → Webhooks → Callback URL (Page `leadgen` subscription)",
    failureVisibility: "unmatched paid leads park via lib/kernel/ingress-continuity.ts (parkIngressEvent) for the daily reconciler",
    notes: "GAP: POST payloads are not X-Hub-Signature-256-verified (lead-scraping lane owns this route's ingest logic).",
  },
  {
    provider: "meta",
    eventKind: "whatsapp-messages",
    path: "/api/webhooks/whatsapp",
    routeFile: "app/api/webhooks/whatsapp/route.ts",
    scheme: "hub-verify-token-only",
    verificationHeaders: [],
    secretEnv: ["WHATSAPP_VERIFY_TOKEN", "META_VERIFY_TOKEN"],
    protocolVersion: "WhatsApp Cloud API (Graph API v25.0 current, 2026-08-27)",
    consoleField: "Meta App Dashboard → WhatsApp → Configuration → Webhook Callback URL",
    failureVisibility: null,
    notes: "GAP: POST payloads are not X-Hub-Signature-256-verified.",
  },

  // ── GoHighLevel / LeadConnector ────────────────────────────────────────────
  {
    provider: "gohighlevel",
    eventKind: "crm-events",
    path: "/api/webhooks/gohighlevel",
    routeFile: "app/api/webhooks/gohighlevel/route.ts",
    scheme: "ed25519-or-hmac-sha256",
    verificationHeaders: ["x-ghl-signature"],
    secretEnv: ["GHL_WEBHOOK_SECRET", "GHL_WEBHOOK_ED25519_PUBLIC_KEY"],
    protocolVersion: "LeadConnector x-ghl-signature Ed25519 (2026 security update); legacy x-wh-signature RSA deprecated 2026-09-01",
    consoleField: "GHL workflow custom-webhook action URL, or Marketplace app webhook URL",
    failureVisibility: null,
    notes: "Survivor of the ghl/gohighlevel duplicate pair (2026-08-27). Verified no-op ack — GHL is sync-out only (product ruling); inbound contact import is the scheduled pull in lib/crm/import-pull.ts.",
  },

  // ── Twilio (messaging + voice; numbers bound by lib/voice/twilio-voice.ts) ─
  {
    provider: "twilio",
    eventKind: "sms-inbound",
    path: "/api/providers/inbound",
    routeFile: "app/api/providers/inbound/route.ts",
    scheme: "multi-provider",
    verificationHeaders: [
      "x-twilio-signature",
      "x-twilio-email-event-webhook-signature",
      "x-twilio-email-event-webhook-timestamp",
      "x-postmark-signature",
      "x-postmark-token",
    ],
    secretEnv: ["TWILIO_AUTH_TOKEN", "SENDGRID_WEBHOOK_SECRET", "POSTMARK_WEBHOOK_SECRET", "MAILGUN_WEBHOOK_SECRET"],
    implementedIn: ["lib/providers/inbound-router.ts"],
    consoleField: "Twilio Console → Phone Numbers → each number's Messaging webhook (SmsUrl) — bound automatically by bindNumberToTwilioLane; also accepts SendGrid/Postmark/Mailgun inbound email",
    failureVisibility: "phone_number_events records bindings; STOP suppressions land on compliance_events + self_heal_events (sentinelWrite)",
    notes: "THE canonical inbound messaging ingress (SmsUrl on every provisioned tenant number). Twilio subaccounts sign with their OWN token — twilioTokenCandidates resolves per-tenant.",
  },
  {
    provider: "twilio",
    eventKind: "sms-inbound",
    path: "/api/sms/inbound-optout",
    routeFile: "app/api/sms/inbound-optout/route.ts",
    scheme: "twilio-url-hmac-sha1",
    verificationHeaders: ["x-twilio-signature"],
    secretEnv: ["TWILIO_AUTH_TOKEN"],
    implementedIn: ["lib/voice/twilio-voice.ts", "lib/voice/sms-inbound.ts"],
    consoleField: "Twilio Console → legacy SmsUrl (should be re-pointed to /api/providers/inbound)",
    failureVisibility: "compliance_events via addSuppression; refused STOPs return 503 so Twilio retries",
    compat: {
      survivorPath: "/api/providers/inbound",
      reason:
        "Console reachability UNRESOLVED (2026-08-27): a number's single SmsUrl may still be pasted here, and a STOP that 404s is a TCPA defect. Delete only after the Twilio console audit shows no number pointing here — see the route header.",
    },
  },
  {
    provider: "twilio",
    eventKind: "voice-inbound",
    path: "/api/voice/twilio/inbound",
    routeFile: "app/api/voice/twilio/inbound/route.ts",
    scheme: "twilio-url-hmac-sha1",
    verificationHeaders: ["x-twilio-signature"],
    // Per-tenant/platform auth tokens are resolved from the DB by
    // resolveInboundContext — no env-held secret on this route.
    secretEnv: [],
    implementedIn: ["lib/voice/twilio-voice.ts"],
    consoleField: "Twilio Console → Phone Numbers → each number's Voice webhook (VoiceUrl) — bound automatically by bindNumberToTwilioLane",
    failureVisibility: "per-number drift surfaced by getTwilioFleetPosture (lib/platform/provider-posture.ts)",
  },
  {
    provider: "twilio",
    eventKind: "voice-status-callback",
    path: "/api/voice/twilio/status",
    routeFile: "app/api/voice/twilio/status/route.ts",
    scheme: "twilio-url-hmac-sha1",
    verificationHeaders: ["x-twilio-signature"],
    secretEnv: ["TWILIO_AUTH_TOKEN"],
    implementedIn: ["lib/voice/twilio-voice.ts"],
    consoleField: "Twilio Console → each number's StatusCallback — bound automatically by bindNumberToTwilioLane",
    failureVisibility: "voice ledger rows closed by the status callback; stalls surface on the voice billing rail",
  },
  {
    provider: "twilio",
    eventKind: "sms-delivery-status",
    path: "/api/webhooks/twilio-sms-status",
    routeFile: "app/api/webhooks/twilio-sms-status/route.ts",
    scheme: "shared-secret",
    verificationHeaders: ["x-webhook-secret"],
    secretEnv: ["TWILIO_STATUS_WEBHOOK_SECRET"],
    consoleField: "Twilio Console → Messaging Service / message StatusCallback URL (append ?secret=…)",
    failureVisibility: "delivery statuses land on the message ledger this route writes",
  },

  // ── Email engagement / suppression ─────────────────────────────────────────
  {
    provider: "sendgrid",
    eventKind: "engagement-events",
    path: "/api/webhooks/sendgrid-events",
    routeFile: "app/api/webhooks/sendgrid-events/route.ts",
    scheme: "shared-secret",
    verificationHeaders: ["x-webhook-secret"],
    secretEnv: ["SENDGRID_WEBHOOK_SECRET"],
    consoleField: "SendGrid → Settings → Mail Settings → Event Webhook URL (append ?secret=…)",
    failureVisibility: "suppression SYNC sweep in getSendgridPosture catches events missed while the webhook was down",
  },
  {
    provider: "multi-esp",
    eventKind: "inbound-email-user",
    path: "/api/webhooks/inbound-mail",
    routeFile: "app/api/webhooks/inbound-mail/route.ts",
    scheme: "multi-provider",
    verificationHeaders: [],
    secretEnv: [],
    implementedIn: ["lib/inbound-mail/providers.ts"],
    consoleField: "Postmark/SendGrid/Mailgun/Resend inbound parse URL; Gmail/Outlook push subscriptions (per-user OAuth)",
    failureVisibility: null,
    notes: "Per-user provider resolution (user → team → brokerage cascade); verification is per-provider inside lib/inbound-mail/providers.ts.",
  },
  {
    provider: "multi-esp",
    eventKind: "inbound-suppression-feed",
    path: "/api/webhooks/inbound-suppression",
    routeFile: "app/api/webhooks/inbound-suppression/route.ts",
    scheme: "shared-secret",
    verificationHeaders: ["x-webhook-secret"],
    secretEnv: ["INBOUND_SUPPRESSION_WEBHOOK_SECRET"],
    consoleField: "External suppression feed target URL",
    failureVisibility: "suppression writes are error-checked; tenant resolved by resolveUnambiguousTenant",
  },

  // ── E-sign / transaction docs (ingress-continuity dead-letter class) ───────
  {
    provider: "docusign",
    eventKind: "esign-events",
    path: "/api/webhooks/docusign",
    routeFile: "app/api/webhooks/docusign/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-docusign-signature-1"],
    secretEnv: ["DOCUSIGN_WEBHOOK_SECRET"],
    consoleField: "DocuSign Connect configuration URL",
    failureVisibility: "unmatched envelopes park via lib/kernel/ingress-continuity.ts and replay daily",
  },
  {
    provider: "dotloop",
    eventKind: "esign-events",
    path: "/api/webhooks/dotloop",
    routeFile: "app/api/webhooks/dotloop/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-dotloop-signature"],
    secretEnv: ["DOTLOOP_WEBHOOK_SECRET"],
    consoleField: "Dotloop webhook subscription URL",
    failureVisibility: "unmatched envelopes park via lib/kernel/ingress-continuity.ts and replay daily",
  },
  {
    provider: "skyslope",
    eventKind: "esign-events",
    path: "/api/webhooks/skyslope",
    routeFile: "app/api/webhooks/skyslope/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-skyslope-signature"],
    secretEnv: ["SKYSLOPE_WEBHOOK_SECRET"],
    consoleField: "SkySlope webhook subscription URL",
    failureVisibility: "unmatched envelopes park via lib/kernel/ingress-continuity.ts and replay daily",
  },
  {
    provider: "authentisign",
    eventKind: "esign-events",
    path: "/api/webhooks/authentisign",
    routeFile: "app/api/webhooks/authentisign/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-authentisign-signature"],
    secretEnv: ["AUTHENTISIGN_WEBHOOK_SECRET"],
    consoleField: "Authentisign webhook subscription URL",
    failureVisibility: "unmatched envelopes park via lib/kernel/ingress-continuity.ts and replay daily",
  },

  // ── Social DM (non-Meta) ───────────────────────────────────────────────────
  {
    provider: "linkedin",
    eventKind: "member-dm",
    path: "/api/webhooks/linkedin",
    routeFile: "app/api/webhooks/linkedin/route.ts",
    scheme: "hub-verify-token-only",
    verificationHeaders: [],
    secretEnv: ["LINKEDIN_WEBHOOK_VERIFY_TOKEN", "LINKEDIN_CLIENT_SECRET"],
    consoleField: "LinkedIn Developer Portal → app webhook URL",
    failureVisibility: null,
    notes: "GET challenge is HMAC-answered with LINKEDIN_CLIENT_SECRET; GAP: POST payloads arrive unverified.",
  },
  {
    provider: "twitter",
    eventKind: "account-activity-dm",
    path: "/api/webhooks/twitter",
    routeFile: "app/api/webhooks/twitter/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-twitter-webhooks-signature"],
    secretEnv: ["TWITTER_CONSUMER_SECRET"],
    consoleField: "X (Twitter) Developer Portal → Account Activity API webhook URL",
    failureVisibility: null,
  },

  // ── Billing / vendor marketplace ───────────────────────────────────────────
  {
    provider: "stripe",
    eventKind: "vendor-marketplace-events",
    path: "/api/webhooks/stripe/vendor",
    routeFile: "app/api/webhooks/stripe/vendor/route.ts",
    scheme: "stripe-signature",
    verificationHeaders: ["stripe-signature"],
    secretEnv: [],
    implementedIn: ["lib/billing/stripe-webhook-secrets.ts"],
    protocolVersion: "Stripe webhook signature v1 (t=…,v1=… HMAC-SHA256)",
    consoleField: "Stripe Dashboard → Developers → Webhooks → endpoint URL (vendor_marketplace endpoint)",
    failureVisibility: "Stripe dashboard retries + the stripe-drift cron cross-checks",
    notes: "Per-endpoint signing secret resolved by verifyStripeWebhook, not a single env var.",
  },

  // ── Ops / content providers ────────────────────────────────────────────────
  {
    provider: "anthropic",
    eventKind: "agent-callbacks",
    path: "/api/webhooks/anthropic-agent",
    routeFile: "app/api/webhooks/anthropic-agent/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-anthropic-signature", "anthropic-webhook-signature"],
    secretEnv: ["ANTHROPIC_WEBHOOK_SIGNING_KEY"],
    consoleField: "Agent callback URL supplied when the async agent job is created",
    failureVisibility: null,
  },
  {
    provider: "d_id",
    eventKind: "video-render-events",
    path: "/api/webhooks/did",
    routeFile: "app/api/webhooks/did/route.ts",
    scheme: "shared-secret",
    verificationHeaders: ["x-webhook-secret"],
    secretEnv: ["DID_WEBHOOK_SECRET"],
    consoleField: "D-ID webhook URL passed on talk/clip creation (append ?secret=…)",
    failureVisibility: "render stalls surface on the video queue terminal states",
  },
  {
    provider: "lob",
    eventKind: "direct-mail-events",
    path: "/api/webhooks/lob-events",
    routeFile: "app/api/webhooks/lob-events/route.ts",
    scheme: "shared-secret",
    verificationHeaders: ["x-webhook-secret"],
    secretEnv: ["LOB_WEBHOOK_SECRET"],
    consoleField: "Lob Dashboard → Webhooks → URL (append ?secret=…)",
    failureVisibility: null,
  },
  {
    provider: "zoom",
    eventKind: "recording-events",
    path: "/api/webhooks/zoom",
    routeFile: "app/api/webhooks/zoom/route.ts",
    scheme: "zoom-hmac-sha256",
    verificationHeaders: ["x-zm-signature", "x-zm-request-timestamp"],
    secretEnv: ["ZOOM_WEBHOOK_SECRET_TOKEN"],
    implementedIn: ["lib/connections/zoom.ts"],
    consoleField: "Zoom App Marketplace → app → Event Subscriptions URL",
    failureVisibility: null,
  },
  {
    provider: "zapier",
    eventKind: "automation-events",
    path: "/api/webhooks/zapier",
    routeFile: "app/api/webhooks/zapier/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-zapier-signature"],
    secretEnv: ["ZAPIER_WEBHOOK_SECRET"],
    consoleField: "Zap webhook action URL",
    failureVisibility: null,
  },
  {
    provider: "ce_provider",
    eventKind: "course-completions",
    path: "/api/webhooks/ce-provider",
    routeFile: "app/api/webhooks/ce-provider/route.ts",
    scheme: "hmac-sha256",
    verificationHeaders: ["x-ce-signature"],
    secretEnv: ["CE_PROVIDER_WEBHOOK_SECRET"],
    implementedIn: ["lib/education/ce-provider.ts"],
    consoleField: "Accredited CE provider's completion callback URL",
    failureVisibility: null,
  },
]
