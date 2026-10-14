/**
 * lib/enrichment/web-mention-search.ts — the SEARCH-ENRICHMENT rung (wave 82 lane A)
 *
 * Owner verbatim (wave 82): "osint is supposed to be a free provider for intent behavior
 * acquisition and a free search enrichment. exa can also be used for these".
 *
 * WHAT IT REPLACES AS THE FIRST RUNG, AND WHY (expert verdict, measured not assumed):
 * the contact life-change re-check (lib/enrichment/contact-enrichment-core.ts::
 * runLifeChangeCheck) asked lib/osint-client.ts::searchPerson — SIX ZenRows premium-proxy
 * scrapes (~$0.06, booked as zenrows) of people-search / court / social pages whose parser
 * flags a life event when the WORD "divorce" / "death" / "bankruptcy" appears ANYWHERE in the
 * page (lane 81B's audit: `records: []` by construction, keyword flags only). That is neither
 * free nor evidence. One Exa search is $0.007 (+ content pages), inside a $10/month free
 * credit, and returns the page, its date and the sentences that matched — so an event is
 * recorded only when the person's FULL NAME and the event term appear in the SAME result, with
 * the URL kept as the source. The ZenRows scrape stays as the fallback when Exa is unconfigured
 * (never deleted — §1).
 *
 * Every call goes through lib/providers/dispatch.ts::dispatchWebSearch (tenant required, spend
 * booked platform-paid as vendor "exa"). Life-event tokens reuse the spellings the OSINT
 * scrape already writes (divorce / bankruptcy / death_in_family / foreclosure_filing /
 * inheritance) plus relocation / marriage / job_change, which the readers
 * (lib/kernel/referral-radar.ts) already classify — one vocabulary (§6).
 *
 * Fair-housing: no compliance gate on intelligence (standing ruling) — but nothing here is a
 * protected-class inference; the events are public-record/life-stage facts, never used to
 * target or exclude, and outbound content keeps its own fair-housing gate.
 */

import type { ExaResult } from "@/lib/external/exa-client"

export type MentionLifeEvent =
  | "death_in_family" | "inheritance" | "divorce" | "bankruptcy" | "foreclosure_filing"
  | "relocation" | "marriage" | "job_change"

/** Event → the terms that must co-occur with the person's name in ONE result. */
const EVENT_TERMS: ReadonlyArray<{ event: MentionLifeEvent; re: RegExp }> = [
  { event: "death_in_family", re: /\b(obituary|passed away|in loving memory|survived by|funeral)\b/i },
  { event: "inheritance", re: /\b(probate|estate of|executor|executrix|personal representative|letters testamentary)\b/i },
  { event: "divorce", re: /\b(divorce|dissolution of marriage)\b/i },
  { event: "bankruptcy", re: /\b(bankruptcy|chapter 7|chapter 13)\b/i },
  { event: "foreclosure_filing", re: /\b(foreclosure|notice of default|lis pendens|trustee'?s sale)\b/i },
  { event: "relocation", re: /\b(relocat(e|ed|ing|ion)|moving to|moved to|transferred to)\b/i },
  { event: "marriage", re: /\b(wedding|married|engagement announcement)\b/i },
  { event: "job_change", re: /\b(joins|joined|appointed|promoted to|named (?:new )?(?:ceo|president|director|vp))\b/i },
]

export interface MentionEvent {
  event: MentionLifeEvent
  url: string | null
  title: string | null
  publishedDate: string | null
  /** The sentence(s) that carried the match — the evidence, never paraphrased. */
  evidence: string
}

export interface PersonMentionInput {
  firstName: string | null | undefined
  lastName: string | null | undefined
  city?: string | null
  state?: string | null
}

/** PURE — two queries, no more (spend bound): life-stage notices and moves, both place-anchored. */
export function buildPersonMentionQueries(p: PersonMentionInput): string[] {
  const first = (p.firstName ?? "").trim(), last = (p.lastName ?? "").trim()
  if (!first || !last) return []
  const where = [p.city, p.state].map((v) => (v ?? "").trim()).filter(Boolean).join(", ")
  const name = `"${first} ${last}"`
  return [
    `${name}${where ? ` ${where}` : ""} obituary OR probate estate OR divorce OR foreclosure notice`,
    `${name}${where ? ` ${where}` : ""} relocating OR moving OR new job OR wedding announcement`,
  ]
}

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim()

/**
 * PURE — results → events. A result counts ONLY when the person's full name ("first last",
 * case-insensitive) appears in its title/text/highlights AND an event term appears in the same
 * result; the evidence is the matching sentence. One event per type (the earliest-listed
 * result wins). A page that merely contains the word "divorce" (the OSINT scrape's defect)
 * yields nothing.
 */
export function classifyMentionEvents(results: readonly ExaResult[], p: PersonMentionInput): MentionEvent[] {
  const first = (p.firstName ?? "").trim().toLowerCase(), last = (p.lastName ?? "").trim().toLowerCase()
  if (!first || !last) return []
  const full = `${first} ${last}`
  const out = new Map<MentionLifeEvent, MentionEvent>()
  for (const r of results) {
    const body = squash([r.title, ...(r.highlights ?? []), r.summary, r.text].filter(Boolean).join(". "))
    if (!body.toLowerCase().includes(full)) continue
    const sentences = body.split(/(?<=[.!?])\s+/)
    // A page TITLED with the person (an obituary, a probate notice) may carry the event term in
    // a sentence that does not repeat the surname; any other page must put both in one sentence.
    const titledForPerson = squash(r.title).toLowerCase().includes(full)
    for (const { event, re } of EVENT_TERMS) {
      if (out.has(event)) continue
      // Best evidence first: the sentence naming the PERSON (full name) with the term, then a
      // sentence with the surname and the term (a relative's notice), then the titled page.
      const hit = sentences.find((s) => re.test(s) && s.toLowerCase().includes(full))
        ?? sentences.find((s) => re.test(s) && s.toLowerCase().includes(last))
        ?? (titledForPerson ? sentences.find((s) => re.test(s)) : undefined)
      if (!hit) continue
      out.set(event, { event, url: r.url, title: r.title, publishedDate: r.publishedDate, evidence: hit.slice(0, 280) })
    }
  }
  return [...out.values()]
}

export interface PersonMentionOutcome {
  ran: boolean
  events: MentionEvent[]
  costUsd: number
  reason: string
}

type SearchFn = (p: import("@/lib/providers/dispatch").DispatchWebSearchParams) => Promise<import("@/lib/providers/dispatch").DispatchWebSearchResult>

/** I/O — run the queries through THE provider dispatch and classify. Never throws. */
export async function searchPersonMentions(
  input: PersonMentionInput & { brokerageId: string | null; contactId?: string | null },
  deps: { search?: SearchFn } = {},
): Promise<PersonMentionOutcome> {
  const queries = buildPersonMentionQueries(input)
  if (queries.length === 0) return { ran: false, events: [], costUsd: 0, reason: "needs a first AND last name" }
  const search: SearchFn = deps.search ?? (async (p) => (await import("@/lib/providers/dispatch")).dispatchWebSearch(p))
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString()
  const all: ExaResult[] = []
  let costUsd = 0
  let ran = false
  let lastReason = ""
  for (const query of queries) {
    try {
      const r = await search({
        brokerageId: input.brokerageId, query, numResults: 10, startPublishedDate: since,
        purpose: "search_enrichment", metadata: { contactId: input.contactId ?? null, lane: "person_mentions" },
      })
      costUsd += r.costUsd
      lastReason = r.reason
      if (!r.ok) break // unconfigured / refused — the same answer for the next query
      ran = true
      all.push(...r.results)
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e)
    }
  }
  return { ran, events: ran ? classifyMentionEvents(all, input) : [], costUsd, reason: lastReason }
}
