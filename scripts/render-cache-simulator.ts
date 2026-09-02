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
  hashSourceFiles,
  leakBrief,
  NO_FINISH,
  FINISH_PROP_KEYS,
  RENDER_CACHE_LEAK_SIGNAL,
  type FinishInputs,
} from "../lib/remotion/composition-cache"
import {
  resolveCodeRevision, __resetCodeRevisionMemo,
  composeCodeRevision, readInstalledPackageVersions, REVISION_PACKAGES,
} from "../lib/remotion/code-revision"
import { createRequire } from "node:module"
import { join } from "node:path"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { TABLE_MANAGER, MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { stripComments } from "./strip-comments"

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
  return stripComments(readFileSync(path, "utf8"))
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
    computeArtifactKey(computeFrameKey(base), { ...NO_FINISH, narrationAudioUrl: "https://x/y.mp3" })
      !== computeArtifactKey(computeFrameKey(base), { ...NO_FINISH, narrationAudioUrl: "https://x/z.mp3" }))
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
    introClipUrl: "https://cdn/intro-a.mp4", outroClipUrl: "https://cdn/outro-a.mp4",
    musicTrackUrl: "https://cdn/bed-a.mp3",
    musicVolumePct: 20, musicLoop: true, narrationAudioUrl: "https://x/a.mp3",
  }
  ok("identical finish → identical key", computeArtifactKey(fk, f) === computeArtifactKey(fk, { ...f }))
  ok("a NEW BRAND INTRO changes the artifact (the whole point of the second key)",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, introClipUrl: "https://cdn/intro-b.mp4" }))
  ok("a different outro changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, outroClipUrl: "https://cdn/outro-b.mp4" }))
  ok("a different music track changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, musicTrackUrl: "https://cdn/bed-b.mp3" }))
  ok("a different music VOLUME changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, musicVolumePct: 40 }))
  ok("music loop on/off changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(fk, { ...f, musicLoop: false }))
  ok("a different frame key changes it",
    computeArtifactKey(fk, f) !== computeArtifactKey(`${fk}x`, f))
  ok("the empty finish is distinguishable from a populated one",
    computeArtifactKey(fk, NO_FINISH) !== computeArtifactKey(fk, f))
  ok("a still (no finish pass) is keyed by the same function, no special case",
    computeArtifactKey(fk, NO_FINISH).startsWith("a2_"))
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

console.log("\n═══ 6. Code revision — derived from the SOURCE, and able to say I don't know ═══")
{
  // Keyed on the composition source itself, not on VERCEL_GIT_COMMIT_SHA. The
  // sha was a proxy that (a) nothing in this repo guarantees is set — absent, it
  // silently collapsed to a constant and a composition edit would have served
  // stale frames forever — and (b) changes on every deploy, discarding the cache
  // for edits that touched no composition.
  const a = [{ path: "MarketUpdateReel.tsx", content: "export const A = 1" }]
  const b = [{ path: "MarketUpdateReel.tsx", content: "export const A = 2" }]
  ok("identical source → identical revision", hashSourceFiles(a) === hashSourceFiles([...a]))
  ok("an EDITED composition changes the revision", hashSourceFiles(a) !== hashSourceFiles(b))
  ok("file order in the walk does not matter", (() => {
    const one = [{ path: "a.tsx", content: "x" }, { path: "b.tsx", content: "y" }]
    const two = [{ path: "b.tsx", content: "y" }, { path: "a.tsx", content: "x" }]
    return hashSourceFiles(one) === hashSourceFiles(two)
  })())
  ok("RENAMING a composition changes the revision (Remotion resolves by id)",
    hashSourceFiles([{ path: "Old.tsx", content: "x" }])
      !== hashSourceFiles([{ path: "New.tsx", content: "x" }]))
  ok("an added file changes the revision",
    hashSourceFiles(a) !== hashSourceFiles([...a, { path: "New.tsx", content: "z" }]))

  __resetCodeRevisionMemo()
  const live = resolveCodeRevision()
  ok("the real remotion/ tree resolves to a revision", typeof live === "string" && live!.length > 0)
  ok("...derived from source, not from a deploy id", live!.startsWith("src_"))
  ok("...and it is memoized (source cannot change under a running server)",
    resolveCodeRevision() === live)

  // ── THE RENDERER IS PART OF THE REVISION (2026-09-02) ───────────────────
  // The 4.0.473 → 4.0.520 bump changed no file under remotion/ and no env var,
  // so every 4.0.473-era artifact stayed a cache HIT under 4.0.520. The rule,
  // asserted rather than the number: same source + different package version
  // ⇒ different revision; same source + same version ⇒ same revision. The
  // versions below are NOT the installed ones — they are two arbitrary
  // strings, because the rule must hold for any pair, not for today's pair.
  const V = (v: string) => Object.fromEntries(REVISION_PACKAGES.map((p) => [p, v])) as Record<(typeof REVISION_PACKAGES)[number], string>
  ok("POSITIVE CONTROL: same source + DIFFERENT package version ⇒ DIFFERENT revision",
    composeCodeRevision("h", V("1.0.0")) !== composeCodeRevision("h", V("1.0.1")))
  ok("...same source + SAME package version ⇒ SAME revision (a bump that did not\n    happen must not flush the cache)",
    composeCodeRevision("h", V("1.0.0")) === composeCodeRevision("h", V("1.0.0")))
  ok("...and a bump to ANY ONE of the three packages moves it — a half-applied\n    bump cannot collapse onto the fully-applied one",
    REVISION_PACKAGES.every((p) =>
      composeCodeRevision("h", V("1.0.0")) !== composeCodeRevision("h", { ...V("1.0.0"), [p]: "1.0.1" })))
  ok("...and a different source with the same version still moves it (the old half\n    of the rule survives)",
    composeCodeRevision("h1", V("1.0.0")) !== composeCodeRevision("h2", V("1.0.0")))
  ok("...and a divergent trio is not spelled as if it agreed",
    composeCodeRevision("h", { ...V("1.0.0"), remotion: "1.0.1" }) !== composeCodeRevision("h", V("1.0.1")))

  // The LIVE revision carries the INSTALLED version — read here through the
  // same createRequire path a runtime uses, never typed in (§2: the number is
  // derived; a literal would be true today and a lie after the next bump).
  const req = createRequire(join(process.cwd(), "package.json"))
  const installed = Object.fromEntries(REVISION_PACKAGES.map((p) => [p, (req(`${p}/package.json`) as { version: string }).version]))
  const versionsSeen = new Set(Object.values(installed))
  ok(`the installed trio was read from node_modules (${REVISION_PACKAGES.map((p) => `${p}@${installed[p]}`).join(", ")})`,
    versionsSeen.size >= 1 && [...versionsSeen].every((v) => /^\d+\.\d+\.\d+/.test(v)))
  ok("readInstalledPackageVersions agrees with that direct read, package for package",
    JSON.stringify(readInstalledPackageVersions(process.cwd())) === JSON.stringify(installed))
  ok(`the LIVE revision embeds the installed renderer version — a 4.0.473-era\n    artifact can no longer be a hit under a later renderer (live=${live})`,
    [...versionsSeen].every((v) => live!.includes(v)) && live!.includes("_rm"))
  ok("...and it is the composed shape, not a coincidence: recomposing the live\n    source hash with the live versions reproduces it",
    (() => {
      const m = live!.match(/^src_([0-9a-f]+)_rm/)
      return !!m && composeCodeRevision(m[1], installed as Record<(typeof REVISION_PACKAGES)[number], string>) === live
    })())

  // THE ENV FALLBACK, intact: a readable tree whose PACKAGES cannot be read must
  // fall to the deploy proxy — and to null with no proxy — never to a
  // source-only key, which is the exact version-blind key this pass retires.
  const savedSha = process.env.VERCEL_GIT_COMMIT_SHA, savedDep = process.env.VERCEL_DEPLOYMENT_ID
  delete process.env.VERCEL_GIT_COMMIT_SHA; delete process.env.VERCEL_DEPLOYMENT_ID
  __resetCodeRevisionMemo()
  ok("packages unreadable + no deploy env ⇒ NULL (cache disabled), not a\n    version-blind src_ key",
    resolveCodeRevision(process.cwd(), { readVersions: () => null }) === null)
  process.env.VERCEL_GIT_COMMIT_SHA = "0123456789abcdef"
  __resetCodeRevisionMemo()
  ok("packages unreadable + deploy sha ⇒ the sha proxy (moves on every deploy, so a\n    bump commit still flushes)",
    resolveCodeRevision(process.cwd(), { readVersions: () => null }) === "sha_0123456789ab")
  if (savedSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA; else process.env.VERCEL_GIT_COMMIT_SHA = savedSha
  if (savedDep === undefined) delete process.env.VERCEL_DEPLOYMENT_ID; else process.env.VERCEL_DEPLOYMENT_ID = savedDep
  ok("readInstalledPackageVersions on a root with no node_modules is null, not a\n    partial map", readInstalledPackageVersions("/nonexistent-root-for-this-proof") === null)

  __resetCodeRevisionMemo()
  ok("a tree with NO composition source yields null — unknown, not a constant",
    resolveCodeRevision("/nonexistent-root-for-this-proof") === null
      || resolveCodeRevision("/nonexistent-root-for-this-proof")!.startsWith("sha_")
      || resolveCodeRevision("/nonexistent-root-for-this-proof")!.startsWith("dep_"))
  __resetCodeRevisionMemo()

  const revSrcCode = code("lib/remotion/code-revision.ts")
  ok("the versions are READ from each package.json at runtime: no version literal\n    is hardcoded in code-revision.ts code (a literal would be a waypoint pin)",
    /\/package\.json`\)/.test(revSrcCode) && !/["'`]\d+\.\d+\.\d+["'`]/.test(revSrcCode))
  ok("...and that finder would see a literal (control)", /["'`]\d+\.\d+\.\d+["'`]/.test(`const v = "4.0.520"`))

  const cacheSrc = code("lib/remotion/render-cache.ts")
  ok("a null revision DISABLES the cache rather than keying on a constant",
    cacheSrc.includes("if (!codeRevision)") && cacheSrc.includes("cacheable: false"))
  const routeSrc = code("app/api/internal/remotion/render-composition/route.ts")
  ok("an uncacheable render is never stamped with a key", routeSrc.includes("if (probe.cacheable)"))
  ok("...and never asks finalize to stamp one either",
    routeSrc.includes("probe.cacheable ? probe.frameKey : null"))
  const revSrc = code("lib/remotion/code-revision.ts")
  ok("the env proxy is only a FALLBACK, never the primary",
    revSrc.indexOf("fromSource(root)") < revSrc.indexOf("fromEnv()"))
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
    coord.includes("narrationAudioUrl = voUrl"))
  ok("the intro/outro CLIP URLS are the key, not the row ids — a delete+re-upload of\n    the same file keeps its cached artifact instead of missing forever",
    coord.includes("introClipUrl = introRow?.video_url") &&
    coord.includes("musicTrackUrl = musicRow.video_url"))
  ok("a caller that does not participate leaves the key NULL rather than guessing",
    coord.includes("frameKey ? computeArtifactKey(frameKey, finish) : null"))

  const route = code("app/api/internal/remotion/render-composition/route.ts")
  ok("the route probes the cache before bundling",
    route.indexOf("probeRenderCache") < route.indexOf("getBundle(entryPoint)"))
  ok("the route passes the frame key into finalize",
    route.includes("finalizeCoordinatedRender(") && route.includes("probe.cacheable ? probe.frameKey : null"))
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
