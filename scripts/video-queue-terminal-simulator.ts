#!/usr/bin/env tsx
/**
 * scripts/video-queue-terminal-simulator.ts (npm run test:video-queue-terminal)
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY QUEUED VIDEO SPUN FOREVER.
 *
 * video_generation_queue has a status column and three writers that set it —
 * 'queued' on insert, then 'generating' or 'generating_audio' when a render is
 * kicked. NOTHING in the codebase ever wrote 'completed' or 'failed'. Not one
 * row could reach a terminal state. The Content Studio showed work in flight
 * that had actually finished, or died, minutes later — forever.
 *
 * THE BRIDGE ALREADY EXISTED AND WAS NEVER USED:
 *   video_generation_queue.project_id -> ai_video_projects(id) ON DELETE CASCADE
 *
 * ai_video_projects is the rail that genuinely completes: poll-did-videos drives
 * a D-ID job to completed/failed (treating a provider 404 as terminal), the
 * Remotion routes write terminal statuses, and video-pipeline-reaper fails
 * anything that stalls. The two ledgers were simply never connected.
 *
 * THREE DEFECTS, ALL OF THE SAME SHAPE — a real UI over a real backend with
 * nothing in between:
 *
 * 1. NO TERMINAL PATH AT ALL. Fixed at the DATABASE (m365), not in code: there
 *    are ~15 places that write a terminal ai_video_projects.status, and a rule
 *    spread across 15 call sites is one a future writer breaks by not knowing
 *    about it — which is how this defect was born. The trigger is unmissable.
 *
 * 2. generateVideoFromScript SUBMITTED A JOB NOTHING COULD POLL. It inserted a
 *    queue row carrying title/script/video_type/avatar/voice — none of which are
 *    columns on that table, so Supabase dropped them silently — with NO
 *    project_id, then called D-ID for real. poll-did-videos selects
 *    ai_video_projects rows, and there was no project, so the D-ID job id went
 *    to a console.log and the row sat at 'generating' permanently. It now
 *    creates the project first (restoring the dropped metadata to columns that
 *    exist) and stamps the provider job on it.
 *
 * 3. startVideoGeneration WAS A STATUS WRITE AND NOTHING ELSE. It set
 *    'generating_audio' and returned "Video generation started". No renderer was
 *    ever invoked. The script was real and the compliance check was real; the
 *    middle was missing entirely. It now creates/adopts a project, refuses a
 *    script that has not passed compliance (that column existed with no gate
 *    reading it), submits through lib/did, and lets the poll cron finish it.
 *
 * Verified live on brokerage b0000000…0001, exercising the real trigger:
 *   project draft -> generating   => queue 'queued'           -> 'creating_video'
 *   project        -> completed   => queue                    -> 'completed', processed_at stamped
 *   project        -> rendering   => queue stays 'completed'   (terminal is FINAL)
 *   project        -> failed      => queue 'generating_audio'  -> 'failed', processed_at stamped
 * Test rows removed; ZZTEST residue 0.
 */
import { readFileSync, existsSync } from "node:fs"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
/** Comments stripped: this file's own prose must never satisfy an assertion. */
const src = (p: string) =>
  existsSync(p)
    ? stripComments(readFileSync(p, "utf8"))
    : ""
/** SQL keeps its comments stripped too — `--` lines. */
const sql = (p: string) =>
  existsSync(p) ? readFileSync(p, "utf8").replace(/^\s*--.*$/gm, "") : ""

const MIGRATION = sql("supabase/migrations/m365-video-queue-follows-its-project.sql")
const GENVIDEO  = src("app/actions/video-generation.ts")
const LINKVIDEO = src("app/actions/link-to-video.ts")
const STUDIO    = src("app/components/content-studio/LinkToVideoGenerator.tsx")
const REAPER    = src("lib/video/video-pipeline-reaper-policy.ts")
// m374 moved the vocabulary itself here; the reaper policy only re-exports it.
// Imported, not grepped — see the membership checks below for why.
import { VIDEO_TERMINAL_STATUSES } from "../lib/video/video-status"
import { stripComments } from "./strip-comments"
const POLL      = src("app/api/cron/poll-did-videos/route.ts")

console.log("\n── the mirror exists, at the database, where no writer can miss it ──")
{
  check("a trigger fires on ai_video_projects status changes",
    /create trigger trg_video_queue_follow_project_status[\s\S]{0,200}?after update of status on public\.ai_video_projects/.test(MIGRATION))
  check("…and it updates the queue through the project_id FK",
    /update public\.video_generation_queue[\s\S]{0,400}?where q\.project_id = new\.id/.test(MIGRATION))
  check("…mapping every terminal project state to a terminal queue state",
    /'completed', 'ready', 'published', 'distributed'/.test(MIGRATION) &&
    /'failed', 'cancelled'/.test(MIGRATION))
  check("…and stamping processed_at only on a terminal transition",
    /processed_at = case when is_terminal then now\(\)/.test(MIGRATION))
  // Anchored INSIDE the trigger's own UPDATE (the one keyed on new.id). The
  // backfill at the bottom of the migration carries an identical clause, so an
  // unanchored match would pass while the trigger itself had lost its guard.
  check("a terminal queue row is FINAL — a re-render cannot drag it back in flight",
    /where q\.project_id = new\.id[\s\S]{0,300}?not in \('completed', 'failed'\)/.test(MIGRATION))
  check("a no-op status rewrite does not re-stamp",
    /new\.status is not distinct from old\.status/.test(MIGRATION))
  check("already-stranded rows are backfilled, not left stuck forever",
    /update public\.video_generation_queue q[\s\S]{0,600}?from public\.ai_video_projects p/.test(MIGRATION))
  check("the mirror's WHERE has an index to ride",
    /create index if not exists idx_video_generation_queue_project_id/.test(MIGRATION))
}

console.log("\n── the mapping matches the two vocabularies it joins ──")
{
  // If the terminal set grows, the mirror must learn the new member or a whole
  // class of finished work stops reaching the queue. That intent is unchanged;
  // both halves of it moved.
  //
  // WHAT MOVED. m374 collapsed 22 status spellings into 9, and the surviving
  // terminal set is completed | published | failed. `ready` and `distributed`
  // folded into those two, `cancelled` into `failed`, and the CHECK constraint
  // now REFUSES all three retired spellings — so asserting the mirror maps them
  // would demand coverage of values no writer can produce. The m365 trigger
  // still lists them, which is harmless: dead branches over impossible inputs.
  //
  // WHERE IT MOVED. The list itself now lives in lib/video/video-status.ts; the
  // reaper policy re-exports it. Reading the literals out of REAPER is why this
  // check failed — the tokens were no longer in that file. Read the owner.
  //
  // VERIFIED, not assumed: m365 line 65 already maps 'published' -> 'completed',
  // so the merge did not open a hole in the mirror.
  // IMPORT the arrays rather than grepping the file. A token-presence check
  // here is worthless: "published" also appears in CANONICAL_VIDEO_STATUSES and
  // as the target of RETIRED_VIDEO_STATUS.distributed, so /"published"/ stayed
  // true even after it was deleted from the terminal set — the first cut of
  // this check passed under exactly that mutation. Importing asserts membership,
  // which is the actual claim.
  for (const s of VIDEO_TERMINAL_STATUSES) {
    check(`  '${s}' is terminal to the vocabulary AND mapped by the mirror`,
      new RegExp(`'${s}'`).test(MIGRATION))
  }
  check("  the terminal set is exactly completed | published | failed",
    [...VIDEO_TERMINAL_STATUSES].sort().join(",") === "completed,failed,published")
  // The retired spellings must NOT come back as terminal values.
  for (const s of ["ready", "distributed", "cancelled", "uploaded", "video_ready"]) {
    check(`  '${s}' is retired — not a terminal status any writer can produce`,
      !(VIDEO_TERMINAL_STATUSES as readonly string[]).includes(s))
  }

  // The queue's vocabulary is what the Content Studio badge map renders.
  for (const s of ["completed", "failed", "creating_video"]) {
    check(`  the queue state '${s}' the mirror writes has a badge`,
      new RegExp(`${s}:\\s*\\{`).test(STUDIO))
  }
}

console.log("\n── generateVideoFromScript puts its job on the rail that finishes ──")
{
  // Asserts the CONSTRUCT (a project exists before the queue row), not the
  // spelling of the insert — the project is created through the canonical
  // createVideoProject rather than a hand-rolled insert, so that
  // ai_video_projects.agent_id keeps exactly one writer while that column is
  // mid-migration (scripts/agent-id-repoint-guard.ts).
  check("it creates a project before the queue row",
    /createVideoProject\(\{[\s\S]{0,900}?from\("video_generation_queue"\)/.test(GENVIDEO))
  check("…and the queue row points at it",
    /project_id: project\.id/.test(GENVIDEO))
  check("the D-ID job id is stamped on the PROJECT, not logged and lost",
    /provider_job_id:\s*didJobId/.test(GENVIDEO))
  // All three are required by the poll cron's selector; two out of three is invisible.
  check("…with everything poll-did-videos selects on",
    /status:\s*"generating"/.test(GENVIDEO) &&
    /provider_metadata: \{ provider: "did", mode: "talk", talk_id: didJobId \}/.test(GENVIDEO))
  check("…and it no longer writes the queue status by hand",
    !/from\("video_generation_queue"\)\s*\n?\s*\.update\(\{ status: "generating" \}\)/.test(GENVIDEO))
  check("a deferred render records WHY on the project instead of going quiet",
    /Render not started: \$\{reason\}/.test(GENVIDEO))
  check("the caller gets the project id, which is what the video system keys on",
    /projectId: project\.id/.test(GENVIDEO))
}

console.log("\n── startVideoGeneration actually starts a generation ──")
{
  check("it no longer just writes a status and returns",
    !/^\s*await supabase\.from\("video_generation_queue"\)\.update\(\{ status: "generating_audio" \}\)/m.test(LINKVIDEO))
  check("it refuses a script that has not cleared compliance",
    /compliance_approved !== true/.test(LINKVIDEO))
  check("…and refuses an empty script rather than paying for a render of nothing",
    /if \(!script\)/.test(LINKVIDEO))
  check("it creates a project and links the queue row to it",
    /createVideoProject\(\{[\s\S]{0,900}?\.update\(\{ project_id: projectId \}\)/.test(LINKVIDEO))
  check("…adopting an existing project on a re-run instead of making a second one",
    /let projectId = queued\.project_id/.test(LINKVIDEO))
  check("it submits a real job through the D-ID gateway",
    /generateVideo\(\{/.test(LINKVIDEO) && /agentUserId:/.test(LINKVIDEO))
  check("…stamps what the poll cron selects on",
    /provider_metadata: \{ provider: "did", mode: "talk", talk_id: render\.videoId \}/.test(LINKVIDEO))
  check("…and a refused render marks the project failed so the queue follows",
    /status: "failed", error_message: `Render not started: \$\{reason\}`/.test(LINKVIDEO))
}

console.log("\n── the poll cron can still see what we stamp ──")
{
  check("poll-did-videos selects generating + provider_job_id + provider='did'",
    /\.eq\("status", "generating"\)/.test(POLL) &&
    /\.not\("provider_job_id", "is", null\)/.test(POLL) &&
    /provider_metadata->>provider/.test(POLL))
}

console.log("\n── the Download control is backed by a real file again ──")
{
  check("the queue read embeds the project's rendered output",
    /ai_video_projects\(video_url, thumbnail_url, status, error_message\)/.test(src("app/actions/link-to-video.ts")))
  check("the studio offers a download only when a file exists",
    /video\.ai_video_projects\?\.video_url && \(/.test(STUDIO))
  check("…and a failed render tells the agent why",
    /video\.ai_video_projects\?\.error_message/.test(STUDIO))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VIDEO_QUEUE_TERMINAL_FAIL"); process.exit(1) }
console.log(" ✅ VIDEO_QUEUE_TERMINAL_PASS — a queued video reaches a terminal state, or says why it could not")
