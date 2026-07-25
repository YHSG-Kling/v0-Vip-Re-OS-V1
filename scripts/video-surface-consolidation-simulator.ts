#!/usr/bin/env tsx
/**
 * scripts/video-surface-consolidation-simulator.ts  (npm run test:video-surface-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE VIDEO HUB, NO DUPLICATE VIDEO NAV (owner: "on video page navigation
 * doesn't make sense"). Investigation found the dedicated hub
 * (/dashboard/videos/{library,board,analytics,create,…}) is coherent — a single
 * "My Videos" workbench with its own Scripts/Pipeline/Analytics tab bar. The
 * drift was DUPLICATION: (1) Marketing Studio carried a thin read-only "Video"
 * tab that only re-listed ai_video_projects and linked back OUT to the real hub,
 * and (2) a fully orphaned VideoHubClient ("Video Generation Hub") plus its five
 * child components were dead code reachable from nothing. Resolution: removed the
 * duplicate Studio tab (Studio is for authoring; video has its own studio) and
 * deleted the dead hub + children. Proves the duplicate is gone, the real hub is
 * intact, and no dead video component remains.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const gone = (p: string) => !existsSync(join(process.cwd(), p))

console.log("\n── the duplicate Marketing Studio 'Video' tab is removed ──")
{
  const page = src("app/dashboard/marketing/studio/page.tsx")
  check("'video' is no longer a valid Studio tab", !/VALID_TABS[\s\S]*?"video"/.test(page))

  const client = src("app/dashboard/marketing/studio/marketing-studio-client.tsx")
  check("no 'video' TabsTrigger remains", !/TabsTrigger[\s\S]{0,120}value="video"/.test(client))
  check("no 'video' TabsContent remains", !/TabsContent value="video"/.test(client))
  check("the loadVideoData loader is gone", !client.includes("loadVideoData"))
  check("the video-projects state is gone", !client.includes("videoProjects") && !client.includes("isVideoLoading"))
}

console.log("\n── the dedicated video hub is intact (the kept, advanced surface) ──")
{
  check("the video library hub still exists", existsSync(join(process.cwd(), "app/dashboard/videos/library/page.tsx")))
  const lib = src("app/dashboard/videos/library/page.tsx")
  check("it keeps its Scripts / Pipeline / Analytics tab bar",
    lib.includes("/dashboard/videos/board") && lib.includes("/dashboard/videos/analytics"))
  check("the create wizard, board and analytics routes still exist",
    existsSync(join(process.cwd(), "app/dashboard/videos/create/page.tsx")) &&
    existsSync(join(process.cwd(), "app/dashboard/videos/board/page.tsx")) &&
    existsSync(join(process.cwd(), "app/dashboard/videos/analytics/page.tsx")))
  // The hub entry still enforces the video_generation feature gate.
  const hub = src("app/dashboard/video/page.tsx")
  check("the video hub entry still gates on video_generation",
    hub.includes("canAccessFeature") && hub.includes("video_generation"))
}

console.log("\n── the dead 'Video Generation Hub' + its orphaned children are deleted ──")
{
  check("VideoHubClient is deleted", gone("app/dashboard/video/VideoHubClient.tsx"))
  for (const c of ["DistributionControls", "GenerationSettings", "ScriptEditor", "VideoPreview", "VideoProjectList"]) {
    check(`orphaned ${c} is deleted`, gone(`app/components/features/video/${c}.tsx`))
  }
  // The still-used video components survive and are still re-exported.
  const idx = src("app/components/features/video/index.ts")
  check("index still re-exports the live components (VideosDashboard, VideoGenerationButtons)",
    idx.includes("VideosDashboard") && idx.includes("VideoGenerationButtons"))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ VIDEO_SURFACE_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ VIDEO_SURFACE_CONSOLIDATION_PASS — one video hub; the duplicate Studio tab + dead hub removed; no dead video component")
