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
 * SCOPE, CLOSED (m336): this guard used to cover only the AUTHENTICATED D-ID
 * lane, and §5 asserted — deliberately, as a TRUE assertion — that the public
 * website-widget lane (/api/widget/avatar-*) was STILL on raw fetch and still on
 * talks/streams, so a green run could never be mistaken for a converted lane.
 *
 * That assertion has now done its job by FAILING. The widget lane is gone:
 * /api/widget/avatar-session and /api/widget/avatar-talk were retired in m336
 * once the audit showed they could never have worked (they looked up
 * `agents.user_id` with an agents.id, so every call 404'd), and the real public
 * agent is the embed widget on the D-ID Agents SDK — through this gateway,
 * capped, budget-gated and metered.
 *
 * §5 is now the inverse claim, asserted just as literally: no raw D-ID fetch and
 * no deprecated talks/clips stream call survives ANYWHERE in the app.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"

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

console.log("\n═══ 5. THE GAP IS CLOSED — no lane left outside the gateway ═══")
{
  // This section used to assert the widget lane was STILL raw, so a green run
  // could not be mistaken for a converted lane. m336 converted it by RETIRING
  // it, and that assertion failed — which is the guard working, not breaking.
  ok("the raw widget avatar routes no longer exist",
    !existsSync("app/api/widget/avatar-session/route.ts") &&
    !existsSync("app/api/widget/avatar-talk/route.ts"))

  // Sweep the whole app rather than two known paths: the point of closing a gap
  // is that a NEW one must not open somewhere else.
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); continue }
      if (!/\.tsx?$/.test(e.name)) continue
      const c = code(full)
      if (/await fetch\([^)]*api\.d-id\.com/.test(c) ||
          /await fetch\(\s*`\$\{DID_API_BASE\}/.test(c)) offenders.push(full)
    }
  }
  for (const d of ["app", "lib"]) if (existsSync(d)) walk(d)
  ok("NO file under app/ or lib/ raw-fetches D-ID any more — every call leaves\n    through lib/did/gateway.ts",
    offenders.length === 0, offenders.join(", "))

  const deprecated: string[] = []
  const walkDep = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== "node_modules") walkDep(full); continue }
      if (!/\.tsx?$/.test(e.name)) continue
      // A PATH EXPRESSION, not the words. The manager registry documents the
      // retired lane inside a string literal (prose in data, which code() cannot
      // strip), and lib/did/agents.ts names the deprecated APIs in its header to
      // explain what it replaced. Matching the bare words flagged both — the
      // pattern was wrong, the code was right. Anchor on a URL path opening:
      // `${BASE}/talks/streams` or "/clips/streams".
      if (/[`"'](?:\$\{[^}]*\})?\/(?:talks|clips)\/streams/.test(code(full))) deprecated.push(full)
    }
  }
  for (const d of ["app", "lib"]) if (existsSync(d)) walkDep(d)
  ok("...and nothing calls the DEPRECATED talks/streams or clips/streams APIs",
    deprecated.length === 0, deprecated.join(", "))
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
console.log("Every D-ID call in the app leaves through Connection OS — no lane left outside.")
