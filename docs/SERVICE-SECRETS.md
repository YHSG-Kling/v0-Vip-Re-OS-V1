# Service Secrets — what each one opens, and how far it reaches

Written 2026-09-03 (lane B) from the code as it stands. Every claim carries the
file:line it was read from; when a line drifts, the file is still the truth.
Nothing here is policy that is not already enforced in a handler.

The single most important fact on this page: **two of these values are
CROSS-TENANT master keys.** The route trusts the tenant named in the request
body once the secret matches. They must be treated as platform credentials, not
integration settings.

| Secret | Where it is checked | Header / carrier | Compare | Tenant reach |
|---|---|---|---|---|
| `INTERNAL_API_SECRET` | 6 routes (below) | three different spellings | plain `===` / `!==` | **CROSS-TENANT** — body names the tenant |
| `WORKFLOW_WEBHOOK_SECRET` | `app/api/workflow/trigger/route.ts` | `Authorization: Bearer` | `timingSafeEqual` | **CROSS-TENANT** — body names the tenant |
| `tenant_webhook_subscriptions.secret` (`whsec_…`) | same route, tenant path | `Authorization: Bearer` | `timingSafeEqual` | ONE brokerage — bound by the lookup predicate |
| `RELAY_SHARED_SECRET` | 3 voice routes | `x-relay-secret` header or `?token=` | `timingSafeEqual` | platform-wide voice brain; scope resolved per call from the dialed number |
| `SHOWINGTIME_WEBHOOK_SECRET` | `app/api/showings/showingtime-webhook/route.ts` | `x-showingtime-signature` (HMAC-SHA256 of raw body) | `timingSafeEqual` | platform-wide; brokerage taken from the payload |
| `vos_…` bearer tokens | `app/api/agentic-os/*` (6 routes) | `Authorization: Bearer vos_…` | sha256 hash lookup in `agent_credentials` | the brokerage on the credential row, gated by its `scopes` |

---

## 1. `INTERNAL_API_SECRET` — cross-tenant master key

One env value, six gates, **three header spellings**. A caller that holds it can
act on any brokerage the body names; none of these routes reads a session for
the tenant on the secret path.

| Route | Gate | Header | Fails closed when unset? | Tenant source |
|---|---|---|---|---|
| `POST /api/intelligence/classify` | `app/api/intelligence/classify/route.ts:6-9` | `x-internal-secret` (raw value, no `Bearer`) | yes — `null !== undefined` refuses | `brokerageId` from body (`:12`) |
| `POST /api/intelligence/coordinate` | `app/api/intelligence/coordinate/route.ts:21-25` | `authorization: Bearer <secret>` | yes — explicit `!expectedSecret ||` (`:23`) | `brokerageId` from body per action (`:32`) |
| `POST /api/intelligence/memory/update` | `app/api/intelligence/memory/update/route.ts:11-26` | `authorization: Bearer <secret>` | yes — 500 "not set" (`:14-19`) | `brokerageId` from body (`:30`) |
| `POST /api/intelligence/kb/embed` | `app/api/intelligence/kb/embed/route.ts:6-11` | `authorization: Bearer <secret>` | yes (`:9`) | none in body — embeds by `topicId` / `embedAll` (`:14-18`), i.e. every tenant's articles |
| `GET /api/admin/health-status` | `app/api/admin/health-status/route.ts:63-66` | `x-internal-api-secret` | secret path simply does not apply; falls through to the session check | none — platform catalogue only (`brokerage_id IS NULL`, `:69-76`) |
| `POST /api/errors/collect` | `app/api/errors/collect/route.ts:14-19` | `x-internal-api-secret` | secret path does not apply; falls through to a session check (`:22-27`) | whatever the body carries into `collectError` |

Not on the task's list but checked by the same value and therefore rotated with
it: `kb/embed`. Not gated by it at all despite the name: nothing under
`app/api/cron/**` (those use `CRON_SECRET` via `lib/cron-auth.ts:26`).

**In-tree senders: none.** No runtime file in `app/` or `lib/` sends
`x-internal-secret`, `x-internal-api-secret`, or `Bearer ${INTERNAL_API_SECRET}`
(grep 2026-09-03; the only mentions are comments in
`app/actions/system-health.ts:248`, `app/actions/error-handler.ts:22`,
`app/api/cron/conversation-insights-refresh/route.ts:22`,
`lib/platform/service-catalogue-scope.ts:62`, and a removed client-side leak
documented at `app/dashboard/settings/knowledge-base/knowledge-base-client.tsx:263-264`).
Every holder is therefore off-repo, which is what makes rotation a coordination
task rather than a deploy.

**Rotation.** Each gate compares against exactly one value — there is no
old/new dual-acceptance window anywhere in the code. Rotating means: set the
new value on every off-repo caller first, then change the env var and redeploy;
during the gap one side is refused. Because the key is cross-tenant, treat a
suspected leak as a platform incident (every tenant reachable), not a tenant
one.

## 2. `WORKFLOW_WEBHOOK_SECRET` — cross-tenant master key (platform path)

`POST /api/workflow/trigger` — `app/api/workflow/trigger/route.ts`.

- Platform path: `:100-103` — `Bearer` token compared with `timingSafeEqual`
  (`secretsMatch`, `:55-60`). On a match the body's `brokerageId` is trusted as
  given (`:72-86`), so this value enrolls contacts into **any** brokerage's
  sequences. Unset env → this path is disabled, never widened (`:101`, `:127-129`).
- Tenant path: `:107-125` — the token is compared against every ACTIVE
  `tenant_webhook_subscriptions.secret` **of the brokerage named in the body**
  (`.eq("brokerage_id", brokerageId)`, `:111-112`). The body's id is a lookup
  key, not a claim: a secret can only ever authorise the brokerage whose row
  holds it. A refused lookup is a 401 (`:113-117`), not a pass.
- Both paths log `payload.authorised_via` on the `workflow_webhook_events` audit
  row (`:154`).

The tenant secret is the `whsec_…` value minted on `/settings/developers`
(`app/actions/tenant-webhooks.ts`, `lib/platform/tenant-webhooks-core.ts:198-200`
`generateWebhookSecret`), shown once at mint and stored raw because it also signs
outbound deliveries (`tenant-webhooks-core.ts:208`). It is per subscription;
rotating it is delete-and-recreate the subscription in that UI. The header used
to promise `brokerage_integrations.config.webhook_secret`; that column does not
exist (`scripts/schema-snapshot.ts:145`) and no code ever minted one.

**Rotation (platform value).** Single value, no dual window (same shape as §1).
Tenants holding their own `whsec_` secret are unaffected by a platform rotation
and vice versa.

## 3. `RELAY_SHARED_SECRET` — the voice brain's shared secret

| Route | Gate | Carrier |
|---|---|---|
| `POST /api/voice/relay/plan` | `app/api/voice/relay/plan/route.ts:23-27` | `x-relay-secret` header, `timingSafeEqual`, 401 when unset or wrong |
| `POST /api/voice/twilio/intelligence` | `app/api/voice/twilio/intelligence/route.ts:23-28` | `?token=` query string, `timingSafeEqual`, **404** when unset or wrong (deliberately silent) |
| `POST /api/voice/twilio/whisper` | `app/api/voice/twilio/whisper/route.ts:24-29` via `lib/voice/warm-transfer.ts:46-48` `whisperToken()` | `?token=` query string, `timingSafeEqual`, 404 |

Reach: none of the three takes a tenant from the caller. `relay/plan` resolves
scope from the dialed number (`isPlatformNumber` at `:37`, then
`resolveInboundContext` for tenant numbers); `intelligence` and `whisper` key on Twilio SIDs. The secret
therefore opens the whole voice brain, not one tenant.

Holders: the out-of-process relay companion (`tools/relay-companion/server.mjs:23`,
sends the header per `docs/PHONE-SYSTEM-SETUP.md:102-104`) and the Twilio
console (the Intelligence Service webhook URL registered with `?token=`,
`docs/PHONE-SYSTEM-SETUP.md:155`; the whisper URLs are authored by the app
itself). **Fallback to note:** `whisperToken()` falls back to `CRON_SECRET` when
`RELAY_SHARED_SECRET` is unset (`lib/voice/warm-transfer.ts:47`), so on a
deployment without the relay secret, the cron secret also opens the whisper
endpoints.

**Rotation.** Three places must move together: the env var here, the companion
host's env, and the Twilio console webhook URL. No dual window in code.

## 4. `SHOWINGTIME_WEBHOOK_SECRET` — HMAC signing key

`POST /api/showings/showingtime-webhook` — `app/api/showings/showingtime-webhook/route.ts:61-73`.
HMAC-SHA256 over the **raw** request body, hex, compared `timingSafeEqual`
against `x-showingtime-signature`; unset → 503 "Webhook not configured"
(`:62-64`), mismatch → 401 (`:75`). Tenant reach: the payload's `brokerage_id`
(`:52`) is used after signature verification — one key, every tenant's
appointments. The route's own header (`:13`) mentions a per-brokerage
`brokerage_credentials.showingtime.webhook_secret`; the handler at `:61` reads
only the env var.

**Rotation.** Regenerate on the ShowingTime side, set the env var, redeploy;
deliveries signed with the old key are refused from that moment.

## 5. `vos_…` agent bearer tokens — tenant-scoped, scope-gated

Format: `vos_` + 32 random bytes base64url (`lib/agentic-os/agent-credentials.ts:11,19-21`).
Only the sha256 is stored (`agent_credentials.token_hash`,
`agent-credentials.ts:14-16`; raw value shown once at mint —
`app/actions/tenant-webhooks.ts:354-363` for the tenant developers page,
`app/actions/agentic-tokens.ts:62-68` for the superadmin page).

Resolution: `resolveAgenticCaller` (`agent-credentials.ts:72-93`) hashes the
bearer, looks up `agent_credentials` by `token_hash` (`resolveAgentToken`,
`:41-52`), refuses inactive or expired rows (`:51-52`), and returns `{ brokerageId, scopes, via: "token" }`. A
token present but unknown yields `via: "none"` — it does **not** fall through
to the session (`:76-77`).

| Route | Gate |
|---|---|
| `GET /api/agentic-os/actions` | `app/api/agentic-os/actions/route.ts:19-20` |
| `GET /api/agentic-os/actions/[capability]` | `app/api/agentic-os/actions/[capability]/route.ts:14-15` |
| `POST /api/agentic-os/actions/[capability]/invoke` | `app/api/agentic-os/actions/[capability]/invoke/route.ts:42-43` |
| `/api/agentic-os/connectivity` | `app/api/agentic-os/connectivity/route.ts:15-16` |
| `/api/agentic-os/mcp` | `app/api/agentic-os/mcp/route.ts:63-64`, per-action scope check `:102` (`hasScope`) |
| `/api/agentic-os/voice` | `app/api/agentic-os/voice/route.ts:65-66` |

`/api/agentic-os/resolve-capability` is **not** token-reachable: it uses
`requirePlatformStaffAuth` (`app/api/agentic-os/resolve-capability/route.ts:24`),
a session gate, as its header (`:10-11`) states.

Reach: the brokerage on the credential row, further narrowed by `scopes`; a
session caller who is platform staff gets `["*"]` (`agent-credentials.ts:87-91`),
a token never does unless minted with it.

**Rotation.** Per token: deactivate or delete the `agent_credentials` row (the
hash is the only server-side copy) and mint a new one; `expires_at` is honoured
at resolve time (`:52`). No platform-wide value exists to rotate.

## 6. Where these do NOT apply

- `CRON_SECRET` gates `app/api/cron/**` through `lib/cron-auth.ts` and is
  outside this page except for the `whisperToken()` fallback in §3.
- Stripe webhook signing secrets (`STRIPE_WEBHOOK_SECRET`, tenant
  `platform_credentials.config.webhook_secret`) are resolved per signing account
  by `lib/billing/stripe-webhook-secrets.ts` and documented there.
- Nothing on this page authenticates a browser session. Session routes resolve
  the tenant from `users.brokerage_id` via `lib/kernel/api-auth.ts:requireAuth`
  or `lib/identity/get-agent-context.ts`, never from the body.
