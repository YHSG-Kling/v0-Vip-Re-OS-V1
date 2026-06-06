// lib/social/assemble-disclosures.ts
// Resolves the legally-required real-estate advertising disclosures for a social
// post / ad from the settings cascade (author agent → brokerage) and appends
// them to outbound content. Analogous to assembleEmail's footer for email.
//
// Disclosures included (most US state advertising rules + Fair Housing):
//   - Brokerage name (state license law requires brokerage identification in ads)
//   - Broker/agent license number + state (agent's own, else brokerage's)
//   - "Equal Housing Opportunity" (Fair Housing Act)
//
// Sourced from: agents.license_number/license_state (by author user_id) with a
// brokerages.license_number/license_state fallback, and brokerages.name.

import type { SupabaseClient } from "@supabase/supabase-js"

export async function assembleSocialDisclosures(
  supabase: SupabaseClient,
  params: { brokerageId: string | null; userId?: string | null },
): Promise<string> {
  if (!params.brokerageId) return ""

  const [brokerageRes, agentRes] = await Promise.all([
    supabase
      .from("brokerages")
      .select("name, license_number, license_state")
      .eq("id", params.brokerageId)
      .maybeSingle(),
    params.userId
      ? supabase
          .from("agents")
          .select("license_number, license_state")
          .eq("user_id", params.userId)
          .eq("brokerage_id", params.brokerageId)
          .maybeSingle()
      : Promise.resolve({ data: null as any }),
  ])

  const brokerage = brokerageRes.data
  const agent = (agentRes as { data: { license_number?: string | null; license_state?: string | null } | null }).data

  const license = agent?.license_number ?? brokerage?.license_number ?? null
  const licenseState = agent?.license_state ?? brokerage?.license_state ?? null

  const parts: string[] = []
  if (brokerage?.name) parts.push(brokerage.name)
  if (license) parts.push(`Lic# ${license}${licenseState ? ` (${licenseState})` : ""}`)
  parts.push("Equal Housing Opportunity")

  return parts.join(" · ")
}

/**
 * Append disclosures to content. Idempotent: if the content already carries an
 * Equal Housing Opportunity disclosure, it is left unchanged.
 */
export function appendDisclosures(content: string, disclosures: string): string {
  if (!disclosures) return content
  if (/equal housing/i.test(content)) return content
  return `${content.trimEnd()}\n\n${disclosures}`
}
