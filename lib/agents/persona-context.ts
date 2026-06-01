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

// Sensitive-context substrings — if the supplied persona key contains any of these
// (e.g. "divorce_buyer", "post_probate", "foreclosure_seller_relocating") and isn't
// in PERSONA_CONFIGS as an exact match, the fuzzy fallback preserves the
// sensitive=true flag AND maps to the canonical persona's aiContext so the agent
// still gets the right voice. Coarse defaults silently strip this; the bug a code
// review flagged.
const SENSITIVE_FALLBACK_MAP: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /divorce/i,      canonical: "divorce" },
  { pattern: /probate/i,      canonical: "probate" },
  { pattern: /foreclos/i,     canonical: "foreclosure" },
  { pattern: /senior|elder/i, canonical: "senior" },
  { pattern: /military|va_loan/i,  canonical: "military_buyer" },
  { pattern: /relocat/i,      canonical: "relocating" },
  { pattern: /luxury/i,       canonical: "luxury_buyer" }, // luxury_seller maps separately below
]

/**
 * Resolve a persona key (from contacts.contact_persona) into a PersonaContext.
 * Returns a sensible fallback when the persona is unknown so the caller always
 * gets a non-null context to drop into the kickoff.
 *
 * Fuzzy fallback: when the key doesn't exactly match a PERSONA_CONFIGS entry, we
 * scan SENSITIVE_FALLBACK_MAP for substring matches so that variants like
 * "divorce_buyer" / "post_probate_2024" still resolve to the canonical config's
 * aiContext + sensitive flag instead of silently downgrading to "general buyer".
 */
export function resolvePersonaContext(
  personaKey: string | null | undefined,
  fallbackSide: "buyer" | "seller",
): PersonaContext {
  const rawKey = (personaKey ?? "").trim()
  const key    = rawKey || (fallbackSide === "buyer" ? "first_time_buyer" : "first_time_seller")

  // Exact match — fast path.
  const exact = PERSONA_CONFIGS[key]
  if (exact) {
    return {
      key:       exact.id,
      label:     exact.label,
      sensitive: !!exact.sensitiveContext,
      aiContext: exact.aiContext,
    }
  }

  // Fuzzy match — preserve sensitive flag when the key carries it. luxury_seller
  // takes precedence over the generic luxury_buyer mapping when the side is seller.
  if (rawKey) {
    for (const m of SENSITIVE_FALLBACK_MAP) {
      if (m.pattern.test(rawKey)) {
        const target = m.canonical === "luxury_buyer" && fallbackSide === "seller" ? "luxury_seller" : m.canonical
        const fuzzy = PERSONA_CONFIGS[target]
        if (fuzzy) {
          return {
            key:       fuzzy.id,
            label:     fuzzy.label,
            sensitive: !!fuzzy.sensitiveContext,
            aiContext: fuzzy.aiContext,
          }
        }
      }
    }
  }

  // True last-resort fallback.
  return {
    key:        key || fallbackSide,
    label:      fallbackSide === "buyer" ? "Buyer" : "Seller",
    sensitive:  false,
    aiContext:  fallbackSide === "buyer" ? FALLBACK_BUYER_CONTEXT : FALLBACK_SELLER_CONTEXT,
  }
}
