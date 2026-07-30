/**
 * scripts/living-video-simulator.ts
 *
 * test:living-video — the proof for SELF-UPDATING VIDEO (m312).
 *
 * The thing being proven is a judgment, not just a hash: a video should remake
 * itself when a seller would care, and stay put when they would not. Most of
 * these assertions are about the SECOND half — the changes that must NOT trigger
 * anything — because a staleness detector that fires too often is worse than
 * none at all. It re-renders, re-proposes, and trains an agent to ignore it.
 */
import { readFileSync } from "node:fs"
import {
  LIVING_KINDS,
  livingKind,
  computeFactsKey,
  diffLivingFacts,
  isStale,
  describeFactChanges,
  summarizeRefresh,
  LIVING_VIDEO_STALE_SIGNAL,
  type LivingFacts,
} from "../lib/video/living-video"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
}

const KIND = "seller_weekly_update"

/** A seller update as delivered on Monday. */
const monday: LivingFacts = {
  listingAddress: "812 Rosewood Ln",
  listPrice: 545000,
  showingsThisWeek: 2,
  interestLabel: "moderate",
  daysOnMarket: 21,
  videoScans: 40,
  avatarId: "did_actor_abc123",
}

console.log("\n═══ 1. The facts key ═══")
{
  ok("identical facts → identical key",
    computeFactsKey(KIND, monday) === computeFactsKey(KIND, { ...monday }))
  ok("field ORDER does not change the key", (() => {
    const reordered: LivingFacts = {
      avatarId: monday.avatarId, videoScans: monday.videoScans, daysOnMarket: monday.daysOnMarket,
      interestLabel: monday.interestLabel, showingsThisWeek: monday.showingsThisWeek,
      listPrice: monday.listPrice, listingAddress: monday.listingAddress,
    }
    return computeFactsKey(KIND, reordered) === computeFactsKey(KIND, monday)
  })())
  ok("a price change changes the key",
    computeFactsKey(KIND, monday) !== computeFactsKey(KIND, { ...monday, listPrice: 529000 }))
  ok("an UNDECLARED field is ignored — a provider that starts returning an extra\n    value must not invalidate every existing video by accident",
    computeFactsKey(KIND, monday) === computeFactsKey(KIND, { ...monday, somethingNew: "x" } as LivingFacts))
  ok("a missing field reads as null rather than throwing",
    typeof computeFactsKey(KIND, { listPrice: 1 }) === "string")
  ok("the key is prefixed so a scheme change is recognizable",
    computeFactsKey(KIND, monday).startsWith("fx1_"))
}

console.log("\n═══ 2. MATERIAL changes — the seller would want the new video ═══")
{
  const priceCut = diffLivingFacts(KIND, monday, { ...monday, listPrice: 529000 })
  ok("a price cut is detected", priceCut.length === 1)
  ok("...and is material", isStale(priceCut))
  ok("...and the sentence names the old and new number",
    describeFactChanges(KIND, priceCut).includes("545000") &&
    describeFactChanges(KIND, priceCut).includes("529000"))

  ok("a new showing is material (0→1 is the difference between anxious and reassured)",
    isStale(diffLivingFacts(KIND, { ...monday, showingsThisWeek: 0 }, { ...monday, showingsThisWeek: 1 })))
  ok("buyer interest moving is material",
    isStale(diffLivingFacts(KIND, monday, { ...monday, interestLabel: "strong" })))
  ok("the listing address changing is material (the video is about the wrong home)",
    isStale(diffLivingFacts(KIND, monday, { ...monday, listingAddress: "9 Other St" })))

  // The owner's point: the agent records an avatar at onboarding into our bucket.
  // Re-recording it leaves every delivered video fronted by the old face.
  const newAvatar = diffLivingFacts(KIND, monday, { ...monday, avatarId: "did_actor_zzz999" })
  ok("RE-RECORDING THE AVATAR is material — a delivered video still shows the old face",
    isStale(newAvatar))
  ok("...and the sentence does not dump a meaningless id at a human",
    describeFactChanges(KIND, newAvatar).includes("avatar"))
}

console.log("\n═══ 3. IMMATERIAL changes — the half that keeps this usable ═══")
{
  // The trap: days on market increments EVERY DAY. Material-by-default here
  // would re-render and re-propose this video daily, forever, about nothing.
  const oneDayLater = diffLivingFacts(KIND, monday, { ...monday, daysOnMarket: 22 })
  ok("a day passing is DETECTED (so the diff is honest)", oneDayLater.length === 1)
  ok("...but is NOT material — this is what stops a daily re-render about nothing",
    !isStale(oneDayLater))

  const oneScan = diffLivingFacts(KIND, monday, { ...monday, videoScans: 41 })
  ok("one more QR scan is detected", oneScan.length === 1)
  ok("...but a counter ticking is not news", !isStale(oneScan))

  const bigScanJump = diffLivingFacts(KIND, monday, { ...monday, videoScans: 70 })
  ok("a jump of 25+ scans IS material — the marketing genuinely broke through",
    isStale(bigScanJump))
  ok("just under the threshold is still not material",
    !isStale(diffLivingFacts(KIND, monday, { ...monday, videoScans: 64 })))

  ok("a day AND a scan together are still not a reason to remake the video",
    !isStale(diffLivingFacts(KIND, monday, { ...monday, daysOnMarket: 22, videoScans: 41 })))
  ok("but a day, a scan AND a price cut is",
    isStale(diffLivingFacts(KIND, monday, { ...monday, daysOnMarket: 22, videoScans: 41, listPrice: 529000 })))

  ok("no change at all → no diff", diffLivingFacts(KIND, monday, { ...monday }).length === 0)
  ok("...and nothing to say", describeFactChanges(KIND, []).includes("Nothing material"))
  ok("an immaterial-only change says nothing material either",
    describeFactChanges(KIND, oneDayLater).includes("Nothing material"))
}

console.log("\n═══ 4. Every declared fact justifies its own rule ═══")
{
  const spec = livingKind(KIND)!
  ok("the kind is registered", !!spec)
  ok("it names the composition it renders through", spec.compositionId === "AgentTalkingHeadReel")
  for (const [field, f] of Object.entries(spec.facts)) {
    ok(`"${field}" explains WHY its materiality is what it is`, f.why.length > 30)
  }
  ok("every fact has a human label (a manager reads these, not field names)",
    Object.values(spec.facts).every((f) => f.label.length > 0 && f.label !== f.label.toUpperCase()))
  ok("at least one fact is material — a living kind with none can never update",
    Object.values(spec.facts).some((f) => f.materiality === "always" || typeof f.materiality === "object"))
  ok("every registered kind has a provider in the sweep", (() => {
    const sweep = code("lib/video/living-video-sweep.ts")
    return Object.keys(LIVING_KINDS).every((k) => sweep.includes(`${k}:`))
  })())
}

console.log("\n═══ 5. The summary is honest about what it did ═══")
{
  const s = summarizeRefresh([
    { changes: diffLivingFacts(KIND, monday, { ...monday, listPrice: 529000 }), requeued: true },
    { changes: diffLivingFacts(KIND, monday, { ...monday, listPrice: 500000 }), requeued: false },
    { changes: diffLivingFacts(KIND, monday, { ...monday, daysOnMarket: 22 }), requeued: null },
    { changes: [], requeued: null },
  ])
  ok("examined counts everything looked at", s.examined === 4)
  ok("stale counts only material change", s.stale === 2)
  ok("refreshed counts only what actually requeued", s.refreshed === 1)
  ok("a FAILED requeue is counted, not swallowed — the client still has the old video",
    s.failed === 1)
  ok("immaterial change is reported separately, never as staleness", s.immaterialOnly === 1)
  ok("an empty sweep is all zeros, never NaN", (() => {
    const e = summarizeRefresh([])
    return e.examined === 0 && e.stale === 0 && e.refreshed === 0
  })())
}

console.log("\n═══ 6. The loop, and the line it will not cross ═══")
{
  const sweep = code("lib/video/living-video-sweep.ts")
  ok("the signal is catalogued", !!SIGNAL_REGISTRY[LIVING_VIDEO_STALE_SIGNAL])
  ok("it is feed-only — a human decides what to do about a stale video",
    SIGNAL_REGISTRY[LIVING_VIDEO_STALE_SIGNAL]?.disposition === "feed_only")
  ok("it renders as an alert", SIGNAL_REGISTRY[LIVING_VIDEO_STALE_SIGNAL]?.kind === "alert")
  ok("it reaches the manager that owns the render ledger",
    sweep.includes('manager: "asset_manager"'))
  ok("carried by a DIFFERENT manager (a signal never routes to itself)",
    sweep.includes('"data_steward" : "cron_manager"'))

  // THE LINE. A system that judged a video stale AND mailed the replacement is
  // one bad fact provider away from spamming a client.
  ok("the sweep NEVER sends — no dispatcher is reachable from it",
    !sweep.includes("dispatchEmail") && !sweep.includes("dispatchSms") &&
    !sweep.includes("proposeClientMessage") && !sweep.includes("sendPersonalEmail"))
  ok("it only stages a render through the producer's own path",
    sweep.includes("requestSellerUpdateReel"))
  ok("a failed requeue is reported IN the message, so nobody reads 'stale' as 'fixed'",
    sweep.includes("could NOT be staged"))
  ok("the composition/kind name travels in the payload, not the uuid entity_id column",
    sweep.includes("living_kind: kind"))
  ok("the sweep cannot throw into the cron that also drains the render queue",
    sweep.includes("} catch (e) {") && sweep.includes("ok: false"))
  ok("a vanished subject stops being checked rather than re-rendering",
    sweep.includes("if (!fresh) continue"))
  ok("only the NEWEST cut per entity is checked", sweep.includes("newest.has(k)"))
}

console.log("\n═══ 7. The seven-day window that used to swallow a price drop ═══")
{
  const producer = code("lib/agents/seller-update-reel-producer.ts")
  ok("the weekly idempotency is still there for the CADENCE cron",
    producer.includes('already && !opts.force'))
  ok("...and the refresh can override it, so a seller is not made to wait for a true video",
    producer.includes("force?: boolean"))
  ok("the producer exposes a READ-ONLY fact projection", producer.includes("export async function sellerUpdateFacts"))
  ok("the facts include the avatar the agent recorded at onboarding",
    producer.includes("resolveSelfAvatar"))
  ok("the queued render is stamped with its living identity",
    producer.includes("livingKind:") && producer.includes("factsKey:"))
  ok("a refresh records which video it replaces",
    producer.includes("refreshedFromRenderId"))

  const registry = code("lib/remotion/registry.ts")
  ok("recordRenderQueued persists the living identity for ANY future kind",
    registry.includes("living_kind:") && registry.includes("facts_key:") && registry.includes("facts:"))
}

console.log("\n═══ 8. Wiring + ownership ═══")
{
  const cron = code("app/api/cron/composition-render-queue/route.ts")
  ok("the video-ops cron runs the refresh", cron.includes("refreshLivingVideos"))
  ok("it reports the result even when the render queue is empty",
    (cron.match(/living_refresh/g) ?? []).length >= 2)
  ok("the refresh runs BEFORE the drain, so a staged replacement is picked up next tick",
    cron.indexOf("refreshLivingVideos") < cron.indexOf('.eq("render_status", "queued")'))
  ok("the domain has a declared owner", MAINTENANCE_DOMAINS.living_video?.manager === "asset_manager")
  ok("...and names its runnable proof", MAINTENANCE_DOMAINS.living_video?.proof === "test:living-video")
}

console.log(`\n${"═".repeat(70)}`)
console.log(`LIVING VIDEO — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
console.log("A video that asserts moving facts now knows when it has started lying,")
console.log("says which number moved, and remakes itself — without mailing anybody.")
