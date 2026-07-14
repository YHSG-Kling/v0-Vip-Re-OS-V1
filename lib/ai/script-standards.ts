// lib/ai/script-standards.ts
//
// THE SCRIPT QUALITY CHARTER (owner standard, verbatim intent: "all scripts
// that get created are not basic… lead with value, not salesy and not basic,
// need more details but within reason, depending on the one that consumes
// the material"). ONE source of truth appended to every generator's system
// prompt — copy rail, education authors, video scripts, outreach drafts —
// so the standard can never drift per-surface. NOT server-only (simulators
// exercise it).

export const SCRIPT_QUALITY_CHARTER = [
  "SCRIPT QUALITY CHARTER — applies to every script, draft, and piece of material:",
  "0. THEM-FIRST (the house philosophy, Gate 5 enforces it): write about what THEY experience, gain, or discover — 'you/your' dominates 'I/me/we'; the agent's expertise is a resource FOR them, never a credential about us.",
  "1. LEAD WITH VALUE: the FIRST sentence gives the reader/listener something they didn't have — an insight, a number, an answer, a concrete next step. Never open with who we are or what we want.",
  "2. NEVER SALESY: no hype, no manufactured urgency ('act now', 'don't miss out', 'once in a lifetime'), no exclamation stacking, no pressure closes. Confidence comes from specifics, not volume.",
  "3. NEVER BASIC: no filler any competitor could paste ('hope this finds you well', 'just checking in', 'in today's fast-paced market'). Every line earns its place with a concrete detail — a name, a number, a street, a date, an exact next step.",
  "4. CALIBRATE DEPTH TO WHO CONSUMES IT, within reason: a client gets plain language and the WHY in their terms; a first-year agent gets the steps AND the reasoning; a veteran gets the sharp version plus the advanced note; a broker gets the numbers first. More than a summary, less than a lecture.",
  "5. READ-ALOUD TEST: if a person wouldn't SAY the sentence to someone they respect, cut it.",
].join("\n")

/** Append the charter to any generator's system prompt. */
export function withScriptStandards(system: string): string {
  return `${system}\n\n${SCRIPT_QUALITY_CHARTER}`
}

/**
 * PURE lint — the deterministic backstop for fallback/hardcoded material
 * (the charter governs the model; this catches what ships without one).
 * Returns the violated rules, empty = clean. Honest: flags only hard tells.
 */
export function lintScriptQuality(text: string): string[] {
  const t = text.toLowerCase()
  const hits: string[] = []
  const SALESY = ["act now", "don't miss out", "once in a lifetime", "limited time only", "you won't believe"]
  const BASIC = ["hope this finds you well", "just checking in", "just touching base", "in today's fast-paced market"]
  if (SALESY.some((p) => t.includes(p))) hits.push("salesy_pressure")
  if (BASIC.some((p) => t.includes(p))) hits.push("basic_filler")
  if ((text.match(/!/g) ?? []).length >= 3) hits.push("exclamation_stacking")
  return hits
}
