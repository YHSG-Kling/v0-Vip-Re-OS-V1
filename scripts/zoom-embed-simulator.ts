#!/usr/bin/env tsx
/**
 * scripts/zoom-embed-simulator.ts
 *   run: npx tsx --conditions=react-server scripts/zoom-embed-simulator.ts
 *   suggested npm script (NOT added here — package.json is owned elsewhere):
 *     "test:zoom-embed": "tsx --conditions=react-server scripts/zoom-embed-simulator.ts"
 *
 * ROUND 40 PROOF — the meeting room's FULL IN-PAGE Zoom upgrade (the Meeting
 * SDK Component/embedded view) on top of the round-39 join tier:
 *
 *  Layer 1 (pure): the SDK JWT signature shape — HS256 header, appKey===
 *    sdkKey, mn/role/iat/exp/tokenExp claims, Zoom's 1800s..172800s lifetime
 *    window, HMAC verifiable with the SDK secret.
 *  Layer 2 (pure): role resolution — role 1 ONLY for the calendar event's
 *    owning agent; everyone else (including a missing owner) joins as 0.
 *  Layer 3 (pure + source): credential honesty — dedicated SDK vars win, the
 *    Zoom General-app fallback reuses ZOOM_CLIENT_ID/SECRET, no usable pair →
 *    a gap statement naming the EXACT missing env vars; the signature route
 *    refuses with 428 + that statement, after the SAME RLS event read the
 *    meeting page uses.
 *  Layer 4 (source): keep-one fallback lock — the round-39 iframe/join-launch
 *    markup lives ONLY in the extracted ZoomJoinFallback component; the page
 *    renders MeetingEmbed when creds exist else the fallback; MeetingEmbed
 *    degrades to the SAME fallback component client-side and cleans up
 *    (leaveMeeting + destroyClient) on unmount.
 *  Layer 5 (source): embedded-client-only lock — no '@zoom/meetingsdk' import
 *    anywhere in app/, components/, lib/ WITHOUT the '/embedded' subpath (the
 *    package's React wrappers peer-pin react 18; this repo runs React 19, so
 *    the React-pinned entry must never load).
 *
 * npm package under test: @zoom/meetingsdk (installed 6.2.0, added by the
 * orchestrator with --legacy-peer-deps — this simulator reports it and NEVER
 * edits package.json).
 */

import { readFileSync } from "fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join, dirname, relative } from "path"
import { fileURLToPath } from "url"
import { createHmac } from "crypto"
// Some transitive imports pull `server-only` — neutralize it in the require
// cache BEFORE importing anything app-side (the zoom-lane sim's idiom).
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }

import {
  resolveZoomSdkCredentials,
  zoomSdkGap,
  zoomSdkRoleForViewer,
  mintZoomSdkSignature,
  zoomPasswordFromJoinUrl,
} from "../lib/connections/zoom"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"))

// ─── Layer 1: signature shape (pure JWT decode) ──────────────────────────────
console.log("\nLayer 1 — SDK JWT signature shape")
{
  const NOW = Date.UTC(2026, 6, 20, 17, 0, 0) // fixed clock
  const sdkKey = "sdk_key_ABC123"
  const sdkSecret = "sdk_secret_S3CRET"
  const jwt = mintZoomSdkSignature({ sdkKey, sdkSecret, meetingNumber: "88812345678", role: 1, nowMs: NOW })
  const parts = jwt.split(".")
  check("three-part compact JWT", parts.length === 3)
  const header = b64urlJson(parts[0])
  const claims = b64urlJson(parts[1])
  check("header is HS256/JWT", header.alg === "HS256" && header.typ === "JWT", JSON.stringify(header))
  check("appKey present and === sdkKey (v5+ requirement)", claims.appKey === sdkKey && claims.sdkKey === sdkKey)
  check("mn is the meeting number", claims.mn === "88812345678")
  check("role claim carried (host)", claims.role === 1)
  check("iat backdated ~30s for clock skew", claims.iat === Math.floor(NOW / 1000) - 30)
  check("claim ordering sane: iat < exp ≤ tokenExp", claims.iat < claims.exp && claims.exp <= claims.tokenExp)
  const life = claims.exp - claims.iat
  check("lifetime inside Zoom's window [1800s, 172800s]", life >= 1800 && life <= 172_800, `lifetime=${life}`)
  const expectSig = createHmac("sha256", sdkSecret).update(`${parts[0]}.${parts[1]}`).digest("base64url")
  check("HMAC verifies with the SDK secret", parts[2] === expectSig)
  const wrongSig = createHmac("sha256", "other-secret").update(`${parts[0]}.${parts[1]}`).digest("base64url")
  check("a different secret does NOT verify", parts[2] !== wrongSig)

  const shortJwt = mintZoomSdkSignature({ sdkKey, sdkSecret, meetingNumber: "1", role: 0, nowMs: NOW, expiresInSec: 60 })
  const shortClaims = b64urlJson(shortJwt.split(".")[1])
  check("requested lifetime below 1800s clamps UP to 1800s", shortClaims.exp - shortClaims.iat === 1800)
  const longJwt = mintZoomSdkSignature({ sdkKey, sdkSecret, meetingNumber: "1", role: 0, nowMs: NOW, expiresInSec: 999_999_999 })
  const longClaims = b64urlJson(longJwt.split(".")[1])
  check("requested lifetime above 48h clamps DOWN to 172800s", longClaims.exp - longClaims.iat === 172_800)
  check("attendee mint carries role 0", b64urlJson(mintZoomSdkSignature({ sdkKey, sdkSecret, meetingNumber: "1", role: 0, nowMs: NOW }).split(".")[1]).role === 0)
}

// ─── Layer 2: role resolution (host vs attendee) ─────────────────────────────
console.log("\nLayer 2 — role resolution")
{
  check("the event's owning agent → role 1 (host)",
    zoomSdkRoleForViewer({ viewerUserId: "u-agent", eventAgentUserId: "u-agent" }) === 1)
  check("any other brokerage viewer → role 0 (attendee)",
    zoomSdkRoleForViewer({ viewerUserId: "u-other", eventAgentUserId: "u-agent" }) === 0)
  check("event with no owning agent → role 0 (never a free host)",
    zoomSdkRoleForViewer({ viewerUserId: "u-any", eventAgentUserId: null }) === 0)
  check("undefined owner → role 0",
    zoomSdkRoleForViewer({ viewerUserId: "u-any", eventAgentUserId: undefined }) === 0)
}

// ─── Layer 3: credential resolution + refusal honesty ────────────────────────
console.log("\nLayer 3 — credential resolution + creds-missing honesty")
{
  const full = resolveZoomSdkCredentials({ sdkKey: "K", sdkSecret: "S", clientId: "CID", clientSecret: "CS" })
  check("dedicated SDK vars win over the OAuth pair", full?.source === "sdk_app" && full.sdkKey === "K")
  const gen = resolveZoomSdkCredentials({ sdkKey: null, sdkSecret: null, clientId: "CID", clientSecret: "CS" })
  check("General-app fallback reuses ZOOM_CLIENT_ID/SECRET", gen?.source === "general_app" && gen.sdkKey === "CID" && gen.sdkSecret === "CS")
  check("a half SDK pair cannot sign (falls to OAuth pair or null)",
    resolveZoomSdkCredentials({ sdkKey: "K", sdkSecret: null, clientId: null, clientSecret: null }) === null)
  check("nothing configured → null (no fabricated credential)",
    resolveZoomSdkCredentials({}) === null)

  check("gap is null when a usable pair exists", zoomSdkGap({ clientId: "CID", clientSecret: "CS" }) === null)
  const gapNone = zoomSdkGap({}) ?? ""
  check("empty env: gap names ALL four env vars",
    ["ZOOM_SDK_KEY", "ZOOM_SDK_SECRET", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"].every((v) => gapNone.includes(v)), gapNone)
  const gapHalfSdk = zoomSdkGap({ sdkKey: "K" }) ?? ""
  check("half SDK pair: gap names exactly the missing ZOOM_SDK_SECRET",
    gapHalfSdk.includes("ZOOM_SDK_SECRET") && !gapHalfSdk.includes("missing ZOOM_SDK_KEY"), gapHalfSdk)
  const gapHalfOauth = zoomSdkGap({ clientId: "CID" }) ?? ""
  check("half OAuth pair: gap names the missing ZOOM_CLIENT_SECRET", gapHalfOauth.includes("ZOOM_CLIENT_SECRET"), gapHalfOauth)

  check("pwd extracted from a stamped join_url",
    zoomPasswordFromJoinUrl("https://zoom.us/j/88812345678?pwd=abcDEF123") === "abcDEF123")
  check("join_url without pwd → null", zoomPasswordFromJoinUrl("https://zoom.us/j/88812345678") === null)
  check("garbage join_url → null (no throw)", zoomPasswordFromJoinUrl("not a url") === null)

  // Route source locks: auth-gated, same RLS event read as the page, 428 gap.
  const route = src("app/api/meetings/sdk-signature/route.ts")
  check("route is auth-gated (supabase auth.getUser)", route.includes("auth.getUser()") && route.includes("401"))
  check("route reuses the page's RLS event access check", route.includes('from("calendar_events")') && route.includes("maybeSingle"))
  check("route refuses with 428 + the exact-gap statement when creds missing",
    route.includes("428") && route.includes("zoomSdkGap"))
  check("route resolves role via zoomSdkRoleForViewer (host = event owner)", route.includes("zoomSdkRoleForViewer"))
  check("route mints via mintZoomSdkSignature (the ONE pure JWT path)", route.includes("mintZoomSdkSignature"))
  check("route returns the roster name + optional stamped password",
    route.includes("userName") && route.includes("zoomPasswordFromJoinUrl"))
  check("route refuses honestly when no meeting number is stamped (409)", route.includes("409"))
}

// ─── Layer 4: keep-one fallback lock (source) ────────────────────────────────
console.log("\nLayer 4 — keep-one fallback lock")
{
  const page = src("app/dashboard/meetings/[eventId]/page.tsx")
  const embed = src("app/dashboard/meetings/[eventId]/meeting-embed.tsx")
  const fallback = src("app/dashboard/meetings/[eventId]/join-fallback.tsx")

  check("page renders MeetingEmbed when SDK creds resolve",
    page.includes("resolveZoomSdkCredentials") && page.includes("<MeetingEmbed"))
  check("page renders the EXTRACTED fallback (not inline markup) otherwise",
    page.includes("<ZoomJoinFallback") && page.includes("zoomSdkGap"))
  check("the round-39 iframe lives ONLY in join-fallback.tsx",
    fallback.includes("<iframe") && !page.includes("<iframe") && !embed.includes("<iframe"))
  check("MeetingEmbed degrades to the SAME fallback component client-side",
    embed.includes('from "./join-fallback"') && embed.includes("<ZoomJoinFallback"))
  check("fallback keeps the join-launch buttons + honest note",
    fallback.includes("Join Zoom meeting") && fallback.includes("note ?? FALLBACK_DEFAULT_NOTE"))
  check("embed fetches the server-minted signature (never mints client-side)",
    embed.includes("/api/meetings/sdk-signature") && !embed.includes("mintZoomSdkSignature"))
  check("embed mounts via createClient → init({ zoomAppRoot }) → join",
    embed.includes("createClient()") && embed.includes("zoomAppRoot") && embed.includes(".join("))
  check("unmount cleanup: leaveMeeting + destroyClient",
    embed.includes("leaveMeeting") && embed.includes("destroyClient"))
  check("ops note present (Meeting SDK feature + domain allow list)",
    /[Dd]omain [Aa]llow/.test(src("lib/connections/zoom.ts")) && /[Dd]omain/.test(embed))
}

// ─── Layer 5: embedded-client-only lock (React-19 safety) ────────────────────
console.log("\nLayer 5 — embedded-client-only lock")
{
  // components/ in this repo lives at app/components (tsconfig maps
  // @/components/* → ./app/components/*), so scanning app covers it.
  const scanRoots = ["app", "lib", "hooks", "services"]
  const offenders: string[] = []
  let embeddedImports = 0
  // TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
  // 82 copies of the same readdirSync walker. The survivor is
  // scripts/runtime-roots.ts:61 (`walkTs`), imported above. It enumerated
  // DIRECTORIES, and a root-level FILE is not a directory, so `proxy.ts` — the Next
  // 16 edge middleware — was outside this guard's corpus. A file that is never
  // opened reports green. `rootRuntimeFiles()` from the same survivor supplies it.
  for (const p of [...scanRoots.flatMap((r) => walkTs(join(ROOT, r))), ...rootRuntimeFiles(ROOT)]) {
    const text = readFileSync(p, "utf8")
    if (!text.includes("@zoom/meetingsdk")) continue
    // Every reference must carry the /embedded subpath — the package root /
    // React wrappers peer-pin react 18 and must never load under React 19.
    const bare = text.match(/@zoom\/meetingsdk(?!\/embedded)/g)
    if (bare) offenders.push(`${relative(ROOT, p)} (${bare.length} bare ref${bare.length > 1 ? "s" : ""})`)
    embeddedImports += (text.match(/@zoom\/meetingsdk\/embedded/g) ?? []).length
  }
  check("no '@zoom/meetingsdk' reference WITHOUT '/embedded' in app/lib/hooks/services or the repo root",
    offenders.length === 0, offenders.join("; "))
  check("the embedded Component-view client IS imported somewhere", embeddedImports > 0)
  const embed = src("app/dashboard/meetings/[eventId]/meeting-embed.tsx")
  check("the embed component dynamic-imports the embedded entry (no SSR load)",
    embed.includes('import("@zoom/meetingsdk/embedded")'))

  // Report (never edit) the npm dependency the upgrade rides on.
  const pkg = JSON.parse(src("package.json"))
  const dep = pkg.dependencies?.["@zoom/meetingsdk"]
  check("package.json carries @zoom/meetingsdk (installed by the orchestrator)", typeof dep === "string", String(dep))
  console.log(`  ℹ npm package: @zoom/meetingsdk@${dep} (embedded Component-view entry only)`)
}

// ─── Verdict ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
