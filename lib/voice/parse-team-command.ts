// lib/voice/parse-team-command.ts
//
// PURE deterministic NL → team-command parser — the testable floor under the AI classifier.
// The Command Center "command your team" text bar and the voice route's fallback both map a
// typed/spoken sentence to ONE { name, params } that dispatchTeamCommand (lib/voice/team-commands.ts)
// already knows how to route. NO new dispatch logic — this only classifies; the single dispatcher
// stays the source of truth (no drift). Returns null when nothing matches (caller asks to rephrase).
//
// Mirrors the codebase pattern: an AI smart-path with a deterministic fallback that is the floor a
// regression can pin. This module is pure (imports only parseOrdinal + the pure spoken-value
// resolvers) so it unit-tests with no DB/AI.

import { parseOrdinal } from "@/lib/kernel/standup-action"
import { parseSpokenPrice } from "@/lib/voice/spoken-values"

export type ParsedTeamCommand = { name: string; params: Record<string, unknown> }

/** Trim trailing punctuation/filler from a captured entity ("the Hendersons?" → "Hendersons"). */
function cleanEntity(s: string): string {
  return s
    .replace(/^(the|a|an|for|with|about|on|of|to)\s+/i, "")
    .replace(/[?.!,]+\s*$/g, "")
    .replace(/\s+please$/i, "")
    .trim()
}

/** Pull the dictation a follow-up should carry ("...saying I'll call tomorrow" → "I'll call tomorrow"). */
function extractDictation(text: string): string | null {
  const m = text.match(/\b(?:saying|that says|tell (?:them|him|her)|message[:]?|:)\s+(.+)$/i)
  return m ? cleanEntity(m[1]) : null
}

/**
 * Classify a free-text team command. Ordered — first match wins. Conservative: only the clear,
 * common phrasings resolve; ambiguous text returns null so the UI can ask for a rephrase rather
 * than mis-route (acting verbs especially must never fire on a guess).
 */
export function parseTeamCommandText(raw: string): ParsedTeamCommand | null {
  const text = (raw ?? "").trim()
  if (text.length < 3) return null
  const t = text.toLowerCase()

  // 1. standup_action — an acting verb + a ranked item ("knock out number two", "do item 1").
  if (/\b(knock|do|handle|tackle|finish|complete|take care of)\b/.test(t) &&
      /\b(number|item|#|no\.?|first|second|third|one|two|three|[1-3])\b/.test(t)) {
    const ordinal = parseOrdinal(t)
    if (ordinal) return { name: "standup_action", params: { ordinal } }
  }

  // 1.5. accept_offer — the spoken deal decision ("accept the Hendersons' offer",
  // "accept the offer on 44 Birch"). Conservative: requires the word "offer" and never
  // fires on counters ("accept the counter" is the buyer-side lane, not ours).
  if (/\b(accept|approve)\b/.test(t) && /\boffer\b/.test(t) && !/\bcounter\b/.test(t)) {
    // "accept the offer on/for/from/at 44 Birch" → query "44 Birch"
    let m = text.match(/\boffer\s+(?:on|for|from|at)\s+(.+)$/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q) return { name: "accept_offer", params: { query: q } }
    }
    // "accept the Hendersons' offer" / "accept Jane Doe's offer" → query "Hendersons"
    m = text.match(/\b(?:accept|approve)\s+(?:the\s+)?(.+?)(?:'s|s')?\s+offer\b/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q && q.toLowerCase() !== "the" && q.toLowerCase() !== "this" && q.toLowerCase() !== "that") {
        return { name: "accept_offer", params: { query: q } }
      }
    }
    // Bare "accept the offer" — no hint; backend auto-selects when exactly one is open.
    if (/\b(?:accept|approve)\s+(?:the|this|that)?\s*offer\b/.test(t)) {
      return { name: "accept_offer", params: {} }
    }
  }

  // 1.6. reject_offer — "reject the Hendersons' offer", "decline the offer on 44 Birch
  // because the earnest money is too low". Round 36: the kernel command now takes an
  // injected client, so the spoken form rides the SAME rejectOffer transition. Never
  // fires on counters (buyer-side lane). The trailing "because …" becomes the reason.
  if (/\b(reject|decline|turn down|pass on)\b/.test(t) && /\boffer\b/.test(t) && !/\bcounter\b/.test(t)) {
    const reasonM = text.match(/\b(?:because|since|reason(?:\s+being)?[:]?)\s+(.+)$/i)
    const reason = reasonM ? cleanEntity(reasonM[1]) : null
    const base = reasonM ? text.slice(0, reasonM.index).trim() : text
    let m = base.match(/\boffer\s+(?:on|for|from|at)\s+(.+)$/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q) return { name: "reject_offer", params: { query: q, ...(reason ? { reason } : {}) } }
    }
    m = base.match(/\b(?:reject|decline|turn\s+down|pass\s+on)\s+(?:the\s+)?(.+?)(?:'s|s')?\s+offer\b/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q && !["the", "this", "that"].includes(q.toLowerCase())) {
        return { name: "reject_offer", params: { query: q, ...(reason ? { reason } : {}) } }
      }
    }
    if (/\b(?:reject|decline|turn\s+down|pass\s+on)\s+(?:the|this|that)?\s*offer\b/i.test(base)) {
      return { name: "reject_offer", params: { ...(reason ? { reason } : {}) } }
    }
  }

  // 1.7. counter_offer — "counter the Hendersons' offer at 450", "counter the offer on
  // 44 Birch at 462 thousand". Requires the word "counter" as OUR verb (never "accept/
  // reject the counter" — those are other lanes). The trailing "at <price>" resolves via
  // the shared spoken-price rules; the backend refuses a counter with no explicit price.
  if (/\bcounter\b/.test(t) && !/\b(accept|reject|decline|respond)\b/.test(t) && /\boffer\b/.test(t)) {
    const priceM = text.match(/\b(?:at|to|for)\s+(\$?\s*[\d][\d,]*(?:\.\d+)?\s*(?:k|thousand|grand|m|mm|million)?)\s*[?.!]?\s*$/i)
    const price = priceM ? parseSpokenPrice(priceM[1]) : null
    const base = priceM ? text.slice(0, priceM.index).trim() : text
    let m = base.match(/\boffer\s+(?:on|for|from)\s+(.+)$/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q) return { name: "counter_offer", params: { query: q, ...(price ? { counter_price: price } : {}) } }
    }
    m = base.match(/\bcounter\s+(?:the\s+)?(.+?)(?:'s|s')?\s+offer\b/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q && !["the", "this", "that"].includes(q.toLowerCase())) {
        return { name: "counter_offer", params: { query: q, ...(price ? { counter_price: price } : {}) } }
      }
    }
    if (/\bcounter\s+(?:the|this|that)?\s*offer\b/i.test(base)) {
      return { name: "counter_offer", params: { ...(price ? { counter_price: price } : {}) } }
    }
  }

  // 1.8. withdraw_offer — "withdraw the offer on 44 Birch", "retract Jane's offer".
  if (/\b(withdraw|retract)\b/.test(t) && /\boffer\b/.test(t)) {
    const reasonM = text.match(/\b(?:because|since)\s+(.+)$/i)
    const reason = reasonM ? cleanEntity(reasonM[1]) : null
    const base = reasonM ? text.slice(0, reasonM.index).trim() : text
    let m = base.match(/\boffer\s+(?:on|for|from|at)\s+(.+)$/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q) return { name: "withdraw_offer", params: { query: q, ...(reason ? { reason } : {}) } }
    }
    m = base.match(/\b(?:withdraw|retract)\s+(?:the\s+)?(.+?)(?:'s|s')?\s+offer\b/i)
    if (m) {
      const q = cleanEntity(m[1])
      if (q && !["the", "this", "that"].includes(q.toLowerCase())) {
        return { name: "withdraw_offer", params: { query: q, ...(reason ? { reason } : {}) } }
      }
    }
    if (/\b(?:withdraw|retract)\s+(?:the|this|that|our)?\s*offer\b/i.test(base)) {
      return { name: "withdraw_offer", params: { ...(reason ? { reason } : {}) } }
    }
  }

  // 1.9. stage_showing — "schedule a showing for Maria at 44 Birch on Saturday at 2".
  // Person after "for", address after the first "at", date after "on", time after the
  // final "at". Missing pieces are passed through empty — the backend asks instead of
  // guessing (and the NAR BBA gate inside requestShowing stays absolute).
  {
    const sm = text.match(/\b(?:schedule|book|set\s*up|request)\b.*?\bshowing\b\s+for\s+(.+)$/i)
    if (sm) {
      let rest = sm[1]
      let timeText: string | null = null
      const timeM = rest.match(/\s+at\s+((?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)|noon)\s*[?.!]?\s*$/i)
      if (timeM && timeM.index !== undefined) { timeText = timeM[1]; rest = rest.slice(0, timeM.index) }
      let dateText: string | null = null
      const dateM = rest.match(/\s+on\s+(.+)$/i)
      if (dateM && dateM.index !== undefined) { dateText = dateM[1]; rest = rest.slice(0, dateM.index) }
      let person = rest.trim()
      let address: string | null = null
      const atM = rest.match(/^(.+?)\s+at\s+(.+)$/i)
      if (atM) { person = atM[1]; address = atM[2] }
      const personQ = cleanEntity(person)
      if (personQ) {
        return {
          name: "stage_showing",
          params: {
            person_query: personQ,
            ...(address ? { address_query: cleanEntity(address) } : {}),
            ...(dateText ? { date_text: dateText.trim() } : {}),
            ...(timeText ? { time_text: timeText.trim() } : {}),
          },
        }
      }
    }
  }

  // 1.10. reassign_contact — "reassign Maria Lopez to Bob Chen". Broker/manager lane;
  // the backend refuses non-managers, so a mis-spoken agent request fails safe.
  {
    const rm = text.match(/\breassign\s+(.+?)\s+to\s+(.+)$/i)
    if (rm) {
      const person = cleanEntity(rm[1])
      const toAgent = cleanEntity(rm[2])
      if (person && toAgent) return { name: "reassign_contact", params: { person_query: person, to_agent_query: toAgent } }
    }
  }

  // 1.11. broadcast_announcement — "announce to the team: office closes at noon Friday".
  // Principal-gated downstream; IN-APP ONLY by construction of the canonical action.
  {
    const bm = text.match(/^(?:announce(?:\s+to\s+the\s+team)?|broadcast(?:\s+to\s+the\s+team)?|tell\s+the\s+team)[:,]?\s+(.+)$/i)
    if (bm) {
      const message = bm[1].trim()
      if (message.length >= 5) return { name: "broadcast_announcement", params: { message } }
    }
  }

  // 1.12. convert_lead — "convert the lead for John Smith" (also catches spoken
  // "promote the lead …"). Broker-only downstream (leads are never agent-speakable).
  // NOT a raw→lead door: the backend converts an already-QUALIFIED lead to a
  // contact via Engine 2, whose server-side gate refuses unqualified leads
  // (owner round 37: raw leads move only via the automatic pipeline; leads
  // convert once qualified).
  if (/\b(convert|promote)\b/.test(t) && /\blead\b/.test(t)) {
    const m = text.match(/\blead\s+(?:for|from|named)\s+(.+)$/i) ?? text.match(/\b(?:convert|promote)\s+(.+?)(?:'s)?\s+lead\b/i)
    const nm = m ? cleanEntity(m[1]) : ""
    return { name: "convert_lead", params: nm && !["the", "a", "new"].includes(nm.toLowerCase()) ? { name_query: nm } : {} }
  }

  // 2. morning_standup — "what should I do today", "what's on my plate", "stand-up", "top 3".
  if (/\b(what should i do|what'?s on my plate|my (day|priorities|plan|agenda)|stand[\s-]?up|top (3|three)|what'?s most important|where (should|do) i start)\b/.test(t)) {
    return { name: "morning_standup", params: {} }
  }

  // 3. cut_promo — "cut a reel for 44 Birch", "make a promo video of 12 Oak St".
  {
    const m = text.match(/\b(?:cut|make|create|produce|shoot|generate)\b.*?\b(?:promo|reel|video|clip|spot)\b.*?\b(?:for|of|on)\b\s+(.+)$/i)
    if (m) { const addr = cleanEntity(m[1]); if (addr) return { name: "cut_promo", params: { address_query: addr } } }
  }

  // 4. start_marketing — "start marketing for the Hendersons", "enroll Jane in a campaign".
  {
    if (/\b(start|kick off|begin|launch)\b.*\bmarketing\b/.test(t) || /\benroll\b.*\b(marketing|campaign|sequence|drip)\b/.test(t)) {
      const m = text.match(/\b(?:for|with)\s+(.+)$/i) ?? text.match(/\benroll\s+(.+?)\s+(?:in|into)\b/i)
      const person = m ? cleanEntity(m[1]) : ""
      if (person) return { name: "start_marketing", params: { person_query: person } }
    }
  }

  // 5. voice_followup — "send the Hendersons a follow-up", "follow up with Jane saying ...".
  {
    if (/\bfollow[\s-]?up\b/.test(t) || /\bsend\b.*\b(note|message|email|text)\b/.test(t)) {
      const dictation = extractDictation(text)
      // "follow up with X" | "send X a follow-up/note" | "follow up on X"
      let m = text.match(/\bfollow[\s-]?up\s+(?:with|on)\s+(.+?)(?:\s+(?:saying|that says|tell|message|:).*)?$/i)
      if (!m) m = text.match(/\bsend\s+(.+?)\s+(?:a\s+)?(?:follow[\s-]?up|note|message|email|text)\b/i)
      const person = m ? cleanEntity(m[1]) : ""
      if (person) return { name: "voice_followup", params: { person_query: person, ...(dictation ? { dictation } : {}) } }
    }
  }

  // 6. find_properties — "find the Hendersons a 3-bed under 500k in Austin".
  {
    const m = text.match(/\b(?:find|search|look)\b.*?\bfor\s+(.+?)\b\s+(?:a|an|some)?\s*(.+(?:bed|bath|home|house|propert|listing|under|in\b).*)$/i)
                ?? text.match(/\bfind\s+(.+?)\s+(a\s+.+(?:bed|bath|home|house|propert).*)$/i)
    if (m) {
      const person = cleanEntity(m[1]); const query = cleanEntity(m[2])
      if (person && query.length >= 5) return { name: "find_properties", params: { person_query: person, query } }
    }
  }

  // 7. area_query — "anything happening near 44 Birch?", "what's going on around downtown".
  {
    const m = text.match(/\b(?:anything|what'?s|any (?:activity|news)|what is)\b.*?\b(?:near|around|by|in|on)\b\s+(.+)$/i)
    if (m && /\b(near|around|by)\b/.test(t)) { const area = cleanEntity(m[1]); if (area) return { name: "area_query", params: { area_query: area } } }
  }

  // 8. team_query — "what do you know about the Hendersons", "where do we stand on 44 Birch".
  {
    const m = text.match(/\b(?:what do you know about|tell me about|status (?:on|of)|fill me in on|brief me on|catch me up on|where (?:are|do) we (?:stand )?(?:on|with)|the latest on|update on)\s+(.+)$/i)
    if (m) { const person = cleanEntity(m[1]); if (person) return { name: "team_query", params: { person_query: person } } }
  }

  return null
}
