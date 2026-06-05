/**
 * lib/branding/resolve-brokerage-brand.ts
 *
 * DEPRECATED — Wave 36. This was a brokerage-only resolver. The
 * canonical resolver is now lib/branding/resolve-brand-context.ts
 * which honors the agent → team → brokerage tier cascade. Existing
 * callers that pass only brokerageId still work — they just always
 * resolve at the brokerage tier (no team / agent override). New
 * callers should import resolveBrandContext directly so they can
 * pass teamId + agentUserId for the right per-piece brand.
 *
 * Kept as a thin alias so we don't churn the 7 existing call sites
 * in one commit; they're migrated to resolveBrandContext as their
 * surrounding code is touched.
 */
import "server-only"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"

// Re-export the canonical type so callers don't have to update imports
// the moment they upgrade.
export type { BrandContext as BrokerageBrandContext } from "@/lib/branding/resolve-brand-context"

export async function resolveBrokerageBrandContext(brokerageId: string) {
  return resolveBrandContext({ brokerageId })
}
