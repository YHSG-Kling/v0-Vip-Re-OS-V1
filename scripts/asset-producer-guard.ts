// scripts/asset-producer-guard.ts — `test:asset-producer` (wave 150, lane 150SZ — directive 150S; owner ruling R10)
// ─────────────────────────────────────────────────────────────────────────────
// "All outward copy is inventive and humanized in the tenant's voice and tagline — never hard-copied, never a common
//  real-estate campaign phrase; legal/scripted text stays verbatim where required." (R10, 2026-11-06) · "Lead magnet =
//  complete deliverable artifact → page → funnel" (canary 10) · "personalized video / books / podcast / TV as staged assets
//  in the approval path before publication" · "market reports from data" · "SEO/GEO visibility hooks".
//
//   §A THE CLICHÉ LIST — POSITIVE CONTROL: a specimen of every common real-estate campaign phrase is caught by the ONE tell
//      scanner (lib/lead-magnets/book-editorial.ts scanAiTells); ordinary, specific prose is not.
//   §B ONE HUMANIZED PASS — no second tell list, no second final phase, no lib/ai/humanize*.ts (comment-stripped source; a
//      planted twin is seen).
//   §C THE PHASE — an AI draft with stock lines is NOT ready (each line named); a person's own words get a note, not a hold;
//      legal / scripted blocks are byte-identical, never scanned, appended when missing; the tenant's tagline is applied and
//      never judged as a stock line.
//   §D EVERY OUTWARD ASSET KIND HAS A DOOR into the phase (or a named disposition) — a planted door is found.
//   §E STAGED ASSETS — personalized-video producers never reach an egress; YouTube / podcast / TV / book doors pass approval.
//   §F CANARY 10 — order magnet → page → funnel; consent declared, never authored; unsubscribe only in the ONE email
//      assembler; deliveries ride dispatchEmail; market reports come from the market-report producer (verified data), never
//      the topic bank; the tenant-site page carries canonical + FAQ JSON-LD (SEO/GEO hooks).
// The summary line is `RESULT: N passed, M failed` (never the chain runner's own exit token).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { scanAiTells, CAMPAIGN_PHRASE_RULE_PREFIX } from "../lib/lead-magnets/book-editorial"
import { finalizeForDistribution, HUMANIZE_ASSET_KINDS } from "../lib/marketing/humanize-final"
import { FUNNEL_PACKAGE_ORDER } from "../lib/lead-magnets/magnet-funnel"

let pass = 0, fail = 0
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try { names = readdirSync(join(ROOT, dir)) } catch { return out }
  for (const n of names) {
    if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
  return out
}
const isCampaign = (text: string) => scanAiTells(text).filter((t) => t.rule.startsWith(CAMPAIGN_PHRASE_RULE_PREFIX))

// The known cliché list (R10) — one specimen per entry of the ONE tell list's campaign family.
const SPECIMENS = [
  "Welcome to the dream home you have been waiting for.",
  "This one won't last long, so act now.",
  "Freshly updated and priced to sell.",
  "A hidden gem on a quiet lane.",
  "A must-see three-bedroom ranch.",
  "Nestled in the hills above the river.",
  "The home boasts a chef's kitchen.",
  "A turnkey property for the next owner.",
  "Bright, clean and move-in ready.",
  "Pride of ownership shows throughout.",
  "An entertainer's dream backyard.",
  "Thinking of selling? Let's talk.",
  "What's your home worth in this market?",
  "Now is a great time to sell.",
  "Don't miss out on this opportunity.",
  "Call me today for a free consultation.",
  "Here for all your real estate needs.",
  "Your one-stop shop for buying and selling.",
  "We hold the key to your new home.",
  "It's all about location, location, location.",
  "Buyers are waiting for homes like yours.",
  "Home sweet home starts here.",
]
const ORDINARY = [
  "The kitchen was redone in 2021 and the back fence opens onto the creek trail.",
  "Three offers came in on the corner lot last month; two were above the asking price.",
  "If you are weighing a move before school starts, here is how long a sale usually takes in your ZIP code.",
  "The roof is eight years old and the inspection report is attached.",
]

async function main() {
  // ══ §A ══════════════════════════════════════════════════════════════════════════════════════
  section("A · the known cliché list — POSITIVE CONTROL (every specimen caught, ordinary prose not)")
  const missed = SPECIMENS.filter((s) => isCampaign(s).length === 0)
  check(`every one of the ${SPECIMENS.length} known campaign phrases is caught by the ONE tell scanner`, missed.length === 0, missed.join(" | "))
  const rules = new Set(SPECIMENS.flatMap((s) => isCampaign(s).map((t) => t.rule)))
  check("each specimen hits a DISTINCT entry (the list is not one broad regex accusing everything)", rules.size === SPECIMENS.length, `${rules.size} distinct rules`)
  const falsePos = ORDINARY.filter((s) => isCampaign(s).length > 0)
  check("specific, ordinary prose is NOT flagged (no false positive on facts, numbers or a plain question)", falsePos.length === 0, falsePos.join(" | "))
  check("the model-written tells are still caught beside them (one list, two families)", scanAiTells("In today's fast-paced market, delve into your options.").length >= 2)

  // ══ §B ══════════════════════════════════════════════════════════════════════════════════════
  section("B · ONE humanized pass (comment-stripped source)")
  const libFiles = walk("lib")
  const TELL_LIST_DEF = /\bconst\s+(?:AI_TELLS|[A-Z_]*CLICHES?|[A-Z_]*CAMPAIGN_PHRASES?)\s*(?::[^=]+)?=\s*(?:Object\.freeze\()?\[/
  check("POSITIVE CONTROL: a planted twin list (`const CAMPAIGN_CLICHES = [`) is seen by the finder", TELL_LIST_DEF.test(stripComments("const CAMPAIGN_CLICHES = [\"dream home\"]\n")))
  check("POSITIVE CONTROL: the same planted twin inside a comment is NOT seen (a tombstone is not a definition)", !TELL_LIST_DEF.test(stripComments("// const CAMPAIGN_CLICHES = [\"dream home\"]\n")))
  const listDefs = libFiles.filter((f) => TELL_LIST_DEF.test(code(f)))
  check("exactly ONE tell list exists in lib/ — lib/lead-magnets/book-editorial.ts", listDefs.length === 1 && listDefs[0] === "lib/lead-magnets/book-editorial.ts", listDefs.join(", "))
  const finalDefs = libFiles.filter((f) => /export\s+async\s+function\s+finalizeForDistribution\b/.test(code(f)))
  check("exactly ONE final phase (finalizeForDistribution) — lib/marketing/humanize-final.ts", finalDefs.length === 1 && finalDefs[0] === "lib/marketing/humanize-final.ts", finalDefs.join(", "))
  const aiHumanize = walk("lib/ai").filter((f) => /\/humaniz/i.test(f))
  check("no second humanizer under lib/ai/humanize*.ts (the brief's guessed path does not exist; the survivor is humanize-final)", aiHumanize.length === 0, aiHumanize.join(", "))

  // ══ §C ══════════════════════════════════════════════════════════════════════════════════════
  section("C · the phase: stock lines, the person's own words, verbatim legal text, the tagline")
  const brand = { brandName: "Harbor & Pine Homes", tagline: "Neighbors first, numbers always", prohibitedWords: [], preferredWords: [] }
  const ai = await finalizeForDistribution({ assetKind: "social_post", text: "This dream home won't last! Call me today to see the new porch.", tenantBrand: brand })
  check("an AI draft carrying stock lines is NOT ready for approval", ai.readyForApproval === false)
  check("…each stock line is NAMED for the writer (3 found)", ai.campaignPhrases.length === 3, JSON.stringify(ai.campaignPhrases))
  check("…and each is a blocker that says to say it their own way", ai.blockers.filter((b) => b.includes("stock real-estate campaign line")).length === 3)
  check("the tenant's vetted tagline is appended as the sign-off (their voice)", ai.tagline.applied === "appended" && ai.text.includes("Neighbors first, numbers always"))
  const human = await finalizeForDistribution({ assetKind: "social_post", text: "Pride of ownership shows on every porch board I photographed.", tenantBrand: brand, authoredBy: "human" })
  check("a person's own words with a stock line are NOT held (their words stay theirs) …", human.readyForApproval === true, human.blockers.join(" | "))
  check("… but the line is named in a review note", human.reviewNotes.some((n) => n.includes("Pride of ownership")))
  const clicheTagline = await finalizeForDistribution({ assetKind: "social_post", text: "Two porches, one creek view, and a garage that fits a canoe.", tenantBrand: { ...brand, tagline: "Location, location, location" } })
  check("a tagline that is itself a stock line still goes out (it is the brand) and never blocks the piece", clicheTagline.readyForApproval === true && clicheTagline.text.includes("Location, location, location"), clicheTagline.blockers.join(" | "))
  check("… and the person is told it reads like a stock line", clicheTagline.reviewNotes.some((n) => n.includes("tagline") && n.includes("stock")))

  const LEGAL = "Equal Housing Opportunity. It is important to note that this offer won't last beyond 05/31/2027 as stated in the agreement."
  const withLegal = await finalizeForDistribution({ assetKind: "email_campaign", text: `It is important to note that the new roof went on in 2024.\n\n${LEGAL}`, tenantBrand: brand, verbatim: [LEGAL] })
  check("a verbatim legal block is byte-identical in the final", withLegal.text.includes(LEGAL))
  check("… the tell it contains was NOT stripped from it, while the same tell OUTSIDE it was", withLegal.removed.length === 1 && !withLegal.text.startsWith("It is important"), JSON.stringify(withLegal.removed))
  check("… and the stock phrase inside it is never judged (legal text is not a cliché the writer can rephrase)", withLegal.campaignPhrases.length === 0 && withLegal.readyForApproval === true, withLegal.blockers.join(" | "))
  check("… nothing is reported lost", withLegal.verbatim.missing.length === 0 && withLegal.materialTerms.missing.length === 0)
  const SCRIPT = "Reply STOP to opt out; msg & data rates may apply."
  const appended = await finalizeForDistribution({ assetKind: "email_campaign", html: "<p>The open house runs from noon to two.</p>", tenantBrand: brand, verbatim: [SCRIPT] })
  check("a required scripted block the draft lacked is appended exactly once, as given", appended.verbatim.appended.length === 1 && appended.verbatim.missing.length === 0 && (appended.text.match(/opt out/g) ?? []).length === 1)
  check("… HTML-escaped in markup, so the READ text is exactly the script", appended.text.includes("msg &amp; data rates") && !appended.text.includes("msg & data"))
  const none = await finalizeForDistribution({ assetKind: "newsletter", text: "The creek trail reopened on Saturday.", tenantBrand: brand })
  check("NEGATIVE CONTROL: no verbatim input → nothing appended, nothing missing", none.verbatim.required.length === 0 && none.verbatim.appended.length === 0)

  // ══ §D ══════════════════════════════════════════════════════════════════════════════════════
  section("D · every outward asset kind has a door into the ONE final phase (or a named disposition)")
  const DISPOSED: Record<string, string> = {
    book: "the book's humanized review (humanizedReviewState on the SAME tell list) gates lead-magnet publish and KDP — lib/kernel/lead-magnets.ts, lib/lead-magnets/book-publishing-produce.ts",
    video_script: "a spoken script is graded by the realism profile + script-compliance; a PUBLIC video publishes through the YouTube door, whose description is the staged final (video_description)",
  }
  const doorOf = (src: string, kind: string) => new RegExp(`assetKind:\\s*["']${kind}["']`).test(src)
  check("POSITIVE CONTROL: a planted door (`assetKind: \"newsletter\"`) is found by the finder", doorOf(stripComments("await finalizeForDistribution({ assetKind: \"newsletter\", text })\n"), "newsletter"))
  const product = [...libFiles, ...walk("app")].filter((f) => f !== "lib/marketing/humanize-final.ts")
  const productCode = new Map(product.map((f) => [f, code(f)]))
  const doorless: string[] = []
  for (const k of HUMANIZE_ASSET_KINDS) {
    const doors = [...productCode.entries()].filter(([, src]) => doorOf(src, k)).map(([f]) => f)
    if (doors.length === 0 && !DISPOSED[k]) doorless.push(k)
    console.log(`    ${k}: ${doors.length ? doors.slice(0, 3).join(", ") + (doors.length > 3 ? ` (+${doors.length - 3})` : "") : DISPOSED[k] ? `DISPOSED — ${DISPOSED[k].slice(0, 90)}…` : "NO DOOR"}`)
  }
  check(`all ${HUMANIZE_ASSET_KINDS.length} public asset kinds reach the phase (a door, or a named disposition)`, doorless.length === 0, doorless.join(", "))
  check("the email campaign — the last kind with no door — now records what went out through the SAME door as the newsletter", /recordDoorPublication\([\s\S]{0,200}assetKind:\s*"email_campaign"/.test(code("lib/marketing/email-campaign-sender.ts")))
  const sender = code("lib/marketing/email-campaign-sender.ts")
  const preIdx = sender.indexOf("await preflightCampaignCopy(svc, campaign, html)")
  const claimIdx = sender.indexOf('.update({ status: "sending" })')
  check("the campaign passes the ONE final phase's check BEFORE it is claimed and sent (a refusal leaves it untouched)", preIdx > 0 && claimIdx > preIdx && /checkDistributionPublication\(/.test(sender), `preflight@${preIdx} claim@${claimIdx}`)
  check("… and a phase that cannot run refuses the send (fail closed)", /the final copy check could not run/.test(sender))
  const { checkDistributionPublication } = await import("../lib/marketing/humanize-final")
  const { memSupabase } = await import("./in-memory-supabase")
  const mdb = memSupabase({ distribution_finals: [] }, { uuidIds: true, stampCreatedAt: true })
  const pc = (content: string) => checkDistributionPublication(mdb as never, { brokerageId: "11111111-1111-4111-8111-111111111111", assetKind: "email_campaign", assetTable: "email_campaigns", assetId: "e1e1e1e1-0000-4000-8000-000000000001", content, approval: { approved: true, by: null, at: null }, tenantBrand: { prohibitedWords: ["guaranteed"] } })
  const refusedFH = await pc("<p>Perfect for young professionals — no children please.</p>")
  check("POSITIVE CONTROL: a campaign carrying a hard fair-housing phrase is refused at the pre-send check", refusedFH.ok === false && /fair housing/.test(refusedFH.reason), JSON.stringify(refusedFH))
  const refusedWord = await pc("<p>Your sale price, guaranteed.</p>")
  check("… so is one carrying the tenant's own prohibited word", refusedWord.ok === false && /prohibited by your brand voice: "guaranteed"/.test(refusedWord.reason), JSON.stringify(refusedWord))
  const passes = await pc("<p>The creek trail reopened on Saturday, and the two homes on Alder sold this month.</p>")
  check("NEGATIVE CONTROL: an ordinary campaign passes the pre-send check", passes.ok === true, JSON.stringify(passes))
  check("every disposition names a live kind (a stale one is a waypoint)", Object.keys(DISPOSED).every((k) => (HUMANIZE_ASSET_KINDS as readonly string[]).includes(k)))

  // ══ §E ══════════════════════════════════════════════════════════════════════════════════════
  section("E · personalized video / books / podcast / TV are staged in the approval path before publication")
  const EGRESS = /\b(?:dispatchEmail|dispatchSms|dispatchDirectMail|uploadToYouTube|publishToYouTube|youtube\.videos\.insert|sendgrid|twilio\.messages)\b/
  check("POSITIVE CONTROL: a planted egress call in a producer is seen", EGRESS.test(stripComments("await dispatchEmail({ to })\n")))
  const producers = readdirSync(join(ROOT, "lib/agents")).filter((n) => n.endsWith("-producer.ts")).map((n) => `lib/agents/${n}`)
  const leaking = producers.filter((f) => EGRESS.test(code(f)))
  check(`no personalized-asset producer (${producers.length} lib/agents/*-producer.ts) sends or publishes itself — each stages for a person`, producers.length > 0 && leaking.length === 0, leaking.join(", "))
  check("YouTube: the publish door stages the humanized final and checks it before the upload", /stageDistributionFinal/.test(code("lib/video/youtube-publish.ts")) && /recordDistributionPublication|checkDistributionPublication/.test(code("lib/video/youtube-publish.ts")))
  check("podcast: the distribution cron checks / records the approved final", /checkDistributionPublication|recordDoorPublication|recordDistributionPublication/.test(code("app/api/cron/distribute-podcast-episodes/route.ts")))
  check("TV: a spot is produced only from an approved PUBLIC marketing video (classifyPublicVideo)", /classifyPublicVideo/.test(code("lib/video/tv-spot-produce.ts")))
  check("TV: the CTV lane stages its final for approval", /stageDistributionFinal/.test(code("lib/marketing/ctv-lane.ts")))
  check("books: publication is refused until the humanized review is done (humanizedReviewRefusal)", /humanizedReviewRefusal|humanizedReviewState/.test(code("lib/kernel/lead-magnets.ts")))

  // ══ §F ══════════════════════════════════════════════════════════════════════════════════════
  section("F · canary 10 — the complete lead-magnet package (static half; the in-memory half is test:lead-magnet-package)")
  check("the package order is magnet → landing page → funnel", JSON.stringify([...FUNNEL_PACKAGE_ORDER]) === JSON.stringify(["magnet", "landing_page", "funnel"]), JSON.stringify(FUNNEL_PACKAGE_ORDER))
  const mf = code("lib/lead-magnets/magnet-funnel.ts")
  check("consent is DECLARED on the form and rendered by the one C15 component — never authored by the package", /wording:\s*"rendered_by_c15"/.test(mf))
  const UNSUB = /List-Unsubscribe|\/api\/unsubscribe|\/unsubscribe\?|unsubscribe_url|unsubscribeUrl/
  check("POSITIVE CONTROL: a planted unsubscribe link is seen", UNSUB.test(stripComments("const footer = `<a href=\"/api/unsubscribe?c=${id}\">x</a>`\n")))
  const lmFiles = walk("lib/lead-magnets")
  const ownUnsub = lmFiles.filter((f) => UNSUB.test(code(f)))
  check(`no lead-magnet module (${lmFiles.length}) writes its own unsubscribe — ONE canonical place`, ownUnsub.length === 0, ownUnsub.join(", "))
  check("… that place is the one email assembler on the dispatch gate (List-Unsubscribe built in lib/providers/dispatch.ts' assemble path)", /unsubscribe/i.test(code("lib/providers/dispatch.ts")))
  const pd = code("lib/lead-magnets/promised-deliverables.ts")
  check("promised deliverables are SENT through dispatchEmail (consent + suppression + unsubscribe at the gate), never a provider", /dispatchEmail/.test(pd) && !/from\s+["']@sendgrid|from\s+["']resend/.test(pd))
  check("the creator is the users.id (createLeadMagnet writes created_by_user_id)", /created_by_user_id/.test(code("lib/kernel/lead-magnets.ts")))
  const da = code("lib/lead-magnets/deliverable-asset.ts")
  check("market reports come from the market-report producer (verified data — lib/market-reports/producer.ts produceMarketReport)", /produceMarketReport/.test(mf) && /produceMarketReport/.test(da))
  check("… and never from the topic bank (no lead-magnet module imports lib/market-reports/topics for a report)", !lmFiles.some((f) => /market-reports\/topics/.test(code(f))))
  const producer = await import("../lib/market-reports/producer")
  check("the producer's interface the funnel consumes exists (produceMarketReport is a function — seam with 150KLMO)", typeof producer.produceMarketReport === "function")
  const lm = code("app/lm/[slug]/page.tsx")
  check("SEO/GEO: the published page declares its canonical on the TENANT's site and is indexable", /alternates:\s*\{\s*canonical/.test(lm) && /index:\s*true/.test(lm))
  check("SEO/GEO: the page emits FAQ JSON-LD from the landing copy (geo-faq) — a draft preview does not", /application\/ld\+json/.test(lm) && /isDraftPreview/.test(lm))
  check("the writer's brief carries R10 (inventive, tenant voice, no stock campaign lines; legal text verbatim)", /never a stock real-estate campaign line/.test(raw("lib/lead-magnets/magnet-funnel.ts")))
  check("the tenant-site route serves the same page (custom domain / storefront)", existsSync(join(ROOT, "app/site/[slug]/lm/[formSlug]/page.tsx")))

  console.log("\n BLIND SPOTS: §A is LEXICAL — a stock line phrased beyond the 22 patterns (\"stunning\", \"gorgeous\", \"charming\" are style, deliberately not listed) is not caught; §C's `verbatim.missing` path (a mask that failed to restore) has no reachable trigger from input, so it is asserted only by construction; §D proves a DOOR exists per kind, not that every producer of that kind uses it (a new writer that skips the phase is caught only if it publishes through a door that checks the staged final); §E is a static census of named egress tokens — an egress spelled another way is not seen; the market-report producer is 150KLMO's (built in parallel) — only its function interface is asserted here; no live model, no live send.")
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail === 0) console.log("✅ ASSET_PRODUCER_PASS — one humanized pass on every outward asset (stock lines named, legal text verbatim, the tenant's tagline), staged assets in the approval path, the lead-magnet package complete in the owner's order")
  else { console.log("❌ ASSET_PRODUCER_FAIL"); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
