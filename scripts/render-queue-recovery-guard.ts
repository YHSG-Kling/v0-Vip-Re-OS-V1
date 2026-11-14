#!/usr/bin/env tsx
/**
 * scripts/render-queue-recovery-guard.ts   (npm run test:render-queue-recovery — in-memory DB, no network)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 153, LANE 153J — A KILLED RENDER IS FOUND, A POISONED WINDOW DOES NOT STARVE THE QUEUE, AND A TERMINAL
 * FAILURE DOES NOT BURN ITS RETRIES.
 *
 * Three real defects in the composition render queue, each found by reading every reader of a render_status:
 *
 *   §A DEAD CLAIM. render-composition claims `queued → rendering`; a process killed at its 300 s cap / a memory limit
 *      / an instance recycle writes no terminal status, and NOTHING read a `rendering` row again (the requeue, the
 *      census and OS-health read `failed`; the pipeline reaper reads ai_video_projects). The row spun forever.
 *      Survivor: lib/remotion/registry.ts recoverStalledRenders (m933 claimed_at, stamped by trigger).
 *   §B POISON WINDOW. The cron's requeue read the 5 OLDEST failed rows unfiltered — five spent rows held that window
 *      forever and no newer transient failure was retried again. Survivor: requeueFailedRenders (spent rows excluded
 *      in the query, window 25).
 *   §C TERMINAL CLASSES. shouldAutoRequeueFailedRender never read error_message, so the census's own fix text
 *      ("treat a 404 as TERMINAL — the auto-requeue must not re-fetch a file that is gone") was not behavior. Each
 *      census signature now carries `retry`, and the decision refuses a terminal class without spending budget.
 *   §D THE LOOP, end to end on one client: stall → recover → requeue → stall → … → exhausted → left for a human.
 *
 * Drives the REAL exported survivors on scripts/in-memory-supabase.ts (SIMULATED — not the live database; the live
 * table held 0 rows on 2026-11-14). Runs under --conditions=react-server because registry.ts is server-only.
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { memSupabase, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import { recoverStalledRenders, requeueFailedRenders } from "../lib/remotion/registry"
import {
  shouldAutoRequeueFailedRender, MAX_AUTO_REQUEUE_ATTEMPTS, isStalledRender, stalledRenderError,
} from "../lib/remotion/render-decision"
import { classifyRenderFailure, RENDER_FAILURE_SIGNATURES, LIVE_RENDER_FAILURE_CENSUS_SQL } from "../lib/remotion/render-failure-census"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const code = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))

let passed = 0, failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n── ${s} ──`)

const NOW = new Date("2026-11-14T18:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000, HOUR = 3_600_000
const A = "tenant-a", B = "tenant-b"
const FULL_JUST_LISTED = { hook: "Just listed", address: "12 Elm St", cityState: "Pace, FL", price: 425000, bedrooms: 3, bathrooms: 2, sqft: 1800 }
const row = (over: Partial<Row>): Row => ({
  composition_id: "JustListedReel", brokerage_id: A, render_status: "queued", retry_count: 0, error_message: null,
  input_props: FULL_JUST_LISTED, claimed_at: null, created_at: ago(5 * MIN), completed_at: null, ...over,
})
const get = (db: { tables: Record<string, Row[]> }, id: string) => db.tables.remotion_composition_renders.find((r) => r.id === id)!
/** The stall horizon is DERIVED from the survivor's behavior (bisect the smallest age isStalledRender calls dead), never
 *  restated: the constants stay module-private in render-decision.ts and this proof judges what the function DOES. */
function horizonOf(field: "claimed_at" | "created_at"): number {
  let lo = 0, hi = 7 * 24 * HOUR
  if (!isStalledRender({ [field]: ago(hi) }, NOW)) return Infinity
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (isStalledRender({ [field]: ago(mid) }, NOW)) hi = mid; else lo = mid }
  return hi
}
const RENDER_STALL_AFTER_MS = horizonOf("claimed_at")
const LEGACY_RENDER_STALL_AFTER_MS = horizonOf("created_at")

async function main() {
  // ═══════════════════════════════════════════════════════════════════════════
  section("§A · a claim the route never finished is failed render_stalled — and only that")
  {
    const db = memSupabase({ remotion_composition_renders: [
      row({ id: "dead", render_status: "rendering", claimed_at: ago(20 * MIN), created_at: ago(2 * HOUR) }),
      row({ id: "live", render_status: "rendering", claimed_at: ago(2 * MIN), created_at: ago(3 * HOUR) }),
      row({ id: "legacy-dead", render_status: "rendering", claimed_at: null, created_at: ago(30 * HOUR) }),
      row({ id: "legacy-young", render_status: "rendering", claimed_at: null, created_at: ago(2 * HOUR) }),
      row({ id: "done", render_status: "succeeded", claimed_at: ago(5 * HOUR), created_at: ago(5 * HOUR) }),
      row({ id: "other-tenant-dead", brokerage_id: B, render_status: "rendering", claimed_at: ago(40 * MIN) }),
    ] })
    const r = await recoverStalledRenders(db as never, { now: NOW })
    const moved = r.moved.map((m) => m.id).sort().join(",")
    check("the dead claims (20 min, 40 min, and a 30 h legacy row with no stamp) are recovered — nothing else", moved === "dead,legacy-dead,other-tenant-dead" && !r.error, JSON.stringify(r))
    check("a claim 2 min old is KEPT (it may still be rendering) — the horizon is three route lifetimes, not zero", get(db, "live").render_status === "rendering" && r.skipped.some((s) => s.id === "live"))
    check("a stamp-less row only 2 h old is KEPT (created_at can sit hours in the queue before a legitimate claim)", get(db, "legacy-young").render_status === "rendering")
    check("a finished row is never read by the sweep", get(db, "done").render_status === "succeeded")
    const dead = get(db, "dead")
    check("the recovered row is failed with the claim time in its reason and completed_at stamped", dead.render_status === "failed" && /^render_stalled: claimed at /.test(String(dead.error_message)) && String(dead.error_message).includes(ago(20 * MIN)) && dead.completed_at === NOW.toISOString(), JSON.stringify(dead))
    check("the legacy reason says WHY it was judged on created_at", /no claim stamp/.test(String(get(db, "legacy-dead").error_message)))
    const c = classifyRenderFailure(String(dead.error_message))
    check("the census files it render_stalled (transient) — NOT memory, although the reason says the function was 'killed'", c.bucket === "render_stalled" && c.signature?.retry === "transient", c.bucket)
    check("CONTROL: the memory signature WOULD match that sentence on its own — first-match order is what keeps it honest", RENDER_FAILURE_SIGNATURES.find((s) => s.bucket === "memory")!.pattern.test(String(dead.error_message)))
    check("the SQL census orders render_stalled ahead of memory too (one vocabulary, same precedence)", LIVE_RENDER_FAILURE_CENSUS_SQL.indexOf("'render_stalled'") > 0 && LIVE_RENDER_FAILURE_CENSUS_SQL.indexOf("'render_stalled'") < LIVE_RENDER_FAILURE_CENSUS_SQL.indexOf("then 'memory'"))
    const again = await recoverStalledRenders(db as never, { now: NOW })
    check("idempotent: a second sweep moves nothing", again.moved.length === 0)

    // VERSION SAFETY: the row is re-claimed (fresh stamp) between the sweep's read and its flip → the flip matches nothing.
    const db2 = memSupabase({ remotion_composition_renders: [row({ id: "raced", render_status: "rendering", claimed_at: ago(30 * MIN) })] })
    const racing = { from: (t: string) => { const b: any = db2.from(t); const up = b.update.bind(b); b.update = (p: Row) => { if (p.render_status === "failed") get(db2, "raced").claimed_at = NOW.toISOString(); return up(p) }; return b } }
    const rr = await recoverStalledRenders(racing as never, { now: NOW })
    check("a row re-claimed between the read and the flip is NOT failed (the flip is guarded on the claim stamp it was judged on)", rr.moved.length === 0 && get(db2, "raced").render_status === "rendering" && rr.skipped.some((s) => /re-claimed/.test(s.reason)), JSON.stringify(rr))

    // BEFORE m933: the claimed_at read is refused → reported, nothing moved, never an empty-queue reading.
    const pre = memSupabase({ remotion_composition_renders: [row({ id: "x", render_status: "rendering", created_at: ago(40 * HOUR) })] }, { missingColumns: { remotion_composition_renders: ["claimed_at"] } })
    const pr = await recoverStalledRenders(pre as never, { now: NOW })
    check("pre-m933 (no claimed_at column) the sweep REPORTS the refused read and moves nothing", !!pr.error && /stalled-render read refused/.test(pr.error) && pr.moved.length === 0 && get(pre, "x").render_status === "rendering", JSON.stringify(pr))

    check("the stall horizon is ≥ 2× the render route's REAL maxDuration (read from the route, not restated)", (() => {
      const m = /export const maxDuration\s*=\s*(\d+)/.exec(code("app/api/internal/remotion/render-composition/route.ts"))
      return !!m && RENDER_STALL_AFTER_MS >= 2 * Number(m[1]) * 1000
    })())
    check("the legacy horizon is longer than the stamped one (a stamp-less row is never reaped earlier)", LEGACY_RENDER_STALL_AFTER_MS > RENDER_STALL_AFTER_MS)
    check("isStalledRender agrees at the edges (exactly at the horizon = stalled, one ms before = live)", isStalledRender({ claimed_at: ago(RENDER_STALL_AFTER_MS) }, NOW) && !isStalledRender({ claimed_at: ago(RENDER_STALL_AFTER_MS - 1) }, NOW))
    check("a row with no clock at all is never reaped blindly", !isStalledRender({ claimed_at: null, created_at: null }, NOW))

    const route = code("app/api/internal/remotion/render-composition/route.ts")
    const claim = /\.update\(\{\s*render_status:\s*"rendering"\s*\}\)/.exec(route)
    check("the claim UPDATE names NO new column (claimed_at is the trigger's — a lagging migration cannot PGRST204 every claim)", !!claim && !/claimed_at/.test(route))
    check("CONTROL: the claim locator would see a claim that DID name the column", !/\.update\(\{\s*render_status:\s*"rendering"\s*\}\)/.test(`.update({ render_status: "rendering", claimed_at: now })`))
    const mig = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(root, "supabase/migrations", f), "utf8")).find((s) => /create trigger\s+trg_stamp_render_claimed_at/i.test(s)) ?? ""
    check("a migration creates the stamping trigger on the transition into 'rendering' and adds the column", /add column if not exists claimed_at timestamptz/i.test(mig) && /before update of render_status on public\.remotion_composition_renders/i.test(mig) && /new\.render_status = 'rendering' and old\.render_status is distinct from 'rendering'/i.test(mig))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("§B · five spent rows can no longer starve every newer retry")
  {
    const seed: Row[] = []
    for (let i = 0; i < 6; i++) seed.push(row({ id: `spent-${i}`, render_status: "failed", retry_count: MAX_AUTO_REQUEUE_ATTEMPTS, error_message: "Task timed out after 300.00 seconds", created_at: ago((100 - i) * HOUR) }))
    seed.push(row({ id: "fresh", render_status: "failed", retry_count: 0, error_message: "Task timed out after 300.00 seconds", created_at: ago(1 * HOUR) }))
    const db = memSupabase({ remotion_composition_renders: seed })
    const oldWindow = [...seed].filter((r) => r.render_status === "failed").sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).slice(0, 5).map((r) => r.id)
    check("CONTROL: the OLD query shape (5 oldest failed, unfiltered) never even READ the retryable row", !oldWindow.includes("fresh") && oldWindow.length === 5)
    const r = await requeueFailedRenders(db as never)
    check("the retryable row behind six spent ones IS requeued (retry_count 1, error cleared)", r.moved.some((m) => m.id === "fresh") && get(db, "fresh").render_status === "queued" && get(db, "fresh").retry_count === 1 && get(db, "fresh").error_message === null, JSON.stringify(r))
    check("spent rows are excluded by the query, not re-judged every tick (none appears in moved or skipped)", ![...r.moved, ...r.skipped].some((x) => x.id.startsWith("spent-")) && seed.filter((s) => s.id.startsWith("spent-")).every((s) => get(db, s.id).render_status === "failed"))

    // RACE: retry_count changes between the read and the flip → zero rows → reported, not double-counted.
    const db2 = memSupabase({ remotion_composition_renders: [row({ id: "r", render_status: "failed", retry_count: 0, error_message: "Task timed out" })] })
    const racing = { from: (t: string) => { const b: any = db2.from(t); const up = b.update.bind(b); b.update = (p: Row) => { if (p.render_status === "queued") get(db2, "r").retry_count = 1; return up(p) }; return b } }
    const rr = await requeueFailedRenders(racing as never)
    check("a row requeued by someone else between read and flip is reported 'already claimed', not flipped twice", rr.moved.length === 0 && rr.skipped.some((s) => /already claimed/.test(s.reason)) && get(db2, "r").render_status === "failed", JSON.stringify(rr))

    const refused = memSupabase({ remotion_composition_renders: [] }, { refuse: { remotion_composition_renders: "permission denied" } })
    const rf = await requeueFailedRenders(refused as never)
    check("a refused read is REPORTED (error set), never read as an empty queue", !!rf.error && /failed-render read refused/.test(rf.error))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("§C · a terminal failure does not spend its retries; a transient one does")
  {
    const cases: Array<[string, string, boolean]> = [
      ["gone-photo", "Error loading image with src: https://cdn.example.com/listing/12-elm/photo-03.jpg", false],
      ["no-sources", "Module not found: Error: Can't resolve './JustListedReel' in '/var/task/remotion'", false],
      ["alias", "Module not found: Error: Can't resolve '@/lib/format/math' in '/var/task/lib/video'", false],
      ["interp", "inputRange must be strictly monotonically increasing but got [0,0]", false],
      ["stalled", stalledRenderError({ claimed_at: ago(20 * MIN) }, NOW), true],
      ["timeout", "Task timed out after 300.00 seconds", true],
      ["blip", "NetworkError: A network error occurred.", true],
      ["unknown", "something nobody has seen before", true],
    ]
    const db = memSupabase({ remotion_composition_renders: cases.map(([id, msg]) => row({ id, render_status: "failed", retry_count: 0, error_message: msg })) })
    const r = await requeueFailedRenders(db as never)
    for (const [id, msg, retried] of cases) {
      const c = classifyRenderFailure(msg)
      check(`${retried ? "transient" : "TERMINAL"} · ${c.bucket} ← ${msg.slice(0, 54)}…`, (get(db, id).render_status === (retried ? "queued" : "failed")) && get(db, id).retry_count === (retried ? 1 : 0))
    }
    const goneSkip = r.skipped.find((s) => s.id === "gone-photo")
    check("the terminal skip names the class and the signature's fix (a human reads WHY, not 'skipped')", !!goneSkip && /terminal failure \(media_decode\)/.test(goneSkip.reason) && /404/.test(goneSkip.reason), goneSkip?.reason)
    check("a missing deploy source and an `@/` alias are DIFFERENT root causes (deploy_sources_missing vs bundle_resolve)", classifyRenderFailure(cases[1][1]).bucket === "deploy_sources_missing" && classifyRenderFailure(cases[2][1]).bucket === "bundle_resolve")
    check("the SQL census classifies the deploy class BEFORE the generic resolve class (same precedence as the code)", LIVE_RENDER_FAILURE_CENSUS_SQL.indexOf("'deploy_sources_missing'") > 0 && LIVE_RENDER_FAILURE_CENSUS_SQL.indexOf("'deploy_sources_missing'") < LIVE_RENDER_FAILURE_CENSUS_SQL.indexOf("then 'bundle_resolve'"))
    check("every census signature declares a retry class (one table drives the rule)", RENDER_FAILURE_SIGNATURES.every((s) => s.retry === "transient" || s.retry === "terminal"))
    check("CONTROL: the doomed-props refusal still holds beside the terminal one", !shouldAutoRequeueFailedRender({ render_status: "failed", retry_count: 0, error_message: "Task timed out" }, ["price"]).requeue)
    const osHealth = code("lib/kernel/os-health.ts")
    check("the OS-health incident reads error_message, so its requeue/terminal verdict is the same judgment", /select\("id, composition_id, render_status, retry_count, error_message"\)/.test(osHealth) && /shouldAutoRequeueFailedRender\(r, \[\]\)/.test(osHealth))
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("§D · the loop: stall → recover → requeue, bounded, then a human")
  {
    const db = memSupabase({ remotion_composition_renders: [row({ id: "loop", render_status: "queued" })] })
    const trail: string[] = []
    let t = NOW.getTime()
    for (let attempt = 0; attempt <= MAX_AUTO_REQUEUE_ATTEMPTS; attempt++) {
      const r = get(db, "loop")
      r.render_status = "rendering"; r.claimed_at = new Date(t).toISOString() // the claim + the trigger's stamp
      t += RENDER_STALL_AFTER_MS + MIN                                        // the function dies; a tick runs later
      const rec = await recoverStalledRenders(db as never, { now: new Date(t) })
      const rq = await requeueFailedRenders(db as never)
      trail.push(`${rec.moved.length ? "recovered" : "-"}/${rq.moved.length ? `requeued(${get(db, "loop").retry_count})` : "left"}`)
    }
    const final = get(db, "loop")
    check(`each death is recovered and retried until the budget is spent: ${trail.join(" → ")}`, trail.join(",") === `recovered/requeued(1),recovered/requeued(2),recovered/left` && final.render_status === "failed" && final.retry_count === MAX_AUTO_REQUEUE_ATTEMPTS)
    check("the exhausted row is left failed with render_stalled for the OS-health incident and a human", /^render_stalled/.test(String(final.error_message)) && !shouldAutoRequeueFailedRender(final as never, []).requeue)

    const cron = code("app/api/cron/composition-render-queue/route.ts")
    const at = (s: string) => cron.indexOf(s)
    check("the cron runs recovery BEFORE the requeue, both AFTER the living-video refresh and BEFORE the drain", at("refreshLivingVideos(") > 0 && at("recoverStalledRenders(svc)") > at("refreshLivingVideos(") && at("requeueFailedRenders(svc)") > at("recoverStalledRenders(svc)") && cron.search(/\.eq\(\s*["']render_status["']\s*,\s*PICKABLE_RENDER_STATUS/) > at("requeueFailedRenders(svc)"))
    check("the cron reports both sweeps in BOTH responses (empty queue and processed)", (cron.match(/stall_recovery/g) ?? []).length === 2 && (cron.match(/auto_requeue/g) ?? []).length === 2)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("§E · what the tenant reads: the contract sentence, never the raw error")
  {
    const SAMPLES: Array<[string, string]> = [
      ["unplayable_output", "[media-host] refusing to host video-assets/compositions/tenant-a/JustListedReel/r1.mp4: the playability probe failed — output not playable: no moov box"],
      ["content_contract", "content_props_missing: address, price"],
      ["claim_refused", "claim_refused: Could not find the 'claimed_at' column of 'remotion_composition_renders' in the schema cache"],
      ["render_stalled", stalledRenderError({ claimed_at: ago(20 * MIN) }, NOW)],
      ["asset_load_timeout", "A delayRender() \"Loading <Img>\" was called but not cleared after 28000ms. See https://remotion.dev/docs/timeout for help."],
      ["browser_network", "NetworkError: A network error occurred."],
      ["media_decode", "Error loading image with src: https://tenant-a.supabase.co/storage/v1/object/public/listing-photos/12-elm/3.jpg"],
      ["deploy_sources_missing", "Module not found: Error: Can't resolve './JustListedReel' in '/var/task/remotion'"],
      ["bundle_resolve", "Module not found: Error: Can't resolve '@/lib/format/math' in '/var/task/lib/video'"],
      ["chromium_launch", "Failed to launch the browser process! spawn /tmp/chromium ENOENT"],
      ["frame_interpolation", "inputRange must be strictly monotonically increasing but got [0,0]"],
      ["ffmpeg_stitch", "ffmpeg exited 1: Error initializing filters for xfade"],
      ["function_timeout", "Task timed out after 300.00 seconds"],
      ["memory", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"],
      ["host_refused", "[media-host] video-assets/compositions/tenant-a/x.mp4 upload refused: The object exceeded the maximum allowed size"],
      ["provider", "D-ID talk failed: InsufficientCredits"],
      ["not_renderable", "composition_not_reachable_at_tier:solo_agent"],
      ["unknown", "something nobody has seen before"],
    ]
    const { presentRenderFailure } = await import("../lib/remotion/render-escalation")
    const { tenantCopyVerdict } = await import("../lib/errors")
    const LEAK = /\/|\[media-host\]|webpack|ffmpeg|chromium|D-ID|elevenlabs|supabase|bucket|render_stalled|delayRender|heap|moov|\bENOENT\b|_[a-z]+_|content_props_missing/i
    const LEAKY = ["unplayable_output", "media_decode", "deploy_sources_missing", "host_refused", "render_stalled", "provider", "claim_refused"]
    check(`CONTROL: the leak finder flags the RAW messages that carry a path / provider / storage / census token (${LEAKY.length} specimens) — it can see the defect`, LEAKY.every((b) => LEAK.test(SAMPLES.find(([sb]) => sb === b)![1])))
    check("every census bucket has a sample here (derived from the signatures, plus 'unknown')", [...new Set(RENDER_FAILURE_SIGNATURES.map((s) => s.bucket))].every((b) => SAMPLES.some(([sb]) => sb === b)))
    let allClean = true, retryTruth = true
    const bad: string[] = []
    for (const [bucket, msg] of SAMPLES) {
      const sig = RENDER_FAILURE_SIGNATURES.find((s) => s.bucket === bucket)
      const transient = (sig?.retry ?? "transient") === "transient"
      for (const [status, retries] of [["failed", 0], ["failed", MAX_AUTO_REQUEUE_ATTEMPTS], ["cancelled", 0]] as Array<[string, number]>) {
        const p = presentRenderFailure({ id: "9f3c2a71-0000-4000-8000-000000000000", render_status: status, error_message: msg, retry_count: retries })
        const s = p?.sentence ?? ""
        const clean = !!p && tenantCopyVerdict(s).ok && !LEAK.test(s) && !s.includes(msg.slice(0, 24))
        if (!clean) { allClean = false; bad.push(`${bucket}/${status}/${retries}: ${s}`) }
        const saysRetry = /retry automatically/i.test(s)
        if (saysRetry !== (status === "failed" && transient && retries < MAX_AUTO_REQUEUE_ATTEMPTS)) { retryTruth = false; bad.push(`retry claim wrong ${bucket}/${status}/${retries}: ${s}`) }
      }
    }
    check(`all ${SAMPLES.length} classes × 3 row states read as contract sentences: gated, no path / provider / storage / census token, no raw text`, allClean, bad.slice(0, 3).join(" ‖ "))
    check("'We'll retry automatically' appears EXACTLY when the bounded requeue will retry (transient class, retries left, failed)", retryTruth, bad.filter((b) => b.startsWith("retry")).slice(0, 2).join(" ‖ "))
    const gone = presentRenderFailure({ id: "9f3c2a71-aaaa", render_status: "failed", error_message: SAMPLES.find(([b]) => b === "media_decode")![1], retry_count: 0 })!
    check("a terminal missing photo tells the tenant the ONE thing they can do, and the reference is the row's short form", /replace the photo or clip and request the video again/i.test(gone.sentence) && !/retry automatically/i.test(gone.sentence) && gone.referenceId === "9F3C2A71" && /Reference: 9F3C2A71\./.test(gone.sentence), gone.sentence)
    check("a succeeded / rendering row has no failure sentence", presentRenderFailure({ id: "x1234", render_status: "succeeded", error_message: null, retry_count: 0 }) === null && presentRenderFailure({ id: "x1234", render_status: "rendering", error_message: null, retry_count: 0 }) === null)
    const action = code("app/actions/composition-library.ts")
    const client = code("app/dashboard/admin/composition-library/client.tsx")
    check("the composition-library action sends `failure` (presented), never the row's raw error_message, and presents its own refused read", /failure: presentRenderFailure\(r\)\?\.sentence \?\? null/.test(action) && !/error_message: r\.error_message/.test(action) && !/error: error\.message/.test(action))
    check("the admin page renders the sentence and no longer prints error_message", /\{h\.failure\}/.test(client) && !/h\.error_message/.test(client))
    check("CONTROL: the action finder would see the old pass-through line", /error_message: r\.error_message/.test("renders: rows.map((r) => ({ id: r.id, error_message: r.error_message }))"))
  }

  console.log(`\n Denominators: 6 claim shapes (dead / live / legacy-dead / legacy-young / finished / other tenant) + 2 races + 1 pre-migration refusal; 8 failure classes requeue-judged; one ${MAX_AUTO_REQUEUE_ATTEMPTS + 1}-death loop. SIMULATED on the in-memory client.`)
  console.log(" Blind spots: the trigger itself runs only in Postgres (asserted from the migration text, applied by the integrator); the cron handler is read from source, not invoked (createServiceClient has no injection seam).")
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
