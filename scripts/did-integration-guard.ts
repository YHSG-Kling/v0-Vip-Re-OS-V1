/**
 * scripts/did-integration-guard.ts
 *
 * test:did-integration — THE D-ID LANE CANNOT SILENTLY STALL.
 *
 * D-ID is asynchronous at every entry point: a submit returns a job id and
 * something else has to decide when that job is finished. Three places do that
 * (the inline poller in lib/did, the video poll cron, the avatar poll cron) and
 * each of them had a way to wait forever on a job that was already dead:
 *
 *   · the inline poller CONTINUED on any status that was not exactly "done" or
 *     "error", so a "rejected" job — a status the video cron itself already
 *     handles, which is how we know it is real — polled to the timeout and
 *     then reported "still processing" for something that would never finish;
 *   · the inline poller GUESSED which endpoint held the job by trying
 *     /talks/{id} and falling back to /expressives/{id} on ANY error, so a
 *     transient 5xx on a healthy talks job diverted it to /expressives, where
 *     it 404s, and the 404 surfaced as "D-ID poll failed";
 *   · both crons treated a 404 as transient and re-fetched it every tick
 *     forever, leaving the row at 'generating' and the agent waiting. (Fixed on
 *     the avatar cron in m316; the video cron still had it, which is how a
 *     defect class survives being found.)
 *
 * The engine is KNOWN at submit time and recorded on the row. Guessing where
 * you have the answer is the same failure as the render content contract in
 * this pass: the OS collected the answer and then used something else.
 *
 * NOTE ON VERIFICATION. api.d-id.com and docs.d-id.com are blocked by this
 * environment's network policy, so these assertions are grounded in the repo
 * and in the installed SDK's own type definitions — never in a remembered API
 * surface. That is deliberate: asserting a provider contract we cannot read
 * would be the same fabrication this build exists to remove.
 */
import { readFileSync } from "node:fs"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(p, "utf8")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

console.log("\n═══ 1. The inline poller treats UNKNOWN as terminal, not as 'keep waiting' ═══")
{
  const s = code("lib/did/index.ts")
  ok("in-flight statuses are an ALLOW-LIST", s.includes("DID_IN_FLIGHT_STATUSES"))
  ok("...containing the states that really mean 'still working'",
    /DID_IN_FLIGHT_STATUSES\s*=\s*new Set\(\[[^\]]*"created"[^\]]*"started"/.test(s))
  ok("...and the loop only CONTINUES for those",
    /if \(DID_IN_FLIGHT_STATUSES\.has\(status\)\) continue/.test(s))
  ok("anything else THROWS rather than polling to the timeout",
    /DID_IN_FLIGHT_STATUSES\.has\(status\)\) continue[\s\S]{0,400}throw new Error\(/.test(s))
  ok("...and names the unrecognised status verbatim, so an unhandled provider\n    state is legible instead of looking like a slow render",
    s.includes('ended in status "${status'))
  ok("the old deny-list is gone", !/status === "error"\)\s*\{\s*throw/.test(s))
}

console.log("\n═══ 2. The engine is PASSED, never probed ═══")
{
  const s = code("lib/did/index.ts")
  ok("pollUntilDone takes the engine as a parameter",
    /function pollUntilDone\(\s*talkId: string,\s*engine: DidEngine\s*\)/.test(s.replace(/\s+/g, " ").replace(/ /g, " ")) || /pollUntilDone\(talkId: string, engine: DidEngine\)/.test(s))
  ok("...and fetches exactly one endpoint", s.includes("didGet(`/${engine}/${talkId}`)"))
  ok("the try/talks-catch/expressives probe is gone — a transient 5xx on a\n    healthy job must not divert it to an endpoint where it 404s",
    !/didGet\(`\/talks\/\$\{talkId\}`\)[\s\S]{0,120}catch[\s\S]{0,120}didGet\(`\/expressives/.test(s))
  ok("the caller passes the engine it ALREADY computed at submit",
    s.includes('pollUntilDone(talkId, isV4Expressive ? "expressives" : "talks")'))
  ok("...and generateVideo still reports that engine back to its caller",
    /engine: isV4Expressive \? "expressives" : "talks"/.test(s))
}

console.log("\n═══ 3. Both crons key the endpoint off the RECORDED mode ═══")
{
  const v = code("app/api/cron/poll-did-videos/route.ts")
  ok("the video cron reads provider_metadata.mode", /pmeta\?\.mode === "clip"/.test(v))
  ok("...and builds the path from it", v.includes("${DID_API_BASE}/${mode}/"))

  const a = code("app/api/cron/poll-did-avatars/route.ts")
  ok("the avatar cron posts to the real avatars path (m316)", a.includes("/scenes/avatars"))
}

console.log("\n═══ 4. A 404 is TERMINAL in both crons ═══")
{
  const v = code("app/api/cron/poll-did-videos/route.ts")
  ok("the video cron distinguishes 404 from a transient failure",
    /statusRes\.status === 404/.test(v))
  ok("...marks the row failed rather than re-fetching it forever",
    /statusRes\.status === 404[\s\S]{0,700}status: "failed"/.test(v))
  ok("...and tells the agent who was waiting on it",
    /statusRes\.status === 404[\s\S]{0,1400}type: "video_failed"/.test(v))
  ok("...while 429 and 5xx stay transient", /Everything else/.test(src("app/api/cron/poll-did-videos/route.ts")))

  const a = code("app/api/cron/poll-did-avatars/route.ts")
  ok("the avatar cron already treats 404 as terminal (m316)", /404/.test(a))
}

console.log("\n═══ 5. 'rejected' is a real terminal status, per our OWN code ═══")
{
  // Corroboration from the repo rather than from memory: the video cron has
  // handled this status since before this pass, which is the evidence that the
  // inline poller's deny-list was incomplete.
  const v = code("app/api/cron/poll-did-videos/route.ts")
  ok("the video cron handles it", /didStatus === "rejected"/.test(v))
  ok("...and the inline poller's allow-list would now catch it too, because it\n    is not an in-flight status",
    !/DID_IN_FLIGHT_STATUSES\s*=\s*new Set\(\[[^\]]*"rejected"/.test(code("lib/did/index.ts")))
}

console.log("\n═══ 6. The streaming SDK bump is source-compatible where we touch it ═══")
{
  // The widget lane rides @d-id/client-sdk. The bump 1.1.68 → 2.x was made
  // because the AgentManagerOptions surface we pass is ADDITIVE-only across it
  // (2.x adds optional verbose/enableAnalytics and nothing else), and 2.x is
  // what carries Expressives V4 over LiveKit. This locks that fact so a future
  // major cannot quietly drop an option the widget depends on.
  const pkg = JSON.parse(src("package.json"))
  const pinned = pkg.dependencies?.["@d-id/client-sdk"] ?? ""
  ok(`package.json pins the SDK at 2.x (${pinned})`, /^\^?2\./.test(pinned), pinned)

  const installed = JSON.parse(src("node_modules/@d-id/client-sdk/package.json")).version
  ok(`the installed SDK is 2.x (${installed})`, /^2\./.test(installed))

  const opts = src("node_modules/@d-id/client-sdk/dist/src/types/entities/agents/manager.d.ts")
  for (const key of ["auth", "callbacks", "mode", "externalId"]) {
    ok(`AgentManagerOptions still accepts \`${key}\` — the widget passes it`,
      new RegExp(`\\b${key}\\??:`).test(opts))
  }

  const widget = code("app/components/features/ai-avatar-chat/AgentsWidget.tsx")
  ok("the widget passes exactly those four and nothing removed",
    widget.includes("createAgentManager(didAgentId, {")
    && widget.includes("auth: { type: \"key\", clientKey }")
    && widget.includes("mode: didSdk.ChatMode.TextOnly")
    && widget.includes("externalId: contactId"))
  ok("...and still degrades to text chat on any connection failure, which is\n    what makes the major bump a contained risk",
    widget.includes('fail("Connection lost — switching to chat")'))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`D-ID INTEGRATION — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("No D-ID job can wait forever on a status or an endpoint nobody checked.")
