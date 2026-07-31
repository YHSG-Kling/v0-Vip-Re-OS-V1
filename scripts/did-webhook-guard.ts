/**
 * scripts/did-webhook-guard.ts
 *
 * test:did-webhook — THE AVATAR LOOP CLOSES ON A CALLBACK, NOT A CLOCK.
 *
 * D-ID accepts a `webhook` on the creation call and nothing was ever passing
 * one, so the only way this OS learned an avatar had finished was a cron every
 * three minutes. An agent who just performed a consent passcode on camera sat
 * on a spinner for up to three minutes after the work was already done.
 *
 * The four invariants this guard keeps, each of them a way the fix could rot:
 *
 * 1. WE DO NOT PRETEND TO VERIFY A SIGNATURE D-ID DOES NOT SEND. Their
 *    reference documents `webhook` as a URI and its securitySchemes cover only
 *    calling D-ID; there is no HMAC header, no signing secret. The shared
 *    secret in the callback URL is the honest mechanism, and the endpoint must
 *    never be open when that secret is unset.
 * 2. CORRELATION IS ON user_data, AND THE ID MUST EXIST BEFORE THE SUBMIT.
 *    The non-twin path used to insert the asset row AFTER the D-ID call, so a
 *    first-time avatar — the case where correlation matters most — sent no
 *    user_data at all.
 * 3. ONE COMPLETION IMPLEMENTATION. The cron and the webhook must share
 *    lib/did/avatar-completion.ts. Two copies of "what done means" is how this
 *    codebase produces drift, and a webhook that re-hosts differently from the
 *    cron is a bug nobody sees until an agent's avatar looks wrong.
 * 4. THE CRON REMAINS. A webhook is not a guarantee — the secret may be unset,
 *    the origin unreachable, a delivery dropped, and old jobs carry no callback.
 *    Deleting the poll because "we have a webhook now" is the tempting next
 *    edit and it is the one that loses avatars silently.
 */
import { readFileSync, existsSync } from "node:fs"
import { parseDidWebhook, secretMatches, didWebhookUrl } from "../lib/did/webhook"
import { buildExpressAvatarRequest, assetIdFromUserData } from "../lib/did/contract"
import { pickAvatarImageUrl, avatarWarning } from "../lib/did/avatar-completion"

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

const ROUTE = "app/api/webhooks/did/route.ts"
const CRON = "app/api/cron/poll-did-avatars/route.ts"
const CREATE = "app/api/did/create-avatar/route.ts"
const COMPLETION = "lib/did/avatar-completion.ts"

console.log("\n═══ 1. The payload is parsed, never guessed ═══")
{
  const done = parseDidWebhook({
    id: "avt_abc123", object: "scene_avatar", status: "done",
    user_data: "asset:11111111-2222-3333-4444-555555555555",
    image_url: "https://cdn.d-id.com/full.png",
  })
  ok("the job id is read", done.jobId === "avt_abc123")
  ok("the status is read and CLASSIFIED, so an unknown status can never be\n    mistaken for success", done.status === "done" && done.statusClass === "succeeded")
  ok("user_data is decoded back to OUR row id — the field D-ID designed for\n    exactly this and echoes verbatim",
    done.assetId === "11111111-2222-3333-4444-555555555555")
  ok("an avatar payload is recognised as one", done.isAvatar)

  const failed = parseDidWebhook({ id: "avt_x", object: "scene_avatar", status: "rejected" })
  ok("`rejected` classifies as FAILED, not as something to keep waiting on",
    failed.statusClass === "failed")

  const training = parseDidWebhook({ id: "avt_x", object: "scene_avatar", status: "training-started" })
  ok("a training state classifies as in-flight — the published SceneStatus enum\n    omits it but avatar training really emits it",
    training.statusClass === "in_flight")
}

console.log("\n═══ 2. Nothing is invented from a payload we cannot read ═══")
{
  const empty = parseDidWebhook(null)
  ok("a null body yields nulls, not a crash and not a default status",
    empty.jobId === null && empty.status === null && empty.assetId === null)
  ok("an unreadable status classifies as UNKNOWN", parseDidWebhook({ id: "x" }).statusClass === "unknown")

  ok("a malformed user_data correlates to nothing rather than to a guess",
    assetIdFromUserData("asset:not-a-uuid") === null && assetIdFromUserData("11111111-2222-3333-4444-555555555555") === null)

  const nested = parseDidWebhook({ data: { id: "avt_n", status: "done", object: "scene_avatar" } })
  ok("one level of envelope nesting is tolerated — D-ID does not publish the\n    wrapper shape, so the bare object is assumed and nesting is handled,\n    not guessed at further",
    nested.jobId === "avt_n" && nested.statusClass === "succeeded")

  const video = parseDidWebhook({ id: "tlk_123", object: "talk", status: "done" })
  ok("a VIDEO payload is not treated as an avatar", !video.isAvatar)
  ok("...and the avt_ prefix alone is enough to recognise an avatar, because\n    `object` is not guaranteed on every delivery",
    parseDidWebhook({ id: "avt_only", status: "done" }).isAvatar)
}

console.log("\n═══ 3. The secret is the mechanism, and it is compared carefully ═══")
{
  ok("a matching secret passes", secretMatches("s3cret", "s3cret"))
  ok("a wrong secret fails", !secretMatches("s3cret", "s3crey"))
  ok("a null secret fails — an absent header must never read as a match",
    !secretMatches(null, "s3cret"))
  ok("a length mismatch fails without comparing further", !secretMatches("s3", "s3cret"))
  ok("the comparison is a fixed XOR accumulation, not an early-returning ===",
    /diff \|= .*charCodeAt\(i\) \^ .*charCodeAt\(i\)/.test(code("lib/did/webhook.ts")))
}

console.log("\n═══ 4. The callback URL is only minted when it can actually work ═══")
{
  const savedSecret = process.env.DID_WEBHOOK_SECRET
  const savedApp = process.env.NEXT_PUBLIC_APP_URL
  const savedVercel = process.env.VERCEL_URL
  try {
    delete process.env.DID_WEBHOOK_SECRET
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com"
    ok("no secret configured ⇒ NO webhook registered, rather than a callback\n    D-ID posts into the void", didWebhookUrl() === null)

    process.env.DID_WEBHOOK_SECRET = "sec ret/&"
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.VERCEL_URL
    ok("no public origin ⇒ no webhook", didWebhookUrl() === null)

    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000"
    ok("a non-https origin ⇒ no webhook; D-ID's schema requires https and a\n    localhost origin is unreachable from them anyway", didWebhookUrl() === null)

    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com"
    const url = didWebhookUrl()
    ok("configured ⇒ an https callback on the webhook route",
      url === "https://app.example.com/api/webhooks/did?secret=sec%20ret%2F%26", url ?? "null")
    ok("...with the secret URL-ENCODED, so a secret containing / or & cannot\n    break the query it travels in", (url ?? "").includes("sec%20ret%2F%26"))
  } finally {
    if (savedSecret === undefined) delete process.env.DID_WEBHOOK_SECRET; else process.env.DID_WEBHOOK_SECRET = savedSecret
    if (savedApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = savedApp
    if (savedVercel === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = savedVercel
  }
}

console.log("\n═══ 5. The submit carries the correlation AND the callback ═══")
{
  const req = buildExpressAvatarRequest({
    sourceUrl: "https://bucket/clip.mp4",
    assetId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agentName: "Dana Kling", label: "Studio Twin",
    consentId: "cns_1", webhookUrl: "https://app.example.com/api/webhooks/did?secret=x",
  })
  ok("user_data carries asset:<uuid>", req.user_data === "asset:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
  ok("the webhook is registered", req.webhook === "https://app.example.com/api/webhooks/did?secret=x")
  ok("a round trip through the parser recovers the same row id",
    parseDidWebhook({ id: "avt_1", object: "scene_avatar", status: "done", user_data: req.user_data }).assetId
      === "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

  const noHook = buildExpressAvatarRequest({ sourceUrl: "https://b/c.mp4", webhookUrl: null })
  ok("a null callback is DROPPED, not sent as an empty string the schema\n    would reject", noHook.webhook === undefined)

  const c = code(CREATE)
  ok("create-avatar mints the asset id BEFORE the D-ID submit — the whole\n    point, since user_data can only carry an id that exists yet",
    /const assetId: string = twin_id \?\? randomUUID\(\)/.test(c))
  ok("...and the id reaches buildExpressAvatarRequest", /assetId,/.test(c))
  ok("...and the row is inserted with that SAME id, so the webhook's\n    correlation lands on a row that exists", /insert\(\{[\s\S]{0,200}id: assetId,/.test(c))
  ok("the regression is locked out: assetId is no longer `twin_id ?? null`,\n    which sent NOTHING for a first-time avatar",
    !/assetId: twin_id \?\? null/.test(c))
  ok("the callback url is wired into the submit", /webhookUrl: didWebhookUrl\(\)/.test(c))
}

console.log("\n═══ 6. The route refuses before it reads ═══")
{
  const r = code(ROUTE)
  ok("route exists", r.length > 0, ROUTE)
  ok("an UNSET secret 404s — never a silently-open endpoint, the same rule\n    sendgrid-events and lob-events already follow",
    /if \(!secret\) return NextResponse\.json\([\s\S]{0,60}status: 404/.test(r))
  ok("a wrong secret 401s BEFORE the body is parsed",
    r.indexOf("secretMatches") < r.indexOf("request.json()"))
  ok("the secret is accepted from the query OR a header",
    r.includes('searchParams.get("secret")') && r.includes('headers.get("x-webhook-secret")'))
  ok("no fabricated signature verification — D-ID publishes none, and a check\n    that looks like verification but verifies nothing is worse than none",
    !/hmac|createHmac|x-did-signature/i.test(r))
}

console.log("\n═══ 7. The body identifies a job; it never authorises one ═══")
{
  const r = code(ROUTE)
  ok("correlation prefers user_data", r.indexOf("event.assetId") < r.indexOf('eq("did_avatar_id"'))
  ok("...but a user_data id is CHECKED against a row we own before it is used —\n    an unsigned webhook that could name any uuid must not be able to write\n    to one we never created",
    /if \(assetId\) \{[\s\S]{0,240}if \(!owned\) assetId = null/.test(r))
  ok("an unmatched job is IGNORED rather than turned into a new row",
    /if \(!assetId\) \{[\s\S]{0,200}ignored: "no matching avatar asset"/.test(r))
  ok("a payload with no status is ignored rather than defaulted",
    /ignored: "no status"/.test(r))
  ok("a video payload is acknowledged and ignored OUT LOUD, not half-handled —\n    poll-did-videos does the re-host, the ffmpeg brand overlay and the\n    Remotion handoff, and a second entry point for that is pure drift",
    /if \(!event\.isAvatar\)[\s\S]{0,300}poll-did-videos/.test(r))
  ok("a parse failure ACKs 2xx — a retry storm on one bad body would bury\n    every other completion behind it", /ignored: "unparseable body"/.test(r))
  ok("...but a genuine write failure returns 500 so D-ID retries",
    /catch \(err: any\) \{[\s\S]{0,220}status: 500/.test(r))
}

console.log("\n═══ 8. Idempotent on replay ═══")
{
  const c = code(COMPLETION)
  ok("the applier RE-READS the row instead of trusting the caller's copy",
    /from\("agent_avatar_assets"\)[\s\S]{0,200}\.eq\("id", assetId\)[\s\S]{0,40}maybeSingle\(\)/.test(c))
  ok("a row already ready/failed is a REPLAY and changes nothing — without\n    this a redelivery re-downloads the avatar and inserts a second\n    'Avatar Ready' notification",
    /TERMINAL_ROW_STATUSES\.has\(String\(asset\.status\)\)[\s\S]{0,120}outcome: "skipped"/.test(c))
  ok("the terminal set is exactly ready+failed", /new Set\(\["ready", "failed"\]\)/.test(c))
  ok("the in-flight promotion is scoped to pending, so a processing row does\n    not churn updated_at on every tick and every redelivery",
    /status: "processing"[\s\S]{0,120}\.eq\("status", "pending"\)/.test(c))
  ok("an unknown asset id is reported, not created",
    /if \(!asset\) return \{ applied: false, outcome: "not_found"/.test(c))
}

console.log("\n═══ 9. One completion implementation, shared ═══")
{
  const cronSrc = code(CRON)
  const routeSrc = code(ROUTE)
  ok("the cron calls the shared applier", /applyAvatarOutcome\(supabase, asset\.id as string, data\)/.test(cronSrc))
  ok("the webhook calls the SAME applier", /applyAvatarOutcome\(supabase, assetId,/.test(routeSrc))
  ok("the cron no longer carries its own completion copy — no inline re-host",
    !cronSrc.includes("rehostAvatarImage(") || cronSrc.includes('from "@/lib/did/avatar-completion"'))
  ok("...no inline ready-write", !/status: "ready"/.test(cronSrc))
  ok("...and no inline avatar_ready notification",
    !/type: "avatar_ready"/.test(cronSrc))
  ok("the notification still exists — in the shared module, sent to users.id\n    rather than agents.id, which are different and easy to confuse",
    /type: "avatar_ready"/.test(c_of(COMPLETION)) && /select\("user_id"\)/.test(c_of(COMPLETION)))
}
function c_of(p: string) { return code(p) }

console.log("\n═══ 10. The completion decisions that were nearly lost in the move ═══")
{
  ok("HIGH RES FIRST — image_url beats the low-res thumbnail and the preview\n    GIF, so an agent's profile picture is not a blurry still",
    pickAvatarImageUrl({ image_url: "hi", thumbnail_url: "lo", preview_url: "gif" }) === "hi")
  ok("...falling back in order when the good one is absent",
    pickAvatarImageUrl({ thumbnail_url: "lo", preview_url: "gif" }) === "lo" &&
    pickAvatarImageUrl({ preview_url: "gif" }) === "gif" &&
    pickAvatarImageUrl({}) === null)

  ok("A FAILED VOICE CLONE ON A SUCCESSFUL AVATAR IS STILL REPORTED — D-ID\n    puts it in creation_notes and nothing used to read it, so the agent got\n    a working face with a silently missing voice",
    (avatarWarning({ creation_notes: { is_clone_voice_failed: true } }) ?? "").includes("voice clone failed"))
  ok("worker errors surface as a warning", (avatarWarning({ creation_notes: { worker_errors: ["a", "b"] } }) ?? "").includes("a; b"))
  ok("a clean avatar produces NO warning, so error_message is cleared rather\n    than left carrying a stale failure from an earlier attempt",
    avatarWarning({ creation_notes: {} }) === null && avatarWarning({}) === null)

  const c = code(COMPLETION)
  ok("the re-host is best-effort with a fallback to the D-ID url, so a bucket\n    failure never leaves the avatar blank", /rehosted \?\? didAssetUrl/.test(c))
  ok("the default twin is mirrored onto the profile as a URL", /agent_voice_profiles"\)[\s\S]{0,120}avatar_url: avatarUrl/.test(c))
}

console.log("\n═══ 11. The poll cron REMAINS as the fallback ═══")
{
  ok("the cron file still exists — a webhook is not a delivery guarantee, and\n    jobs submitted before the callback existed have none at all",
    existsSync(CRON))
  const cronSrc = code(CRON)
  ok("...and still fetches D-ID itself", /scenes\/avatars\/\$\{asset\.did_avatar_id\}/.test(cronSrc))
  ok("...still treats a 404 as terminal", /statusRes\.status === 404/.test(cronSrc))
  ok("...and still distinguishes retryable from terminal provider errors,\n    because re-polling a 402 or a 451 forever hides the real answer",
    /if \(failure\.retryable\) continue/.test(cronSrc))
  ok("the poll-did-videos cron is untouched — the video lane still completes\n    there, on purpose", existsSync("app/api/cron/poll-did-videos/route.ts"))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`D-ID WEBHOOK — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nD-ID publishes NO webhook signature. The shared secret and the")
  console.log("owned-row correlation are the mechanism — do not replace them with a")
  console.log("verification scheme the provider does not implement, and do not delete")
  console.log("the poll cron because a callback exists.")
  process.exit(1)
}
console.log("Avatar completions arrive on a callback, apply once, and the poll still catches what the callback misses.")
