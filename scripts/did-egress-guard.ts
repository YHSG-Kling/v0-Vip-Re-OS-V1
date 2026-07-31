/**
 * scripts/did-egress-guard.ts
 *
 * test:did-egress — EVERY D-ID CALL LEAVES THROUGH CONNECTION OS.
 *
 * The connector gateway's own header states the architecture rule: "every
 * outbound api / oauth / mcp call leaves the app through this one function, and
 * every response comes back IN through connector-shape.adaptResponse (so a
 * vendor field rename self-heals + is reported as drift) … never a bespoke fetch
 * scattered across feature code (the /ecc:api-connector-builder rule)."
 *
 * Six D-ID surfaces were doing exactly that bespoke fetch — thirteen raw calls.
 * Each one cost three things that are invisible until they bite:
 *
 *   · SELF-HEALING. adaptResponse exists to catch a vendor field rename and
 *     report the drift. A raw fetch skips it, so the rename surfaces as a
 *     mysterious undefined somewhere downstream instead of a named drift.
 *   · CREDENTIAL RESOLUTION. The gateway is where auth is resolved. A raw fetch
 *     pins process.env.DID_API_KEY at the call site, so a rotated credential
 *     never reaches it.
 *   · METERING AND ATTRIBUTION. Vendor spend and connector health are counted at
 *     the gateway. Thirteen calls were spending money invisibly.
 *
 * SCOPE, STATED: this guard covers the AUTHENTICATED D-ID lane. The public
 * website-widget lane (/api/widget/avatar-*) is still on raw fetch AND on
 * talks/streams — the API lib/did/agents.ts itself calls deprecated. That is a
 * consolidation, not a swap, and it is tracked separately rather than pretended
 * away here.
 */
import { readFileSync, existsSync } from "node:fs"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

/** The authenticated D-ID surfaces. Every one must be on the gateway. */
const AUTHED_SURFACES = [
  "app/api/did/create-avatar/route.ts",
  "app/api/did/generate-video/route.ts",
  "app/api/cron/poll-did-avatars/route.ts",
  "app/api/cron/poll-did-videos/route.ts",
]

console.log("\n═══ 1. No bespoke fetch to D-ID on the authenticated lane ═══")
{
  for (const p of AUTHED_SURFACES) {
    const c = code(p)
    ok(`${p.replace("app/api/", "")} has NO raw fetch to the D-ID base`,
      !/await fetch\(\s*`\$\{DID_API_BASE\}/.test(c) && !/await fetch\(endpoint/.test(c), p)
  }
  for (const p of AUTHED_SURFACES) {
    // Match the NAME plus either a generic or a paren. An earlier attempt used
    // <[^>]*> and still failed on didRequest<Record<string, unknown>>( — the
    // character class stops at the first '>', so a nested generic never matched.
    // Twice the code was right and the pattern was wrong.
    ok(`  …and calls didRequest instead`, /\bdidRequest\s*[<(]/.test(code(p)), p)
  }
}

console.log("\n═══ 2. Hand-rolled D-ID auth is gone from those surfaces ═══")
{
  for (const p of AUTHED_SURFACES) {
    ok(`${p.replace("app/api/", "")} no longer builds its own Basic header —\n    that is what pinned a credential at the call site`,
      !/Authorization: `Basic \$\{Buffer\.from\(`\$\{didApiKey\}/.test(code(p)), p)
  }
}

console.log("\n═══ 3. The wrapper is on the gateway and is TOTAL ═══")
{
  const g = code("lib/did/gateway.ts")
  ok("it exists", g.length > 0)
  ok("it routes through callConnector — the single egress path",
    g.includes("callConnector") && /baseUrl: DID_BASE/.test(g))
  ok("it NEVER throws: a missing credential returns ok:false rather than\n    exploding inside a cron tick",
    /if \(!key\)[\s\S]{0,120}return \{ ok: false/.test(g))
  ok("...and a transport failure is caught too", /catch \(e\)[\s\S]{0,140}return \{\s*ok: false/.test(g))
  ok("it returns status + data so callers can run classifyDidError and give the\n    agent a real instruction instead of a shrug",
    /status: res\.status \?\? null/.test(g) && /data:/.test(g))

  ok("it carries x-api-key-external by DEFAULT — every agent voice is an IVC\n    clone in OUR ElevenLabs account, so without it D-ID resolves voice_id\n    against ITS account and the avatar speaks in a stranger's voice",
    /withExternalKey === false \? \{\} : externalKeyHeader\(\)/.test(g))
  ok("...and a plain status poll can opt out, since it carries no voice",
    /withExternalKey: false/.test(code("app/api/cron/poll-did-avatars/route.ts")))
}

console.log("\n═══ 4. Callers still classify the failure ═══")
{
  for (const p of ["app/api/did/create-avatar/route.ts", "app/api/cron/poll-did-avatars/route.ts",
                   "app/api/cron/poll-did-videos/route.ts"]) {
    ok(`${p.replace("app/api/", "")} still runs the failure through classifyDidError`,
      code(p).includes("classifyDidError("), p)
  }
  ok("a gateway-level error still reaches the classifier as a description,\n    rather than being dropped on the floor",
    /statusRes\.data \?\? \{ description: statusRes\.error \}/.test(code("app/api/cron/poll-did-avatars/route.ts")))
}

console.log("\n═══ 5. The remaining gap is NAMED, not hidden ═══")
{
  // Honesty check: the widget lane is still raw. This guard must say so rather
  // than quietly scoping it out — a guard that looks green while a lane is
  // unconverted is the same lie it exists to prevent.
  const widgetRaw =
    /await fetch\(`\$\{DID_API_BASE\}/.test(code("app/api/widget/avatar-session/route.ts")) ||
    /await fetch\(`\$\{DID_API_BASE\}/.test(code("app/api/widget/avatar-talk/route.ts"))
  ok("the public widget lane is still on raw fetch — asserted TRUE so this\n    guard cannot silently start passing if someone believes it was done",
    widgetRaw)
  ok("...and this file states that scope in its header",
    /public website-widget lane/.test(src("scripts/did-egress-guard.ts")))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`D-ID EGRESS — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nEvery D-ID call leaves through lib/did/gateway.ts → callConnector.")
  console.log("A bespoke fetch loses self-healing, credential rotation and metering.")
  process.exit(1)
}
console.log("The authenticated D-ID lane is fully on Connection OS; the widget lane is named, not hidden.")
