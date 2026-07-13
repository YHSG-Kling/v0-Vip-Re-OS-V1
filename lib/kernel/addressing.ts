/**
 * lib/kernel/addressing.ts
 *
 * ADDRESSING MEMORY — "call me Bill." The luxury-details manifesto names the
 * detail directly: capture name pronunciation and how clients prefer to be
 * addressed, then make sure EVERY message and call note aligns with it.
 * Nothing tells a client "you're a record in a CRM" faster than a drip that
 * says "Hi William" after they said "it's Bill" on the first call.
 *
 * Storage: three nullable columns on contacts (preferred_name,
 * name_pronunciation, salutation_style — l48-s01). This module is the ONE
 * pure resolver every copy surface shares (AI drafts, the context spine,
 * briefing nudges, the portal), so the answer to "what do we call them?" has
 * exactly one implementation. Honest degradation: nothing captured → the
 * plain first name, and NO prompt line (the AI is never fed an empty rule).
 *
 * NOT server-only (simulator-driven, pure).
 */

export interface AddressingFacts {
  firstName: string | null
  lastName: string | null
  /** what they actually go by ("Bill", "Dr. Chen", "Peggy") — wins everywhere. */
  preferredName: string | null
  /** phonetic help ("SHIV-on" for Siobhan) — surfaced to the agent before calls. */
  namePronunciation: string | null
  /** "formal" | "casual" (free text tolerated) — greeting register. */
  salutationStyle: string | null
}

export interface Addressing {
  /** the one name every surface uses ("Bill"); falls back to firstName, then "there". */
  addressAs: string
  /** ready-made greeting matching their register ("Hi Bill," / "Dear Bill Chen,"). */
  greeting: string
  /** agent-facing pronunciation cue, null when none captured. */
  pronunciationNote: string | null
  /** the rule line injected into AI draft prompts; null when nothing was captured
   *  beyond the default (never feed the model an empty rule). */
  promptLine: string | null
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim()
  return t.length > 0 ? t : null
}

/** PURE: the single answer to "how do we address this person?" */
export function resolveAddressing(f: AddressingFacts): Addressing {
  const preferred = clean(f.preferredName)
  const first = clean(f.firstName)
  const last = clean(f.lastName)
  const pron = clean(f.namePronunciation)
  const style = (clean(f.salutationStyle) ?? "").toLowerCase()

  const addressAs = preferred ?? first ?? "there"
  const formal = style === "formal"
  // Formal register uses the fuller name when we have one — but the PREFERRED
  // name still wins outright ("Dr. Chen" formal stays "Dr. Chen").
  const formalName = preferred ?? ([first, last].filter(Boolean).join(" ") || addressAs)
  const greeting = formal ? `Dear ${formalName},` : `Hi ${addressAs},`

  const pronunciationNote = pron ? `Pronounced "${pron}".` : null

  const rules: string[] = []
  if (preferred) rules.push(`Address the client as "${preferred}"${first && first !== preferred ? ` (never "${first}")` : ""}.`)
  if (pron) rules.push(`Their name is pronounced "${pron}".`)
  if (formal) rules.push(`Keep the salutation formal.`)
  else if (style === "casual") rules.push(`Keep the tone warm and casual.`)

  return {
    addressAs,
    greeting,
    pronunciationNote,
    promptLine: rules.length > 0 ? rules.join(" ") : null,
  }
}
