/**
 * scripts/render-cache-simulator.ts
 *
 * test:render-cache — the proof for DETERMINISTIC, CACHEABLE COMPOSITION OF
 * VIDEO (m310).
 *
 * Two halves:
 *
 *   PURE   the identity functions, exercised against the properties a cache key
 *          must have: stable under key reordering, sensitive to array order,
 *          sensitive to code revision, split correctly between frames and
 *          finish, and honest about which props are nonces.
 *   WIRING the facts that make the pure core matter — the tier gate runs on the
 *          live path, the dead entry point is gone, there is ONE stock picker
 *          and ONE tier ladder, the narration path carries no clock, a cache hit
 *          still runs the delivery loop, and a refused serve renders instead of
 *          lying.
 *
 * No DB, no egress. The live end-to-end run is separate (and cleans up after
 * itself); this is the invariant net that runs on every guard.
 */
import { readFileSync } from "node:fs"
import {
  canonicalJson,
  framePropsOf,
  computeFrameKey,
  computeArtifactKey,
  computeNarrationKey,
  findCachePoisoningProps,
  summarizeCacheEconomics,
  buildRevision,
  leakBrief,
  NO_FINISH,
  FINISH_PROP_KEYS,
  RENDER_CACHE_LEAK_SIGNAL,
  type FinishInputs,
} from "../lib/remotion/composition-cache"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { TABLE_MANAGER, MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let pass = 0
let fail = 0
const failures: string[] = []

function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

/** Source with comments stripped, so an assertion about a dead pattern is not
 *  defeated by a comment that names the pattern it removed. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
}

const GEO = { width: 1080, height: 1920, fps: 30, durationFrames: 480 }

console.log("\n═══ 1. Canonical JSON — key order is noise, array order is content ═══")
{
  ok("key order does not change the canonical form",
    canonicalJson({ a: 1, b: 2 }) === canonicalJson({ b: 2, a: 1 }))
  ok("nested key order does not change it either",
    canonicalJson({ x: { p: 1, q: 2 } }) === canonicalJson({ x: { q: 2, p: 1 } }))
  ok("array order DOES change it (slide 1 then 2 is a different video)",
    canonicalJson([1, 2]) !== canonicalJson([2, 1]))
  ok("undefined is dropped like JSON.stringify drops it",
    canonicalJson({ a: 1, b: undefined }) === canonicalJson({ a: 1 }))
  ok("null is preserved and is NOT the same as absent",
    canonicalJson({ a: null }) !== canonicalJson({}))
  ok("NaN does not produce invalid output", canonicalJson({ a: NaN }) === '{"a":null}')
  ok("Infinity does not produce invalid output", canonicalJson({ a: Infinity }) === '{"a":null}')
  ok("strings with quotes survive", canonicalJson({ a: 'he said "hi"' }).includes('\\"'))
  ok("a deep object round-trips to valid JSON",
    JSON.parse(canonicalJson({ a: [1, { b: "c" }], d: null })) !== null)
}

console.log("\n═══ 2. Frame vs finish — the split that stops needless re-renders ═══")
{
  ok("FINISH_PROP_KEYS names voiceover_url", (FINISH_PROP_KEYS as readonly string[]).includes("voiceover_url"))
  ok("FINISH_PROP_KEYS names music_mood", (FINISH_PROP_KEYS as readonly string[]).includes("music_mood"))

  const props = { headline: "Market update", voiceover_url: "https://x/y.mp3", music_mood: "calm" }
  const frames = framePropsOf(props)
  ok("framePropsOf strips voiceover_url", !("voiceover_url" in frames))
  ok("framePropsOf strips music_mood", !("music_mood" in frames))
  ok("framePropsOf keeps the content props", frames.headline === "Market update")

  const base = { compositionId: "MarketUpdateReel", codeRevision: "abc123", geometry: GEO, props }
  const swappedNarration = { ...base, props: { ...props, voiceover_url: "https://x/DIFFERENT.mp3" } }
  ok("a narration swap does NOT change the frame key",
    computeFrameKey(base) === computeFrameKey(swappedNarration))
  ok("a narration swap DOES change the artifact key",
    computeArtifactKey(computeFrameKey(base), { ...NO_FINISH, voiceoverUrl: "https://x/y.mp3" })
      !== computeArtifactKey(computeFrameKey(base), { ...NO_FINISH, voiceoverUrl: "https://x/z.mp3" }))
}

console.log("\n═══ 3. Frame key — everything that changes the frames changes it ═══")
{
  const base = { compositionId: "MarketUpdateReel", codeRevision: "abc123", geometry: GEO, props: { a: 1 } }
  ok("identical inputs → identical key", computeFrameKey(base) === computeFrameKey({ ...base }))
  ok("prop key ORDER does not change it",
    computeFrameKey({ ...base, props: { a: 1, b: 2 } })
      === computeFrameKey({ ...base, props: { b: 2, a: 1 } }))
  ok("a different composition changes it",
    computeFrameKey(base) !== computeFrameKey({ ...base, compositionId: "CMAReel" }))
  ok("a different CODE REVISION changes it (a composition edit must not serve stale frames)",
    computeFrameKey(base) !== computeFrameKey({ ...base, codeRevision: "def456" }))
  ok("a different width changes it",
    computeFrameKey(base) !== computeFrameKey({ ...base, geometry: { ...GEO, width: 720 } }))
  ok("a different fps changes it",
    computeFrameKey(base) !== computeFrameKey({ ...base, geometry: { ...GEO, fps: 24 } }))
  ok("a different duration changes it",
    computeFrameKey(base) !== computeFrameKey({ ...base, geometry: { ...GEO, durationFrames: 600 } }))
  ok("a different prop value changes it",
    computeFrameKey(base) !== computeFrameKey({ ...base, props: { a: 2 } }))
  ok("null props and empty props agree (both fall back to registry defaultProps)",
    computeFrameKey({ ...base, props: null }) === computeFrameKey({ ...base, props: {} }))
  ok("the key is prefixed so a schema change is recognizable", computeFrameKey(base).startsWith("f1_"))
}

console.log("\n═══ 4. Artifact key — the finish inputs are part of the video ═══")
{
  const fk = computeFrameKey({ compositionId: "CMAReel", codeRevision: "r1", geometry: GEO, props: { a: 1 } })
  const f: FinishInputs = {
    introAssetId: "i1", outroAssetId: "o1", musicAssetId: "m1",
    musicVolumePct: 20, musicLoop: true, voiceoverUrl: "https://x/a.mp3",
  }
  ok("identical finish → identical key", computeArtifactKey(fk, f) === computeArtifactKey(fk, { ...f }))
  ok("a NEW BRAND INTRO changes the artifact (the whole point of the second key)",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, introAssetId: "i2" }))
  ok("a different outro changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, outroAssetId: "o2" }))
  ok("a different music track changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, musicAssetId: "m2" }))
  ok("a different music VOLUME changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, musicVolumePct: 40 }))
  ok("music loop on/off changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, musicLoop: false }))
  ok("a different frame key changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(`${fk}x`, f))
  ok("the empty finish is distinguishable from a populated one",
    computeArtifactKey(fk, NO_FINISH) !== computeArtifactKey(fk, f))
  ok("a still (no finish pass) is keyed by the same function, no special case",
    computeArtifactKey(fk, NO_FINISH).startsWith("a1_"))
  ok("NO_FINISH is entirely null so it cannot accidentally match a real finish",
    Object.values(NO_FINISH).every((v) => v === null))
}

console.log("\n═══ 5. Narration key — the precondition for a stable artifact ═══")
{
  ok("same voice + same script → same key",
    computeNarrationKey("v1", "Hello there") === computeNarrationKey("v1", "Hello there"))
  ok("surrounding whitespace does not change it",
    computeNarrationKey("v1", "  Hello there  ") === computeNarrationKey("v1", "Hello there"))
  ok("a DIFFERENT VOICE changes it (the same words in another voice is another clip)",
    computeNarrationKey("v1", "Hello") !== computeNarrationKey("v2", "Hello"))
  ok("a different script changes it",
    computeNarrationKey("v1", "Hello") !== computeNarrationKey("v1", "Goodbye"))
  ok("the key is prefixed", computeNarrationKey("v1", "Hello").startsWith("n1_"))
}

console.log("\n═══ 6. Code revision — derived, never hand-declared ═══")
{
  ok("a commit sha is used when present",
    buildRevision({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef" }) === "0123456789ab")
  ok("a deployment id is the fallback",
    buildRevision({ VERCEL_DEPLOYMENT_ID: "dpl_abcdefghijklmn" }) === "dpl_abcdefgh")
  ok("local dev shares one revision so the cache is observable while iterating",
    buildRevision({}) === "dev")
  ok("a truncated/garbage sha does not silently become the revision",
    buildRevision({ VERCEL_GIT_COMMIT_SHA: "abc" }) === "dev")
  const src = code("lib/remotion/composition-cache.ts")
  ok("the revision comes from the environment, not a database version column",
    src.includes("VERCEL_GIT_COMMIT_SHA") && !src.includes("code_revision_column"))
}

console.log("\n═══ 7. Poisoning detector — the guard against this bug returning ═══")
{
  ok("clean content props are not flagged",
    findCachePoisoningProps({ headline: "Market update", price: 750000, city: "Austin" }).length === 0)

  const epochUrl = findCachePoisoningProps({ audio: "https://x/voiceovers/b/render-probe-1753900000000.mp3" })
  ok("an epoch-suffixed URL is flagged", epochUrl.length === 1)
  ok("...as a nonce_suffix", epochUrl[0]?.reason === "nonce_suffix")
  ok("...naming the prop path", epochUrl[0]?.path === "audio")

  ok("a raw epoch-millis NUMBER is flagged",
    findCachePoisoningProps({ stamp: 1753900000000 })[0]?.reason === "epoch_millis")
  ok("an ordinary number is not flagged", findCachePoisoningProps({ beds: 4 }).length === 0)
  ok("a price is not flagged as an epoch", findCachePoisoningProps({ price: 750000 }).length === 0)
  ok("a uuid is flagged", findCachePoisoningProps({ ref: "6b1f9d3e-2a4c-4f8b-9c1d-0e5a7b3c8d21" })[0]?.reason === "uuid")
  ok("a full ISO timestamp is flagged",
    findCachePoisoningProps({ at: "2026-07-30T05:34:00.000Z" })[0]?.reason === "recent_timestamp")

  // The conservatism that keeps the detector trusted.
  ok("a PLAIN DATE is content, not a nonce — never flagged",
    findCachePoisoningProps({ weekOf: "2026-07-27" }).length === 0)
  ok("a year is not flagged", findCachePoisoningProps({ builtIn: "1998" }).length === 0)
  ok("a phone number is not flagged", findCachePoisoningProps({ phone: "512-555-0134" }).length === 0)

  ok("voiceover_url's nonce is NOT flagged (it is a finish input, already excluded)",
    findCachePoisoningProps({ voiceover_url: "https://x/a-1753900000000.mp3" }).length === 0)
  ok("music_mood is not walked either",
    findCachePoisoningProps({ music_mood: "6b1f9d3e-2a4c-4f8b-9c1d-0e5a7b3c8d21" }).length === 0)

  const nested = findCachePoisoningProps({ brand: { logo: "https://x/l-1753900000000.png" } })
  ok("nested props are walked", nested.length === 1)
  ok("...with a dotted path", nested[0]?.path === "brand.logo")
  const inArray = findCachePoisoningProps({ slides: [{ url: "https://x/s-1753900000000.png" }] })
  ok("array members are walked with an index in the path", inArray[0]?.path === "slides.0.url")
  ok("findings are capped so one pathological payload cannot flood a signal",
    findCachePoisoningProps({ xs: Array.from({ length: 60 }, () => "a-1753900000000") }).length <= 25)
  ok("a null props payload is safe", findCachePoisoningProps(null).length === 0)
  ok("leakBrief names the composition", leakBrief("CMAReel", nested).includes("CMAReel"))
  ok("leakBrief names the prop path so the fix is actionable", leakBrief("CMAReel", nested).includes("brand.logo"))
}

console.log("\n═══ 8. Economics — honest on an OS with no data yet ═══")
{
  const empty = summarizeCacheEconomics([])
  ok("zero renders → 0% hit rate, never NaN", empty.hitRatePct === 0 && !Number.isNaN(empty.hitRatePct))
  ok("zero renders → nothing claimed as saved", empty.usdAvoided === 0 && empty.secondsAvoided === 0)

  const e = summarizeCacheEconomics([
    { cacheHit: false, estimatedUsd: 0.5, outputSeconds: 16 },
    { cacheHit: true, estimatedUsd: 0.5, outputSeconds: 16 },
    { cacheHit: true, estimatedUsd: 0.5, outputSeconds: 16 },
  ], 7)
  ok("hits are counted", e.hits === 2)
  ok("hit rate is computed over all renders", e.hitRatePct === 66.7)
  ok("only HITS count as avoided cost", e.usdAvoided === 1)
  ok("only hits count as avoided seconds", e.secondsAvoided === 32)
  ok("narration reuse is reported separately from render hits", e.narrationReuses === 7)
}

console.log("\n═══ 9. Ownership + the bus ═══")
{
  ok("narration_cache has an owning manager", TABLE_MANAGER.narration_cache === "asset_manager")
  ok("the render ledger is still Asset Manager's", TABLE_MANAGER.remotion_composition_renders === "asset_manager")
  ok("the composition registry is still Asset Manager's", TABLE_MANAGER.remotion_compositions === "asset_manager")
  ok("the domain has a declared owner + proof", MAINTENANCE_DOMAINS.render_determinism?.manager === "asset_manager")
  ok("...and names its runnable proof", MAINTENANCE_DOMAINS.render_determinism?.proof === "test:render-cache")

  const spec = SIGNAL_REGISTRY[RENDER_CACHE_LEAK_SIGNAL]
  ok("the leak signal is catalogued", !!spec)
  ok("it is feed-only (the fix is a code change, not an inbox action)", spec?.disposition === "feed_only")
  ok("it renders as an alert", spec?.kind === "alert")

  const sweep = code("lib/remotion/render-cache.ts")
  ok("the sweep routes to the manager that owns the render pipeline", sweep.includes('toManager: "asset_manager"'))
  ok("it is carried by a DIFFERENT manager (a signal never self-routes)", sweep.includes('fromManager: "cron_manager"'))
  ok("a composition NAME travels in the payload, not in the uuid entity_id column",
    sweep.includes("entityId: null") && sweep.includes("composition_id: r.composition_id"))
  ok("publish failures are counted, not discarded", sweep.includes("out.failed++"))
  ok("the sweep dedupes on a recency window so a standing leak does not spam",
    sweep.includes("signal_type") && sweep.includes("cutoff"))
}

console.log("\n═══ 10. Tenancy ═══")
{
  const src = code("lib/remotion/render-cache.ts")
  ok("the artifact lookup is scoped by brokerage", src.includes('.eq("brokerage_id", brokerageId)'))
  ok("only SUCCEEDED renders are served from", src.includes('.eq("render_status", "succeeded")'))
  ok("a row with no output_url is never served", src.includes('.not("output_url", "is", null)'))
  const vo = code("lib/video/reel-voiceover.ts")
  ok("the narration lookup is scoped by brokerage", vo.includes('.eq("brokerage_id", brokerageId)'))
  ok("...and by voice, so one tenant's clone is never used for another's script",
    vo.includes('.eq("voice_id", voiceId)'))
}

console.log("\n═══ 11. The narration clock is gone ═══")
{
  const vo = code("lib/video/reel-voiceover.ts")
  ok("the mp3 path no longer carries a millisecond stamp", !vo.includes("Date.now()}.mp3"))
  ok("the path is derived from the script hash", vo.includes("${scriptHash}.mp3"))
  ok("the cache is consulted BEFORE synthesis",
    vo.indexOf("loadCachedNarration") < vo.indexOf("synthesizeSpeechWithTimestamps"))
  ok("a reuse is reported to the caller, not hidden", vo.includes("reused: true"))
  ok("the script is capped BEFORE hashing so two scripts differing past the cap share a clip",
    vo.indexOf("MAX_SCRIPT_CHARS)") < vo.indexOf("computeNarrationKey(p.voiceId, script)"))
  ok("the cache row upserts on the unique key (two producers can race)",
    vo.includes('onConflict: "brokerage_id,voice_id,script_hash"'))
  ok("alignment is cached too, so a reused clip still gets word-accurate captions",
    vo.includes("alignment"))
}

console.log("\n═══ 12. The tier gate now runs where it can refuse ═══")
{
  const route = code("app/api/internal/remotion/render-composition/route.ts")
  ok("the live render path calls canAccessComposition", route.includes("canAccessComposition(callerTier, composition)"))
  ok("a refused render is CANCELLED, not failed", route.includes('status: "cancelled"'))
  ok("the reason names the tier that was refused", route.includes("composition_not_reachable_at_tier"))

  const coord = code("lib/remotion/render-coordinator.ts")
  ok("the dead beginCoordinatedRender entry point is gone", !coord.includes("export async function beginCoordinatedRender"))
  ok("the coordinator no longer holds a second way to queue a render", !coord.includes("recordRenderQueued("))

  const lib = code("app/actions/composition-library.ts")
  ok("the library imports the ONE tier ladder", lib.includes("canAccessComposition(brokerageTier, c)"))
  ok("...and no longer re-implements TIER_RANK", !lib.includes("const TIER_RANK"))
}

console.log("\n═══ 13. One stock picker, so the key cannot disagree with the video ═══")
{
  const coord = code("lib/remotion/render-coordinator.ts")
  const pick = code("lib/remotion/stock-pick.ts")
  const cache = code("lib/remotion/render-cache.ts")
  ok("the coordinator imports the shared picker", coord.includes('from "./stock-pick"'))
  ok("the coordinator no longer defines its own", !coord.includes("async function pickStockAsset"))
  ok("the cache uses the SAME picker", cache.includes('from "./stock-pick"'))
  ok("the picker still walks the agent → team → brokerage cascade", pick.includes("resolveStockScopeOrder"))
  ok("the mood preference is still honoured before the fallback", pick.includes("moodPref"))
}

console.log("\n═══ 14. Look up on the prediction, stamp on the reality ═══")
{
  const coord = code("lib/remotion/render-coordinator.ts")
  ok("finalize accepts the frame key so it can stamp the true artifact key",
    coord.includes("frameKey?:  string | null"))
  ok("the artifact key persisted is computed inside finalize", coord.includes("computeArtifactKey(frameKey, finish)"))
  ok("music volume is recorded only when the mix actually applied",
    coord.includes("musicVolumePct = musicRow.music_volume_pct"))
  ok("the narration url is recorded only when the mux actually applied",
    coord.includes("voiceoverUrl = voUrl"))
  ok("a caller that does not participate leaves the key NULL rather than guessing",
    coord.includes("frameKey ? computeArtifactKey(frameKey, finish) : null"))

  const route = code("app/api/internal/remotion/render-composition/route.ts")
  ok("the route probes the cache before bundling",
    route.indexOf("probeRenderCache") < route.indexOf("getBundle(entryPoint)"))
  ok("the route passes the frame key into finalize",
    route.includes("finalizeCoordinatedRender(intent, row.id, buffer, probe.frameKey)"))
}

console.log("\n═══ 15. A cache hit is a real delivery, and a refused serve renders ═══")
{
  const route = code("app/api/internal/remotion/render-composition/route.ts")
  ok("a cache hit still runs the post-render coordination loop",
    route.includes("runPostRenderCoordination(svc, row, served.outputUrl!"))
  ok("a normal render runs the SAME loop (one implementation)",
    route.includes("runPostRenderCoordination(svc, row, result.outputUrl ?? null, thumbnailUrl)"))
  ok("the coordination helper still flips the linked video project to completed",
    route.includes('status: "completed"') && route.includes("ai_video_projects"))
  ok("...and still publishes the video coordination signals",
    route.includes("publishVideoCoordinationSignals"))
  ok("a refused cache-serve write falls through to rendering",
    route.includes("cache serve refused; rendering instead"))
  ok("the response says whether it was a hit, so nobody has to guess",
    route.includes("cache_hit: true") && route.includes("cache_hit: false"))

  const cache = code("lib/remotion/render-cache.ts")
  ok("serveFromCache surfaces a rejected write instead of returning ok",
    cache.includes("if (error) return { ok: false, reason: error.message }"))
  ok("a hit points at the ORIGIN render, never at another hit (no provenance chain)",
    cache.includes("row.served_from_render_id ?? row.id"))
  ok("the cache does not re-capture into marketing_assets (one file, one library card)",
    !cache.includes("captureRenderAsMarketingAsset"))
  // A prediction failure must degrade to a MISS (an unnecessary render), never
  // to a wrong artifact — so predictFinishInputs swallows and returns whatever
  // it resolved, which then simply fails to match any stamped key.
  const predictBody = cache.slice(
    cache.indexOf("export async function predictFinishInputs"),
    cache.indexOf("export interface CacheProbe"),
  )
  ok("predictFinishInputs cannot throw", predictBody.includes("} catch {"))
  ok("...and returns the finish it resolved, so a failure is a miss not a lie",
    predictBody.trimEnd().endsWith("return finish\n}") || predictBody.includes("\n  return finish\n}"))
}

console.log("\n═══ 16. The sweep is wired to a cron that actually runs ═══")
{
  const cron = code("app/api/cron/composition-render-queue/route.ts")
  ok("the video-ops cron runs the determinism sweep", cron.includes("sweepDeterminismLeaks"))
  ok("it reports the sweep even when the queue is empty",
    (cron.match(/leak_sweep/g) ?? []).length >= 2)
}

console.log(`\n${"═".repeat(70)}`)
console.log(`RENDER CACHE — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("Video is a cacheable asset: identity is derived, the tier gate refuses, and a")
console.log("composition that can never reuse a render tells the Asset Manager which prop to fix.")
