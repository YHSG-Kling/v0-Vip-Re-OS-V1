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
import { readFileSync, existsSync, readdirSync } from "node:fs"

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walk(full, out)
    } else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}
/** Strip comments so the guard measures CODE, never its own prose or the
 *  historical record that documents WHY the vendor was retired. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

/**
 * Retired vendors, and the ONLY files permitted to still speak their names.
 * Every entry here is an epitaph: it names the vendor in order to keep it dead,
 * or to keep historical cost rows priceable. Adding a file to this list is a
 * deliberate act that should be justified in the file itself.
 */
const RETIRED: Record<string, string[]> = {
  vapi: [
    "lib/platform/provider-posture.ts",              // DECOMMISSIONED_PROVIDERS — the exclusion mechanism
    "lib/providers/tenancy-matrix.ts",               // vendor-ownership history; "nothing in the app calls Vapi"
    "lib/vendor-governance/meter-vendor.ts",         // historical rate — never delete a rate
    "lib/vendor-governance/vendor-policy.ts",        // keyed to vendor_usage_tracking rows
    "lib/agentic-os/vendor-ownership.ts",            // ownership axis for historical rows
    "lib/agentic-os/vendor-capability-registry.ts",  // capability history
    "lib/kernel/manager-registry.ts",                // the written record of the decision
  ],
  heygen: [
    "lib/platform/provider-posture.ts",
    "lib/providers/tenancy-matrix.ts",
    "lib/vendor-governance/meter-vendor.ts",
    "lib/vendor-governance/vendor-policy.ts",
    "lib/agentic-os/vendor-ownership.ts",
    "lib/agentic-os/vendor-capability-registry.ts",
    "lib/kernel/manager-registry.ts",
    "lib/marketing/video-provider-resolver.ts",       // FORCES heygen -> did; must name it to force it
    "lib/vendor-governance/cost-normalizer.ts",       // historical ledger rows must still normalise
    "app/dashboard/onboarding/training/[id]/video-player-client.tsx", // legacy training URL compat
  ],
}

/** Word-boundaried so VAPID never matches VAPI. This is the whole safety margin. */
const tokenOf = (vendor: string) => new RegExp(`(?<![A-Za-z0-9_])${vendor}(?![A-Za-z0-9_])`, "i")

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const FILES = [...walk("app"), ...walk("lib")]
const SOURCES = FILES.map((f) => ({ file: f, src: code(read(f)) }))

console.log("\n═══ 1. A retired vendor is named only where naming it retires it ═══")
for (const [vendor, allowed] of Object.entries(RETIRED)) {
  const re = tokenOf(vendor)
  const offenders = SOURCES.filter((s) => re.test(s.src) && !allowed.includes(s.file))
  ok(`no app/lib file outside the ${allowed.length} epitaph sites still says "${vendor}"`,
    offenders.length === 0,
    offenders.map((o) => `${o.file}`).join(", "))
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
  const epitaphs = new Set(Object.values(RETIRED).flat())
  const stale = SOURCES.filter((s) =>
    !epitaphs.has(s.file) && /\bvapi_phone_numbers\b|\bvapi_call_id\b/.test(s.src))
  ok("no query still names a renamed object — tsc cannot see inside a\n    .select() string, so this is the check that actually catches it",
    stale.length === 0, stale.map((s) => s.file).join(", "))
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
