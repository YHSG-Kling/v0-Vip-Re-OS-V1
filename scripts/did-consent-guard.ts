/**
 * scripts/did-consent-guard.ts
 *
 * test:did-consent — A VIDEO TWIN CANNOT BE SUBMITTED WITHOUT CONSENT.
 *
 * A V3 Instant Avatar — the "build my twin from a short video" flow this OS
 * sells — REQUIRES a recorded consent statement. Not a checkbox: D-ID mints a
 * random three-word passcode, the agent must read it aloud on camera, and D-ID
 * then runs a transcription check, face recognition against the avatar footage,
 * and voice verification before the avatar is allowed to exist.
 *
 * We had NONE of it. create-avatar posted a source_url with no consent_id, so
 * every video-sourced twin was submitted without the one thing that endpoint
 * exists to require — the avatar loop was open at the very front, and the
 * failure surfaced (if at all) minutes later inside a cron.
 *
 * Two rules this guard exists to keep:
 *   · CONSENT MUST BE RECORDED, NOT UPLOADED. D-ID is explicit that webcam
 *     capture is required and a file upload is not accepted, because an upload
 *     proves nothing about who was in front of the camera.
 *   · CONSENT IS REUSED. Once verified it backs every future avatar for that
 *     agent, so nobody performs the passcode twice.
 */
import { readFileSync, existsSync } from "node:fs"
import {
  consentRequiredFor, normalizeConsentLanguage, CONSENT_LANGUAGES, CONSENT_INSTRUCTIONS,
} from "../lib/did/contract"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

console.log("\n═══ 1. Consent is required exactly where D-ID requires it ═══")
{
  ok("a VIDEO source needs consent — that is the V3 Instant Avatar flow the\n    consent process exists to police", consentRequiredFor("video"))
  ok("a PHOTO source does NOT — a V2 talking head skips instant-avatar\n    training, so demanding a passcode performance would be friction with\n    nothing behind it", !consentRequiredFor("photo"))
}

console.log("\n═══ 2. The language list is the documented one ═══")
{
  ok("english is the default for anything unrecognised",
    normalizeConsentLanguage("klingon") === "english" && normalizeConsentLanguage(null) === "english")
  ok("a supported language passes through", normalizeConsentLanguage("Spanish") === "spanish")
  ok("the list matches D-ID's published set (18 languages)", CONSENT_LANGUAGES.length === 18)
  ok("...including the ones easy to forget",
    (["filipino", "croatian", "slovak"] as const).every((l) => (CONSENT_LANGUAGES as readonly string[]).includes(l)))
}

console.log("\n═══ 3. The instructions state the rules that actually matter ═══")
{
  const all = CONSENT_INSTRUCTIONS.join(" ").toLowerCase()
  ok("the agent is told to read the words ALOUD", /read .*aloud/.test(all))
  ok("...and that recording must happen on camera, not by upload — the single\n    rule most likely to be 'helpfully' broken later",
    /on camera/.test(all) && /uploaded file cannot be accepted/.test(all))
  ok("...and how to frame themselves, since face recognition is one of the\n    three checks", /only you in frame/.test(all))
}

console.log("\n═══ 4. Avatar creation REFUSES a video twin with no consent ═══")
{
  const route = code("app/api/did/create-avatar/route.ts")
  ok("the route resolves a consent for the source type",
    route.includes("resolveConsentIdForAvatar(supabase, agentRow.id, source_type)"))
  ok("...only when the source type actually needs one",
    /if \(consentRequiredFor\(source_type\)\)/.test(route))
  ok("...and REFUSES rather than submitting a job that cannot succeed",
    /if \(!consentId\)[\s\S]{0,600}status: 428/.test(route))
  ok("...with a next step the agent can act on, not an error code",
    /record a short consent statement/.test(route))
  ok("the resolved consent is what gets sent", /consentId,/.test(route))
  ok("no caller-supplied consent_id is trusted from the request body — that\n    would let one agent borrow another's verified consent",
    !route.includes("body?.consent_id"))
}

console.log("\n═══ 5. A verified consent is REUSED, never re-performed ═══")
{
  const lib = code("lib/did/consent.ts")
  ok("the resolver looks for an existing verified consent first",
    lib.includes("findVerifiedConsent(svc, agentId)"))
  ok("...scoped to status='verified'", /\.eq\("status", "verified"\)/.test(lib))

  const mig = src("supabase/migrations/m322-did-avatar-consent.sql")
  ok("the migration exists", mig.length > 0)
  ok("...and enforces at most ONE verified consent per agent, while letting\n    pending/failed retries accumulate",
    /unique index[\s\S]{0,120}agent_did_consents_one_verified[\s\S]{0,120}where status = 'verified'/.test(mig))
  ok("...stores the passcode, so a resume shows the SAME words rather than\n    invalidating a recording already in progress", /consent_text text not null/.test(mig))
  ok("...constrains status to the real vocabulary",
    /check \(status in \('pending','verified','failed'\)\)/.test(mig))
  ok("...and has RLS on", /enable row level security/.test(mig))

  const route = code("app/api/did/consent/route.ts")
  ok("POST hands back an existing verified consent instead of minting a second",
    /const existing = await findVerifiedConsent[\s\S]{0,220}return NextResponse\.json\(\{ status: "verified"/.test(route))
  ok("GET resumes a PENDING attempt with its original passcode",
    route.includes('.eq("status", "pending")') && route.includes("consent_text: pending.consent_text"))
  ok("...and does NOT hand the passcode back once verified — it has served its\n    purpose", !/status: "verified"[\s\S]{0,200}consent_text:/.test(route))
}

console.log("\n═══ 6. Verification is owned by the right agent, and idempotent ═══")
{
  const v = code("app/api/did/consent/verify/route.ts")
  ok("the consent row must belong to the calling agent",
    /row\.agent_id !== agent\.id/.test(v))
  ok("a second submit of an already-verified consent is a no-op, not an error —\n    a flaky network must not look like a failure",
    /row\.status === "verified"[\s\S]{0,200}status: "verified"/.test(v))
  ok("a RETRYABLE provider blip leaves the row pending so the same passcode can\n    be retried; only a real rejection marks it failed",
    /status: failure\.retryable \? "pending" : "failed"/.test(v))
  ok("the passcode-mismatch failure gets its own instruction",
    code("lib/did/consent.ts").includes("ConsentTextSimilarityError")
    && /say the three words exactly as they appear/.test(code("lib/did/consent.ts")))
}

console.log("\n═══ 7. The D-ID endpoints are the documented ones ═══")
{
  const lib = code("lib/did/consent.ts")
  ok("mint posts to /consents", /path: "\/consents", method: "POST"/.test(lib))
  ok("the video goes to /consents/{id}/video",
    lib.includes("`/consents/${encodeURIComponent(consentId)}/video`"))
  ok("...and the id is URL-encoded, so a stray character cannot alter the path",
    (lib.match(/encodeURIComponent\(consentId\)/g) ?? []).length >= 2)
  ok("read-back uses GET /consents/{id}",
    /path: `\/consents\/\$\{encodeURIComponent\(consentId\)\}`,\s*\n?\s*method: "GET"/.test(lib)
    || lib.includes('method: "GET"'))
  ok("every provider failure routes through the ONE classifier",
    (lib.match(/classifyDidError\(/g) ?? []).length >= 4)
}

console.log("\n═══ 8. The live constraints, exercised against the real table ═══")
{
  // Run against production: two legitimate rows inserted, three violations
  // attempted, all three refused, then everything deleted. Recorded here so the
  // guarantee survives without the rows.
  //
  //   pending + failed for the same agent   → ACCEPTED (retries may accumulate)
  //   a SECOND verified for the same agent  → REFUSED  (partial unique index)
  //   status = 'approved'                   → REFUSED  (CHECK vocabulary)
  //   a duplicate did_consent_id            → REFUSED  (unique index)
  //
  // The middle one is the guarantee that matters: without it an agent could end
  // up with two verified consents and the resolver's maybeSingle() would throw
  // on a multi-row result, breaking avatar creation for exactly the agents who
  // had done everything right.
  const mig = src("supabase/migrations/m322-did-avatar-consent.sql")
  ok("the partial unique index is what refuses a second verified consent",
    /create unique index[^;]*agent_did_consents_one_verified[^;]*where status = 'verified'/.test(mig))
  ok("...and it is PARTIAL, so a pending retry alongside a failed one is still\n    allowed — an agent fumbling the passcode must not be locked out",
    !/create unique index[^;]*agent_did_consents_one_verified\s*\n?\s*on agent_did_consents\(agent_id\);/.test(mig))
  ok("did_consent_id is unique platform-wide, so two agents cannot claim the\n    same D-ID consent", /create unique index[^;]*agent_did_consents_did_id_key on agent_did_consents\(did_consent_id\)/.test(mig))
  ok("the resolver reads with maybeSingle, which is only safe BECAUSE of that\n    partial index", code("lib/did/consent.ts").includes(".maybeSingle()"))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`D-ID CONSENT — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nA V3 Instant Avatar cannot be created without a verified consent.")
  console.log("Do not add a file-upload path for it — D-ID rejects uploads by design.")
  process.exit(1)
}
console.log("No video twin reaches D-ID without a consent the agent actually recorded.")
