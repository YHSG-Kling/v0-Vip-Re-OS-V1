// lib/voice/parse-team-command.ts
//
// PURE deterministic NL → team-command parser — the testable floor under the AI classifier.
// The Command Center "command your team" text bar and the voice route's fallback both map a
// typed/spoken sentence to ONE { name, params } that dispatchTeamCommand (lib/voice/team-commands.ts)
// already knows how to route. NO new dispatch logic — this only classifies; the single dispatcher
// stays the source of truth (no drift). Returns null when nothing matches (caller asks to rephrase).
//
// Mirrors the codebase pattern: an AI smart-path with a deterministic fallback that is the floor a
// regression can pin. This module is pure (no imports beyond parseOrdinal) so it unit-tests with no DB/AI.

import { parseOrdinal } from "@/lib/kernel/standup-action"

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
