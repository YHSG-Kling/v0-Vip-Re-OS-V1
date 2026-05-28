import type { TransactionProvider } from "@/lib/brokerage/get-brokerage-settings"

export function getTransactionProviderEmbedUrl(
  provider: TransactionProvider,
  _credentials?: { apiKey?: string; userId?: string; orgId?: string }
): string | null {
  switch (provider) {
    case "dotloop":
      return "https://dotloop.com/loops?embed=1"
    case "skyslope":
      return "https://app.skyslope.com/files?embed=1"
    case "formsimplicity":
      return "https://www.formsimplicity.com/"
    case "brokermint":
      return "https://app.brokermint.com/transactions"
    default:
      return null
  }
}
