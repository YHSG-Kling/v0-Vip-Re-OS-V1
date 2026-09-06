// lib/voice-admin/kernel-command-surface.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE VOICE ADMIN SPEAKS TO THE KERNEL, NOT TO A HAND-KEPT LIST.
//
// What already exists and is good: handleVoiceCommand validates authority against a
// real matrix, validates business readiness, and dispatches through
// COMMAND_EXECUTORS — statically imported so tsc guarantees every mapped command
// resolves (a previous round fixed a runtime-string dynamic import that silently
// failed in production). None of that is replaced. Those 16 commands are the DIRECT
// lane: one verb, one action, executed now.
//
// Three things the direct lane cannot do, and this module adds:
//
// 1. IT COVERS 16 OF THE KERNEL'S 28 CAPABILITIES. The map is hand-kept, so most of
//    the OS is not voice-addressable and a NEW kernel capability never becomes so.
//    APP_CAPABILITY_REGISTRY is already the kernel's own machine-readable command
//    surface — it powers /api/agentic-os/actions and the MCP tools/list. The voice
//    admin should read the same registry, so adding a capability makes it speakable
//    with no second list to update.
//
// 2. IT CANNOT EXPRESS A MULTI-STEP INSTRUCTION. "Spin up a two-week plan for 123
//    Main and send the seller a reel" is three capabilities owned by three different
//    managers. Executed inline it is three unattributed function calls with no
//    approval trail. Decomposed onto the egress it is a PLAN: each step attributed to
//    the manager whose charter owns it (CAPABILITY_MANAGER), gated where it mutates,
//    visible on the Command Center. Voice in, governed multi-agent execution out —
//    which is the thing a single-assistant competitor cannot structurally do.
//
// 3. IT VALIDATES BUSINESS READINESS BUT NOT CAPABILITY OPERABILITY. readiness-rules
//    answers "is this listing at the right stage"; it does not answer "is the provider
//    this needs actually connected". So the voice admin could accept "post that to
//    Instagram" and fail mid-command on a tenant with no social account. The
//    capability contract already knows — this consults it BEFORE promising.
//
// PURE — no I/O. Intent resolution, plan shape and gating are unit-tested without a
// database, a model, or a microphone. The live resolution lives in plan-voice-command.ts.

import {
  APP_CAPABILITY_REGISTRY,
  type AppCapability,
  type AppCapabilityDef,
} from "@/lib/agentic-os/app-capability-registry"
import { CAPABILITY_MANAGER } from "@/lib/agentic-os/capability-ownership"
import type { ManagerKey } from "@/lib/kernel/manager-registry"

/**
 * A capability the voice admin can speak to, with the phrases that reach it.
 *
 * Phrases are deliberately CONSERVATIVE and multi-word. A single generic token
 * ("send", "post") matched against free speech produces confident misfires, and a
 * voice admin that does the wrong consequential thing is worse than one that asks.
 */
export interface VoiceCapability {
  capability: AppCapability
  def: AppCapabilityDef
  /** The manager accountable — this is what a plan step is attributed to. */
  manager: ManagerKey
  /** Lowercase phrases that indicate this capability. Multi-word by design. */
  phrases: readonly string[]
  /** True when executing it changes something — always confirmed before running. */
  mutates: boolean
}

/**
 * Phrase → capability. Keyed on the capability so it CANNOT drift from the registry:
 * the guard proves every key is real and that every mutating capability either has
 * phrases or is deliberately unspoken.
 *
 * Capabilities with NO phrases are unreachable by voice on purpose — `payment_transfer`
 * moves money and `transaction_advance` changes a deal's legal stage. Those are not
 * things to trigger from a spoken sentence in a car, and the omission is the decision,
 * not an oversight.
 */
export const VOICE_PHRASES: Partial<Record<AppCapability, readonly string[]>> = {
  // ── Reads: safe, high-value, the "what's on my plate" class ──
  lead_search:           ["find leads", "search leads", "which leads", "show me leads", "new leads"],
  contact_get:           ["look up", "pull up the contact", "who is", "tell me about"],
  report_generate:       ["run a report", "how did we do", "pipeline report", "source report"],
  education_path_get:    ["learning path", "what should they learn"],
  portal_milestones_get: ["where are we", "milestone", "client timeline"],
  connectivity_scan:     ["connection health", "what is connected", "integration status"],

  // ── Writes: real work, confirmed before it runs ──
  cma_generate:              ["run a cma", "comparative market analysis", "what is it worth", "value that home"],
  appointment_schedule:      ["book an appointment", "schedule a showing", "put it on my calendar", "set a meeting"],
  isa_qualify:               ["qualify that lead", "run qualification"],
  lead_create:               ["add a lead", "create a lead", "new lead for"],
  listing_publish:           ["publish the listing", "take it live", "go active"],
  marketing_campaign_create: ["spin up a campaign", "start a campaign", "two week plan", "marketing plan"],
  newsletter_send:           ["send the newsletter"],
  blog_publish:              ["publish the blog", "post the article"],
  social_post_publish:       ["post to social", "put it on instagram", "share on facebook", "post that on linkedin"],
  content_repurpose:         ["repurpose", "turn that into"],
  video_distribute:          ["send the video", "send them the reel", "share the reel"],
  direct_mail_send:          ["send a postcard", "mail the neighborhood", "direct mail"],
  gift_send:                 ["send a gift", "closing gift"],
  handwritten_note_send:     ["send a card", "handwritten note", "thank you card"],
  review_request_send:       ["ask for a review", "request a review"],
  inbox_reply_send:          ["reply to", "text them back", "email them back"],
  education_assign:          ["assign the guide", "send them the course"],
  podcast_publish:           ["publish the episode", "release the podcast"],
  report_export:             ["export that report", "send me the csv"],

  // DELIBERATELY UNSPOKEN — see the doc comment above:
  //   payment_transfer      moves money
  //   accounting_sync       writes to the books
  //   transaction_advance   changes a deal's legal stage
}

/** The full speakable surface, derived from the kernel registry. */
export function voiceCapabilities(): VoiceCapability[] {
  return (Object.keys(VOICE_PHRASES) as AppCapability[])
    .filter((c) => !!APP_CAPABILITY_REGISTRY[c])
    .map((c) => ({
      capability: c,
      def: APP_CAPABILITY_REGISTRY[c],
      manager: CAPABILITY_MANAGER[c],
      phrases: VOICE_PHRASES[c] ?? [],
      mutates: APP_CAPABILITY_REGISTRY[c].mutates,
    }))
}

/** The signal a dispatched plan step publishes. Catalogued in signal-registry.
 *  Lives HERE, in the pure module, so a proof can import it without pulling in
 *  server-only — the planner re-exports it for callers. */
export const VOICE_COMMAND_SIGNAL = "voice_command_dispatched" as const

/** Capabilities intentionally unreachable by voice. Named so the guard can hold them. */
export const VOICE_WITHHELD: readonly AppCapability[] = [
  "payment_transfer",
  "accounting_sync",
  "transaction_advance",
] as const

export interface IntentMatch {
  capability: AppCapability
  manager: ManagerKey
  /** The phrase that matched — shown back to the speaker so a misfire is visible. */
  matchedPhrase: string
  mutates: boolean
  /** Longer phrase = more specific = higher confidence. Used only for ordering. */
  specificity: number
}

/**
 * PURE: which capabilities does this utterance ask for?
 *
 * Returns EVERY match, most specific first — because a real instruction often
 * contains several ("run a cma on 412 Oak and book an appointment with the Chens").
 * Deliberately NOT a single best guess: collapsing a two-capability sentence into one
 * silently drops half of what was asked.
 *
 * Matching is substring-on-normalised-text, which is conservative: it can miss a
 * paraphrase (the speaker rephrases, no harm) but it will not invent an intent from
 * an unrelated sentence. For a surface that triggers real sends, missing beats
 * guessing.
 */
export function matchIntents(utterance: string): IntentMatch[] {
  const text = ` ${(utterance ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `
  if (text.trim().length === 0) return []

  const hits = new Map<AppCapability, IntentMatch>()
  for (const vc of voiceCapabilities()) {
    for (const phrase of vc.phrases) {
      if (!text.includes(` ${phrase} `) && !text.includes(`${phrase} `) && !text.includes(` ${phrase}`)) continue
      const existing = hits.get(vc.capability)
      if (existing && existing.specificity >= phrase.length) continue
      hits.set(vc.capability, {
        capability: vc.capability,
        manager: vc.manager,
        matchedPhrase: phrase,
        mutates: vc.mutates,
        specificity: phrase.length,
      })
    }
  }
  return [...hits.values()].sort((a, b) => b.specificity - a.specificity)
}

// ─── THE PLAN ────────────────────────────────────────────────────────────────

export type StepDisposition =
  /** Runs. A read, or a write the speaker confirmed. */
  | "ready"
  /** A write awaiting the speaker's confirmation before anything happens. */
  | "needs_confirmation"
  /** The capability cannot run for this tenant — said BEFORE promising. */
  | "not_operable"
  /** The speaker's role may not invoke it. */
  | "not_authorized"

export interface PlanStep {
  capability: AppCapability
  /** The manager this step is attributed to on the Command Center. */
  manager: ManagerKey
  matchedPhrase: string
  mutates: boolean
  disposition: StepDisposition
  /** One line the voice admin can SAY about this step. */
  say: string
}

export interface VoicePlan {
  utterance: string
  steps: PlanStep[]
  /** True when at least one step will actually do something. */
  actionable: boolean
  /** Steps needing a yes before anything runs. */
  awaitingConfirmation: number
  /** What the voice admin says back, in one breath. */
  spokenSummary: string
}

export interface PlanInputs {
  /** Capability → can it run for this tenant right now (resolveAppCapability). */
  operable: Partial<Record<AppCapability, boolean>>
  /** Capability → is the speaker's role allowed (the authority matrix / scopes). */
  authorized: Partial<Record<AppCapability, boolean>>
  /** The speaker already said yes to mutating work in this turn. */
  confirmed?: boolean
  /** Why a capability is dark, for the spoken line. */
  blockReason?: Partial<Record<AppCapability, string>>
}

/**
 * PURE: turn an utterance into a governed PLAN.
 *
 * The ordering of the gates is the design, and it is deliberately the opposite of
 * convenient:
 *
 *   authorization  first — never tell someone what they could do if they were
 *                  allowed to; that is an information leak dressed as helpfulness.
 *   operability    second — a capability whose provider is dark is refused BEFORE
 *                  the speaker is promised anything, rather than failing mid-command.
 *   confirmation   last — a mutating step never runs on the strength of one sentence.
 *
 * Nothing here executes. A plan is a proposal; the caller dispatches its ready steps
 * onto the egress, where each is attributed and auditable.
 */
export function buildVoicePlan(utterance: string, inputs: PlanInputs): VoicePlan {
  const matches = matchIntents(utterance)

  const steps: PlanStep[] = matches.map((m) => {
    const label = APP_CAPABILITY_REGISTRY[m.capability].purpose.replace(/\.$/, "")

    if (inputs.authorized[m.capability] === false) {
      return {
        ...m, disposition: "not_authorized" as const,
        say: `You are not able to ${m.matchedPhrase} from this account.`,
      }
    }
    if (inputs.operable[m.capability] === false) {
      const why = inputs.blockReason?.[m.capability]
      return {
        ...m, disposition: "not_operable" as const,
        say: why
          ? `I cannot ${m.matchedPhrase} yet — ${why}`
          : `I cannot ${m.matchedPhrase} yet: the provider it needs is not connected.`,
      }
    }
    if (m.mutates && !inputs.confirmed) {
      return {
        ...m, disposition: "needs_confirmation" as const,
        say: `${label} — say yes and ${humanManager(m.manager)} will take it.`,
      }
    }
    return {
      ...m, disposition: "ready" as const,
      say: `${humanManager(m.manager)} is on it: ${label.toLowerCase()}.`,
    }
  })

  const ready = steps.filter((s) => s.disposition === "ready")
  const awaiting = steps.filter((s) => s.disposition === "needs_confirmation")
  const blocked = steps.filter((s) => s.disposition === "not_operable" || s.disposition === "not_authorized")

  let spoken: string
  if (steps.length === 0) {
    // The honest miss. Never a fabricated action, and never silence.
    spoken = "I did not catch a command I can act on. Try naming the thing you want — a CMA, an appointment, a campaign."
  } else if (awaiting.length > 0) {
    spoken =
      `That is ${steps.length} ${steps.length === 1 ? "step" : "steps"}: ` +
      steps.map((s) => s.matchedPhrase).join(", then ") +
      `. ${awaiting.length === 1 ? "It" : "They"} will change things — say yes and I will hand ${awaiting.length === 1 ? "it" : "them"} to ` +
      uniqueManagers(awaiting).join(" and ") + "."
  } else if (ready.length > 0) {
    spoken =
      `On it — ${ready.map((s) => s.matchedPhrase).join(", ")}, with ` +
      uniqueManagers(ready).join(" and ") +
      (blocked.length > 0 ? `. ${blocked.length} I cannot do: ${blocked.map((s) => s.say).join(" ")}` : ".")
  } else {
    spoken = blocked.map((s) => s.say).join(" ")
  }

  return {
    utterance,
    steps,
    actionable: ready.length > 0,
    awaitingConfirmation: awaiting.length,
    spokenSummary: spoken,
  }
}

/** Manager keys are machine names; a voice admin says a person-shaped title. */
const MANAGER_SPOKEN: Record<string, string> = {
  ai_isa: "your ISA",
  campaign_orchestrator: "your campaign manager",
  marketing_agent: "your marketing manager",
  asset_manager: "your asset manager",
  ads_manager: "your ads manager",
  listing_concierge: "your listing concierge",
  shopping_agent: "your buyer agent",
  deal_coordinator: "your transaction coordinator",
  sphere_of_influence: "your sphere manager",
  data_steward: "your data steward",
  finance_manager: "your finance manager",
  compliance_officer: "your compliance officer",
  recruiting_manager: "your recruiting manager",
  cron_manager: "operations",
}

export function humanManager(key: ManagerKey): string {
  return MANAGER_SPOKEN[key] ?? key.replace(/_/g, " ")
}

function uniqueManagers(steps: PlanStep[]): string[] {
  return [...new Set(steps.map((s) => humanManager(s.manager)))]
}
