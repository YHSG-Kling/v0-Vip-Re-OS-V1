import { createClient } from "@/lib/supabase/server"
import { getTransactionProvider, type TransactionProvider } from "@/lib/brokerage/get-brokerage-settings"
import { getTransactionFormProviders } from "@/lib/integrations/providers/catalog"

export interface ResolvedTransactionProvider {
  provider: TransactionProvider
  credentialsId?: string
}

// Derived from the provider catalog: only IMPLEMENTED transaction-form providers
// are resolvable (previously a hardcoded list that excluded docusign/authentisign
// and included unimplemented formsimplicity/brokermint, which crash the factory).
const TRANSACTION_PLATFORMS = getTransactionFormProviders()

/**
 * Resolves the transaction provider for a given agent with fallback:
 *   1. Agent-scoped platform_credentials (scope='agent', agent_user_id)
 *   2. Brokerage-scoped platform_credentials (scope='brokerage', brokerage_id)
 *   3. global_settings.additional_settings.transaction_provider
 *
 * NOTE: platform_credentials is keyed by agent_user_id / brokerage_id + scope —
 * there is no `owner_id` column (the prior query used one, so it always errored
 * and silently fell through to the global_settings fallback) and no team scope.
 */
export async function resolveTransactionProvider(params: {
  agentUserId: string
  teamId?: string | null
  brokerageId: string
}): Promise<ResolvedTransactionProvider | null> {
  const { agentUserId, brokerageId } = params
  const supabase = await createClient()

  const { data: agentCreds } = await supabase
    .from("platform_credentials")
    .select("id, platform")
    .in("platform", TRANSACTION_PLATFORMS)
    .eq("scope", "agent")
    .eq("agent_user_id", agentUserId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle()

  if (agentCreds) {
    return { provider: agentCreds.platform as TransactionProvider, credentialsId: agentCreds.id }
  }

  const { data: brokerageCreds } = await supabase
    .from("platform_credentials")
    .select("id, platform")
    .in("platform", TRANSACTION_PLATFORMS)
    .eq("scope", "brokerage")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle()

  if (brokerageCreds) {
    return { provider: brokerageCreds.platform as TransactionProvider, credentialsId: brokerageCreds.id }
  }

  // Final fallback: global_settings.additional_settings.transaction_provider.
  // Returns null (not a silent dotloop default) when nothing is configured.
  try {
    const provider = await getTransactionProvider(brokerageId)
    return provider ? { provider } : null
  } catch {
    return null
  }
}
