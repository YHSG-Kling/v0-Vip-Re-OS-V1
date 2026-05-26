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
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64")
    const res = await fetch(INTUIT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.creds.refreshToken }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`QuickBooks token refresh failed (${res.status}): ${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
    const tokenExpiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString()
    // Keep the in-memory creds current so subsequent calls on this instance use the new token.
    this.creds = { ...this.creds, accessToken: json.access_token, refreshToken: json.refresh_token, tokenExpiresAt }
    return { accessToken: json.access_token, refreshToken: json.refresh_token, tokenExpiresAt }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${QBO_API_BASE}/${this.creds.realmId}/${path}`
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.creds.accessToken}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`QuickBooks ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`)
    }
    return (await res.json()) as T
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
