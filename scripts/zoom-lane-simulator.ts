#!/usr/bin/env tsx
/**
 * scripts/zoom-lane-simulator.ts
 *   run: npx tsx --conditions=react-server scripts/zoom-lane-simulator.ts
 *   suggested npm script (NOT added here — package.json is owned elsewhere):
 *     "test:zoom-lane": "tsx --conditions=react-server scripts/zoom-lane-simulator.ts"
 *
 * ROUND 39 PROOF — "if an appointment is to be by zoom, add that connection in
 * settings, embed the zoom window in the OS, and attach zoom transcripts to
 * the contact (tenant for platform use) to enrich with insights" — as ONE
 * scope-aware lane on the round-36 connection idiom:
 *
 *  Layer 1 (pure): the per-level offering matrix (platform/brokerage/team/
 *    agent connectable via the ONE OAuth route; vendor an honest not-offered
 *    verdict), provider gating statements, owner resolution (no fallback).
 *  Layer 2 (isolation): distinct 'platform_zoom' storage key; exact-owner
 *    filters unique per scope; the tenant host cascade can NEVER reach the
 *    platform's account; vendor/contact actors get no host at all.
 *  Layer 3 (behavioral, stubbed I/O — zero network): meeting-creation honesty
 *    — provider unconfigured ⇒ refusal BEFORE any credential read; not
 *    connected ⇒ refusal with the settings hint, credential reads in exact
 *    cascade order, no meeting egress; webhook recording events without a
 *    transcript file / matching calendar event stop BEFORE any download.
 *  Layer 4 (pure): Zoom webhook signature + url_validation crypto; VTT
 *    transcript parsing; attach-target resolution (contact vs TENANT by host
 *    scope).
 *  Layer 5 (source locks): insight extractor REUSE (the zoom lane contains no
 *    generateObject fork — it imports THE call-analysis extractor and writes
 *    provenance 'zoom_transcript'); webhook route verifies + gates on the
 *    secret; OAuth route registers real Zoom endpoints + basic-auth token
 *    exchange + the platform_zoom key; the ONE card mounts on all four
 *    surfaces with provider gating; the scheduling actions carry the additive
 *    zoom branch with honest outcomes; the registry knows meetings→zoom.
 */

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { createHmac } from "crypto"
// Some transitive imports pull `server-only` — neutralize it in the require
// cache BEFORE importing anything app-side (the accounting sim's idiom).
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }

import {
  ZOOM_SCOPES,
  ZOOM_OFFERINGS,
  ZOOM_OAUTH_START,
  PLATFORM_ZOOM_OWNER_ID,
  PLATFORM_ZOOM_STORAGE_KEY,
  ZOOM_SETTINGS_HINT,
  zoomStorageKey,
  isZoomOffered,
  zoomProviderGap,
  resolveZoomOwner,
  zoomOwnerFilter,
  zoomHostCascade,
  zoomWebhookSignature,
  verifyZoomWebhook,
  zoomUrlValidationResponse,
  parseZoomVtt,
  resolveZoomAttachTarget,
  ensureZoomMeetingForAppointment,
  type ZoomScope,
} from "../lib/connections/zoom"
import { pickTranscriptFile, processZoomRecordingEvent } from "../lib/connections/zoom-transcripts"
import { aliasesFor } from "../lib/integrations/connection-manager"
import { isConnectSupported, connectionScopeForUserType, DOMAIN_AUTH, oauthStartPath } from "../lib/connections/field-spec"
import { CONNECTOR_PROVIDERS, isConnectionAllowed } from "../lib/connections/scope"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function section(title: string) { console.log(`\n■ ${title}`) }

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1 — offering matrix (platform + all tiers, honest verdicts)")

check("five zoom scopes in the matrix", ZOOM_SCOPES.length === 5)
for (const scope of ["platform", "brokerage", "team", "agent"] as ZoomScope[]) {
  check(`${scope}: Zoom is CONNECTABLE via the one real OAuth route`,
    ZOOM_OFFERINGS[scope].status === "connectable" && ZOOM_OFFERINGS[scope].connectPath === ZOOM_OAUTH_START)
}
check("vendor: NOT-OFFERED with a documented no-meeting-consumer verdict (not a dead button)",
  ZOOM_OFFERINGS.vendor.status === "not-offered"
  && ZOOM_OFFERINGS.vendor.connectPath === null
  && /vendor-booking rail/i.test(ZOOM_OFFERINGS.vendor.verdict))
check("isZoomOffered mirrors the matrix",
  isZoomOffered("agent") === true && isZoomOffered("vendor") === false)
check("every non-connectable offering carries a non-empty verdict",
  ZOOM_SCOPES.every((s) => ZOOM_OFFERINGS[s].status === "connectable" || ZOOM_OFFERINGS[s].verdict.trim().length > 20))

// Provider gating (pure): the gap statement names exactly what is missing.
check("provider gap: both creds missing → names BOTH env vars",
  /ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET/.test(zoomProviderGap({ clientId: null, clientSecret: null }) ?? ""))
check("provider gap: secret missing → names only the secret",
  /ZOOM_CLIENT_SECRET/.test(zoomProviderGap({ clientId: "id", clientSecret: null }) ?? "")
  && !/ZOOM_CLIENT_ID and/.test(zoomProviderGap({ clientId: "id", clientSecret: null }) ?? ""))
check("provider gap: fully configured → null (button is live)",
  zoomProviderGap({ clientId: "id", clientSecret: "sec" }) === null)

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 1b — owner resolution (each scope resolves its OWN entity, no fallback)")

const ids = { brokerageId: "b-1", teamId: "t-1", agentUserId: "u-1" }
check("platform → sentinel 'platform' owner", resolveZoomOwner("platform", {})?.ownerId === PLATFORM_ZOOM_OWNER_ID)
check("brokerage → brokerage id", resolveZoomOwner("brokerage", ids)?.ownerId === "b-1")
check("team → team id", resolveZoomOwner("team", ids)?.ownerId === "t-1")
check("agent → auth USER id (what the OAuth callback writes)", resolveZoomOwner("agent", ids)?.ownerId === "u-1")
check("vendor → honest null (not offered — no owner minted)", resolveZoomOwner("vendor", ids) === null)
check("team WITHOUT a team anchor → honest null (never falls back to the brokerage)",
  resolveZoomOwner("team", { brokerageId: "b-1" }) === null)

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 2 — no cross-scope token leakage (the accounting-scopes idiom)")

check("platform Zoom uses the DISTINCT storage key (m273 idiom)",
  zoomStorageKey("platform") === PLATFORM_ZOOM_STORAGE_KEY && String(PLATFORM_ZOOM_STORAGE_KEY) !== "zoom")
check("tenant scopes share the 'zoom' key (rows differ by owner)",
  (["brokerage", "team", "agent"] as const).every((s) => zoomStorageKey(s) === "zoom"))
check("the tenant alias set can NEVER resolve the company's Zoom",
  !aliasesFor("zoom").includes(PLATFORM_ZOOM_STORAGE_KEY))

const filters = (["platform", "brokerage", "team", "agent"] as ZoomScope[]).map((s) => zoomOwnerFilter(s, "same-id"))
const uniq = new Set(filters.map((f) => `${f.owner_type}|${f.owner_id}|${f.platform}`))
check("exact-owner filters are unique per scope (same id, four distinct filters)", uniq.size === 4)

// Host cascade isolation: tenant actors can never reach the platform account.
const agentCascade = zoomHostCascade({ scope: "agent", agentUserId: "u-1", teamId: "t-1", brokerageId: "b-1" })
check("agent host cascade is agent → team → brokerage (most specific first)",
  agentCascade.length === 3
  && agentCascade[0].ownerType === "agent" && agentCascade[1].ownerType === "team" && agentCascade[2].ownerType === "brokerage")
check("tenant cascade NEVER contains the platform owner",
  !agentCascade.some((c) => c.ownerType === "platform"))
check("platform actor hosts ONLY on the platform's own account",
  JSON.stringify(zoomHostCascade({ scope: "platform", brokerageId: "b-1" }))
  === JSON.stringify([{ ownerType: "platform", ownerId: "platform" }]))
check("vendor + contact actors get NO host (they join, never host)",
  zoomHostCascade({ scope: "vendor", brokerageId: "b-1" }).length === 0
  && zoomHostCascade({ scope: "contact", brokerageId: "b-1" }).length === 0)
check("solo agent (no team) cascade skips the team without inventing an owner",
  zoomHostCascade({ scope: "agent", agentUserId: "u-1", brokerageId: "b-1" }).map((c) => c.ownerType).join(",") === "agent,brokerage")

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 3 — meeting-creation honesty (stubbed I/O, zero network)")

type StubResult = { data: unknown; error: { message: string } | null }
function stubSvc(tables: Record<string, StubResult | StubResult[]>, log: Array<{ table: string; filters: Record<string, unknown> }>) {
  const consume = (table: string): StubResult => {
    const r = tables[table]
    if (Array.isArray(r)) return r.shift() ?? { data: null, error: null }
    return r ?? { data: null, error: null }
  }
  const builder = (table: string) => {
    const filters: Record<string, unknown> = {}
    const b: any = {
      select: () => b,
      update: () => b,
      insert: () => b,
      eq: (k: string, v: unknown) => { filters[k] = v; return b },
      in: (k: string, v: unknown) => { filters[k] = v; return b },
      not: () => b,
      order: () => b,
      limit: () => b,
      single: async () => { log.push({ table, filters }); return consume(table) },
      maybeSingle: async () => { log.push({ table, filters }); return consume(table) },
      then: (res: any, rej: any) => { log.push({ table, filters }); return Promise.resolve(consume(table)).then(res, rej) },
    }
    return b
  }
  return { from: (table: string) => builder(table) } as any
}

const HOST = { scope: "agent" as const, agentUserId: "u-1", teamId: "t-1", brokerageId: "b-1" }
const MEETING_ARGS = { topic: "ISA Appointment", startAt: new Date("2026-07-21T15:00:00Z"), endAt: new Date("2026-07-21T15:30:00Z"), timezoneName: "America/New_York" }

{
  // Provider unconfigured → refusal BEFORE any credential read.
  delete process.env.ZOOM_CLIENT_ID
  delete process.env.ZOOM_CLIENT_SECRET
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({}, log)
  const out = await ensureZoomMeetingForAppointment(svc, { host: HOST, ...MEETING_ARGS })
  check("no ZOOM client credentials → honest 'provider_unconfigured' refusal (never a fake meeting)",
    out.created === false && out.reason === "provider_unconfigured" && /ZOOM_CLIENT_ID/.test(out.detail))
  check("…and the credential store was never touched", log.length === 0)
}
{
  // Configured but nobody in the cascade connected → refusal with the settings hint.
  process.env.ZOOM_CLIENT_ID = "sim-client"
  process.env.ZOOM_CLIENT_SECRET = "sim-secret"
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({ platform_credentials: [{ data: null, error: null }, { data: null, error: null }, { data: null, error: null }] }, log)
  const out = await ensureZoomMeetingForAppointment(svc, { host: HOST, ...MEETING_ARGS })
  check("not connected anywhere in the cascade → { created:false, reason:'not_connected' } + the settings hint",
    out.created === false && out.reason === "not_connected" && out.detail === ZOOM_SETTINGS_HINT)
  const reads = log.filter((l) => l.table === "platform_credentials")
  check("…credential reads walked the EXACT cascade (agent, then team, then brokerage — all platform='zoom')",
    reads.length === 3
    && reads[0].filters.owner_type === "agent" && reads[0].filters.owner_id === "u-1"
    && reads[1].filters.owner_type === "team" && reads[1].filters.owner_id === "t-1"
    && reads[2].filters.owner_type === "brokerage" && reads[2].filters.owner_id === "b-1"
    && reads.every((r) => r.filters.platform === "zoom"))
  check("…and never touched the platform's distinct key",
    !reads.some((r) => r.filters.platform === PLATFORM_ZOOM_STORAGE_KEY))
  delete process.env.ZOOM_CLIENT_ID
  delete process.env.ZOOM_CLIENT_SECRET
}
{
  // Webhook processing stops BEFORE any download when the payload has no
  // transcript file, and before egress when no calendar event matches.
  const log: Array<{ table: string; filters: Record<string, unknown> }> = []
  const svc = stubSvc({ calendar_events: { data: null, error: null } }, log)
  const noFile = await processZoomRecordingEvent(svc, {
    event: "recording.completed",
    payload: { object: { id: 123, uuid: "uu-1", recording_files: [{ file_type: "MP4", download_url: "https://zoom.us/rec/x" }] } },
  })
  check("recording payload without a TRANSCRIPT file → handled:false, nothing invented",
    noFile.handled === false && /TRANSCRIPT/i.test(noFile.reason ?? "") && log.length === 0)
  const noEvent = await processZoomRecordingEvent(svc, {
    event: "recording.transcript_completed",
    download_token: "dl-token",
    payload: { object: { id: 123, uuid: "uu-1", recording_files: [{ file_type: "TRANSCRIPT", download_url: "https://zoom.us/rec/t" }] } },
  })
  check("transcript event with NO matching calendar event → handled:false before any attach",
    noEvent.handled === false && /calendar event/i.test(noEvent.reason ?? ""))
  const evRead = log.find((l) => l.table === "calendar_events")
  check("…the event lookup keys on the stamped zoom meeting_id",
    !!evRead && evRead.filters["metadata->zoom->>meeting_id"] === "123")
}
check("pickTranscriptFile finds the VTT transcript among recording files",
  pickTranscriptFile({ recording_files: [{ file_type: "MP4", download_url: "a" }, { file_type: "TRANSCRIPT", download_url: "b" }] })?.download_url === "b"
  && pickTranscriptFile({ recording_files: [{ file_type: "MP4", download_url: "a" }] }) === null)

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 4 — webhook validation + VTT parsing + attach targets (pure)")

{
  const secret = "whsec-sim"
  const body = JSON.stringify({ event: "recording.completed", payload: { object: { id: 1 } } })
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = zoomWebhookSignature(body, ts, secret)
  check("signature matches Zoom's documented scheme (v0=HMAC(`v0:{ts}:{body}`))",
    sig === `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`)
  check("valid signature verifies", verifyZoomWebhook({ rawBody: body, timestamp: ts, signatureHeader: sig, secretToken: secret }))
  check("tampered body is rejected",
    !verifyZoomWebhook({ rawBody: body + "x", timestamp: ts, signatureHeader: sig, secretToken: secret }))
  check("missing secret is rejected (no secret, no processing — the Vapi gate idiom)",
    !verifyZoomWebhook({ rawBody: body, timestamp: ts, signatureHeader: sig, secretToken: null }))
  check("stale timestamp (>5 min) is rejected (replay guard)",
    !verifyZoomWebhook({ rawBody: body, timestamp: ts, signatureHeader: sig, secretToken: secret, nowMs: Date.now() + 6 * 60_000 }))
  const val = zoomUrlValidationResponse("plain-1", secret)
  check("endpoint.url_validation response echoes plainToken + HMAC encryptedToken",
    val.plainToken === "plain-1" && val.encryptedToken === createHmac("sha256", secret).update("plain-1").digest("hex"))
}
{
  const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Dana Kling: We'd want to list in September.

2
00:00:04.500 --> 00:00:06.000
Dana Kling: Maybe early October.

3
00:00:06.500 --> 00:00:09.000
Agent Smith: That timing works — let's price it this week.`
  const parsed = parseZoomVtt(vtt)
  check("VTT parses to speaker-attributed plain text (header/ids/timestamps dropped)",
    parsed.includes("Dana Kling: We'd want to list in September.") && parsed.includes("Agent Smith: That timing works")
    && !parsed.includes("WEBVTT") && !parsed.includes("-->"))
  check("consecutive cues from one speaker merge into a single line",
    parsed.split("\n").length === 2 && /September\. Maybe early October\./.test(parsed))
  check("empty/garbage input parses to empty (never a fabricated transcript)", parseZoomVtt("") === "")
}
{
  check("platform-hosted meeting attaches to the TENANT (never a tenant contact)",
    JSON.stringify(resolveZoomAttachTarget({ hostOwnerType: "platform", brokerageId: "b-9", entityType: "contact", entityId: "c-1" }))
    === JSON.stringify({ kind: "tenant", brokerageId: "b-9" }))
  check("tenant-hosted, contact entity → the contact",
    JSON.stringify(resolveZoomAttachTarget({ hostOwnerType: "agent", brokerageId: "b-1", entityType: "contact", entityId: "c-1" }))
    === JSON.stringify({ kind: "contact", contactId: "c-1" }))
  check("tenant-hosted, lead entity → the lead's LINKED contact",
    JSON.stringify(resolveZoomAttachTarget({ hostOwnerType: "team", brokerageId: "b-1", entityType: "lead", entityId: "l-1", leadContactId: "c-7" }))
    === JSON.stringify({ kind: "contact", contactId: "c-7" }))
  check("listing appointment → the metadata contact",
    JSON.stringify(resolveZoomAttachTarget({ hostOwnerType: "brokerage", brokerageId: "b-1", entityType: "listing", entityId: "L-1", metadataContactId: "c-3" }))
    === JSON.stringify({ kind: "contact", contactId: "c-3" }))
  const none = resolveZoomAttachTarget({ hostOwnerType: "agent", brokerageId: "b-1", entityType: "lead", entityId: "l-2", leadContactId: null })
  check("lead with no linked contact → honest 'none' with a stated reason",
    none.kind === "none" && (none as any).reason.length > 10)
}

// ─────────────────────────────────────────────────────────────────────────────
section("Layer 5 — source locks (extractor reuse, real routes, gating, keep-one card)")

const zoomLibSrc = src("lib/connections/zoom.ts")
const transcriptsSrc = src("lib/connections/zoom-transcripts.ts")
const callAnalysisSrc = src("lib/voice/call-analysis.ts")
const webhookSrc = src("app/api/webhooks/zoom/route.ts")
const oauthSrc = src("app/api/integrations/oauth/[provider]/route.ts")
const cardSrc = src("app/settings/accounting/provider-connection-card.tsx")
const isaSchedulerSrc = src("lib/ai-isa/appointment-scheduler.ts")
const isaActionSrc = src("app/actions/ai-isa/schedule-appointment.ts")
const listingSvcSrc = src("lib/application/listing-lifecycle.ts")
const meetingPageSrc = src("app/dashboard/meetings/[eventId]/page.tsx")

check("insight extractor REUSE: the zoom transcript lane imports THE call-analysis extractor (no fork)",
  transcriptsSrc.includes('from "@/lib/voice/call-analysis"')
  && transcriptsSrc.includes("analyzeVoiceCallRow") && transcriptsSrc.includes("extractVoiceIntel")
  && !transcriptsSrc.includes("generateObject") && !zoomLibSrc.includes("generateObject") && !webhookSrc.includes("generateObject"))
check("…provenance 'zoom_transcript' is stamped on the insight rows",
  transcriptsSrc.includes('"zoom_transcript"') && callAnalysisSrc.includes("analyzed_by: provenance"))
check("call-analysis exposes the ONE shared extractor core (sweep + zoom both ride it)",
  callAnalysisSrc.includes("export async function extractVoiceIntel") && callAnalysisSrc.includes("await extractVoiceIntel(call.transcription"))
check("contact attach rides the ONE voice-transcript ledger (voice_calls + call ledger vendor id 'zoom:<uuid>')",
  transcriptsSrc.includes('from("voice_calls")') && transcriptsSrc.includes("`zoom:${meetingUuid}`"))
check("tenant attach rides communications (channel 'zoom_transcript', contact_id null)",
  transcriptsSrc.includes('from("communications")') && transcriptsSrc.includes('channel: "zoom_transcript"') && transcriptsSrc.includes("contact_id: null"))
check("both attach lanes are idempotent per meeting uuid",
  transcriptsSrc.includes('eq("vapi_call_id", vendorCallId)') && transcriptsSrc.includes('eq("metadata->>zoom_uuid", meetingUuid)'))

check("webhook route verifies Zoom's signature and gates on the secret (no secret → 401)",
  webhookSrc.includes("verifyZoomWebhook") && webhookSrc.includes("ZOOM_WEBHOOK_SECRET_TOKEN") && webhookSrc.includes("endpoint.url_validation"))
check("webhook route handles the transcript events only through the verified path",
  webhookSrc.includes("recording.transcript_completed") && webhookSrc.includes("processZoomRecordingEvent"))

check("OAuth route registers zoom with REAL endpoints (zoom.us authorize + token)",
  oauthSrc.includes("https://zoom.us/oauth/authorize") && oauthSrc.includes("https://zoom.us/oauth/token"))
check("OAuth route: zoom token exchange uses HTTP Basic auth (Zoom's requirement)",
  /usesBasicTokenAuth = oauthProvider === "zoom"/.test(oauthSrc))
check("OAuth route stores the platform's OWN Zoom under the distinct key",
  oauthSrc.includes('oauthProvider === "zoom" && ownerType === "platform" ? "platform_zoom"'))
check("meeting API egress rides the connector gateway against api.zoom.us",
  zoomLibSrc.includes("https://api.zoom.us") && zoomLibSrc.includes("callConnector"))
check("'created' only on real API acceptance (id + join_url checked before created:true)",
  /if \(!res\.ok \|\| !res\.data\?\.id \|\| !res\.data\.join_url\)/.test(zoomLibSrc))

check("the ONE card gained zoom (keep-one — no second card component)",
  cardSrc.includes('"quickbooks" | "xero" | "stripe" | "zoom"') && cardSrc.includes('zoom: { name: "Zoom"'))
const surfaces: Array<[string, string]> = [
  ["platform", "app/dashboard/superadmin/platform/page.tsx"],
  ["brokerage", "app/settings/accounting/page.tsx"],
  ["team", "app/dashboard/financials/team/page.tsx"],
  ["agent", "app/dashboard/financials/agent/page.tsx"],
]
for (const [level, file] of surfaces) {
  const s = src(file)
  check(`${level} surface mounts the zoom card with provider gating (readScopedZoom + providerGap)`,
    s.includes("readScopedZoom") && s.includes('provider="zoom"') && s.includes("providerGap"))
}
check("platform surface uses the distinct platform_zoom key + sentinel owner",
  src("app/dashboard/superadmin/platform/page.tsx").includes("PLATFORM_ZOOM_STORAGE_KEY")
  && src("app/dashboard/superadmin/platform/page.tsx").includes("PLATFORM_ZOOM_OWNER_ID"))

check("ISA scheduler carries the additive zoom branch (real meeting or honest zoom_outcome)",
  isaSchedulerSrc.includes("ensureZoomMeetingForAppointment") && isaSchedulerSrc.includes("zoom_outcome")
  && isaSchedulerSrc.includes("zoomLocation ?? params.location"))
check("ISA action surfaces the honest zoom outcome to the UI",
  isaActionSrc.includes("meetingMode") && isaActionSrc.includes("zoom_outcome"))
check("listing appointment service carries the additive zoom branch",
  listingSvcSrc.includes("meeting_mode") && listingSvcSrc.includes("ensureZoomMeetingForAppointment") && listingSvcSrc.includes("zoom_outcome"))
check("booking dialog offers the zoom mode and relays the honest outcome",
  src("app/dashboard/voice/isa/book-appointment-dialog.tsx").includes('value="zoom"')
  && src("app/dashboard/voice/isa/book-appointment-dialog.tsx").includes("result.zoom"))

check("meeting page embeds the join URL + states the Component-SDK next step honestly",
  meetingPageSrc.includes("iframe") && meetingPageSrc.includes("join_url") && /Component SDK/i.test(meetingPageSrc)
  && meetingPageSrc.includes("Join Zoom meeting"))

check("registry: meetings domain → zoom, owner-scoped OAuth start path",
  JSON.stringify(CONNECTOR_PROVIDERS.meetings) === JSON.stringify(["zoom"])
  && DOMAIN_AUTH.meetings.method === "oauth"
  && oauthStartPath("meetings", "zoom") === "/api/integrations/oauth/zoom")
check("registry: vendor/contact scopes may NOT connect meetings (they join, never host)",
  isConnectionAllowed("vendor", "meetings") === false && isConnectionAllowed("contact", "meetings") === false
  && isConnectionAllowed("agent", "meetings") === true && isConnectionAllowed("platform", "meetings") === true)
check("field-spec: meetings connect is owner-scoped for any owner-capable actor (platform included, no brokerage anchor)",
  isConnectSupported("meetings", "zoom", { canOwn: true, hasAgentId: false, isBrokerageManager: false, hasBrokerage: false }).available === true
  && isConnectSupported("meetings", "zoom", { canOwn: false, hasAgentId: false, isBrokerageManager: false, hasBrokerage: true }).available === false)
check("role → scope mapping still covers the four connectable levels",
  connectionScopeForUserType("superadmin").scope === "platform"
  && connectionScopeForUserType("broker").scope === "brokerage"
  && connectionScopeForUserType("team_lead").scope === "team"
  && connectionScopeForUserType("agent").scope === "agent")
check("provider metadata registers zoom as an OAuth meetings provider",
  src("lib/onboarding/integration-tester.ts").includes('oauthProvider: "zoom"'))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}\n${fail === 0 ? "✅" : "❌"} zoom-lane simulator: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
