import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { redirect } from "next/navigation"
import { listAgenticTokens } from "@/app/actions/agentic-tokens"
import { ApiTokensClient } from "./api-tokens-client"

export const metadata = {
  title: "Agentic-API Tokens | Superadmin",
  description:
    "Mint, list, and revoke scoped Agentic-OS API tokens — the Bearer credentials that let external agents/MCP clients invoke AGIS capabilities on a brokerage's behalf.",
}

/**
 * Superadmin surface for the Agentic-OS API auth layer. These tokens (token_hash + scopes,
 * stored in agent_credentials) authenticate `Authorization: Bearer vos_…` calls to
 * /api/agentic-os/* via resolveAgenticCaller. Minting shows the raw token exactly once.
 */
export default async function ApiTokensPage() {
  const gate = await requirePlatformCapability("providers")
  if (!gate.userId) redirect("/auth/login")
  if (!gate.ok) redirect("/dashboard")

  const res = await listAgenticTokens()
  const rows = res.ok ? res.rows : []

  // READ vs MINT. This page admits the 'providers' capability ({superadmin,
  // admin}); minting/revoking a Bearer credential stays superadmin-only in the
  // action (app/actions/agentic-tokens.ts). Pass that split down rather than
  // offering a platform admin a Mint button whose action will refuse them —
  // a page and its action disagreeing is the exact defect this round fixed.
  const canMint = gate.role === "superadmin"

  return <ApiTokensClient initialRows={rows} loadError={res.ok ? null : res.error} canMint={canMint} />
}
