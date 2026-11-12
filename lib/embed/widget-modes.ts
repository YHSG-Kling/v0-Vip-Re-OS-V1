/**
 * lib/embed/widget-modes.ts
 *
 * WHAT A PUBLIC WEBSITE AGENT CAN DO — the vocabulary, in one place, pure.
 *
 * The embed shipped with two modes, `text` and `live`, and the owner's ask is
 * three: a visitor should be able to TYPE to the agent, TALK to it by voice, or
 * meet it face-to-face as a live talking avatar.
 *
 * `voice` is not cosmetic sugar over `live`. It is the mode most website
 * visitors will actually use: hands-free, no camera-shyness, works on a phone
 * held at walking height, and — the part that matters commercially — it is the
 * only mode where the visitor's own words reach the agent without them typing.
 * A buyer standing in front of a house can ask about it out loud.
 *
 * THE CAPABILITY TRAP THIS MODULE EXISTS TO CLOSE. Voice needs the visitor's
 * microphone published into the stream, and D-ID's SDK is explicit that
 * publishMicrophoneStream is "supported only with Expressive (V4) agents". A
 * talk- or clip-family presenter cannot open a microphone at all. So the mode a
 * broker ENABLES and the mode a visitor can actually USE are two different
 * questions, and the widget must ask both — offering a Talk button over a clip
 * avatar is precisely the dead affordance this codebase keeps paying for.
 *
 * Pure and dependency-free so the settings UI, the public widget and the guard
 * all read the same rule.
 */

import { capabilitiesFor, type DidPresenterType } from "@/lib/did/agent-presenter"

/** The stored vocabulary — mirrors the embed_widgets.enabled_modes CHECK. */
export const EMBED_MODES = ["text", "voice", "live"] as const
export type EmbedMode = (typeof EMBED_MODES)[number]

export function isEmbedMode(v: unknown): v is EmbedMode {
  return typeof v === "string" && (EMBED_MODES as readonly string[]).includes(v)
}

export interface ModeCopy {
  mode: EmbedMode
  /** Button label a VISITOR sees. */
  label: string
  /** What the broker is turning on, in the settings UI. */
  adminLabel: string
  adminHint: string
}

export const MODE_COPY: Record<EmbedMode, ModeCopy> = {
  text: {
    mode: "text",
    label: "Type",
    adminLabel: "Type",
    adminHint: "Visitors type; the agent answers in the transcript. Always available.",
  },
  voice: {
    mode: "voice",
    label: "Talk",
    adminLabel: "Talk (voice)",
    adminHint:
      "Visitors speak out loud and the agent answers in your cloned voice — hands-free, and the mode most people on a phone will use. Needs an Expressive (V4) avatar.",
  },
  live: {
    mode: "live",
    label: "Live avatar",
    adminLabel: "Live avatar (video)",
    adminHint: "Your twin on camera, speaking. Works with every avatar family.",
  },
}

/**
 * TEXT IS NOT OPTIONAL. Every visitor can type — it needs no microphone
 * permission, no camera, no avatar family, and it is the fallback when anything
 * else degrades. Storing a widget with text disabled would produce a bubble
 * that can refuse every visitor whose browser blocks the mic.
 */
export function normalizeEnabledModes(raw: unknown): EmbedMode[] {
  const list = Array.isArray(raw) ? raw.filter(isEmbedMode) : []
  const set = new Set<EmbedMode>(list)
  set.add("text")
  return EMBED_MODES.filter((m) => set.has(m))
}

export interface UsableModesInput {
  /** What the broker enabled on this embed. */
  enabled: EmbedMode[]
  /** The presenter family the session actually minted, or null if unknown. */
  presenterType: DidPresenterType | null | undefined
  /** Whether this browser exposes getUserMedia at all (false in an insecure context). */
  browserHasMic: boolean
}

export interface UsableMode {
  mode: EmbedMode
  label: string
  /** Present ONLY when the mode is enabled but cannot run — shown to the
   *  visitor instead of a button that would do nothing. */
  unavailableReason?: string
}

/**
 * The modes a visitor may actually pick, in visitor-facing order.
 *
 * A mode the broker enabled but the runtime cannot deliver is RETURNED with a
 * reason rather than dropped: silently hiding it makes the broker think their
 * setting did not save, and hiding it while the settings page still shows it
 * enabled is the drift this OS keeps hunting. The widget renders the reason and
 * disables the button.
 */
export function usableModes(input: UsableModesInput): UsableMode[] {
  const enabled = normalizeEnabledModes(input.enabled)
  const caps = capabilitiesFor(input.presenterType ?? undefined)

  return enabled.map((mode): UsableMode => {
    const label = MODE_COPY[mode].label
    if (mode === "voice") {
      if (!input.browserHasMic) {
        return { mode, label, unavailableReason: "Your browser can't share a microphone here." }
      }
      if (!caps.microphone) {
        // The real, published reason — not a shrug. capabilitiesFor carries
        // D-ID's own wording for why a talk/clip presenter cannot take a mic.
        return { mode, label, unavailableReason: "This agent's avatar can't take voice yet." }
      }
    }
    return { mode, label }
  })
}

/** The mode the widget opens on: the richest one that actually works, because a
 *  visitor who never finds the Talk button has the same experience as one who
 *  was never offered it. Text is the floor and always works. */
export function initialMode(modes: UsableMode[]): EmbedMode {
  const live = modes.find((m) => m.mode === "live" && !m.unavailableReason)
  if (live) return "live"
  const voice = modes.find((m) => m.mode === "voice" && !m.unavailableReason)
  if (voice) return "voice"
  return "text"
}
