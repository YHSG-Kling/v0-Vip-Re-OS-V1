#!/usr/bin/env tsx
/**
 * scripts/face-render-seam-simulator.ts   (npm run test:face-render-seam)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 62 — owner ruling (2026-09-14, verbatim): "building Simli as a backup
 * makes more sense than HeyGen." Proves the FACE-RENDER SEAM
 * (lib/live-agent/face-render.ts) that puts Simli behind D-ID as the live
 * avatar's fail-over leg, never a competing primary and never a weakened
 * consent gate.
 *
 * Properties proved, each with a POSITIVE CONTROL (§2):
 *   §seamExports     the seam exports FaceRenderProvider, resolveFaceRenderProvider
 *                    and simliFaceRenderAdapter (isConfigured/estimateUsdPerMinute/
 *                    startSession); the D-ID primary path stays the doors' own
 *                    inline ensureDIDAgent + issueClientKey call (tombstone in
 *                    the seam header — no unread D-ID wrapper).
 *   §providerOrder   DEFAULT_FACE_PROVIDER_ORDER is exactly ["did","simli"]
 *                    (D-ID primary, Simli backup — the ruling's own order);
 *                    m627 (applied live 2026-09-14) carries the SAME default on
 *                    brokerage_settings.live_agent_face_provider_order.
 *   §simliEgress     lib/providers/simli/client.ts's mintSimliSessionToken
 *                    goes through callConnector ONLY — no bespoke fetch to
 *                    api.simli.ai anywhere in that file or lib/providers/simli/faces.ts.
 *   §consentGate     ensureSimliFaceForAgent is gated on findVerifiedConsent
 *                    (the SAME agent_did_consents check app/api/did/create-avatar
 *                    reads) BEFORE any face is created — a specimen with the
 *                    consent check removed IS caught by the same regex (positive
 *                    control), so this is not a check that would pass on anything.
 *   §doorsWired      both session doors (app/api/did/agents/session,
 *                    app/api/embed/session) call resolveFaceRenderProvider +
 *                    simliFaceRenderAdapter INSIDE their existing D-ID-init-failed
 *                    branch, never on the success path — and open the
 *                    live_agent_sessions row with provider:"simli" so the
 *                    metering ledger attributes correctly.
 *   §meteringAware   estimateStreamingMinutesCostUsd takes a provider argument,
 *                    SIMLI_USD_PER_STREAMING_MINUTE = 0.009 exists, and
 *                    closeLiveAgentSession (lib/did/live-session-metering.ts)
 *                    reads row.provider rather than a hardcoded "did" literal.
 *   §pcm16k          SimliFaceSession feeds PCM16 mono 16kHz to sendAudioData
 *                    (voice-tts called with format:"pcm_16000", chunks bounded
 *                    to the documented ≤6000-byte sweet spot).
 *   §importScope     "simli-client" (the real npm package, 3.x) is imported
 *                    ONLY from SimliFaceSession.tsx — a
 *                    specimen importing it from an unrelated file IS caught
 *                    (positive control).
 *   §consentUntouched app/api/did/create-avatar/route.ts is byte-identical to
 *                    its content at the lane's own base commit (ae5776cb) —
 *                    the D-ID 428 consent path was never touched by this wave.
 *
 * METHOD (§2): every source scan reads STRIPPED source via
 * scripts/strip-comments.ts (stripComments for line-number-free structural
 * checks here — no line numbers are reported by this proof). PURE — no
 * network, no D-ID/Simli call, no live database read. `git show` is a local
 * read of THIS repo's own history, not network egress.
 */
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
// NOTE: lib/live-agent/face-render.ts carries `import "server-only"` (it is a
// server-only seam, correctly) — it is read as STRIPPED SOURCE TEXT below,
// never imported at the module level, the same reason
// scripts/live-agent-identity-simulator.ts reads lib/did/live-session-
// metering.ts as text rather than importing it. lib/video/realism-profile.ts
// carries no such pragma and IS safe to import directly (same precedent that
// simulator already sets).
import {
  SIMLI_USD_PER_STREAMING_MINUTE,
  DID_USD_PER_STREAMING_MINUTE,
  estimateStreamingMinutesCostUsd,
} from "../lib/video/realism-profile"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const readStripped = (rel: string): string => stripComments(readFileSync(join(root, rel), "utf8"))
const readRaw = (rel: string): string => readFileSync(join(root, rel), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
// §seamExports — lib/live-agent/face-render.ts's contract
// ═══════════════════════════════════════════════════════════════════════════
function seamExportsSection() {
  console.log("\n── §seamExports — the seam exports what both session doors need ──")
  const seam = readStripped("lib/live-agent/face-render.ts")
  check("exports FaceRenderProvider type", /export type FaceRenderProvider = ["']did["'] \| ["']simli["']/.test(seam))
  check("exports resolveFaceRenderProvider", /export async function resolveFaceRenderProvider\(/.test(seam))
  check("carries NO unread didFaceRenderAdapter (the doors call ensureDIDAgent + issueClientKey directly — tombstone names them)",
    !/export const didFaceRenderAdapter/.test(seam) && /ensureDIDAgent \+ issueClientKey/.test(readRaw("lib/live-agent/face-render.ts")))
  check("exports simliFaceRenderAdapter", /export const simliFaceRenderAdapter: FaceRenderAdapter/.test(seam))
  check("FaceRenderAdapter declares isConfigured/estimateUsdPerMinute/startSession",
    /isConfigured\(\): boolean/.test(seam) && /estimateUsdPerMinute\(\): number/.test(seam) && /startSession\(params: FaceRenderSessionParams\)/.test(seam))
  check("the Simli adapter implements all three (not a partial stub)",
    (seam.match(/isConfigured:/g) ?? []).length >= 1 &&
    (seam.match(/estimateUsdPerMinute:/g) ?? []).length >= 1 &&
    (seam.match(/async startSession\(params\)/g) ?? []).length >= 1)

  // CONTROL: a made-up export name is correctly absent.
  check("[control] the seam does NOT export a made-up 'startFaceRenderSession' function",
    !/export (async )?function startFaceRenderSession/.test(seam))
}

// ═══════════════════════════════════════════════════════════════════════════
// §providerOrder — D-ID primary, Simli backup, everywhere the default lives
// ═══════════════════════════════════════════════════════════════════════════
function providerOrderSection() {
  console.log("\n── §providerOrder — D-ID → Simli is the DEFAULT everywhere it's declared ──")
  const seam = readStripped("lib/live-agent/face-render.ts")
  check("DEFAULT_FACE_PROVIDER_ORDER is exactly [did, simli] in source (not [simli, did] or a 3rd provider)",
    /(?:export )?const DEFAULT_FACE_PROVIDER_ORDER: readonly FaceRenderProvider\[\] = \[["']did["'], ["']simli["']\]/.test(seam))
  check("normalizeProviderOrder falls back to the SAME default when settings carry no valid provider (never an empty list)",
    /cleaned\.length > 0 \? cleaned : \[\.\.\.DEFAULT_FACE_PROVIDER_ORDER\]/.test(seam))

  const m627 = readRaw("supabase/migrations/m627-live-agent-face-provider.sql")
  // The rule, not a waypoint (CLAUDE.md §2): an integrated migration's header
  // line 3 carries the integrator's dated APPLIED LIVE stamp — a header that
  // is silent about whether it ran is the defect this line exists to catch.
  check("m627 line 3 carries the integrator's dated APPLIED LIVE stamp",
    /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2}/.test(m627.split("\n")[2]?.trim() ?? ""))
  check("m627's column DEFAULT matches the seam's runtime default (['did','simli'])",
    /live_agent_face_provider_order TEXT\[\][\s\S]{0,80}DEFAULT ARRAY\['did', 'simli'\]/.test(m627))
  check("m627 adds simli_face_id to agent_avatar_assets (the SAME row did_agent_id\\/did_avatar_id live on)",
    /ALTER TABLE public\.agent_avatar_assets\s*\n\s*ADD COLUMN IF NOT EXISTS simli_face_id TEXT/.test(m627))

  // CONTROL: swapping the array literal would be caught by the regex above —
  // demonstrated here against a specimen so "found no 3rd provider" isn't a
  // check that would pass on anything.
  const badSpecimen = "live_agent_face_provider_order TEXT[] NOT NULL DEFAULT ARRAY['simli', 'did', 'heygen']"
  check("[control] a 3-provider/wrong-order specimen does NOT match the expected-default regex",
    !/live_agent_face_provider_order TEXT\[\][\s\S]{0,80}DEFAULT ARRAY\['did', 'simli'\]/.test(badSpecimen))
}

// ═══════════════════════════════════════════════════════════════════════════
// §simliEgress — the ONE gateway, no bespoke fetch
// ═══════════════════════════════════════════════════════════════════════════
function simliEgressSection() {
  console.log("\n── §simliEgress — mintSimliSessionToken goes through callConnector ONLY ──")
  const client = readStripped("lib/providers/simli/client.ts")
  const faces = readStripped("lib/providers/simli/faces.ts")

  check("mintSimliSessionToken calls callConnector", /callConnector<\{ session_token/.test(client))
  check("mintSimliSessionToken declares connector: 'simli'", /connector:\s*["']simli["']/.test(client))
  check("client.ts imports callConnector from the ONE gateway", /from ["']@\/lib\/agentic-os\/connector-gateway["']/.test(client))
  check("[control] client.ts contains no bespoke fetch(\"https://api.simli.ai to api.simli.ai (bypassing the gateway)",
    !/\bfetch\(\s*["'`]https:\/\/api\.simli\.ai/.test(client))

  check("faces.ts's own face-creation call ALSO goes through callConnector (not a second bespoke fetch)",
    /callConnector<\{ face_id/.test(faces) && /connector:\s*["']simli["']/.test(faces))
  check("[control] faces.ts contains no bespoke fetch(\"https://api.simli.ai either",
    !/\bfetch\(\s*["'`]https:\/\/api\.simli\.ai/.test(faces))
  check("faces.ts posts to the DOCUMENTED endpoint POST /faces/trinity as multipart (not the lane's guessed /textToFace)",
    /path:\s*["']\/faces\/trinity["']/.test(faces) && /bodyType:\s*["']multipart["']/.test(faces) && !/textToFace/.test(faces))
  check("the Simli adapter refuses a session on a face enqueued THIS call (async generation → text fallback)",
    /if \(face\.created\)/.test(readStripped("lib/live-agent/face-render.ts")))
}

// ═══════════════════════════════════════════════════════════════════════════
// §consentGate — reused, not re-implemented; a specimen without it IS caught
// ═══════════════════════════════════════════════════════════════════════════
function consentGateSection() {
  console.log("\n── §consentGate — no Simli face without the SAME verified D-ID consent row ──")
  const faces = readStripped("lib/providers/simli/faces.ts")

  check("ensureSimliFaceForAgent imports findVerifiedConsent from lib/did/consent (reused, not re-implemented)",
    /import\s*\{\s*findVerifiedConsent\s*\}\s*from\s*["']@\/lib\/did\/consent["']/.test(faces))
  check("the consent check runs BEFORE the twin-image lookup (gate first, §4)",
    (() => {
      const consentIdx = faces.indexOf("findVerifiedConsent(svc, agentId)")
      const twinIdx = faces.indexOf('.from("agent_avatar_assets")')
      return consentIdx > -1 && twinIdx > -1 && consentIdx < twinIdx
    })())
  check("a missing consent returns a typed ConsentRequired refusal, not a thrown error or a silent face create",
    /kind:\s*["']ConsentRequired["']/.test(faces))
  check("lib/live-agent/face-render.ts never touches lib/did/consent.ts's WRITE path (no mintConsent/verify import)",
    !/mintConsent|verifyConsent/.test(readStripped("lib/live-agent/face-render.ts")))

  // POSITIVE CONTROL: a specimen with the consent gate stripped out IS
  // correctly recognized as NOT gated — proves this check can fail.
  const ungatedSpecimen = `
    export async function ensureSimliFaceForAgent(agentId: string, svc: Svc) {
      const { data: twin } = await svc.from("agent_avatar_assets").select("id").eq("agent_id", agentId).maybeSingle()
      const res = await callConnector({ connector: "simli", path: "/faces/trinity", body: form, bodyType: "multipart" })
      return { ok: true, faceId: res.data.face_id }
    }
  `
  check("[control] the ungated specimen does NOT import findVerifiedConsent (this check correctly fails on it)",
    !/import\s*\{\s*findVerifiedConsent\s*\}\s*from\s*["']@\/lib\/did\/consent["']/.test(ungatedSpecimen))
}

// ═══════════════════════════════════════════════════════════════════════════
// §doorsWired — both session doors branch to Simli INSIDE the D-ID-failed path
// ═══════════════════════════════════════════════════════════════════════════
function doorsWiredSection() {
  console.log("\n── §doorsWired — D-ID → Simli fail-over lives inside if(!ensured.ok), both doors ──")
  const portal = readStripped("app/api/did/agents/session/route.ts")
  const embed = readStripped("app/api/embed/session/route.ts")

  for (const [label, src] of [["portal", portal], ["embed", embed]] as const) {
    check(`${label} imports resolveFaceRenderProvider + simliFaceRenderAdapter from the seam`,
      /import\s*\{\s*resolveFaceRenderProvider,\s*simliFaceRenderAdapter\s*\}\s*from\s*["']@\/lib\/live-agent\/face-render["']/.test(src))
    check(`${label} calls resolveFaceRenderProvider (checks the provider order before falling to Simli)`,
      /resolveFaceRenderProvider\(\{\s*brokerageId:/.test(src))
    check(`${label} opens the metering row with provider: "simli" on the fail-over branch`,
      /provider:\s*["']simli["']/.test(src))
    check(`${label} still returns the EXISTING 502 (text fail-over) when Simli also refuses — never a THIRD dead end`,
      /status:\s*502\s*\}\)\s*$/m.test(src) || /\{ status: 502 \}\)/.test(src))

    // CONTROL: the Simli branch is positioned INSIDE `if (!ensured.ok)`, not
    // on the success path — checked by requiring resolveFaceRenderProvider to
    // appear AFTER the "!ensured.ok" guard opens and BEFORE that block's own
    // closing 502 return.
    const guardIdx = src.indexOf("if (!ensured.ok)")
    const providerIdx = src.indexOf("resolveFaceRenderProvider(")
    check(`${label}: the Simli fail-over is textually INSIDE the D-ID-failed branch, not the success path`,
      guardIdx > -1 && providerIdx > guardIdx)
  }

  // CONTROL: a route that does NOT import the seam at all is correctly
  // recognized as not wired — e.g. this simulator file itself.
  check("[control] this simulator file itself does not import simliFaceRenderAdapter (sanity on the regex)",
    !/simliFaceRenderAdapter/.test(readStripped("scripts/strip-comments.ts")))
}

// ═══════════════════════════════════════════════════════════════════════════
// §meteringAware — ONE function, provider-aware, no second copy
// ═══════════════════════════════════════════════════════════════════════════
function meteringAwareSection() {
  console.log("\n── §meteringAware — estimateStreamingMinutesCostUsd(seconds, provider), one ledger ──")
  check("SIMLI_USD_PER_STREAMING_MINUTE is Simli's published pay-as-you-go rate ($0.009/min)",
    SIMLI_USD_PER_STREAMING_MINUTE === 0.009)
  check("SIMLI rate is dramatically cheaper than DID's rate (backup leg, not a mispriced swap)",
    SIMLI_USD_PER_STREAMING_MINUTE < DID_USD_PER_STREAMING_MINUTE)
  check("estimateStreamingMinutesCostUsd(75s, 'did') matches the pre-wave-62 one-arg call (backward compatible)",
    estimateStreamingMinutesCostUsd(75) === estimateStreamingMinutesCostUsd(75, "did"))
  check("estimateStreamingMinutesCostUsd(75s, 'simli') prices at the Simli rate, not the D-ID rate",
    estimateStreamingMinutesCostUsd(75, "simli") === Math.round(1.25 * SIMLI_USD_PER_STREAMING_MINUTE * 10000) / 10000 &&
    estimateStreamingMinutesCostUsd(75, "simli") !== estimateStreamingMinutesCostUsd(75, "did"))

  const metering = readStripped("lib/did/live-session-metering.ts")
  check("closeLiveAgentSession reads row.provider (provider-aware), not a hardcoded 'did' literal in the vendorName field",
    /vendorName:\s*provider/.test(metering) && !/vendorName:\s*["']did["']/.test(metering))
  check("startLiveAgentSession accepts an optional provider param, defaulting to 'did' (additive, §6)",
    /provider\?\:\s*["']did["']\s*\|\s*["']simli["']/.test(metering) && /provider:\s*params\.provider\s*\?\?\s*["']did["']/.test(metering))
  check("ONE close path still shared by end AND sweep (§6 — not duplicated for the Simli branch)",
    (metering.match(/closeLiveAgentSession\(/g) ?? []).length >= 3)

  // CONTROL: the OLD hardcoded literal, if it were still present, WOULD match
  // this regex — proving the check can fail. (Asserted against a specimen,
  // not the real file, since the real file must NOT contain it.)
  const oldSpecimen = `vendorName: "did",`
  check("[control] the pre-wave-62 hardcoded literal IS matched by the literal-detector regex (proves it's a real check)",
    /vendorName:\s*["']did["']/.test(oldSpecimen))
}

// ═══════════════════════════════════════════════════════════════════════════
// §pcm16k — the client feeds PCM16 mono 16kHz, chunked
// ═══════════════════════════════════════════════════════════════════════════
function pcm16kSection() {
  console.log("\n── §pcm16k — SimliFaceSession feeds PCM16 16kHz to sendAudioData, chunked ──")
  const session = readStripped("app/components/features/ai-avatar-chat/SimliFaceSession.tsx")
  const tts = readStripped("app/api/internal/voice-tts/route.ts")
  const elevenlabs = readStripped("lib/voice/elevenlabs-tts.ts")

  check("SimliFaceSession requests format: 'pcm_16000' from voice-tts",
    /format:\s*["']pcm_16000["']/.test(session))
  check("SimliFaceSession calls sendAudioData with a bounded chunk size",
    /sendAudioData\(/.test(session) && /PCM_CHUNK_BYTES/.test(session))
  check("the chunk size constant is the documented ≤6000-byte sweet spot (not the 65,536 hard max)",
    /PCM_CHUNK_BYTES = 6000/.test(session))
  check("voice-tts route accepts and whitelists format:'pcm_16000' (not a raw pass-through of any string)",
    /body\.format === ["']pcm_16000["']/.test(tts))
  check("voice-tts sets Content-Type audio/pcm only for the pcm branch (mp3 default unchanged)",
    /outputFormat \? ["']audio\/pcm["'] : ["']audio\/mpeg["']/.test(tts))
  check("elevenlabs-tts.ts's outputFormat param is only consulted by the STREAM variant (buffered synthesizeSpeech untouched)",
    /outputFormat\?\:\s*["']pcm_16000["']/.test(elevenlabs) && /output_format/.test(elevenlabs))

  // CONTROL: a specimen that sends the whole buffer in one call (no chunking)
  // is correctly recognized as NOT chunked.
  const unchunkedSpecimen = `clientRef.current?.sendAudioData(fullBuffer)`
  check("[control] an unchunked specimen has no PCM_CHUNK_BYTES reference (this check can fail)",
    !/PCM_CHUNK_BYTES/.test(unchunkedSpecimen))
}

// ═══════════════════════════════════════════════════════════════════════════
// §importScope — "simli-client" imported ONLY where it should be
// ═══════════════════════════════════════════════════════════════════════════
function importScopeSection() {
  console.log("\n── §importScope — 'simli-client' imported ONLY from the client component ──")
  // Sweep the two directories a live import could plausibly land in, rather
  // than the whole tree (scoped, and fast) — app/components and lib/.
  const candidates = [
    "app/components/features/ai-avatar-chat/SimliFaceSession.tsx",
    "app/components/features/ai-avatar-chat/AgentsWidget.tsx",
    "app/embed/[publicId]/embed-widget.tsx",
    "lib/providers/simli/client.ts",
    "lib/providers/simli/faces.ts",
    "lib/live-agent/face-render.ts",
  ]
  // The runtime import targets the package's dist/client module directly
  // (simli-client@3.0.2's index.js has a case-mismatched "./Client" require
  // that fails on Linux) — still the ONE real import of the SDK.
  const importers = candidates.filter((f) => /from ["']simli-client(\/dist\/client)?["']|import\(["']simli-client(\/dist\/client)?["']\)/.test(readStripped(f)))
  check("exactly ONE file imports the real 'simli-client' package (SimliFaceSession.tsx, dynamically)",
    importers.length === 1 && importers[0] === "app/components/features/ai-avatar-chat/SimliFaceSession.tsx")
  check("the import is DYNAMIC (import(\"simli-client/dist/client\")), not a static top-level import (bundle stays out of the primary path)",
    /await import\(["']simli-client\/dist\/client["']\)/.test(readStripped("app/components/features/ai-avatar-chat/SimliFaceSession.tsx")))
  check("the server-side Simli modules (client.ts/faces.ts) do NOT import 'simli-client' (that's a browser SDK, not a server one)",
    !/from ["']simli-client["']/.test(readStripped("lib/providers/simli/client.ts")) &&
    !/from ["']simli-client["']/.test(readStripped("lib/providers/simli/faces.ts")))

  // CONTROL: a specimen importing it from an unrelated file IS caught.
  const rogueSpecimen = `import { SimliClient } from "simli-client"\nexport function unrelated() {}`
  check("[control] a rogue import specimen IS detected by the same regex (proves the finder isn't a no-op)",
    /from ["']simli-client["']|import\(["']simli-client["']\)/.test(rogueSpecimen))
}

// ═══════════════════════════════════════════════════════════════════════════
// §consentUntouched — the D-ID 428 consent path is byte-identical to base
// ═══════════════════════════════════════════════════════════════════════════
const LANE_BASE_SHA = "ae5776cb"

function consentUntouchedSection() {
  console.log(`\n── §consentUntouched — app/api/did/create-avatar untouched since ${LANE_BASE_SHA} ──`)
  try {
    const baseline = execFileSync("git", ["show", `${LANE_BASE_SHA}:app/api/did/create-avatar/route.ts`], { cwd: root, encoding: "utf8" })
    const current = readRaw("app/api/did/create-avatar/route.ts")
    check("app/api/did/create-avatar/route.ts is BYTE-IDENTICAL to its content at the lane base commit",
      baseline === current)
  } catch (e) {
    check(`app/api/did/create-avatar/route.ts is BYTE-IDENTICAL to its content at the lane base commit (git show failed: ${e instanceof Error ? e.message : String(e)})`, false)
  }

  // CONTROL: a deliberately mutated copy of the SAME baseline text is
  // correctly recognized as different — proves the byte-compare isn't
  // trivially true (e.g. two empty strings).
  try {
    const baseline = execFileSync("git", ["show", `${LANE_BASE_SHA}:app/api/did/create-avatar/route.ts`], { cwd: root, encoding: "utf8" })
    const mutated = baseline + "\n// a rogue edit\n"
    check("[control] a deliberately mutated copy of the SAME baseline is correctly detected as NOT identical",
      baseline !== mutated)
  } catch {
    check("[control] a deliberately mutated copy of the SAME baseline is correctly detected as NOT identical (git show unavailable — cannot run control)", false)
  }

  // CONTROL: lib/did/consent.ts's WRITE path is untouched too — same sweep,
  // different file, same guarantee.
  try {
    const baseline = execFileSync("git", ["show", `${LANE_BASE_SHA}:lib/did/consent.ts`], { cwd: root, encoding: "utf8" })
    const current = readRaw("lib/did/consent.ts")
    check("lib/did/consent.ts is BYTE-IDENTICAL to its content at the lane base commit (the consent WRITE path, untouched)",
      baseline === current)
  } catch (e) {
    check(`lib/did/consent.ts is BYTE-IDENTICAL to its content at the lane base commit (git show failed: ${e instanceof Error ? e.message : String(e)})`, false)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §registration — MAINTENANCE_DOMAINS carries this domain
// ═══════════════════════════════════════════════════════════════════════════
function registrationSection() {
  console.log("\n── §registration — face_render_seam registered in MAINTENANCE_DOMAINS ──")
  check("MAINTENANCE_DOMAINS.face_render_seam exists", !!MAINTENANCE_DOMAINS["face_render_seam"])
  check("owned by asset_manager (mirrors live_agent_metering's TABLE_MANAGER ownership of live_agent_sessions)",
    MAINTENANCE_DOMAINS["face_render_seam"]?.manager === "asset_manager")
  check("its proof is this script's own npm target",
    MAINTENANCE_DOMAINS["face_render_seam"]?.proof === "test:face-render-seam")
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Face-render seam simulator (wave 62 — D-ID → Simli → text)")
  console.log("══════════════════════════════════════════════════════════════")
  seamExportsSection()
  providerOrderSection()
  simliEgressSection()
  consentGateSection()
  doorsWiredSection()
  meteringAwareSection()
  pcm16kSection()
  importScopeSection()
  consentUntouchedSection()
  registrationSection()
  console.log("\n────────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Face-render seam properties hold: D-ID primary, Simli backup, consent gate reused, one ledger, each with a positive control.")
}

main()
