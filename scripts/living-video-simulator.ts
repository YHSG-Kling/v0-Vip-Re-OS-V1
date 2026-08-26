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
import { paddingSecondsFor } from "../lib/remotion/voiceover-mixer"
import { compositionSeconds } from "../lib/remotion/composition-geometry"
import { isUnavailableStatus, normalizeVendorStatus } from "../lib/property/resolve-property-facts"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"))
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

console.log("\n═══ 8. THE DELIVERY HALF — where the refresh nearly died ═══")
{
  const producer = code("lib/agents/seller-update-reel-producer.ts")
  // The refresh re-renders; THIS is where that work reaches the seller or is
  // thrown away. It was being thrown away: delivery kept its own seven-day
  // window, so the corrected video was skipped until the following Monday —
  // the same defect one stage downstream, burning a real render every time.
  ok("delivery de-duplicates per VIDEO, not per calendar week",
    producer.includes('.ilike("body", `%${r.output_url}%`)'))
  ok("a REFRESH is exempt from the weekly cadence guard",
    producer.includes("if (!r.refreshed_from_render_id) {"))
  ok("...but an ordinary cadence render is still guarded, so nothing spams",
    producer.includes("recentProposal"))
  ok("the NEWEST cut per (listing, seller) is the one proposed — never a superseded one",
    producer.includes("const seen = new Set<string>()") &&
    producer.includes('.order("completed_at", { ascending: false })'))
  ok("the render read is bounded", producer.includes(".limit(500)"))
  ok("the human sees WHY this cut arrived off-cadence",
    producer.includes("REFRESHED seller-update video"))
  ok("it still proposes rather than sends — the gate is unchanged",
    producer.includes("proposeClientMessage"))
}

console.log("\n═══ 9. Narration is never cut off mid-sentence ═══")
{
  // Every composition has a FIXED duration_frames and none uses Remotion's
  // calculateMetadata to size itself to its audio, while the script is capped at
  // 2400 chars — minutes of speech. The mux used -shortest, so the agent was
  // silently truncated in a video that went to a client.
  ok("no padding when the video is already long enough",
    paddingSecondsFor(10, 14) === 0)
  ok("no padding for a sub-quarter-second encode boundary",
    paddingSecondsFor(14.1, 14) === 0)
  ok("a genuine overrun IS padded", paddingSecondsFor(22, 14) === 8)
  ok("an unknown narration length pads nothing rather than guessing",
    paddingSecondsFor(null, 14) === 0)
  ok("an unknown video length pads nothing either", paddingSecondsFor(22, null) === 0)
  ok("a nonsense duration cannot produce an hour of frozen frame",
    paddingSecondsFor(99999, 14) === 120)
  ok("NaN is refused", paddingSecondsFor(NaN, 14) === 0)
  ok("a zero-length narration is refused", paddingSecondsFor(0, 14) === 0)

  const mixer = code("lib/remotion/voiceover-mixer.ts")
  ok("the padded path holds the FINAL FRAME rather than cutting the voice",
    mixer.includes("tpad=stop_mode=clone"))
  ok("...and follows the LONGEST stream so the held frame survives",
    mixer.includes('pad > 0 ? "longest" : "first"'))
  ok("...and drops -shortest, which is what did the truncating",
    mixer.includes('...(pad > 0 ? [] : ["-shortest"])'))
  ok("the unpadded path still stream-copies the video (no needless re-encode)",
    mixer.includes('["-c:v", "copy"]'))
  ok("BOTH ffmpeg attempts pad — the silent-video fallback is not forgotten",
    (mixer.match(/tpad=stop_mode=clone/g) ?? []).length >= 2)

  const vo = code("lib/video/reel-voiceover.ts")
  ok("the length comes free from the alignment already cached for captions",
    vo.includes("character_end_times_seconds"))
  ok("...is persisted so the coordinator can read it back",
    vo.includes("duration_seconds: p.durationSeconds"))
  ok("...and a reused clip reports it too", vo.includes("cached.durationSeconds"))

  const coord = code("lib/remotion/render-coordinator.ts")
  ok("the coordinator looks the narration length up by url, tenant-scoped",
    coord.includes('.eq("audio_url", voUrl)') && coord.includes('.eq("brokerage_id", intent.brokerageId)'))
  // WAS pinned to the literal expression `composition.duration_frames /
  // Math.max(1, composition.fps)`. That is a WAYPOINT, not the rule (CLAUDE.md
  // §2): the arithmetic moved into the ONE shared compositionSeconds helper
  // (lib/remotion/composition-geometry.ts) when the narration cap needed the
  // same computation at generation time, and this assertion went red while the
  // behaviour it guards was unchanged. Assert the RULE in two halves instead —
  // the comparison length is derived FROM THE COMPOSITION being rendered, and
  // that derivation really is frames/fps, the second half checked by RUNNING it
  // rather than by matching its text.
  ok("...and passes the composition's own length as the comparison",
    /const videoSeconds\s*=\s*compositionSeconds\(\s*composition\s*\)/.test(coord)
    && /videoSeconds\s*[,}]/.test(coord.slice(coord.indexOf("mixNarrationVoiceover"))))
  ok("...and that length really is duration_frames / fps (run, not matched)",
    compositionSeconds({ duration_frames: 600, fps: 30 }) === 20
    && compositionSeconds({ duration_frames: 750, fps: 30 }) === 25
    && compositionSeconds({ duration_frames: 300, fps: 60 }) === 5)
}

console.log("\n═══ 10. BUYER MATCH REEL — the second living kind ═══")
{
  const B = "buyer_match_reel"
  // A reel delivered to a buyer showing three available homes.
  const sent: LivingFacts = {
    shownCount: 3, unavailableCount: 0, unverifiableCount: 1,
    priceSignature: "545000|610000|489000",
    matchSetSignature: "aaa|bbb|ccc",
    agentName: "Dana Reyes",
  }

  ok("the kind is registered", !!livingKind(B))
  ok("it reuses the AffordabilitySnapshotReel composition, not a new one",
    livingKind(B)!.compositionId === "AffordabilitySnapshotReel")

  // THE reason this kind exists: the buyer ACTS on what the reel shows.
  const oneGone = diffLivingFacts(B, sent, { ...sent, unavailableCount: 1 })
  ok("a shown home going under contract is detected", oneGone.length === 1)
  ok("...and is material — the buyer would ask about a home that is gone",
    isStale(oneGone))
  ok("...and the sentence says so plainly",
    describeFactChanges(B, oneGone).includes("no longer available"))

  ok("a price change on a shown card is material",
    isStale(diffLivingFacts(B, sent, { ...sent, priceSignature: "529000|610000|489000" })))
  ok("a card dropping out entirely is material",
    isStale(diffLivingFacts(B, sent, { ...sent, shownCount: 2 })))
  ok("a buyer reassigned to another agent is material — the footer invites a reply\n    to someone who no longer works their file",
    isStale(diffLivingFacts(B, sent, { ...sent, agentName: "Sam Okafor" })))

  // THE GOVERNING RULE: the refresh stops a video LYING; the cadence owns NOVELTY.
  const reranked = diffLivingFacts(B, sent, { ...sent, matchSetSignature: "bbb|aaa|ddd" })
  ok("a re-ranked match set is DETECTED", reranked.length === 1)
  ok("...but is NOT material — a better match appearing is news, and news is the\n    weekly cadence's job, not the refresh's",
    !isStale(reranked))
  ok("an unverifiable external match is recorded but never acted on",
    !isStale(diffLivingFacts(B, sent, { ...sent, unverifiableCount: 2 })))
  ok("a re-rank plus an unverifiable change together still do nothing",
    !isStale(diffLivingFacts(B, sent, { ...sent, matchSetSignature: "x|y|z", unverifiableCount: 3 })))
  ok("but a re-rank alongside a home going unavailable DOES fire",
    isStale(diffLivingFacts(B, sent, { ...sent, matchSetSignature: "x|y|z", unavailableCount: 1 })))

  ok("the two kinds do not share a facts key namespace",
    computeFactsKey(B, sent) !== computeFactsKey(KIND, sent))

  // Availability truth: unknown must never be read as unavailable.
  ok("an active listing is available", !isUnavailableStatus("active"))
  ok("a coming-soon listing is still available", !isUnavailableStatus("coming_soon"))
  ok("pending is unavailable", isUnavailableStatus("pending"))
  ok("sold is unavailable", isUnavailableStatus("sold"))
  ok("withdrawn is unavailable", isUnavailableStatus("withdrawn"))
  ok("UNKNOWN (external/MLS, no status column) is NOT treated as unavailable —\n    we do not invent bad news about a listing we cannot see",
    !isUnavailableStatus(null) && !isUnavailableStatus(undefined))

  const resolver = code("lib/property/resolve-property-facts.ts")
  ok("the resolver carries availability at all", resolver.includes('statusSource: "listing"'))

  // ── BOTH IDS (m315) ───────────────────────────────────────────────────────
  // A property arrives by one of two doors and a caller must know which.
  ok("an in-house match exposes OUR listing id", resolver.includes("listingId: l.id"))
  ok("an outside match exposes the MLS/vendor property id",
    resolver.includes("propertyId: s.mls_number ?? s.external_property_id ?? null"))
  ok("...and the mls number specifically, which is what an agent recognises",
    resolver.includes("mlsNumber: s.mls_number ?? null"))
  ok("...and where a human can go look at it", resolver.includes("listingUrl: s.listing_url"))

  // ── EXTERNAL LISTINGS ARE CHECKABLE, NOT UNKNOWABLE ───────────────────────
  // The first cut called every external match unverifiable. Wrong twice over.
  ok("a saved row that LINKS BACK to one of our listings uses OUR status —\n    free, authoritative, and most 'external' matches are actually these",
    resolver.includes('statusSource: linked_listing'.replace("linked_listing", '"linked_listing"')) ||
    resolver.includes('"linked_listing" : "unknown"'))
  ok("...resolved in ONE extra query, not per property", resolver.includes("linkedStatus"))
  ok("a genuinely external listing is verified against the vendor",
    resolver.includes("export async function verifyExternalAvailability"))
  ok("...only for rows still unknown — never re-paying for what we already know",
    resolver.includes('f.statusSource === "unknown" && f.propertyId'))
  // A vendor outage must degrade to "we do not know", never to "still for sale".
  // Structural, not a comment: the catch returns the facts UNCHANGED, and the
  // only place statusSource becomes "rentcast" is behind a resolved status.
  ok("...and a failed lookup leaves it unknown rather than guessing available",
    resolver.includes("} catch {\n    \n    return facts\n  }") ||
    /catch\s*\{[^}]*return facts/.test(resolver))
  ok("...and a row only becomes vendor-verified when a status actually came back",
    resolver.includes('s ? { ...f, status: s, statusSource: "rentcast" as const } : f'))
  ok("the status source is DECLARED, so a human can see which lane answered",
    resolver.includes("statusSource:"))

  const rentcast = code("lib/property/rentcast.ts")
  ok("the vendor lookup exists and is per-listing",
    rentcast.includes("export async function getRentcastListingStatus"))
  // RentCast is PLATFORM-GATED (owner ruling, wave 17): one platform account
  // serving every tenant, metered per tenant. There is no tenant RentCast key,
  // so an agent with no vendor account of their own is covered BY CONSTRUCTION
  // rather than by a fallback. `brokerageId` is still passed — not to select a
  // credential, but as the tenant ATTRIBUTION the metering bills against, which
  // is what makes it "gated" and not merely "platform-owned". That is why this
  // assertion still reads the same call text: what changed is what the argument
  // MEANS, and this proof is what stops the lane resolving a key with no tenant
  // to charge it to.
  // WAVE 18 moved the key resolution one level in, and this assertion moved with
  // it rather than being deleted. The lane no longer calls `getApiKey` directly:
  // it calls `gateRentcast(params)`, which asks the ONE eligibility resolver
  // (platform key + owner ruling + vendor budget) and returns the key only when
  // the answer is yes. `params` still carries the tenant, so the property this
  // assertion has always protected is intact and is now STRONGER — a lane cannot
  // resolve a key without a tenant to meter it against, AND cannot resolve one
  // for a tenant the owner has ruled RentCast out for. Pinning to the old call
  // text would have made a tightening look like a regression.
  ok("...resolving the PLATFORM key THROUGH THE GATE, with the tenant carried\n    (a lane can never resolve a key without a tenant to meter it against)",
    rentcast.includes("gateRentcast(params)") && rentcast.includes("getApiKey(caller.brokerageId)"))
  ok("...and a 404 means off_market, not sold — we do not invent which terminal state",
    rentcast.includes('if (res.status === 404) return "off_market"'))
  ok("...and the call is metered like every other vendor call",
    rentcast.includes('endpoint: "/listings/sale/{id}"'))

  ok("a vendor 'Active' maps onto our vocabulary", normalizeVendorStatus("Active") === "active")
  ok("'Under Contract' maps to pending", normalizeVendorStatus("Under Contract") === "pending")
  ok("an UNRECOGNISED vendor status maps to off_market, never to active — the safe\n    direction is to stop advertising a home we are unsure about",
    normalizeVendorStatus("Somethingelse") === "off_market")
  ok("an absent vendor status stays null", normalizeVendorStatus(null) === null)

  ok("the buyer facts VERIFY before counting", producerHasVerify())
  function producerHasVerify() {
    const pr = code("lib/agents/buyer-match-reel-producer.ts")
    return pr.includes("verifyExternalAvailability(brokerageId, resolved)")
  }
  ok("...and the unverifiable count is the residue AFTER verification, not a shrug\n    at every external listing",
    code("lib/agents/buyer-match-reel-producer.ts").includes('f.statusSource === "unknown"'))
  ok("the match signature names BOTH doors — our listing id, or the MLS id",
    code("lib/agents/buyer-match-reel-producer.ts")
      .includes("f.listingId ?? f.propertyId ?? f.id"))

  const producer = code("lib/agents/buyer-match-reel-producer.ts")
  ok("the producer exposes a read-only fact projection",
    producer.includes("export async function buyerMatchFacts"))
  ok("...and a refresh can override the weekly cooldown",
    producer.includes("recent && !opts.force"))
  ok("...and stamps the living identity on the queued render",
    producer.includes('livingKind: livingFacts ? "buyer_match_reel" : null'))

  const delivery = code("lib/agents/buyer-reel-delivery.ts")
  ok("buyer delivery de-duplicates per VIDEO, not per week",
    delivery.includes('.ilike("body", `%${render.output_url}%`)'))
  ok("...and exempts a refresh from the cooldown",
    delivery.includes("if (!render.refreshed_from_render_id) {"))
  ok("...while an ordinary reel is still cooled down",
    delivery.includes('"already delivered this week"'))
  ok("...and the human is told why an off-cadence cut arrived",
    delivery.includes("REFRESHED property-match reel"))
}

console.log("\n═══ 11. Wiring + ownership ═══")
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
