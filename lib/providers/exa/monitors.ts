// lib/providers/exa/monitors.ts
// ─────────────────────────────────────────────────────────────────────────────
// EXA SEARCH MONITORS — MONITORED DELTAS OVER REPEATED SEARCHES (wave 151, lane 151D).
//
// A Search Monitor (POST /monitors) runs a play's search on a cadence and PUSHES only the NEW results to
// our webhook (app/api/webhooks/exa/route.ts) as `monitor.run.completed`. Exa signs every delivery:
//   Exa-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 over `${t}.${rawBody}`>   (docs.exa.ai, read 2026-11-09)
// with a secret returned ONCE at creation. That secret is sealed per monitor (lib/security/secret-crypto.ts
// encryptSecret — fail-closed without SECRETS_ENCRYPTION_KEY: no monitor is created that we could not
// verify) in provider_monitors.webhook_secret_ciphertext (m969); EXA_WEBHOOK_SECRET is the env fallback
// for a monitor created in the Exa dashboard by hand.
//
// THE DELIVERY RULES (directive: "signed, idempotent webhook deliveries, replay-safe, never trusting
// payload identifiers without verification"):
//   · the payload's monitor id only SELECTS which sealed secret to verify with; the SIGNATURE proves Exa
//     sent it for that monitor; the TENANT and TERRITORY come from OUR provider_monitors row — never from
//     the payload's metadata;
//   · an unregistered (unknown) monitor is acknowledged (202) and nothing is done;
//   · a replay (same event id inside 7 days) answers 200 replayed through emitKernelEvent's dedupe key, and
//     the C35 idempotency key on every raw row is the second, longer-lived guard;
//   · a stale timestamp (> 5 min) or a bad signature is 401; no secret at all is 503 (fail closed);
//   · the run's RESULTS walk the registered play through lib/acquisition-plays/runner.ts — the same gates a
//     hunt passes (territory, rights, identity, freshness, THE ONE producer).

import { createHmac, timingSafeEqual } from "node:crypto"
import { stableContentDigest } from "@/lib/lead-pipeline/raw-record-types"
import { corridorSearches, type PlayMarket } from "@/lib/acquisition-plays/moving-corridor"
import { publicRequestSearches } from "@/lib/acquisition-plays/public-request"
import { propertyCandidateSearches } from "@/lib/acquisition-plays/property-candidates"
import { runEarlyOpportunityPlays } from "@/lib/acquisition-plays/runner"
import { EXA_HUNTED_PLAYS, PLAY_KEYS, type PlayKey } from "@/lib/acquisition-plays/contract"
import { normalizeExaHuntRow, type ExaHuntSearch } from "./hunting"

type Svc = { from: (t: string) => any }

/** One vocabulary — provider_monitors.provider CHECK (m969); Exa is the only monitored provider today. */
export const EXA_MONITOR_PROVIDERS = ["exa"] as const
export const EXA_MONITOR_PROVIDER: (typeof EXA_MONITOR_PROVIDERS)[number] = "exa"
/** One vocabulary — provider_monitors.status CHECK (m969). */
export const PROVIDER_MONITOR_STATUSES = ["active", "paused", "disabled"] as const
export type ProviderMonitorStatus = (typeof PROVIDER_MONITOR_STATUSES)[number]
export const EXA_WEBHOOK_PATH = "/api/webhooks/exa"
/** Exa's documented replay window. */
export const EXA_SIGNATURE_TOLERANCE_SEC = 300
const REPLAY_WINDOW_SEC = 7 * 86_400

export interface ProviderMonitorRow {
  id: string
  brokerage_id: string
  market_id: string | null
  provider: string
  provider_monitor_id: string
  play_key: PlayKey
  status: ProviderMonitorStatus
  cadence: string | null
  webhook_secret_ciphertext: string | null
  deliveries: number | null
}

/** PURE — the search a monitor runs for a play (the play's FIRST search; a monitor is one query). Non-Exa plays have none. */
function monitorSearchFor(play: PlayKey, market: PlayMarket): ExaHuntSearch | null {
  if (!EXA_HUNTED_PLAYS.includes(play)) return null
  const searches = play === "moving_corridor_radar" ? corridorSearches(market) : play === "public_request_assist" ? publicRequestSearches(market) : propertyCandidateSearches(market)
  return searches[0] ?? null
}

// ── SIGNATURE ────────────────────────────────────────────────────────────────

/** PURE — verify an Exa-Signature header over the raw body. Length-guarded timing-safe compare; every refusal names its reason.
 *  Module-private: the ONE caller is handleExaWebhookDelivery (the proof exercises every refusal through it). */
function verifyExaWebhookSignature(a: { rawBody: string; header: string | null | undefined; secret: string | null | undefined; nowSec?: number; toleranceSec?: number }): { ok: boolean; reason: string } {
  if (!a.secret) return { ok: false, reason: "no webhook secret configured for this monitor" }
  if (!a.header || !a.header.trim()) return { ok: false, reason: "missing Exa-Signature header" }
  const parts = a.header.split(",").map((p) => p.trim())
  const t = parts.find((p) => p.startsWith("t="))?.slice(2) ?? null
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3).toLowerCase())
  if (!t || sigs.length === 0) return { ok: false, reason: "malformed Exa-Signature (expected t=<seconds>,v1=<hex>)" }
  const ts = Number(t)
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed Exa-Signature timestamp" }
  const nowSec = a.nowSec ?? Math.floor(Date.now() / 1000)
  const tolerance = a.toleranceSec ?? EXA_SIGNATURE_TOLERANCE_SEC
  if (Math.abs(nowSec - ts) > tolerance) return { ok: false, reason: `timestamp outside the ${tolerance}s replay window` }
  const expected = Buffer.from(createHmac("sha256", a.secret).update(`${t}.${a.rawBody}`, "utf8").digest("hex"), "utf8")
  for (const s of sigs) {
    const given = Buffer.from(s, "utf8")
    if (given.length !== expected.length) continue
    try { if (timingSafeEqual(expected, given)) return { ok: true, reason: "signature verified" } } catch { /* unequal buffers never reach here (length-guarded) */ }
  }
  return { ok: false, reason: "signature mismatch" }
}

// ── PAYLOAD ──────────────────────────────────────────────────────────────────

interface ExaWebhookDelivery {
  eventType: string
  eventId: string
  monitorId: string | null
  runId: string | null
  results: Array<Record<string, unknown>> | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/** PURE — shape a delivery; read defensively (the documented event names; the data envelope or top-level ids). Nothing here is trusted yet. */
function parseExaWebhookPayload(body: unknown): ExaWebhookDelivery | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const data = (b.data && typeof b.data === "object" ? b.data : b) as Record<string, unknown>
  const eventType = str(b.type) ?? str(b.eventType) ?? str(b.event) ?? null
  if (!eventType) return null
  const monitorId = str(data.monitorId) ?? str(data.monitor_id) ?? str(b.monitorId) ?? (eventType.startsWith("monitor.") && !eventType.startsWith("monitor.run") ? str(data.id) : null)
  const runId = eventType.startsWith("monitor.run") ? str(data.id) ?? str(data.runId) ?? str(b.runId) : str(data.runId) ?? null
  const output = data.output && typeof data.output === "object" ? (data.output as Record<string, unknown>) : null
  const results = Array.isArray(output?.results) ? (output!.results as Array<Record<string, unknown>>) : Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : null
  const eventId = str(b.id) ?? str(b.eventId) ?? (monitorId && runId ? `${monitorId}:${runId}` : `digest:${stableContentDigest(b)}`)
  return { eventType, eventId, monitorId, runId, results }
}

// ── THE DELIVERY HANDLER ─────────────────────────────────────────────────────

export interface ExaDeliveryDeps {
  /** Read the run back from Exa (default lib/providers/exa/client.ts getSearchMonitorRun with EXA_API_KEY by name). */
  fetchRun?: (monitorId: string, runId: string) => Promise<{ ok: boolean; results: Array<Record<string, unknown>>; error: string | null }>
  runPlays?: typeof runEarlyOpportunityPlays
  emit?: typeof import("@/lib/kernel/emit").emitKernelEvent
  /** Open a sealed per-monitor secret (default lib/security/secret-crypto.ts decryptSecret). */
  unseal?: (ciphertext: string) => string | null
  nowSec?: number
  now?: Date
}

const defaultFetchRun: NonNullable<ExaDeliveryDeps["fetchRun"]> = async (monitorId, runId) => {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return { ok: false, results: [], error: "EXA_API_KEY is not configured — the run cannot be read back (WAITING_EXTERNAL by name)" }
  const { getSearchMonitorRun } = await import("./client")
  const r = await getSearchMonitorRun(apiKey, monitorId, runId)
  return r.ok && r.data ? { ok: true, results: r.data.results, error: null } : { ok: false, results: [], error: r.error ?? "run read failed" }
}
const defaultEmit: NonNullable<ExaDeliveryDeps["emit"]> = async (input) => (await import("@/lib/kernel/emit")).emitKernelEvent(input)
const defaultUnseal: NonNullable<ExaDeliveryDeps["unseal"]> = (ciphertext) => {
  // Synchronous by contract (the crypto module is pure); required lazily so a proof without the key never loads it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@/lib/security/secret-crypto") as typeof import("@/lib/security/secret-crypto")
  return mod.decryptSecret(ciphertext)
}

export interface ExaDeliveryResponse { status: 200 | 202 | 400 | 401 | 503; body: Record<string, unknown> }

/** One delivery, start to finish. Never throws; every refusal is a status and a reason. */
export async function handleExaWebhookDelivery(
  svc: Svc,
  a: { rawBody: string; signatureHeader: string | null; envSecret: string | null },
  deps: ExaDeliveryDeps = {},
): Promise<ExaDeliveryResponse> {
  const now = deps.now ?? new Date()
  let body: unknown
  try { body = JSON.parse(a.rawBody) } catch { return { status: 400, body: { error: "invalid JSON body" } } }
  const delivery = parseExaWebhookPayload(body)
  if (!delivery) return { status: 400, body: { error: "unrecognized payload shape (no event type)" } }

  // 1 · WHICH SECRET — the payload's monitor id selects a sealed secret; it decides nothing else.
  let row: ProviderMonitorRow | null = null
  if (delivery.monitorId) {
    const { data, error } = await svc.from("provider_monitors").select("id, brokerage_id, market_id, provider, provider_monitor_id, play_key, status, cadence, webhook_secret_ciphertext, deliveries")
      .eq("provider", EXA_MONITOR_PROVIDER).eq("provider_monitor_id", delivery.monitorId).limit(1)
    if (error) return { status: 503, body: { error: `monitor registry read refused: ${error.message}` } }
    row = ((data ?? []) as ProviderMonitorRow[])[0] ?? null
  }
  let secret: string | null = null
  let secretSource: "sealed" | "env" | "none" = "none"
  if (row?.webhook_secret_ciphertext) {
    try { secret = (deps.unseal ?? defaultUnseal)(row.webhook_secret_ciphertext); secretSource = secret ? "sealed" : "none" }
    catch { secret = null }
  }
  if (!secret && a.envSecret) { secret = a.envSecret; secretSource = "env" }
  if (!secret) return { status: 503, body: { error: "no webhook secret — EXA_WEBHOOK_SECRET is unset and this monitor holds no sealed secret; refusing to accept an unverifiable delivery" } }

  // 2 · THE SIGNATURE — before anything else is believed.
  const v = verifyExaWebhookSignature({ rawBody: a.rawBody, header: a.signatureHeader, secret, nowSec: deps.nowSec ?? Math.floor(now.getTime() / 1000) })
  if (!v.ok) return { status: 401, body: { error: v.reason, secretSource } }

  // 3 · WHO IT IS FOR — our row, never the payload.
  if (!row) return { status: 202, body: { accepted: false, reason: "unregistered monitor — verified, but no provider_monitors row names a tenant and territory; nothing done", monitorId: delivery.monitorId } }
  if (row.status === "disabled") return { status: 202, body: { accepted: false, reason: "monitor is disabled in the registry", monitorId: row.provider_monitor_id } }
  if (delivery.eventType !== "monitor.run.completed") return { status: 202, body: { accepted: true, action: "acknowledged", eventType: delivery.eventType } }
  if (!(PLAY_KEYS as readonly string[]).includes(row.play_key)) return { status: 202, body: { accepted: false, reason: `unknown play_key on the registry row (${row.play_key})` } }

  // 4 · THE RESULTS — the payload's, else read back from Exa (a failed read is 503 so Exa retries; nothing recorded).
  let rows = delivery.results
  if (!rows) {
    if (!delivery.runId) return { status: 400, body: { error: "a run-completed event with neither results nor a run id" } }
    const r = await (deps.fetchRun ?? defaultFetchRun)(row.provider_monitor_id, delivery.runId)
    if (!r.ok) return { status: 503, body: { error: `run could not be read back: ${r.error ?? "unknown"}` } }
    rows = r.results
  }

  const { data: m, error: mErr } = await svc.from("lead_scraping_markets").select("id, brokerage_id, name, city, state, zip_codes, counties, agent_id").eq("id", row.market_id).eq("brokerage_id", row.brokerage_id).maybeSingle()
  if (mErr) return { status: 503, body: { error: `territory read refused: ${mErr.message}` } }
  if (!m) return { status: 202, body: { accepted: false, reason: "the monitor's territory no longer exists for its tenant; nothing done" } }
  const market = m as PlayMarket

  // 5 · REPLAY — one audit row per event id (7 days); the C35 key on each raw row guards beyond that.
  const audit = await (deps.emit ?? defaultEmit)({
    event: "exa_monitor_delivery", brokerageId: row.brokerage_id, entityType: "provider_monitor", entityId: row.id, source: "webhook", auditOnly: true,
    dedupeKey: `exa_webhook:${delivery.eventId}`, dedupeWindowSec: REPLAY_WINDOW_SEC,
    metadata: { event_type: delivery.eventType, monitor_id: row.provider_monitor_id, run_id: delivery.runId, play: row.play_key, results: rows.length, secret_source: secretSource },
    client: svc,
  })
  if (!audit.inserted && audit.lifecycleEventId) return { status: 200, body: { accepted: true, replayed: true, eventId: delivery.eventId } }
  if (!audit.inserted) return { status: 503, body: { error: `delivery audit row refused: ${audit.error ?? "unknown"} — refusing to act unrecorded` } }

  // 6 · THE PLAY — the same gates a hunt passes; no provider call (hunt: null; results are the delta).
  const run = await (deps.runPlays ?? runEarlyOpportunityPlays)(svc, { market, hunt: null, results: rows.map(normalizeExaHuntRow), plays: [row.play_key], now })

  const { data: upd, error: uErr } = await svc.from("provider_monitors").update({ last_delivery_at: now.toISOString(), last_delivery_event_id: delivery.eventId, deliveries: (row.deliveries ?? 0) + 1, updated_at: now.toISOString() }).eq("id", row.id).select("id")
  const stamped = uErr ? 0 : (upd ?? []).length
  return {
    status: 200,
    body: {
      accepted: true, replayed: false, eventId: delivery.eventId, monitorId: row.provider_monitor_id, play: row.play_key, results: rows.length,
      plays: run.results.map((r) => ({ play: r.play, status: r.status, actions: r.actions.length, refused: r.refused.length })),
      registryStamped: stamped === 1, ...(uErr ? { registryError: uErr.message } : {}),
    },
  }
}

// ── REGISTRATION ─────────────────────────────────────────────────────────────

export interface MonitorRegistration { play: PlayKey; status: "created" | "existing" | "refused"; monitorId: string | null; rowId: string | null; reason: string | null }

export interface RegisterMonitorDeps {
  create?: typeof import("./client").createSearchMonitor
  /** undefined = EXA_API_KEY by name; null = none. */
  apiKey?: string | null
  /** Seal the returned secret (default lib/security/secret-crypto.ts encryptSecret — THROWS without SECRETS_ENCRYPTION_KEY). */
  seal?: (plaintext: string) => string
  now?: Date
}

const defaultCreate: NonNullable<RegisterMonitorDeps["create"]> = async (apiKey, input) => (await import("./client")).createSearchMonitor(apiKey, input)
const defaultSeal: NonNullable<RegisterMonitorDeps["seal"]> = (plaintext) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("@/lib/security/secret-crypto") as typeof import("@/lib/security/secret-crypto")
  return mod.encryptSecret(plaintext)
}

/**
 * Register ONE monitor for a play on a territory (idempotent per tenant × territory × play). Refuses without the provider key
 * (by name), without a sealing key (nothing is created that could not be verified), or when the registry refuses the row.
 * Module-private: ensureExaMonitors (the runner's door) is the one caller.
 */
async function registerExaMonitor(
  svc: Svc,
  a: { brokerageId: string; market: PlayMarket; play: PlayKey; webhookUrl: string; period?: string; createdByUserId?: string | null },
  deps: RegisterMonitorDeps = {},
): Promise<MonitorRegistration> {
  const refuse = (reason: string): MonitorRegistration => ({ play: a.play, status: "refused", monitorId: null, rowId: null, reason })
  const apiKey = deps.apiKey === undefined ? (process.env.EXA_API_KEY ?? null) : deps.apiKey
  if (!apiKey) return refuse("EXA_API_KEY is not configured — no monitor created (WAITING_EXTERNAL by name)")
  const search = monitorSearchFor(a.play, a.market)
  if (!search) return refuse(`${a.play} is not an Exa-hunted play or the territory has no city/state`)
  const seal = deps.seal ?? defaultSeal
  try { seal("seal-capability-probe") } catch (e) { return refuse(`the webhook secret could not be sealed (${e instanceof Error ? e.message : String(e)}) — nothing created on Exa`) }

  const { data: existing, error: exErr } = await svc.from("provider_monitors").select("id, provider_monitor_id, status")
    .eq("brokerage_id", a.brokerageId).eq("market_id", a.market.id).eq("provider", EXA_MONITOR_PROVIDER).eq("play_key", a.play).in("status", ["active", "paused"]).limit(1)
  if (exErr) return refuse(`monitor registry read refused: ${exErr.message}`)
  const ex = ((existing ?? []) as Array<{ id: string; provider_monitor_id: string }>)[0]
  if (ex) return { play: a.play, status: "existing", monitorId: ex.provider_monitor_id, rowId: ex.id, reason: "already registered for this tenant, territory and play" }

  const period = a.period ?? "1d"
  const created = await (deps.create ?? defaultCreate)(apiKey, {
    name: `${a.play} · ${a.market.name}`.slice(0, 120), query: search.query, numResults: search.numResults ?? 10,
    includeDomains: search.includeDomains, excludeDomains: search.excludeDomains, period, outputSchema: search.schema ?? null,
    metadata: { play: a.play, market_id: a.market.id }, webhookUrl: a.webhookUrl,
  })
  if (!created.ok || !created.data) return refuse(`Exa refused the monitor: ${created.error ?? "unknown"}`)
  const now = deps.now ?? new Date()
  const { data: ins, error: insErr } = await svc.from("provider_monitors").insert({
    brokerage_id: a.brokerageId, market_id: a.market.id, provider: EXA_MONITOR_PROVIDER, provider_monitor_id: created.data.monitorId, play_key: a.play,
    status: "active", cadence: period, search: { key: search.key, query: search.query, includeDomains: search.includeDomains ?? null, excludeDomains: search.excludeDomains ?? null, category: search.category ?? null },
    webhook_path: EXA_WEBHOOK_PATH, webhook_secret_ciphertext: seal(created.data.webhookSecret), secret_env: "EXA_WEBHOOK_SECRET",
    created_by_user_id: a.createdByUserId ?? null, created_at: now.toISOString(), updated_at: now.toISOString(),
  }).select("id").single()
  if (insErr || !ins) return refuse(`created on Exa as ${created.data.monitorId} but the registry row was refused (${insErr?.message ?? "no row"}) — deliveries will be acknowledged as unregistered until a row exists`)
  return { play: a.play, status: "created", monitorId: created.data.monitorId, rowId: (ins as { id: string }).id, reason: null }
}

/** One monitor per Exa play per territory (idempotent). */
export async function ensureExaMonitors(
  svc: Svc,
  a: { brokerageId: string; market: PlayMarket; plays: readonly PlayKey[]; webhookUrl: string; period?: string },
  deps: RegisterMonitorDeps = {},
): Promise<MonitorRegistration[]> {
  const out: MonitorRegistration[] = []
  for (const play of a.plays.filter((p) => EXA_HUNTED_PLAYS.includes(p))) out.push(await registerExaMonitor(svc, { ...a, play }, deps))
  return out
}
