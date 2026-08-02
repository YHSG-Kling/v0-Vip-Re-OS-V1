#!/usr/bin/env tsx
/**
 * scripts/voice-clone-lifecycle-simulator.ts   (npm run test:voice-clone-lifecycle) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VOICE WAS CLONED AND THE POINTER TO IT WAS THROWN AWAY.
 *
 * The avatar/explainer stack is D-ID + ElevenLabs clones. Every stage of the
 * ElevenLabs clone lifecycle was broken by one vocabulary mismatch.
 *
 *   agent_voice_profiles.training_status
 *     CHECK (not_started | collecting_samples | training | ready | failed)
 *
 * ── 1. Progress could not be saved ──────────────────────────────────────────
 * The mid-recording save wrote `training_status: "pending"` — not a value the
 * column admits. Verified live: check_violation, and because status and
 * sample_count move in the SAME update, `sample_count` never advanced past its
 * first value. The agent records phrase after phrase and the counter does not
 * move.
 *
 * ── 2. The clone id was never stored ────────────────────────────────────────
 * The training-completion callback copied the TRAINING JOB's status
 * (processing | completed | failed) straight onto the PROFILE column, which has
 * a different vocabulary. It wrote "completed" — rejected. And
 * `elevenlabs_voice_id` is set in that same update, so the id ElevenLabs
 * returned was discarded. Verified live: after the rejected update the column
 * still read NULL. The clone exists at ElevenLabs; nothing here points to it.
 *
 * ── 3. No surface could ever find a finished clone ──────────────────────────
 * Three readers filtered `.eq("training_status", "completed")`. The finished
 * state is `ready`. Verified live on a probe profile: the old filter returned 0,
 * the corrected one returned 1.
 *
 * ── AND THE UNANSWERED-CALL RETRY LISTS READ THE WRONG COLUMN ───────────────
 * app/api/voice/twilio/status/route.ts closes every terminated leg with
 * `status = "completed"` and puts the real disposition in OUTCOME
 * (busy / no_answer / failed / canceled). Two surfaces filtered
 * `status IN (no_answer, busy, failed)` — the ISA dashboard's retry list and the
 * 4-hour callback sweep in lib/application/ai-isa.ts. Neither ever matched: the
 * AI ISA never retried an unanswered call. `busy` is not even a value
 * voice_calls.status admits. Verified live with a busy call: filtering status
 * returned 0, filtering outcome returned 1.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

console.log("\n── the profile vocabulary, and the value that is NOT in it ──")
{
  const live = CHECK_VOCABULARIES.agent_voice_profiles?.training_status ?? []
  check(`training_status has 5 values (${live.join(", ")})`, live.length === 5)
  check("'ready' is the finished state", live.includes("ready"))
  check("'completed' is NOT — three readers asked for it", !live.includes("completed"))
  check("'pending' is NOT — the progress save wrote it", !live.includes("pending"))
  check("every stage of the real ladder is storable",
    ["not_started", "collecting_samples", "training", "ready", "failed"].every((s) => live.includes(s)))
}

console.log("\n── the whole clone ladder uses admitted values ──")
{
  const v = src("app/actions/video-voice.ts")
  const live = CHECK_VOCABULARIES.agent_voice_profiles?.training_status ?? []

  const written = [...v.matchAll(/training_status:\s*"(\w+)"/g)].map((m) => m[1])
  check(`every literal written is admitted (${written.join(", ")})`,
    written.length > 0 && written.every((w) => live.includes(w)))
  check("the progress save no longer writes 'pending'", !/training_status:\s*"pending"/.test(v))
  // 'collecting_samples' stays a STORABLE value (the CHECK admits it) but
  // nothing writes it any more: the phrase-by-phrase sample manifest belonged to
  // an asynchronous training pipeline this product never had. See below.

  const read = [...v.matchAll(/\.eq\("training_status", "(\w+)"\)/g)].map((m) => m[1])
  check(`every literal read is admitted (${read.join(", ")})`,
    read.length > 0 && read.every((r) => live.includes(r)))
  check("readers look for 'ready', not 'completed'", read.every((r) => r === "ready"))

  const client = src("app/dashboard/videos/create/video-create-client.tsx")
  check("the video-create surface looks for 'ready' too",
    /\.eq\("training_status", "ready"\)/.test(client) &&
    !/\.eq\("training_status", "completed"\)/.test(client))
}

console.log("\n── the clone is SYNCHRONOUS: there is no job to map ──")
{
  const v = src("app/actions/video-voice.ts")
  const route = src("app/api/elevenlabs/voice-clone/route.ts")
  const live = CHECK_VOCABULARIES.agent_voice_profiles?.training_status ?? []

  // This block used to assert a PROFILE_STATUS_FOR_JOB mapping table, an
  // async voice_clone_training job, and a phrase-by-phrase sample manifest.
  // None of it was ever reachable: ElevenLabs Instant Voice Clone returns the
  // voice_id on the SAME request (/voices/add below), so there is no job to
  // open, poll or complete — and voice_clone_training had no writer and no
  // reader outside the four functions that have now been removed. The guard was
  // describing a pipeline the product does not have, which is why deleting the
  // dead limb "broke" it.
  check("the clone call is synchronous — the voice id comes back in the same request",
    /\/voices\/add/.test(route) && /elData\.voice_id/.test(route))
  check("no asynchronous training job is opened any more",
    !/PROFILE_STATUS_FOR_JOB/.test(v) && !/voice_clone_training\b/.test(v.replace(/voice_clone_training\(/g, "")))

  // THE POINT OF THIS BLOCK. The row is created 'not_started' and every reader
  // gates on 'ready', so saving the id without promoting the status left a
  // working clone permanently invisible. Both must happen in one update.
  check("the clone id and 'ready' are written TOGETHER when the clone succeeds",
    /\.update\(\{ elevenlabs_voice_id, training_status: "ready" \}\)/.test(route))
  check("…'ready' is a value the CHECK admits", live.includes("ready"))
  check("…and a failed save is reported, not swallowed into a false success",
    /Voice was cloned but could not be saved/.test(route))
  check("the reader gate and the writer agree on 'ready'",
    /\.eq\("training_status", "ready"\)/.test(v))
}

console.log("\n── the unanswered-call retry lists read OUTCOME, not status ──")
{
  const liveStatus = CHECK_VOCABULARIES.voice_calls?.status ?? []
  const liveOutcome = CHECK_VOCABULARIES.voice_calls?.outcome ?? []
  check("'busy' is not a voice_calls.status", !liveStatus.includes("busy"))
  check("'busy' IS a voice_calls.outcome", liveOutcome.includes("busy"))
  check("so are the other dispositions Twilio reports",
    ["no_answer", "failed", "canceled"].every((o) => liveOutcome.includes(o)))

  const status = src("app/api/voice/twilio/status/route.ts")
  check("the callback closes every terminated leg as status=completed",
    /patch\.status = "completed"/.test(status))
  check("…and puts the real disposition in outcome",
    /patch\.outcome = callStatus\.replace/.test(status))

  for (const p of ["app/dashboard/voice/isa/page.tsx", "lib/application/ai-isa.ts"]) {
    const s = src(p)
    check(`${p} filters on outcome`, /\.in\("outcome", \[/.test(s))
    check(`${p} no longer filters status for a disposition`,
      !/\.in\("status", \["no_answer"/.test(s) && !/"busy"\]\)/.test(s.replace(/\.in\("outcome"[^)]*\)/g, "")))
  }
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ VOICE_CLONE_LIFECYCLE_FAIL"); process.exit(1) }
console.log(" ✅ VOICE_CLONE_LIFECYCLE_PASS — the clone id is saved, found, and unanswered calls are retryable")
