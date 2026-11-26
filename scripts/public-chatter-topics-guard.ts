/**
 * scripts/public-chatter-topics-guard.ts — wave 154, lane 154C (test:public-chatter-topics). ALL SIMULATED.
 *
 * Proves, on an in-memory database and COUNTING provider seams (no provider is ever called live):
 *   A  the R9 exclusion gate (directive C5.4) — adversarial fixtures, the "new agent" false positive, engagement never rescues
 *   B  the reword-before-store near-copy refusal (R1) — with a positive control
 *   C  Nextdoor PUBLIC post → topic path: one transport call, a reworded topic stored, zero personal data, zero person writes
 *   D  Nextdoor PERSON path → held (LICENSE_REQUIRED), zero transport calls; portals / search pages held under every purpose
 *   E  sign-in-gated / private / session URLs refused before a call; a sign-in wall page held and discarded
 *   F  a public first-person question and an anonymous discussion route differently; both stay topics
 *   G  a cross-site repost (Nextdoor + Facebook) is ONE idea with linked provenance, counted once
 *   H  a deleted / superseded source is re-evaluated (rejected / stale), idempotently; a used topic stays used
 *   I  Facebook group question + Meta ad creative → topics, zero RawData / Raw Lead / Contact / outreach writes
 *   J  insurance-education ad → question brief; new-hire ad never enters the pool; brand slogan filtered despite 90k reactions
 *   K  missing ad metrics are unknown; the engagement column is not fed an unmeasured / non-0–100 number
 *   L  replay, duplicate actor result, denied rights, disconnected key, budget breach, removed source — idempotent + truthful
 *   M  the adversarial seed of directive line 357
 *   N  the IMPORT GRAPH of the idea path reaches no acquisition side door (positive control: the acquisition play does)
 *   O  tenant pinning + refusals read (CLAUDE.md §3 / §4)
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { intakeTopicIdeas, classifyTopicExclusion, rewordedNearCopyProblem, reevaluateRemovedTopicSource, type TopicIdea } from "../lib/content-intel/topic-intake"
import {
  researchCommunityPostTopics, normalizeFacebookGroupItems, normalizeMetaAdItems, apifyIdeaSourceProblem, apifyIdeaBudgetProblem,
  routeChatter, fenceUntrusted, deriveRewordedTopic, saveManualTopicObservation, APIFY_IDEA_ACTORS, type StatementClassifier,
} from "../lib/content-intel/public-chatter-topics"
import { fetchCheckpointedSnapshot, COMMUNITY_TOPIC_RESEARCH_PURPOSE, SCRAPE_PURPOSES, communityTopicTargetProblem } from "../lib/providers/scrape-checkpoint"

const ROOT = process.cwd()
let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── In-memory database (records every write per table) ─────────────────────────────────────────────────────────────────
type Row = Record<string, any>
function memDb() {
  const tables: Record<string, Row[]> = {}
  const writes: Array<{ table: string; op: string }> = []
  let seq = 0
  const get = (o: any, path: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(path)
    if (m) { const v = o?.[m[1]]?.[m[2]]; return v == null ? null : String(v) }
    return o?.[path]
  }
  const contains = (a: any, b: any): boolean => {
    if (Array.isArray(b)) return Array.isArray(a) && b.every((bi) => a.some((ai: any) => contains(ai, bi)))
    if (b && typeof b === "object") return !!a && typeof a === "object" && Object.entries(b).every(([k, v]) => contains(a[k], v))
    return a === b
  }
  function from(table: string) {
    const rows = (tables[table] ??= [])
    let op: "select" | "insert" | "update" = "select"
    let payload: any = null
    const filters: Array<(r: Row) => boolean> = []
    let limitN: number | null = null
    let single = false
    const q: any = {
      select() { return q },
      insert(p: any) { op = "insert"; payload = p; return q },
      update(p: any) { op = "update"; payload = p; return q },
      eq(c: string, v: any) { filters.push((r) => get(r, c) === v); return q },
      is(c: string, v: any) { filters.push((r) => (get(r, c) ?? null) === v); return q },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(get(r, c))); return q },
      gte(c: string, v: any) { filters.push((r) => String(get(r, c) ?? "") >= String(v)); return q },
      lt(c: string, v: any) { filters.push((r) => String(get(r, c) ?? "") < String(v)); return q },
      contains(c: string, v: any) { filters.push((r) => contains(r[c], v)); return q },
      order() { return q },
      limit(n: number) { limitN = n; return q },
      single() { single = true; return q },
      maybeSingle() { single = true; return q },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
    }
    function run() {
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: `${table}-${++seq}`, created_at: new Date(0).toISOString(), ...JSON.parse(JSON.stringify(p)) }))
        for (const r of list) { rows.push(r); writes.push({ table, op: "insert" }) }
        return { data: single ? list[0] : list, error: null }
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      if (op === "update") {
        for (const r of hit) { Object.assign(r, JSON.parse(JSON.stringify(payload))); writes.push({ table, op: "update" }) }
        return { data: hit.map((r) => ({ id: r.id })), error: null }
      }
      const out = limitN === null ? hit : hit.slice(0, limitN)
      return { data: single ? (out[0] ?? null) : out, error: null }
    }
    return q
  }
  return { from, tables, writes }
}
const ALLOWED_WRITE_TABLES = new Set(["content_topic_bank", "content_topic_sources", "lead_scraping_jobs", "self_heal_events"])
const forbiddenWrites = (db: ReturnType<typeof memDb>) => db.writes.filter((w) => !ALLOWED_WRITE_TABLES.has(w.table))
const allStored = (db: ReturnType<typeof memDb>) => JSON.stringify(db.tables.content_topic_bank ?? [])

const NOW = new Date("2026-11-18T12:00:00Z")
const A = "brokerage-A", B = "brokerage-B"
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/

/** A counting page transport + robots + store for the checkpoint. */
function transport(htmlFor: (url: string) => string) {
  const calls: Array<{ url: string; headers: Record<string, string> | null }> = []
  const store = new Map<string, any>()
  const deps = {
    fetcher: async (url: string, opts: any) => { calls.push({ url, headers: opts.requestHeaders }); return { ok: true, html: htmlFor(url), provider: "zyte" as const, cost: 0.001, costBasis: "final" as const, statusCode: 200, vendorStatus: null, headers: {}, notModified: false, error: null } },
    robots: async () => ({ status: 404, text: null }),
    store: { load: async (k: string) => (store.has(k) ? { id: k, state: store.get(k) } : false as const), save: async (id: string | null, st: any) => { store.set(st.key, st); return { ok: true, id: st.key, error: null } } } as any,
    spendGate: () => ({ allowed: true, reason: "test budget" }),
    configuredProviders: ["zyte"] as const,
    now: () => NOW,
  }
  return { calls, deps }
}
const page = (body: string, published = "2026-11-10T09:00:00Z") => `<html><head><meta property="article:published_time" content="${published}"><script>var x=1</script></head><body><div class="author">Pat Neighbor</div><p>${body}</p></body></html>`

/** The existing classifier's SHAPE (readPublicStatement in lib/acquisition-plays/public-request.ts — not exported at base). */
const classify: StatementClassifier = (t) => {
  const fp = /\b(I|I'm|we|we're|my|our)\b/.test(t) && /\b(looking to buy|selling (?:my|our) (?:home|house)|need (?:a|an) (?:realtor|agent))\b/i.test(t)
  return { firstPerson: fp, requestsAgentContact: /\bneed (?:a|an) (?:realtor|agent)\b/i.test(t), statesHousingNeed: fp }
}

async function main() {
  console.log("\n[A · the R9 exclusion gate]")
  const noise: Array<[string, string]> = [
    ["Please welcome our newest agent, Jane Doe, to the Coastline Realty family!", "competitor_agent_joining"],
    ["Big news: Sam Rivera has officially joined our team this week.", "competitor_agent_joining"],
    ["Thinking about switching brokerages? Join our team for a 90/10 split.", "recruitment_pitch"],
    ["Top 1% agent in the county — sold 500+ homes. Call me today.", "unverified_performance"],
    ["We're #1 in Broward again! Celebrating 20 years of service.", "competitor_brand_self_promotion"],
    ["Grand opening of our new office location downtown this Saturday!", "competitor_brand_self_promotion"],
    ["Just sold! Another one sold over asking. Tag a friend!", "no_consumer_value"],
    ["Welcome our new agent Sam! Ask about closing costs?", "competitor_agent_joining"],
  ]
  const verdicts = noise.map(([t, want]) => ({ t, want, got: classifyTopicExclusion({ title: t }) }))
  check(`POSITIVE CONTROL: every noise fixture is excluded with its reason (${verdicts.filter((v) => v.got.excluded && v.got.reason === v.want).length}/${noise.length})`, verdicts.every((v) => v.got.excluded && v.got.reason === v.want), verdicts.filter((v) => !(v.got.excluded && v.got.reason === v.want)).map((v) => `${v.t} → ${v.got.reason}`).join(" | "))
  const fp = classifyTopicExclusion({ title: "What a new agent relationship means for buyers", text: "How buyer representation agreements work, what you sign, and how compensation is negotiated before you tour homes with any agent." })
  check("the FALSE POSITIVE the directive names survives: a useful buyer-representation article that says 'new agent'", !fp.excluded, String(fp.reason))
  const mixed = classifyTopicExclusion({ title: "Proud to announce our new office opening!", text: "Meanwhile buyers keep asking how closing costs work here: lender fees, title charges and prepaid taxes all add up, and this is how to estimate them before you make an offer." })
  check("a post that MAINLY carries a consumer question survives once the brand pitch is separated", !mixed.excluded, String(mixed.reason))
  check("plain consumer questions pass the gate", !classifyTopicExclusion({ title: "How much are flood insurance premiums going up for older homes?" }).excluded)

  console.log("\n[B · reword-before-store: the near-copy refusal]")
  const src = "Our homeowners insurance premium just went up forty percent and nobody can explain why the renewal jumped so much this year"
  check("POSITIVE CONTROL: a verbatim excerpt is refused", !!rewordedNearCopyProblem("homeowners insurance premium just went up forty percent", src))
  check("POSITIVE CONTROL: a synonym swap that keeps a shared phrase is refused", !!rewordedNearCopyProblem("homeowners insurance premium went up forty percent renewal jumped", src))
  check("an original rewording passes", rewordedNearCopyProblem("Homeowners and flood insurance: what local neighbors are asking right now", src) === null)

  console.log("\n[C · Nextdoor PUBLIC post → reworded topic, zero personal data (SIMULATED transport)]")
  const ndText = "Hi neighbors, I'm Pat Neighbor (pat.n@example.com, 954-555-0142). Our homeowners insurance premium just went up forty percent at renewal. How are people handling rising insurance costs around here?"
  const t1 = transport(() => page(ndText))
  const db1 = memDb()
  const c1 = await researchCommunityPostTopics(db1 as any, { brokerageId: A, urls: ["https://nextdoor.com/p/AbC123xyz"], geo: { city: "Coral Springs", state: "FL", label: "Coral Springs" }, now: NOW }, { snapshot: t1.deps as any, classify })
  const bank1 = db1.tables.content_topic_bank ?? []
  check(`one transport call under the TOPIC purpose (calls: ${t1.calls.length})`, t1.calls.length === 1)
  check("no cookie / credential / authorization header rode the request", t1.calls.every((c) => !c.headers || !Object.keys(c.headers).some((k) => /cookie|authorization|token/i.test(k))))
  check(`one reworded topic stored (inserted ${c1.intake?.inserted ?? 0}, rule-derived ${c1.derived.ruleDerived})`, c1.intake?.inserted === 1 && bank1.length === 1 && bank1[0].raw_data.intake.rights === "public_read_reworded")
  check("the stored row carries no email, phone or author name", !EMAIL.test(allStored(db1)) && !PHONE.test(allStored(db1)) && !/Pat Neighbor/.test(allStored(db1)))
  check("the stored title / angle are not a near-copy of the post", rewordedNearCopyProblem(bank1[0]?.topic_title ?? "", ndText) === null && rewordedNearCopyProblem(bank1[0]?.value_angle ?? "", ndText) === null)
  check("the post's wording is not stored anywhere in the row (no 5-word run of it in the serialized row)", rewordedNearCopyProblem(allStored(db1).replace(/[{}":,\[\]_]/g, " "), ndText)?.startsWith("shares a five-word") !== true)
  check("freshness: expires_at set; the source's published date kept as provenance", !!bank1[0]?.expires_at && bank1[0]?.topic_posted_at === "2026-11-10T09:00:00.000Z")
  check(`zero RawData / Lead / Contact / outreach writes (forbidden writes: ${forbiddenWrites(db1).length})`, forbiddenWrites(db1).length === 0)
  check("the C5.6 creative brief is mapped into raw_data (consumer_question, popularity_evidence_type unknown, source_rights)", !!bank1[0]?.raw_data?.creative_brief?.consumer_question && bank1[0].raw_data.creative_brief.popularity_evidence_type === "unknown" && bank1[0].raw_data.creative_brief.source_rights === "public_read_reworded")

  console.log("\n[D · Nextdoor PERSON path → LICENSE-HELD, zero calls; portals stay held]")
  const t2 = transport(() => page(ndText))
  const person = await fetchCheckpointedSnapshot({ url: "https://nextdoor.com/p/AbC123xyz", scope: { brokerageId: A, marketId: null, purpose: "real_estate_need_chatter" } }, t2.deps as any)
  check(`person-path purpose on nextdoor.com → held_terms LICENSE_REQUIRED (got ${person.status}), transport calls: ${t2.calls.length}`, person.status === "held_terms" && /LICENSE_REQUIRED/.test(person.reason) && t2.calls.length === 0)
  check("the owner's two acquisition purposes are unchanged (SCRAPE_PURPOSES)", JSON.stringify(SCRAPE_PURPOSES) === JSON.stringify(["real_estate_need_chatter", "fsbo_listing"]))
  for (const u of ["https://www.zillow.com/homedetails/1", "https://www.redfin.com/FL/x", "https://www.realtor.com/x", "https://www.google.com/search?q=homes"]) {
    const t = transport(() => "<html></html>")
    const r = await fetchCheckpointedSnapshot({ url: u, scope: { brokerageId: A, marketId: null, purpose: COMMUNITY_TOPIC_RESEARCH_PURPOSE } }, t.deps as any)
    check(`${new URL(u).hostname} under the TOPIC purpose → refused, zero calls (${r.status})`, r.status === "refused_purpose" && t.calls.length === 0)
  }

  console.log("\n[E · sign-in-gated / private pages refused]")
  for (const u of ["https://nextdoor.com/neighborhood/coral-springs/", "https://nextdoor.com/g/abc123/", "https://nextdoor.com/news_feed/", "https://nextdoor.com/p/AbC123xyz?session_token=1", "https://user:pw@nextdoor.com/p/AbC123xyz", "http://nextdoor.com/p/AbC123xyz"]) {
    const t = transport(() => page(ndText))
    const r = await fetchCheckpointedSnapshot({ url: u, scope: { brokerageId: A, marketId: null, purpose: COMMUNITY_TOPIC_RESEARCH_PURPOSE } }, t.deps as any)
    check(`${u} → refused before any call (${r.status})`, r.status === "refused_purpose" && t.calls.length === 0, r.reason)
  }
  check("POSITIVE CONTROL: the public post shape is accepted by the target rule", communityTopicTargetProblem("https://nextdoor.com/p/AbC123xyz") === null)
  const tw = transport(() => `<html><body><h1>Join Nextdoor to see this post</h1><form action="/login"><input type="password" name="p"></form></body></html>`)
  const dbw = memDb()
  const wall = await researchCommunityPostTopics(dbw as any, { brokerageId: A, urls: ["https://nextdoor.com/p/Wall9999"], now: NOW }, { snapshot: tw.deps as any })
  check(`a sign-in wall page is held_access_control and nothing is stored (${wall.held[0]?.status})`, wall.held[0]?.status === "held_access_control" && (dbw.tables.content_topic_bank ?? []).length === 0)

  console.log("\n[F · first-person question vs anonymous discussion]")
  const fpText = fenceUntrusted("We're looking to buy our first home next spring — how much should we budget for closing costs?")
  const anText = fenceUntrusted("How do closing costs usually split between buyer and seller in this county?")
  const rFp = routeChatter(fpText, "community_post", classify), rAn = routeChatter(anText, "community_post", classify)
  check(`routed differently: ${rFp.route} vs ${rAn.route}`, rFp.route === "first_person_topic_only" && rAn.route === "anonymous_topic")
  check("the first-person Nextdoor post's person path is LICENSE-held; from Facebook it is ideas-only", /license_held:nextdoor/.test(rFp.personPath) && /ideas_only/.test(routeChatter(fpText, "facebook_group_question", classify).personPath))
  const dFp = await deriveRewordedTopic(fpText, { geoLabel: "Coral Springs" })
  check("both still yield only a TOPIC (no person record is produced by this path)", dFp.status === "rule_derived")

  console.log("\n[G · cross-site repost → ONE idea, linked provenance, counted once]")
  const repost = "How are people handling rising insurance costs around here? Our homeowners insurance premium jumped at renewal."
  const tg = transport(() => page(repost))
  const dbg = memDb()
  await researchCommunityPostTopics(dbg as any, { brokerageId: A, urls: ["https://nextdoor.com/p/Repost111"], geo: { label: "Coral Springs" }, now: NOW }, { snapshot: tg.deps as any })
  const fb = await normalizeFacebookGroupItems([{ text: repost, url: "https://www.facebook.com/groups/csneighbors/posts/1", time: "2026-11-12T10:00:00Z", likesCount: 40, commentsCount: 12, user: { id: "u1", name: "Pat Neighbor" } }], { geo: { label: "Coral Springs" }, now: NOW })
  const rg = await intakeTopicIdeas(dbg as any, { brokerageId: A, ideas: fb.ideas, now: NOW })
  const gRows = dbg.tables.content_topic_bank ?? []
  const prov = gRows[0]?.raw_data?.provenance ?? []
  check(`one idea (rows: ${gRows.length}), merged ${rg.merged}, same observation ${rg.sameObservation}`, gRows.length === 1 && rg.merged === 1 && rg.sameObservation === 1)
  check("linked provenance: one observation, both URLs, both transports; independent_observations = 1", prov.length === 1 && prov[0].urls.length === 2 && prov[0].transports.includes("apify") && gRows[0].raw_data.independent_observations === 1)
  check("the Facebook author was dropped in memory (counted) and is stored nowhere", fb.droppedPersonFields >= 1 && !/Pat Neighbor|"u1"/.test(allStored(dbg)))

  console.log("\n[H · deleted / superseded source respected]")
  const r1 = await reevaluateRemovedTopicSource(dbg as any, { brokerageId: A, sourceUrl: "https://nextdoor.com/p/Repost111", disposition: "deleted", now: NOW })
  check(`one of the repost's two URLs deleted → the topic is kept on the surviving URL (kept ${r1.kept})`, r1.kept === 1 && gRows[0].status === "fresh" && JSON.stringify(gRows[0].raw_data.provenance[0].urls) === JSON.stringify(["https://www.facebook.com/groups/csneighbors/posts/1"]))
  // Removing the observation's last URL retires the topic.
  const r2 = await reevaluateRemovedTopicSource(dbg as any, { brokerageId: A, sourceUrl: "https://www.facebook.com/groups/csneighbors/posts/1", disposition: "deleted", now: NOW })
  check(`the last source deleted → status rejected (retired ${r2.retired}), never silently kept`, r2.retired === 1 && gRows[0].status === "rejected" && gRows[0].raw_data.source_removals.length === 2)
  const r3 = await reevaluateRemovedTopicSource(dbg as any, { brokerageId: A, sourceUrl: "https://www.facebook.com/groups/csneighbors/posts/1", disposition: "deleted", now: NOW })
  check("idempotent: a second removal finds nothing to change", r3.reevaluated === 0 && r3.ok)
  const dbu = memDb()
  await intakeTopicIdeas(dbu as any, { brokerageId: A, now: NOW, ideas: [{ sourceKind: "community_post", title: "Closing costs: what local neighbors are asking right now", observedAt: NOW.toISOString(), sourceUrl: "https://nextdoor.com/p/Used1", evidence: { kind: "unknown" }, rights: "public_read_reworded" }] })
  dbu.tables.content_topic_bank[0].status = "used"
  await reevaluateRemovedTopicSource(dbu as any, { brokerageId: A, sourceUrl: "https://nextdoor.com/p/Used1", disposition: "superseded", now: NOW })
  check("a USED topic stays used (it already shipped) and is flagged with the removal", dbu.tables.content_topic_bank[0].status === "used" && dbu.tables.content_topic_bank[0].raw_data.source_removals.length === 1)

  console.log("\n[I/J/K · Facebook group question + Meta ad creative → topics only]")
  const dbi = memDb()
  const groups = await normalizeFacebookGroupItems([
    { text: "Anyone know how to prepare for a rising homeowners insurance premium? Ours doubled.", url: "https://www.facebook.com/groups/x/posts/2", time: "2026-11-15T10:00:00Z", likesCount: 15, commentsCount: 30, user: { name: "A Member" }, topComments: [{ text: "call me", profileName: "B" }] },
    { text: "We're #1 in the county — the most trusted name in real estate!", url: "https://www.facebook.com/groups/x/posts/3", time: "2026-11-15T10:00:00Z", likesCount: 90000, commentsCount: 4000 },
  ], { geo: { label: "Coral Springs" }, now: NOW, classify })
  const ads = await normalizeMetaAdItems([
    { adArchiveID: "111", pageID: "p1", collationId: "c1", startDateFormatted: "2026-03-01", snapshot: { title: "Is your homeowners insurance premium about to jump?", body: { text: "Learn what drives flood and wind insurance costs and the questions to ask your insurer before renewal." }, displayFormat: "VIDEO" } },
    { adArchiveID: "112", pageID: "p1", collationId: "c1", snapshot: { title: "Is your homeowners insurance premium about to jump? (v2)", body: { text: "Same campaign, second version." }, displayFormat: "IMAGE" } },
    { adArchiveID: "222", pageID: "p2", collationId: "c2", snapshot: { title: "Please welcome our newest agent!", body: { text: "We're thrilled to welcome Alex to the Bayside Realty family. Join our team!" }, displayFormat: "IMAGE" } },
  ], { geo: { label: "Coral Springs" }, now: NOW })
  const ri = await intakeTopicIdeas(dbi as any, { brokerageId: A, ideas: [...groups.ideas, ...ads.ideas], now: NOW })
  const iRows = dbi.tables.content_topic_bank ?? []
  check(`group question + ad creative landed as topics (inserted ${ri.inserted}, rows ${iRows.length})`, ri.inserted >= 2 && iRows.some((r) => r.raw_data.intake.source_kind === "facebook_group_question") && iRows.some((r) => r.raw_data.intake.source_kind === "meta_ad_creative"))
  check(`zero RawData / Raw Lead / Contact / outreach writes (forbidden: ${forbiddenWrites(dbi).length})`, forbiddenWrites(dbi).length === 0)
  const adRow = iRows.find((r) => r.raw_data.intake.source_kind === "meta_ad_creative")
  check("the insurance-education ad became a QUESTION brief (consumer_question, insurance theme)", !!adRow?.raw_data?.creative_brief?.consumer_question && (adRow?.raw_data?.theme_keys ?? []).includes("insurance"))
  check(`the new-hire ad did NOT enter the pool (excluded: ${ads.excluded.map((e) => e.reason).join(",")})`, ads.excluded.some((e) => e.reason === "competitor_agent_joining") && !/Alex|Bayside/.test(allStored(dbi)))
  check(`the brand slogan was filtered despite 94,000 visible reactions + comments (excluded: ${groups.excluded.map((e) => e.reason).join(",")})`, groups.excluded.length === 1 && !/most trusted/.test(allStored(dbi)))
  check(`two versions of one campaign collapsed into one observation (collapsed ${ads.campaignsCollapsed})`, ads.campaignsCollapsed === 1)
  const m = adRow?.raw_data?.ad_metrics ?? {}
  check("missing ad metrics are UNKNOWN; longevity is not performance; evidence kind unknown", m.conversion === "unknown" && m.cpa === "unknown" && m.ctr === "unknown" && m.impressions === "unknown" && m.spend === "unknown" && m.longevity_is_not_performance === true && adRow?.raw_data?.popularity_evidence_type === "unknown")
  check("the engagement column is NOT written from unknown evidence or from a raw count (only a stated 0–100 score)", iRows.every((r) => !("engagement_score" in r)))
  const dbs = memDb()
  await intakeTopicIdeas(dbs as any, { brokerageId: A, now: NOW, ideas: [{ sourceKind: "topic_intelligence", title: "Mortgage rates and what they mean for a payment", observedAt: NOW.toISOString(), evidence: { kind: "proxy", metric: "x", value: 64, unit: "score_0_100" }, rights: "first_party" }] })
  check("POSITIVE CONTROL: a stated 0–100 score IS written to the column", dbs.tables.content_topic_bank?.[0]?.engagement_score === 64)
  check("the group post's public counts are MEASURED evidence in their own unit", iRows.find((r) => r.raw_data.intake.source_kind === "facebook_group_question")?.raw_data?.evidence?.unit === "count")

  console.log("\n[L · replay, duplicates, rights, key, budget, removed source]")
  const ri2 = await intakeTopicIdeas(dbi as any, { brokerageId: A, ideas: [...groups.ideas, ...ads.ideas], now: NOW })
  check(`replay is idempotent: inserted ${ri2.inserted}, merged ${ri2.merged}, same observation ${ri2.sameObservation}; rows unchanged (${(dbi.tables.content_topic_bank ?? []).length})`, ri2.inserted === 0 && ri2.sameObservation === ri2.merged && (dbi.tables.content_topic_bank ?? []).length === iRows.length && iRows.every((r) => r.raw_data.independent_observations === 1))
  const dupItems = [{ text: "How do property taxes change after you buy a home here?", url: "https://www.facebook.com/groups/x/posts/9", time: "2026-11-15T10:00:00Z" }]
  const dup = await normalizeFacebookGroupItems([...dupItems, ...dupItems], { now: NOW })
  const dbd = memDb()
  const rd = await intakeTopicIdeas(dbd as any, { brokerageId: A, ideas: dup.ideas, now: NOW })
  check(`a duplicate actor result in one batch is one row (inserted ${rd.inserted}, same observation ${rd.sameObservation})`, rd.inserted === 1 && rd.sameObservation === 1)
  check("denied rights: a group not recorded PUBLIC is refused (no call)", !!apifyIdeaSourceProblem({ actor: "apify/facebook-groups-scraper", input: { startUrls: [] }, rights: "public_read_reworded" }))
  check("denied rights: no rights status → PENDING_RIGHTS hold (no call)", /PENDING_RIGHTS/.test(apifyIdeaSourceProblem({ actor: "apify/facebook-groups-scraper", input: {}, visibility: "public" }) ?? ""))
  check("a cookie / login field in the actor input is refused; includeAboutPage (contact details) is refused", !!apifyIdeaSourceProblem({ actor: "apify/facebook-groups-scraper", input: { cookies: "x" }, visibility: "public", rights: "public_read_reworded" }) && !!apifyIdeaSourceProblem({ actor: "apify/facebook-ads-scraper", input: { includeAboutPage: true }, rights: "public_read_reworded" }))
  check("POSITIVE CONTROL: a public group with recorded rights passes", apifyIdeaSourceProblem({ actor: "apify/facebook-groups-scraper", input: { startUrls: [{ url: "https://www.facebook.com/groups/x" }] }, visibility: "public", rights: "public_read_reworded" }) === null)
  check("intake refuses rights 'unknown' with a machine-readable reason", (await intakeTopicIdeas(memDb() as any, { brokerageId: A, now: NOW, ideas: [{ sourceKind: "manual_link", title: "Closing costs explained", observedAt: NOW.toISOString(), evidence: { kind: "unknown" }, rights: "unknown" }] })).excluded[0]?.reason === "rights_unknown")
  check("budget breach: over-budget, unbudgeted and unbounded runs are held before any call", !!apifyIdeaBudgetProblem({ actor: "apify/facebook-ads-scraper", input: { resultsLimit: 1000 }, max_run_usd: 1 }) && !!apifyIdeaBudgetProblem({ actor: "apify/facebook-ads-scraper", input: { resultsLimit: 10 } }) && !!apifyIdeaBudgetProblem({ actor: "apify/facebook-ads-scraper", input: {}, max_run_usd: 5 }))
  check("POSITIVE CONTROL: a bounded run inside its budget passes", apifyIdeaBudgetProblem({ actor: "apify/facebook-ads-scraper", input: { resultsLimit: 20 }, max_run_usd: 1 }) === null)
  // Disconnected key: the run seam is never reached (apify-scraper.ts is server-only — driven under react-server).
  const { runApifyScrape } = await import("../lib/content-intel/apify-scraper")
  let runnerCalls = 0
  const noKey = await runApifyScrape({ actor: "apify/facebook-ads-scraper", input: {} }, { token: null, runner: async () => { runnerCalls++; return { ok: true, data: [] } } })
  check(`disconnected key → no call (runner calls ${runnerCalls}), truthful status with a resolution path`, runnerCalls === 0 && noKey.called === false && /connect Apify/.test(noKey.error ?? ""))
  const route = stripComments(readFileSync(join(ROOT, "app/api/cron/content-intel-apify/route.ts"), "utf8"))
  const at = (s: string) => route.indexOf(s)
  check("removed / inactive source makes zero calls: the cron selects is_active = true, and rights + budget checks precede the run",
    at('.eq("is_active", true)') > 0 && at("apifyIdeaSourceProblem(cfg)") > at('.eq("is_active", true)') && at("apifyIdeaBudgetProblem(cfg)") > at("apifyIdeaSourceProblem(cfg)") && at("runApifyScrape(") > at("apifyIdeaBudgetProblem(cfg)") && /resolution: RESOLUTION/.test(route))
  check("the cron files through THE ONE intake and never inserts into content_topic_bank directly", /intakeTopicIdeas\(svc/.test(route) && !/from\("content_topic_bank"\)/.test(route))
  check("the actor certification records UNVERIFIED items rather than guessing", Object.values(APIFY_IDEA_ACTORS).every((a) => a.unverified.length > 0 && !!a.actorId && !!a.pricing))

  console.log("\n[M · the adversarial seed (directive line 357)]")
  const competitorParagraph = "At Sunshine Elite Realty we turn every listing into a sold sign faster than anyone else in the state, guaranteed."
  const seed = await normalizeFacebookGroupItems([
    { text: "My renewal notice says my homeowners insurance premium is going up again. What questions should I ask my insurer before renewal? Reach me at jo.seller@example.com or 305-555-0199.", url: "https://www.facebook.com/groups/y/posts/1", time: "2026-11-16T10:00:00Z", user: { name: "Jo Seller", id: "u9" }, profileUrl: "https://www.facebook.com/jo.seller" },
    { text: competitorParagraph, url: "https://www.facebook.com/groups/y/posts/2", time: "2026-11-16T10:00:00Z", likesCount: 5000 },
    { text: "Please welcome our newest agent Chris to the Sunshine Elite Realty family!", url: "https://www.facebook.com/groups/y/posts/3", time: "2026-11-16T10:00:00Z", likesCount: 800 },
  ], { geo: { label: "Coral Springs" }, now: NOW, classify })
  const dbm = memDb()
  await intakeTopicIdeas(dbm as any, { brokerageId: A, ideas: seed.ideas, now: NOW })
  const ms = allStored(dbm)
  check("no personal data stored (email, phone, author name, profile link)", !EMAIL.test(ms) && !PHONE.test(ms) && !/Jo Seller|jo\.seller|"u9"/.test(ms))
  check(`no RawData / Raw Lead / Contact write and no outbound message (forbidden writes: ${forbiddenWrites(dbm).length})`, forbiddenWrites(dbm).length === 0)
  check("the competitor paragraph is not reproduced (no 5-word run of it stored)", !(dbm.tables.content_topic_bank ?? []).some((r) => rewordedNearCopyProblem(`${r.topic_title} ${r.value_angle ?? ""}`, competitorParagraph)))
  check(`the new-agent announcement is excluded (excluded: ${seed.excluded.map((e) => e.reason).join(",")})`, seed.excluded.some((e) => e.reason === "competitor_agent_joining"))
  check("the useful question in the seed still became a topic", (dbm.tables.content_topic_bank ?? []).some((r) => (r.raw_data.theme_keys ?? []).includes("insurance")))

  console.log("\n[N · import graph: the idea path reaches no acquisition side door]")
  const FORBIDDEN = [/lib\/lead-pipeline\/social-sourcer\.ts$/, /lib\/kernel\/scraping\.ts$/, /lib\/ai-isa\//, /lib\/lead-pipeline\/raw-data-producer/]
  const FORBIDDEN_CALL = /\bingestRawSourceBatch\s*\(/
  function resolveSpec(fromFile: string, spec: string): string | null {
    let base: string
    if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2))
    else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec)
    else return null
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c) && c.match(/\.tsx?$/)) return c
    return null
  }
  // What the idea path EXECUTES: every static import (it loads), plus the lazy import() calls made BY the idea path's own files
  // (they are calls this path makes). A lazy import() inside a third-party module runs only if this path calls that function —
  // published as a blind spot below. The call token is matched on string-blanked code, so prose naming it never counts.
  const IDEA_PATH = new Set(["lib/content-intel/public-chatter-topics.ts", "lib/content-intel/topic-intake.ts", "lib/content-intel/topic-themes.ts", "lib/content-intel/system-topic-source.ts", "lib/content-intel/apify-scraper.ts", "lib/providers/apify/client.ts", "lib/providers/scrape-checkpoint.ts", "app/api/cron/content-intel-apify/route.ts", "app/api/cron/content-intel-reddit/route.ts"])
  function walk(entry: string) {
    const seen = new Set<string>(), hits: string[] = []
    const stack = [join(ROOT, entry)]
    let lazyFollowed = 0
    while (stack.length) {
      const f = stack.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      const rel = f.slice(ROOT.length + 1)
      const src = stripComments(readFileSync(f, "utf8"))
      if (FORBIDDEN.some((re) => re.test(rel)) || FORBIDDEN_CALL.test(blankStrings(src))) hits.push(rel)
      const lazyHere = rel === entry || IDEA_PATH.has(rel)
      const lazy = lazyHere ? [...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]) : []
      lazyFollowed += lazy.length
      const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"\n;]*?from\s*["']([^"']+)["']/g), ...src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)].map((m) => m[1]).concat(lazy)
      for (const s of specs) { const r = resolveSpec(f, s); if (r && !seen.has(r)) stack.push(r) }
    }
    return { reached: seen.size, hits, lazyFollowed }
  }
  for (const entry of ["lib/content-intel/public-chatter-topics.ts", "lib/content-intel/topic-intake.ts", "lib/content-intel/apify-scraper.ts", "app/api/cron/content-intel-apify/route.ts", "app/api/cron/content-intel-reddit/route.ts"]) {
    const g = walk(entry)
    check(`${entry}: ${g.reached} modules reached (${g.lazyFollowed} lazy imports of the path followed), side doors reached: ${g.hits.length}`, g.hits.length === 0, g.hits.join(", "))
  }
  const ctl = walk("lib/acquisition-plays/public-request.ts")
  check(`POSITIVE CONTROL: the walker DOES find the side door from the acquisition play (${ctl.hits.slice(0, 3).join(", ")}…)`, ctl.hits.some((h) => /lib\/kernel\/scraping\.ts|lib\/ai-isa\//.test(h)))
  check("POSITIVE CONTROL: the call token is found in code and ignored in prose", FORBIDDEN_CALL.test(blankStrings(stripComments("await ingestRawSourceBatch(p)"))) && !FORBIDDEN_CALL.test(blankStrings(stripComments('const s = "ingestRawSourceBatch(x)" // ingestRawSourceBatch(y)'))))

  console.log("\n[O · tenant pinning and refusals]")
  check("no tenant → refused", !!(await intakeTopicIdeas(memDb() as any, { brokerageId: "", ideas: [] })).refused)
  const dbt = memDb()
  const idea: TopicIdea = { sourceKind: "manual_link", title: "Down payments and assistance programs explained", observedAt: NOW.toISOString(), evidence: { kind: "unknown" }, rights: "own_content", sourceUrl: "https://example.org/a" }
  await intakeTopicIdeas(dbt as any, { brokerageId: A, ideas: [idea], now: NOW })
  await intakeTopicIdeas(dbt as any, { brokerageId: B, ideas: [idea], now: NOW })
  const tRows = dbt.tables.content_topic_bank ?? []
  check("the same idea for two tenants is two rows, each pinned (no cross-tenant merge)", tRows.length === 2 && tRows.some((r) => r.brokerage_id === A) && tRows.some((r) => r.brokerage_id === B))
  const refusing = { from: (t: string) => { const q: any = memDb().from(t); if (t === "content_topic_bank") { q.in = () => ({ then: (r: any) => Promise.resolve({ data: null, error: { message: "permission denied" } }).then(r) }) } return q } }
  const rr = await intakeTopicIdeas(refusing as any, { brokerageId: A, ideas: [idea], now: NOW })
  check("a refused read is READ and reported — nothing stored, not 'ok'", !rr.ok && /permission denied/.test(rr.refused ?? ""))
  const stale = await normalizeFacebookGroupItems([{ text: "How much are closing costs for buyers here?", url: "https://www.facebook.com/groups/x/posts/old", time: "2025-10-01T10:00:00Z" }], { now: NOW })
  const rs = await intakeTopicIdeas(memDb() as any, { brokerageId: A, ideas: stale.ideas, now: NOW })
  check("a year-old post is not current intent → stale_source, not stored", rs.excluded[0]?.reason === "stale_source" && rs.inserted === 0)
  const manual = await saveManualTopicObservation(memDb() as any, { brokerageId: A, note: "Buyers at my open house kept asking how HOA fees affect the payment", now: NOW })
  check("the manual door files a subscriber's own observation through the same intake", manual.inserted === 1)
  const manualPii = await saveManualTopicObservation(memDb() as any, { brokerageId: A, note: "Call Dana at 954-555-0100 about her closing costs", now: NOW })
  check("…and refuses one carrying a phone number", manualPii.inserted === 0 && manualPii.excluded[0]?.reason === "personal_data_in_topic")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` Denominators: ${noise.length} noise fixtures + 3 survivors; 4 portal / search hosts; 6 refused Nextdoor URL shapes; 4 import-graph entries (+1 control); 2 Apify idea actors`)
  console.log(" Blind spots: the gate is pattern-based (a pitch phrased outside its patterns passes); the Nextdoor public-post path shape is UNVERIFIED against a live page;")
  console.log("  the statement classifier here is a stand-in with the SHAPE of readPublicStatement (not exported at base — Outside-lane request);")
  console.log("  no rewording model is wired (rule-derived topics are the production rewording); all transports and actors are SIMULATED.")
  console.log(`\n public-chatter-topics: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(` FAILED: ${failures.join(" | ")}`); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
