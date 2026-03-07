import type { SellerPersona } from "./coaching-generator"

/**
 * getSellerPersona
 * Pure utility — NOT a server action. Lives in lib/ so it can be imported
 * by both server actions and lib modules without "use server" constraints.
 *
 * Derivation rules (spec-ordered, highest priority first):
 *   motivation_score > 80           → 'motivated'
 *   tags includes 'investor'        → 'investor'
 *   communication_preference = 'detailed' → 'analytical'
 *   contact_persona (stored value)  → use if valid
 *   Default                         → null (system will treat as 'standard')
 */
export function getSellerPersona(contact: {
  contact_persona?: string | null
  motivation_score?: number | null
  tags?: string[] | null
  communication_preference?: string | null
}): SellerPersona {
  const valid: SellerPersona[] = [
    "motivated", "skeptical", "emotional", "investor", "indecisive", "analytical",
  ]

  if ((contact.motivation_score ?? 0) > 80)           return "motivated"
  if (contact.tags?.includes("investor"))              return "investor"
  if (contact.communication_preference === "detailed") return "analytical"

  const stored = contact.contact_persona as SellerPersona
  if (stored && valid.includes(stored))                return stored

  return null
}
