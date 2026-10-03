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

// KEPT ON REST (wave 71A): no official Intuit Node SDK exists for the QBO
// business-object surface (customer/invoice/purchase/journal-entry/company
// info) — `node-quickbooks` was verified (npm view) and its API shape
// inspected, but it is a COMMUNITY package (Michael Cohen), not published by
// Intuit, so it is declined under the official-SDK ruling. `intuit-oauth`
// (Intuit's only official package) is adopted for the token-lifecycle call
// above; these business-object calls stay on the connector gateway.
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

  /** Exchange the refresh token for a fresh access token. Wave 71A: routes through the
   *  official `intuit-oauth` SDK adapter (lib/providers/quickbooks/client.ts) instead of a
   *  hand-built Basic-auth form POST — see that file's header for the official-SDK reasoning
   *  (node-quickbooks was verified and declined; intuit-oauth is Intuit's only official
   *  package, and it covers exactly this token-lifecycle call). */
  async refreshAccessToken(): Promise<RefreshedTokens> {
    if (!this.creds.refreshToken) throw new Error("QuickBooks: refreshToken required to refresh")
    const { refreshQuickBooksToken } = await import("@/lib/providers/quickbooks/client")
    const res = await refreshQuickBooksToken(this.creds.clientId, this.creds.clientSecret, this.creds.refreshToken)
    if (!res.ok || !res.data) {
      throw new Error(`QuickBooks token refresh failed (${res.status ?? "—"}): ${res.error ?? ""}`)
    }
    const json = res.data
    const tokenExpiresAt = new Date(Date.now() + json.expiresIn * 1000).toISOString()
    // Keep the in-memory creds current so subsequent calls on this instance use the new token.
    this.creds = { ...this.creds, accessToken: json.accessToken, refreshToken: json.refreshToken, tokenExpiresAt }
    return { accessToken: json.accessToken, refreshToken: json.refreshToken, tokenExpiresAt }
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

  /** QBO Purchase — the correct entity for a business EXPENSE. paymentAccountRef is the
   *  bank/credit account the money left; expenseAccountRef is the expense category account.
   *  Both come from the tenant's tax_categories mapping — never fabricated. */
  async createPurchase(params: {
    amount: number
    expenseAccountRef: string
    paymentAccountRef: string
    description?: string
    txnDate?: string
  }): Promise<AccountingWriteResult> {
    try {
      const payload = {
        PaymentType: "Cash",
        AccountRef: { value: params.paymentAccountRef },
        ...(params.txnDate ? { TxnDate: params.txnDate } : {}),
        ...(params.description ? { PrivateNote: params.description } : {}),
        Line: [
          {
            Amount: params.amount,
            DetailType: "AccountBasedExpenseLineDetail",
            Description: params.description,
            AccountBasedExpenseLineDetail: { AccountRef: { value: params.expenseAccountRef } },
          },
        ],
      }
      const data = await this.request<{ Purchase: { Id: string } }>("POST", "purchase?minorversion=73", payload)
      return { success: true, externalId: data.Purchase.Id }
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
