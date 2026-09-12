// lib/ai-isa/lead-reel-brief.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE AI-ISA's CREATIVE BRIEF to the Asset Manager (video director) for a 1:1 lead
// intro reel — the multi-manager outreach play, the angle the owner wants for the
// whole app: the ISA quarterbacks, the Asset Manager directs the persona-matched
// reel, the Campaign Orchestrator distributes it — every hop on the "managers
// talking" feed.
//
// This is the PURE half: given the qualified lead's REAL facts, compose the
// VideoSituation + persona + the bounded facts the hook copy may use. The Asset
// Manager's commissionVideo takes it from here (format → QR → compliance gate →
// gated ai_video_projects row).
//
//   • PERSONA-MATCHED — the lead's name + situation seed the avatar's intro; the
//     generational COHORT (reused from the SAME canonical age tooling the portal
//     education + first-touch copy use) tones the brief, never the facts.
//   • THEM-FIRST — the reel introduces the agent as a helpful guide to THIS person's
//     move, grounded ONLY in facts the lead actually gave (interest / timeline /
//     budget). No fabrication.
//
// FAIR HOUSING SAFE BY CONSTRUCTION: the cohort tones the brief's PHRASING only and
// is NEVER emitted as a fact — the extraFacts list carries no age, no protected
// class, no steering language (the lead-reel simulator asserts this). commissionVideo
// still drafts the hook through the AI gateway and clears evaluateOutbound before any
// render spend; nothing here sends or renders.
//
// PURE (no server-only, no I/O) so the simulator imports it directly.

import type { VideoSituation, CompositionTierLite } from "@/lib/video/video-director"
import type { CopyPersona } from "@/lib/kernel/ai-copy"
import {
  generationalCohortFromAge,
  cohortFraming,
  type GenerationalCohort,
} from "@/lib/kernel/education"

export interface LeadReelBriefInput {
  leadId: string
  firstName: string
  /** What the lead told us they're looking for (e.g. "3-bed homes downtown"). */
  propertyInterest?: string | null
  /** Their stated timeline (e.g. "buy this spring"). */
  timeline?: string | null
  /** The lead's motivation persona (relocation_buyer / first_time_buyer / …). */
  motivationType?: string | null
  /**
   * `leads.lead_type` — which SIDE the lead is on (buyer / seller / …).
   *
   * OWNER RULING, verbatim: "leads are handled by their type and or persona for
   * content situation." The persona alone was the whole situation before this, so a
   * lead whose motivation_type was never filled in — which is the pipeline's own
   * 'unknown' default until the intent classifier lands one — reached the writer as
   * the bare phrase "exploring a move", with the one fact we DID have about them
   * (buyer or seller) nowhere in the brief.
   *
   * AND/OR, exactly as ruled: when both exist the situation carries both; when only
   * one exists it carries that one; when neither does the honest generic phrase
   * stands rather than a guessed side.
   */
  leadType?: string | null
  budgetMin?: number | null
  budgetMax?: number | null
  /** Enrichment block used ONLY to derive the cohort tone (age / age_range). */
  enrichment?: { age?: number | null; age_range?: string | null } | null
  /** Explicit cohort override (when the caller already resolved it). */
  cohort?: GenerationalCohort
  /** Composition tier (solo_agent default — the reel is the agent's personal brand). */
  tier?: CompositionTierLite
}

export interface LeadReelBrief {
  situation: VideoSituation
  persona: CopyPersona
  /** The ONLY facts the hook/script copy may use — no age, no protected class. */
  extraFacts: string[]
  /** The ai_video_projects title for the staged reel. */
  title: string
}

/** Resolve the cohort from an explicit value, else from enrichment age/age_range. */
function resolveCohort(i: LeadReelBriefInput): GenerationalCohort {
  if (i.cohort) return i.cohort
  const e = i.enrichment
  if (!e) return "unknown"
  if (typeof e.age === "number") return generationalCohortFromAge(e.age)
  const nums = typeof e.age_range === "string" ? (e.age_range.match(/\d+/g)?.map(Number) ?? []) : []
  if (nums.length >= 2) return generationalCohortFromAge(Math.round((nums[0] + nums[1]) / 2))
  if (nums.length === 1) return generationalCohortFromAge(nums[0])
  return "unknown"
}

/**
 * buildLeadIntroReelBrief — PURE. Compose the AI-ISA's creative brief for a lead
 * intro reel. The cohort tones the persona's `situation` (phrasing only); the
 * extraFacts carry ONLY grounded, Fair-Housing-safe facts the lead provided.
 */
export function buildLeadIntroReelBrief(i: LeadReelBriefInput): LeadReelBrief {
  const cohort = resolveCohort(i)
  const interest = i.propertyInterest?.trim() || "a home in the area"

  // The persona seeds the avatar's 1:1 intro. The cohort framing tones HOW the agent
  // speaks (warm/relationship-led for boomer, efficient for gen-x, terse for gen-z) —
  // it is phrasing guidance for the generator, never an emitted demographic fact.
  const toneHint = cohortFraming(cohort).trim()

  // TYPE AND/OR PERSONA (owner ruling). 'unknown' is a REAL live lead_type /
  // motivation_type value the pipeline writes when the source is ambiguous — it is
  // the absence of an answer, not an answer, so it must never become a situation.
  const known = (v: string | null | undefined) => {
    const s = (v ?? "").trim().toLowerCase()
    return s && s !== "unknown" && s !== "other" ? s.replace(/_/g, " ") : null
  }
  const typeBasis = known(i.leadType)
  const personaBasis = known(i.motivationType)
  // Persona first when both exist: it is the more specific of the two, and the type
  // is usually already implied by it ("relocation buyer" carries "buyer").
  const basis = [personaBasis, typeBasis].filter(Boolean).join(" · ") || "exploring a move"
  const situationHint = [basis, toneHint ? `(tone: ${toneHint})` : ""].filter(Boolean).join(" ")

  const persona: CopyPersona = {
    name: i.firstName,
    audience: "lead",
    situation: situationHint,
  }

  // Bounded facts — grounded ONLY in what the lead actually told us. No age, no
  // protected class, no steering ("family", "safe", "perfect for").
  const extraFacts: string[] = []
  if (i.propertyInterest?.trim()) extraFacts.push(`Looking for: ${i.propertyInterest.trim()}`)
  if (i.timeline?.trim()) extraFacts.push(`Timeline: ${i.timeline.trim()}`)
  if (typeof i.budgetMin === "number" && typeof i.budgetMax === "number") {
    extraFacts.push(`Budget: $${i.budgetMin.toLocaleString()}–$${i.budgetMax.toLocaleString()}`)
  }
  extraFacts.push("This is a 1:1 introduction — the agent offering to help, not a listing pitch.")

  const situation: VideoSituation = {
    kind: "lead_intro",
    tier: i.tier ?? "solo_agent",
    targetChannel: "email", // strictly 1:1 — a lead reel is embedded in an email, never broadcast
    facts: {
      lead_id: i.leadId,
      property_interest: interest,
      ...(i.timeline?.trim() ? { when: i.timeline.trim() } : {}),
    },
  }

  return {
    situation,
    persona,
    extraFacts,
    title: `Intro reel for ${i.firstName}`,
  }
}
