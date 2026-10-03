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
  | "google_esign"
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
  /** The provider's API issues a one-time SENDER VIEW url for a draft envelope that is
   *  documented as frameable — the agent reviews tabs/recipients and presses Send inside
   *  OUR window. Only DocuSign documents this (EnvelopeViews:createSender with
   *  viewAccess "envelope" — "iFrames are supported", DocuSign developer blog 2024-05). */
  embeddedSend?: boolean
}

export interface ProviderCatalogEntry {
  name: ProviderName
  label: string
  /** True only when a working ITransactionProvider class is registered. */
  implemented: boolean
  /** Lane 88B — the provider sends from ITS OWN UI and exposes no send API: our flow fills and
   *  stages the document, then hands the agent the provider's window (PROVIDER_PORTAL_URLS). There
   *  is no credential to connect and no class to register; it is selectable without either. */
  portalSend?: boolean
  capabilities: ProviderCapabilities
}

// EMBED EVIDENCE (lane 88C, 2026-09-28 — Exa research; direct header probes were refused
// by this sandbox's egress policy, so a provider with NO published embed surface is
// treated as NOT frameable: fail closed to a popup, never a blank iframe).
//   · SkySlope   — the SkySlope Forms Widget "injects an iframe into the DOM of the host
//                  application, which loads the SkySlope Forms application"
//                  (github.com/skyslope-2/skyslope-forms-widget) → forms.skyslope.com frames.
//   · DocuSign   — the web app does not frame; the API's SENDER VIEW and RECIPIENT VIEW do
//                  (embeddedSend below).
//   · Dotloop    — Public API v2 Loop-It returns a `loopUrl` "used to redirect the user to
//                  the loop on dotloop.com" (dotloop.github.io/public-api) — no embed surface.
//                  The previous `embed: true` + a dotloop loops URL with an embed flag was not
//                  a real endpoint, so the wizard's iframe rendered blank.
//   · Brokermint, Form Simplicity, Authentisign — no published embed surface → popup.
//   · Google eSignature — no API, drive.google.com does not frame → popup; lane 88C places
//     the FILLED packet in the agent's Drive first (lib/esign/google-esign-handoff.ts).
//   · Lone Wolf TransactionDesk / zipForm — not integrated (no provider class); TD's API
//     issues a one-time SSO `view-url` (apidocs.lwolf.com) — a popup, if/when integrated.
export const PROVIDER_CATALOG: Record<ProviderName, ProviderCatalogEntry> = {
  // Google Workspace eSignature — SELECTABLE, no longer the default (owner, wave 89 verbatim: "the
  // platforms defualt esign is no longer google but we decided on docusign instead since it will
  // embed in our platform window."). Docs/Drive → Tools → eSignature → Request signature is UI-only —
  // Google publishes no API to create a signature request (support.google.com/docs/answer/12315692)
  // and Google frames nothing (X-Frame) — so it is a portalSend provider opened in a popup, on the
  // agent's own Google account (lane 88C's Drive placement of the filled packet is kept).
  google_esign:   { name: "google_esign",   label: "Google eSignature", implemented: false, portalSend: true, capabilities: { esign: true,  transactionForms: false, embed: false } },
  dotloop:        { name: "dotloop",        label: "Dotloop",         implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: false } },
  // THE DEFAULT E-SIGN PROVIDER (wave 89): DocuSign's embedded SENDER VIEW frames inside our window
  // (EnvelopeViews:createSender, viewAccess "envelope" — "iFrames are supported", DocuSign developer
  // blog 2024-05), so the contact pick, signature-field placement and Send all happen in the platform.
  // With no tenant credential the PLATFORM's own DocuSign account carries the envelope
  // (lib/esign/docusign-platform-account.ts, JWT grant); a tenant's own DocuSign/Dotloop/SkySlope/
  // Authentisign connection or explicit selection ALWAYS wins over this default.
  docusign:       { name: "docusign",       label: "DocuSign",        implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: false, embeddedSend: true } },
  skyslope:       { name: "skyslope",       label: "SkySlope",        implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: true  } },
  authentisign:   { name: "authentisign",   label: "Authentisign",    implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: false } },
  // Brokermint = transaction/back-office management, no native e-sign (pair an
  // eSign provider for signing). Form Simplicity = state-association form library
  // plus e-sign via its Authentisign integration.
  brokermint:     { name: "brokermint",     label: "Brokermint",      implemented: true,  capabilities: { esign: false, transactionForms: true,  embed: false } },
  formsimplicity: { name: "formsimplicity", label: "Form Simplicity", implemented: true,  capabilities: { esign: true,  transactionForms: true,  embed: false } },
}

// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function isKnownProvider(name?: string | null): name is ProviderName {
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
  google_esign:   "https://drive.google.com/drive/my-drive",
  dotloop:        "https://www.dotloop.com/my/loops",
  docusign:       "https://app.docusign.com",
  // forms.skyslope.com is the documented frameable Forms app (the widget's iframe src).
  skyslope:       "https://forms.skyslope.com",
  authentisign:   "https://www.authentisign.com",
  brokermint:     "https://my.brokermint.com",
  formsimplicity: "https://www.formsimplicity.com",
}

/** PURE: how the Forms Library AND the FormWizard's Fill step surface a provider's portal
 *  window. The ONE embed resolver — lib/integrations/transaction-providers/embed-url.ts was
 *  a second spelling of the same idea (different URLs, frameability ignored) and is deleted
 *  onto this function (tombstone in app/api/form-wizard/resolve-provider/route.ts). */
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

/**
 * THE DEFAULT E-SIGN PROVIDER — ONE constant, read by every unconfigured door: lib/kernel/providers.ts
 * SYSTEM_DEFAULTS.esign, lib/integrations/resolve-esign-provider.ts (the actor resolver's fallback),
 * the send-for-esign workflow step, getEsignStatus / launchEsignEnvelope, the settings override form,
 * the forms library window and the onboarding e-sign requirement.
 *
 * Lane 88B made it Google eSignature ("google esign is default not dotloop"). Lane 89A moves it to
 * DOCUSIGN on the owner's wave-89 ruling: "the platforms defualt esign is no longer google but we
 * decided on docusign instead since it will embed in our platform window." THE RULE (not the value):
 * the user's / team's / brokerage's e-sign SELECTION (provider_overrides `esign`) wins, then THIS
 * default — never "whatever transaction-management vendor happens to be connected". Google
 * eSignature stays selectable (its Drive hand-off is kept); Dotloop & co stay selectable.
 */
export const DEFAULT_ESIGN_PROVIDER: ProviderName = "docusign"

// TOMBSTONE (lane 89A): resolveEsignProviderOrDefault deleted. It mapped "unconfigured / unknown /
// not an e-sign provider" to the default SILENTLY, and its last product reader (lib/kernel/forms.ts
// getEsignStatus) now resolves through the survivor —
// lib/integrations/resolve-esign-provider.ts:resolveESignProviderForActor (readSelection →
// `selection.pick || DEFAULT_ESIGN_PROVIDER`), which defaults ONLY when nothing is selected and
// REFUSES a selection that cannot sign by name (CLAUDE.md §4: fail closed, never "checked and fine").

/** E-sign providers a user may SELECT (settings override menu): the DEFAULT first, then every other
 *  e-sign provider — implemented (credential-connectable) or portal-send (Google eSignature). */
export function getSelectableEsignProviders(): ProviderName[] {
  return Object.values(PROVIDER_CATALOG)
    .filter((p) => p.capabilities.esign && (p.implemented || p.portalSend))
    .sort((a, b) => Number(b.name === DEFAULT_ESIGN_PROVIDER) - Number(a.name === DEFAULT_ESIGN_PROVIDER))
    .map((p) => p.name)
}
/** Implemented providers that can e-sign (credential-CONNECTABLE — a portalSend provider has no
 *  credential, so it is not here; lib/connections/scope.ts reads this as the connect allow-list). */
export function getEsignProviders(): ProviderName[] {
  return getImplementedProviders()
    .filter((p) => p.capabilities.esign)
    .map((p) => p.name)
}

/** PURE: does this provider's API issue a frameable SENDER view for a draft envelope?
 *  (Only DocuSign today — see the embed evidence above PROVIDER_CATALOG.) */
export function supportsEmbeddedSend(name?: string | null): boolean {
  return getCatalogEntry(name)?.capabilities.embeddedSend === true
}
