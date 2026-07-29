#!/usr/bin/env tsx
/**
 * scripts/sequence-step-palette-guard.ts (npm run test:sequence-step-palette) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A STEP PICKER OFFERED A STEP THE DATABASE COULD NEVER SAVE.
 *
 * The sequence builder's channel list contained "voice". campaign_sequence_steps
 * .channel does not admit it — the real channels are 'voice_drop' (ringless
 * voicemail) and 'ai_call' (a live AI call), separate adapters with separate
 * consent implications. Choosing Voice produced an INSERT rejected by
 * campaign_sequence_steps_channel_check. Verified live: 'voice' rejected,
 * 'voice_drop' and 'ai_call' both accepted.
 *
 * The CHECK-vocabulary guard could not catch it. That guard reads literals in
 * WRITE PAYLOADS; this value sat in a const array feeding a <Select>, and only
 * became a payload at run time, in the browser, from the user's choice.
 *
 * ── THE WIDER GAP THIS PINS ─────────────────────────────────────────────────
 * Two builders edit the same campaign_sequences/campaign_sequence_steps rows and
 * neither offers what the other does:
 *
 *   /dashboard/campaigns/workflows        8 types: email, sms, direct_mail,
 *                                         wait, condition, assign_task,
 *                                         add_to_segment, remove_from_campaign
 *   /dashboard/campaigns/sequences/[id]   video, in_app, voice_drop, ai_call
 *                                         (+ email, sms, direct_mail)
 *
 * So a sequence built in one contains steps the other cannot render, and editing
 * it in the wrong builder hides them. Between them they now reach 12 of the 23
 * channels the executor can dispatch (10 before this fix) — lib/workflow/adapters registers 24
 * adapters, and ad_campaign, ai_image, avm_cma, draft_document,
 * listing_landing_page, newsletter, schedule_showing, schedule_tour,
 * send_for_esign, send_gift and social_post still have no UI anywhere.
 *
 * Consolidating the two builders onto a registry-derived palette is the real
 * fix and a real build. Until then this guard holds the line that matters most:
 * everything a picker OFFERS must be something the database ACCEPTS.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { LISTING_STATUSES } from "../lib/constants"
import {
  VENDOR_CATEGORIES,
  VENDOR_CATEGORY_GROUPS,
  VENDOR_CATEGORY_LABELS,
} from "../lib/kernel/vendor-categories"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/** PURE — the `value: "…"` entries of a named const array in a client file. */
export function paletteValues(source: string, constName: string): string[] {
  const start = source.indexOf(`const ${constName} = [`)
  if (start === -1) return []
  const open = source.indexOf("[", start)
  let depth = 0, end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++
    else if (source[i] === "]") { depth--; if (depth === 0) { end = i; break } }
  }
  return [...source.slice(open, end).matchAll(/value:\s*"([\w]+)"/g)].map((m) => m[1])
}

const LIVE: readonly string[] = CHECK_VOCABULARIES.campaign_sequence_steps?.channel ?? []

console.log("══════════════════════════════════════════════════")
console.log(" Sequence step palette (a picker may only offer a savable step)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the extractor]")
{
  const sample = `const X = [\n  { value: "email", label: "E" },\n  { value: "sms", label: "S" },\n]\n`
  check("reads value: entries from a const array", JSON.stringify(paletteValues(sample, "X")) === '["email","sms"]')
  check("returns nothing for an absent const", paletteValues(sample, "NOPE").length === 0)
}

console.log("\n[the live vocabulary]")
{
  check(`campaign_sequence_steps.channel admits ${LIVE.length} channels`, LIVE.length > 0)
  check("'voice' is NOT one of them — that was the bug", !LIVE.includes("voice"))
  check("'voice_drop' and 'ai_call' ARE — those are the real ones",
    LIVE.includes("voice_drop") && LIVE.includes("ai_call"))
}

const PALETTES: Array<{ file: string; constName: string }> = [
  { file: "app/dashboard/campaigns/sequences/[id]/SequenceBuilderClient.tsx", constName: "CHANNELS" },
  { file: "app/dashboard/campaigns/workflows/workflow-builder-client.tsx",    constName: "STEP_TYPES" },
]

console.log("\n[every offered step is one the database accepts]")
const offered = new Set<string>()
for (const { file, constName } of PALETTES) {
  const values = paletteValues(src(file), constName)
  check(`${constName} was found and is non-empty (${values.length})`, values.length > 0)
  const invalid = values.filter((v) => !LIVE.includes(v))
  check(`${constName}: every value is an admitted channel`, invalid.length === 0, invalid.join(", "))
  values.forEach((v) => offered.add(v))
}

console.log("\n[the coverage gap, held visible rather than rediscovered]")
{
  const missing = LIVE.filter((c) => !offered.has(c))
  console.log(`  · ${offered.size} of ${LIVE.length} dispatchable channels are offered by some builder`)
  console.log(`  · no UI anywhere for: ${missing.join(", ")}`)
  check("the two builders together cover at least the 12 reached today",
    offered.size >= 12, `only ${offered.size}`)
  check("the voicemail + AI-call channels are reachable by a user now",
    offered.has("voice_drop") && offered.has("ai_call"))
  // Not a failure — a standing, honest count. It fails only if coverage REGRESSES.
  check("coverage never silently shrinks below what is wired today",
    offered.size >= 12 && missing.length <= LIVE.length - 12)
}

console.log("\n[the same class, elsewhere: the listing phase picker]")
{
  // Found by sweeping every .tsx option list against the live CHECK vocabularies
  // after the "voice" bug — the defect generalises, so the check does too.
  // listings.status had THREE disagreeing vocabularies: the CHECK (10), a
  // LISTING_STATUSES constant with ZERO consumers (6), and the picker (7,
  // including "under_contract" — a TRANSACTION status the column rejects).
  const live = CHECK_VOCABULARIES.listings?.status ?? []
  check("listings.status does NOT admit 'under_contract' (it is a transaction status)",
    !live.includes("under_contract"))
  check("the canonical LISTING_STATUSES now matches the column exactly",
    LISTING_STATUSES.length === live.length &&
    LISTING_STATUSES.every((s2) => live.includes(s2)))
  check("…and every phase the owner's process names is in it",
    ["listing_signed", "coming_soon", "active", "withdrawn", "cancelled", "off_market", "sold"]
      .every((s2) => (LISTING_STATUSES as readonly string[]).includes(s2)))
  const picker = src("app/components/dashboard/listings/listing-status-select.tsx")
  check("the picker DERIVES its options instead of restating them",
    /LISTING_STATUSES\.map/.test(picker) && !/value: "under_contract"/.test(picker))
  const action = src("app/actions/listings-kernel.ts")
  check("updateListingStatus rejects a non-phase before it reaches the CHECK",
    /isListingStatus\(status\)/.test(action))
  check("…and the constant is no longer a dead list (the picker + action use it)",
    /LISTING_STATUSES/.test(picker) && /LISTING_STATUSES/.test(action))
}

console.log("\n[the same class, elsewhere: the vendor category picker]")
{
  // The third instance of the defect, and the worst of the three: vendors.category
  // was authored by a free-text <Input> whose placeholder read "e.g., Home
  // Inspection, Photography" — under BOTH the pre-m304 six-value Title-Case CHECK
  // and the post-m304 38-value one, typing either suggestion produced a rejected
  // INSERT. A CHECK-constrained column may only be authored by a control that
  // cannot express a value outside the CHECK.
  const live = CHECK_VOCABULARIES.vendors?.category ?? []
  check(`vendors.category admits ${live.length} values`, live.length > 0)
  check("the vocabulary module matches the column exactly",
    VENDOR_CATEGORIES.length === live.length &&
    VENDOR_CATEGORIES.every((c) => live.includes(c)))
  check("…and it is the SAME taxonomy vendor_directory uses (m304)",
    (CHECK_VOCABULARIES.vendor_directory?.category ?? []).length === live.length)

  // The groups are what the picker renders. If they drifted from the vocabulary a
  // category would either never appear in the UI or appear twice — so they are
  // proved to PARTITION it, not merely to overlap it.
  const grouped = VENDOR_CATEGORY_GROUPS.flatMap((g) => g.categories)
  check("every category appears in exactly one picker group",
    grouped.length === VENDOR_CATEGORIES.length &&
    new Set(grouped).size === grouped.length &&
    VENDOR_CATEGORIES.every((c) => grouped.includes(c)))
  check("every category has a display label",
    VENDOR_CATEGORIES.every((c) => !!VENDOR_CATEGORY_LABELS[c]))

  const picker = src("app/components/vendors/vendor-category-select.tsx")
  check("the picker DERIVES its options from the vocabulary",
    /VENDOR_CATEGORY_GROUPS\.map/.test(picker) && /VENDOR_CATEGORY_LABELS\[c\]/.test(picker))
  const dialog = src("app/dashboard/vendors/vendor-directory-client.tsx")
  check("the Add Vendor dialog uses the picker, not a free-text box",
    /<VendorCategorySelect/.test(dialog))
  // Scoped to the CATEGORY control specifically. The booking dialog on the same
  // page keeps a free-text "e.g., Home Inspection" box, and correctly so —
  // vendor_bookings.service_type has no CHECK. The rule is not "no free text on
  // this page", it is "no free text into a constrained column".
  check("…and the category state is no longer bound to a free-text Input",
    !/<Input[^>]*value=\{newVendorCategory\}/s.test(dialog))

  // The write path refuses in words rather than relaying a Postgres constraint.
  const kernel = src("lib/kernel/vendors.ts")
  check("createVendorRecord normalises through the vocabulary before INSERT",
    /toVendorCategory\(category\)/.test(kernel))
  check("updateVendorRecord does the same (a blind patch spread would not)",
    /toVendorCategory\(nextPatch\.category\)/.test(kernel))
  check("no second, untyped vendor writer survives",
    !/from\("vendors"\)\.insert\(vendor\)/.test(src("services/supabaseService.ts")))

  // The classifier is what makes the widened bench REACHABLE rather than merely
  // spellable: before m304 it could only ever emit six of the values.
  const classifier = src("lib/contacts/card-classifier.ts")
  const emitted = new Set([...classifier.matchAll(/category: "([\w]+)"/g)].map((m) => m[1]))
  check(`the business-card classifier can emit ${emitted.size} categories, not 6`, emitted.size >= 30)
  check("…and every one of them is an admitted value",
    [...emitted].every((c) => live.includes(c)))
  const scanner = src("app/actions/business-card/business-card-actions.ts")
  check("the scanner's fallback is the constant, not the Title-Case 'Other' the CHECK rejects",
    /VENDOR_CATEGORY_OTHER/.test(scanner) && !/\?\? "Other"/.test(scanner))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ SEQUENCE_STEP_PALETTE_FAIL"); process.exit(1) }
console.log(" ✅ SEQUENCE_STEP_PALETTE_PASS — no picker offers a step the database rejects")
