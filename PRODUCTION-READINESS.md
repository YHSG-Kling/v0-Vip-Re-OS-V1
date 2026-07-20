# PRODUCTION READINESS — the consolidated honest posture

Last updated: round 42. This is the one-page truth about what is enforced by
machinery, what is a live surface, and what is an operator task. Nothing here
is aspirational: every claim points at the code or surface that enforces it.

---

## 1. What the guard chain enforces (machinery, not promises)

The repo carries ~497 named simulator/guard scripts (`test:*` in package.json).
The core chains:

- `npm run guard` — type-check + ~49 chained locks (schema drift, signal
  integrity, egress coverage/scope, manager ownership/dissent, tenant scope,
  session rails, data guard, orphan routes/actions/writes, cron dispatch, …).
- `npm run guard:compliance` — 13 chained compliance locks (consent gates,
  DNC/TCPA phone scrub, sequence-stop, fair housing, content safety,
  spend/agent governance, …).
- `npm run harness:integrity` — the meta-locks that keep the harness itself
  honest (dead components, orphan actions, vocabulary drift, data-guard-guard).

Every lock is a ratchet: baselines can only shrink. A new ungoverned egress
path, schema drift, or orphaned surface fails CI before it reaches production.

## 2. The Launch Checklist (live surface, not tribal knowledge)

`lib/platform/launch-checklist.ts` renders on the superadmin go-live board
(`/dashboard/superadmin/connectors`, `LaunchChecklistCard`) beside the
live-probe Go-Live card:

- **31 env-gate rows** in three tiers — **10 launch-blocking** (Supabase core,
  app URL, cron auth, Stripe key + webhook secret, AI gateway, SendGrid key +
  from-address, Twilio master, platform line), **13 launch-degraded** (voice,
  video/avatars, Zoom, web push, records/enrichment, AVM, maps, secrets-at-rest,
  streaming voice, Vapi legacy), **8 optional** (scrapers, research/OSINT,
  direct mail, stock media, Meta/Google/Microsoft/QuickBooks OAuth apps).
- **Presence only** — env values are never read into the result, serialized, or
  logged (runtime-locked by the simulator with a canary value).
- **No aspirational rows** — every listed env var is grep-verified to actually
  gate code (`scripts/launch-checklist-simulator.ts`, npm name
  `test:launch-checklist` — registration in package.json is an orchestrator
  step, the sim runs standalone via `npx tsx`).
- The checklist is the cheap presence map; the Go-Live card's **live probes**
  remain the proof a configured key actually works (a wrong key looks
  configured until the vendor rejects it).

## 3. Rate-limit posture on public surfaces

Enumerated public/unauthenticated POST surfaces and their protection:

| Surface | Protection |
| --- | --- |
| Self-serve signup (`signupBrokerageAction`) | **In-memory limiter**: 5/10min per IP + strict input validation + duplicate-email guard |
| Get-started coupon check | **In-memory limiter**: 20/min per IP (stops code enumeration) |
| Widget session mint (`/api/widget/session`) | **In-memory limiter**: 10/min per IP |
| Widget chat (`/api/widget/message`) | **In-memory limiter**: 20/min per session token (caps LLM spend) + session-token gate |
| Vendor webhooks (`/api/webhooks/*`) | Signature verification per provider (Stripe/SendGrid/Zoom/Meta/Vapi/…); dev bypass flags are `NODE_ENV`-gated off in production |
| Portal OTP login | Supabase Auth's own OTP rate limits (platform-side) |
| `/api/ref` | GET-only cookie set, allowlisted redirect, no DB write, no code oracle |
| Embed avatar session (`/api/embed/session`) | Usage-cap 429 per brokerage + allowed-domains origin check |
| Behavior signal API | Authenticated + per-contact in-memory limiter |

**Honest limitation, stated in the code** (`lib/security/public-rate-limit.ts`):
the limiter is a fixed-window counter **per serverless instance** — the real
ceiling is limit × warm instances, and cold starts reset windows. It stops
tight single-client abuse loops at zero dependency cost. A **distributed
limiter** (Upstash/Redis or a Postgres counter) is the stated v2 when volume
justifies a shared ledger.

## 4. Error-monitoring verdict

**No third-party error tracker is installed** (no Sentry, no instrumentation.ts
— the two "Sentry" hits in the codebase are comments). Verdict: **acceptable
for beta, revisit at scale.** The honest internal story:

- **Operational failures are already captured in-platform**: the self-heal
  ledger (`self_heal_events`, surfaced on the OS Sentinel), the cron ledger
  (`cron_execution_logs` + `cron_health_snapshot`), the connector gateway's
  per-call error classification (`rate_limited` / `provider_error` /
  `request_rejected`), and the superadmin audit log.
- Vercel captures unhandled function errors/logs at the platform level.
- What a vendor tracker would add: client-side error aggregation and release
  tagging. Deliberately **not** added in this round — no new vendor without an
  owner decision.

## 5. Backup / restore posture

- **Supabase provides**: daily automated backups on paid plans; **PITR
  (point-in-time recovery) is a platform dashboard setting** — enable it on the
  production project before real tenant data lands. Storage buckets are
  redundant object storage but are NOT covered by database PITR.
- **The OS adds**: append-only audit ledgers (superadmin audit log, compliance
  ledger, cron/self-heal ledgers) that make state reconstructable, and the
  **tenant export rails** (`lib/platform/tenant-export.ts`, offboarding round
  24) — any tenant's data can be exported on demand, which doubles as a
  per-tenant logical backup.
- **Honest gap**: there is no application-level scheduled dump beyond
  Supabase's own backups. PITR + Supabase backups are the recovery story;
  that is a platform setting, not code, and belongs on the ops activation list.

## 6. Secrets hygiene (this round's sweep)

Swept `lib/ app/ services/ scripts/ supabase/` for `sk_live`/`sk_test`, AWS
`AKIA`, Google `AIza`, Slack `xoxb`, GitHub `ghp_`, PEM private keys, Supabase
JWTs (`eyJhbGciOi`), Twilio Account SIDs (`AC…`), SendGrid keys (`SG.…`), and
secret-shaped string literals. **Findings: none.** One reviewed non-finding:
`SHAKEN_TRUST_POLICY = "RN7a97…"` in `lib/voice/a2p-registration.ts` is
Twilio's public SHAKEN/STIR trust-policy SID, not a credential. Tenant secrets
encrypt at rest via `lib/security/secret-crypto.ts` (AES-256-GCM, keyed by
`SECRETS_ENCRYPTION_KEY` — on the launch checklist as launch-degraded:
fail-safe without it, set it before tenants connect accounts).

## 7. Ops activation list (human steps — not code)

The launch checklist tells you *whether* these are done; this is *how*:

1. **Supabase**: production project; set `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; **enable PITR**.
2. **App URL + cron**: `NEXT_PUBLIC_APP_URL` = the https production URL
   (webhooks/magic links register against it); set `CRON_SECRET`.
3. **Stripe live**: swap `STRIPE_SECRET_KEY` to the live key; register
   `https://<app>/api/webhooks/stripe` in the Stripe dashboard and set
   `STRIPE_WEBHOOK_SECRET` — paid signups never activate without it.
4. **Email**: `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL`; complete sender
   domain authentication (the go-live board probes it); register the SendGrid
   event webhook → `/api/webhooks/sendgrid-events` and set
   `SENDGRID_WEBHOOK_SECRET`.
5. **Twilio**: `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` +
   `TWILIO_PHONE_NUMBER`; bind the platform number's VoiceUrl to
   `/api/voice/twilio/inbound` (one click on the go-live board); run the A2P
   pipeline per tenant before real SMS volume.
6. **AI gateway**: at least one of `AI_GATEWAY_API_KEY` / `ANTHROPIC_API_KEY` /
   `OPENAI_API_KEY` / `XAI_API_KEY`.
7. **Voice/video vendors (degraded tier)**: `ELEVENLABS_API_KEY` (TTS +
   clones), `DID_API_KEY` (avatars + embed twins).
8. **Zoom**: `ZOOM_CLIENT_ID` + `ZOOM_CLIENT_SECRET`; register the Zoom event
   webhook → `/api/webhooks/zoom` and set `ZOOM_WEBHOOK_SECRET_TOKEN`.
9. **Web push**: generate VAPID keys; set `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto:).
10. **Secrets at rest**: set `SECRETS_ENCRYPTION_KEY` before tenants connect
    OAuth/SMTP accounts.
11. **Verify**: open `/dashboard/superadmin/connectors` — Launch Checklist
    shows the presence gaps; "Run readiness checks" live-probes every vendor;
    "Queue render proof" pushes a real video through the full pipeline.
