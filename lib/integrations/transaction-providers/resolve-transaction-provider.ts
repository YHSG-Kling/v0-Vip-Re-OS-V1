import { createClient } from "@/lib/supabase/server"
import { getTransactionProvider, type TransactionProvider } from "@/lib/brokerage/get-brokerage-settings"

export interface ResolvedTransactionProvider {
  provider: TransactionProvider
  credentialsId?: string
}

const TRANSACTION_PLATFORMS = ["dotloop", "skyslope", "formsimplicity", "brokermint"] as const

/**
 * Resolves the transaction provider for a given agent with fallback:
 *   1. Agent-scoped platform_credentials
 *   2. Team-scoped platform_credentials (if teamId provided)
 *   3. Brokerage-scoped platform_credentials
 *   4. global_settings.additional_settings.transaction_provider (existing brokerage setting)
 */
export async function resolveTransactionProvider(params: {
  agentUserId: string
  teamId?: string | null
  brokerageId: string
}): Promise<ResolvedTransactionProvider | null> {
  const { agentUserId, teamId, brokerageId } = params
  const supabase = await createClient()

  const { data: agentCreds } = await supabase
    .from("platform_credentials")
    .select("id, platform")
    .in("platform", TRANSACTION_PLATFORMS)
    .eq("scope", "agent")
    .eq("owner_id", agentUserId)
    .limit(1)
    .maybeSingle()

  if (agentCreds) {
    return { provider: agentCreds.platform as TransactionProvider, credentialsId: agentCreds.id }
  }

  if (teamId) {
    const { data: teamCreds } = await supabase
      .from("platform_credentials")
      .select("id, platform")
      .in("platform", TRANSACTION_PLATFORMS)
      .eq("scope", "team")
      .eq("owner_id", teamId)
      .limit(1)
      .maybeSingle()

    if (teamCreds) {
      return { provider: teamCreds.platform as TransactionProvider, credentialsId: teamCreds.id }
    }
  }

  const { data: brokerageCreds } = await supabase
    .from("platform_credentials")
    .select("id, platform")
    .in("platform", TRANSACTION_PLATFORMS)
    .eq("scope", "brokerage")
    .eq("owner_id", brokerageId)
    .limit(1)
    .maybeSingle()

  if (brokerageCreds) {
    return { provider: brokerageCreds.platform as TransactionProvider, credentialsId: brokerageCreds.id }
  }

  // Final fallback: global_settings.additional_settings.transaction_provider
  try {
    const provider = await getTransactionProvider(brokerageId)
    return { provider }
  } catch {
    return null
  }
}
