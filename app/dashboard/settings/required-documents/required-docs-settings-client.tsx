"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { seedRequiredDocsForBrokerage } from "@/app/actions/compliance/seed-required-docs"

interface Props {
  brokerageId:     string
  teamId:          string | null
  userId:          string
  userType:        string
  supportedStates: string[]
}

export function RequiredDocsSettingsClient({ brokerageId, teamId, userId, userType, supportedStates }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [stateCode, setStateCode] = useState<string>("")
  const [scope, setScope] = useState<"brokerage" | "team" | "agent">("brokerage")
  const [result, setResult] = useState<string | null>(null)

  // Scope choices depend on the user's role.
  const allowedScopes: ("brokerage" | "team" | "agent")[] = []
  if (["broker","broker_admin","admin","superadmin","compliance_manager","compliance_officer"].includes(userType)) allowedScopes.push("brokerage")
  if (teamId && ["team_lead","broker","broker_admin","admin","superadmin","compliance_manager","compliance_officer"].includes(userType)) allowedScopes.push("team")
  if (["agent","team_lead","broker","broker_admin","admin","superadmin","compliance_manager","compliance_officer"].includes(userType)) allowedScopes.push("agent")

  function seed() {
    setResult(null)
    startTransition(async () => {
      const scopeId = scope === "team" ? (teamId ?? "") : scope === "agent" ? userId : brokerageId
      if (scope === "team" && !teamId) {
        setResult("You aren't on a team — choose brokerage or agent scope.")
        return
      }
      const r = await seedRequiredDocsForBrokerage({
        brokerageId,
        scope,
        scopeId,
        stateCode: stateCode || null,
        actorUserId: userId,
        dealType: "buyer",
      })
      if (r.success) {
        setResult(`Seeded ${r.inserted_count} new rule${r.inserted_count === 1 ? "" : "s"} (${r.skipped_count} already on file).`)
        router.refresh()
      } else {
        setResult(`Failed: ${r.error}`)
      }
    })
  }

  return (
    <Card>
      <CardHeader><CardTitle>Seed defaults from a per-state preset</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Loads the US baseline plus the state-specific stack (TX, CA, FL, NY, IL, GA, AZ, CO, WA, NC).
          Existing rules at the same scope are skipped — your customizations are preserved.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">Scope</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={scope} onChange={e => setScope(e.target.value as any)}>
              {allowedScopes.includes("brokerage") && <option value="brokerage">Brokerage (everyone here)</option>}
              {allowedScopes.includes("team")      && <option value="team">My team only</option>}
              {allowedScopes.includes("agent")     && <option value="agent">Just me</option>}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium mb-1">State (optional)</span>
            <select className="w-full border rounded px-2 py-1.5 text-sm" value={stateCode} onChange={e => setStateCode(e.target.value)}>
              <option value="">US baseline (no state additions)</option>
              {supportedStates.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <Button onClick={seed} disabled={pending} className="w-full">
              {pending ? <Loader2 className="h-3 w-3 mr-2 animate-spin" /> : null}
              Seed defaults
            </Button>
          </div>
        </div>
        {result && <p className="text-xs text-muted-foreground">{result}</p>}
      </CardContent>
    </Card>
  )
}
