/**
 * scripts/elevenlabs-egress-guard.ts
 *
 * test:elevenlabs-egress — EVERY ELEVENLABS CALL LEAVES THROUGH CONNECTION OS,
 * AND THERE IS EXACTLY ONE CALLER PER CAPABILITY.
 *
 * Two defects live in the same place and this guard covers both.
 *
 * 1. BESPOKE EGRESS. The connector gateway's header states the rule: "every
 *    outbound api / oauth / mcp call leaves the app through this one function,
 *    and every response comes back IN through connector-shape.adaptResponse (so
 *    a vendor field rename self-heals + is reported as drift) … never a bespoke
 *    fetch scattered across feature code." Voice cloning — the one ElevenLabs
 *    call that spends real money AND mints a durable asset an agent's identity
 *    depends on — was a raw fetch. It skipped credential resolution (a rotated
 *    key never reached it), self-healing (a `voice_id` rename would surface as
 *    an undefined three writes later), and metering.
 *
 *    Cloning is multipart. That was the reason it stayed raw, and the honest
 *    fix was to teach the gateway multipart rather than smuggle FormData
 *    through bodyType "binary" — which would have "worked", but only because
 *    BodyInit happens to accept FormData; the mode documents Buffer/Uint8Array,
 *    and a hand-set multipart Content-Type without fetch's generated boundary
 *    is rejected by every vendor.
 *
 * 2. DUPLICATE CALLERS. Two surfaces were POSTing to ElevenLabs
 *    /text-to-speech independently — lib/voice/elevenlabs-tts.ts (the real one,
 *    with brokerage-scoped metering and error classification) and the
 *    /api/elevenlabs/tts route, which read process.env.ELEVENLABS_API_KEY a
 *    second time and did none of it. Same vendor, same endpoint, two error
 *    vocabularies, one of them unmetered.
 *
 * SCOPE, CLOSED (m336): §5 used to assert — deliberately, as a TRUE assertion —
 * that the public website-widget lane (/api/widget/avatar-talk) was STILL a raw
 * fetch to ElevenLabs, so this guard could not quietly go green on a lane nobody
 * had converted. The owner authorised the consolidation and the audit found the
 * lane was dead code besides (its voice lookup keyed an agents-class column with
 * a users id, so it could never resolve a voice). The route is gone; §5 is now
 * the inverse claim, swept across the whole app rather than one known path.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  stripComments(src(p))

const GATEWAY = "lib/agentic-os/connector-gateway.ts"
const CLONE = "app/api/elevenlabs/voice-clone/route.ts"
const TTS_ROUTE = "app/api/elevenlabs/tts/route.ts"
const TTS_LIB = "lib/voice/elevenlabs-tts.ts"

console.log("\n═══ 1. The gateway speaks multipart, explicitly ═══")
{
  const g = code(GATEWAY)
  ok("bodyType admits \"multipart\" as its own mode, rather than leaving callers\n    to smuggle FormData through \"binary\"",
    /bodyType\?:[^\n]*"multipart"/.test(g))
  ok("...and multipart is EXCLUDED from the Content-Type auto-set, so fetch\n    supplies the boundary (a hand-set multipart header without it is rejected)",
    /req\.bodyType !== "binary" && req\.bodyType !== "multipart"/.test(g))
  ok("...and the body is passed through untouched rather than JSON.stringify'd,\n    which would have posted the string \"[object FormData]\"",
    /req\.bodyType === "binary" \|\| req\.bodyType === "multipart"/.test(g))
}

console.log("\n═══ 2. Voice cloning leaves through Connection OS ═══")
{
  const c = code(CLONE)
  ok("voice-clone no longer raw-fetches the ElevenLabs base",
    !/await fetch\(\s*`\$\{EL_API_BASE\}/.test(c), CLONE)
  ok("...it calls callConnector on the elevenlabs connector",
    /callConnector\s*[<(]/.test(c) && /connector: "elevenlabs"/.test(c))
  ok("...at the published clone path /voices/add", /path: "\/voices\/add"/.test(c))
  ok("...declaring bodyType multipart", /bodyType: "multipart"/.test(c))
  ok("...and callConnector is actually IMPORTED (the edit that first shipped\n    without it failed tsc, not the guard — assert the import too)",
    /import \{ callConnector \} from "@\/lib\/agentic-os\/connector-gateway"/.test(c))
}

console.log("\n═══ 3. A refused clone is still a refusal, not a half-written row ═══")
{
  const c = code(CLONE)
  ok("a gateway failure OR a missing voice_id short-circuits before any write —\n    the old code trusted elRes.ok alone and would have written `undefined`\n    as an agent's permanent voice id",
    /if \(!elRes\.ok \|\| !elData\.voice_id\)/.test(c))
  ok("...and the vendor's own message still reaches the caller when it has one",
    /elData\.detail\?\.message \?\? elRes\.error/.test(c))
}

console.log("\n═══ 4. One caller per capability ═══")
{
  const r = code(TTS_ROUTE)
  ok("the /api/elevenlabs/tts route delegates to synthesizeSpeech instead of\n    POSTing text-to-speech itself",
    /synthesizeSpeech\s*\(/.test(r) && !/text-to-speech/.test(r), TTS_ROUTE)
  ok("...and no longer reads ELEVENLABS_API_KEY a second time — the key belongs\n    to the one module that resolves it",
    !/process\.env\.ELEVENLABS_API_KEY/.test(r), TTS_ROUTE)
  ok("...it classifies the library's failure kinds rather than flattening every\n    problem to a 500",
    /quota|rate_limit/.test(r) && /503|429/.test(r))

  // The ONE documented raw fetch in the TTS library: streaming. The gateway
  // buffers a response and cannot hand back a live ReadableStream, so this is
  // an exception with a reason — asserted present so nobody "fixes" it into a
  // buffered call and silently kills streaming playback.
  const t = code(TTS_LIB)
  const rawStream = (t.match(/fetch\(\s*\n?\s*`https:\/\/api\.elevenlabs\.io[^`]*\/stream`/g) ?? []).length
  ok("the streaming path is the single remaining raw fetch in the TTS library,\n    because a gateway response is buffered and cannot be streamed",
    rawStream === 1, `found ${rawStream}`)
  // Two call sites: the buffered synthesizeSpeech, and the timestamped variant
  // the video rail uses for word-level alignment. Counted rather than guessed —
  // an earlier pass here asserted ">= 3" from a stale recollection and failed
  // on correct code, which is the same mistake in the opposite direction.
  const gatewayCalls = (t.match(/callConnector\s*[<(]/g) ?? []).length
  ok("...and every OTHER ElevenLabs call in that library is on the gateway",
    gatewayCalls >= 2, `callConnector call sites: ${gatewayCalls}`)
}

console.log("\n═══ 5. THE GAP IS CLOSED — swept, not spot-checked ═══")
{
  ok("the raw widget TTS route no longer exists",
    !existsSync("app/api/widget/avatar-talk/route.ts"))

  // The whole app, because closing one gap must not let another open elsewhere.
  // The ONE legitimate exception is the streaming read in the TTS library, which
  // §4 already pins by count and reason.
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); continue }
      if (!/\.tsx?$/.test(e.name)) continue
      if (full === TTS_LIB) continue
      const c = code(full)
      if (/await fetch\([^)]*api\.elevenlabs\.io/.test(c) ||
          /await fetch\(\s*`\$\{EL_API_BASE\}/.test(c)) offenders.push(full)
    }
  }
  for (const d of ["app", "lib"]) if (existsSync(d)) walk(d)
  ok("NO file outside the documented streaming exception raw-fetches ElevenLabs",
    offenders.length === 0, offenders.join(", "))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`ELEVENLABS EGRESS — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nEvery ElevenLabs call leaves through callConnector; the streaming read is")
  console.log("the one documented exception, and one capability has one caller.")
  process.exit(1)
}
console.log("Every ElevenLabs call is on Connection OS; the streaming read is the one stated exception.")
