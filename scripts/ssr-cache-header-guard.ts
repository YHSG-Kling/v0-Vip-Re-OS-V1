#!/usr/bin/env tsx
/**
 * scripts/ssr-cache-header-guard.ts   (npm run test:ssr-cache-headers)
 * ─────────────────────────────────────────────────────────────────────────────
 * A REFRESHED SESSION COOKIE MUST NEVER BE CACHEABLE BY A CDN.
 *
 * THE VULNERABILITY. When @supabase/ssr refreshes a session token server-side it
 * writes the new JWT onto the HTTP response as `Set-Cookie`. If a CDN caches that
 * response and replays it to somebody else, that person's browser stores the token
 * and they are signed in AS THE WRONG PERSON. Supabase's SSR advanced guide:
 *
 *   "When @supabase/ssr refreshes a session token server-side, it writes the updated
 *    JWT to the HTTP response via a Set-Cookie header. If your CDN (e.g. Vercel Edge,
 *    Cloudflare) caches that response and serves it to a different user, that user's
 *    browser will store the cached token and be signed in as the wrong person."
 *   — https://supabase.com/docs/guides/auth/server-side/advanced-guide
 *
 * It matters more here than in a normal app (CLAUDE.md §5): a support seat acting-as a
 * tenant is the request most likely to be refreshed mid-investigation, and leaking THAT
 * token hands a tenant user platform-staff credentials.
 *
 * THE FIX THIS GUARD PROTECTS. From @supabase/ssr 0.10.0 the library hands the required
 * cache headers to the `setAll` cookie callback as a SECOND ARGUMENT. The bump alone
 * changes nothing — the second argument only helps if the callback READS it and puts it
 * on the response. This guard proves all three links of that chain still hold:
 *
 *   1. CONTRACT  — the installed library really passes a second argument, and it really
 *                  contains no-store. Proven by driving the REAL library through its
 *                  REAL public API (createServerClient → signInWithOAuth's PKCE
 *                  code-verifier write), which fires setAll with zero network I/O.
 *   2. WIRING    — proxy.ts's setAll really applies that argument to the response.
 *                  Proven by executing the ACTUAL setAll body extracted from proxy.ts
 *                  source, not a copy of it, so deleting the line here breaks the test.
 *   3. FLOOR     — proxy.ts still sets an unconditional `private, no-store` for the
 *                  responses setAll never touches. See the long note in proxy.ts: the
 *                  library's header only lands on a REFRESH response, while every
 *                  response off that gate is tenant-private and must not be cached.
 *
 * POSITIVE CONTROL (CLAUDE.md §2). Link 2 is an assertion that something IS present, and
 * a broken extractor would report "present" for a file that no longer contains the code.
 * So the same harness is re-run against a deliberately BROKEN copy of the body with the
 * header-applying statement deleted; that run MUST fail. If the sabotaged body still
 * passes, the finder is blind and this guard fails loudly rather than reporting green.
 *
 * ZERO BASELINE, on purpose. This is not a burn-down. One un-wired callback is a
 * cross-tenant session leak, so there is no acceptable count above zero.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createServerClient } from "@supabase/ssr"
import { stripComments } from "./strip-comments"

const root = process.cwd()
const PROXY = join(root, "proxy.ts")
const SERVER_CLIENT = join(root, "lib/supabase/server.ts")

/** The directive that actually stops a shared cache from storing the response. */
const REQUIRED_DIRECTIVE = "no-store"

const failures: string[] = []
const notes: string[] = []

console.log("══════════════════════════════════════════════════════════════════════")
console.log("  a refreshed session cookie must never be CDN-cacheable")
console.log("══════════════════════════════════════════════════════════════════════")

// ─────────────────────────────────────────────────────────────────────────────
// LINK 1 — CONTRACT. Drive the real library and capture what it passes to setAll.
// signInWithOAuth({ skipBrowserRedirect }) only builds an authorize URL and stores
// the PKCE code verifier; that storage write goes through applyServerStorage, which
// is the same function a TOKEN_REFRESHED event uses. No network, real code path.
// ─────────────────────────────────────────────────────────────────────────────
type SetAllCall = { argc: number; cookieNames: string[]; headers: Record<string, string> }

async function captureLibraryCall(): Promise<SetAllCall | null> {
  const calls: SetAllCall[] = []
  const jar = new Map<string, string>()
  const supabase = createServerClient("https://example.supabase.co", "anon-key-not-used", {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: function (
        cookiesToSet: { name: string; value: string; options: unknown }[],
        headers: Record<string, string>,
      ) {
        // eslint-disable-next-line prefer-rest-params
        calls.push({ argc: arguments.length, cookieNames: cookiesToSet.map((c) => c.name), headers })
        cookiesToSet.forEach((c) => jar.set(c.name, c.value))
      },
    },
  })
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { skipBrowserRedirect: true },
  })
  if (error) notes.push(`signInWithOAuth reported: ${error.message}`)
  return calls[0] ?? null
}

const libCall = await captureLibraryCall()

console.log("\n  LINK 1 — library contract (real @supabase/ssr, no network)")
if (!libCall) {
  failures.push(
    "the installed @supabase/ssr never invoked setAll — the PKCE storage path this guard " +
      "drives has changed shape, so the contract is UNVERIFIED. Do not read this as safe.",
  )
  console.log("     ✗ setAll was never called")
} else {
  console.log(`     setAll invoked with ${libCall.argc} argument(s)`)
  console.log(`     cookies: ${libCall.cookieNames.join(", ")}`)
  console.log(`     headers: ${JSON.stringify(libCall.headers)}`)

  if (libCall.argc < 2) {
    failures.push(
      `@supabase/ssr called setAll with ${libCall.argc} argument(s); the cache-header ` +
        "argument arrives only from 0.10.0. The installed version is too old for the wiring below.",
    )
  }
  const cc = libCall.headers?.["Cache-Control"] ?? ""
  if (!cc.includes(REQUIRED_DIRECTIVE)) {
    failures.push(
      `the library's second argument carried Cache-Control "${cc}", which lacks ` +
        `"${REQUIRED_DIRECTIVE}" — the directive that stops a shared cache storing the response.`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LINK 2 — WIRING. Execute proxy.ts's REAL setAll body against a fake response.
// ─────────────────────────────────────────────────────────────────────────────

/** Pull the balanced-brace body of `setAll(...) { … }` out of comment-stripped source. */
function extractSetAllBody(file: string): { params: string; body: string } | null {
  const src = stripComments(readFileSync(file, "utf8"))
  const m = /\bsetAll\s*\(([^)]*)\)\s*\{/.exec(src)
  if (!m) return null
  let depth = 1
  let i = m.index + m[0].length
  const start = i
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") depth--
  }
  if (depth !== 0) return null
  return { params: m[1].trim(), body: src.slice(start, i - 1) }
}

/** Minimal stand-ins for the Next.js response surface the body touches. */
function makeHarness() {
  const cookiesSet: Array<{ name: string; value: string }> = []
  const mkResponse = () => ({
    headers: new Headers(),
    cookies: { set: (name: string, value: string) => void cookiesSet.push({ name, value }) },
  })
  const request = { cookies: { set: () => {}, getAll: () => [] } }
  const NextResponse = { next: () => mkResponse() }
  return { mkResponse, request, NextResponse, cookiesSet }
}

/**
 * Run a setAll body and report what ended up on the response.
 * Returns the Cache-Control the body left behind, or null.
 */
function runSetAllBody(body: string, headers: Record<string, string>): string | null {
  const h = makeHarness()
  const fn = new Function(
    "request",
    "NextResponse",
    "cookiesToSet",
    "headers",
    "__mkResponse",
    `let response = __mkResponse();\n${body}\nreturn response;`,
  ) as (
    request: unknown,
    NextResponse: unknown,
    cookiesToSet: unknown,
    headers: unknown,
    mk: unknown,
  ) => { headers: Headers }
  const res = fn(
    h.request,
    h.NextResponse,
    [{ name: "sb-auth-token", value: "new.jwt.value", options: {} }],
    headers,
    h.mkResponse,
  )
  return res.headers.get("Cache-Control")
}

console.log("\n  LINK 2 — proxy.ts wiring (body executed from real source)")
const extracted = extractSetAllBody(PROXY)

// The headers the library actually produced, so the wiring test uses real input.
const REAL_HEADERS = libCall?.headers ?? {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
}

if (!extracted) {
  // Fail closed (CLAUDE.md §4): a guard that cannot find the code it judges must
  // refuse, never quietly pass.
  failures.push(
    "could not extract a setAll body from proxy.ts — the callback was renamed, removed or " +
      "reshaped. The wiring is UNVERIFIED; this is a refusal, not a pass.",
  )
  console.log("     ✗ no setAll body found in proxy.ts")
} else {
  console.log(`     signature: setAll(${extracted.params})`)
  if (!/,/.test(extracted.params)) {
    failures.push(
      `proxy.ts declares setAll(${extracted.params}) — one parameter. The library passes the ` +
        "cache headers as a SECOND argument; a one-parameter callback silently drops them.",
    )
  }

  const applied = runSetAllBody(extracted.body, REAL_HEADERS)
  console.log(`     Cache-Control left on the response: ${applied ?? "(none)"}`)
  if (!applied || !applied.includes(REQUIRED_DIRECTIVE)) {
    failures.push(
      "proxy.ts's setAll did NOT put the library's cache headers on the response " +
        `(got ${applied ?? "no Cache-Control"}). A refreshed JWT would ship CDN-cacheable.`,
    )
  }

  // ── POSITIVE CONTROL ────────────────────────────────────────────────────────
  // Delete the header-applying statement and re-run. The assertion above must be
  // capable of FAILING, otherwise "passed" means nothing.
  const sabotaged = extracted.body.replace(
    /Object\.entries\s*\(\s*headers[\s\S]*?\)\s*\n?\s*\)/,
    "/* header application removed by positive control */",
  )
  const controlChanged = sabotaged !== extracted.body
  const controlResult = controlChanged ? runSetAllBody(sabotaged, REAL_HEADERS) : applied

  console.log("\n  POSITIVE CONTROL — same harness, header application deleted")
  if (!controlChanged) {
    failures.push(
      "the positive control could not sabotage proxy.ts's setAll body — its shape no longer " +
        "matches the mutation, so the wiring assertion above is UNPROVEN.",
    )
    console.log("     ✗ mutation did not apply")
  } else if (controlResult && controlResult.includes(REQUIRED_DIRECTIVE)) {
    failures.push(
      "POSITIVE CONTROL FAILED: with the header application deleted the harness STILL reported " +
        `Cache-Control "${controlResult}". The wiring check is blind and its pass means nothing.`,
    )
    console.log(`     ✗ sabotaged body still yielded: ${controlResult}`)
  } else {
    console.log(`     ✓ sabotaged body yields ${controlResult ?? "(none)"} — the check can fail`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LINK 3 — FLOOR. proxy.ts must still set an unconditional no-store for the
// responses setAll never runs on, and must not clobber the library's stronger header.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n  LINK 3 — unconditional floor on the auth gate")
const proxySrc = stripComments(readFileSync(PROXY, "utf8"))
const floor = /if\s*\(\s*!\s*response\.headers\.has\(\s*["'`]Cache-Control["'`]\s*\)\s*\)\s*\{\s*response\.headers\.set\(\s*["'`]Cache-Control["'`]\s*,\s*["'`]([^"'`]*)["'`]/.exec(
  proxySrc,
)
if (!floor) {
  failures.push(
    "proxy.ts no longer sets a fallback Cache-Control on the auth-gate response. The library's " +
      "header lands ONLY on refresh responses; every other authenticated response is " +
      "tenant-private and would become CDN-cacheable.",
  )
  console.log("     ✗ no conditional fallback found")
} else if (!floor[1].includes(REQUIRED_DIRECTIVE)) {
  failures.push(`the auth-gate fallback is "${floor[1]}", which lacks "${REQUIRED_DIRECTIVE}".`)
  console.log(`     ✗ fallback is "${floor[1]}"`)
} else {
  console.log(`     ✓ fallback "${floor[1]}" applies only when setAll did not already speak`)
}

// ─────────────────────────────────────────────────────────────────────────────
// LINK 4 — the Server-Component client must keep the gap VISIBLE.
// It cannot apply the headers (next/headers cookies() exposes no response), so the
// requirement is only that it names the parameter rather than looking like an oversight.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n  LINK 4 — lib/supabase/server.ts keeps the documented gap visible")
const serverExtract = extractSetAllBody(SERVER_CLIENT)
if (!serverExtract) {
  notes.push("lib/supabase/server.ts has no setAll callback (nothing to check).")
  console.log("     – no setAll present")
} else if (!/,/.test(serverExtract.params)) {
  failures.push(
    `lib/supabase/server.ts declares setAll(${serverExtract.params}) — it drops the cache-header ` +
      "argument without naming it. Accept the parameter so the gap stays legible.",
  )
  console.log(`     ✗ setAll(${serverExtract.params})`)
} else {
  console.log(`     ✓ setAll(${serverExtract.params}) — second argument named`)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n  BLIND SPOTS")
console.log("     · Only proxy.ts and lib/supabase/server.ts implement setAll; the deprecated")
// lib/auth/permissions.ts stood here too until wave 26 deleted it (tombstone:
// lib/auth/index.ts; survivor lib/security/permission-matrix.ts). A blind-spot
// note naming a file that no longer exists reads as coverage of nothing.
console.log("       get/set/remove adapter (app/actions/demo-auth.ts)")
console.log("       receive no cache headers from the library by design and are not checked here.")
console.log("     · This is a unit-level proof. It does not exercise a live CDN.")
for (const n of notes) console.log(`     · ${n}`)

if (failures.length > 0) {
  console.log(`\n  ✗ ${failures.length} failure(s):\n`)
  for (const f of failures) console.log(`     – ${f}\n`)
  console.log(" ❌ SSR_CACHE_HEADER_FAIL")
  process.exit(1)
}

console.log("\n  ✓ library passes cache headers, proxy.ts applies them, floor holds")
console.log("\n✅ SSR_CACHE_HEADER_PASS — a refreshed session cookie cannot be CDN-cached")
