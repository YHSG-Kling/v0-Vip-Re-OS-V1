// lib/platform/go-live-readiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE GO-LIVE READINESS BOARD — "are we ready for production?" as a page, not
// a meeting. One on-demand sweep runs a cheap LIVE PROBE per platform domain
// (never just env-var presence: a wrong key looks 'configured' until the
// vendor rejects it) and reports ready / broken / not-configured honestly.
// Read-only everywhere: every probe is a GET/list against the vendor or a
// count against our own DB. Distinct from the OS SENTINEL (runtime health of
// the autonomous layer) — this is CONFIGURATION health: creds, URLs, webhook
// prerequisites. Domains marked optional don't block go-live.

export type ReadinessStatus = "ready" | "broken" | "not_configured"

export interface DomainReadiness {
  key: string
  label: string
  status: ReadinessStatus
  optional: boolean
  detail: string
}

export interface GoLiveReadiness {
  generatedAt: string
  requiredReady: number
  requiredTotal: number
  domains: DomainReadiness[]; configNote: string
}

/** PURE: fold domain results into the go/no-go summary. */
export function rollupReadiness(domains: DomainReadiness[], generatedAt: string): GoLiveReadiness {
  const required = domains.filter((d) => !d.optional)
  return {
    generatedAt,
    requiredReady: required.filter((d) => d.status === "ready").length,
    requiredTotal: required.length,
    domains, configNote: configurationNote(required.filter((d) => d.status === "ready").length, required.length),
  }
}

type Probe = () => Promise<DomainReadiness>

const d = (key: string, label: string, optional: boolean) =>
  (status: ReadinessStatus, detail: string): DomainReadiness => ({ key, label, status, optional, detail })

/** Run every domain probe (independently — one vendor down never hides the rest). */
export async function runGoLiveReadiness(svc: any): Promise<GoLiveReadiness> {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const { getStripeBalance } = await import("@/lib/providers/payment")
  const basic = (u: string, p: string) => ({ style: "basic" as const, username: u, password: p })

  const probes: Probe[] = [
    // ── App fundamentals ────────────────────────────────────────────────────
    async () => {
      const r = d("app_url", "App URL + cron auth", false)
      const url = process.env.NEXT_PUBLIC_APP_URL
      if (!url || !/^https:\/\//.test(url)) return r("not_configured", "NEXT_PUBLIC_APP_URL must be the https production URL — every webhook registers against it")
      if (!process.env.CRON_SECRET) return r("broken", "CRON_SECRET unset — the cron dispatcher can't authenticate its 159 jobs")
      return r("ready", `${url} · cron auth set`)
    },
    async () => {
      const r = d("email_deliverability", "Email deliverability (sender domain auth)", false)
      const { probeSendgridDomainAuth } = await import("@/lib/kernel/email-deliverability")
      const p = await probeSendgridDomainAuth()
      return r(p.status, p.detail)
    },
    async () => {
      const r = d("database", "Database (service role)", false)
      try {
        const { count, error } = await svc.from("brokerages").select("id", { count: "exact", head: true })
        if (error) return r("broken", `Service-role read failed: ${error.message}`)
        return r("ready", `${count ?? 0} brokerage(s) reachable via service role`)
      } catch (e: any) { return r("broken", e?.message ?? "unreachable") }
    },
    async () => {
      const r = d("storage", "Supabase storage (media home)", false)
      try {
        const { data, error } = await svc.storage.from("video-assets").list("", { limit: 1 })
        if (error) return r("broken", `video-assets bucket: ${error.message}`)
        return r("ready", `video-assets bucket reachable (${(data ?? []).length >= 0 ? "list ok" : ""})`)
      } catch (e: any) { return r("broken", e?.message ?? "storage unreachable") }
    },
    // ── The private document buckets' LIVE storage policies (wave 146, lane 146Z on lane 146A's Outside-lane 1 —
    //    ruling 20 priority 1). Read from pg_policies by m874's public.storage_bucket_policy_readiness(), never from a
    //    migration stamp: 'ready' only when every private document bucket is owner-scoped or server-only. Required —
    //    release-blocking until the owner runs docs/operations/OWNER-SQL.md §F (m855) and §G (m875).
    async () => {
      const r = d("storage_policies", "Private document buckets — live storage policies", false)
      try {
        const { data, error } = await svc.rpc("storage_bucket_policy_readiness")
        if (error) {
          return r("not_configured", /42883|PGRST202|Could not find the function/i.test(`${error.code ?? ""} ${error.message}`)
            ? "m874 is not applied — the live policy read does not exist yet"
            : `policy read refused: ${error.message}`)
        }
        const rows = (data ?? []) as Array<{ bucket_id: string; verdict: string }>
        if (rows.length === 0) return r("broken", "the live policy read returned no bucket — nothing was checked, so nothing is reported ready")
        const open = rows.filter((x) => x.verdict !== "owner_scoped" && x.verdict !== "service_only")
        return open.length
          ? r("broken", `owner SQL pending (docs/operations/OWNER-SQL.md §F / §G): ${open.map((x) => `${x.bucket_id}=${x.verdict}`).join(", ")}`)
          : r("ready", `${rows.length} private document buckets owner-scoped or server-only (read from pg_policies)`)
      } catch (e: any) { return r("broken", e?.message ?? "policy read threw") }
    },

    // ── Telephony ───────────────────────────────────────────────────────────
    async () => {
      const r = d("twilio_master", "Twilio master account", false)
      const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN
      if (!sid || !tok) return r("not_configured", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN unset — voice, SMS, subaccounts all depend on this")
      const res = await callConnector<{ status?: string; friendly_name?: string }>({
        connector: "twilio", baseUrl: "https://api.twilio.com",
        path: `/2010-04-01/Accounts/${sid}.json`, method: "GET", auth: basic(sid, tok),
      })
      if (!res.ok) return r("broken", `Twilio rejected the master creds (${res.status ?? "—"})`)
      return r("ready", `${res.data?.friendly_name ?? sid} · status ${res.data?.status ?? "?"}`)
    },
    async () => {
      const r = d("platform_line", "Platform reception line", false)
      const num = process.env.TWILIO_PHONE_NUMBER
      if (!num) return r("not_configured", "TWILIO_PHONE_NUMBER unset — the platform's own AI reception line has no number")
      const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN
      if (!sid || !tok) return r("broken", "Master creds missing — can't verify the number binding")
      const res = await callConnector<{ incoming_phone_numbers?: Array<{ voice_url?: string }> }>({
        connector: "twilio", baseUrl: "https://api.twilio.com",
        path: `/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, method: "GET",
        query: { PhoneNumber: num }, auth: basic(sid, tok),
      })
      const row = res.ok ? res.data?.incoming_phone_numbers?.[0] : null
      if (!row) return r("broken", `Master account doesn't own ${num}`)
      const bound = (row.voice_url ?? "").includes("/api/voice/twilio/inbound")
      return bound ? r("ready", `${num} bound to the AI reception lane`) : r("broken", `${num} owned but VoiceUrl not bound — press "Bind platform number"`)
    },
    async () => {
      const r = d("relay", "ConversationRelay (streaming voice)", true)
      const wss = process.env.CONVERSATION_RELAY_WSS_URL, sec = process.env.RELAY_SHARED_SECRET
      if (!wss && !sec) return r("not_configured", "Optional — unset means the serverless Gather lane answers (fully functional)")
      if (!wss?.startsWith("wss://") || !sec) return r("broken", "Partially configured — needs BOTH CONVERSATION_RELAY_WSS_URL (wss://) and RELAY_SHARED_SECRET")
      return r("ready", `Streaming lane active → ${wss}${process.env.TWILIO_INTELLIGENCE_SERVICE_SID ? " · Conversational Intelligence attached" : ""}`)
    },

    // ── Messaging / email ───────────────────────────────────────────────────
    async () => {
      const r = d("email", "Transactional email (SendGrid)", false)
      const key = process.env.SENDGRID_API_KEY
      if (!key) return r("not_configured", "SENDGRID_API_KEY unset — dunning, digests, and transactional email silently no-op")
      const res = await callConnector({
        connector: "sendgrid", baseUrl: "https://api.sendgrid.com",
        path: "/v3/scopes", method: "GET", auth: { style: "bearer", token: key },
      })
      return res.ok ? r("ready", "SendGrid key accepted") : r("broken", `SendGrid rejected the key (${res.status ?? "—"})`)
    },

    // ── Money ───────────────────────────────────────────────────────────────
    // ONE Stripe client. This check and app/api/cron/health-check/route.ts each
    // re-implemented the key lookup and the /v1/balance request; getStripeBalance
    // in lib/providers/payment already did both and had no caller at all. It
    // returns { success, error, httpStatus, notConfigured, livemode } — every
    // bit this check reads. It does NOT read `available` or `pending`: no
    // balance figure reaches any surface, which is the standing product decision
    // recorded in lib/providers/payment/index.ts.
    // ── THIS PROBE JUDGES THE **PLATFORM'S** STRIPE ACCOUNT, AND SAYS SO ─────
    //
    // OWNER RULING: "the stripe account will be per tenant and platform so no
    // configuration should be hardcoded." This probe used to read
    // `process.env.STRIPE_SECRET_KEY` + `process.env.STRIPE_WEBHOOK_SECRET`
    // directly and call the result "Stripe (billing)" — one green row standing in
    // for every Stripe path in the product, tenant money included. A go-live board
    // that goes green on the wrong architecture is worse than one that fails, so
    // the row is renamed to what it can actually prove and the SOURCE of the
    // credential is reported beside the verdict: a stored platform credential
    // beats the env var, and an operator who does not know which one answered
    // cannot rotate either with confidence.
    async () => {
      const r = d("stripe", "Stripe — the PLATFORM's account (billing)", false)
      const res = await getStripeBalance()
      if (res.notConfigured) {
        return r("not_configured", res.error ?? "The platform has no Stripe credential — signup checkout, dunning, AI overage and vendor marketplace billing can't run")
      }
      if (!res.success) {
        // `success:false` with `notConfigured` false is EITHER a rejected key OR a
        // credential store that could not be read. Both are "broken"; the message
        // carries which, because they have different fixes.
        return r("broken", res.error ?? `Stripe rejected the platform key (${res.httpStatus ?? "—"})`)
      }
      const live = res.livemode

      // Which account signs the tenant-billing webhook, and where its secret came
      // from. `resolvePlatformStripeAccount` prefers a platform-owned
      // platform_credentials row and falls back to STRIPE_WEBHOOK_SECRET.
      //
      // THE PATH IN THIS SENTENCE WAS A 404. It said /api/webhooks/stripe;
      // app/api/webhooks/stripe/ holds ONLY vendor/route.ts, and the tenant
      // billing webhook is /api/billing/webhook. An operator following it
      // registered a dead endpoint and paid signups never activated — the exact
      // outcome this string warns about, caused by the string itself.
      const { resolvePlatformStripeAccount } = await import("@/lib/billing/resolve-stripe-account")
      const platform = await resolvePlatformStripeAccount("tenant_billing")
      const source =
        platform.status === "resolved"
          ? platform.account.fromEnv
            ? "key from STRIPE_SECRET_KEY (no platform_credentials row yet)"
            : `key from platform_credentials row ${platform.account.credentialId}`
          : "key source unresolved"
      const hasHook = platform.status === "resolved" && !!platform.account.webhookSecret
      const whsec = hasHook
        ? "tenant-billing webhook secret set"
        : "no tenant-billing webhook secret — register https://<app>/api/billing/webhook in the PLATFORM's Stripe dashboard and set STRIPE_WEBHOOK_SECRET (or config.webhook_secret on the platform credential), or paid signups never activate"
      return r(
        hasHook ? "ready" : "broken",
        `Platform key accepted · ${source} · ${live ? "LIVE mode" : "TEST mode — swap to the live key before charging real customers"} · ${whsec}`,
      )
    },
    // ── AND THIS ONE JUDGES THE **TENANT** HALF, WHICH NO ENV VAR CAN ───────
    //
    // The previous wave's four-env-var story had no row for this at all, which is
    // how a launch board could read "Stripe: ready" while every brokerage's own
    // money had nowhere to settle. There is nothing for an operator to SET here —
    // each tenant connects their own Stripe in Settings → Connections — so this is
    // reported as OPTIONAL and informational. It is on the board because the
    // number it shows (how many tenants have connected) is the only visibility
    // anyone has into the half of the architecture the ruling added, and because
    // its absence is what a fail-closed refusal will look like in production.
    async () => {
      const r = d("stripe_tenant_accounts", "Stripe — tenants' own accounts", true)
      const { data, error } = await svc
        .from("platform_credentials")
        .select("owner_type, owner_id")
        .eq("platform", "stripe")
        .eq("is_active", true)
        .in("owner_type", ["brokerage", "team", "agent"])
      // supabase-js RESOLVES a refusal — read the error first, and never let an
      // unreadable store render as "no tenants have connected".
      if (error) return r("broken", `Tenant Stripe credentials unreadable (${error.code ?? "no-code"}: ${error.message}) — cannot tell connected tenants from unconnected ones`)
      const rows = (data ?? []) as Array<{ owner_type: string | null }>
      if (rows.length === 0) {
        return r(
          "not_configured",
          "No tenant has connected their own Stripe account yet. Tenant-side money (vendor package fees, vendor job bills, client payments, agent payouts) REFUSES by name until they do — lib/billing/resolve-stripe-account.ts never falls back to the platform's account. Nothing for the platform to set: each tenant connects in Settings → Connections.",
        )
      }
      const byScope = rows.reduce<Record<string, number>>((acc, row) => {
        const k = row.owner_type ?? "unknown"
        acc[k] = (acc[k] ?? 0) + 1
        return acc
      }, {})
      const breakdown = Object.entries(byScope).map(([k, n]) => `${n} ${k}`).join(" · ")
      return r("ready", `${rows.length} tenant Stripe credential(s) connected — ${breakdown}. Each resolves through the ownership cascade (agent → team → brokerage); a tenant without one refuses rather than using the platform's account.`)
    },

    // ── AI voice/media vendors ──────────────────────────────────────────────
    async () => {
      const r = d("elevenlabs", "ElevenLabs (TTS + clones)", true)
      const key = process.env.ELEVENLABS_API_KEY
      if (!key) return r("not_configured", "Optional — week-in-review audio + voice clones stay text-only without it")
      const res = await callConnector({
        connector: "elevenlabs", baseUrl: "https://api.elevenlabs.io",
        path: "/v1/user", method: "GET", auth: { style: "header", name: "xi-api-key", value: key },
      })
      return res.ok ? r("ready", "Key accepted") : r("broken", `ElevenLabs rejected the key (${res.status ?? "—"})`)
    },
    async () => {
      const r = d("did", "D-ID (avatars)", true)
      const key = process.env.DID_API_KEY
      if (!key) return r("not_configured", "Optional — avatar videos + the embed widget need it")
      const res = await callConnector({
        connector: "did", baseUrl: "https://api.d-id.com",
        path: "/credits", method: "GET",
        auth: { style: "header", name: "Authorization", value: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
      })
      return res.ok ? r("ready", "Key accepted") : r("broken", `D-ID rejected the key (${res.status ?? "—"})`)
    },
    async () => {
      const r = d("ai_gateway", "AI model gateway", false)
      // ONE MODEL KEY. This used to accept OPENAI_API_KEY / ANTHROPIC_API_KEY /
      // XAI_API_KEY as substitutes, which was true while provider SDKs still
      // shipped. They no longer do — every text/object/image/transcription call
      // resolves through the Vercel AI Gateway on AI_GATEWAY_API_KEY — so a
      // deployment holding only a provider key would have reported "ready" and
      // then thrown "AI_GATEWAY_API_KEY is not configured" on every AI feature.
      if (!process.env.AI_GATEWAY_API_KEY) {
        return r("not_configured", "AI_GATEWAY_API_KEY unset — every AI manager routes through the Vercel AI Gateway; a bare provider key no longer reaches a model")
      }
      return r("ready", "Gateway key present (routing table selects the model per feature)")
    },

    // ── Records / enrichment providers (PLATFORM setup — owner rule: BatchData,
    //    scrapers, video, RentCast are platform providers, never tenant steps) ──
    async () => {
      const r = d("records_provider", "Public-records provider (BatchData)", true)
      const url = process.env.BATCHDATA_MCP_URL
      if (!url) return r("not_configured", "BATCHDATA_MCP_URL unset — phone scrub falls back to REST and the seller net-sheet tax preload skips (template defaults stand, honestly labeled)")
      const { callBatchDataMcp } = await import("@/lib/external/batchdata-mcp")
      // Cheap contract probe — a tools/list-shaped no-op is not exposed, so use
      // an address call that fails FAST with the account's real state
      // (insufficient balance reads as broken-with-reason, not silently ready).
      // Geo comes from a REAL enrolled subscriber territory (owner rule: no
      // hardcoded ZIP), falling back to a neutral canary only pre-enrollment.
      const { data: territory } = await svc
        .from("subscriber_service_areas")
        .select("zip_code, city, state")
        .eq("active", true).limit(1).maybeSingle()
      const probe = await callBatchDataMcp("verify_address", {
        street: "1 Main St",
        city: (territory as any)?.city ?? "Austin",
        state: (territory as any)?.state ?? "TX",
        zip: (territory as any)?.zip_code ?? "78701",
      })
      if (probe.ok) return r("ready", "BatchData MCP reachable and funded")
      const reason = probe.error ?? "unreachable"
      return /balance/i.test(reason)
        ? r("broken", "BatchData account is OUT OF BALANCE — records preload + phone scrub degrade to defaults until funded")
        : r("broken", `BatchData MCP rejected the probe: ${reason}`)
    },

    // ── Carrier compliance ──────────────────────────────────────────────────
    async () => {
      const r = d("a2p", "A2P 10DLC pipeline", false)
      try {
        const { count } = await svc.from("platform_credentials").select("id", { count: "exact", head: true })
          .eq("platform", "twilio_a2p").eq("is_active", true)
        if ((count ?? 0) === 0) return r("not_configured", 'No tenant registered yet — run "Verify A2P pipeline (mock)" once per environment, then register real tenants from their phone settings')
        return r("ready", `${count} tenant registration(s) in progress or complete`)
      } catch (e: any) { return r("broken", e?.message ?? "read failed") }
    },
  ]

  const results = await Promise.all(probes.map((p) => p().catch((e) =>
    ({ key: "unknown", label: "Probe crashed", status: "broken" as const, optional: false, detail: String(e?.message ?? e) }))))
  return rollupReadiness(results, new Date().toISOString())
}

// ═════════════════════════════════════════════════════════════════════════════
// THE FIVE RELEASE STATES — the ONE source (wave 156, lane 156O; directive §156O "Release states must be honest").
//
// The board above answers ONE question: is the platform CONFIGURED (keys accepted, URLs set, buckets reachable)? That is
// an input to a release, never a release state, so the board no longer prints "GO". The release is five DISTINCT states,
// each with its own evidence; no state implies another, and a simulated or local result can never satisfy a live one:
//
//   CODE GREEN                 static / guard / CI proofs pass (the chain's own exit line, or a CI run id)
//   SECURITY READBACK GREEN    live row-security / storage policies READ BACK on the live project, dated, by a named reader
//   LEGAL/LICENSING READY      counsel-approved agreements and the provider licenses / terms actually held
//   PREVIEW LIVE VERIFIED      a deployed preview's route / secret / provider / cron / e-sign / journey smoke evidence
//   PUBLIC RELEASE AUTHORIZED  the owner says go, after every other state is met and every blocker is cleared
//
// Readers: this board (configNote), scripts/release-rules.ts (re-exports these for test:release-blockers §H), and
// docs/operations/WAVE156-OWNER-ACTION-SHEET.md, whose release-state table parseReleaseStateTable reads. Pure; no I/O.
// ═════════════════════════════════════════════════════════════════════════════

export type ReleaseStateKey = "CODE GREEN" | "SECURITY READBACK GREEN" | "LEGAL/LICENSING READY" | "PREVIEW LIVE VERIFIED" | "PUBLIC RELEASE AUTHORIZED"
/** Where a piece of evidence came from. `simulated` (in-memory, stubbed, canary) and `local_db` (a scratch / local
 *  PostgreSQL) are named ONLY so that they can be refused by name — no live state accepts either. */
export type EvidenceOrigin = "ci" | "local_chain" | "live_read" | "counsel" | "owner" | "deployment" | "simulated" | "local_db"

export interface ReleaseStateSpec {
  key: ReleaseStateKey
  means: string
  /** true = the evidence must come from the real world (the live project, counsel, the owner, a deployment). */
  live: boolean
  origins: readonly EvidenceOrigin[]
  /** every pattern must match the evidence cell (ledger prose, read raw). */
  shape: readonly RegExp[]
  /** owner obligations that must ALL be discharged first (ids as test:release-blockers prints them). */
  blockedBy: readonly string[]
  /** a well-formed evidence row — the guard's positive control proves the shape still accepts what it was written for. */
  specimen: { origin: EvidenceOrigin; reader: string; evidence: string }
}

const LIVE_PROJECT_REF = "hrvaqgvukzxfskkcrwbt"
/** Words that mark a result as not live; a live state refuses evidence carrying any of them. */
export const NOT_LIVE_MARKERS = /\b(simulat\w*|in-memory|stub\w*|mock\w*|scratch|local|localhost|postgresql\s*1\d(?:\.\d+)?|canar(?:y|ies))\b/i

export const RELEASE_STATES: readonly ReleaseStateSpec[] = Object.freeze([
  { key: "CODE GREEN", means: "static / guard / CI proofs pass", live: false, origins: ["ci", "local_chain"],
    shape: [/\bGUARD_EXIT=0\b|\brun \d{9,}\b/], blockedBy: [],
    specimen: { origin: "ci", reader: "integrator", evidence: "guards run 43986529213 green; chain log final line GUARD_EXIT=0" } },
  { key: "SECURITY READBACK GREEN", means: "live row-security and storage policies verified on the live project", live: true, origins: ["live_read"],
    shape: [new RegExp(`\\b${LIVE_PROJECT_REF}\\b`), /\bpg_policies\b/, /storage_bucket_policy_readiness\(\)/],
    blockedBy: ["O1", "O1-LM", "O2", "R6"],
    specimen: { origin: "live_read", reader: "owner (SQL editor)", evidence: `${LIVE_PROJECT_REF}: storage_bucket_policy_readiness() every bucket owner_scoped or service_only; pg_policies R.6 ten rows naming the deal; two-tenant script five REFUSED then ROLLBACK` } },
  { key: "LEGAL/LICENSING READY", means: "counsel-approved agreements and provider licenses / terms actually held", live: true, origins: ["counsel", "owner"],
    shape: [/\b(counsel|attorney)\b/i, /\blicen[cs]e/i, /\bversion\b/i],
    blockedBy: ["LEGAL", "LICENSES"],
    specimen: { origin: "counsel", reader: "owner with counsel", evidence: "counsel sign-off ref LR-1, agreement version 1.0.0 published with its sha256; RentCast license recorded, ceiling set" } },
  { key: "PREVIEW LIVE VERIFIED", means: "deployed route / secret / provider / cron / e-sign / buyer / seller / deal / finance smoke evidence", live: true, origins: ["deployment"],
    shape: [/\bdpl_[A-Za-z0-9]{10,}\b/, /\/api\/cron\/dispatch\b/, /\bsigned in\b/i, /\b302\b/],
    blockedBy: ["O3", "O4", "SEK", "LIVE-PROBES"],
    specimen: { origin: "deployment", reader: "owner", evidence: "dpl_AbCdEf123456 preview: signed in as broker_owner; /api/cron/dispatch ok; share link 302, tampered 404; buyer, seller and deal journeys walked" } },
  { key: "PUBLIC RELEASE AUTHORIZED", means: "the owner says go after every blocker is cleared", live: true, origins: ["owner"],
    shape: [/\bowner\b/i, /\bgo\b/i],
    blockedBy: ["O1", "O1-LM", "O2", "R6", "O3", "O4", "SEK", "LEGAL", "LICENSES", "LIVE-PROBES"],
    specimen: { origin: "owner", reader: "owner", evidence: "owner: go for public release, all four states met" } },
])

export interface ReleaseStateRow { state: string; status: string; date: string; origin: string; reader: string; evidence: string }
export interface ReleaseStateVerdict { key: ReleaseStateKey; met: boolean; why: string }

/** PURE — one state's verdict. MET needs: the status word MET, an ISO date, an origin the state admits (never simulated /
 *  local_db for a live state), a named reader for a live state, evidence matching every shape pattern and — for a live
 *  state — no not-live marker, every blocker discharged, and (PUBLIC RELEASE AUTHORIZED) every other state met. */
export function releaseStateVerdict(key: ReleaseStateKey, row: ReleaseStateRow | undefined, ctx: { openBlockers: readonly string[]; otherStatesMet?: boolean }): ReleaseStateVerdict {
  const spec = RELEASE_STATES.find((s) => s.key === key)
  const no = (why: string): ReleaseStateVerdict => ({ key, met: false, why })
  if (!spec) return no("unknown state")
  if (!row) return no("no evidence row")
  if (row.status !== "MET") return no(`status ${row.status || "blank"}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return no("no ISO date")
  if (!spec.origins.includes(row.origin as EvidenceOrigin)) return no(`origin ${row.origin || "blank"} cannot satisfy ${key}${row.origin === "simulated" || row.origin === "local_db" ? " (a simulated or local result is never live)" : ""}`)
  if (spec.live && NOT_LIVE_MARKERS.test(row.evidence)) return no("the evidence describes a simulated or local result")
  if (spec.live && !/[A-Za-z]{2,}/.test(row.reader.replace(/\b(lane\s*\w*|ci|guard|script|n\/a|none|unknown)\b/gi, ""))) return no("no named reader")
  const missing = spec.shape.filter((re) => !re.test(row.evidence))
  if (missing.length) return no(`evidence lacks ${missing.length} of ${spec.shape.length} required facts`)
  const open = spec.blockedBy.filter((b) => ctx.openBlockers.includes(b))
  if (open.length) return no(`blocked by ${open.join(", ")}`)
  if (key === "PUBLIC RELEASE AUTHORIZED" && !ctx.otherStatesMet) return no("the other four states are not all met")
  return { key, met: true, why: `${row.date}, ${row.origin}, read by ${row.reader}` }
}

/** PURE — all five verdicts; PUBLIC RELEASE AUTHORIZED is judged after the other four. */
export function releaseStateVerdicts(rows: ReadonlyMap<string, ReleaseStateRow>, openBlockers: readonly string[]): ReleaseStateVerdict[] {
  const firstFour = RELEASE_STATES.filter((s) => s.key !== "PUBLIC RELEASE AUTHORIZED").map((s) => releaseStateVerdict(s.key, rows.get(s.key), { openBlockers }))
  const pub = releaseStateVerdict("PUBLIC RELEASE AUTHORIZED", rows.get("PUBLIC RELEASE AUTHORIZED"), { openBlockers, otherStatesMet: firstFour.every((v) => v.met) })
  return [...firstFour, pub]
}

/** PURE — the release-state table between `<!-- release-states:start -->` and `<!-- release-states:end -->`:
 *  | State | Status | Date | Origin | Reader | Evidence | (the first row per state wins). */
export function parseReleaseStateTable(md: string): Map<string, ReleaseStateRow> {
  const block = /<!-- release-states:start -->([\s\S]*?)<!-- release-states:end -->/.exec(md)?.[1] ?? ""
  const rows = new Map<string, ReleaseStateRow>()
  for (const line of block.split("\n")) {
    const c = line.split(/(?<!\\)\|/).slice(1, -1).map((x) => x.trim())
    if (c.length !== 6 || !RELEASE_STATES.some((s) => s.key === c[0])) continue
    if (!rows.has(c[0])) rows.set(c[0], { state: c[0], status: c[1], date: c[2], origin: c[3], reader: c[4], evidence: c[5] })
  }
  return rows
}

/** Phrases that announce a release. Shown nowhere while PUBLIC RELEASE AUTHORIZED is unmet, except in a sentence that
 *  negates it ("never", "not", "no one may", "cannot", "must not", "until"). */
export const RELEASE_CLAIM = /\b(ready to sell|live[- ]ready|ready for public (?:launch|release)|go[- ]live ready)\b/i
const NEGATED = /\b(never|not|no one|cannot|can't|must not|until|unless|refus\w*|forbid\w*|nothing|nobody)\b/i

/** PURE — may this text be shown? Every sentence carrying a release claim must negate it, unless the release is authorized. */
export function releaseClaimAllowed(text: string, publicReleaseAuthorized: boolean): boolean {
  if (publicReleaseAuthorized) return true
  return text.split(/(?<=[.!?;])\s+|\n/).every((s) => !RELEASE_CLAIM.test(s) || NEGATED.test(s))
}

/** PURE — the go-live board's one-line summary. Configuration only: it names the release states it is NOT. */
export function configurationNote(ready: number, total: number): string {
  const all = total > 0 && ready === total
  return `${ready}/${total} required configuration domains answer${all ? "" : " (gaps listed below)"}. Configuration is not a release state: ${RELEASE_STATES.map((s) => s.key).join(" · ")} are judged separately (test:release-blockers §H; docs/operations/WAVE156-OWNER-ACTION-SHEET.md).`
}
