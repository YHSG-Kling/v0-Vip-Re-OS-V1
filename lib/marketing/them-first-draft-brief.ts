// lib/marketing/them-first-draft-brief.ts
//
// WAVE 153 (lane 153R — owner B11 "audit and fix any partials in marketing capability census"): THE PERSONA / THEM-FIRST HOP
// that four census rows lacked (broadcast email, social, books, sequences). The recipient's persona is read BEFORE the first
// draft and turned into the writer's them-first brief — through the EXISTING persona reader, never a second persona system:
//
//   · the vocabulary is the live CRM persona CHECK (contacts.contact_persona / leads.persona / marketing_campaigns.audience_personas
//     — scripts/check-vocabularies.ts), the SAME values the direct-mail and newsletter rows already read;
//   · the them-first arc is the authored library, reached ONLY through its one CRM bridge
//     (lib/them-first/empathy-library.ts empathyGuidanceForCrmPersona), which returns null rather than a wrong persona's script;
//   · the sender's brand voice is NOT built here — each door keeps leading with its own loadSenderVoiceBrief; this brief is the
//     READER's half and is placed after it.
//
// THE RULE THIS FILE ENFORCES: an unreadable, absent, mixed or un-authored persona produces a GENERIC-SAFE brief — write to any
// reader, assume no situation — and NEVER a guessed persona. (The social draft path used to hand the compliance gate a
// hard-coded `persona: "first_time"` for every public post; that guess is what complianceGatePersona replaces.)
//
// PURE except readRecipientPersona, which takes the caller's client (tenant-pinned, error READ — CLAUDE.md §3).

import type { Persona } from "@/lib/kernel/types"
import { empathyGuidanceForCrmPersona } from "@/lib/them-first/empathy-library"

export type ThemFirstDraftBrief =
  | {
      basis: "persona"
      /** the CRM persona value the brief was written for (a member of the live persona CHECK) */
      persona: Persona
      /** the authored them-first arc it resolved to (empathy-library id) */
      libraryPersonaId: string
      /** the reader's concerns, as exemplars of THEIR worries — never facts about this reader */
      concerns: string[]
      source: string
    }
  | {
      basis: "generic_safe"
      persona: null
      /** why no persona conditioned the draft — always stated */
      reason: string
      source: string
    }

export interface ThemFirstBriefInput {
  /** The recipient persona value(s) as read: one recipient, or a campaign's audience_personas. */
  personas: ReadonlyArray<string | null | undefined> | string | null | undefined
  /** buyer / seller side when known (picks the side's authored arc); anything else reads as unknown. */
  side?: string | null
  /** The persona read was refused — the brief says so and stays generic-safe. */
  readError?: string | null
  /** Where the persona came from (recorded on the brief). */
  source?: string
}

const MAX_CONCERNS = 3

/** PURE — the them-first brief for this reader. Never guesses: anything short of ONE authored persona is generic-safe. */
export function themFirstDraftBrief(input: ThemFirstBriefInput): ThemFirstDraftBrief {
  const source = input.source ?? "unspecified"
  const generic = (reason: string): ThemFirstDraftBrief => ({ basis: "generic_safe", persona: null, reason, source })
  if (input.readError) return generic(`the recipient persona could not be read (${input.readError}) — written for any reader, no persona assumed`)
  const raw = typeof input.personas === "string" || input.personas == null ? [input.personas] : [...input.personas]
  const distinct = [...new Set(raw.map((p) => (typeof p === "string" ? p.trim().toLowerCase() : "")).filter(Boolean))]
  if (distinct.length === 0) return generic("no recipient persona is on record — written for any reader, no persona assumed")
  if (distinct.length > 1) return generic(`the audience spans ${distinct.length} personas (${distinct.slice(0, 4).join(", ")}) — one persona's arc would mis-address the rest`)
  const persona = distinct[0]
  const side = input.side === "seller" ? "seller" : input.side === "buyer" ? "buyer" : null
  const guidance = empathyGuidanceForCrmPersona(persona, side)
  if (!guidance) return generic(`no authored them-first arc exists for persona '${persona}' — written for any reader rather than borrowing another persona's`)
  return {
    basis: "persona",
    persona: persona as Persona,
    libraryPersonaId: guidance.libraryPersonaId,
    concerns: guidance.painPoints.map((p) => p.pain).filter((s) => typeof s === "string" && s.trim()).slice(0, MAX_CONCERNS),
    source,
  }
}

/** PURE — the brief as writer instructions (placed AFTER the sender's voice brief, BEFORE the task). */
export function renderThemFirstDraftBrief(b: ThemFirstDraftBrief): string {
  const frame = "THEM FIRST: open on the reader's situation and what they want to understand, then trust, then genuine value, then one low-pressure next step — the reader before the agent."
  const fh = "Never name, imply or target a protected characteristic (fair housing); speak to the situation, never to who the reader is."
  if (b.basis === "generic_safe") {
    return [`READER: not known (${b.reason}).`, frame, "Assume no life event, persona or situation — write so any reader of this piece is well served.", fh].join("\n")
  }
  return [
    `READER: written for the '${b.persona}' situation (them-first arc '${b.libraryPersonaId}').`,
    frame,
    b.concerns.length ? `What people in this situation commonly worry about (their concerns as exemplars — never claims about this reader, never quoted):\n${b.concerns.map((c) => `- ${c}`).join("\n")}` : "",
    fh,
  ].filter(Boolean).join("\n")
}

/** PURE — the persona the compliance / brand-voice gate is told: the resolved one, else "other" — never a guessed situation. */
export function complianceGatePersona(b: ThemFirstDraftBrief): Persona {
  return b.basis === "persona" ? b.persona : "other"
}

/** PURE — the audit record a door stores beside its draft (what conditioned it, or why nothing did). */
export function themFirstBasisRecord(b: ThemFirstDraftBrief): Record<string, string | null> {
  return b.basis === "persona"
    ? { persona_basis: "persona", persona: b.persona, them_first_arc: b.libraryPersonaId, persona_source: b.source }
    : { persona_basis: "generic_safe", persona: null, persona_reason: b.reason, persona_source: b.source }
}

type PersonaDb = { from: (table: string) => any }

/**
 * Read ONE recipient's persona — contacts.contact_persona or leads.persona — pinned to the tenant. Never throws; a refused read
 * comes back as readError (and the caller writes generic-safe), a foreign / missing row as persona null. Never a guess.
 */
export async function readRecipientPersona(
  db: PersonaDb,
  input: { brokerageId: string; subject: { type: "contact" | "lead"; id: string } | null },
): Promise<{ persona: string | null; side: "buyer" | "seller" | null; readError: string | null }> {
  if (!input.subject || !input.brokerageId) return { persona: null, side: null, readError: null }
  try {
    const isContact = input.subject.type === "contact"
    const { data, error } = await db
      .from(isContact ? "contacts" : "leads")
      .select(isContact ? "contact_persona, contact_type" : "persona")
      .eq("id", input.subject.id).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (error) return { persona: null, side: null, readError: String(error.message ?? "refused") }
    const row = (data ?? null) as { contact_persona?: string | null; contact_type?: string | null; persona?: string | null } | null
    const persona = (isContact ? row?.contact_persona : row?.persona) ?? null
    const t = row?.contact_type ?? null
    return { persona: typeof persona === "string" && persona.trim() ? persona.trim() : null, side: t === "seller" ? "seller" : t === "buyer" ? "buyer" : null, readError: null }
  } catch (e) {
    return { persona: null, side: null, readError: (e as Error)?.message ?? String(e) }
  }
}
