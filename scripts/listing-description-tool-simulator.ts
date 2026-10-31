/**
 * scripts/listing-description-tool-simulator.ts   (npm run test:listing-description-tool)
 *
 * WAVE 87, LANE 87B. Owner, verbatim (2026-09-28): "listing description can be an ai
 * tool for agents and can assist with a new listing marketing."
 *
 * Proves, with no network and no model spend:
 *   §1 ONE STYLE VOCABULARY (lib/listings/listing-description-styles.ts): the agent's
 *      pick is a member; the legacy "investment" merges onto "investor"; the retired
 *      "family" (familial status — Fair Housing) is never a member and normalizes to
 *      the NEUTRAL default, never to another audience; nothing value-derived survives
 *      (lane 86F's $1M floor is gone from the deck builder).
 *   §2 COMPLIANCE-FIRST release rule (descriptionReleaseDecision): warnings pass
 *      through; a HARD Fair-Housing flag or a check that could not run WITHHOLDS the
 *      copy (fail closed) — with controls both ways.
 *   §3 THE TOOL on an in-memory client: a listing outside the caller's tenant is
 *      refused BEFORE the writer runs (no model call is reachable), a listing with no
 *      agent and a caller with no agent profile is refused by name; the kit-draft
 *      reader never offers a hard-flagged draft and is tenant-pinned.
 *   §4 WIRING (stripped source): the session action, the Marketing Studio panel, the
 *      agent copilot tool and the new-listing kit (launch war room) all reach the ONE
 *      server-only tool → core; the duplicate kernel writer is gone (tombstone kept);
 *      the core writes with the compliance blocks + the style guide IN the prompt and
 *      no "Target Audience" framing; the copilot tool takes its tenant from the session.
 *
 * BLIND SPOTS (published): the model call itself is not executed (it would spend);
 * the copy's quality is not graded here — script-compliance's postcheck and
 * guardContent are proven by their own proofs; the Studio panel is proven mounted,
 * not rendered.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  LISTING_DESCRIPTION_STYLES,
  DEFAULT_LISTING_DESCRIPTION_STYLE,
  normalizeListingDescriptionStyle,
  isListingDescriptionStyle,
  LISTING_DESCRIPTION_STYLE_GUIDE,
} from "../lib/listings/listing-description-styles"
import {
  descriptionReleaseDecision,
  draftListingDescriptionForListing,
  latestListingDescriptionDraft,
} from "../lib/listings/listing-description-tool"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const code = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

type Row = Record<string, any>
function fakeSvc(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    const run = () => ({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null })
    const q: any = {
      select: () => q, order: () => q, limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q },
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return q
  }
  return { from } as any
}

async function main() {
  console.log("\n── §1 one style vocabulary ──")
  check("the agent picks from exactly four property-voice styles", LISTING_DESCRIPTION_STYLES.length === 4 && LISTING_DESCRIPTION_STYLES.every(isListingDescriptionStyle))
  check("'family' is NOT a style (familial status — Fair Housing)", !isListingDescriptionStyle("family"))
  check("a posted 'family' normalizes to the NEUTRAL default, never another audience", normalizeListingDescriptionStyle("family") === DEFAULT_LISTING_DESCRIPTION_STYLE && DEFAULT_LISTING_DESCRIPTION_STYLE === "standard")
  check("legacy 'investment' merges onto 'investor' (§6)", normalizeListingDescriptionStyle("investment") === "investor")
  check("an unknown value normalizes to the default", normalizeListingDescriptionStyle("anything") === "standard" && normalizeListingDescriptionStyle(undefined) === "standard")
  check("[control] a real pick survives normalization", normalizeListingDescriptionStyle("luxury") === "luxury")
  const guides = Object.values(LISTING_DESCRIPTION_STYLE_GUIDE).join(" ").toLowerCase()
  check("no style guide aims the copy at a household type", !/\bfamil|\bkids?\b|\bchildren\b|\bcouples?\b|\bretirees?\b/.test(guides))
  check("[control] the household-type finder catches a family framing", /\bfamil/.test("emphasize family-friendly features"))
  const builder = code("lib/workflow/intelligence/listing-presentation-builder.ts")
  check("the deck builder has no value-derived style rule (lane 86F's $1M floor retired)",
    !/LUXURY_DECK_VALUE_FLOOR|>=\s*1_000_000\s*\?\s*"luxury"/.test(builder) && /deckDescriptionStyle\(input\.descriptionStyle\)/.test(builder))
  check("[control] the value-rule finder catches the retired shape",
    /LUXURY_DECK_VALUE_FLOOR|>=\s*1_000_000\s*\?\s*"luxury"/.test(`return mid >= 1_000_000 ? "luxury" : "first_time_buyer"`))

  console.log("\n── §2 compliance-first release rule ──")
  check("clean copy is released", descriptionReleaseDecision({ hardFairHousingFlag: false, guardFailed: false }).release === true)
  check("NEGATIVE: a hard Fair-Housing flag withholds the copy", descriptionReleaseDecision({ hardFairHousingFlag: true, guardFailed: false }).release === false)
  check("NEGATIVE: a compliance check that could not run withholds it (fail closed)", descriptionReleaseDecision({ hardFairHousingFlag: false, guardFailed: true }).release === false)

  console.log("\n── §3 the tool on an in-memory client ──")
  const T = "b1", OTHER = "b2"
  const svc = fakeSvc({
    listings: [
      { id: "L-foreign", brokerage_id: OTHER, agent_id: "A-2", address: "1 Elsewhere" },
      { id: "L-noagent", brokerage_id: T, agent_id: null, address: "2 Here" },
    ],
    listing_marketing_content: [
      { id: "mc-held", brokerage_id: T, listing_id: "L-1", content_type: "ai_descriptions", generated_at: "2026-09-28", content: { mlsDescription: "held copy", hard_fair_housing_flag: true } },
      { id: "mc-ok", brokerage_id: T, listing_id: "L-1", content_type: "ai_descriptions", generated_at: "2026-09-27", content: { mlsDescription: "clean copy", socialCaption: "Just listed!", style: "standard", source: "new_listing_kit" } },
      { id: "mc-foreign", brokerage_id: OTHER, listing_id: "L-1", content_type: "ai_descriptions", generated_at: "2026-09-29", content: { mlsDescription: "other tenant" } },
    ],
  })
  const foreign = await draftListingDescriptionForListing(svc, { brokerageId: T, listingId: "L-foreign", source: "agent_tool" })
  check("NEGATIVE: a listing outside the caller's tenant is refused before any writer runs", !foreign.ok && /not in your brokerage/.test((foreign as any).error))
  const noAgent = await draftListingDescriptionForListing(svc, { brokerageId: T, listingId: "L-noagent", actorAgentId: null, source: "agent_tool" })
  check("NEGATIVE: no listing agent and no caller agent profile → refused by name", !noAgent.ok && /no agent/.test((noAgent as any).error))
  const latest = await latestListingDescriptionDraft(svc, { brokerageId: T, listingId: "L-1" })
  check("the kit-draft reader skips a hard-flagged draft and offers the clean one (tenant-pinned)",
    latest.ok && latest.draft?.contentId === "mc-ok" && latest.draft?.source === "new_listing_kit", JSON.stringify(latest))

  console.log("\n── §4 wiring ──")
  const action = code("app/actions/listings-kernel.ts")
  check("the session action reaches the ONE tool with the SESSION tenant",
    /draftListingDescriptionForListing\(createServiceClient\(\), \{\s*brokerageId: ctx\.brokerageId/.test(action))
  check("the session action withholds held copy and returns the social caption + warnings",
    /if \(draft\.heldForReview\)/.test(action) && /socialCaption: draft\.socialCaption/.test(action) && /warnings: draft\.warnings/.test(action))
  const kernel = code("lib/kernel/listings.ts")
  check("the duplicate kernel writer is gone (tombstone kept in prose)",
    !/export async function generateListingDescription\(/.test(kernel) && /generateListingDescription removed/.test(readFileSync(join(ROOT, "lib/kernel/listings.ts"), "utf8")))
  check("[control] the finder sees a live declaration", /export async function generateListingDescription\(/.test("export async function generateListingDescription(input) {}"))
  const core = code("lib/listings/listing-description-core.ts")
  check("the core writes compliance-FIRST: the compliance blocks and the style guide are IN the prompt",
    /system: \[[\s\S]{0,120}\.\.\.complianceBlocks/.test(core) && /LISTING_DESCRIPTION_STYLE_GUIDE\[style\]/.test(core))
  check("the core no longer frames the copy as a 'Target Audience'", !/Target Audience/.test(core))
  check("the core still grades the MLS copy (postcheckScript + guardContent)", /postcheckScript\(/.test(core) && /guardContent\(/.test(core))
  const composer = code("app/components/dashboard/listings/lifecycle/listing-description-composer.tsx")
  check("the listing-page composer renders the ONE vocabulary and offers the kit draft",
    /LISTING_DESCRIPTION_STYLES\.map/.test(composer) && /getListingDescriptionDraftAction\(listingId\)/.test(composer) && !/value: "family"/.test(composer))
  const studio = code("app/dashboard/marketing/studio/marketing-studio-client.tsx")
  const panel = code("app/dashboard/marketing/studio/components/ad-os/listing-copy-panel.tsx")
  check("Marketing Studio's listing-copy panel is mounted and reaches the ONE tool (the enhancer writer is retired)",
    /<ListingCopyPanel agentId=\{agentId\} listings=\{listings\} \/>/.test(studio) &&
    /generateListingDescriptionAction\(\{ listingId, style \}\)/.test(panel) && !/enhanceListingDescription/.test(panel) &&
    /LISTING_DESCRIPTION_STYLES\.map/.test(panel))
  const aiMarketing = code("app/actions/ai-marketing-automation.ts")
  check("the third description writer (enhanceListingDescription, 'family' buyer style) is gone",
    !/export async function enhanceListingDescription\(/.test(aiMarketing) && !/growing family/.test(aiMarketing))
  // Lane 87B2 — the FOURTH writer (the content rail's generateListingDescription in
  // app/actions/ai-content-generation.tsx) is merged onto the core.
  const rail = code("app/actions/ai-content-generation.tsx")
  const railAt = rail.indexOf("export async function generateListingDescription(")
  const railBody = railAt >= 0 ? rail.slice(railAt, rail.indexOf("\nexport ", railAt + 10)) : ""
  check("the content-rail door writes through the ONE core (session tenant, no second prompt/model call)",
    /generateListingDescriptions\(createServiceClient\(\), \{\s*brokerageId: agentContext\.brokerageId/.test(railBody) &&
    !/generateAIResponse\(/.test(railBody) && !/function buildListingDescriptionPrompt/.test(rail))
  check("[control] the second-writer finder catches a door that still calls the model itself",
    /generateAIResponse\(/.test(`const response = await generateAIResponse({ prompt })`))
  check("the rail's 'family_with_kids → schools, safety' persona guidance is gone (familial status)",
    !/family_with_kids/.test(rail) && !/function getPersonaGuidance/.test(rail))
  check("the rail maps its persona onto the ONE vocabulary and withholds a hard-flagged draft",
    /style: normalizeListingDescriptionStyle\(params\.targetPersona\)/.test(railBody) && /core\.hardFairHousingFlag \|\| !!core\.guardResult\.guardFailed/.test(railBody))
  check("MERGED FIRST onto the core: length, headline, bullets, neighborhood, SEO keywords, long copy + measured usage",
    /length\?: "short" \| "medium" \| "long"/.test(core) && /headline: z\.string\(\)/.test(core) && /keyFeatureBullets:/.test(core) &&
    /neighborhoodParagraph:/.test(core) && /seoKeywords:/.test(core) && /longDescription:/.test(core) && /usage: \{ model: String\(usage\.model\)/.test(core))
  check("the rail keeps the shape its readers parse (medium/long/short_description, headline, bullets)",
    /medium_description:/.test(railBody) && /long_description:/.test(railBody) && /short_description:/.test(railBody) && /key_features_bullets:/.test(railBody))

  const tool = code("lib/listings/listing-description-tool.ts")
  check("MERGED FIRST: the survivor carries the enhancer's input — the listing's current public remarks",
    /currentPublicRemarks:/.test(tool) && /public_remarks/.test(tool))
  const chat = code("app/api/internal/ai-chat/route.ts")
  const toolAt = chat.indexOf("draft_listing_description: tool(")
  const toolBody = toolAt > 0 ? chat.slice(toolAt, toolAt + 2200) : ""
  check("the agent copilot carries draft_listing_description on the ONE tool", toolAt > 0 && /draftListingDescriptionForListing\(service, \{\s*brokerageId,/.test(toolBody))
  check("the copilot tool takes NO tenant from the model (no brokerage_id input)", toolAt > 0 && !/brokerage_id:\s*z\./.test(toolBody))
  check("the copilot tool's style enum IS the vocabulary (no second list)", /z\.enum\(LISTING_DESCRIPTION_STYLES\)/.test(toolBody))
  const war = code("lib/kernel/launch-war-room.ts")
  check("the new-listing kit drafts description + caption through the ONE tool (source new_listing_kit)",
    /draftListingDescriptionForListing\(supabase, \{ \.\.\.a, source: "new_listing_kit" \}\)/.test(war))
  check("the kit's compliance-checked caption becomes the gated launch-social draft; a held draft never does",
    /body: kitSocialCaption \?\? soc\.body/.test(war) && /if \(!drafted\.held && drafted\.socialCaption\)/.test(war))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log("FAILURES:\n  - " + failures.join("\n  - ")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
