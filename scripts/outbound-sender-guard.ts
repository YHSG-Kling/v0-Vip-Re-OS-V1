/**
 * scripts/outbound-sender-guard.ts
 *
 * test:outbound-sender — NO EMAIL LEAVES FROM AN ADDRESS NOBODY OWNS.
 *
 * WHAT THE SWEEP FOUND. Five call sites each grew their own idea of who an
 * email is from, and four ended in an address that cannot receive mail:
 * noreply@example.com (twice), noreply@vip-re.com, alerts@vip-re.com, and
 * noreply@yourdomain.com at the bottom of sendEmail itself.
 *
 * THE BUG WAS NOT THE PLACEHOLDER — IT WAS THAT THE PLACEHOLDER WON. sendEmail
 * resolved `params.from || SENDGRID_FROM_EMAIL`, so a caller passing its own
 * fallback OVERRODE the brokerage's real, verified, configured sender. A tenant
 * with SendGrid fully set up still had every campaign go out from example.com,
 * which SendGrid rejects as an unverified sender identity — so the send failed
 * at the provider with an opaque 403 rather than being refused up front with
 * something a human could act on. Only ONE of the five sites ever read
 * platform_credentials.config.from_email, the surface where a tenant actually
 * configures this.
 *
 * Same shape as the render content contract in the same pass: the OS collected
 * the answer and then silently used something else.
 */
import { readFileSync, readdirSync } from "node:fs"
import {
  isUnsendableAddress, isPlausibleAddress, isUsableSender,
  formatSender, bareAddress, NO_SENDER_ERROR,
} from "../lib/providers/outbound-sender"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(p, "utf8")
/** Comments stripped — an assertion must target CODE, never prose. */
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

console.log("\n═══ 1. A placeholder is recognised wherever it comes from ═══")
{
  for (const bad of [
    "noreply@example.com", "noreply@yourdomain.com", "alerts@vip-re.com".replace("vip-re.com", "example.org"),
    "hello@yourbrokerage.com", "a@test.com", "x@sub.example.com", "root@localhost",
  ]) {
    ok(`${bad} is unsendable`, isUnsendableAddress(bad))
  }
  ok("a real address is not", !isUnsendableAddress("dana@harbourandco.com"))
  ok("...including inside a display-name wrapper",
    !isUnsendableAddress("Harbour & Co. <dana@harbourandco.com>"))
  ok("but a placeholder inside a wrapper still IS — this is how one hides",
    isUnsendableAddress("Harbour & Co. <noreply@example.com>"))
  ok("empty is unsendable", isUnsendableAddress(""))
  ok("null is unsendable", isUnsendableAddress(null))
}

console.log("\n═══ 2. Shape checks that do not reject real mailboxes ═══")
{
  ok("a plain address parses", isPlausibleAddress("dana@harbourandco.com"))
  ok("a plus-tag parses", isPlausibleAddress("dana+listings@harbourandco.com"))
  ok("a subdomain parses", isPlausibleAddress("dana@mail.harbourandco.com"))
  ok("a display-name wrapper parses", isPlausibleAddress("Dana Reyes <dana@harbourandco.com>"))
  ok("no @ does not", !isPlausibleAddress("dana.harbourandco.com"))
  ok("no TLD does not", !isPlausibleAddress("dana@harbourandco"))
  ok("an embedded space does not", !isPlausibleAddress("dana @harbourandco.com"))
  ok("isUsableSender requires BOTH real shape and a real domain",
    isUsableSender("dana@harbourandco.com")
    && !isUsableSender("dana@example.com")
    && !isUsableSender("not-an-address"))
}

console.log("\n═══ 3. Formatting round-trips ═══")
{
  ok("a named sender renders as Name <addr>",
    formatSender({ email: "dana@harbourandco.com", name: "Harbour & Co.", source: "tenant_credential" })
    === "Harbour & Co. <dana@harbourandco.com>")
  ok("an unnamed sender renders bare",
    formatSender({ email: "dana@harbourandco.com", name: null, source: "platform_env" })
    === "dana@harbourandco.com")
  ok("bareAddress unwraps", bareAddress("Harbour & Co. <dana@harbourandco.com>") === "dana@harbourandco.com")
  ok("...and passes a bare address through", bareAddress("dana@harbourandco.com") === "dana@harbourandco.com")
  ok("the refusal names the surface a human must go and fix",
    NO_SENDER_ERROR.includes("SendGrid") && NO_SENDER_ERROR.includes("verified sender"))
}

console.log("\n═══ 4. sendEmail refuses instead of inventing ═══")
{
  const s = code("lib/providers/messaging/index.ts")
  ok("the bottom-of-stack placeholder is gone", !s.includes("noreply@yourdomain.com"))
  ok("the caller's from is VALIDATED before it can override the tenant's",
    s.includes("isUsableSender(params.from)"))
  ok("...and the env is validated too — a typo'd env var is how one reaches\n    production",
    s.includes("isUsableSender(process.env.SENDGRID_FROM_EMAIL)"))
  ok("with no usable sender it REFUSES rather than sending",
    /if \(!resolvedFrom\)[\s\S]{0,120}NO_SENDER_ERROR/.test(s))
  ok("...and the refusal happens BEFORE the provider is called, so a doomed\n    send never spends the tenant's quota",
    s.indexOf("NO_SENDER_ERROR") < s.indexOf("callConnector({"))
  ok("the provider body uses the RESOLVED address", s.includes("from: { email: resolvedFrom }"))
}

console.log("\n═══ 5. Every rewritten caller routes through the one resolver ═══")
{
  const sites: Array<[string, string]> = [
    ["lib/marketing/email-campaign-sender.ts", "campaign sender"],
    ["app/api/contacts/send-isa-email/route.ts", "ISA follow-up"],
    ["lib/vendors/w9.ts", "W-9 reminder"],
    ["lib/property-alerts/alert-notifier.ts", "property alert"],
  ]
  for (const [path, label] of sites) {
    const s = code(path)
    ok(`${label} calls resolveOutboundSender`, s.includes("resolveOutboundSender("))
    ok(`${label} REFUSES when there is none`, /if \(!(sender|resolvedSender|fromEmail)\)/.test(s))
  }
}

console.log("\n═══ 6. No fabricated sender survives anywhere in the send paths ═══")
{
  // Walk lib/ and app/ for an address literal on an unsendable domain. This is
  // the ratchet: the four that existed are gone, and a new one breaks the build.
  const files: string[] = []
  const walk = (dir: string, depth = 0) => {
    if (depth > 6) return
    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full, depth + 1)
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(full)
    }
  }
  walk("lib"); walk("app")

  // An address literal that is being SENT FROM. Placeholder addresses in
  // validation messages, help text, form placeholders and the demo tenant are
  // not sends — the discriminator is proximity to a from/sender assignment.
  const FROM_ASSIGN = /(?:\bfrom\s*[:=]|fromEmail\s*[:=]|from_email\s*[:=]|fromAddress\s*[:=])\s*[^,\n]{0,120}/g
  const offenders: string[] = []
  for (const f of files) {
    if (f.includes("/platform/demo-tenant") || f.includes("/platform/deal-room-demo")) continue
    if (f.endsWith("lib/providers/outbound-sender.ts")) continue
    const s = code(f)
    for (const m of s.match(FROM_ASSIGN) ?? []) {
      const lit = m.match(/["'`]([^"'`]*@[^"'`]*)["'`]/)?.[1]
      // "@/lib/..." is a module specifier, not a mailbox.
      if (!lit || lit.startsWith("@") || !isPlausibleAddress(lit)) continue
      if (isUnsendableAddress(lit)) offenders.push(`${f}: ${lit}`)
    }
  }
  ok(`scanned ${files.length} source files for a from-address on a domain nobody owns`,
    files.length > 500)
  ok("none survives — the four that shipped are gone and a new one breaks CI",
    offenders.length === 0, offenders.slice(0, 6).join(" | "))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`OUTBOUND SENDER — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nNeed a from-address? Call resolveOutboundSender and refuse on null.")
  console.log("A hardcoded fallback does not degrade the send — it guarantees it fails,")
  console.log("and it overrides the tenant's real configured sender on the way.")
  process.exit(1)
}
console.log("Every outbound email leaves from an address the tenant actually owns.")
