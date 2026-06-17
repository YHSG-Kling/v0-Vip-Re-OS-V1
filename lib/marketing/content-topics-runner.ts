// lib/marketing/content-topics-runner.ts
//
// Live side of CONTENT TOPICS — pull what buyers/sellers are ACTUALLY asking from the gated web-search
// rail (Exa/Tavily over Reddit/forums/Q&A) and extract the ranked content topics that seed the AI copy.
// Uses the unified webSearch helper (research mode → synthesized answer + sources), so the topics are
// real demand, not guesses. Best-effort: search unavailable → empty topics → the copy falls back to
// the safe deterministic baseline. Read-only.

import "server-only"
import { webSearch } from "@/lib/ai/web-search"
import { topicSearchQuery, extractContentTopics, type ContentTopic } from "./content-topics"

/**
 * Fetch the real content topics for a magnet/landing page. Returns ranked buyer/seller questions to
 * ground the AI copy. The searcher is injectable so tests run without the network.
 */
export async function fetchContentTopics(
  magnetType: string, area?: string | null,
  opts: { limit?: number; searcher?: (q: string) => Promise<{ answer: string | null; hits: Array<{ title: string | null; snippet: string | null }> }> } = {},
): Promise<ContentTopic[]> {
  const query = topicSearchQuery(magnetType, area)
  try {
    const res = opts.searcher
      ? await opts.searcher(query)
      : await webSearch({ query, mode: "research", maxResults: 8, deep: true })
    const texts: string[] = []
    if (res.answer) texts.push(res.answer)
    for (const h of res.hits ?? []) { if (h.title) texts.push(h.title); if (h.snippet) texts.push(h.snippet) }
    return extractContentTopics(texts, { limit: opts.limit ?? 8 })
  } catch {
    return []
  }
}
