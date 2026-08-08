"use client"

/**
 * Port-in / BYO number → agent.
 *
 * Wave 4 slice 2: `app/actions/phone-provisioning.ts:manuallyAddAgentPhone` is
 * the MANUAL half of the two flows that module's own header describes ("MANUAL:
 * brokerage admin or agent clicks Add Number → … bring your own (BYO) — paste an
 * existing Twilio number"). The AUTO half is now reached from createAgent; this
 * is the manual half's missing surface. Before this there was no way at all to
 * bind a number a brokerage already owns to one of its agents.
 *
 * The action carries the real proofs (a global active-number collision check and
 * an ownership proof against the brokerage's resolved Twilio account, both
 * failing closed). This card never re-implements them — it collects the number,
 * names the agent, and renders the action's refusal verbatim.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PhoneForwarded, Loader2, CheckCircle2, AlertTriangle } from "lucide-react"
import { manuallyAddAgentPhone } from "@/app/actions/phone-provisioning"

export interface PortInAgentOption {
  agentId: string
  name: string
}

export function AgentPortInCard({ agents }: { agents: PortInAgentOption[] }) {
  const router = useRouter()
  const [agentId, setAgentId] = useState("")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [twilioSid, setTwilioSid] = useState("")
  const [source, setSource] = useState<"manually_added" | "ported_in">("manually_added")
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (agents.length === 0) return null

  function handleAdd() {
    setError(null)
    setOk(null)
    startTransition(async () => {
      const r = await manuallyAddAgentPhone({
        agentId,
        phoneNumber: phoneNumber.trim(),
        twilioSid: twilioSid.trim() || undefined,
        source,
      }).catch(() => ({ success: false, error: "Could not reach the server" }) as const)

      if (!r.success) {
        // Includes the collision refusal and the ownership-proof refusal.
        // Shown as written — this must never read as "added" when it was not.
        setError(r.error ?? "Could not add that number")
        return
      }
      const bindNote = (r as { bound?: boolean; bindNote?: string }).bindNote
      setOk(
        bindNote
          ? `${r.phoneNumber} added — ${bindNote}`
          : `${r.phoneNumber} added and routed to the AI voice lane.`
      )
      setPhoneNumber("")
      setTwilioSid("")
      router.refresh()
    })
  }

  return (
    <Card className="mx-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <PhoneForwarded className="h-4 w-4" />
          Add a number you already own
        </CardTitle>
        <CardDescription className="text-xs">
          Bind an existing number — one you are porting in, or one already in your
          brokerage&apos;s Twilio account — to a specific agent. We verify the number really
          belongs to your account before routing anything to it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="portin-agent" className="text-xs">Agent</Label>
            <select
              id="portin-agent"
              className="w-full rounded border px-2 py-2 text-sm bg-background"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">Select an agent…</option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="portin-number" className="text-xs">Phone number</Label>
            <Input
              id="portin-number"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+15125551234"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="portin-sid" className="text-xs">
              Twilio number SID <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="portin-sid"
              value={twilioSid}
              onChange={(e) => setTwilioSid(e.target.value)}
              placeholder="PN…"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="portin-source" className="text-xs">How you got it</Label>
            <select
              id="portin-source"
              className="w-full rounded border px-2 py-2 text-sm bg-background"
              value={source}
              onChange={(e) => setSource(e.target.value as "manually_added" | "ported_in")}
            >
              <option value="manually_added">Already in our Twilio account</option>
              <option value="ported_in">Ported in from another carrier</option>
            </select>
          </div>
        </div>

        {error && (
          <p className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </p>
        )}
        {ok && (
          <p className="flex items-start gap-2 text-xs text-green-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{ok}</span>
          </p>
        )}

        <Button size="sm" onClick={handleAdd} disabled={isPending || !agentId || !phoneNumber.trim()}>
          {isPending ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Verifying…</>
          ) : (
            "Add number to agent"
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
