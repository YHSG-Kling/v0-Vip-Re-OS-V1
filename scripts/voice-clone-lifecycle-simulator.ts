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

/** Body of a named function — so an assertion is about THAT function, not
 *  about whichever similar-looking code happens to appear first in the file. */
const fnBody = (text: string, name: string): string => {
  const start = text.search(new RegExp(`(async\\s+)?function\\s+${name}\\b`))
  if (start < 0) return ""

  // Step past the PARAMETER LIST before looking for the body brace — an inline
  // object param (`data: { … }`) or a `Promise<{ … }>` return type would
  // otherwise be mistaken for the body and match a few lines of nothing.
  const paren = text.indexOf("(", start)
  if (paren < 0) return ""
  let pDepth = 0, afterParams = -1
  for (let i = paren; i < text.length; i++) {
    if (text[i] === "(") pDepth++
    else if (text[i] === ")" && --pDepth === 0) { afterParams = i + 1; break }
  }
  if (afterParams < 0) return ""

  // Then the first brace not inside a generic return type.
  let aDepth = 0, open = -1
  for (let i = afterParams; i < text.length; i++) {
    const c = text[i]
    if (c === "<") aDepth++
    else if (c === ">") aDepth = Math.max(0, aDepth - 1)
    else if (c === "{" && aDepth === 0) { open = i; break }
  }
  if (open < 0) return ""

  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

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

  // The video wizard no longer hand-rolls the read — it asks the ONE action,
  // which is where the 'ready' gate lives. Assert the construct (it delegates)
  // rather than the spelling of a filter it should not be writing at all.
  const client = src("app/dashboard/videos/create/video-create-client.tsx")
  check("the video-create surface delegates the voice read to the canonical action",
    /getVoiceOptionsForGeneration\(/.test(client))
  check("…and does not re-implement the profile query with its own status filter",
    !/from\("agent_voice_profiles"\)/.test(client))
}

console.log("\n── two CHECK vocabularies, two types ──")
{
  const t = src("app/actions/video-voice.types.ts")
  const liveJob = CHECK_VOCABULARIES.voice_clone_training?.status ?? []
  const liveProfile = CHECK_VOCABULARIES.agent_voice_profiles?.training_status ?? []

  // The original single VoiceTrainingStatus union spanned BOTH columns, so
  // `updateTrainingJobStatus(id, "collecting_samples")` typechecked and then
  // died at the CHECK — silently, because PostgREST resolves rejected writes.
  const jobUnion = /export type VoiceTrainingJobStatus\s*=([\s\S]*?)\n\n/.exec(t)?.[1] ?? ""
  const profileUnion = /export type VoiceProfileTrainingStatus\s*=([\s\S]*?)\n\n/.exec(t)?.[1] ?? ""
  const members = (u: string) => [...u.matchAll(/"(\w+)"/g)].map((m) => m[1])

  check("the job-status type exists and is non-empty", members(jobUnion).length > 0)
  check("the profile-status type exists and is non-empty", members(profileUnion).length > 0)
  check(`job type == live voice_clone_training.status (${liveJob.join(", ")})`,
    members(jobUnion).length === liveJob.length && members(jobUnion).every((m) => liveJob.includes(m)))
  check(`profile type == live agent_voice_profiles.training_status (${liveProfile.join(", ")})`,
    members(profileUnion).length === liveProfile.length && members(profileUnion).every((m) => liveProfile.includes(m)))
  check("the two vocabularies genuinely differ — which is why one union was a bug",
    liveJob.some((s) => !liveProfile.includes(s)) && liveProfile.some((s) => !liveJob.includes(s)))

  const v = src("app/actions/video-voice.ts")
  check("the job→profile mapping is keyed by the job type, so a new job status cannot be forgotten",
    /Record<VoiceTrainingJobStatus,\s*VoiceProfileTrainingStatus>/.test(v))
  check("…and every mapped target is storable in the profile column",
    (() => {
      const table = /Record<VoiceTrainingJobStatus,\s*VoiceProfileTrainingStatus>\s*=\s*\{([\s\S]*?)\}/.exec(v)?.[1] ?? ""
      const targets = [...table.matchAll(/:\s*"(\w+)"/g)].map((m) => m[1])
      return targets.length === liveJob.length && targets.every((t2) => liveProfile.includes(t2))
    })())
}

console.log("\n── the clone is SYNCHRONOUS, and the guided capture is now wired to it ──")
{
  const v = src("app/actions/video-voice.ts")
  const route = src("app/api/elevenlabs/voice-clone/route.ts")
  const client = src("app/dashboard/videos/voice/voice-client.tsx")
  const live = CHECK_VOCABULARIES.agent_voice_profiles?.training_status ?? []

  check("the clone call is synchronous — the voice id comes back in the same request",
    /\/voices\/add/.test(route) && /elData\.voice_id/.test(route))

  // THE DEAD WIZARD. The setup page POSTed with no profile_id / twin_id /
  // isa_default, so the route 400'd on every single attempt: a real button, a
  // real endpoint, and nothing connecting them. Assert the request the client
  // builds actually names a target the route accepts.
  const cloneCall = fnBody(client, "handleCreateClone")
  check("the voice-setup page has a clone submission at all", cloneCall.includes("/api/elevenlabs/voice-clone"))
  check("the voice-setup page names a clone target in its request body",
    /profile_id/.test(cloneCall) || /twin_id/.test(cloneCall) || /isa_default/.test(cloneCall))
  check("…and the route still rejects a request that names none",
    /if \(!profile_id && !twin_id && !isa_default\)/.test(route))

  // THE POINT OF THE ORIGINAL BLOCK. The row is created 'not_started' and every
  // reader gates on 'ready', so saving the id without promoting the status left
  // a working clone permanently invisible. Quick-upload does both in one update.
  check("quick upload writes the clone id and 'ready' together",
    /\.update\(\{ elevenlabs_voice_id, training_status: "ready" \}\)/.test(route))
  check("…'ready' is a value the CHECK admits", live.includes("ready"))
  check("…and a failed save is reported, not swallowed into a false success",
    /Voice was cloned but could not be saved/.test(route))
  check("the reader gate and the writer agree on 'ready'",
    /\.eq\("training_status", "ready"\)/.test(v))

  // GUIDED CAPTURE. Same synchronous provider call, but the outcome is
  // reconciled onto the voice_clone_training row that the capture opened —
  // that is what promotes the profile and fires VOICE_CLONE_READY.
  check("guided capture is reconciled through the training job, not around it",
    /training_id/.test(route) && /updateTrainingJobStatus\(\s*training_id,\s*"completed"/.test(route))
  check("a training_id without its profile_id is refused",
    /if \(training_id && !profile_id\)/.test(route))
  check("every provider-failure path moves the job to 'failed' (no job left at 'queued' forever)",
    (() => {
      const failCalls = (route.match(/await failJob\(/g) ?? []).length
      return /const failJob = async/.test(route) && failCalls >= 3
    })())
  check("…including an unexpected throw, via a hoisted id the outer catch can still see",
    /let trainingIdForCleanup/.test(route) && /if \(trainingIdForCleanup\)/.test(route))
}

console.log("\n── an interrupted capture is resumable: the MANIFEST is persisted, not just the count ──")
{
  const v = src("app/actions/video-voice.ts")
  const client = src("app/dashboard/videos/voice/voice-client.tsx")
  const liveJob = CHECK_VOCABULARIES.voice_clone_training?.status ?? []

  // sample_count alone is a lie: it says "3 of 5 recorded" while the three
  // recordings are unreachable, because nothing else stores the phrase urls.
  check("saving samples persists the manifest itself", /upsertDraftManifest\(/.test(v))
  check("the draft is keyed by the 'queued' job — captured, not yet submitted",
    /\.eq\("status", "queued"\)/.test(v) && liveJob.includes("queued"))
  const start = fnBody(v, "startVoiceCloneTraining")
  check("submitting looks for the draft this capture has been writing into",
    /findDraftJob\(/.test(start))
  check("…and promotes that row rather than opening a second one",
    /\.update\(submission\)/.test(start))
  check("submission stamps started_at", /started_at:/.test(start))
  check("the setup page can read a draft back and resume it",
    /resumePhrases\(/.test(client) && /sample_manifest/.test(client))
  check("…and the profile list query returns the manifest that makes resuming possible",
    /voice_clone_training\(id, status, sample_manifest/.test(v))
}

console.log("\n── the profile is a SINGLETON, and a re-record does not cost the agent their voice ──")
{
  const v = src("app/actions/video-voice.ts")
  const client = src("app/dashboard/videos/voice/voice-client.tsx")

  // agent_voice_profiles carries a UNIQUE index on agent_id. A plain insert
  // therefore threw duplicate-key the SECOND time an agent recorded, which is
  // the normal case. Verified live: 23505 on the second insert for one agent.
  const create = fnBody(v, "createVoiceProfile")
  check("opening a profile checks for the agent's existing one first",
    /\.eq\("agent_id", data\.agentId\)/.test(create) && /maybeSingle\(\)/.test(create))
  check("…and updates it instead of inserting a duplicate", /\.update\(/.test(create))

  // The singleton means training_status is ONE slot. Downgrading it at the
  // start of a re-record would hide the agent's working voice from every
  // reader for the whole capture — and for good if they abandoned it.
  // Assert the PREDICATE, not the variable name: "is there already a usable
  // voice here" is `training_status === 'ready' AND an elevenlabs_voice_id`.
  // Renaming the flag must not satisfy this; deleting the test must break it.
  const guardsLiveClone = (body: string) =>
    /training_status === "ready"/.test(body) && /elevenlabs_voice_id/.test(body)

  check("a live clone is not reset when a re-record begins", guardsLiveClone(create))
  check("…nor downgraded as replacement phrases are saved",
    guardsLiveClone(fnBody(v, "updateVoiceProfileSamples")))
  check("…nor destroyed when the replacement clone fails",
    (() => {
      const b = fnBody(v, "updateTrainingJobStatus")
      // the failure branch must consult the surviving voice id and choose 'ready'
      return /status === "failed" && !!\w+\?\.elevenlabs_voice_id/.test(b) &&
             /\?\s*"ready"\s*:\s*PROFILE_STATUS_FOR_JOB\[status\]/.test(b)
    })())

  check("the setup page does not offer to add a second voice the schema forbids",
    !/Add another voice/.test(client))
  check("resume is keyed off the draft job, not off a profile status a re-record leaves alone",
    /\(profiles \?\? \[\]\)\.find\(\(p\) => resumePhrases\(p\)\)/.test(client))
}

console.log("\n── an agent with no clone can still present: assistant voices are offered ──")
{
  const v = src("app/actions/video-voice.ts")
  const client = src("app/dashboard/videos/create/video-create-client.tsx")

  check("the options action returns premade voices alongside clones",
    /standardVoices/.test(v) && /ASSISTANT_VOICE_OPTIONS/.test(v))
  check("premade voices come from the ONE curated ElevenLabs module",
    /@\/lib\/video\/assistant-options/.test(v))
  check("the wizard renders the assistant voices, not only the clones",
    /voiceOptions\.standardVoices/.test(client))
  check("selecting either kind sets the same voice id the renderer speaks with",
    /elevenlabs_voice_id: selectedElevenLabsVoiceId/.test(client))
  check("the block on generation is 'no voice selected', not 'no clone'",
    /No voice selected/.test(client) && !/Voice clone not set up/.test(client))
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
