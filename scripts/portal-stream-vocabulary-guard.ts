/**
 * scripts/portal-stream-vocabulary-guard.ts — test:portal-stream-vocabulary
 *
 * THE CLIENT PORTAL STREAM HEARS THE KERNEL (2026-09-07). The projector
 * (app/api/cron/portal-stream-projector) selects lifecycle_events by the
 * translator's keys. Those keys were a DOTTED vocabulary (`offer.submitted`)
 * while lib/kernel/emit.ts writes the KernelEvent vocabulary (`offer_submitted`);
 * fourteen of twenty-one portal kinds had no writer in their own spelling and the
 * portal stayed silent on them. No proof watched this seam — a reader with no
 * writer that no census could see, because both halves existed and simply never
 * met (§6: two spellings of one idea).
 *
 * The rule this asserts (not a waypoint, §2): every translator key is REACHABLE —
 * it has a dotted writer in product code, OR a KernelEvent alias whose value is
 * a real enum member, OR it is named in the translator's UNRESOLVED note. And
 * the projector canonicalises before storing, so the stream keeps one vocabulary.
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import { walkTs } from "./runtime-roots"
import { PORTAL_KINDS_WITHOUT_KERNEL_MOMENT } from "../lib/portal-stream/event-translator"

let passed = 0, failed = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const TRANSLATOR = src("lib/portal-stream/event-translator.ts")
const PROJECTOR  = src("app/api/cron/portal-stream-projector/route.ts")
const STAGE_TAGS = src("lib/portal-stream/event-to-stage-tags.ts")
const EVENTS     = src("lib/kernel/events.ts")
const EMIT       = src("lib/kernel/emit.ts")

console.log("══════════════════════════════════════════════════")
console.log(" Portal stream — one vocabulary between the kernel and the client")
console.log("══════════════════════════════════════════════════")

// Translator keys: the dotted portal kinds.
const keys = Array.from(TRANSLATOR.matchAll(/^  "([a-z_]+\.[a-z_]+)":/gm)).map((m) => m[1])
check("the translator declares portal kinds", keys.length >= 15, `${keys.length}`)

// Alias map: kernel spelling → portal kind.
const aliasBlock = TRANSLATOR.slice(TRANSLATOR.indexOf("KERNEL_EVENT_TO_PORTAL: Record"), TRANSLATOR.indexOf("}", TRANSLATOR.indexOf("KERNEL_EVENT_TO_PORTAL: Record")))
const aliases = Array.from(aliasBlock.matchAll(/^\s*([a-z_]+):\s*"([a-z_.]+)"/gm)).map((m) => ({ kernel: m[1], portal: m[2] }))
check("the kernel→portal alias map exists and is non-trivial", aliases.length >= 10, `${aliases.length}`)

const enumValues = new Set(Array.from(EVENTS.matchAll(/=\s*'([a-z_]+)'/g)).map((m) => m[1]))
check("every alias key is a live KernelEvent value (no invented spelling)",
  aliases.every((a) => enumValues.has(a.kernel)), aliases.filter((a) => !enumValues.has(a.kernel)).map((a) => a.kernel).join(", "))
check("every alias target is a translator key", aliases.every((a) => keys.includes(a.portal)), aliases.filter((a) => !keys.includes(a.portal)).map((a) => a.portal).join(", "))
check("the kernel emitter writes the enum spelling (the reason the alias is needed)", /event_type:\s*input\.event as string/.test(EMIT))

// Writers of the dotted spelling in product code (comment- and string-blind on purpose:
// the literal IS the thing we look for, so use stripComments only).
const productFiles = [...walkTs("app"), ...walkTs("lib")].filter((f) => !/portal-stream\/(event-translator|event-to-stage-tags)\.ts$|price-improvement-label\.ts$/.test(f))
const corpus = productFiles.map((f) => src(f)).join("\n")
// The unresolved list is CODE (PORTAL_KINDS_WITHOUT_KERNEL_MOMENT), imported —
// never a comment parsed by hand (§2). The translator is pure (no server-only).
const unresolvedKinds = [...PORTAL_KINDS_WITHOUT_KERNEL_MOMENT]
check("the unresolved list is declared in code and every entry is a translator key",
  unresolvedKinds.length >= 1 && unresolvedKinds.every((k) => keys.includes(k)), unresolvedKinds.join(", "))
const reach = keys.map((k) => ({
  key: k,
  dotted: corpus.includes(`"${k}"`),
  aliased: aliases.some((a) => a.portal === k),
  unresolved: unresolvedKinds.includes(k),
}))
check("no kind is BOTH unresolved and aliased/written (the list would be stale)",
  reach.every((r) => !(r.unresolved && (r.aliased || r.dotted))), reach.filter((r) => r.unresolved && (r.aliased || r.dotted)).map((r) => r.key).join(", "))
const unreachable = reach.filter((r) => !r.dotted && !r.aliased && !r.unresolved)
check("every portal kind is reachable: a dotted writer, a kernel alias, or named UNRESOLVED in the translator",
  unreachable.length === 0, unreachable.map((r) => r.key).join(", "))
check("no kind is BOTH dotted-written and aliased (that would card one moment twice)",
  reach.every((r) => !(r.dotted && r.aliased)), reach.filter((r) => r.dotted && r.aliased).map((r) => r.key).join(", "))
console.log(`    reach: dotted-written ${reach.filter((r) => r.dotted).length} · aliased ${reach.filter((r) => r.aliased).length} · unresolved ${reach.filter((r) => r.unresolved).length} · total ${keys.length}`)

// The projector: selects both spellings, canonicalises before tags and before storing.
check("the projector selects by PROJECTABLE_EVENT_TYPES (keys + alias keys)",
  /\.in\("event_type", PROJECTABLE_EVENT_TYPES\)/.test(PROJECTOR) && /PROJECTABLE_EVENT_TYPES: string\[\] = \[\.\.\.Object\.keys\(TRANSLATIONS\), \.\.\.Object\.keys\(KERNEL_EVENT_TO_PORTAL\)\]/.test(TRANSLATOR))
check("…canonicalises the kind before stage tags", /eventTypeToStageTags\(portalEventType\)/.test(PROJECTOR) && /canonicalPortalEventType\(ev\.event_type\)/.test(PROJECTOR))
check("…and stores the PORTAL spelling (one vocabulary in portal_event_stream)", /event_type:\s*portalEventType,/.test(PROJECTOR))
check("translateEvent resolves through the alias", /TRANSLATIONS\[canonicalPortalEventType\(input\.eventType\)\]/.test(TRANSLATOR))
check("every translator key has a stage-tag case (lesson router totality)", keys.every((k) => STAGE_TAGS.includes(`case "${k}":`)), keys.filter((k) => !STAGE_TAGS.includes(`case "${k}":`)).join(", "))

// The emitter the price-drop card depends on.
const LISTINGS = src("app/actions/listings.ts")
check("LISTING_PRICE_REDUCED has a writer carrying new_price (the card reads metadata.new_price)",
  /KernelEvent\.LISTING_PRICE_REDUCED/.test(LISTINGS) && /new_price:\s*newPrice/.test(LISTINGS))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the writer finder sees a literal and not a comment",
  blankStrings('x("offer.submitted")').length > 0 && !stripComments('// "offer.submitted"\n').includes("offer.submitted") && stripComments('emit("offer.submitted")').includes('"offer.submitted"'))
check("POSITIVE CONTROL: an invented alias key would be caught", !enumValues.has("offer_teleported"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static. Whether the projector cron fires and whether a kernel row's metadata carries the fields a card reads (offer_price, counter_price, scheduled_date, appraisal_value, document_name) is not observed here — those cards degrade to their field-less copy.")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ PORTAL_STREAM_VOCABULARY_FAIL"); fails.forEach((f) => console.log(`   - ${f}`)); process.exit(1) }
console.log(" ✅ PORTAL_STREAM_VOCABULARY_PASS — every portal kind is reachable from the kernel's own spelling")
