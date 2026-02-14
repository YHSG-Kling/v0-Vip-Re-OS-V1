/**
 * Brokerage Authority Settings
 * 
 * Determines which functions are handled internally vs externally.
 * 
 * Example brokerage.settings JSONB:
 * {
 *   "transaction_provider": "dotloop",
 *   "transaction_mode": "hybrid",
 *   "compliance_authority": "internal",
 *   "commission_authority": "internal",
 *   "accounting_authority": "internal"
 * }
 * 
 * NO schema changes - reads from existing brokerages.settings JSONB
 */

export interface BrokerageAuthoritySettings {
  transactionProvider: string
  transactionMode: "hybrid" | "external" | "internal"
  complianceAuthority: "internal" | "external"
  commissionAuthority: "internal" | "external"
  accountingAuthority: "internal" | "external"
}

const DEFAULT_SETTINGS: BrokerageAuthoritySettings = {
  transactionProvider: "dotloop",
  transactionMode: "hybrid",
  complianceAuthority: "internal",
  commissionAuthority: "internal",
  accountingAuthority: "internal",
}

/**
 * Get brokerage authority settings from settings JSONB
 * 
 * @param brokerageSettings - The brokerages.settings JSONB field
 */
export function getBrokerageAuthoritySettings(brokerageSettings?: any): BrokerageAuthoritySettings {
  if (!brokerageSettings || typeof brokerageSettings !== "object") {
    return DEFAULT_SETTINGS
  }

  return {
    transactionProvider: brokerageSettings.transaction_provider || DEFAULT_SETTINGS.transactionProvider,
    transactionMode: brokerageSettings.transaction_mode || DEFAULT_SETTINGS.transactionMode,
    complianceAuthority: brokerageSettings.compliance_authority || DEFAULT_SETTINGS.complianceAuthority,
    commissionAuthority: brokerageSettings.commission_authority || DEFAULT_SETTINGS.commissionAuthority,
    accountingAuthority: brokerageSettings.accounting_authority || DEFAULT_SETTINGS.accountingAuthority,
  }
}

/**
 * Check if compliance should run internally
 */
export function shouldRunInternalCompliance(settings: BrokerageAuthoritySettings): boolean {
  return settings.complianceAuthority === "internal"
}

/**
 * Check if commission calculation should run internally
 */
export function shouldRunInternalCommission(settings: BrokerageAuthoritySettings): boolean {
  return settings.commissionAuthority === "internal"
}

/**
 * Check if accounting should run internally
 */
export function shouldRunInternalAccounting(settings: BrokerageAuthoritySettings): boolean {
  return settings.accountingAuthority === "internal"
}

/**
 * Check if fully external (all functions delegated to provider)
 */
export function isFullyExternal(settings: BrokerageAuthoritySettings): boolean {
  return (
    settings.transactionMode === "external" &&
    settings.complianceAuthority === "external" &&
    settings.commissionAuthority === "external" &&
    settings.accountingAuthority === "external"
  )
}

/**
 * Check if hybrid mode (provider handles forms/signatures, system handles business logic)
 */
export function isHybridMode(settings: BrokerageAuthoritySettings): boolean {
  return settings.transactionMode === "hybrid"
}

/**
 * Get provider name from settings
 */
export function getProviderName(settings: BrokerageAuthoritySettings): string {
  return settings.transactionProvider
}
