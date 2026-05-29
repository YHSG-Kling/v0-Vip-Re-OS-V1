// lib/providers/accounting/quickbooks.ts
// Real QuickBooks Online (Intuit) accounting connector. User-connected: the brokerage
// links its own Intuit account (OAuth2). Mirrors the house provider pattern (a class with
// injected credentials + real fetch calls), like lib/integrations/providers/brokermint-provider.ts.
//
// Implements the IAccountingProvider contract the kernel dispatches to for `accounting_sync`:
// refresh the OAuth token, read CompanyInfo (the health probe), and write invoices /
// journal entries. No stubs — these are the production Intuit endpoints. Token refresh
// returns the new token set so the caller persists it (the connector itself is stateless).

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
const QBO_API_BASE = "https://quickbooks.api.intuit.com/v3/company"

export interface QuickBooksCredentials {
  accessToken: string
  refreshToken: string
  /** Intuit company id (a.k.a. realmId) — identifies which QBO company to write to. */
  realmId: string
  clientId: string
  clientSecret: string
  /** ISO-8601 access-token expiry, when known. */
  tokenExpiresAt?: string | null
}

export interface RefreshedTokens {
  accessToken: string
  refreshToken: string
  /** ISO-8601 — computed from the returned expires_in. */
  tokenExpiresAt: string
}

export interface CompanyInfo {
  companyName: string
  legalName: string | null
  country: string | null
}

export interface CreateInvoiceParams {
  customerRef: string
  amount: number
  description?: string
  currency?: string
}

export interface AccountingWriteResult {
  success: boolean
  externalId?: string
  error?: string
}

/** The contract the kernel's accounting_sync capability dispatches to. Stripe (as a light
 *  ledger) and QuickBooks both implement it, so the domain code is provider-agnostic. */
export interface IAccountingProvider {
  readonly name: string
  /** Liveness + auth + correct-company probe. Throws on auth/permission failure. */
  getCompanyInfo(): Promise<CompanyInfo>
  createInvoice(params: CreateInvoiceParams): Promise<AccountingWriteResult>
  createJournalEntry(params: { lines: Array<{ amount: number; accountRef: string; postingType: "Debit" | "Credit" }>; description?: string }): Promise<AccountingWriteResult>
}

export class QuickBooksProvider implements IAccountingProvider {
  readonly name = "quickbooks"
  private creds: QuickBooksCredentials

  constructor(creds: QuickBooksCredentials) {
    if (!creds?.accessToken) throw new Error("QuickBooks: accessToken required")
    if (!creds?.realmId) throw new Error("QuickBooks: realmId (company id) required")
    this.creds = creds
  }

  /** Exchange the refresh token for a fresh access token. Intuit uses HTTP Basic auth with
   *  the app's client id/secret + grant_type=refresh_token. Returns the new token set. */
  async refreshAccessToken(): Promise<RefreshedTokens> {
    if (!this.creds.refreshToken) throw new Error("QuickBooks: refreshToken required to refresh")
    const tokenUrl = new URL(INTUIT_TOKEN_URL)
    const res = await callConnector<{ access_token: string; refresh_token: string; expires_in: number }>({
      connector: "quickbooks-oauth",
      baseUrl: tokenUrl.origin,
      path: tokenUrl.pathname,
      method: "POST",
      auth: { style: "basic", username: this.creds.clientId, password: this.creds.clientSecret },
      bodyType: "form",
      body: { grant_type: "refresh_token", refresh_token: this.creds.refreshToken },
    })
    if (!res.ok || !res.data) {
      throw new Error(`QuickBooks token refresh failed (${res.status}): ${res.error ?? ""}`)
    }
    const json = res.data
    const tokenExpiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString()
    // Keep the in-memory creds current so subsequent calls on this instance use the new token.
    this.creds = { ...this.creds, accessToken: json.access_token, refreshToken: json.refresh_token, tokenExpiresAt }
    return { accessToken: json.access_token, refreshToken: json.refresh_token, tokenExpiresAt }
  }

  /** Single egress choke point — every QBO call (API + OAuth token refresh) leaves through the
   *  connector-gateway. API calls use Bearer; the token refresh uses Basic auth + form body. */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await callConnector<T>({
      connector: "quickbooks",
      baseUrl: `${QBO_API_BASE}/${this.creds.realmId}`,
      path,
      method,
      body,
      auth: { style: "bearer", token: this.creds.accessToken },
    })
    if (!res.ok || res.data == null) {
      throw new Error(`QuickBooks ${method} ${path} failed (${res.status ?? "—"}): ${res.error ?? ""}`)
    }
    return res.data
  }

  async getCompanyInfo(): Promise<CompanyInfo> {
    const data = await this.request<{ CompanyInfo: { CompanyName: string; LegalName?: string; Country?: string } }>(
      "GET",
      `companyinfo/${this.creds.realmId}?minorversion=73`,
    )
    const c = data.CompanyInfo
    return { companyName: c.CompanyName, legalName: c.LegalName ?? null, country: c.Country ?? null }
  }

  async createInvoice(params: CreateInvoiceParams): Promise<AccountingWriteResult> {
    try {
      const payload = {
        CustomerRef: { value: params.customerRef },
        Line: [
          {
            Amount: params.amount,
            DetailType: "SalesItemLineDetail",
            Description: params.description,
            SalesItemLineDetail: { ItemRef: { value: "1" } },
          },
        ],
        ...(params.currency ? { CurrencyRef: { value: params.currency } } : {}),
      }
      const data = await this.request<{ Invoice: { Id: string } }>("POST", "invoice?minorversion=73", payload)
      return { success: true, externalId: data.Invoice.Id }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async createJournalEntry(params: { lines: Array<{ amount: number; accountRef: string; postingType: "Debit" | "Credit" }>; description?: string }): Promise<AccountingWriteResult> {
    try {
      const payload = {
        Line: params.lines.map((l) => ({
          Amount: l.amount,
          DetailType: "JournalEntryLineDetail",
          Description: params.description,
          JournalEntryLineDetail: { PostingType: l.postingType, AccountRef: { value: l.accountRef } },
        })),
      }
      const data = await this.request<{ JournalEntry: { Id: string } }>("POST", "journalentry?minorversion=73", payload)
      return { success: true, externalId: data.JournalEntry.Id }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
