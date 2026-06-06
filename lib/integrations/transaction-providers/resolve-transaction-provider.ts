import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
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
 * Resolves the transaction provider for an actor through the unified ownership cascade
 * (resolveScopedConnection: agent → team → brokerage → platform, with the legacy
 * connection-manager fallback), then the brokerage's global_settings default.
 *
 * This replaces the old per-column read (agent_user_id / brokerage_id only) — so an
 * owner-scoped connection from the Connection Center, including TEAM scope, now resolves.
 */
export async function resolveTransactionProvider(params: {
  agentUserId: string
  teamId?: string | null
  brokerageId: string
}): Promise<ResolvedTransactionProvider | null> {
  const { agentUserId, teamId, brokerageId } = params

  for (const platform of TRANSACTION_PLATFORMS) {
    const conn = await resolveScopedConnection(platform, { agentUserId, teamId: teamId ?? null, brokerageId })
    if (conn) {
      return { provider: conn.provider as TransactionProvider, credentialsId: conn.credentialId }
    }
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
