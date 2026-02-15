import { getBrokerageSettings } from "./get-brokerage-settings"

/**
 * Get required transaction provider
 * THROWS if not configured - no Dotloop fallback
 */
export async function getRequiredTransactionProvider(brokerageId: string): Promise<string> {
  const settings = await getBrokerageSettings(brokerageId)

  if (!settings.transaction_provider) {
    throw new Error(`Brokerage ${brokerageId} must configure transaction_provider in settings`)
  }

  return settings.transaction_provider
}

/**
 * Get accounting provider (can be null - optional feature)
 */
export async function getAccountingProvider(brokerageId: string): Promise<string | null> {
  const settings = await getBrokerageSettings(brokerageId)
  return settings.accounting_provider || null
}

/**
 * Get closing entity type
 * THROWS if not configured
 */
export async function getClosingEntityType(brokerageId: string): Promise<'attorney' | 'title_company' | 'escrow_company'> {
  const { closing_settings } = await getBrokerageSettings(brokerageId)

  if (!closing_settings?.closing_entity_type) {
    throw new Error(`Brokerage ${brokerageId} must configure closing_entity_type in settings`)
  }

  return closing_settings.closing_entity_type as 'attorney' | 'title_company' | 'escrow_company'
}
