// lib/video/video-guide.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE DESCRIBE-A-VIDEO GUIDE — the pure half (wave 82, lane 82C).
//
// OWNER (2026-09-25, verbatim): "on the describe video card, when you pick this
// kind of video, the ai then tells the user what they will need and assist on
// their wording in the text boxes during the process (so an ai helping and
// guiding them so they feel supported especially if they are not techy)."
//
// Two layers, deliberately split:
//   1. WHAT YOU WILL NEED is DERIVED, never model-authored: the archetype
//      registry's needs, the base purpose's length band, the hosts the
//      composition registry can carry it with (custom-video-archetypes.ts +
//      duration-model.ts). The model may only PHRASE this checklist warmly — it
//      can never add a requirement or change a number, and when the model is
//      unreachable the checklist still shows (fail visible, never blank).
//   2. WORDING HELP per text box: the model offers up to three rewrites of what
//      the person typed; every suggestion passes the fair-housing red-flag scan
//      before it is shown, and a suggestion identical to the input is dropped.
//      The person accepts or edits — nothing is written for them silently.
//
// UX research behind the shape (Exa 2026-09-25): provessa.com "Write with AI
// answers one field at a time … Insert drops the result in" (per-field, tuned to
// the field); gixo.ai "accept or reject with one click", "no separate chat
// window"; kadence "better at improving existing text than writing from blank" —
// so suggestions start once the person has typed a few words. Supportive,
// plain-language microcopy (no jargon: "shape", "archetype", "composition" never
// reach the person).
//
// PURE. No I/O, no model.

import {
  CUSTOM_ARCHETYPE_REGISTRY, CUSTOM_VIDEO_ARCHETYPES, archetypeHosts, type CustomVideoArchetype,
} from "./custom-video-archetypes"
import { PURPOSE_DURATION_RULES, type HostKind } from "./duration-model"

export const GUIDE_FIELDS = ["audience", "goal", "script", "title", "bullets"] as const
export type GuideField = (typeof GUIDE_FIELDS)[number]

/** Per-field coaching: what the box is for, in plain words, and the longest a suggestion may be. */
export const GUIDE_FIELD_SPECS: Record<GuideField, { label: string; coach: string; maxChars: number; minCharsToSuggest: number }> = {
  audience: { label: "Who is it for?", coach: "Describe the viewer's situation, not who they are — \"people thinking about selling this spring\" rather than an age or a family type.", maxChars: 200, minCharsToSuggest: 6 },
  goal:     { label: "What should it do?", coach: "One job per video: explain one thing, invite to one event, or say one thank-you.", maxChars: 300, minCharsToSuggest: 8 },
  script:   { label: "What will be said", coach: "Write it the way you talk. Short sentences. One idea, three small steps, one friendly next step.", maxChars: 1200, minCharsToSuggest: 20 },
  title:    { label: "On-screen title", coach: "Three to six words someone can read in a second.", maxChars: 60, minCharsToSuggest: 3 },
  bullets:  { label: "On-screen points", coach: "Up to three short lines, six words or fewer each.", maxChars: 200, minCharsToSuggest: 6 },
}

export const HOST_PLAIN: Record<HostKind, string> = {
  avatar: "you on camera — your digital twin speaks the words",
  voiceover: "your voice over pictures — your cloned voice reads the words",
  silent: "words on screen only, no voice",
}

export interface NeedsChecklist {
  archetype: CustomVideoArchetype
  /** A one-line, plain-language description of the kind of video. */
  headline: string
  /** Things to have ready, in plain words. Empty = nothing beyond the words. */
  bring: string[]
  /** "About 45 seconds (it can run 30–90)". */
  length: string
  targetSeconds: number
  /** Who can carry it — derived from the hosts the registry can render it with. */
  onCamera: string[]
  /** A suggested closing step, never salesy. */
  nextStep: string
  /** The boxes this kind of video leans on most, in order. */
  focusFields: GuideField[]
}

export const ARCHETYPE_HEADLINES: Record<CustomVideoArchetype, string> = {
  talking_head_message: "A short, personal message — you speaking straight to the viewer.",
  photo_story: "A story told with photos that gently move, with your words over them.",
  screen_demo: "A walk-through of something on a screen, step by step.",
  data_update: "A few numbers that matter, each on its own card, with what they mean.",
  testimonial_story: "A client's own words, shown with their clip.",
  event_promo: "An invitation — what, when, where — with a photo of the place.",
  education_explainer: "One idea explained in three simple steps.",
}

const NEXT_STEPS: Record<CustomVideoArchetype, string> = {
  talking_head_message: "Invite a reply: \"Tell me what you're planning — I'm happy to help.\"",
  photo_story: "Offer a private tour or more photos on request.",
  screen_demo: "Point to where they can try it themselves.",
  data_update: "Offer to walk through what the numbers mean for their home.",
  testimonial_story: "Invite others with a similar situation to reach out.",
  event_promo: "Ask them to save the date or reply to hold a spot.",
  education_explainer: "Invite a question: \"Ask me how this works for your situation.\"",
}

const FOCUS: Record<CustomVideoArchetype, GuideField[]> = {
  talking_head_message: ["audience", "script"],
  photo_story: ["goal", "title", "script"],
  screen_demo: ["goal", "bullets", "script"],
  data_update: ["title", "bullets", "script"],
  testimonial_story: ["audience", "script"],
  event_promo: ["title", "goal", "script"],
  education_explainer: ["goal", "bullets", "script"],
}

/** DERIVED: what a kind of video needs, said plainly. */
export function needsChecklist(archetype: CustomVideoArchetype): NeedsChecklist {
  const spec = CUSTOM_ARCHETYPE_REGISTRY[archetype]
  const band = PURPOSE_DURATION_RULES[spec.basePurpose]
  const bring: string[] = []
  const n = spec.needs
  if (n.photos) bring.push(`${n.photos === 1 ? "a photo" : `at least ${n.photos} photos`} (phone photos are fine — bright and level is all it takes)`)
  if (n.screenshots) bring.push(`${n.screenshots === 1 ? "a screenshot" : `${n.screenshots} screenshots`} of the screen you are showing`)
  if (n.statCards) bring.push(`${n.statCards === 1 ? "one number" : `${n.statCards} numbers`} with a label, like "Median price: $425,000" — from a report you trust`)
  if (n.clientFootage) bring.push("your client's own short clip (with their permission)")
  if (n.chartData) bring.push("the numbers for the chart")
  const hosts = archetypeHosts(archetype)
  return {
    archetype,
    headline: ARCHETYPE_HEADLINES[archetype],
    bring,
    length: `About ${band.idealSeconds} seconds (it can run ${band.minSeconds}–${band.maxSeconds})`,
    targetSeconds: band.idealSeconds,
    onCamera: hosts.map((h) => HOST_PLAIN[h]),
    nextStep: NEXT_STEPS[archetype],
    focusFields: FOCUS[archetype],
  }
}

/** Every archetype has a checklist (the proof iterates this). */
export function allChecklists(): NeedsChecklist[] {
  return CUSTOM_VIDEO_ARCHETYPES.map(needsChecklist)
}

/** The system prompt for the guide — warm, plain, compliance-first, bounded. */
export const GUIDE_SYSTEM = [
  "You are a friendly helper inside a real-estate app, guiding an agent who may not be comfortable with technology.",
  "Use plain, warm, encouraging words. No jargon. Short sentences.",
  "Never add requirements or numbers that are not in the facts you are given.",
  "Fair Housing Act: never describe who a home or area is for or who lives there (no age, family, religion, race, national origin, sex, disability words); describe the home, the process and the situation only. Never mention school quality.",
  "Not salesy: no urgency, no guarantees, no 'act now'.",
].join("\n")

export function needsPrompt(c: NeedsChecklist, topicTitle?: string | null): string {
  return [
    `The agent picked this kind of video: ${c.headline}`,
    topicTitle ? `The topic they picked: "${topicTitle}".` : "",
    `Facts (do not change them): length ${c.length}. Can be carried by: ${c.onCamera.join("; ")}. Things to have ready: ${c.bring.length ? c.bring.join("; ") : "nothing but the words"}. A good closing step: ${c.nextStep}`,
    "In 2-3 short sentences, reassure them and tell them what they will need, in your own warm words. Then give up to 3 one-line tips for writing it.",
  ].filter(Boolean).join("\n")
}

export function suggestPrompt(args: { field: GuideField; text: string; archetype?: CustomVideoArchetype | null; goal?: string | null; audience?: string | null; topicTitle?: string | null }): string {
  const f = GUIDE_FIELD_SPECS[args.field]
  return [
    `Box: "${f.label}". What this box is for: ${f.coach}`,
    args.archetype ? `Kind of video: ${ARCHETYPE_HEADLINES[args.archetype]}` : "",
    args.topicTitle ? `Topic: "${args.topicTitle}".` : "",
    args.goal && args.field !== "goal" ? `Their goal: ${args.goal}` : "",
    args.audience && args.field !== "audience" ? `Their viewer: ${args.audience}` : "",
    `What they typed: """${args.text}"""`,
    `Offer up to 3 improved versions of what they typed, each under ${f.maxChars} characters, keeping their meaning and their voice. Also give one short, kind sentence on why the first version reads better.`,
  ].filter(Boolean).join("\n")
}

/** One suggestion cleaned: trimmed, outer quotes stripped, capped to the field. Idempotent. */
export function cleanSuggestion(raw: unknown, field: GuideField): string {
  return String(raw ?? "").trim().replace(/^["'“”]+|["'“”]+$/g, "").slice(0, GUIDE_FIELD_SPECS[field].maxChars).trim()
}

/** Clean model suggestions: trim, cap length, drop empties/duplicates/echoes, cap at 3, drop flagged ones. */
export function sanitizeSuggestions(
  raw: readonly string[],
  input: string,
  field: GuideField,
  isFlagged: (s: string) => boolean,
): { kept: string[]; droppedForFairHousing: number } {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()
  const seen = new Set<string>([norm(input)])
  const kept: string[] = []
  let droppedForFairHousing = 0
  for (const r of raw) {
    const s = cleanSuggestion(r, field)
    if (!s || seen.has(norm(s))) continue
    seen.add(norm(s))
    if (isFlagged(s)) { droppedForFairHousing += 1; continue }
    kept.push(s)
    if (kept.length === 3) break
  }
  return { kept, droppedForFairHousing }
}

/** Should the card ask for suggestions yet? (debounced client-side; this is the server's floor too). */
export function readyToSuggest(field: GuideField, text: string): boolean {
  const t = (text ?? "").trim()
  return t.length >= GUIDE_FIELD_SPECS[field].minCharsToSuggest && t.length <= GUIDE_FIELD_SPECS[field].maxChars * 2
}

/** The client-side pause before a suggestion request (ms). */
export const SUGGEST_DEBOUNCE_MS = 1200
