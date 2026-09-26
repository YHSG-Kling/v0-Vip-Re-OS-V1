import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Webhook } from "lucide-react"
import { WEBHOOK_CONTRACT, canonicalWebhookUrl } from "@/lib/providers/webhook-contract"
import { siteUrl } from "@/lib/platform/site-url"

/**
 * WEBHOOK CONTRACT CARD — the self-heal read surface the owner named:
 * "any webhook url needs to be researched to find the latest path which is
 * part of the connection self heal". When a provider console needs re-pointing
 * (providers change their connection methods), THIS is the one place a human
 * reads the canonical URL, the verification scheme the route implements, and
 * the env vars its secrets live in. Rows come verbatim from
 * lib/providers/webhook-contract.ts, which scripts/webhook-contract-guard.ts
 * holds in agreement with the actual route files.
 *
 * Server component, platform-staff page only (the page gates on
 * requirePlatformCapability("providers") before rendering this).
 */
export function WebhookContractCard() {
  const base = siteUrl()
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Webhook className="h-4 w-4" /> Inbound webhook contract
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Canonical callback URLs this deployment serves — paste these when re-pointing a provider console.
          Console-side drift is invisible from here (blind spot): a provider still pointed at an old path shows up
          only as missing deliveries on the per-row failure surface, or not at all where none exists.
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1 pr-3 font-medium">Provider · event</th>
                <th className="py-1 pr-3 font-medium">Canonical URL</th>
                <th className="py-1 pr-3 font-medium">Verification</th>
                <th className="py-1 pr-3 font-medium">Secret env</th>
                <th className="py-1 font-medium">Where it's pasted</th>
              </tr>
            </thead>
            <tbody>
              {WEBHOOK_CONTRACT.map((e) => (
                <tr key={e.path} className="border-b last:border-0 align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className="font-medium">{e.provider}</span>
                    <span className="text-muted-foreground"> · {e.eventKind}</span>
                    {e.compat ? (
                      <Badge variant="outline" className="ml-1">compat → {e.compat.survivorPath}</Badge>
                    ) : null}
                    {e.scheme === "hub-verify-token-only" || e.scheme === "none" ? (
                      <Badge variant="destructive" className="ml-1">payload unverified</Badge>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3">
                    <code className="font-mono">{base ? canonicalWebhookUrl(base, e) : e.path}</code>
                    {e.protocolVersion ? (
                      <div className="text-muted-foreground">{e.protocolVersion}</div>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    {e.scheme}
                    {e.verificationHeaders.length > 0 ? (
                      <div className="text-muted-foreground font-mono">{e.verificationHeaders.join(", ")}</div>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 font-mono">
                    {e.secretEnv.length > 0 ? e.secretEnv.join(", ") : "—"}
                  </td>
                  <td className="py-1.5 text-muted-foreground">
                    {e.consoleField}
                    <div>{e.failureVisibility ? `Failures: ${e.failureVisibility}` : "Failures: no repo-side visibility (blind)"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
