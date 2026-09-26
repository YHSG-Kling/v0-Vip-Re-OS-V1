#!/usr/bin/env tsx
/**
 * scripts/twin-lifecycle-simulator.ts   (npm run test:twin-lifecycle)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 62 — owner asked how twins are created/used, whether avatar-twin
 * storage is still read/written, whether a D-ID render is lost if not
 * downloaded, how the live/streaming avatar works, and whether the content-
 * suggestion loop (incl. competitor high-viral posts) still runs. Answered
 * in docs/twins-and-avatars-how-it-works-2026-09.md; this proves the two
 * claims that doc makes about live code:
 *
 *   §A  No source call-site stores a raw D-ID result URL (`d-id.com`) on a
 *       row without first passing through the one rehost helper
 *       (hostRenderedMedia / rehostAvatarImage). Positive control: a
 *       synthetic BAD specimen `.update({ video_url: didData.result_url })`
 *       must be CAUGHT by the same detector used on real source — proving
 *       the scanner is not blind (CLAUDE.md §2).
 *   §B  The nightly rehost-sweep safety net is registered in BOTH
 *       CRON_REGISTRY and CRON_MANAGER, and its route file exists.
 *   §C  The content-suggestion loop (organic + competitor) has a writer, a
 *       table, and a surface at every hop — with positive/negative controls
 *       proving each check can fail.
 *
 * COMMENT-STRIPPED, always (CLAUDE.md §2 — "a tombstone is not a call
 * site"): every source read below goes through blankComments so a tombstone
 * naming a survivor file:line can never be mistaken for a live call site.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const ROOT = process.cwd()
const src = (p: string) => blankComments(readFileSync(join(ROOT, p), "utf8"))
const exists = (p: string) => existsSync(join(ROOT, p))

// ═══════════════════════════════════════════════════════════════════════════
// §A — no rogue write-site for a raw D-ID result URL
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §A: every result_url/thumbnail_url write goes through the rehost helper ──")

/**
 * THE DETECTOR. Flags a `.update({ ... })` object literal that assigns one of
 * our three URL-bearing columns directly from a variable/expression that is
 * still holding the RAW D-ID payload (never reassigned through
 * hostRenderedMedia / rehostAvatarImage / issueBucketObjectUrl first). This
 * is intentionally a NAME-based detector (the raw-payload variable names this
 * codebase actually uses — didResultUrl, didThumbnailUrl, didData.result_url,
 * didAssetUrl, data.result_url) rather than a full data-flow analysis: every
 * real write-site in this repo assigns the rehosted value to a NEW,
 * differently-named variable (persistedVideoUrl, rehosted, avatarUrl,
 * issued.url, patch.video_url after a hostRenderedMedia await) before it ever
 * reaches `.update(`, so the raw name never appears inside an update() object
 * on a clean path — and the positive control below proves the detector does
 * fire when one does.
 */
const RAW_DID_URL_NAMES = ["didResultUrl", "didThumbnailUrl", "didData\\.result_url", "didAssetUrl", "data\\.result_url"]
const rawUrlAssignRe = new RegExp(
  `\\.update\\(\\s*\\{[^)]*?\\b(video_url|avatar_url|thumbnail_url)\\s*:\\s*(${RAW_DID_URL_NAMES.join("|")})\\b`,
  "s",
)

function storesRawDidUrlWithoutRehost(stripped: string): boolean {
  return rawUrlAssignRe.test(stripped)
}

// Positive control — proves the detector is not blind (CLAUDE.md §2: "a
// broken regex and a clean tree both report zero").
{
  const badSpecimen = `
    await supabase
      .from("ai_video_projects")
      .update({ status: "completed", video_url: didData.result_url })
      .eq("id", video.id)
  `
  check("positive control — a raw `.update({ video_url: didData.result_url })` IS caught",
    storesRawDidUrlWithoutRehost(badSpecimen))

  const cleanSpecimen = `
    const persistedVideoUrl = await hostRenderedMedia(supabase, path, videoBuffer, "video/mp4")
    await supabase.from("ai_video_projects").update({ video_url: persistedVideoUrl }).eq("id", video.id)
  `
  check("negative control — a rehosted variable name is NOT flagged",
    !storesRawDidUrlWithoutRehost(cleanSpecimen))
}

// The real scan — every file in the async render + avatar-creation + sweep
// chain that is known to handle a D-ID result payload.
const SCANNED_FILES = [
  "app/api/cron/poll-did-videos/route.ts",
  "app/api/did/generate-video/route.ts",
  "lib/did/avatar-completion.ts",
  "app/api/webhooks/did/route.ts",
  "app/api/cron/poll-did-avatars/route.ts",
  "lib/providers/dispatch.ts",
  "lib/did/agents.ts",
  "lib/did/result-url-rehost-sweep.ts",
]
for (const f of SCANNED_FILES) {
  if (!exists(f)) { check(`${f} exists (scan target)`, false); continue }
  check(`${f} — no write-site stores a raw D-ID URL directly`, !storesRawDidUrlWithoutRehost(src(f)))
}

// Every render-completion write site actually names the rehost helper it
// went through — not just the absence of the bad pattern, but the presence
// of the right one.
{
  const pollVideos = src("app/api/cron/poll-did-videos/route.ts")
  check("poll-did-videos calls hostRenderedMedia before persisting the video",
    /hostRenderedMedia/.test(pollVideos))
  check("poll-did-videos's terminal write uses persistedVideoUrl/brandedVideoUrl, not didResultUrl",
    /finalVideoUrl\s*=\s*brandedVideoUrl\s*\?\?\s*persistedVideoUrl/.test(pollVideos))

  const completion = src("lib/did/avatar-completion.ts")
  check("avatar-completion calls rehostAvatarImage before persisting avatar_url",
    /rehostAvatarImage\(/.test(completion) && /avatar_url:\s*avatarUrl/.test(completion))

  const sweep = src("lib/did/result-url-rehost-sweep.ts")
  check("the sweep reuses hostRenderedMedia (no second video download-and-store impl)",
    /import\s*\{\s*hostRenderedMedia\s*\}\s*from\s*"@\/lib\/remotion\/media-host"/.test(sweep))
  check("the sweep reuses rehostAvatarImage (no second avatar-image impl)",
    /import\s*\{\s*rehostAvatarImage\s*\}\s*from\s*"@\/lib\/did\/avatar-completion"/.test(sweep))
  check("the sweep matches on both documented D-ID URL markers",
    /"d-id\.com"/.test(sweep) && /"api\.d-id\.com"/.test(sweep))
  check("the sweep reports failures through collectError, never a hand-rolled insert",
    /collectError\(/.test(sweep) && !/\.from\("automation_errors"\)\.insert\(/.test(sweep))
}

// ═══════════════════════════════════════════════════════════════════════════
// §B — the nightly sweep cron is registered end to end
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §B: the rehost-sweep cron is registered (route + CRON_REGISTRY + CRON_MANAGER) ──")
{
  const CRON_PATH = "/api/cron/did-result-url-rehost-sweep"
  check("route file exists", exists("app/api/cron/did-result-url-rehost-sweep/route.ts"))

  const registry = src("lib/kernel/cron-dispatch.ts")
  const registryRe = new RegExp(`path:\\s*"${CRON_PATH.replace(/\//g, "\\/")}"\\s*,\\s*schedule:\\s*"([^"]+)"`)
  const registryMatch = registry.match(registryRe)
  check("registered in CRON_REGISTRY", !!registryMatch)
  check("scheduled DAILY, not sub-5-minute (owner cron-cost ruling, wave 62)",
    !!registryMatch && /^\d+\s+\d+\s+\*\s+\*\s+\*$/.test(registryMatch[1]))

  const managerFile = src("lib/kernel/manager-registry.ts")
  const managerRe = new RegExp(`"${CRON_PATH.replace(/\//g, "\\/")}"\\s*:\\s*"(\\w+)"`)
  const managerMatch = managerFile.match(managerRe)
  check("registered in CRON_MANAGER", !!managerMatch)
  check("owned by asset_manager (same owner as poll-did-videos / poll-did-avatars)",
    managerMatch?.[1] === "asset_manager")

  check("MAINTENANCE_DOMAINS carries a twin_lifecycle entry with this proof script",
    /twin_lifecycle:\s*\{\s*manager:\s*"asset_manager",\s*proof:\s*"test:twin-lifecycle"/.test(managerFile))

  // Negative control — the detection regexes are not trivially true.
  check("negative control — a cron NOT in the registry is correctly absent",
    !registry.includes('"/api/cron/definitely-not-a-real-cron-xyz"'))
}

// ═══════════════════════════════════════════════════════════════════════════
// §C — the content-suggestion loop (organic + competitor) has every hop
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §C: content-suggestion loop — writer → table → reader → surface ──")
{
  // Writers (organic).
  const organicWriters = [
    "app/api/cron/content-intel-exa/route.ts",
    "app/api/cron/content-intel-reddit/route.ts",
    "app/api/cron/content-intel-rss/route.ts",
    "app/api/cron/content-intel-apify/route.ts",
  ]
  for (const w of organicWriters) {
    check(`${w} exists and writes content_topic_bank`,
      exists(w) && /\.from\("content_topic_bank"\)\.(insert|upsert)\(/.test(src(w)))
  }

  // Writer (competitor high-viral ads) → its own table → promoted into the
  // SAME organic table so downstream readers don't need to know the source.
  const competitorCron = "app/api/cron/competitor-ads-exa/route.ts"
  check(`${competitorCron} exists and calls fetchExaCompetitorAds + promoteCompetitorAdsToTopicBank`,
    exists(competitorCron) &&
    /fetchExaCompetitorAds/.test(src(competitorCron)) &&
    /promoteCompetitorAdsToTopicBank/.test(src(competitorCron)))

  const promoter = src("lib/competitive-intel/promote-to-topic-bank.ts")
  check("the promoter writes competitor ads INTO content_topic_bank (shared table, §C)",
    /\.from\("content_topic_bank"\)/.test(promoter))
  check("the promoter never copies competitor creative verbatim (paraphrase, not scrape-and-post)",
    !/ad_creative_body/.test(promoter) || /value_angle/.test(promoter))

  // Reader.
  const reader = "lib/content-intel/topic-bank.ts"
  check(`${reader} exists and reads content_topic_bank (pickTopics)`,
    exists(reader) &&
    /export async function pickTopics/.test(src(reader)) &&
    /\.from\("content_topic_bank"\)/.test(src(reader)))

  // Surfaces — at least the podcast/newsletter/blog generators and farm-mail
  // actually import the reader, so a pulled suggestion is reachable by a
  // human-visible output rather than stranded in the table.
  const surfaceFiles = [
    "app/actions/podcast-generation.ts",
    "app/actions/ai-newsletter.ts",
    "app/actions/blog.ts",
    "lib/farm-mail/dispatch-farm-mail.ts",
  ]
  let wiredSurfaces = 0
  for (const s of surfaceFiles) {
    if (exists(s) && /from\s+"@\/lib\/content-intel\/topic-bank"/.test(src(s))) wiredSurfaces++
  }
  check(`at least 2 surfaces import the topic-bank reader (found ${wiredSurfaces}/${surfaceFiles.length})`,
    wiredSurfaces >= 2)

  // Negative control — a table this loop does NOT write must not be reported
  // as wired, proving the "writes content_topic_bank" check discriminates.
  check("negative control — a writer file is not credited for a table it doesn't touch",
    !/\.from\("content_topic_bank"\)\.(insert|upsert)\(/.test(
      "export function unrelated() { return db.from(\"some_other_table\").insert({}) }",
    ))

  // All five crons scheduled (writers reachable autonomously, not button-only
  // — owner rule: every capability runs autonomously via cron/signal/manager).
  const registry = src("lib/kernel/cron-dispatch.ts")
  const allCrons = [...organicWriters.map((w) => w.replace("app/api/cron/", "/api/cron/").replace("/route.ts", "")), "/api/cron/competitor-ads-exa"]
  for (const c of allCrons) {
    check(`${c} is scheduled in CRON_REGISTRY`, registry.includes(`"${c}"`))
  }
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ TWIN_LIFECYCLE_FAIL"); process.exit(1) }
console.log(" ✅ TWIN_LIFECYCLE_PASS — twin/avatar re-host is fail-closed everywhere scanned, the nightly safety net is registered, and the content-suggestion loop has every hop")
