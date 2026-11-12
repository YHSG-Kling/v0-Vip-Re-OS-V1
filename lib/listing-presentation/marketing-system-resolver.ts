/**
 * lib/listing-presentation/marketing-system-resolver.ts
 *
 * The I/O half of the marketing-system function: read what THIS tenant and THIS
 * agent actually have, then hand the facts to the pure composer in
 * lib/listing-presentation/marketing-system.ts.
 *
 * Split from the composer deliberately. The composer is imported by
 * section-narration.ts, which runs the deterministic fallback exactly when the
 * AI (and possibly the database) is unavailable — so it must stay computable
 * with no network, the same reasoning lib/remotion/composition-geometry.ts
 * states for the narration cap. This file is the part that needs a client, and
 * only the producer (section-render.ts) imports it.
 *
 * ── EVERY READ HERE IS TENANT-SCOPED FROM THE PRESENTATION ROW ─────────────
 * `brokerageId` is resolved by the caller from `listing_presentations` — never
 * from a request body or a parameter a client could set (§4). This module takes
 * it as an argument because its only caller is a cron-driven producer that has
 * already read the row.
 */
import type { createServiceClient } from "@/lib/supabase/service"
import { resolveTenantCapabilities } from "@/lib/entitlements/tenant-capabilities"
import { resolveAgentNarrationAssets } from "@/lib/listing-presentation/section-narration-orchestrator"
import {
  composeMarketingSystem,
  marketingSystemFeatureKeys,
  type ComposedMarketingSystem,
} from "@/lib/listing-presentation/marketing-system"
import type { NarrationBudget } from "@/lib/video/script-structure"

/**
 * Resolve the marketing-system claim for one presentation.
 *
 * NEVER THROWS and never returns empty text: on any failure the composer's
 * FLOOR sentence is used, which claims no capability at all. An advertising
 * path must degrade to saying less, never to saying more.
 */
export async function resolveMarketingSystem(
  supabase: ReturnType<typeof createServiceClient>,
  opts: {
    brokerageId: string
    agentUserId: string | null
    /** The composition the narration will be spoken over — the claim list is
     *  packed to fit it. Passed in (never re-derived) so this agrees with the
     *  budget generateSectionNarration will actually enforce. */
    budget: NarrationBudget
  },
): Promise<ComposedMarketingSystem> {
  const emptyFacts = {
    capabilities:      new Set<string>(),
    hasVoiceClone:     false,
    hasAvatarSource:   false,
    directMailEnabled: false,
    budget:            opts.budget,
  }

  try {
    const [caps, assets, brokerageRow] = await Promise.all([
      resolveTenantCapabilities(supabase, opts.brokerageId, marketingSystemFeatureKeys()),
      resolveAgentNarrationAssets(supabase, opts.agentUserId),
      // The tenant's OWN outbound-mail switch. §3 — the error is destructured
      // and read; an unreadable row means the claim is withheld, not assumed.
      supabase.from("brokerages").select("farm_mail_enabled").eq("id", opts.brokerageId).maybeSingle(),
    ])

    if (!caps.ok) {
      // "We could not read what this tenant has" is NOT "they have nothing" —
      // but on this path both must produce the same OUTPUT, because the only
      // safe thing to say when nobody checked is nothing specific (§4).
      console.warn(`[marketing-system] entitlements unreadable for brokerage ${opts.brokerageId} — falling to the floor claim: ${caps.reason}`)
      return composeMarketingSystem(emptyFacts)
    }
    if (brokerageRow.error) {
      console.warn(`[marketing-system] brokerage read refused for ${opts.brokerageId}: ${brokerageRow.error.message}`)
    }

    const composed = composeMarketingSystem({
      capabilities:      caps.allowed,
      hasVoiceClone:     !!assets.voiceId,
      hasAvatarSource:   !!assets.avatarSource,
      directMailEnabled: !!(brokerageRow.data as { farm_mail_enabled?: boolean | null } | null)?.farm_mail_enabled,
      budget:            opts.budget,
    })

    // §2 — publish the blind spot beside the number. A claim the tenant HAS but
    // the composition had no room for is a geometry finding, not a silent drop.
    if (composed.droppedForBudget.length > 0) {
      console.warn(
        `[marketing-system] ${opts.brokerageId}: ${composed.droppedForBudget.length} entitled claim(s) did not fit `
        + `${composed.offered.length ? "alongside the offered ones " : ""}in the ${opts.budget.maxWords}-word budget on `
        + `${opts.budget.compositionId} (${opts.budget.compositionSeconds}s) — withheld from the prompt rather than trimmed `
        + `mid-claim: ${composed.droppedForBudget.join(", ")}`,
      )
    }
    if (composed.droppedForCompliance.length > 0) {
      console.warn(`[marketing-system] ${opts.brokerageId}: fair-housing screen dropped claim(s) before the prompt: ${composed.droppedForCompliance.join(", ")}`)
    }
    return composed
  } catch (err) {
    console.warn(`[marketing-system] resolve failed for brokerage ${opts.brokerageId} — floor claim used:`, err)
    return composeMarketingSystem(emptyFacts)
  }
}
