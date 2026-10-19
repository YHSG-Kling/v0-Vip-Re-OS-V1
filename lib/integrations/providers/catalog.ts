// lib/integrations/providers/catalog.ts
// SINGLE SOURCE OF TRUTH for LEGAL-FORMS / e-sign providers.
//
// VOCABULARY (owner, 2026-10-18, wave 142): "the 'transaction provider' is the real-estate LEGAL-FORMS
// provider — call it the legal-forms provider so it is never confused with the transaction/contract
// lifecycle (Listing → Offer → Signatures → Compliance → Fully Executed Contract → Transaction → Closing)".
// The UI copy, labels and this header say LEGAL-FORMS PROVIDER (LEGAL_FORMS_PROVIDER_LABEL below). The CODE
// identifiers keep their spelling on purpose — `capabilities.transactionForms`, the `transaction` capability
// key, `provider_overrides.provider_type = 'transaction'`, `offers.form_source`, resolveTransactionFormsProvider
// — because the first three are stored DB vocabularies (a rename is a migration, listed in the lane notes),
// and the function names are read by proofs in every lane; a second identifier spelling beside them would
// be the §6 defect the ruling is correcting.
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

/** THE ONE tenant-facing name of the forms capability (owner, wave 142): never "transaction provider". */
export const LEGAL_FORMS_PROVIDER_LABEL = "legal-forms provider"

export interface ProviderCapabilities {
  /** Can send documents for e-signature through this provider. */
  esign: boolean
  /** Hosts a LEGAL-FORMS library / transaction management (the tenant-facing name is LEGAL_FORMS_PROVIDER_LABEL;
   *  the key keeps its spelling — see the header). */
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE FACTUAL CAPABILITY MATRIX (wave 141, lane 141C; owner verbatim: "TRANSACTION vs E-SIGN
// are DIFFERENT capabilities; a provider may support forms-only, e-sign-only, or both … every
// provider HEAD claims must actually function (credentials → settings → forms → transaction
// creation → upload → fill → e-sign if supported → status → sync) or it is not offered").
//
// This EXTENDS the capability flags above (the one registry) — it is not a second catalog.
// `capabilities` says what a provider CLAIMS; the matrix says what the CODE PATH behind each
// claim is, cell by cell, with the file:line that proves it and, where the cell is not BUILT,
// the honest reason. Every verdict below is DERIVED from these cells by one rule
// (providerOfferVerdict) — nothing hand-sets "available".
//
//   BUILT    the path exists, is wired to a product surface with the TENANT's credential, and
//            the vendor contract it speaks is documented (VENDOR_CONTRACTS / the adapter's docs
//            root / a cited vendor page). "Manual by vendor design" (Google eSignature's
//            signed-copy filing) is BUILT when it is the designed path, not a gap.
//   PARTIAL  the path exists but its request/response shape is NOT the documented one, or the
//            documented auth lifecycle (OAuth exchange / refresh) is not performed, or the
//            vendor publishes no contract for it — it may or may not work live; unproven.
//   UNWIRED  code exists but nothing reaches it with a tenant credential.
//   MISSING  no code (or the vendor has no such capability — stated).
//
// EVIDENCE READ 2026-10-14: dotloop.github.io/public-api (v2 guide: §1.2 OAuth2 3-legged, 12-hour
// access tokens + refresh; §5.3 POST /profile/:id/loop { name, status, transactionType } → data.id;
// §7.1/§8.1 folders + documents { id, filename, created, updated } — no signature state; §8.3
// multipart/form-data `file` upload to /folder/:folder_id/document/; §9.3 participant { fullName,
// email, role }; §13.1 /profile/:id/loop-template; NO send-for-signature call is published);
// apidocs.lwolf.com/doc/authentisign-api getting-started (Bearer token, base https://api.lwolf.com —
// only the host is published there); DocuSign eSignature REST v2.1 (the adapter's docs root);
// VENDOR_CONTRACTS (lib/agentic-os/connector-registry.ts) for SkySlope / Brokermint / Form
// Simplicity (wave 140I). Line numbers are of the named files at HEAD of this lane.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** @proofSeam the steps the proof walks (scripts/transaction-provider-matrix-guard.ts §A); the product reads the matrix through providerOfferVerdict. */
export const MATRIX_STEPS = [
  "credentials", "settings", "forms", "transaction_creation", "document_upload", "form_fill", "esign", "status", "sync",
] as const
type MatrixStep = (typeof MATRIX_STEPS)[number]
type CapabilityCellStatus = "BUILT" | "PARTIAL" | "UNWIRED" | "MISSING"
interface ProviderMatrixCell {
  status: CapabilityCellStatus
  /** file:line (or the vendor page) that proves the status. */
  evidence: string
  /** Why the cell is not BUILT — the sentence the tenant reads when the provider is unavailable. */
  reason?: string
}
type ProviderMatrixRow = Record<MatrixStep, ProviderMatrixCell>

const B = (evidence: string): ProviderMatrixCell => ({ status: "BUILT", evidence })
const P = (evidence: string, reason: string): ProviderMatrixCell => ({ status: "PARTIAL", evidence, reason })
const M = (evidence: string, reason: string): ProviderMatrixCell => ({ status: "MISSING", evidence, reason })

/** The in-platform fill is provider-agnostic (every library PDF's AcroForm fields, lib/forms/pdf-form-fill.ts);
 *  the provider-WINDOW fill is an iframe only where the vendor documents framing (capabilities.embed). */
const IN_APP_FILL = "lib/forms/pdf-form-fill.ts:64 fillPdfForm + app/actions/buyer-offer/prefill-storage-form.ts:59; provider window per providerPortalMode"
const SETTINGS = "provider_overrides esign/transaction (lib/integrations/resolve-esign-provider.ts:145 readSelection; lib/integrations/providers/provider-resolver.ts getTransactionProvider; app/dashboard/settings/integrations/integrations-client.tsx PROVIDER_KEYS_BY_TYPE)"
const TENANT_CRED = "platform_credentials owner-scoped (lib/connections/resolve-scoped.ts:190 agent → team → brokerage; written by app/actions/settings/integrations.ts:254 upsertPlatformCredential at brokerage scope)"

/** @proofSeam the proof asserts the cells directly (§A); every product reader goes through providerOfferVerdict / esignCertified below. */
export const PROVIDER_CAPABILITY_MATRIX: Record<ProviderName, ProviderMatrixRow> = {
  docusign: {
    credentials:          B(`${TENANT_CRED}; tenant OAuth app/api/integrations/oauth/[provider]/route.ts:77; the DEFAULT with nothing connected rides the platform's JWT account lib/esign/docusign-platform-account.ts (minted per use, default only). BLIND SPOT, published: a tenant's OWN DocuSign OAuth access token has no refresher (lib/social/token-refresh.ts covers social only) — after it lapses the tenant reconnects`),
    settings:             B(SETTINGS),
    forms:                B("lib/integrations/providers/docusign-provider.ts:311 listForms (GET /templates, documented) via app/api/forms/provider-library/route.ts:57"),
    transaction_creation: B("lib/integrations/providers/docusign-provider.ts:80 createTransaction (POST /envelopes status created — eSignature REST v2.1)"),
    document_upload:      B("lib/integrations/providers/docusign-provider.ts:104 attachForms / :282 uploadDocument (PUT /envelopes/{id}/documents, base64 — documented)"),
    form_fill:            B(`${IN_APP_FILL}; embedded SENDER view places the tabs (docusign-provider.ts:196 prepareEmbeddedSend)`),
    esign:                B("lib/integrations/providers/docusign-provider.ts:220 sendForSignature / :196 prepareEmbeddedSend through lib/esign/dispatch-packet.ts:279-299 (the ONE dispatch core)"),
    status:               B("lib/integrations/providers/docusign-provider.ts:243 getSignatureStatus + webhook app/api/webhooks/docusign/route.ts"),
    sync:                 B("lib/integrations/providers/docusign-provider.ts:357 syncDocuments via lib/transactions/sync-from-provider.ts:125 (tenant credential resolved in provider-resolver.ts getTransactionProvider — wired this lane)"),
  },
  google_esign: {
    credentials:          B("no vendor credential by design (portal send): the agent's own Google connection + drive.file grant — lib/esign/google-esign-handoff.ts googleEsignReadiness; the manual Drive rail without it"),
    settings:             B(SETTINGS),
    forms:                M("PROVIDER_CATALOG.google_esign transactionForms:false", "not a legal-forms provider — the platform library serves the forms"),
    transaction_creation: M("PROVIDER_CATALOG.google_esign transactionForms:false", "not a legal-forms provider"),
    document_upload:      B("lib/esign/dispatch-packet.ts:186-205 places the FILLED packet in the agent's Drive (lib/esign/google-drive-upload.ts buildDriveMultipartBody)"),
    form_fill:            B(IN_APP_FILL),
    esign:                B("lib/esign/dispatch-packet.ts:180-231 — the Drive hand-off (Google publishes no eSignature API: support.google.com/docs/answer/12315692); the agent requests the signature in the Drive window"),
    status:               B("manual by vendor design (no API, no webhook): the signed copy is filed through the upload door — lib/esign/google-esign-completion.ts; the record reads awaiting_agent_send until then"),
    sync:                 M("no Google eSignature API", "nothing to pull — the executed PDF is filed by the agent (status cell)"),
  },
  dotloop: {
    credentials:          P(`${TENANT_CRED}; the shared DOTLOOP_API_KEY env fallback is REMOVED this lane (lib/integrations/providers/dotloop-provider.ts getCredentials, lib/providers/esign/index.ts)`, "Dotloop's documented auth is OAuth2 3-legged with 12-hour access tokens + refresh (v2 guide §1.2); the platform has no Dotloop OAuth route (app/api/integrations/oauth/[provider]/route.ts OAuthProvider), so a pasted token lapses in 12 hours and nothing refreshes it"),
    settings:             B(SETTINGS),
    forms:                P("lib/integrations/providers/dotloop-provider.ts:304 listForms → /profile/{id}/form", "the v2 guide publishes no /form endpoint; the documented library is loop templates (§13.1 /profile/:id/loop-template)"),
    transaction_creation: P("lib/integrations/providers/dotloop-provider.ts:74 createTransaction", "posts { status:'Active', transaction_type:'Purchase', street_address } and reads data.loop_id; §5.3 documents { name, status, transactionType } with the PURCHASE_OFFER / LISTING_FOR_SALE and PRE_OFFER / PRE_LISTING constants and returns data.id"),
    document_upload:      P("lib/integrations/providers/dotloop-provider.ts:103 attachForms / :233 uploadDocument", "posts JSON { name, file_url } to /folder/<folder NAME>/document; §8.3 documents a multipart/form-data `file` upload to /folder/:folder_id/document/ (a folder ID)"),
    form_fill:            B(`${IN_APP_FILL}; Dotloop publishes no embed surface → popup`),
    esign:                P("lib/integrations/providers/dotloop-provider.ts:131 sendForSignature", "adds participants ({ full_name } where §9.3 documents { fullName }) and returns success; the v2 guide publishes NO send-for-signature call — the signature request is made inside Dotloop"),
    status:               P("lib/integrations/providers/dotloop-provider.ts:163 getSignatureStatus; webhook app/api/webhooks/dotloop/route.ts (HMAC-verified)", "reads doc.is_signed off /folder; §7.1/§8.1 document { id, filename, created, updated } with no signature state"),
    sync:                 P("lib/integrations/providers/dotloop-provider.ts:258 syncDocuments via sync-from-provider.ts (tenant credential wired this lane)", "reads undocumented document_id / is_signed / url keys (§8.1 documents id / filename / created / updated)"),
  },
  skyslope: {
    credentials:          B(`${TENANT_CRED} (api_key = the Partnership API token, account_id = the office id; VENDOR_CONTRACTS.skyslope names token POST /ext/token — the token is obtained by the tenant and pasted; the exchange is not automated, published as a blind spot)`),
    settings:             B(SETTINGS),
    forms:                P("lib/integrations/providers/skyslope-provider.ts:217 listForms → GET /forms?officeId", "not in the cited spec excerpt (VENDOR_CONTRACTS.skyslope contractSource) — shape unverified"),
    transaction_creation: B("lib/integrations/providers/skyslope-provider.ts:82 createTransaction (POST /files — the published path, wave 140I)"),
    document_upload:      B("lib/integrations/providers/skyslope-provider.ts:109 attachForms / :197 uploadDocument (POST /files/{id}/documents — the published path)"),
    form_fill:            B(`${IN_APP_FILL}; the ONE frameable provider window — forms.skyslope.com iframe (capabilities.embed, SkySlope Forms Widget)`),
    esign:                P("lib/integrations/providers/skyslope-provider.ts:131 sendForSignature → POST /files/{id}/signatures", "the spec names POST /files/{id}/envelopes (skyslope-provider.ts:9-11 open item) — the envelope path/body is unverified"),
    status:               P("lib/integrations/providers/skyslope-provider.ts:160 getSignatureStatus; webhook app/api/webhooks/skyslope/route.ts", "reads /files/{id}/signatures (the same open item as the send)"),
    sync:                 B("lib/integrations/providers/skyslope-provider.ts:245 syncDocuments (GET /files/{id}/documents — the published path) via sync-from-provider.ts (tenant credential wired this lane)"),
  },
  authentisign: {
    credentials:          B(`${TENANT_CRED} (api_key = the Lone Wolf Bearer token obtained through Request Access, account_id = the account id; base host https://api.lwolf.com verified — apidocs.lwolf.com getting-started, 2026-10-14)`),
    settings:             B(SETTINGS),
    forms:                P("lib/integrations/providers/authentisign-provider.ts:221 listForms → /authentisign/v1/forms", "no published contract for the path (no contractSource; only the host is verified)"),
    transaction_creation: P("lib/integrations/providers/authentisign-provider.ts:78 createTransaction → POST /authentisign/v1/signings", "endpoint paths and bodies are not verified against the published reference (only the host is)"),
    document_upload:      P("lib/integrations/providers/authentisign-provider.ts:101 attachForms / :184 uploadDocument", "unverified path (as above)"),
    form_fill:            B(`${IN_APP_FILL}; no published embed surface → popup`),
    esign:                P("lib/integrations/providers/authentisign-provider.ts:118 sendForSignature (participants, then /send)", "unverified paths (as above)"),
    status:               P("lib/integrations/providers/authentisign-provider.ts:147 getSignatureStatus; webhook app/api/webhooks/authentisign/route.ts", "unverified path (as above)"),
    sync:                 P("lib/integrations/providers/authentisign-provider.ts:199 syncDocuments via sync-from-provider.ts (tenant credential wired this lane)", "unverified path (as above)"),
  },
  formsimplicity: {
    credentials:          P(`${TENANT_CRED} (api_key = a pasted Bearer token)`, "the documented auth is OAuth2 client_credentials at /oauth/token (VENDOR_CONTRACTS.formsimplicity) — not performed, so a pasted token lapses; the vendor states the API is 'setup for internal use only at this time' (api.formsimplicity.com/docs/intro)"),
    settings:             B(SETTINGS),
    forms:                P("lib/integrations/providers/formsimplicity-provider.ts:196 listForms → GET /forms", "not in the published docs (formsimplicity-provider.ts:21-22)"),
    transaction_creation: P("lib/integrations/providers/formsimplicity-provider.ts:80 createTransaction → POST /fsforms/addTrans (documented)", "the vendor requires stateID + agentNRDSID, which the request does not carry — the 400 is surfaced (formsimplicity-provider.ts:19-22)"),
    document_upload:      P("lib/integrations/providers/formsimplicity-provider.ts:104 attachForms / :163 uploadDocument → /transactions/{id}/documents", "not in the published docs"),
    form_fill:            B(`${IN_APP_FILL}; no published embed surface → popup`),
    esign:                P("lib/integrations/providers/formsimplicity-provider.ts:120 sendForSignature → /transactions/{id}/signature-requests", "not in the published docs (e-sign rides the vendor's Authentisign integration)"),
    status:               P("lib/integrations/providers/formsimplicity-provider.ts:137 getSignatureStatus; no webhook route", "not in the published docs; no completion webhook"),
    sync:                 P("lib/integrations/providers/formsimplicity-provider.ts:176 syncDocuments via sync-from-provider.ts", "not in the published docs"),
  },
  brokermint: {
    credentials:          B(`${TENANT_CRED} (api_key as the documented 'api_key' query parameter — VENDOR_CONTRACTS.brokermint, wave 140I)`),
    settings:             B(SETTINGS),
    forms:                M("lib/integrations/providers/brokermint-provider.ts:170 listForms returns [] honestly", "Brokermint exposes no state-association form library"),
    transaction_creation: B("lib/integrations/providers/brokermint-provider.ts:78 createTransaction (POST /v2/transactions — the restated reference)"),
    document_upload:      P("lib/integrations/providers/brokermint-provider.ts:99 attachForms / :137 uploadDocument → /v2/transactions/{id}/documents", "the document sub-resources are INFERRED, not in the restated reference (brokermint-provider.ts:10-12)"),
    form_fill:            B(`${IN_APP_FILL}; no published embed surface → popup`),
    esign:                M("lib/integrations/providers/brokermint-provider.ts:46 ESIGN_UNSUPPORTED (sendForSignature / getSignatureStatus refuse by name)", "Brokermint has no e-signature — pair an e-sign provider"),
    status:               M("brokermint-provider.ts:120 getSignatureStatus refuses", "no e-sign, so no signature status"),
    sync:                 P("lib/integrations/providers/brokermint-provider.ts:150 syncDocuments via sync-from-provider.ts", "the documents list is inferred (as above)"),
  },
}

/** Which cells a capability NEEDS before a provider may be OFFERED for it. `forms` is not required
 *  for the transaction capability (Brokermint is a transaction platform with no form library — the
 *  platform library serves); `sync` is not required for e-sign (Google's signed copy is filed by hand).
 *  @proofSeam the proof derives every verdict from this table (§B) — the product reads providerOfferVerdict. */
export const CAPABILITY_REQUIRED_STEPS: Readonly<Record<"transaction" | "esign", readonly MatrixStep[]>> = Object.freeze({
  transaction: ["credentials", "settings", "transaction_creation", "document_upload", "sync"],
  esign:       ["credentials", "settings", "esign", "status"],
})
export type OfferCapability = keyof typeof CAPABILITY_REQUIRED_STEPS

type ProviderOfferVerdict =
  | { ok: true; provider: ProviderName }
  | { ok: false; provider: string; step: MatrixStep | "unknown" | "capability"; reason: string }

/**
 * PURE — THE ONE RULE: a provider is offered for a capability only when the catalog claims it
 * (capabilities.esign / transactionForms) AND every required cell is BUILT. The first non-BUILT
 * required cell names the honest reason. Never hand-set.
 */
export function providerOfferVerdict(capability: OfferCapability, provider?: string | null): ProviderOfferVerdict {
  const entry = getCatalogEntry(provider)
  if (!entry) return { ok: false, provider: String(provider ?? ""), step: "unknown", reason: `'${provider ?? ""}' is not a provider this platform knows` }
  const claims = capability === "esign" ? entry.capabilities.esign : entry.capabilities.transactionForms
  if (!claims) return { ok: false, provider: entry.name, step: "capability", reason: `${entry.label} does not offer ${capability === "esign" ? "e-signature" : "legal forms / transaction management"}` }
  const row = PROVIDER_CAPABILITY_MATRIX[entry.name]
  for (const step of CAPABILITY_REQUIRED_STEPS[capability]) {
    const cell = row[step]
    if (cell.status !== "BUILT") {
      return { ok: false, provider: entry.name, step, reason: `${entry.label} is unavailable for ${capability === "esign" ? "e-signature" : "legal forms / transactions"} — ${step.replace(/_/g, " ")} is ${cell.status}: ${cell.reason ?? cell.evidence}` }
    }
  }
  return { ok: true, provider: entry.name }
}

// The menu (app/dashboard/settings/integrations/integrations-client.tsx) and every write door ask
// providerOfferVerdict per provider through lib/connections/scope.ts providerSelectionVerdict — an
// unavailable provider stays LISTED, disabled, with its reason. No separate "offerable list" door
// exists on purpose: one rule, read per entry (the proof derives the lists from it, §B).

/** PURE: may a provider FULFIL an e-signature (the CDA, lib/transactions/cda-esign.ts)? The e-sign
 *  selection is honoured only when the matrix certifies its e-sign path — a transaction platform
 *  that also claims e-sign fulfils it only when that path is BUILT (owner, wave 141). */
export function esignCertified(provider?: string | null): boolean {
  return providerOfferVerdict("esign", provider).ok
}
