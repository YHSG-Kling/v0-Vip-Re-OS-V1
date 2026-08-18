// lib/integrations/providers/catalog.ts
// SINGLE SOURCE OF TRUTH for transaction / e-sign providers.
//
// Every provider the app knows about is declared here exactly once, with whether
// it is IMPLEMENTED (has a working ITransactionProvider class in provider-resolver)
// and its capabilities. The settings UI, the resolvers, the factory, the embed
// layer and the forms flow all derive from this catalog so the supported-provider
// lists can never drift apart (the bug class this fixes: DocuSign/Authentisign
// were implemented but excluded from transaction resolution, while Brokermint/
// FormSimplicity were offered/listed but had no class and crashed the factory).
//
// Adding a provider = add one entry here + (when ready) one ITransactionProvider
// class registered in provider-resolver.ts, then flip implemented:true.

export type ProviderName =
  | "dotloop"
  | "docusign"
  | "skyslope"
  | "authentisign"
  | "brokermint"
  | "formsimplicity"

export interface ProviderCapabilities {
  /** Can send documents for e-signature through this provider. */
  esign: boolean
  /** Hosts a transaction-form library / transaction management. */
  transactionForms: boolean
  /** Supports rendering its UI inside an app iframe (most do NOT — CSP/X-Frame). */
  embed: boolean
}

export interface ProviderCatalogEntry {
  name: ProviderName
  label: string
  /** True only when a working ITransactionProvider class is registered. */
  implemented: boolean
  capabilities: ProviderCapabilities
}

export const PROVIDER_CATALOG: Record<ProviderName, ProviderCatalogEntry> = {
  dotloop:        { name: "dotloop",        label: "Dotloop",         implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: true  } },
  docusign:       { name: "docusign",       label: "DocuSign",        implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: false } },
  skyslope:       { name: "skyslope",       label: "SkySlope",        implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: true  } },
  authentisign:   { name: "authentisign",   label: "Authentisign",    implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: false } },
  // Brokermint = transaction/back-office management, no native e-sign (pair an
  // eSign provider for signing). Form Simplicity = state-association form library
  // plus e-sign via its Authentisign integration.
  brokermint:     { name: "brokermint",     label: "Brokermint",      implemented: true,  capabilities: { esign: false, transactionForms: true,  embed: true  } },
  formsimplicity: { name: "formsimplicity", label: "Form Simplicity", implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: true  } },
}

export function isKnownProvider(name?: string | null): name is ProviderName {
  return !!name && name.toLowerCase() in PROVIDER_CATALOG
}

export function getCatalogEntry(name?: string | null): ProviderCatalogEntry | null {
  if (!name) return null
  return PROVIDER_CATALOG[name.toLowerCase() as ProviderName] ?? null
}

/** Each provider's own portal (their forms library / transaction workspace).
 *  Consumed by the Forms Library's provider window: rendered IN-APP as an
 *  iframe when capabilities.embed=true (the vendor permits framing), opened
 *  in a new tab when false (X-Frame/CSP blocks framing — an iframe would just
 *  render blank, so we never pretend). The agent's own provider session does
 *  the auth; we never proxy their credentials. */
export const PROVIDER_PORTAL_URLS: Record<ProviderName, string> = {
  dotloop:        "https://www.dotloop.com/my/loops",
  docusign:       "https://app.docusign.com",
  skyslope:       "https://app.skyslope.com",
  authentisign:   "https://www.authentisign.com",
  brokermint:     "https://my.brokermint.com",
  formsimplicity: "https://www.formsimplicity.com",
}

/** PURE: how the Forms Library surfaces a provider's portal window. */
export function providerPortalMode(name?: string | null): { url: string; label: string; mode: "iframe" | "new_tab" } | null {
  if (!isKnownProvider(name)) return null
  const key = name.toLowerCase() as ProviderName
  const entry = PROVIDER_CATALOG[key]
  return {
    url: PROVIDER_PORTAL_URLS[key],
    label: entry.label,
    mode: entry.capabilities.embed ? "iframe" : "new_tab",
  }
}

// TOMBSTONE (orphan tranche 4): isProviderImplemented deleted. The survivor is
// getCatalogEntry above — `getCatalogEntry(name)?.implemented === true` is the
// whole body it held — plus getImplementedProviders below for the set form.

/** All providers that have a working class (instantiable, dispatchable). */
export function getImplementedProviders(): ProviderCatalogEntry[] {
  return Object.values(PROVIDER_CATALOG).filter((p) => p.implemented)
}

/** Implemented providers that host a transaction-form library. */
export function getTransactionFormProviders(): ProviderName[] {
  return getImplementedProviders()
    .filter((p) => p.capabilities.transactionForms)
    .map((p) => p.name)
}

/** Implemented providers that can e-sign. */
export function getEsignProviders(): ProviderName[] {
  return getImplementedProviders()
    .filter((p) => p.capabilities.esign)
    .map((p) => p.name)
}
