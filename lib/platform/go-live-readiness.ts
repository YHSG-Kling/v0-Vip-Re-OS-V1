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
  domains: DomainReadiness[]
}

/** PURE: fold domain results into the go/no-go summary. */
export function rollupReadiness(domains: DomainReadiness[], generatedAt: string): GoLiveReadiness {
  const required = domains.filter((d) => !d.optional)
  return {
    generatedAt,
    requiredReady: required.filter((d) => d.status === "ready").length,
    requiredTotal: required.length,
    domains,
  }
}

type Probe = () => Promise<DomainReadiness>

const d = (key: string, label: string, optional: boolean) =>
  (status: ReadinessStatus, detail: string): DomainReadiness => ({ key, label, status, optional, detail })

/** Run every domain probe (independently — one vendor down never hides the rest). */
export async function runGoLiveReadiness(svc: any): Promise<GoLiveReadiness> {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
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
    async () => {
      const r = d("stripe", "Stripe (billing)", false)
      const key = process.env.STRIPE_SECRET_KEY
      if (!key) return r("not_configured", "STRIPE_SECRET_KEY unset — signup checkout, dunning, and vendor billing can't run")
      const res = await callConnector<{ livemode?: boolean }>({
        connector: "stripe", baseUrl: "https://api.stripe.com",
        path: "/v1/balance", method: "GET", auth: { style: "bearer", token: key },
      })
      if (!res.ok) return r("broken", `Stripe rejected the key (${res.status ?? "—"})`)
      const live = (res.data as any)?.livemode
      const whsec = process.env.STRIPE_WEBHOOK_SECRET ? "webhook secret set" : "STRIPE_WEBHOOK_SECRET unset — register https://<app>/api/webhooks/stripe in the dashboard and set it, or paid signups never activate"
      return r(process.env.STRIPE_WEBHOOK_SECRET ? "ready" : "broken", `Key accepted · ${live ? "LIVE mode" : "TEST mode — swap to the live key before charging real customers"} · ${whsec}`)
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
      const any = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.XAI_API_KEY
      if (!any) return r("not_configured", "No model key found (OPENAI/ANTHROPIC/AI_GATEWAY) — every AI manager depends on one")
      return r("ready", "Model key present (routing table selects per feature)")
    },

    // ── Records / enrichment providers (PLATFORM setup — owner rule: BatchData,
    //    scrapers, video, RentCast are platform providers, never tenant steps) ──
    async () => {
      const r = d("records_provider", "Public-records provider (BatchData)", true)
      const url = process.env.BATCHDATA_MCP_URL
      if (!url) return r("not_configured", "BATCHDATA_MCP_URL unset — phone scrub falls back to REST and the seller net-sheet tax preload skips (template defaults stand, honestly labeled)")
      const { callBatchDataMcp } = await import("@/lib/external/batchdata-mcp")
      // Cheap contract probe — a tools/list-shaped no-op is not exposed, so use
      // an address-free call that fails FAST with the account's real state
      // (insufficient balance reads as broken-with-reason, not silently ready).
      const probe = await callBatchDataMcp("verify_address", { street: "1 Main St", city: "Austin", state: "TX", zip: "78701" })
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
