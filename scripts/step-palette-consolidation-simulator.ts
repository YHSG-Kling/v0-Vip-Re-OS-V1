#!/usr/bin/env tsx
/**
 * scripts/step-palette-consolidation-simulator.ts (npm run test:step-palette-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO BUILDERS, ONE TABLE, AND ELEVEN CHANNELS NOBODY COULD REACH.
 *
 * /dashboard/campaigns/workflows and /dashboard/campaigns/sequences/[id] edit
 * the SAME campaign_sequences / campaign_sequence_steps rows, and each restated
 * its own step list — 8 types in one, 7 channels in the other, 12 distinct
 * between them out of the 23 the executor dispatches. Three consequences:
 *
 *   1. A sequence built in one builder contained steps the other could not
 *      render. Opening it in the wrong builder HID those steps — and saving
 *      from there is how a step disappears.
 *   2. Eleven registered adapters (ad_campaign, ai_image, avm_cma,
 *      draft_document, listing_landing_page, newsletter, schedule_showing,
 *      schedule_tour, send_for_esign, send_gift, social_post) had no UI at all.
 *      Working, dispatchable code that no user could ever reach.
 *   3. The sequence builder offered "Voice", which the CHECK rejects outright.
 *
 * lib/workflow/step-palette.ts is now the ONE spec. This proves the three
 * things that must agree actually do:
 *
 *      the palette  ==  campaign_sequence_steps.channel CHECK  ==  the adapter
 *      (what a UI     (what the database will save)              registry
 *       may offer)                                              (what can run)
 *
 * Any one of those drifting is a defect with a distinct signature: offer > CHECK
 * is a rejected save, CHECK > registry is a step that saves and dies at
 * dispatch, registry > offer is code nobody can reach — which is exactly the
 * state this consolidation found.
 *
 * It also proves every field.name is a real column, so a builder cannot render
 * an input that writes nowhere, and that the two builders derive their palettes
 * rather than restating them.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import {
  STEP_PALETTE,
  STEP_GROUP_LABELS,
  COMMON_STEP_FIELDS,
  paletteChannels,
  paletteByGroup,
  stepSpec,
  missingRequiredFields,
  invalidFields,
  isInvalidValue,
  storableValue,
} from "../lib/workflow/step-palette"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("══════════════════════════════════════════════════")
console.log(" Step palette consolidation — one palette, and it matches what runs")
console.log("══════════════════════════════════════════════════")

const LIVE: readonly string[] = CHECK_VOCABULARIES.campaign_sequence_steps?.channel ?? []
const COLUMNS: readonly string[] = (SCHEMA_SNAPSHOT as Record<string, string[]>).campaign_sequence_steps ?? []

console.log("\n[the palette IS the database's vocabulary]")
{
  const offered = paletteChannels()
  check(`the CHECK admits ${LIVE.length} channels`, LIVE.length > 0)
  check(`the palette offers ${offered.length}`, offered.length > 0)

  const notSavable = offered.filter((c) => !LIVE.includes(c))
  check("nothing offered would be REJECTED on save", notSavable.length === 0, notSavable.join(", "))

  const unreachable = LIVE.filter((c) => !offered.includes(c))
  check("nothing the database accepts is UNREACHABLE from the UI", unreachable.length === 0, unreachable.join(", "))

  check("no channel is listed twice", new Set(offered).size === offered.length)
}

console.log("\n[every offered step has an adapter that can actually run it]")
{
  // Read the registry's registrations rather than importing it — importing pulls
  // in the whole provider stack. The registration list is the contract.
  const reg = src("lib/workflow/adapters/index.ts")
  const registered = new Set([...reg.matchAll(/channel:\s*"([\w]+)"/g)].map((m) => m[1]))
  // Adapters defined in their own files declare `channel:` there instead.
  for (const f of [
    "email", "sms", "voice-drop", "wait", "condition", "direct-mail", "video", "ai-image",
    "social-post", "newsletter", "assign-task", "draft-document", "schedule-showing",
    "schedule-tour", "avm-cma", "ad-campaign", "listing-landing-page", "send-for-esign",
    "send-gift", "segment-ops",
  ]) {
    for (const m of src(`lib/workflow/adapters/${f}.ts`).matchAll(/channel:\s*"([\w]+)"/g)) {
      registered.add(m[1])
    }
  }

  const noAdapter = paletteChannels().filter((c) => !registered.has(c))
  check("every step the palette offers has a registered adapter", noAdapter.length === 0, noAdapter.join(", "))

  const noUi = [...registered].filter((c) => !paletteChannels().includes(c) && LIVE.includes(c))
  check("no registered adapter is left without a UI (the 11 are wired now)", noUi.length === 0, noUi.join(", "))
}

console.log("\n[every field writes to a real column]")
{
  check("the snapshot knows the table", COLUMNS.length > 0)
  const bad: string[] = []
  for (const spec of STEP_PALETTE) {
    for (const f of spec.fields) {
      if (!COLUMNS.includes(f.name)) bad.push(`${spec.channel}.${f.name}`)
    }
  }
  check("no field would write to a column that does not exist", bad.length === 0, bad.join(", "))

  const badCommon = COMMON_STEP_FIELDS.filter((f) => !COLUMNS.includes(f.name)).map((f) => f.name)
  check("…and the common fields are real columns too", badCommon.length === 0, badCommon.join(", "))

  const noLabel = STEP_PALETTE.flatMap((s) => s.fields).filter((f) => !f.label.trim())
  check("every field has a label", noLabel.length === 0)

  const emptySelect = STEP_PALETTE.flatMap((s) => s.fields)
    .filter((f) => f.type === "select" && !(f.options && f.options.length > 0))
  check("no select is offered with an empty option list", emptySelect.length === 0,
    emptySelect.map((f) => f.name).join(", "))
}

console.log("\n[the grouping is honest — a 'produce' step contacts nobody]")
{
  // The owner's rule: video is NOT a channel, it is delivered in an email or an
  // SMS. The adapter agrees — it renders a clip and stores the URL. Grouping it
  // as a send would be the same lie the old "Video" channel entry told.
  const video = stepSpec("video")
  check("video exists as a step", !!video)
  check("…and is grouped as PRODUCE, not as a delivery channel", video?.group === "produce")
  check("…and says so in words a broker reads",
    !!video && /delivers nothing on its own/i.test(video.description))

  const produce = STEP_PALETTE.filter((s) => s.group === "produce").map((s) => s.channel)
  // commission_video joined this group when it was finally made selectable: the
  // adapter had been registered all along with no palette entry and no CHECK
  // value, so it was unpickable AND unsavable. It is a producer for the same
  // reason `video` is — it makes an asset a later Email or SMS step delivers.
  check("the produce group is exactly the asset-makers",
    ["video", "commission_video", "ai_image", "avm_cma", "draft_document"].every((c) => produce.includes(c)) &&
    produce.length === 5)

  const groups = paletteByGroup()
  check("every group rendered has steps in it", groups.every((g) => g.steps.length > 0))
  check("the groups partition the palette exactly",
    groups.flatMap((g) => g.steps).length === STEP_PALETTE.length)
  check("every group has a human label", groups.every((g) => !!STEP_GROUP_LABELS[g.group]))
}

console.log("\n[required fields are caught before save, not at dispatch]")
{
  // An ad with no platform SAVES fine — channel is the only CHECK on the table —
  // and then dies in the adapter with "No ad platform configured", days later,
  // in a cron. The builder refuses it up front instead.
  check("an ad campaign with no platform is refused",
    missingRequiredFields("ad_campaign", { ad_budget_cents: 5000 }).some((f) => f.name === "ad_platform"))
  check("…and a complete one is accepted",
    missingRequiredFields("ad_campaign", { ad_platform: "facebook", ad_budget_cents: 5000 }).length === 0)
  check("blank-but-present still counts as missing",
    missingRequiredFields("email", { subject: "   ", body: "hi" }).some((f) => f.name === "subject"))
  check("an empty list counts as missing",
    missingRequiredFields("schedule_tour", { tour_property_ids: [] }).length === 1)
  check("a step with no required fields is always complete",
    missingRequiredFields("wait", {}).length === 0)
  check("an unknown channel reports nothing rather than throwing",
    missingRequiredFields("not_a_channel", {}).length === 0)
}

console.log("\n[both builders DERIVE the palette — neither restates it]")
{
  const seq = src("app/dashboard/campaigns/sequences/[id]/SequenceBuilderClient.tsx")
  const wf = src("app/dashboard/campaigns/workflows/workflow-builder-client.tsx")

  // Both reach the palette through the shared controls; the workflow builder
  // also imports it directly for its grouped "Add step" rail. Either way the
  // point is the same: neither owns a list.
  const derives = (s: string) =>
    /from "@\/lib\/workflow\/step-palette"/.test(s) ||
    /from "@\/app\/components\/campaigns\/step-type-select"/.test(s)
  check("the sequence builder derives its steps from the shared palette", derives(seq))
  check("the workflow builder derives its steps from the shared palette", derives(wf))
  check("both render the shared step picker",
    /<StepTypeSelect/.test(seq) && /<StepTypeSelect/.test(wf))
  check("both render the shared per-step field editor",
    /<StepFieldsEditor/.test(seq) && /<StepFieldsEditor/.test(wf))

  // The exact defect that started this: a hand-kept list next to the shared one.
  check("the sequence builder no longer keeps its own CHANNELS array", !/const CHANNELS = \[/.test(seq))
  check("the workflow builder no longer keeps its own STEP_TYPES array", !/const STEP_TYPES = \[/.test(wf))
  check("neither still offers the 'voice' channel the CHECK rejects",
    !/value: "voice"/.test(seq) && !/value: "voice"/.test(wf))
}

console.log("\n[the field types match the COLUMN types, not just the column names]")
{
  // Verified against information_schema: seven of these columns are `uuid`,
  // tour_property_ids is `uuid[]` (not text[]), and three integers are NOT NULL.
  // A plain text box over a uuid column turns a typo into "invalid input syntax
  // for type uuid" from Postgres and loses the whole save; a cleared box over a
  // NOT NULL integer writes null and the row is rejected outright.
  const UUID_COLUMNS = [
    "document_template_id", "esign_document_id", "gift_provider_id",
    "listing_page_template_id", "newsletter_template_id", "showing_property_id",
    "task_assignee_id",
  ]
  const byName = new Map(STEP_PALETTE.flatMap((s) => s.fields).map((f) => [f.name, f]))
  for (const c of UUID_COLUMNS) {
    check(`${c} is typed uuid, not free text`, byName.get(c)?.type === "uuid")
  }
  check("tour_property_ids is a uuid LIST (the column is uuid[], not text[])",
    byName.get("tour_property_ids")?.type === "uuid_csv")
  for (const c of ["showing_duration_minutes", "task_due_offset_days", "tour_date_offset_days"]) {
    check(`${c} is marked NOT NULL with a fallback`,
      byName.get(c)?.notNull === true && typeof byName.get(c)?.fallback === "number")
  }

  const uuidField = byName.get("showing_property_id")!
  check("a name typed into a uuid field is caught here, not by Postgres",
    isInvalidValue(uuidField, "the Elm Street one"))
  check("…a real uuid passes", !isInvalidValue(uuidField, "231f4e64-5022-4752-8047-696886551c35"))
  check("…and blank is never 'invalid' (that is what required is for)",
    !isInvalidValue(uuidField, "") && !isInvalidValue(uuidField, null))
  const listField = byName.get("tour_property_ids")!
  check("one bad id in a list invalidates the list",
    isInvalidValue(listField, ["231f4e64-5022-4752-8047-696886551c35", "nope"]))
  check("invalidFields names the offender",
    invalidFields("schedule_showing", { showing_property_id: "not-an-id" })
      .some((f) => f.name === "showing_property_id"))

  check("a cleared NOT NULL integer falls back instead of writing null",
    storableValue(byName.get("showing_duration_minutes")!, "") === 30)
  check("…while a nullable field still clears to null",
    storableValue(byName.get("showing_notes")!, "") === null)
}

console.log("\n[what the builder collects is what the save writes]")
{
  // The other half of the defect, and the quieter half. Rendering a field is
  // pointless if the save drops it — and the save DID drop it: buildRow listed
  // about half the palette's columns by hand, and the workflow builder's own
  // two extra inputs wrote to `task_description` and `segment_name`, neither of
  // which is a column on the table at all. Every keystroke went nowhere.
  const act = src("app/actions/campaign-sequences.ts")
  check("the save derives its columns from the palette, not a hand-kept list",
    /PALETTE_STEP_FIELDS/.test(act) && /STEP_PALETTE\.flatMap/.test(act))
  check("…and uses it as an ALLOW-LIST, so an arbitrary key cannot reach a column",
    /for \(const name of PALETTE_STEP_FIELDS\)/.test(act))

  const wf = src("app/dashboard/campaigns/workflows/workflow-builder-client.tsx")
  const phantom = ["task_description", "segment_name"].filter((f) =>
    new RegExp(`(setEditingStep|updateLocalStep)[\\s\\S]{0,120}${f}\\s*:`).test(wf))
  check("no builder still writes a field that is not a column", phantom.length === 0, phantom.join(", "))
  for (const f of ["task_description", "segment_name"]) {
    check(`${f} is not a column on campaign_sequence_steps (it never was)`, !COLUMNS.includes(f))
  }

  // Three surfaces write steps through createSequenceStep. It took the service
  // client straight to an INSERT with no ownership check at all.
  check("createSequenceStep verifies the sequence belongs to the caller",
    /export async function createSequenceStep[\s\S]{0,1400}?brokerage_id !== ctx\.brokerageId/.test(act))
  check("updateSequenceStep does too",
    /export async function updateSequenceStep[\s\S]{0,1400}?ownerBrokerage !== ctx\.brokerageId/.test(act))
  check("…and both reject a channel the CHECK would refuse",
    (act.match(/VALID_STEP_TYPES\.has/g) ?? []).length >= 4)
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ STEP_PALETTE_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ STEP_PALETTE_CONSOLIDATION_PASS — one palette; UI, database and executor agree")
