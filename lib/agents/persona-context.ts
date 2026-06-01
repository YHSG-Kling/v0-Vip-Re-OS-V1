/**
 * lib/agents/persona-context.ts
 *
 * Resolves a contact's persona (`contacts.contact_persona`) into the canonical
 * `aiContext` string from lib/portal/persona-config.ts so per-buyer/seller Managed
 * Agent kickoffs match the same voice/tone the portal uses for that contact.
 *
 * This keeps the agents speaking in the buyer/seller's expected register — a
 * first-time buyer hears reassurance and jargon explanations; an investor hears
 * cap rates and CoC; a divorce/probate contact hears neutral, confidentiality-
 * respecting language.
 */
import "server-only"
import { PERSONA_CONFIGS } from "@/lib/portal/persona-config"

export interface PersonaContext {
  /** The resolved persona key (e.g. "first_time_buyer", "investor", "divorce"). */
  key:        string
  /** Human-readable label (e.g. "First-Time Homebuyer"). */
  label:      string
  /** Whether this is a sensitive context (divorce, probate, foreclosure) that
   *  needs extra care in messaging. */
  sensitive:  boolean
  /** The aiContext string from persona-config — describes voice/tone for the
   *  agent to mirror in its drafts. */
  aiContext:  string
}

const FALLBACK_BUYER_CONTEXT  = "General buyer audience. Use clear, friendly language and avoid jargon. Confirm understanding of any technical term you introduce."
const FALLBACK_SELLER_CONTEXT = "General seller audience. Communicate with respect for their property and timeline. Lead with empathy when the situation may be stressful."

/**
 * Resolve a persona key (from contacts.contact_persona) into a PersonaContext.
 * Returns a sensible fallback when the persona is unknown so the caller always
 * gets a non-null context to drop into the kickoff.
 */
export function resolvePersonaContext(
  personaKey: string | null | undefined,
  fallbackSide: "buyer" | "seller",
): PersonaContext {
  const key  = (personaKey ?? "").trim() || (fallbackSide === "buyer" ? "first_time_buyer" : "first_time_seller")
  const cfg  = PERSONA_CONFIGS[key]
  if (!cfg) {
    return {
      key:        key || fallbackSide,
      label:      fallbackSide === "buyer" ? "Buyer" : "Seller",
      sensitive:  false,
      aiContext:  fallbackSide === "buyer" ? FALLBACK_BUYER_CONTEXT : FALLBACK_SELLER_CONTEXT,
    }
  }
  return {
    key:       cfg.id,
    label:     cfg.label,
    sensitive: !!cfg.sensitiveContext,
    aiContext: cfg.aiContext,
  }
}
