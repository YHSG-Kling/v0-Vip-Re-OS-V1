"use client"

/**
 * PICK OR PORT (wave 83D — owner: "the person picks a number or ports and auto
 * business listing approval.").
 *
 * One choice, two paths, one outcome:
 *   PICK — a new LOCAL number near the office. The picker already exists (the
 *          "Add a Number" card, id="pick-a-number", wave 82D); this card sends
 *          the person there rather than drawing a second picker.
 *   PORT — keep the number clients already call. Twilio's Porting API files the
 *          request; Twilio e-mails the Letter of Authorization to the person
 *          who signs; an hourly check follows the port and connects the number
 *          to the AI line the moment it completes.
 * Either way, business registration (A2P 10DLC) files itself from the
 * brokerage profile and the phone test unlocks on carrier approval.
 * Every refusal from the server is shown as written — never "done" when it wasn't.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { PhoneIncoming, MapPin, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react"
import { getPortInStatusAction, submitPortInAction, checkPortabilityAction, type PortInStatusView } from "@/app/actions/phone-port-in"

export interface PickOrPortAgentOption { agentId: string; name: string }

const PHASE_TONE: Record<string, string> = {
  completed: "border-green-200 bg-green-50 text-green-700",
  landing: "border-green-200 bg-green-50 text-green-700",
  action_required: "border-red-200 bg-red-50 text-red-700",
  canceled: "border-muted text-muted-foreground",
  waiting_for_signature: "border-amber-200 bg-amber-50 text-amber-800",
}

export function PickOrPortCard({ agents }: { agents: PickOrPortAgentOption[] }) {
  const [mode, setMode] = useState<"pick" | "port">("pick")
  const [ports, setPorts] = useState<PortInStatusView[]>([])
  const [defaultDate, setDefaultDate] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [ok, setOk] = useState<string | null>(null)
  const [pinNumbers, setPinNumbers] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    getPortInStatusAction().then((r) => {
      if (r.ok) { setPorts(r.ports); setDefaultDate(r.defaultTargetDate); if (r.ports.length) setMode("port") }
    }).catch(() => {})
  }, [])

  function checkPortable(raw: string) {
    const phoneNumbers = raw.split(/[\s,;]+/).filter(Boolean)
    if (!phoneNumbers.length) return
    startTransition(async () => {
      const r = await checkPortabilityAction({ phoneNumbers }).catch(() => ({ ok: false as const, error: "Could not reach the server" }))
      if (!r.ok) { setError(r.error); return }
      setError(null)
      const blocked = r.verdicts.filter((v) => !v.portable)
      setMissing(blocked.map((v) => `${v.phoneNumber} cannot be ported${v.notPortableReason ? `: ${v.notPortableReason}` : ""}`))
      setPinNumbers(r.verdicts.filter((v) => v.pinAndAccountNumberRequired).map((v) => v.phoneNumber))
    })
  }

  function submit(form: HTMLFormElement) {
    setError(null); setOk(null); setMissing([])
    const fd = new FormData(form)
    startTransition(async () => {
      const r = await submitPortInAction(fd).catch(() => ({ ok: false as const, error: "Could not reach the server" }))
      if (!r.ok) { setError(r.error); setMissing((r as { missing?: string[] }).missing ?? []); return }
      setOk(`${r.port.headline} ${r.port.nextStep}`)
      setPorts((p) => [r.port, ...p.filter((x) => x.sid !== r.port.sid)])
      form.reset()
    })
  }

  return (
    <Card className="mx-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <PhoneIncoming className="h-4 w-4" />
          Your business number — pick one or bring yours
        </CardTitle>
        <CardDescription className="text-xs">
          Pick a new local number near your office, or port the number your clients already call.
          Either way we register your business with the carriers automatically and unlock the phone
          test the moment they approve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex gap-2">
          <Button size="sm" variant={mode === "pick" ? "default" : "outline"} onClick={() => setMode("pick")}>Pick a local number</Button>
          <Button size="sm" variant={mode === "port" ? "default" : "outline"} onClick={() => setMode("port")}>Port my number</Button>
        </div>

        {mode === "pick" && (
          <div className="rounded border p-3 text-xs space-y-2">
            <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />
              We search your own area code first, then the numbers nearest your office (by distance), then your city and state.
              Toll-free is optional and off by default.
            </p>
            <Button size="sm" variant="outline" onClick={() => document.getElementById("pick-a-number")?.scrollIntoView({ behavior: "smooth" })}>
              Find local numbers
            </Button>
          </div>
        )}

        {mode === "port" && (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(e.currentTarget) }}>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="port-numbers" className="text-xs">Number(s) to port — local or mobile (toll-free ports go through Twilio support)</Label>
              <Input id="port-numbers" name="phoneNumbers" placeholder="+15125551234, +15125559876" onBlur={(e) => checkPortable(e.target.value)} autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="port-customer" className="text-xs">Account holder (exactly as your carrier has it)</Label>
              <Input id="port-customer" name="customerName" autoComplete="organization" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="port-type" className="text-xs">Account type</Label>
              <select id="port-type" name="customerType" className="w-full rounded border px-2 py-2 text-sm bg-background" defaultValue="Business">
                <option value="Business">Business</option>
                <option value="Individual">Individual</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="port-acct" className="text-xs">Carrier account number {pinNumbers.length ? "(required)" : "(if you have it)"}</Label>
              <Input id="port-acct" name="accountNumber" autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="port-btn" className="text-xs">Account phone number (billing telephone)</Label>
              <Input id="port-btn" name="accountTelephoneNumber" autoComplete="off" />
            </div>
            {pinNumbers.map((n) => (
              <div key={n} className="space-y-1">
                <Label htmlFor={`pin-${n}`} className="text-xs">Port-out PIN for {n} (from your current carrier)</Label>
                <Input id={`pin-${n}`} name={`pin:${n}`} autoComplete="off" />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="port-rep" className="text-xs">Who signs the authorization</Label>
              <Input id="port-rep" name="authorizedRepresentative" autoComplete="name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="port-rep-email" className="text-xs">Their e-mail (the LOA is sent here)</Label>
              <Input id="port-rep-email" name="authorizedRepresentativeEmail" type="email" autoComplete="email" />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="port-street" className="text-xs">Service address (as on the carrier bill)</Label>
              <Input id="port-street" name="street" autoComplete="address-line1" />
            </div>
            <Input name="street2" placeholder="Suite / floor (optional)" autoComplete="address-line2" />
            <Input name="city" placeholder="City" autoComplete="address-level2" />
            <Input name="state" placeholder="State" autoComplete="address-level1" />
            <Input name="zip" placeholder="ZIP" autoComplete="postal-code" />
            <div className="space-y-1">
              <Label htmlFor="port-date" className="text-xs">Target port date (at least 7 days out)</Label>
              <Input id="port-date" name="targetPortInDate" type="date" defaultValue={defaultDate} />
            </div>
            {agents.length > 0 && (
              <div className="space-y-1">
                <Label htmlFor="port-agent" className="text-xs">Lands on (optional)</Label>
                <select id="port-agent" name="agentId" className="w-full rounded border px-2 py-2 text-sm bg-background" defaultValue="">
                  <option value="">The brokerage (office line)</option>
                  {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
                </select>
              </div>
            )}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="port-bill" className="text-xs">Recent phone bill (PDF or image, last 30 days, ≤10 MB)</Label>
              <Input id="port-bill" name="utilityBill" type="file" accept="application/pdf,image/*" />
            </div>
            <div className="sm:col-span-2">
              <Button size="sm" type="submit" disabled={isPending}>
                {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Filing…</> : "Request the port"}
              </Button>
            </div>
          </form>
        )}

        {(error || missing.length > 0) && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 space-y-1">
            {error && <p className="flex items-start gap-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{error}</p>}
            {missing.length > 0 && <ul className="list-disc ml-5">{missing.map((m) => <li key={m}>{m}</li>)}</ul>}
          </div>
        )}
        {ok && <p className="flex items-start gap-2 text-xs text-green-700"><CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />{ok}</p>}

        {ports.length > 0 && (
          <div className="divide-y rounded-md border">
            {ports.map((p) => (
              <div key={p.sid} className="p-2.5 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={PHASE_TONE[p.phase] ?? ""}>{p.phase.replace(/_/g, " ")}</Badge>
                  <span className="text-xs font-medium">{p.numbers.map((n) => n.phone).join(", ")}</span>
                  {p.targetDate && <span className="text-[10px] text-muted-foreground">target {p.targetDate}</span>}
                </div>
                <p className="text-xs">{p.headline}</p>
                <p className="text-xs text-muted-foreground">Next: {p.nextStep}</p>
                {p.signatureUrl && p.phase === "waiting_for_signature" && (
                  <a className="text-xs underline" href={p.signatureUrl} target="_blank" rel="noreferrer">Open the authorization to sign</a>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
