// lib/kernel/ai-copy.ts
//
// PERSONA-AWARE COPY — the team never sends boilerplate. Every contact is a different
// person; a "just sold near you" note to a long-tenure empty-nester reads nothing like
// one to a young investor. So play copy is GENERATED per persona + the real facts, not
// hardcoded. The hardcoded strings the plays carry become the deterministic FALLBACK
// (used when the gateway is unavailable or in tests) — still real, safe defaults, never
// a stub.
//
// The generator is an injectable seam (like every other vendor boundary) so tests don't
// spend tokens; production routes through the AI gateway. The system prompt enforces the
// non-negotiables: Fair Housing safety, ONLY the facts provided (no fabrication), and the
// persona's tone. NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"
// languageName is a PURE function (no server-only I/O at module scope in
// multilingual-reel.ts — only commissionMultilingualReel does I/O, and it
// dynamic-imports its own server-only deps internally), so a static import
// here is safe and is the ONE name→language-label map (§6).
import { languageName as languageNameForCopy } from "@/lib/video/multilingual-reel"
// PURE (no server-only) — see its header. §1: BUILT ahead of a real caller
// rather than waited on, per the wave-55 ruling that an unmounted capability
// gets mounted, not skipped — no channel here is spoken/video TODAY (every
// avatar/video script is drafted by the dedicated writers in lib/video/*
// instead), but this generic copy engine is the one place a future spoken
// channel (a video caption, an avatar-video CTA line) would reach, and it
// must not silently miss the ONE realism directive every other writer carries.
import { SPOKEN_REALISM_DIRECTIVE } from "@/lib/video/realism-profile"
// WAVE 151 (lane 151I) — THE SENDER FIRST, THEN THE PERSON, THEN THE RULES. The sender-voice brief is compiled by THE
// brand-voice reader (lib/kernel/brand-voice.ts loadSenderVoiceBrief — the one cascade, versioned); it is rendered into
// the system prompt BEFORE the first draft, never applied to a finished draft. Both modules are already on the
// app/crm/page.tsx import graph (1300/1300), so this import adds no module.
import { loadSenderVoiceBrief, renderSenderVoiceBrief, voiceSourceStamp, type SenderVoiceBrief, type VoiceSourceStamp } from "@/lib/kernel/brand-voice"

/**
 * Channels whose copy is SPOKEN aloud rather than only read — the set
 * SPOKEN_REALISM_DIRECTIVE applies to. Every channel any caller uses today
 * (landing, portal, blog, farm postcards, …) is written-only, so this set is
 * currently empty in practice; it exists so a future avatar/video caller of
 * generatePersonaCopy is realism-directed automatically instead of silently
 * missing the directive every dedicated video-script writer already carries.
 */
const SPOKEN_COPY_CHANNELS = new Set(["video", "avatar_video", "reel", "reel_caption", "video_script"])

type Svc = ReturnType<typeof createServiceClient>

export interface CopyPersona {
  name?: string | null
  /** buyer | seller | lead | past_client | investor | neighbor | agent | "audience". */
  audience?: string | null
  /** lifecycle / stage hint (e.g. "first-time buyer", "long-tenure homeowner"). */
  situation?: string | null
  /** the agent's brand-voice tone, if configured. */
  tone?: string | null
}

export interface CopyRequest {
  /** What we're writing (e.g. "a 'just sold near you' farm postcard"). */
  goal: string
  /** The ONLY facts the copy may use — no fabrication beyond these. */
  facts: string[]
  channel: string
  persona: CopyPersona
  /** ~ target length in words. */
  words?: number
  /**
   * WRITING CONSTRAINTS, not facts — the difference matters. `facts` is the closed
   * set the copy may draw ON; `directives` are rules the writer must obey WHILE
   * drawing. CLAUDE.md §5 asks for fair housing "in the writing prompt, not only in
   * the post-hoc scan", and laundering a directive through `facts` would invite the
   * model to repeat it back to the reader as though it were something we know about
   * them.
   *
   * ADDITIVE: omitting it reproduces the prior system prompt BYTE-FOR-BYTE (the
   * simulator asserts exactly that), so no existing caller's copy changes.
   */
  directives?: string[]
  /**
   * ISO 639-1 language code (the LOCALE_TO_ELEVENLABS_LANGUAGE-mapped code from
   * lib/video/multilingual-reel.ts — never a second spelling, §6) the copy
   * should be WRITTEN in. ADDITIVE and OPTIONAL: omitted or "en" reproduces the
   * prior system prompt byte-for-byte (English was always the implicit
   * language, so DEFAULT_LANGUAGE needs no extra instruction). Only a non-
   * English resolved language adds a directive line — set by callers that
   * resolved a contact's language via resolveContactLanguage /
   * resolveContactLanguageFromDb (welcome avatar video, persona reels), never
   * guessed here.
   */
  language?: string | null
  /**
   * WAVE 151 (lane 151I) — WHO IS WRITING. The identity the copy engine compiles the versioned sender-voice brief from
   * (lib/kernel/brand-voice.ts loadSenderVoiceBrief) BEFORE the first draft: the sender's stated words, tagline, tone,
   * signature and authorized examples. ADDITIVE: omitted (with `senderVoice` absent too) reproduces the prior system
   * prompt byte for byte.
   */
  sender?: SenderRef | null
  /** A brief the caller already compiled (the ISA cascade returns one) — wins over `sender`. */
  senderVoice?: SenderVoiceBrief | null
  /** WHO IT IS FOR — the person's own stated needs and preferences (persona-render.ts loadAudienceBrief). Them first. */
  audience?: AudienceBrief | null
}

export interface CopyDraft {
  subject?: string
  body: string
  /** WAVE 151 (151I): the voice the draft was written in — recorded on the produced asset (distribution_finals.findings.voice_source). Absent on a deterministic fallback (nobody's voice was modelled). */
  voiceSource?: VoiceSourceStamp | null
}

/** Injectable seam: produce persona-tailored copy, or null to fall back. */
export type CopyGenerator = (req: CopyRequest) => Promise<CopyDraft | null>

/** The chat call the real generator makes — the vendor seam one level below the generator (a proof injects a deterministic one through generatePersonaCopy's `opts.chat`). */
type CopyChat = (args: { model: string; messages: Array<{ role: "system" | "user"; content: string }>; maxTokens: number; temperature: number }) => Promise<{ ok: boolean; content?: string | null }>

// ─── THE AUDIENCE BRIEF (wave 151, lane 151I — "gear it to them first") ───────────────────────────
//
// The person's side of the brief: what THEY said they need and how they want to hear from us, compiled by the
// FH-safe fact survivor (lib/campaign-sequences/persona-render.ts loadAudienceBrief — persona + facts by construction,
// plus the memory ledger the person's OWN words wrote, lib/kernel/conversation-memory.ts) and handed to the writer BEFORE
// the first draft. The type and its renderer live beside CopyRequest because the copy engine is what reads them; the
// loader lives with the facts rule it extends. Every persona label is welcome; no attribute is deleted — the fair-housing
// rule lives at the ACTION (what may be a copy fact), never as a refused label.

export interface AudienceBrief {
  schema: 1
  contactId: string | null
  name: string | null
  /** Any persona label the record carries — never refused, never a copy fact by itself. */
  personaLabel: string | null
  /** contact_type as a LABEL (buyer / seller / both / audience) — never an intent signal. */
  audience: string | null
  situation: string | null
  /** THEM FIRST: what the person said matters to them (their words, current) — the copy opens on these. */
  leadWith: string[]
  /** Current, unexpired facts the person's own words wrote (the memory ledger). */
  stated: Array<{ key: string; value: string; source: string; observedAt: string | null }>
  preferences: { channel: string | null; time: string | null; language: string | null; format: string | null; frequency: string | null; explanationStyle: string | null; accessibility: string[] }
  /** The closed set of FH-safe facts the copy may use (buildPersonaContext). */
  facts: string[]
  evidenceClass: "expressed_interest" | "persona_only" | "none"
  sources: string[]
  readErrors: string[]
}

/** Where a writer is told who the sender is (the identity ref the copy engine compiles the voice brief from). */
export interface SenderRef { brokerageId: string; teamId?: string | null; agentUserId?: string | null; agentId?: string | null }

/** PURE. The audience brief as the writer reads it — right after the sender's voice, before any rule. */
function renderAudienceBrief(a: AudienceBrief): string {
  const who = [a.name ?? "the recipient", a.audience ? `${a.audience}` : null, a.personaLabel ? `persona: ${a.personaLabel.replace(/_/g, " ")}` : null, a.situation ? `situation: ${a.situation}` : null].filter(Boolean).join(" · ")
  const lines = [
    `AUDIENCE BRIEF v${a.schema} — write for THIS person, them first (${a.evidenceClass === "expressed_interest" ? "what follows is what they told us" : a.evidenceClass === "persona_only" ? "a persona label only — nothing stated yet" : "nothing known yet"}).`,
    `Who: ${who}`,
    a.leadWith.length
      ? `THEM FIRST — they told us what matters to them: ${a.leadWith.join("; ")}. Open with genuinely useful help on exactly that (their options, what changes for them, what does not) before anything about the sender's services. Do NOT open with an offer to sell, list or value their home unless they asked about selling.`
      : "THEM FIRST — nothing stated yet: write about what is useful to someone in their situation, never a pitch; one small question that lets them say what matters beats a list of services.",
  ]
  if (a.stated.length) lines.push(`What they told us (their own words, current): ${a.stated.map((s) => `${s.key.replace(/_/g, " ")} = ${s.value}`).join("; ")}`)
  const prefs = [a.preferences.channel ? `channel ${a.preferences.channel}` : null, a.preferences.time ? `time ${a.preferences.time}` : null, a.preferences.language ? `language ${a.preferences.language}` : null, a.preferences.format ? `format ${a.preferences.format}` : null, a.preferences.frequency ? `frequency ${a.preferences.frequency}` : null, a.preferences.explanationStyle ? `explain ${a.preferences.explanationStyle.replace(/_/g, " ")}` : null, a.preferences.accessibility.length ? `accessibility ${a.preferences.accessibility.join(", ")}` : null].filter(Boolean)
  if (prefs.length) lines.push(`How they want to hear from us: ${prefs.join(" · ")}`)
  lines.push(a.facts.length ? `Facts you may use about them (the closed set — nothing else): ${a.facts.join("; ")}` : "Facts you may use about them: none beyond what is above.")
  lines.push("Never use a protected-class attribute (race, color, religion, national origin, sex, familial status, disability, age) — not as a fact, not as a hint, whatever the persona label says. Every persona is welcome; write with care and without pressure.")
  if (a.readErrors.length) lines.push(`Could not be read (do not guess it): ${a.readErrors.join("; ")}`)
  return lines.join("\n")
}

/** PURE. The system prompt in the owner's order: the sender's voice, then the person, then the rules. With neither brief it is the rules alone, byte for byte. */
function composeVoicedSystem(senderVoice: SenderVoiceBrief | null | undefined, audience: AudienceBrief | null | undefined, rules: string[]): string {
  return [senderVoice ? renderSenderVoiceBrief(senderVoice) : null, audience ? renderAudienceBrief(audience) : null, ...rules].filter((x): x is string => typeof x === "string").join("\n")
}

/** The sender's brief for a request: handed in pre-compiled, or compiled from the identity ref on the service client (the caller's VERIFIED tenant). Never throws. */
async function senderVoiceFor(req: CopyRequest): Promise<SenderVoiceBrief | null> {
  if (req.senderVoice) return req.senderVoice
  if (!req.sender?.brokerageId) return null
  try {
    return await loadSenderVoiceBrief(createServiceClient() as never, { brokerageId: req.sender.brokerageId, teamId: req.sender.teamId ?? null, agentUserId: req.sender.agentUserId ?? null, agentId: req.sender.agentId ?? null })
  } catch (e) {
    console.error("[ai-copy] sender-voice brief unavailable — the draft is written without the sender's voice:", (e as Error)?.message ?? String(e))
    return null
  }
}

/** The real generator — routes through the AI gateway. Returns null on any failure so
 *  the caller's deterministic fallback takes over (the play always produces copy). */
function makeRealCopyGenerator(chat?: CopyChat): CopyGenerator {
  return async (req) => {
  const send: CopyChat = chat ?? (await import("@/lib/ai/gateway-chat")).gatewayChat as unknown as CopyChat
  // THE SENDER FIRST (wave 151I): the voice brief is resolved BEFORE the prompt exists, so the first draft is written in it.
  const senderVoice = await senderVoiceFor(req)
  const persona = [
    req.persona.name ? `Name: ${req.persona.name}` : null,
    req.persona.audience ? `Audience: ${req.persona.audience}` : null,
    req.persona.situation ? `Situation: ${req.persona.situation}` : null,
    req.persona.tone ? `Brand tone to match: ${req.persona.tone}` : null,
  ].filter(Boolean).join("\n")
  const { SCRIPT_QUALITY_CHARTER } = await import("@/lib/ai/script-standards")
  const sys = composeVoicedSystem(senderVoice, req.audience ?? null, [
    "You write real-estate marketing copy for a specific person. Rules you must NEVER break:",
    "1. FAIR HOUSING: never reference or imply race, religion, national origin, family status, disability, sex, or use steering language ('safe neighborhood', 'perfect for families', 'great for retirees').",
    "2. Use ONLY the facts provided — invent nothing (no prices, dates, names, or claims not given).",
    "3. Write to THIS persona's situation and tone; make it feel one-to-one, not a blast.",
    `4. Keep it ~${req.words ?? 60} words, warm, no pressure.`,
    ...(req.directives?.length
      ? ["5. Additional non-negotiable constraints for THIS piece:", ...req.directives.map((d) => `   - ${d}`)]
      : []),
    // ADDITIVE — a resolved non-English language adds ONE line; "en" or absent
    // changes nothing (the language was always implicitly English). Never a
    // second language-name spelling: the name comes from the ONE map,
    // lib/video/multilingual-reel.ts::languageName (§6).
    ...(req.language && req.language !== "en"
      ? [`6. Write the ENTIRE piece in ${languageNameForCopy(req.language)} — subject and body both, no English mixed in.`]
      : []),
    // ADDITIVE — every existing (written-only) channel is byte-for-byte
    // unaffected; only a future spoken/video channel gains this line.
    ...(SPOKEN_COPY_CHANNELS.has(req.channel) ? [SPOKEN_REALISM_DIRECTIVE] : []),
    SCRIPT_QUALITY_CHARTER,
    `Return STRICT JSON: {"subject": "<short subject or empty>", "body": "<the copy>"}.`,
  ])
  const usr = `Write ${req.goal} for the ${req.channel} channel.\n\nPersona:\n${persona || "(general audience)"}\n\nFacts you may use:\n${req.facts.map((f) => `- ${f}`).join("\n")}`
  const res = await send({ model: "openai/gpt-4o-mini", messages: [{ role: "system", content: sys }, { role: "user", content: usr }], maxTokens: 400, temperature: 0.7 })
  if (!res.ok || !res.content) return null
  const voiceSource = senderVoice ? voiceSourceStamp(senderVoice) : null
  try {
    const m = res.content.match(/\{[\s\S]*\}/)
    if (!m) return { body: res.content.trim(), voiceSource }
    const j = JSON.parse(m[0]) as { subject?: string; body?: string }
    if (!j.body) return null
    return { subject: j.subject || undefined, body: j.body, voiceSource }
  } catch { return { body: res.content.trim(), voiceSource } }
  }
}

const defaultRealCopyGenerator = makeRealCopyGenerator()
/** The real generator — the sender-first composition on the AI gateway (the export every play, sequence and lead magnet names). */
export const realCopyGenerator: CopyGenerator = async (req) => defaultRealCopyGenerator(req)

/**
 * Generate persona-aware copy, falling back to the play's deterministic default. The
 * fallback guarantees a play ALWAYS produces real copy; the generator makes it personal.
 * `opts.chat` (wave 151I) drives the REAL generator — the sender-first composition — on an injected chat call, so a
 * proof can read the exact system prompt and the draft a deterministic model writes from it without spending tokens.
 */
export async function generatePersonaCopy(
  req: CopyRequest, fallback: CopyDraft, opts: { generator?: CopyGenerator; chat?: CopyChat } = {},
): Promise<CopyDraft> {
  const generator = opts.generator ?? (opts.chat ? makeRealCopyGenerator(opts.chat) : realCopyGenerator)
  const out = await generator(req).catch(() => null)
  return out ?? fallback
}

/** Pull a contact's persona for copy from the live row (best-effort). */
export async function loadContactPersona(supabase: Svc, contactId: string): Promise<CopyPersona> {
  const { data: c } = await supabase.from("contacts")
    .select("first_name, last_name, contact_type, buyer_stage").eq("id", contactId).maybeSingle()
  if (!c) return { audience: "audience" }
  return {
    name: [(c as any).first_name, (c as any).last_name].filter(Boolean).join(" ").trim() || null,
    audience: (c as any).contact_type ?? "audience",
    situation: (c as any).buyer_stage ?? null,
  }
}
