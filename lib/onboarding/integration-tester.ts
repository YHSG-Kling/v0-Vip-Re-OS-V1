// ============================================================
// SYSTEM: L11-S03 — Integration Tester Library
// VIP Real Estate AI OS — Layer 11
// ============================================================
// Tests provider connections without logging raw credentials
// Each provider has a specific test function

import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface TestResult {
  pass: boolean
  detail: string
}

export type ProviderName =
  | "twilio"
  | "sendgrid"
  | "docusign"
  | "dotloop"
  | "skyslope"
  | "brokermint"
  | "heygen"
  | "gohighlevel"
  | "google_calendar"
  | "outlook_calendar"
  | "quickbooks"
  | "xero"
  | "idx_broker"
  | "lob"
  | "zillow"
  | "realtor_com"
  | "opcity"
  | "meta_ads"
  | "google_ads"

// ─── MAIN TEST FUNCTION ───────────────────────────────────────────────────────

export async function testIntegration(
  provider: ProviderName,
  credentials: Record<string, string>
): Promise<TestResult> {
  console.log(`[IntegrationTester] Testing provider: ${provider}`)
  
  try {
    switch (provider) {
      case "twilio":
        return await testTwilio(credentials)
      case "sendgrid":
        return await testSendGrid(credentials)
      case "docusign":
        return await testDocuSign(credentials)
      case "dotloop":
        return await testDotLoop(credentials)
      case "heygen":
        return await testHeyGen(credentials)
      case "gohighlevel":
        return await testGoHighLevel(credentials)
      case "google_calendar":
        return await testGoogleCalendar(credentials)
      case "outlook_calendar":
        return await testOutlookCalendar(credentials)
      case "quickbooks":
        return await testQuickBooks(credentials)
      case "xero":
        return await testXero(credentials)
      case "idx_broker":
        return await testIdxBroker(credentials)
      case "lob":
        return await testLob(credentials)
      case "zillow":
        return await testZillow(credentials)
      case "realtor_com":
        return await testRealtorCom(credentials)
      case "opcity":
        return await testOpcity(credentials)
      case "skyslope":
        return await testSkySlope(credentials)
      case "brokermint":
        return await testBrokermint(credentials)
      default:
        return { pass: false, detail: `Unknown provider: ${provider}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error(`[IntegrationTester] ${provider} test failed:`, message)
    return { pass: false, detail: message }
  }
}

// ─── PROVIDER-SPECIFIC TEST FUNCTIONS ─────────────────────────────────────────

async function testTwilio(credentials: Record<string, string>): Promise<TestResult> {
  const { account_sid, auth_token, phone_number } = credentials
  
  if (!account_sid || !auth_token) {
    return { pass: false, detail: "Account SID and Auth Token are required" }
  }
  
  const response = await callConnector({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${account_sid}/IncomingPhoneNumbers.json`,
    method: "GET",
    query: { PageSize: "1" },
    auth: { style: "basic", username: account_sid, password: auth_token },
  })

  if (!response.ok) {
    return {
      pass: false,
      detail: response.error || `Twilio API returned ${response.status}`
    }
  }

  return { pass: true, detail: "Twilio credentials verified - phone numbers accessible" }
}

async function testSendGrid(credentials: Record<string, string>): Promise<TestResult> {
  const { api_key, from_email } = credentials
  
  if (!api_key) {
    return { pass: false, detail: "API Key is required" }
  }
  
  const response = await callConnector({
    connector: "sendgrid", baseUrl: "https://api.sendgrid.com", path: "/v3/user/profile", method: "GET",
    auth: { style: "bearer", token: api_key },
  })

  if (!response.ok) {
    return {
      pass: false,
      detail: `SendGrid API returned ${response.status} - verify API key`
    }
  }

  return { pass: true, detail: "SendGrid credentials verified - account accessible" }
}

async function testDocuSign(credentials: Record<string, string>): Promise<TestResult> {
  const { integration_key, account_id, access_token, environment } = credentials
  
  if (!integration_key || !account_id) {
    return { pass: false, detail: "Integration Key and Account ID are required" }
  }
  
  // If we have an access token, verify it
  if (access_token) {
    const baseUrl = environment === "sandbox"
      ? "https://demo.docusign.net/restapi"
      : "https://na3.docusign.net/restapi"

    const response = await callConnector({
      connector: "docusign", baseUrl, path: `/v2.1/accounts/${account_id}`, method: "GET",
      auth: { style: "bearer", token: access_token },
    })

    if (!response.ok) {
      return {
        pass: false,
        detail: "DocuSign access token invalid or expired"
      }
    }
    
    return { pass: true, detail: "DocuSign credentials verified - account accessible" }
  }
  
  // Without access token, we can only validate the configuration exists
  return { 
    pass: true, 
    detail: "DocuSign configuration saved - OAuth flow required for full verification" 
  }
}

async function testDotLoop(credentials: Record<string, string>): Promise<TestResult> {
  const { access_token, partner_key } = credentials
  
  if (!access_token) {
    return { pass: false, detail: "Access Token is required" }
  }
  
  const response = await callConnector({
    connector: "dotloop", baseUrl: "https://api-gateway.dotloop.com", path: "/public/v2/profile", method: "GET",
    auth: { style: "bearer", token: access_token },
    headers: { ...(partner_key && { "X-Partner-Key": partner_key }) },
  })

  if (!response.ok) {
    return {
      pass: false,
      detail: `DotLoop API returned ${response.status} - verify access token`
    }
  }
  
  return { pass: true, detail: "DotLoop credentials verified - profile accessible" }
}

async function testHeyGen(credentials: Record<string, string>): Promise<TestResult> {
  const { api_key } = credentials
  
  if (!api_key) {
    return { pass: false, detail: "API Key is required" }
  }
  
  const response = await callConnector({
    connector: "heygen", baseUrl: "https://api.heygen.com", path: "/v1/avatars", method: "GET",
    auth: { style: "header", name: "X-Api-Key", value: api_key },
  })

  if (!response.ok) {
    return {
      pass: false,
      detail: `HeyGen API returned ${response.status} - verify API key`
    }
  }
  
  return { pass: true, detail: "HeyGen credentials verified - avatars accessible" }
}

async function testGoHighLevel(credentials: Record<string, string>): Promise<TestResult> {
  const { agency_api_key, location_id } = credentials
  
  if (!agency_api_key) {
    return { pass: false, detail: "Agency API Key is required" }
  }
  
  const response = await callConnector({
    connector: "ghl", baseUrl: "https://rest.gohighlevel.com",
    path: location_id ? `/v1/locations/${location_id}` : "/v1/locations", method: "GET",
    auth: { style: "bearer", token: agency_api_key },
  })

  if (!response.ok) {
    return { 
      pass: false, 
      detail: `GoHighLevel API returned ${response.status} - verify API key` 
    }
  }
  
  return { pass: true, detail: "GoHighLevel credentials verified - locations accessible" }
}

async function testGoogleCalendar(credentials: Record<string, string>): Promise<TestResult> {
  const { access_token, refresh_token } = credentials
  
  if (!access_token && !refresh_token) {
    return { pass: false, detail: "OAuth connection required - click Connect Google Account" }
  }
  
  if (access_token) {
    const response = await callConnector({
      connector: "google_calendar", baseUrl: "https://www.googleapis.com",
      path: "/calendar/v3/users/me/calendarList", method: "GET", query: { maxResults: "1" },
      auth: { style: "bearer", token: access_token },
    })

    if (!response.ok) {
      if (response.status === 401) {
        return { pass: false, detail: "Google token expired - reconnection required" }
      }
      return { pass: false, detail: `Google Calendar API returned ${response.status}` }
    }
    
    return { pass: true, detail: "Google Calendar connected - calendars accessible" }
  }
  
  return { pass: true, detail: "Google Calendar OAuth configured - token refresh pending" }
}

async function testOutlookCalendar(credentials: Record<string, string>): Promise<TestResult> {
  const { access_token, refresh_token } = credentials
  
  if (!access_token && !refresh_token) {
    return { pass: false, detail: "OAuth connection required - click Connect Microsoft Account" }
  }
  
  if (access_token) {
    const response = await callConnector({
      connector: "outlook_calendar", baseUrl: "https://graph.microsoft.com",
      path: "/v1.0/me/calendars", method: "GET", query: { "$top": "1" },
      auth: { style: "bearer", token: access_token },
    })

    if (!response.ok) {
      if (response.status === 401) {
        return { pass: false, detail: "Microsoft token expired - reconnection required" }
      }
      return { pass: false, detail: `Microsoft Graph API returned ${response.status}` }
    }
    
    return { pass: true, detail: "Outlook Calendar connected - calendars accessible" }
  }
  
  return { pass: true, detail: "Outlook Calendar OAuth configured - token refresh pending" }
}

async function testQuickBooks(credentials: Record<string, string>): Promise<TestResult> {
  const { client_id, client_secret, realm_id, access_token } = credentials
  
  if (!client_id || !client_secret) {
    return { pass: false, detail: "Client ID and Client Secret are required" }
  }
  
  if (!access_token) {
    return { pass: true, detail: "QuickBooks OAuth configured - connection required" }
  }
  
  const response = await callConnector({
    connector: "quickbooks", baseUrl: "https://quickbooks.api.intuit.com",
    path: `/v3/company/${realm_id}/companyinfo/${realm_id}`, method: "GET",
    auth: { style: "bearer", token: access_token },
  })

  if (!response.ok) {
    return { pass: false, detail: `QuickBooks API returned ${response.status}` }
  }
  
  return { pass: true, detail: "QuickBooks connected - company info accessible" }
}

async function testXero(credentials: Record<string, string>): Promise<TestResult> {
  const { client_id, client_secret, access_token } = credentials
  
  if (!client_id || !client_secret) {
    return { pass: false, detail: "Client ID and Client Secret are required" }
  }
  
  if (!access_token) {
    return { pass: true, detail: "Xero OAuth configured - connection required" }
  }
  
  const response = await callConnector({
    connector: "xero", baseUrl: "https://api.xero.com", path: "/connections", method: "GET",
    auth: { style: "bearer", token: access_token },
  })

  if (!response.ok) {
    return { pass: false, detail: `Xero API returned ${response.status}` }
  }
  
  return { pass: true, detail: "Xero connected - organization accessible" }
}

async function testIdxBroker(credentials: Record<string, string>): Promise<TestResult> {
  const { api_key, partner_key } = credentials
  
  if (!api_key) {
    return { pass: false, detail: "API Key is required" }
  }
  
  const response = await callConnector({
    connector: "idxbroker", baseUrl: "https://api.idxbroker.com", path: "/partners/accounttype", method: "GET",
    auth: { style: "header", name: "accesskey", value: api_key },
    headers: { ...(partner_key && { partnerkey: partner_key }) },
  })

  if (!response.ok) {
    return { pass: false, detail: `IDX Broker API returned ${response.status}` }
  }
  
  return { pass: true, detail: "IDX Broker credentials verified - account accessible" }
}

async function testLob(credentials: Record<string, string>): Promise<TestResult> {
  const { api_key_live, api_key_test, environment } = credentials
  
  const apiKey = environment === "live" ? api_key_live : api_key_test
  
  if (!apiKey) {
    return { pass: false, detail: `${environment || "test"} API Key is required` }
  }
  
  const response = await callConnector({
    connector: "lob", baseUrl: "https://api.lob.com", path: "/v1/accounts", method: "GET",
    auth: { style: "basic", username: apiKey, password: "" },
  })

  if (!response.ok) {
    return { pass: false, detail: `Lob API returned ${response.status}` }
  }
  
  return { pass: true, detail: `Lob ${environment || "test"} credentials verified` }
}

async function testZillow(credentials: Record<string, string>): Promise<TestResult> {
  const { tech_connect_token } = credentials
  
  if (!tech_connect_token) {
    return { pass: false, detail: "Tech Connect API Token is required" }
  }
  
  // Zillow Tech Connect doesn't have a simple health endpoint
  // Validate token format and assume valid if properly formatted
  if (tech_connect_token.length < 20) {
    return { pass: false, detail: "Token appears invalid - check format" }
  }
  
  return { pass: true, detail: "Zillow Tech Connect token saved - will verify on first sync" }
}

async function testRealtorCom(credentials: Record<string, string>): Promise<TestResult> {
  const { api_key } = credentials
  
  if (!api_key) {
    return { pass: false, detail: "API Key is required" }
  }
  
  // Realtor.com API validation
  if (api_key.length < 10) {
    return { pass: false, detail: "API Key appears invalid - check format" }
  }
  
  return { pass: true, detail: "Realtor.com API Key saved - will verify on first sync" }
}

async function testOpcity(credentials: Record<string, string>): Promise<TestResult> {
  const { username, password } = credentials

  if (!username || !password) {
    return { pass: false, detail: "Username and Password are required" }
  }

  return { pass: true, detail: "Opcity credentials saved - will verify on first sync" }
}

async function testSkySlope(credentials: Record<string, string>): Promise<TestResult> {
  const { api_key } = credentials
  if (!api_key) return { pass: false, detail: "API Key is required" }
  // SkySlope REST API health check
  const response = await callConnector({
    connector: "skyslope", baseUrl: "https://api.skyslope.com", path: "/v3/transactions", method: "GET",
    query: { pageSize: "1" }, auth: { style: "bearer", token: api_key },
  })
  if (response.status === 401) return { pass: false, detail: "Invalid SkySlope API Key" }
  if (!response.ok && response.status !== 403) {
    return { pass: false, detail: `SkySlope API returned ${response.status}` }
  }
  return { pass: true, detail: "SkySlope credentials verified - transaction platform accessible" }
}

async function testBrokermint(credentials: Record<string, string>): Promise<TestResult> {
  const { api_key, office_id } = credentials
  if (!api_key) return { pass: false, detail: "API Key is required" }
  // Brokermint API health check
  const response = await callConnector({
    connector: "brokermint", baseUrl: "https://brokermint.com",
    path: office_id ? `/api/v1/offices/${office_id}` : "/api/v1/offices", method: "GET",
    auth: { style: "bearer", token: api_key },
  })
  if (response.status === 401) return { pass: false, detail: "Invalid Brokermint API Key" }
  if (!response.ok && response.status !== 403) {
    return { pass: false, detail: `Brokermint API returned ${response.status}` }
  }
  return { pass: true, detail: "Brokermint credentials verified - office accessible" }
}

// ─── PROVIDER METADATA ────────────────────────────────────────────────────────

export const PROVIDER_METADATA: Record<ProviderName, {
  displayName: string
  providerType: string
  credentialFields: Array<{
    key: string
    label: string
    type: "text" | "password" | "email" | "select"
    required: boolean
    placeholder?: string
    options?: Array<{ value: string; label: string }>
  }>
  isOAuth?: boolean
  oauthProvider?: "google" | "microsoft" | "docusign" | "quickbooks" | "xero" | "meta_ads" | "google_ads"
}> = {
  meta_ads: {
    displayName: "Meta Ads (Facebook & Instagram)",
    providerType: "ads",
    credentialFields: [],
    isOAuth: true,
    oauthProvider: "meta_ads",
  },
  google_ads: {
    displayName: "Google Ads",
    providerType: "ads",
    credentialFields: [],
    isOAuth: true,
    oauthProvider: "google_ads",
  },
  twilio: {
    displayName: "Twilio",
    providerType: "sms",
    credentialFields: [
      { key: "account_sid", label: "Account SID", type: "text", required: true, placeholder: "AC..." },
      { key: "auth_token", label: "Auth Token", type: "password", required: true },
      { key: "phone_number", label: "Phone Number", type: "text", required: true, placeholder: "+1..." },
    ],
  },
  sendgrid: {
    displayName: "SendGrid",
    providerType: "email",
    credentialFields: [
      { key: "api_key", label: "API Key", type: "password", required: true, placeholder: "SG..." },
      { key: "from_email", label: "From Email", type: "email", required: true },
      { key: "from_name", label: "From Name", type: "text", required: false },
    ],
  },
  docusign: {
    displayName: "DocuSign",
    providerType: "esign",
    credentialFields: [
      { key: "integration_key", label: "Integration Key", type: "text", required: true },
      { key: "account_id", label: "Account ID", type: "text", required: true },
      { key: "redirect_uri", label: "Redirect URI", type: "text", required: false },
      { 
        key: "environment", 
        label: "Environment", 
        type: "select", 
        required: true,
        options: [
          { value: "sandbox", label: "Sandbox" },
          { value: "production", label: "Production" },
        ],
      },
    ],
    isOAuth: true,
    oauthProvider: "docusign",
  },
  dotloop: {
    // Real estate transaction-and-forms platform with built-in e-sign. Counts
    // as both transaction-management and e-sign — primary type is esign so
    // it satisfies the required e-sign category in the progress calc.
    displayName: "DotLoop",
    providerType: "esign",
    credentialFields: [
      { key: "access_token", label: "Access Token", type: "password", required: true },
      { key: "partner_key", label: "Partner Key", type: "text", required: false },
    ],
  },
  skyslope: {
    // Transaction-and-forms platform with built-in DigiSign e-sign.
    displayName: "SkySlope",
    providerType: "esign",
    credentialFields: [
      { key: "api_key", label: "API Key", type: "password", required: true },
    ],
  },
  brokermint: {
    // Pure transaction-management + commission tracking (no built-in e-sign).
    displayName: "Brokermint",
    providerType: "transaction",
    credentialFields: [
      { key: "api_key", label: "API Key", type: "password", required: true },
      { key: "office_id", label: "Office ID", type: "text", required: false },
    ],
  },
  heygen: {
    displayName: "HeyGen",
    providerType: "video",
    credentialFields: [
      { key: "api_key", label: "API Key", type: "password", required: true },
    ],
  },
  gohighlevel: {
    displayName: "GoHighLevel",
    providerType: "crm",
    credentialFields: [
      { key: "agency_api_key", label: "Agency API Key", type: "password", required: true },
      { key: "location_id", label: "Location ID", type: "text", required: false },
    ],
  },
  google_calendar: {
    displayName: "Google Calendar",
    providerType: "calendar",
    credentialFields: [],
    isOAuth: true,
    oauthProvider: "google",
  },
  outlook_calendar: {
    displayName: "Outlook Calendar",
    providerType: "calendar",
    credentialFields: [],
    isOAuth: true,
    oauthProvider: "microsoft",
  },
  quickbooks: {
    displayName: "QuickBooks",
    providerType: "accounting",
    credentialFields: [
      { key: "client_id", label: "Client ID", type: "text", required: true },
      { key: "client_secret", label: "Client Secret", type: "password", required: true },
      { key: "realm_id", label: "Realm ID", type: "text", required: false },
    ],
    isOAuth: true,
    oauthProvider: "quickbooks",
  },
  xero: {
    displayName: "Xero",
    providerType: "accounting",
    credentialFields: [
      { key: "client_id", label: "Client ID", type: "text", required: true },
      { key: "client_secret", label: "Client Secret", type: "password", required: true },
    ],
    isOAuth: true,
    oauthProvider: "xero",
  },
  idx_broker: {
    displayName: "IDX Broker",
    providerType: "mls",
    credentialFields: [
      { key: "api_key", label: "API Key", type: "password", required: true },
      { key: "partner_key", label: "Partner Key", type: "text", required: false },
      { key: "account_label", label: "Account Label", type: "text", required: false },
    ],
  },
  lob: {
    displayName: "Lob",
    providerType: "direct_mail",
    credentialFields: [
      { key: "api_key_live", label: "Live API Key", type: "password", required: false },
      { key: "api_key_test", label: "Test API Key", type: "password", required: true },
      { 
        key: "environment", 
        label: "Environment", 
        type: "select", 
        required: true,
        options: [
          { value: "test", label: "Test" },
          { value: "live", label: "Live" },
        ],
      },
    ],
  },
  zillow: {
    displayName: "Zillow",
    providerType: "leads",
    credentialFields: [
      { key: "tech_connect_token", label: "Tech Connect API Token", type: "password", required: true },
    ],
  },
  realtor_com: {
    displayName: "Realtor.com",
    providerType: "leads",
    credentialFields: [
      { key: "api_key", label: "API Key", type: "password", required: true },
    ],
  },
  opcity: {
    displayName: "Opcity",
    providerType: "leads",
    credentialFields: [
      { key: "username", label: "Username", type: "text", required: true },
      { key: "password", label: "Password", type: "password", required: true },
    ],
  },
}

// ─── PROVIDER GROUPS ──────────────────────────────────────────────────────────

export const PROVIDER_GROUPS = {
  // Required = the minimum tech a brokerage needs to operate on the platform.
  // E-sign covers DocuSign, Dotloop, and SkySlope (the latter two also serve
  // as transaction-form platforms, so connecting one of them satisfies both
  // the required e-sign category and the recommended transaction category).
  required: {
    label: "Required",
    description: "Connect one provider per category to advance in onboarding",
    providers: ["twilio", "sendgrid", "docusign", "dotloop", "skyslope"] as ProviderName[],
    requirements: {
      sms: 1,
      email: 1,
      esign: 1,
    },
  },
  // Recommended = transaction-form platform (so the form wizard can pull
  // state contracts/disclosures), calendar, CRM. Dotloop and SkySlope are
  // listed here too for the transaction-management UX even though their
  // primary type is e-sign — connecting them counts toward both.
  recommended: {
    label: "Recommended",
    description: "Transaction-form platform, CRM, calendar — strongly recommended for the AI workflow",
    providers: ["dotloop", "skyslope", "brokermint", "gohighlevel", "google_calendar", "outlook_calendar"] as ProviderName[],
    requirements: {
      transaction: 0,
      crm: 0,
      calendar: 0,
    },
  },
  // Optional = accounting, MLS/IDX, lead portals, direct mail.
  // Video generation (D-ID + HeyGen) and voice cloning (ElevenLabs) run on
  // platform-managed infrastructure — subscribers configure their personal
  // avatar/voice in Twin Studio, not by entering API keys here.
  optional: {
    label: "Optional",
    description: "Connect any that apply to your business",
    providers: ["quickbooks", "xero", "idx_broker", "lob", "zillow", "realtor_com", "opcity"] as ProviderName[],
    requirements: {},
  },
}
