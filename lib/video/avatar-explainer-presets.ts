/**
 * lib/video/avatar-explainer-presets.ts
 *
 * TEAMMATE VIDEO lane — pure, client-safe presets + shared vocabulary.
 * Split from lib/video/avatar-explainer.ts so the studio UI can import the
 * preset list without pulling the server-side commission module (whose
 * dynamic imports reach server-only code) into the client bundle.
 *
 * Presets are TOPICS ONLY — the script/on-screen copy is always AI-authored
 * per tenant in the brand voice and compliance-gated at commission time.
 */

export interface AvatarExplainerPreset {
  id: "listing_explainer" | "buyer_education" | "market_update" | "agent_intro"
  label: string
  /** Short on-screen eyebrow default (the model may refine it). */
  eyebrow: string
  /** What the video should cover — a topic seed, never a script. */
  topicSeed: string
  defaultAudience: string
}

export const AVATAR_EXPLAINER_PRESETS: AvatarExplainerPreset[] = [
  {
    id: "listing_explainer",
    label: "Listing explainer",
    eyebrow: "About this home",
    topicSeed: "Walk viewers through what makes this listing worth a closer look and what to ask before touring it",
    defaultAudience: "active buyers following this listing",
  },
  {
    id: "buyer_education",
    label: "Buyer education",
    eyebrow: "Buyer basics",
    topicSeed: "Explain one step of the home-buying process buyers most often misunderstand",
    defaultAudience: "first-time home buyers",
  },
  {
    id: "market_update",
    label: "Market update",
    eyebrow: "Market update",
    topicSeed: "What the current local market conditions mean for people deciding whether to buy or sell now",
    defaultAudience: "homeowners and buyers in my local market",
  },
  {
    id: "agent_intro",
    label: "Agent introduction",
    eyebrow: "Meet your agent",
    topicSeed: "Introduce the agent, how they work, and what a client can expect from the first conversation",
    defaultAudience: "new leads who have not met me yet",
  },
]

/** Where the narration voice comes from — labeled honestly end-to-end. */
export type ExplainerVoiceSource =
  | "agent_clone"          // the agent's own ElevenLabs voice clone
  | "brokerage_assistant"  // the brokerage's configured assistant voice
  | "stock_elevenlabs"     // platform stock ElevenLabs voice (labeled fallback)
  | "did_default"          // no ElevenLabs configured — D-ID's built-in TTS
