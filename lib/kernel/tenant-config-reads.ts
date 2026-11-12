/**
 * lib/kernel/tenant-config-reads.ts — THE SESSIONLESS DOOR onto tenant configuration (lane 86C).
 * ─────────────────────────────────────────────────────────────────────────────
 * Brand voice (brand_voice_profile / teams.member_overrides_json) and provider configuration
 * (provider_overrides) were read through the COOKIE client inside their resolvers. A caller with
 * no session — the voice webhook's stage creators (lib/kernel/content-creators.ts), the crons and
 * internal render routes that reach evaluateOutbound — read as anon, and RLS answered with NO
 * ROWS rather than an error: the tenant's prohibited words were never checked, and every
 * provider "resolved" to the system default. Degraded, never refused.
 *
 * THE CONTRACT. `brokerageId` (and userId/teamId) must come from the caller's VERIFIED context —
 * a webhook's signed session row, a cron's own row — never from a request body (CLAUDE.md §4).
 * These doors bind the SERVICE client and call the SAME cores the session-gated readers call:
 *   · lib/kernel/brand-voice.ts   resolveBrandVoiceCore  (applyBrandVoice is its session door)
 *   · lib/kernel/providers.ts     resolveProviderCore    (resolveProvider is its session door)
 *   · lib/kernel/compliance.ts    evaluateOutbound(params, { client })
 * Every read in both cores is pinned to the brokerage, because the service client has no RLS.
 *
 * `import "server-only"`: this module must never reach a client bundle, and it is not a
 * "use server" file, so nothing here is a public endpoint.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { applyBrandVoice, type ApplyBrandVoiceParams, type BrandVoiceResult, type BrandVoiceReadClient } from "@/lib/kernel/brand-voice"
import { resolveProvider, type ResolveProviderParams, type ResolvedProvider, type ProviderReadClient } from "@/lib/kernel/providers"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { EvaluateOutboundParams, ComplianceResult } from "@/lib/kernel/types"
import type { SupabaseClient } from "@supabase/supabase-js"

/** Brand voice for a tenant named by a VERIFIED context, read on the service client. */
export async function applyTenantBrandVoice(
  params: ApplyBrandVoiceParams,
  client: BrandVoiceReadClient = createServiceClient(),
): Promise<BrandVoiceResult> {
  return applyBrandVoice(params, { client })
}

/** Provider cascade for a tenant named by a VERIFIED context, read on the service client. */
export async function resolveTenantProvider(
  params: ResolveProviderParams,
  client: ProviderReadClient = createServiceClient(),
): Promise<ResolvedProvider> {
  return resolveProvider(params, { client })
}

/** The outbound compliance gate for a tenant named by a VERIFIED context: Gate 1's brand voice,
 *  the contact re-read and the compliance_events audit row all land on the service client. */
export async function evaluateTenantOutbound(
  params: EvaluateOutboundParams,
  client: SupabaseClient = createServiceClient(),
): Promise<ComplianceResult> {
  return evaluateOutbound(params, { client })
}
