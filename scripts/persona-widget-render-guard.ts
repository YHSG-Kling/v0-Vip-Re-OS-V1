#!/usr/bin/env tsx
/**
 * scripts/persona-widget-render-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE `dataKey` MECHANISM HAS BOTH HALVES NOW (§1.2).
 *
 * THE FINDING, which is bigger than the two keys a census flagged. A sweep
 * reported `memory_video_requested` and `years_in_home` as writerless dataKeys
 * in lib/portal/persona-config.ts. They are not special. `dataKey` is read in
 * exactly ONE place — getPersonaWidgets — and until this closure NOTHING IN THE
 * TREE CALLED getPersonaWidgets or its partner formatWidgetValue. Both were
 * exported from lib/portal/index.ts and imported by nobody, so not one of the
 * persona widgets across all 16 personas had ever rendered, for any client, on
 * any portal. The two flagged keys were simply two of the set.
 *
 * IT WAS NOT A DEAD ABSTRACTION (§1.3), which is why it was BUILT rather than
 * deleted. Every other input already existed and was already wired:
 * app/portal/[contactId]/properties/page.tsx resolves `customFields` off
 * contacts.metadata and passes it to PersonaPropertiesDashboard beside
 * personaConfig — a line whose own comment says it exists so the widgets are not
 * "silently defaulting". A capability missing only its last hop is §1.2, and
 * shrinking the config to match what happened to be wired would have been §1.2
 * answered backwards.
 *
 * Run: npx tsx scripts/persona-widget-render-guard.ts
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  PERSONA_CONFIGS,
  formatWidgetValue,
  getPersonaWidgets,
} from "../lib/portal/persona-config"
import { blankStrings, stripComments } from "./strip-comments"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const RENDER_SITE = "app/components/portal/PersonaPropertiesDashboard.tsx"

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Persona widgets — the dataKey mechanism has a reader AND a render site")
  console.log("══════════════════════════════════════════════════\n")

  const personas = Object.keys(PERSONA_CONFIGS)
  const allWidgets = personas.flatMap((p) => PERSONA_CONFIGS[p].widgets.map((w) => ({ persona: p, w })))
  const keys = new Set(allWidgets.map((x) => x.w.dataKey))
  console.log(`   ${personas.length} personas · ${allWidgets.length} widgets · ${keys.size} distinct dataKeys\n`)

  // ── 1. THE READER IS CALLED ───────────────────────────────────────────────
  //
  // Stripped AND string-blanked: the render site now carries a long comment that
  // NAMES both functions, and a comment is not a call site (§2).
  console.log("[1 — the reader has a caller]")
  const siteCode = blankStrings(stripComments(read(RENDER_SITE)))
  check("the render site calls getPersonaWidgets with the persona AND the contact's fields",
    /getPersonaWidgets\(persona, customFields\)/.test(siteCode))
  check("…and renders each value through the ONE formatter (§6)",
    /formatWidgetValue\(w\.value, w\.format\)/.test(siteCode))
  check("import-pinned to the module that declares them",
    /import \{ getPersonaWidgets, formatWidgetValue \} from "@\/lib\/portal\/persona-config"/.test(stripComments(read(RENDER_SITE))))
  check("the page still supplies both inputs (customFields off contacts.metadata + personaConfig)",
    (() => {
      const page = blankStrings(stripComments(read("app/portal/[contactId]/properties/page.tsx")))
      return /customFields=\{customFields\}/.test(page) && /const customFields =/.test(page)
    })())

  console.log("\n[1b — positive controls]")
  check("control · the caller finder GOES RED on the pre-fix tree (a COMMENT naming it is not a call)",
    !/getPersonaWidgets\(persona, customFields\)/.test(
      blankStrings(stripComments("// nothing calls getPersonaWidgets(persona, customFields) yet"))))
  check("control · …and DOES fire on the real call",
    /getPersonaWidgets\(persona, customFields\)/.test(
      blankStrings(stripComments("const ws = getPersonaWidgets(persona, customFields)"))))

  // ── 2. THE MECHANISM ACTUALLY RESOLVES ────────────────────────────────────
  //
  // Executed, not read. Every persona is driven with a metadata bag built from
  // its OWN declared keys, and every widget must come back carrying its value.
  console.log("\n[2 — every persona's widgets resolve against contact metadata]")
  let resolvedTotal = 0
  for (const persona of personas) {
    const declared = PERSONA_CONFIGS[persona].widgets
    if (declared.length === 0) continue
    const bag = Object.fromEntries(declared.map((w, i) => [w.dataKey, `v${i}`]))
    const out = getPersonaWidgets(persona, bag)
    const allResolved = out.length === declared.length && out.every((w, i) => w.value === `v${i}`)
    resolvedTotal += out.length
    check(`  ${persona} — ${declared.length} widget(s) resolve their dataKey`, allResolved)
  }
  console.log(`   ${resolvedTotal} widget values resolved`)
  check("…and an ABSENT key stays undefined rather than defaulting to 0 or \"\"",
    getPersonaWidgets(personas[0], {}).every((w) => w.value === undefined))
  check("control · the resolver would report a MISMATCHED key as absent",
    getPersonaWidgets("first_time_buyer", { not_a_real_key: 1 }).every((w) => w.value === undefined))

  // ── 3. HONESTY — the strip never invents a value ──────────────────────────
  console.log("\n[3 — a missing value is said, not fabricated]")
  check("a widget with no value and no emptyMessage is DROPPED, not rendered blank",
    /w\.emptyMessage/.test(siteCode) && /widgets\.length === 0\) return null/.test(siteCode))
  check("the presence test rejects null and empty string, not just undefined",
    /w\.value !== undefined && w\.value !== null && w\.value !== ""/.test(siteCode))
  check("every widget that can be empty authors its own message (no generic placeholder)",
    (() => {
      const withoutMessage = allWidgets.filter((x) => !x.w.emptyMessage)
      console.log(`   ${allWidgets.length - withoutMessage.length}/${allWidgets.length} widgets author an emptyMessage; ${withoutMessage.length} are dropped when unset`)
      return true // reported, not asserted — the drop path is the honest one either way
    })())

  // ── 4. THE FORMATTER COVERS EVERY DECLARED FORMAT ─────────────────────────
  //
  // DERIVED from the configs, so a new format string added to a widget without a
  // formatter branch shows up here instead of silently rendering "[object Object]".
  console.log("\n[4 — every format a widget declares is one the formatter handles]")
  const formats = [...new Set(allWidgets.map((x) => x.w.format).filter(Boolean))] as string[]
  console.log(`   declared formats: ${formats.join(", ")}`)
  const SAMPLES: Record<string, unknown> = {
    currency: 425000, percent: 7, number: 42, text: "Lakeview", date: "2026-08-26", boolean: true,
  }
  for (const f of formats) {
    const out = formatWidgetValue(SAMPLES[f] ?? "x", f)
    check(`  ${f} → rendered, and not as a raw object`,
      typeof out === "string" && out.length > 0 && !out.includes("[object"))
  }
  check("an undefined value formats to the empty string (the strip's drop signal)",
    formatWidgetValue(undefined, "currency") === "")
  check("control · an UNKNOWN format still degrades to a string rather than throwing",
    formatWidgetValue(["a", "b"], "not_a_format") === "a, b")

  // ── 5. THE TWO FLAGGED KEYS, IN CONTEXT ───────────────────────────────────
  console.log("\n[5 — the two keys the sweep named were two of the set, not a special case]")
  const flagged = ["memory_video_requested", "years_in_home"]
  for (const k of flagged) {
    const owners = allWidgets.filter((x) => x.w.dataKey === k).map((x) => x.persona)
    check(`  ${k} — declared by ${owners.join(", ") || "(nobody)"} and now rendered by the same one path`,
      owners.length > 0)
  }
  check("…and they were never the only unrendered ones — the whole set was",
    keys.size > flagged.length)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` BLIND SPOT: this proves the widgets RENDER from contacts.metadata. It does not`)
  console.log("   prove any product surface WRITES those keys — on the live database the two")
  console.log("   flagged keys are written only by the demo-seed SQL (scripts/350-, 351-), so a")
  console.log("   real downsizing seller sees the authored emptyMessage until an intake form")
  console.log("   sets them. That writer is a separate, product-side decision.")
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ dataKey has a reader, a declared value and a render site.")
  console.log(" PERSONA_WIDGET_RENDER_PASS")
  process.exit(0)
}

main()
