import type { SellerPersona } from "./coaching-generator"

/**
 * getSellerPersona
 * Pure utility — NOT a server action. Lives in lib/ so it can be imported
 * by both server actions and lib modules without "use server" constraints.
 *
 * Derivation rules (spec-ordered, highest priority first):
 *   lead_score > 80                 → 'motivated'
 *   tags includes 'investor'        → 'investor'
 *   preferred_channel = 'detailed'  → 'analytical'
 *   contact_persona (stored value)  → use if valid
 *   Default                         → null (system will treat as 'standard')
 */
export function getSellerPersona(contact: {
  contact_persona?: string | null
  lead_score?: number | null
  tags?: string[] | null
  preferred_channel?: string | null
}): SellerPersona {
  const valid: SellerPersona[] = [
    "motivated", "skeptical", "emotional", "investor", "indecisive", "analytical",
  ]

  if ((contact.lead_score ?? 0) > 80)                  return "motivated"
  if (contact.tags?.includes("investor"))              return "investor"
  if (contact.preferred_channel === "detailed")        return "analytical"

  const stored = contact.contact_persona as SellerPersona
  if (stored && valid.includes(stored))                return stored

  return null
}
