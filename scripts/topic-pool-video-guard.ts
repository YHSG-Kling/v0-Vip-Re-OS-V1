#!/usr/bin/env tsx
/**
 * scripts/topic-pool-video-guard.ts  (npm run test:topic-pool-video) — pure, no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TOPIC POOL FEEDS THE DIRECTOR, AUTONOMOUSLY, BY RULE — AND IT IS ONE POOL.
 *
 * OWNER (2026-09-25): "videos should also be derived by the topic pool which
 * should be autonomous." OWNER (2026-09-26, wave 83): "in topic video, you made
 * the persona contact type instead of contact personas." · "the cron route, you
 * added topic videos to a const for runlistingbrochures … does not fit in for
 * the capability."
 *
 * Asserted:
 *   §one-pool   the runner reads topics ONLY through pickTopics (content_topic_bank +
 *               the office claim); the pure rule module does no I/O; no new topic
 *               table is introduced (+ positive control on the detector).
 *   §vocab      every category the rule speaks (season sets, archetype rules, persona
 *               sets) is one the WRITERS write (derived by scanning lib/content-intel
 *               add("…") + promote-to-topic-bank) — §6 (+ positive control).
 *   §season     all 12 months map to a season; in-season lift < local/geo boosts.
 *   §persona    (wave 83) the persona vocabulary is contacts.contact_persona (the live
 *               CHECK, via the CAMPAIGN_PERSONAS survivor), NEVER contacts.contact_type;
 *               the runner reads contact_persona and never contact_type; the pick's
 *               recipientPersona is that persona (so per-persona learning can match the
 *               aggregator's contact_persona-keyed rows); rotation + categories + audience
 *               are keyed by it (+ POSITIVE CONTROLS: the 82C contact-type roster and a
 *               contact_type read are both flagged by the same detectors).
 *   §shape      archetype by rule — first chain member whose needs are met; the chain
 *               ends in the needs-free archetype THE HOST can carry; every topic ×
 *               persona brief PLANS on BOTH hosts (a ready twin, or a voice alone); the
 *               voiceover brief's content satisfies the planned composition's contract.
 *   §runner     compliance-first script (routed + booked, tenant from the row read),
 *               fair-housing scan BEFORE the Director, postcheck, the ONE rail
 *               (pending_review), the claim logged AFTER the asset exists, every skip
 *               counted by name; mounted on the existing daily video-plays cron as ITS
 *               OWN STEP, never inside the listing plays' const (+ positive control).
 * Cadence (how many a week, which days) is proven by test:topic-video-cadence.
 *
 * BLIND SPOTS (published): the model's script quality is not judged here (the
 * Director's hook gate + human approval are the judges); pickTopics' SQL is proven
 * by shape, not against the live bank; content_asset_persona_performance's
 * asset_type CHECK does not admit `situational_reel`, so per-persona learning for
 * topic VIDEOS has no rows yet (the persona key now matches; the asset type still
 * needs a CHECK widening — recorded for the integrator).
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  PERSONA_AUDIENCE, TOPIC_ARCHETYPE_RULES, TOPIC_PERSONA_RULES, TOPIC_VIDEO_PERSONAS, personaForSlot, personaForTopicCategories,
  personaRotation, seasonalCategories, terminalArchetypeFor, topicArchetypeFor, topicCategoriesForPersona, topicPersonaOf,
  topicPersonaSide, topicScriptPrompt, topicVideoBrief, topicVideoContent, type TopicLike, type TopicVideoPersona,
} from "../lib/video/topic-video"
import { planCustomVideo, archetypeHosts } from "../lib/video/custom-video-archetypes"
import { missingContentProps } from "../lib/remotion/content-contract"
import type { BodyVisualAssets } from "../lib/video/body-visual-model"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const NONE: BodyVisualAssets = { avatarClip: false, brollClips: 0, propertyPhotos: 0, screenshots: 0, statCards: 0, clientFootage: 0, chartData: false }
const topic = (categories: string[], title = "What closing costs cover"): TopicLike => ({ id: "00000000-0000-4000-8000-000000000001", topic_title: title, value_angle: "a plain walk-through", categories })

console.log("\n── §one-pool · pickTopics is the only door ──")
{
  const runner = readStripped("lib/video/topic-video-runner.ts")
  const rule = readStripped("lib/video/topic-video.ts")
  const fromTables = (s: string) => Array.from(s.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)).map((m) => m[1])
  check("the runner picks through pickTopics (freshness · territory · persona performance · office claim)", /pickTopics\(\{/.test(runner))
  check("the runner never queries content_topic_bank directly", !fromTables(runner).includes("content_topic_bank"), fromTables(runner).join(", "))
  check("POSITIVE CONTROL: the table detector sees a direct bank read", fromTables(`svc.from("content_topic_bank").select("*")`).includes("content_topic_bank"))
  // The RULE: it READS brokerages, agents, the tenant's contact personas and the cadence setting;
  // its one write is the counted compliance note on the row the Director staged.
  const allowed = new Set(["brokerages", "agents", "contacts", "brokerage_settings", "ai_video_projects"])
  check(`the runner touches only brokerages · agents · contacts(persona) · brokerage_settings(cadence) · the Director-staged ai_video_projects note (${fromTables(runner).join(", ")})`,
    fromTables(runner).every((t) => allowed.has(t))
    && (runner.match(/\.from\(\s*"ai_video_projects"\s*\)/g) ?? []).length === 1
    && /\.from\("ai_video_projects"\)\s*\.update\(\{ compliance_violations: complianceWarnings \}\)\s*\.eq\("id", r\.videoProjectId\)\.eq\("brokerage_id", t\.id\)\.select\("id"\)/.test(runner)
    && /await postcheckScript\(/.test(runner))
  check("the contacts read is tenant-scoped (brokerage_id = the tenant row) and reads contact_persona only",
    /\.from\("contacts"\)\s*\.select\("contact_persona"\)\.eq\("brokerage_id", t\.id\)/.test(runner))
  check("the rule module is PURE (no supabase, no server-only, no model)", !/supabase|server-only|generateObjectRouted|fetch\(/.test(rule))
  const migrations = readdirSync(join(root, "supabase/migrations")).filter((f) => /^m66[2-9]/.test(f))
  const newPool = migrations.filter((f) => /create table[^;]*topic/i.test(read(`supabase/migrations/${f}`)))
  check("no migration this wave creates a second topic table", newPool.length === 0, newPool.join(", "))
  const bank = readStripped("lib/content-intel/topic-bank.ts")
  check("pickTopics carries the seasonal lift (boostCategories → SEASONAL_BOOST in adjusted_score)", /boostCategories\?:\s*string\[\]/.test(bank) && /\+ seasonBoost/.test(bank))
  const boost = Number(/SEASONAL_BOOST\s*=\s*(\d+)/.exec(bank)?.[1] ?? "NaN")
  check(`the season nudges, never outranks a local (+15) or geo (+20) story (SEASONAL_BOOST=${boost})`, boost > 0 && boost < 15)
  check("the office claim excludes a topic this brokerage already claimed (content_topic_uses by brokerage_id, 30-day window) — what keeps the week's slots from repeating a topic",
    /\.from\("content_topic_uses"\)[\s\S]{0,120}\.eq\("brokerage_id", args\.brokerageId\)[\s\S]{0,60}\.gte\("used_at", since\)/.test(bank) && /rows = rows\.filter\(\(r\) => !taken\.has\(r\.id\)\)/.test(bank))
}

console.log("\n── §vocab · the rule speaks the writers' categories ──")
const writerVocab = new Set<string>()
{
  for (const f of readdirSync(join(root, "lib/content-intel")).filter((f) => f.endsWith(".ts"))) {
    for (const m of readStripped(`lib/content-intel/${f}`).matchAll(/add\("([a-z_]+)"\)/g)) writerVocab.add(m[1])
  }
  if (/"competitor_intel"/.test(readStripped("lib/competitive-intel/promote-to-topic-bank.ts"))) writerVocab.add("competitor_intel")
  console.log(`    writer vocabulary (derived): ${Array.from(writerVocab).sort().join(", ")}`)
  check("the writer vocabulary was found (≥ 6 categories)", writerVocab.size >= 6)
  const unwritten = (cats: string[]) => cats.filter((c) => !writerVocab.has(c))
  check("POSITIVE CONTROL: an unwritten spelling (market_update) is caught", unwritten(["market_update"]).length === 1)
  const seasonCats = Array.from(new Set(Array.from({ length: 12 }, (_, m) => seasonalCategories(m).categories).flat()))
  check("every in-season category is a WRITTEN one", unwritten(seasonCats).length === 0, unwritten(seasonCats).join(", "))
  const ruleCats = TOPIC_ARCHETYPE_RULES.flatMap((r) => r.categories)
  const ruleWritten = ruleCats.filter((c) => writerVocab.has(c))
  check(`the archetype rules cover every written category (${ruleWritten.length}/${writerVocab.size})`, Array.from(writerVocab).every((c) => ruleCats.includes(c)), Array.from(writerVocab).filter((c) => !ruleCats.includes(c)).join(", "))
  const thin: string[] = []
  for (const p of TOPIC_VIDEO_PERSONAS) {
    const cats = topicCategoriesForPersona(p)
    if (cats.filter((c) => writerVocab.has(c)).length < 2 || unwritten(cats).length > 0) thin.push(`${p}: ${cats.join("+")}`)
  }
  check(`every persona's pick filter is ≥ 2 WRITTEN categories and nothing unwritten (${TOPIC_VIDEO_PERSONAS.length} personas)`, thin.length === 0, thin.join(" | "))
}

console.log("\n── §season · twelve months, four seasons ──")
{
  const seasons = Array.from({ length: 12 }, (_, m) => seasonalCategories(m).season)
  check("Dec–Feb winter, Mar–May spring, Jun–Aug summer, Sep–Nov fall", seasons.join(",") === "winter,winter,spring,spring,spring,summer,summer,summer,fall,fall,fall,winter")
  check("spring leads with the seller (listing season); summer with the buyer (relocation)", seasonalCategories(3).categories[0] === "seller_advice" && seasonalCategories(6).categories[0] === "buyer_advice")
  check("out-of-range months wrap (−1 → December, 12 → January)", seasonalCategories(-1).season === "winter" && seasonalCategories(12).season === "winter")
}

console.log("\n── §persona · CONTACT PERSONAS (contacts.contact_persona), never contact type ──")
{
  const livePersonas = (CHECK_VOCABULARIES.contacts?.contact_persona ?? []).filter((p) => p !== "other").sort()
  const liveTypes = new Set(CHECK_VOCABULARIES.contacts?.contact_type ?? [])
  check(`the rule's persona roster IS the live contacts.contact_persona CHECK minus 'other' (${TOPIC_VIDEO_PERSONAS.length}: ${livePersonas.join(", ")})`,
    livePersonas.length >= 10 && JSON.stringify([...TOPIC_VIDEO_PERSONAS].sort()) === JSON.stringify(livePersonas))
  // THE DETECTOR the owner's finding needs: a roster member that is a contact_TYPE spelling.
  const contactTypeSpellings = (roster: readonly string[]) => roster.filter((p) => liveTypes.has(p) || liveTypes.has(`${p}_customer`))
  check("no roster member is a contact_type spelling", contactTypeSpellings(TOPIC_VIDEO_PERSONAS).length === 0, contactTypeSpellings(TOPIC_VIDEO_PERSONAS).join(", "))
  check("POSITIVE CONTROL: the 82C roster (buyer/seller/both/lifetime) is flagged as contact_type — all four", contactTypeSpellings(["buyer", "seller", "both", "lifetime"]).length === 4)
  check("a contact_type value is NEVER read as a persona (buyer/seller/both/lifetime_customer/sphere → null)",
    ["buyer", "seller", "both", "lifetime_customer", "sphere", "lead"].every((t) => topicPersonaOf(t) === null))
  check("drifted persona spellings map forward through the ONE normaliser (first_time_buyer → first_time, veteran → military, relocation → relocated); 'other' is no persona",
    topicPersonaOf("first_time_buyer") === "first_time" && topicPersonaOf("veteran") === "military" && topicPersonaOf("relocation") === "relocated" && topicPersonaOf("other") === null)

  const runner = blankStrings(readStripped("lib/video/topic-video-runner.ts"))
  const runnerRaw = readStripped("lib/video/topic-video-runner.ts")
  const readsContactType = (src: string) => /contact_type|contactReelPersona|ContactReelPersona|personaTopicCategories/.test(src)
  check("the runner never reads contact_type (nor the contact-type reel mapping)", !readsContactType(runnerRaw))
  check("POSITIVE CONTROL: the detector sees a contact_type read", readsContactType(`svc.from("contacts").select("contact_type")`))
  check("the rule module speaks no contact-type vocabulary (no ContactReelPersona / personaTopicCategories import)", !readsContactType(readStripped("lib/video/topic-video.ts")))
  check("the rotation is built from the tenant's contact_persona column and ASSIGNED per slot (personaRotation → personaForSlot)",
    /personaRotation\(/.test(runner) && /personaForSlot\(now, t\.id, slot,/.test(runner))
  check("the pick's recipientPersona is that contact persona (per-persona learning keys on contact.contact_persona — lib/content-intel/performance-aggregator.ts)",
    /recipientPersona:\s*persona/.test(runner) && /contact_persona/.test(readStripped("lib/content-intel/performance-aggregator.ts")))
  check("the compliance scan + postcheck read the persona's SIDE (not a contact type)",
    /const side = topicPersonaSide\(persona\)/.test(runner) && /detectFairHousingRedFlags\([\s\S]{0,200}?,\s*side\)/.test(runnerRaw) && /object\.script,\s*side,/.test(runnerRaw))

  const rot = personaRotation(["investor", "first_time_buyer", "investor", "buyer", null, "other", "veteran", "first_time", "investor"])
  check(`the tenant's rotation is its own book, most-held first, contact types dropped (${rot.join(", ")})`, rot.join() === "investor,first_time,military")
  check("an empty book (or one with only contact types) rotates through every persona", personaRotation([]).length === TOPIC_VIDEO_PERSONAS.length && personaRotation(["buyer", "seller"]).length === TOPIC_VIDEO_PERSONAS.length)
  const tenant = "11111111-1111-4111-8111-111111111111"
  const d = new Date(Date.UTC(2026, 8, 7))
  const week = [0, 1, 2].map((i) => personaForSlot(d, tenant, i, 3))
  check(`a week's slots speak to DISTINCT personas (assigned, not left to the picker: ${week.join(", ")})`, new Set(week).size === 3)
  const seen = new Set<string>()
  const weeks = Math.ceil(TOPIC_VIDEO_PERSONAS.length / 3)
  for (let w = 0; w < weeks; w++) for (let i = 0; i < 3; i++) seen.add(personaForSlot(new Date(Date.UTC(2026, 8, 7 + w * 7)), tenant, i, 3))
  check(`at 3 a week, ${weeks} consecutive weeks visit all ${TOPIC_VIDEO_PERSONAS.length} personas (${seen.size})`, seen.size === TOPIC_VIDEO_PERSONAS.length)
  const small = personaRotation(["investor", "first_time"])
  check("a two-persona book alternates within the week (never the same persona on consecutive slots)", personaForSlot(d, tenant, 0, 3, small) !== personaForSlot(d, tenant, 1, 3, small))
  check("the audience lines describe a SITUATION, never a people-group (no protected-class words) — all personas",
    Object.values(PERSONA_AUDIENCE).length === TOPIC_VIDEO_PERSONAS.length
    && Object.values(PERSONA_AUDIENCE).every((a) => !/\b(famil|kid|child|young|old\b|elder|senior|retire|single|married|divorc|christian|church|jewish|muslim|disab|wheelchair|men\b|women|race|ethnic|national)/i.test(a)))
  check("POSITIVE CONTROL: the protected-class detector flags a people-group line", /\b(senior|famil)/i.test("seniors and young families"))
  const sellerSide = TOPIC_VIDEO_PERSONAS.filter((p) => topicPersonaSide(p) === "seller")
  check(`the seller-side personas are the listing situations (${sellerSide.join(", ")})`, ["fsbo", "probate", "expired", "foreclosure", "downsize"].every((p) => sellerSide.includes(p as TopicVideoPersona)) && !sellerSide.includes("first_time"))
  check("the card suggests an audience by persona category overlap (seller_advice+regulation → a seller-side persona)", topicPersonaSide(personaForTopicCategories(["seller_advice", "regulation"], "first_time")) === "seller")
  const card = readStripped("app/actions/custom-video.ts")
  check("the card's topic pool suggests by contact persona (personaForTopicCategories), no contact-type literals", /personaForTopicCategories\(/.test(card) && !/return "lifetime"|return "both"/.test(card))
  check("TOPIC_PERSONA_RULES has a rule for exactly the roster", Object.keys(TOPIC_PERSONA_RULES).sort().join() === [...TOPIC_VIDEO_PERSONAS].sort().join())
}

console.log("\n── §shape · archetype by rule, every brief plans on either host ──")
{
  const md = topicArchetypeFor(topic(["market_education"], "Inventory this quarter"), "avatar", { ...NONE, avatarClip: true })
  check("numbers topic with no stat cards (twin) → education_explainer, data_update skipped with its reason", md.archetype === "education_explainer" && md.skipped.some((s) => s.archetype === "data_update"))
  const mdVoice = topicArchetypeFor(topic(["market_education"], "Inventory this quarter"), "voiceover", NONE)
  check("numbers topic, voice only → voiceover_explainer (the voiceover host's terminal), data_update skipped", mdVoice.archetype === "voiceover_explainer" && mdVoice.skipped.some((s) => s.archetype === "data_update"))
  const mdStats = topicArchetypeFor(topic(["market_education"]), "avatar", { ...NONE, avatarClip: true, statCards: 2 })
  check("numbers topic WITH stat cards on the twin → data_update", mdStats.archetype === "data_update")
  check("advice topic → education_explainer on a twin, voiceover_explainer on a voice",
    topicArchetypeFor(topic(["seller_advice"]), "avatar", { ...NONE, avatarClip: true }).archetype === "education_explainer"
    && topicArchetypeFor(topic(["seller_advice"]), "voiceover", NONE).archetype === "voiceover_explainer")
  check("every rule chain ENDS in the needs-free explainer", TOPIC_ARCHETYPE_RULES.every((r) => r.chain[r.chain.length - 1] === "education_explainer"))
  check("the rule table is not mutated by a pick (chains copied)", TOPIC_ARCHETYPE_RULES.every((r) => r.chain.filter((a) => a === "education_explainer").length === 1 && !r.chain.includes("voiceover_explainer")))
  check(`every narrating host has a derived terminal (avatar → ${terminalArchetypeFor("avatar")}, voiceover → ${terminalArchetypeFor("voiceover")}); silent has none`,
    terminalArchetypeFor("avatar") === "education_explainer" && terminalArchetypeFor("voiceover") === "voiceover_explainer" && terminalArchetypeFor("silent") === null)
  let planned = 0, total = 0, contractOk = 0
  const misses: string[] = []
  const copy = { script: "A hook. Beat one. Beat two. Beat three. Ask me.", title: "Closing costs, plainly", hook: "What you actually pay at closing", bullets: ["Lender fees", "Title and escrow", "Prepaids"] }
  for (const cats of [["market_education"], ["neighborhood"], ["buyer_advice"], ["seller_advice"], ["finance"], ["home_improvement"], ["regulation"], ["competitor_intel"], []]) {
    for (const persona of TOPIC_VIDEO_PERSONAS) {
      for (const host of ["avatar", "voiceover"] as const) {
        total++
        const assets = host === "avatar" ? { ...NONE, avatarClip: true } : NONE
        const { brief } = topicVideoBrief({ topic: topic(cats), persona, host, assets })
        const r = planCustomVideo(brief)
        if (r.ok) {
          planned++
          if (missingContentProps(r.plan.compositionId, topicVideoContent(r.plan.compositionId, copy)).length === 0 || r.plan.compositionId !== "NewsletterDigestVideo") contractOk++
        } else misses.push(`${cats.join("+") || "none"}/${persona}/${host}: ${r.reason}`)
      }
    }
  }
  check(`every topic × persona × {twin, voice only} brief PLANS (${planned}/${total})`, planned === total, misses.slice(0, 3).join(" | "))
  check(`the voiceover explainer's content satisfies NewsletterDigestVideo's contract (subject · marketBeat · sectionTitles) in every plan (${contractOk}/${planned})`, contractOk === planned)
  const vo = planCustomVideo(topicVideoBrief({ topic: topic(["buyer_advice"]), persona: "first_time", host: "voiceover", assets: NONE }).brief)
  check(`a voice-only topic video plans on the registered voiceover composition (${vo.ok ? vo.plan.compositionId : vo.reason})`, vo.ok && vo.plan.archetype === "voiceover_explainer" && vo.plan.compositionId === "NewsletterDigestVideo")
  check("NEGATIVE CONTROL: the owner's rule holds — an EXPLAINER hint on the voiceover host is refused (explainers present with the avatar)",
    !planCustomVideo({ ...topicVideoBrief({ topic: topic(["buyer_advice"]), persona: "first_time", host: "voiceover", assets: NONE }).brief, archetypeHint: "education_explainer" }).ok
    && archetypeHosts("education_explainer").join() === "avatar")
  const photoVoice = planCustomVideo(topicVideoBrief({ topic: topic(["neighborhood"], "Walking the riverfront district"), persona: "relocated", host: "voiceover", assets: { ...NONE, propertyPhotos: 4 } }).brief)
  check("a place topic WITH photos plans on the voiceover host as a photo story (the chain's first member)", photoVoice.ok && photoVoice.plan.archetype === "photo_story", photoVoice.ok ? photoVoice.plan.archetype : photoVoice.reason)
  const runnerSrc = readStripped("lib/video/topic-video-runner.ts")
  check("the runner probes for a ready twin (bounded) and falls back to the VOICEOVER host by name — no tenant skipped for want of a twin",
    /MAX_TWIN_PROBES/.test(runnerSrc) && /p\.canRender/.test(runnerSrc) && /const host: HostKind = agent \? "avatar" : "voiceover"/.test(runnerSrc) && /"no_twin_ready_voiceover_used"/.test(runnerSrc) && !/"no_twin_ready"\)/.test(runnerSrc) && /out\.byHost\[host\]/.test(runnerSrc))
  const silent = planCustomVideo(topicVideoBrief({ topic: topic(["buyer_advice"]), persona: "first_time", host: "silent", assets: NONE }).brief)
  check("NEGATIVE CONTROL: a silent host is refused by the planner (the runner's `unplanned` skip is reachable)", !silent.ok)
  const prompt = topicScriptPrompt({ topic: topic(["finance"]), persona: "first_time", words: 120, archetype: "education_explainer" })
  check("the script prompt is compliance-FIRST (Fair Housing in the writing prompt, no invented numbers, not salesy, the situation not a group)",
    /Fair Housing Act/.test(prompt) && /Never invent numbers/.test(prompt) && /Not salesy/.test(prompt) && /never to a group of people/.test(prompt))
  const nd = read("remotion/NewsletterDigestVideo.tsx")
  check("NewsletterDigestVideo's chrome labels are props with the newsletter wording as the default (the digest renders exactly as before)",
    /beatLabel \|\| "This week in your market"/.test(nd) && /label \|\| "Inside this week's digest"/.test(nd) && /endHeadline \|\| "Open the email"/.test(nd) && /endSubline \|\| "for this week's full digest"/.test(nd))
}

console.log("\n── §runner · compliance-first, the ONE rail, the claim after the asset ──")
{
  const r = readStripped("lib/video/topic-video-runner.ts")
  const at = (re: RegExp) => { const m = re.exec(r); return m ? m.index : -1 }
  check("routed + booked: generateObjectRouted with brokerageId from the tenant row (t.id) and a feature key", /generateObjectRouted\(\{[\s\S]{0,200}feature:\s*"video_script_generation"[\s\S]{0,80}brokerageId:\s*t\.id/.test(r))
  check("compliance system blocks + spoken standards wrap the prompt", /buildComplianceSystemBlocks\(t\.id/.test(r) && /withSpokenScriptStandards\(topicScriptPrompt\(/.test(r))
  const scan = at(/detectFairHousingRedFlags\(/), post = at(/await postcheckScript\(/), commission = at(/commissionCustomVideo\(brief/), claim = at(/logTopicUses\(\{/)
  check("order: fair-housing scan → postcheck → Director → claim", scan > 0 && post > scan && commission > post && claim > commission, `scan@${scan} post@${post} commission@${commission} claim@${claim}`)
  check("the hook line is scanned with the rest of the on-screen copy", /detectFairHousingRedFlags\(`\$\{object\.title\}\\n\$\{object\.hook\}/.test(r))
  check("the claim is logged only for a NEWLY staged video, with the project as the asset", /r\.status !== "staged"/.test(r) && /assetId:\s*r\.videoProjectId/.test(r))
  check("pickTopics is asked with territory, persona, season and markUsed:false (claim later)",
    /recipientLocation:\s*\{\s*city:\s*t\.city,\s*state:\s*t\.state,\s*zip_code:\s*t\.zip\s*\}/.test(r) && /recipientPersona:\s*persona/.test(r) && /boostCategories:\s*season\.categories/.test(r) && /markUsed:\s*false/.test(r))
  check("refusals are READ ({ data, error } on the tenant, cadence, agent and persona reads)",
    /\{\s*data:\s*tenants,\s*error:\s*tenantErr\s*\}/.test(r) && /\{\s*data:\s*cadenceRows,\s*error:\s*cadenceErr\s*\}/.test(r) && /\{\s*data:\s*agents,\s*error:\s*agentErr\s*\}/.test(r) && /\{\s*data:\s*book,\s*error:\s*bookErr\s*\}/.test(r))
  check("every skip is counted by name (bump) — demo, cadence off, day, no agent, empty pool, unplanned, red flag, director status",
    ["demo_tenant", "cadence_off", "not_this_tenants_day", "no_active_agent", "pool_empty_for_persona", "unplanned", "fair_housing_red_flag"].every((k) => r.includes(`"${k}"`)) && /director_\$\{r\.status\}/.test(r))
  check("the content handed to the Director is keyed by the PLANNED composition (topicVideoContent(planned.plan.compositionId, …))", /topicVideoContent\(planned\.plan\.compositionId, object\)/.test(r))
  const director = readStripped("lib/video/video-director.ts")
  check("the ONE rail stages pending_review (a human approves every customer-facing video)", /approval_status:\s*"pending_review"/.test(director) && /export async function commissionCustomVideo/.test(director))

  // THE CRON: its own named step, never inside the listing plays' const (owner, wave 83).
  const cron = readStripped("app/api/cron/video-plays/route.ts")
  const listingConst = /const \[([^\]]*)\]\s*=\s*await Promise\.all\(\[([\s\S]*?)\]\)/.exec(cron)
  const insideListingConst = (src: string) => {
    const m = /const \[([^\]]*)\]\s*=\s*await Promise\.all\(\[([\s\S]*?)\]\)/.exec(src)
    return !!m && /runTopicPoolVideos|topicVideos|runTopicPoolStep/.test(m[1] + m[2])
  }
  check("the listing plays' const still runs runListingBrochures (unchanged) and no longer carries the topic runner", !!listingConst && /runListingBrochures\(svc\)/.test(listingConst[2]) && !insideListingConst(cron))
  check("POSITIVE CONTROL: the 82C shape (topic runner destructured beside runListingBrochures) is flagged",
    insideListingConst(`const [brochures, topicVideos] = await Promise.all([\n runListingBrochures(svc),\n runTopicPoolVideos(svc),\n ])`))
  check("the topic runner is its OWN named step with its own error handling and result key (runTopicPoolStep → try/catch → { error }; summary key topicPool)",
    /async function runTopicPoolStep\(/.test(cron) && /return await runTopicPoolVideos\(svc\)/.test(cron) && /catch \(e\)[\s\S]{0,200}return \{ error \}/.test(cron) && /topicPool\s*\}/.test(cron) && /const topicPool = await topicPoolStep/.test(cron))
  check("still on the EXISTING daily video-plays cron (no new cron)", /"\/api\/cron\/video-plays"/.test(readStripped("lib/kernel/cron-dispatch.ts")))
}

console.log("\n── §registered · package.json, ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:topic-pool-video runs this file and sits in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:topic-pool-video"] === "tsx scripts/topic-pool-video-guard.ts" && guard.indexOf("npm run test:scrapers") !== -1 && guard.indexOf("npm run test:topic-pool-video") > guard.indexOf("npm run test:scrapers"))
  check("manager-registry: MAINTENANCE_DOMAINS.topic_pool_video names asset_manager with co-owners", /topic_pool_video:\s*\{ manager: "asset_manager", proof: "test:topic-pool-video", coOwners: \[[^\]]+\]/.test(readStripped("lib/kernel/manager-registry.ts")))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
