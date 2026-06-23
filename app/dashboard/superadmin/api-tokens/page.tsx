import { createClient } from "@/lib/supabase/server"
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { data: u } = await supabase.from("users").select("user_type").eq("id", user.id).maybeSingle()
  if (u?.user_type !== "superadmin") redirect("/dashboard")

  const res = await listAgenticTokens()
  const rows = res.ok ? res.rows : []

  return <ApiTokensClient initialRows={rows} loadError={res.ok ? null : res.error} />
}
