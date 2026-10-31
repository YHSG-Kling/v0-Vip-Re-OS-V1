/**
 * scripts/vendor-retirement-guard.ts
 *
 * test:vendor-retirement — A RETIRED VENDOR MAY SURVIVE ONLY AS ITS OWN EPITAPH.
 *
 * THE RULE THIS ENCODES. When the owner retires a vendor, deleting its client
 * code is the easy half. The half that rots is its VOCABULARY: table names,
 * column names, enum values, UI labels, provider maps and default values that
 * go on naming a company this OS no longer calls. That residue is not cosmetic.
 * Every defect this sweep found has one shape — a name that says one thing
 * while the value means another — and stale vendor vocabulary manufactures that
 * shape wholesale. The worst instance is already on the record: a column called
 * byoc_credential_id (a VAPI concept) that actually held a Twilio phone-number
 * SID, whose admin form therefore asked for "cred_xxx from VAPI Credentials"
 * and fed it into Twilio's /IncomingPhoneNumbers/{sid} path. Numbers registered
 * that way could never receive a call. A name taught a form to collect the
 * wrong thing.
 *
 * THE DISTINCTION THAT MAKES THIS GUARD WORK, and the reason it is not a blanket
 * ban: the name must SURVIVE in the machinery that performs the retirement.
 *
 *   · DECOMMISSIONED_PROVIDERS names the vendor in order to EXCLUDE it. Delete
 *     the name and a stale ledger row resurrects the provider in posture.
 *   · VENDOR_PRICING / VENDOR_POLICY / vendor-ownership / tenancy-matrix are
 *     keyed to historical vendor_usage_tracking rows. The standing owner rule is
 *     never delete a rate — old ledger rows must still price.
 *
 * So "no occurrences" is the WRONG invariant; it would force deleting the very
 * mechanism that keeps the vendor dead. The right invariant is an ALLOWLIST of
 * epitaph sites, and a ban everywhere else. A guard that cannot tell the
 * difference between a tombstone and a resurrection is worse than none.
 *
 * VAPID IS NOT VAPI. VAPID is the Web Push standard (Voluntary Application
 * Server Identification). A case-insensitive search for "vapi" matches every
 * VAPID key in lib/providers/web-push.ts and the push toggle, and a careless
 * sweep would rename them and silently break browser push. The token matcher
 * here is word-boundaried precisely so that never happens, and §4 proves it.
 */
import { readFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
// TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
// 82 byte-identical copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// The copy was not a style problem. It enumerated DIRECTORIES, and a root-level
// FILE is not a directory, so `proxy.ts` — the Next 16 edge middleware, which
// gates auth and queries blog_posts, brokerages, users and tenant_custom_domains
// with a SERVICE client on EVERY request — was outside this guard's corpus. A file
// that is never opened reports green, which is the failure shape §2 of CLAUDE.md
// names. `rootRuntimeFiles()` from the same survivor supplies the root files.
/** Strip comments so the guard measures CODE, never its own prose or the
 *  historical record that documents WHY the vendor was retired. */
const code = (s: string) =>
  stripComments(s)

/**
 * Retired vendors, and the ONLY files permitted to still speak their names.
 * Every entry here is an epitaph: it names the vendor in order to keep it dead,
 * or to keep historical cost rows priceable. Adding a file to this list is a
 * deliberate act that should be justified in the file itself.
 */
//
// WAVE 145 (lane 145D — owner ruling 13, 2026-10-27: "We no longer use vapi or retell"):
//   · retell JOINS the list with NO epitaph site. It never had a client, a rate, a registry row or a ledger row
//     (live vendor_usage_tracking: 0 rows), so nothing needs its name to keep it dead. Its last runtime mentions
//     were a vendor union literal and a billing branch in lib/voice-engine/voice-usage-tracker.ts (removed, tombstone
//     there) — spelled `retell_ai`, which the word-boundaried matcher below could NOT see (`_` is a word character
//     to it). So a vendor may be SNAKE-AWARE: its name embedded in a snake_case identifier counts too (§7 proves it).
//   · two vapi epitaph sites are RETIRED from the list because they no longer name it — and both were not history but
//     LIVE paths: lib/agentic-os/vendor-ownership.ts PLATFORM_VENDORS (scanConnectivity rendered every member as a
//     managed connector) and lib/agentic-os/vendor-capability-registry.ts (the voice_call capability still routed to
//     the retired vendor). The same two files no longer name heygen either (PLATFORM_VENDORS), so they leave heygen's list.
//     A list entry for a file that no longer needs the name is a standing permission to re-introduce it.
const RETIRED: Record<string, { epitaphs: string[]; snakeAware: boolean }> = {
  vapi: { snakeAware: true, epitaphs: [
    "lib/platform/provider-posture.ts",              // DECOMMISSIONED_PROVIDERS — the exclusion mechanism
    "lib/providers/tenancy-matrix.ts",               // vendor-ownership history; "nothing in the app calls Vapi"
    "lib/vendor-governance/meter-vendor.ts",         // historical rate — never delete a rate
    "lib/vendor-governance/vendor-policy.ts",        // keyed to vendor_usage_tracking rows
    "lib/kernel/manager-registry.ts",                // the written record of the decision
  ] },
  // heygen stays word-boundaried: legacy rows still carry metadata.heygen_video_id and app/actions/ai-isa.ts reads it
  // as a fallback for historical video jobs — a historical-row read, not a live path to the vendor.
  heygen: { snakeAware: false, epitaphs: [
    "lib/platform/provider-posture.ts",
    "lib/providers/tenancy-matrix.ts",
    "lib/vendor-governance/meter-vendor.ts",
    "lib/vendor-governance/vendor-policy.ts",
    "lib/kernel/manager-registry.ts",
    // lib/marketing/video-provider-resolver.ts LEFT this list (wave 145, lane 145D — found by the new stale-epitaph
    // check): resolveVideoProvider forces every non-upload key to 'did' WITHOUT naming the vendor in code (the name
    // survives only in its comment), so the site no longer needs the permission.
    "lib/vendor-governance/cost-normalizer.ts",       // historical ledger rows must still normalise
    "app/dashboard/onboarding/training/[id]/video-player-client.tsx", // legacy training URL compat
  ] },
  retell: { snakeAware: true, epitaphs: [] },
}

/** Word-boundaried so VAPID never matches VAPI. This is the whole safety margin. */
const tokenOf = (vendor: string) => new RegExp(`(?<![A-Za-z0-9_])${vendor}(?![A-Za-z0-9_])`, "i")
/** SNAKE-AWARE (wave 145): `_` separates words, so `retell_ai` / `vapi_call_id` count — letters and digits still do not,
 *  so VAPID / getVapidPublicKey / "retelling" never match. */
const snakeTokenOf = (vendor: string) => new RegExp(`(?<![A-Za-z0-9])${vendor}(?![A-Za-z0-9])`, "i")

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const FILES = [...walkTs("app"), ...walkTs("lib"), ...rootRuntimeFiles(".")]
const SOURCES = FILES.map((f) => ({ file: f, src: code(read(f)) }))

console.log("\n═══ 1. A retired vendor is named only where naming it retires it ═══")
for (const [vendor, { epitaphs: allowed, snakeAware }] of Object.entries(RETIRED)) {
  const re = snakeAware ? snakeTokenOf(vendor) : tokenOf(vendor)
  const offenders = SOURCES.filter((s) => re.test(s.src) && !allowed.includes(s.file))
  ok(`no app/lib file outside the ${allowed.length} epitaph sites still says "${vendor}"${snakeAware ? " (snake-aware)" : ""}`,
    offenders.length === 0,
    offenders.map((o) => `${o.file}`).join(", "))
  // An epitaph that no longer names the vendor is a standing permission to re-introduce it — the list must shrink.
  const stale = allowed.filter((f) => !re.test(SOURCES.find((s) => s.file === f)?.src ?? ""))
  ok(`every one of "${vendor}"'s epitaph sites still NEEDS the name (none stale)`, stale.length === 0, stale.join(", "))
}

console.log("\n═══ 2. The exclusion machinery is intact — the epitaph still works ═══")
{
  const posture = read("lib/platform/provider-posture.ts")
  ok("DECOMMISSIONED_PROVIDERS still names both retired vendors, because that\n    is what keeps a stale ledger row from resurrecting them",
    /DECOMMISSIONED_PROVIDERS[\s\S]{0,120}"vapi"[\s\S]{0,40}"heygen"/.test(posture))

  const meter = read("lib/vendor-governance/meter-vendor.ts")
  ok("the historical rates survive — deleting a rate stops old ledger rows pricing",
    /\bvapi\s*:/.test(meter) && /\bheygen\s*:/.test(meter))
}

console.log("\n═══ 3. Nothing DISPATCHES to a retired vendor ═══")
{
  // Surviving as history is fine. Being a default, a capability target, or a
  // selectable option is not — that is a live path to a dead vendor.
  const providers = code(read("lib/kernel/providers.ts"))
  ok("no capability defaults to a retired vendor",
    !/:\s*"(vapi|heygen)"/.test(providers),
    "lib/kernel/providers.ts still routes a capability at one")

  const selectable = SOURCES.filter((s) =>
    /<SelectItem\s+value="(vapi|heygen)"/.test(s.src))
  ok("no UI offers a retired vendor as a choice",
    selectable.length === 0, selectable.map((s) => s.file).join(", "))

  const vocab = read("scripts/check-vocabularies.ts")
  ok("voice_provider vocabulary is ElevenLabs only, matching the live CHECK",
    /voice_provider:\s*\["elevenlabs"\]/.test(vocab))
}

console.log("\n═══ 4. VAPID — the Web Push standard — is untouched ═══")
{
  // The near-miss that this section exists to prevent forever: a case-
  // insensitive sweep for "vapi" matches every VAPID key and silently breaks
  // browser push. Prove both that the keys survive and that the matcher is
  // incapable of hitting them.
  const push = read("lib/providers/web-push.ts")
  ok("web-push still reads its VAPID key pair",
    /VAPID_PUBLIC_KEY/.test(push) && /VAPID_PRIVATE_KEY/.test(push) && /VAPID_SUBJECT/.test(push))
  ok("the push toggle still resolves the public key",
    /getVapidPublicKey/.test(read("app/components/shared/push-permission-toggle.tsx")))

  const re = tokenOf("vapi")
  ok("the vendor matcher does NOT fire on VAPID_PUBLIC_KEY",  !re.test("VAPID_PUBLIC_KEY"))
  ok("...nor on getVapidPublicKey",                            !re.test("getVapidPublicKey"))
  ok("...nor on vapidDetails",                                 !re.test("vapidDetails"))
  ok("...but DOES fire on a bare vendor mention",              re.test('provider: "vapi"'))
  ok("...and on a snake_case column that embeds it",           tokenOf("vapi_call_id").test("vapi_call_id: x"))
}

console.log("\n═══ 5. The renamed objects agree with the live schema snapshot ═══")
{
  const snap = read("scripts/schema-snapshot.ts")
  ok("the inventory ledger is catalogued under its new name",
    /tenant_phone_numbers: \[/.test(snap) && !/vapi_phone_numbers: \[/.test(snap))
  ok("voice_calls carries vendor_call_id, not the vendor's own name",
    /voice_calls: \[[^\]]*"vendor_call_id"/.test(snap) && !/"vapi_call_id"/.test(snap))
  ok("the four vestigial columns are gone from the snapshot",
    !/"vapi_assistant_id"|"vapi_number_id"|"vapi_phone_number_id"/.test(snap))

  // Scoped past the epitaph sites for the same reason §1 is. manager-registry
  // is the WRITTEN RECORD of this decision, and the record has to be able to
  // say which column was renamed or it documents nothing. code() strips
  // comments but NOT string literals, so the registry's prose reads as code to
  // a naive scan — the trap that already cost this sweep one false failure.
  const epitaphs = new Set(Object.values(RETIRED).flatMap((r) => r.epitaphs))
  const stale = SOURCES.filter((s) =>
    !epitaphs.has(s.file) && /\bvapi_phone_numbers\b|\bvapi_call_id\b/.test(s.src))
  ok("no query still names a renamed object — tsc cannot see inside a\n    .select() string, so this is the check that actually catches it",
    stale.length === 0, stale.map((s) => s.file).join(", "))
}

console.log("\n═══ 6. The exclusion set has a CONSUMER on the monitoring rail ═══")
{
  // §2 proves DECOMMISSIONED_PROVIDERS still NAMES both vendors. That is
  // necessary and it is not sufficient: a set nothing reads excludes nothing.
  //
  // This is not hypothetical. service_status carried live rows for both retired
  // vendors until m372 deleted them — the health cron iterates that table one
  // check per row, so both were polled every run and rendered on
  // /dashboard/system as providers whose health an operator is invited to care
  // about. Neither has a check function, so both resolved to 'unknown' forever.
  // The set existed, was correct, and no consumer on this rail ever asked it.
  //
  // Asserting the CONSTRUCT, not a spelling: the cron must import the set and
  // branch on it inside the per-service loop. A mention in a comment cannot
  // satisfy this — code() strips comments before the scan.
  const cron = code(read("app/api/cron/health-check/route.ts"))
  ok("the health cron imports the exclusion set rather than re-listing vendors",
    /import\s*\{[^}]*DECOMMISSIONED_PROVIDERS[^}]*\}\s*from/.test(cron))
  ok("...and actually branches on it, so a resurrected ledger row is skipped",
    /DECOMMISSIONED_PROVIDERS\.has\s*\(/.test(cron))
  // Name-presence would pass on a declared-but-unused array. Assert it is both
  // WRITTEN TO at the skip and READ BACK into what the run reports.
  ok("...and the skip is REPORTED, never silent — a resurrected row must be visible",
    /skippedDecommissioned\.push\s*\(/.test(cron) &&
    /metadata:\s*\{[^}]*skippedDecommissioned/.test(cron))

  // The migration that cleared the rows must stay in the tree; without it a
  // fresh environment seeds the retired vendors straight back in.
  const mig = read("supabase/migrations/m372-drop-decommissioned-provider-monitoring.sql")
  ok("the migration that cleared the retired monitoring rows is still present",
    /DELETE\s+FROM\s+public\.service_status/i.test(mig) &&
    /'heygen'/.test(mig) && /'vapi'/.test(mig))
}

console.log("\n═══ 7. retell (wave 145) — the snake-aware matcher, its positive controls, and no live path ═══")
{
  // The measurement the list needed: the old matcher could not see `retell_ai`, which is how the name survived.
  const snake = snakeTokenOf("retell"), word = tokenOf("retell")
  ok("POSITIVE CONTROL: the snake-aware matcher fires on the identifier the old matcher missed (retell_ai)",
    snake.test("vendor: 'twilio' | 'retell_ai' | string") && !word.test("retell_ai"))
  ok("...and on a bare mention", snake.test('provider: "retell"'))
  ok("...and never on an ordinary English word that contains it (retelling)", !snake.test("retelling the story"))
  ok("the vapi matcher stays VAPID-safe under snake-awareness (VAPID_PUBLIC_KEY, getVapidPublicKey)",
    !snakeTokenOf("vapi").test("VAPID_PUBLIC_KEY") && !snakeTokenOf("vapi").test("getVapidPublicKey") && snakeTokenOf("vapi").test("vapi_call_id"))
  const tracker = code(read("lib/voice-engine/voice-usage-tracker.ts"))
  ok("the voice usage tracker bills by the live lane only (no retired-vendor branch left in code)",
    /vendor\.includes\('twilio'\)/.test(tracker) && !snake.test(tracker) && !snakeTokenOf("vapi").test(tracker))
  const cap = code(read("lib/agentic-os/vendor-capability-registry.ts"))
  ok("the voice_call capability routes to the Twilio-native lane (twilio_voice), not a retired vendor",
    /voice_call:[\s\S]{0,400}vendor:\s*"twilio_voice"/.test(cap))
  ok("...and over budget it still BLOCKS (vendor policy names twilio_voice with no free alternative)",
    /twilio_voice:\s*\{\s*freeAlternative:\s*null\s*\}/.test(code(read("lib/vendor-governance/vendor-policy.ts"))))
  const own = code(read("lib/agentic-os/vendor-ownership.ts"))
  ok("PLATFORM_VENDORS no longer lists a decommissioned vendor (scanConnectivity renders every member as a managed connector)",
    !/PLATFORM_VENDORS[\s\S]{0,600}"(vapi|heygen)"/.test(own))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`VENDOR RETIREMENT — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nA retired vendor may survive only as its own epitaph: in the")
  console.log("machinery that excludes it, and in the rates that price its history.")
  process.exit(1)
}
console.log("Both retired vendors survive only as epitaphs. VAPID is untouched.")
