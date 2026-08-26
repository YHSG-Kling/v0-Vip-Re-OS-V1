import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { redirect } from "next/navigation"
import { listAgenticTokens } from "@/app/actions/agentic-tokens"
import { ApiTokensClient } from "./api-tokens-client"
import { summarizeInvocations } from "@/lib/agentic-os/invocation-log"

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

  // THE AUDIT TRAIL, beside the credentials it audits.
  // lib/agentic-os/invocation-log.ts records every /api/agentic-os decision;
  // until 2026-08-26 nothing read it, so five columns (verb, caller_via,
  // authorized, duration_ms, detail) were written on every call and seen by
  // nobody. summarizeInvocations() is the reader that was missing.
  const invocations = await summarizeInvocations({ days: 14 })

  return (
    <div className="space-y-6">
      <ApiTokensClient initialRows={rows} loadError={res.ok ? null : res.error} canMint={canMint} />

      <section className="rounded-lg border p-4">
        <h2 className="text-base font-semibold">What these tokens did — last 14 days</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Every Agentic-OS invocation decision, rolled up per capability. &ldquo;Refused&rdquo; counts
          calls a token was not scoped for — the fastest way to see a credential minted
          without the scope its client actually needs.
        </p>

        {!invocations.ok && (
          <p className="mt-3 text-sm text-red-700">
            The invocation log could not be read: {invocations.error}. This is a refusal, not an
            empty log — do not read it as &ldquo;no agent has called anything&rdquo;.
          </p>
        )}

        {invocations.ok && invocations.scannedRows === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            No Agentic-OS invocations recorded since {invocations.sinceIso.slice(0, 10)}.
          </p>
        )}

        {invocations.ok && invocations.scannedRows > 0 && (
          <>
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Executed</p>
                <p className="text-xl font-bold">{invocations.totals.executed}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Planned / gated</p>
                <p className="text-xl font-bold">{invocations.totals.planned}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Refused</p>
                <p className="text-xl font-bold">{invocations.totals.denied}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Errored</p>
                <p className="text-xl font-bold">{invocations.totals.errored}</p>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-3 font-medium">Capability</th>
                    <th className="py-2 pr-3 font-medium">Kind</th>
                    <th className="py-2 pr-3 font-medium">Verb</th>
                    <th className="py-2 pr-3 font-medium">Calls</th>
                    <th className="py-2 pr-3 font-medium">Exec</th>
                    <th className="py-2 pr-3 font-medium">Refused</th>
                    <th className="py-2 pr-3 font-medium">Err</th>
                    <th className="py-2 pr-3 font-medium">Avg ms</th>
                    <th className="py-2 pr-3 font-medium">Via</th>
                    <th className="py-2 font-medium">Latest failure</th>
                  </tr>
                </thead>
                <tbody>
                  {invocations.byCapability.slice(0, 40).map(c => (
                    <tr key={`${c.kind}::${c.capability}`} className="border-b last:border-0 align-top">
                      <td className="py-2 pr-3 font-mono text-xs">{c.capability}</td>
                      <td className="py-2 pr-3">{c.kind}</td>
                      <td className="py-2 pr-3">{c.verb ?? "—"}</td>
                      <td className="py-2 pr-3">{c.total}</td>
                      <td className="py-2 pr-3">{c.executed}</td>
                      <td className={`py-2 pr-3 ${c.unauthorized > 0 ? "text-amber-700 font-medium" : ""}`}>
                        {c.denied}
                        {c.unauthorized > 0 ? ` (${c.unauthorized} scope)` : ""}
                      </td>
                      <td className={`py-2 pr-3 ${c.errored > 0 ? "text-red-700 font-medium" : ""}`}>{c.errored}</td>
                      <td className="py-2 pr-3">{c.avgDurationMs ?? "—"}</td>
                      <td className="py-2 pr-3 text-xs">{c.callerVias.length ? c.callerVias.join(", ") : "—"}</td>
                      <td className="py-2 text-xs text-muted-foreground max-w-xs truncate">{c.lastError ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              {invocations.scannedRows} row(s) scanned since {invocations.sinceIso.slice(0, 10)}
              {invocations.truncated
                ? " — the scan hit its row cap, so these counts are a floor, not a total."
                : "."}
              {invocations.deniedForScope.length > 0 &&
                ` ${invocations.deniedForScope.length} capabilit(ies) were refused for a missing scope.`}
            </p>
          </>
        )}
      </section>
    </div>
  )
}
