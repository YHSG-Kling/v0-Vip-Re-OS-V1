#!/usr/bin/env tsx
/**
 * scripts/guided-video-card-guard.ts  (npm run test:guided-video-card) — pure, no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DESCRIBE-A-VIDEO CARD GUIDES — DERIVED NEEDS, ROUTED + BOOKED WORDING HELP,
 * FAIR-HOUSING-SCANNED SUGGESTIONS, THE TOPIC POOL ON THE CARD.
 *
 * OWNER (2026-09-25): "on the describe video card, when you pick this kind of
 * video, the ai then tells the user what they will need and assist on their
 * wording in the text boxes during the process … on the card they can also pick
 * from the topic pool."
 *
 * Asserted:
 *   §needs      the checklist for EVERY archetype is derived from the registries
 *               (band numbers, one bring-line per need, one host line per derived
 *               host) and spoken in plain words (no internal jargon) (+ control).
 *   §suggest    suggestions are cleaned, de-duplicated, never echo the input,
 *               capped at 3 and at the field's length, and a flagged one is DROPPED
 *               and counted (+ positive control: an all-flagging scanner drops all).
 *   §actions    every export of the "use server" file is async; each new action
 *               resolves the SESSION caller before any model/pool call; model calls
 *               are routed + booked (feature video_brief_guide, brokerageId from the
 *               session); model words are fair-housing scanned before return; the
 *               model's absence leaves the derived checklist (aiAvailable:false);
 *               a picked topic is re-read under the tenant's visibility and claimed
 *               only after a staged commission; no body-supplied brokerageId.
 *   §card       the card calls all three new actions (no orphan actions), mounts
 *               wording help on all five text boxes, debounces with cleanup, lets
 *               the person accept ("Use this") into an editable box, and sends the
 *               topic id; the card is mounted on /dashboard/videos/create.
 *
 * BLIND SPOTS (published): the model's tone is not measured (the prompt asks for
 * warmth; a human reads it); the UI is proven by source shape, not by a browser.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import {
  GUIDE_FIELDS, GUIDE_FIELD_SPECS, SUGGEST_DEBOUNCE_MS, allChecklists, cleanSuggestion, needsChecklist, readyToSuggest, sanitizeSuggestions,
} from "../lib/video/video-guide"
import {
  CUSTOM_ARCHETYPE_REGISTRY, CUSTOM_VIDEO_ARCHETYPES, archetypeHosts, compositionsForPurposeAndHost, pickCompositionForChannel, planCustomVideo,
} from "../lib/video/custom-video-archetypes"
import { geometryFor } from "../lib/remotion/composition-geometry"
import { PURPOSE_DURATION_RULES } from "../lib/video/duration-model"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

console.log("\n── §needs · derived, plain-spoken ──")
{
  const all = allChecklists()
  check(`a checklist for every archetype (${all.length}/${CUSTOM_VIDEO_ARCHETYPES.length})`, all.length === CUSTOM_VIDEO_ARCHETYPES.length)
  const jargon = (s: string) => /\b(archetype|composition|purpose|host kind|body[- ]visual|registry)\b/i.test(s)
  check("POSITIVE CONTROL: the jargon detector sees 'archetype'", jargon("pick an archetype"))
  for (const a of CUSTOM_VIDEO_ARCHETYPES) {
    const c = needsChecklist(a)
    const spec = CUSTOM_ARCHETYPE_REGISTRY[a]
    const band = PURPOSE_DURATION_RULES[spec.basePurpose]
    const needKeys = Object.entries(spec.needs).filter(([, v]) => Boolean(v)).length
    const derived = c.targetSeconds === band.idealSeconds && c.length.includes(`${band.minSeconds}–${band.maxSeconds}`)
      && c.bring.length === needKeys && c.onCamera.length === archetypeHosts(a).length
    const plain = ![c.headline, ...c.bring, c.length, ...c.onCamera, c.nextStep].some(jargon)
    check(`${a}: band ${band.minSeconds}-${band.maxSeconds}s (ideal ${band.idealSeconds}), ${needKeys} bring-line(s), ${archetypeHosts(a).length} host line(s) — derived and plain`, derived && plain)
  }
  check("the not-salesy closing steps carry no urgency words", !allChecklists().some((c) => /\b(now|hurry|today only|act fast|don't miss|limited)\b/i.test(c.nextStep)))
}

console.log("\n── §suggest · cleaned, capped, scanned ──")
{
  const never = () => false
  const r = sanitizeSuggestions(['"Explain closing costs in three steps"', "explain closing costs in three steps", "", "Help buyers see where closing money goes", "A third one", "A fourth one"], "Explain closing costs", "goal", never)
  check("quotes stripped, duplicates collapsed, empties dropped, capped at 3", r.kept.length === 3 && r.kept[0] === "Explain closing costs in three steps" && !r.kept.includes(""))
  check("a suggestion identical to the input is never offered back", sanitizeSuggestions(["Explain closing costs"], "  explain  closing costs ", "goal", never).kept.length === 0)
  check("each suggestion is capped at the field's length", sanitizeSuggestions(["x".repeat(500)], "", "title", never).kept[0].length === GUIDE_FIELD_SPECS.title.maxChars)
  const flagged = sanitizeSuggestions(["Perfect for young families", "Close to parks and shopping"], "", "audience", (s) => /famil/i.test(s))
  check("a flagged suggestion is DROPPED and counted", flagged.kept.join("|") === "Close to parks and shopping" && flagged.droppedForFairHousing === 1)
  check("POSITIVE CONTROL: an all-flagging scanner drops everything", sanitizeSuggestions(["a b c", "d e f"], "", "goal", () => true).kept.length === 0)
  check("cleanSuggestion is idempotent (the server flags exactly what it later keeps)", cleanSuggestion(cleanSuggestion('  "Hello there"  ', "title"), "title") === cleanSuggestion('  "Hello there"  ', "title"))
  check("suggestions wait for a few words (improving beats writing from blank) and a sane upper bound", !readyToSuggest("goal", "hi") && readyToSuggest("goal", "Invite past clients") && !readyToSuggest("title", "x".repeat(500)))
  check(`the typing pause is ${SUGGEST_DEBOUNCE_MS} ms (between 800 and 2000 — responsive, not chatty)`, SUGGEST_DEBOUNCE_MS >= 800 && SUGGEST_DEBOUNCE_MS <= 2000)
  check(`coaching copy exists for all ${GUIDE_FIELDS.length} boxes`, GUIDE_FIELDS.every((f) => GUIDE_FIELD_SPECS[f].coach.length > 20))
  check("the audience box coaches the fair-housing way (a situation, not a people-group)", /situation/i.test(GUIDE_FIELD_SPECS.audience.coach))
}

console.log("\n── §actions · session first, routed + booked, scanned ──")
{
  const raw = read("app/actions/custom-video.ts")
  const src = stripComments(raw)
  check('the file is "use server"', /^\s*["']use server["']/.test(raw))
  const exportedFns = Array.from(blankStrings(src).matchAll(/export\s+(async\s+)?function\s+(\w+)/g))
  const syncExports = exportedFns.filter((m) => !m[1]).map((m) => m[2])
  check(`every exported function is async (${exportedFns.length} exports)`, syncExports.length === 0, syncExports.join(", "))
  check("no exported const/let in a use-server file", !/export\s+(const|let)\s+/.test(blankStrings(src)))
  const body = (name: string) => { const i = src.indexOf(`export async function ${name}`); const j = src.indexOf("export ", i + 10); return i < 0 ? "" : src.slice(i, j < 0 ? undefined : j) }
  for (const name of ["listVideoTopicPoolAction", "getVideoGuideAction", "suggestVideoWordingAction"]) {
    const b = body(name)
    const caller = b.indexOf("resolveCaller()")
    const firstIo = Math.min(...["generateObjectRouted(", "pickTopics(", "createServiceClient()"].map((k) => { const i = b.indexOf(k); return i < 0 ? Infinity : i }))
    check(`${name}: resolves the SESSION caller before any model/pool/service call`, caller > 0 && caller < firstIo)
  }
  const routed = Array.from(src.matchAll(/generateObjectRouted\(\{([\s\S]{0,1200}?)schema:/g)).map((m) => m[1])
  check(`every model call is routed with feature video_brief_guide and the session's brokerageId (${routed.length} calls)`,
    routed.length >= 2 && routed.every((c) => /feature:\s*"video_brief_guide"/.test(c) && /brokerageId:\s*auth\.caller\.brokerageId/.test(c) && /userId:\s*auth\.caller\.userId/.test(c)))
  const route = readStripped("lib/ai/models.ts")
  check("AI_TASK_ROUTING has video_brief_guide on the fast (haiku) lane", /video_brief_guide:\s*\{\s*model:\s*"claude-haiku"/.test(route))
  const guide = body("getVideoGuideAction"), suggest = body("suggestVideoWordingAction")
  check("guide: model words are fair-housing scanned before return, and an outage returns the derived checklist (aiAvailable:false)",
    /flagsFor\(object\.reassurance\)/.test(guide) && /flagsFor\(t\)/.test(guide) && /aiAvailable:\s*false/.test(guide) && /checklist,\s*reassurance:\s*null/.test(guide))
  check("suggest: every suggestion is scanned, flagged ones dropped via sanitizeSuggestions; the person's own words get a heads-up",
    /flagsFor\(s\)/.test(suggest) && /sanitizeSuggestions\(cleaned,/.test(suggest) && /const warnings = await flagsFor\(text\)/.test(suggest))
  check("flagsFor runs the ONE fair-housing scanner for both journeys", /detectFairHousingRedFlags\(text,\s*"buyer"\)/.test(src) && /detectFairHousingRedFlags\(text,\s*"seller"\)/.test(src))
  check("a picked topic is re-read under the tenant's visibility (own row or the platform-wide bank)", /\.or\(`brokerage_id\.is\.null,brokerage_id\.eq\.\$\{brokerageId\}`\)/.test(src))
  const create = body("createDescribedVideoAction")
  check("create: a topic is claimed only AFTER a staged commission, with the project as the asset",
    create.indexOf("commissionCustomVideo(") > 0 && create.indexOf("logTopicUses(") > create.indexOf("commissionCustomVideo(") && /r\.status === "staged" && r\.videoProjectId/.test(create))
  const inputIface = /export interface DescribeVideoInput \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? ""
  check("the request body carries no brokerageId/userId (tenant from the session only)", inputIface.length > 0 && !/brokerageId|userId/.test(inputIface))
}

console.log("\n── §card · mounted, wired, supportive ──")
{
  const card = readStripped("app/dashboard/videos/create/describe-video-card.tsx")
  for (const a of ["listVideoTopicPoolAction", "getVideoGuideAction", "suggestVideoWordingAction"]) {
    check(`the card calls ${a} (no orphan action)`, new RegExp(`${a}\\(`).test(card))
  }
  const helped = GUIDE_FIELDS.filter((f) => new RegExp(`<WordingHelp field="${f}"`).test(card))
  check(`wording help is mounted on every text box (${helped.length}/${GUIDE_FIELDS.length})`, helped.length === GUIDE_FIELDS.length, GUIDE_FIELDS.filter((f) => !helped.includes(f)).join(", "))
  check("the pause is the shared SUGGEST_DEBOUNCE_MS and the timer is cleared on every keystroke", /setTimeout\([\s\S]{0,600}SUGGEST_DEBOUNCE_MS\)/.test(card) && /return \(\) => clearTimeout\(timer\)/.test(card))
  check("stale replies are ignored (a request sequence)", /mine === seq\.current/.test(card))
  check("\"Use this\" puts the suggestion into the box (still editable) — nothing is written silently", /onUse\(s\)/.test(card) && /Use this/.test(read("app/dashboard/videos/create/describe-video-card.tsx")))
  check("the picked topic travels with the commission (topicId)", /topicId:\s*topic\?\.id \?\? null/.test(card))
  check("the guide re-asks when the kind or the topic changes", /\[archetypeHint,\s*topic\?\.id\]/.test(card))
  check("the offline guide still shows the exact checklist", /aiAvailable === false/.test(card))
  const mount = readStripped("app/dashboard/videos/create/video-create-client.tsx")
  check("the card is mounted on /dashboard/videos/create", /<DescribeVideoCard\b/.test(mount))
}

console.log("\n── §channel · 81C open item closed: the composition follows the channel ──")
{
  const cands = compositionsForPurposeAndHost("listing_promo", "voiceover")
  const orient = (id: string) => { const g = geometryFor(id); return g ? (g.height > g.width ? "vertical" : g.width > g.height ? "horizontal" : "square") : "?" }
  console.log(`    listing_promo on voiceover: ${cands.map((c) => `${c}(${orient(c)})`).join(", ")}`)
  const hasBoth = cands.some((c) => orient(c) === "horizontal") && cands.some((c) => orient(c) === "vertical")
  check("the fixture purpose has both orientations registered (else the pick is untestable)", hasBoth)
  check("youtube → a horizontal composition; instagram/tiktok → a vertical one (registered geometry)",
    orient(pickCompositionForChannel(cands, "youtube") ?? "") === "horizontal" && orient(pickCompositionForChannel(cands, "instagram") ?? "") === "vertical" && orient(pickCompositionForChannel(cands, "tiktok") ?? "") === "vertical")
  check("no channel / an unknown channel → the registry's first (unchanged behaviour)", pickCompositionForChannel(cands, null) === cands[0] && pickCompositionForChannel(cands, "email") === cands[0])
  const plan = planCustomVideo({ audience: "neighbours", goal: "Invite them to our open house this Saturday", host: "voiceover", assets: { avatarClip: false, brollClips: 0, propertyPhotos: 3, screenshots: 0, statCards: 0, clientFootage: 0, chartData: false }, targetChannel: "youtube" })
  check("a described event promo for YouTube plans onto the horizontal composition", plan.ok && orient(plan.plan.compositionId) === "horizontal", plan.ok ? plan.plan.compositionId : plan.reason)
  check("the card's action threads the channel into the brief", /targetChannel:\s*input\.targetChannel \?\? null/.test(readStripped("app/actions/custom-video.ts")))
}

console.log("\n── §registered · package.json, ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:guided-video-card runs this file and sits in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:guided-video-card"] === "tsx scripts/guided-video-card-guard.ts" && guard.indexOf("npm run test:scrapers") !== -1 && guard.indexOf("npm run test:guided-video-card") > guard.indexOf("npm run test:scrapers"))
  check("manager-registry: MAINTENANCE_DOMAINS.guided_video_card names asset_manager with co-owners", /guided_video_card:\s*\{ manager: "asset_manager", proof: "test:guided-video-card", coOwners: \[[^\]]+\]/.test(readStripped("lib/kernel/manager-registry.ts")))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
