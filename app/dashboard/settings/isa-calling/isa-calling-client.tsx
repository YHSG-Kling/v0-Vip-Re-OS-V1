"use client"

import { useState, useTransition } from "react"
import {
  Phone,
  Plus,
  Trash2,
  PhoneCall,
  PhoneIncoming,
  PhoneForwarded,
  Loader2,
  Check,
  X,
} from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog"
import {
  createIsaPhoneNumber,
  deleteIsaPhoneNumber,
  toggleIsaPhoneNumber,
  type VapiPhoneNumberRow,
} from "@/app/actions/isa-phone-numbers"
import {
  saveAIISASettings,
  type IsaCapability,
  type IsaCapabilityDescriptor,
} from "@/app/actions/ai-isa-settings"
import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react"

interface DutyAgent {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

interface Props {
  brokerageId: string
  phoneNumbers: VapiPhoneNumberRow[]
  dutyAgent: DutyAgent | null
  currentUserRole: string | null
  capabilityCatalog: IsaCapabilityDescriptor[]
  enabledCapabilities: IsaCapability[]
}

const NUMBER_SOURCE_LABELS: Record<string, string> = {
  vapi_native: "VAPI Native (purchased through VAPI)",
  ported: "Ported (your existing number transferred to VAPI)",
  byoc_twilio: "BYOC — Twilio (SIP trunk)",
  byoc_vonage: "BYOC — Vonage (SIP trunk)",
  forwarded: "Call Forwarding (existing number forwards to VAPI)",
}

const DEPARTMENTS = [
  { value: "sales_isa", label: "Sales / ISA" },
  { value: "transaction_coordinator", label: "Transaction Coordinator" },
  { value: "showings", label: "Showings" },
  { value: "front_desk", label: "Front Desk" },
  { value: "main", label: "Main Line" },
]

export function IsaCallingClient(props: Props) {
  const { brokerageId, phoneNumbers: initialNumbers, dutyAgent, capabilityCatalog, enabledCapabilities: initialEnabledCapabilities } = props
  const [isPending, startTransition] = useTransition()
  const [numbers, setNumbers] = useState(initialNumbers)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enabledCapabilities, setEnabledCapabilities] = useState<Set<IsaCapability>>(
    new Set(initialEnabledCapabilities)
  )

  function handleToggleCapability(capability: IsaCapability) {
    const next = new Set(enabledCapabilities)
    if (next.has(capability)) next.delete(capability)
    else next.add(capability)
    setEnabledCapabilities(next)

    startTransition(async () => {
      await saveAIISASettings(brokerageId, {
        enabled_capabilities: Array.from(next),
      })
    })
  }

  // New phone number form state
  const [newPhoneNumber, setNewPhoneNumber] = useState("")
  const [newVapiId, setNewVapiId] = useState("")
  const [newSource, setNewSource] = useState<VapiPhoneNumberRow["number_source"]>("vapi_native")
  const [newDepartment, setNewDepartment] = useState("sales_isa")
  const [newByocCredId, setNewByocCredId] = useState("")
  const [newForwardingTarget, setNewForwardingTarget] = useState("")

  const dutyAgentDisplay = dutyAgent
    ? `${dutyAgent.first_name ?? ""} ${dutyAgent.last_name ?? ""}`.trim() ||
      dutyAgent.email ||
      "Admin"
    : "No admin assigned"

  function resetForm() {
    setNewPhoneNumber("")
    setNewVapiId("")
    setNewSource("vapi_native")
    setNewDepartment("sales_isa")
    setNewByocCredId("")
    setNewForwardingTarget("")
    setError(null)
  }

  function handleAdd() {
    if (!newPhoneNumber || !newVapiId) {
      setError("Phone number and VAPI Phone ID are required")
      return
    }
    startTransition(async () => {
      const result = await createIsaPhoneNumber({
        brokerageId,
        scopeType: "brokerage",
        vapiPhoneNumberId: newVapiId,
        phoneNumber: newPhoneNumber,
        numberSource: newSource,
        department: newDepartment,
        byocCredentialId: newByocCredId || undefined,
        forwardingTarget: newForwardingTarget || undefined,
      })
      if (!result.success) {
        setError(result.error ?? "Failed to add number")
        return
      }
      // Optimistic add
      setNumbers([
        {
          id: result.id ?? crypto.randomUUID(),
          brokerage_id: brokerageId,
          team_id: null,
          agent_user_id: null,
          scope_type: "brokerage",
          vapi_phone_number_id: newVapiId,
          phone_number: newPhoneNumber,
          phone_digits: newPhoneNumber.replace(/\D/g, "").slice(-10),
          number_source: newSource,
          byoc_credential_id: newByocCredId || null,
          forwarding_target: newForwardingTarget || null,
          department: newDepartment,
          ivr_enabled: false,
          ivr_menu: null,
          is_active: true,
          created_at: new Date().toISOString(),
        },
        ...numbers,
      ])
      setAddDialogOpen(false)
      resetForm()
    })
  }

  function handleToggle(id: string, current: boolean) {
    startTransition(async () => {
      const result = await toggleIsaPhoneNumber({
        id,
        brokerageId,
        active: !current,
      })
      if (result.success) {
        setNumbers(numbers.map((n) => (n.id === id ? { ...n, is_active: !current } : n)))
      }
    })
  }

  function handleDelete(id: string) {
    if (!confirm("Remove this phone number from ISA routing?")) return
    startTransition(async () => {
      const result = await deleteIsaPhoneNumber({ id, brokerageId })
      if (result.success) {
        setNumbers(numbers.filter((n) => n.id !== id))
      }
    })
  }

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">ISA Calling</h1>
        <p className="text-muted-foreground text-sm">
          Configure inbound + outbound phone numbers for the AI ISA. Numbers can
          be VAPI-native, ported, BYOC (Twilio/Vonage SIP), or forwarded from
          your existing line.
        </p>
      </div>

      <Tabs defaultValue="numbers" className="space-y-4">
        <TabsList>
          <TabsTrigger value="numbers" className="gap-1.5">
            <Phone className="h-4 w-4" />
            Phone Numbers
          </TabsTrigger>
          <TabsTrigger value="capabilities" className="gap-1.5">
            <ShieldCheck className="h-4 w-4" />
            Capabilities
          </TabsTrigger>
          <TabsTrigger value="duty" className="gap-1.5">
            <PhoneForwarded className="h-4 w-4" />
            Transfer & Duty Agent
          </TabsTrigger>
          <TabsTrigger value="voice" className="gap-1.5">
            <PhoneCall className="h-4 w-4" />
            Voice Provider
          </TabsTrigger>
        </TabsList>

        <TabsContent value="numbers" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Brokerage Phone Numbers</CardTitle>
                <CardDescription>
                  {numbers.length === 0
                    ? "No numbers configured yet."
                    : `${numbers.length} number${numbers.length === 1 ? "" : "s"} active in routing.`}
                </CardDescription>
              </div>
              <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="gap-1.5">
                    <Plus className="h-4 w-4" />
                    Add Number
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Add Phone Number</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 py-2">
                    <div>
                      <label className="text-xs font-medium block mb-1">
                        Number Source
                      </label>
                      <Select value={newSource} onValueChange={(v) => setNewSource(v as VapiPhoneNumberRow["number_source"])}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(NUMBER_SOURCE_LABELS).map(([k, v]) => (
                            <SelectItem key={k} value={k}>
                              {v}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <label className="text-xs font-medium block mb-1">
                        Phone Number (E.164: +15551234567)
                      </label>
                      <Input
                        placeholder="+15551234567"
                        value={newPhoneNumber}
                        onChange={(e) => setNewPhoneNumber(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="text-xs font-medium block mb-1">
                        VAPI Phone Number ID
                      </label>
                      <Input
                        placeholder="phn_xxx (from VAPI dashboard)"
                        value={newVapiId}
                        onChange={(e) => setNewVapiId(e.target.value)}
                      />
                    </div>

                    {(newSource === "byoc_twilio" || newSource === "byoc_vonage") && (
                      <div>
                        <label className="text-xs font-medium block mb-1">
                          BYOC Credential ID (from VAPI Credentials)
                        </label>
                        <Input
                          placeholder="cred_xxx"
                          value={newByocCredId}
                          onChange={(e) => setNewByocCredId(e.target.value)}
                        />
                      </div>
                    )}

                    {newSource === "forwarded" && (
                      <div>
                        <label className="text-xs font-medium block mb-1">
                          Forwarding Target (where original number forwards to)
                        </label>
                        <Input
                          placeholder="+15551234567"
                          value={newForwardingTarget}
                          onChange={(e) => setNewForwardingTarget(e.target.value)}
                        />
                      </div>
                    )}

                    <div>
                      <label className="text-xs font-medium block mb-1">
                        Department
                      </label>
                      <Select value={newDepartment} onValueChange={setNewDepartment}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DEPARTMENTS.map((d) => (
                            <SelectItem key={d.value} value={d.value}>
                              {d.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {error && (
                      <p className="text-xs text-red-600">{error}</p>
                    )}
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setAddDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleAdd} disabled={isPending}>
                      {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Number"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardHeader>
            <CardContent className="space-y-2">
              {numbers.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  <PhoneIncoming className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  <p>No phone numbers configured.</p>
                  <p className="text-xs mt-1">
                    Click <span className="font-medium">Add Number</span> to wire one up.
                  </p>
                </div>
              ) : (
                numbers.map((num) => (
                  <div
                    key={num.id}
                    className="flex items-center justify-between p-3 border rounded-lg bg-card"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">
                          {num.phone_number}
                        </span>
                        <Badge variant={num.is_active ? "default" : "secondary"} className="text-[10px]">
                          {num.is_active ? "active" : "paused"}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {NUMBER_SOURCE_LABELS[num.number_source].split(" ")[0]}
                        </Badge>
                        {num.department && (
                          <Badge variant="outline" className="text-[10px]">
                            {num.department}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        VAPI ID: <span className="font-mono">{num.vapi_phone_number_id}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={num.is_active}
                        onCheckedChange={() => handleToggle(num.id, num.is_active)}
                        disabled={isPending}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleDelete(num.id)}
                        disabled={isPending}
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="capabilities" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>AI ISA Capabilities</CardTitle>
              <CardDescription>
                Approve which actions the AI ISA can take on calls and conversations.
                Disabled capabilities are politely declined with a fallback message
                ("I'll have someone reach out shortly"). Brokerage admins control
                this setting.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {(["core", "compliance", "outreach", "booking", "information", "ghost", "reputation"] as const).map((category) => {
                const items = capabilityCatalog.filter((c) => c.category === category)
                if (items.length === 0) return null
                return (
                  <div key={category}>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-2">
                      {category === "core"
                        ? "Core (recommended always on)"
                        : category === "compliance"
                        ? "Compliance & DNC (recommended always on)"
                        : category === "outreach"
                        ? "Outreach actions"
                        : category === "booking"
                        ? "Booking & scheduling"
                        : category === "information"
                        ? "Information lookups (existing contacts)"
                        : category === "ghost"
                        ? "Ghost re-engagement"
                        : "Reputation & reviews"}
                    </p>
                    <div className="space-y-2">
                      {items.map((cap) => {
                        const isEnabled = enabledCapabilities.has(cap.key)
                        const RiskIcon = cap.riskLevel === "high"
                          ? ShieldX
                          : cap.riskLevel === "medium"
                          ? ShieldAlert
                          : ShieldCheck
                        const riskColor = cap.riskLevel === "high"
                          ? "text-red-600 dark:text-red-400"
                          : cap.riskLevel === "medium"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-green-600 dark:text-green-400"
                        return (
                          <div
                            key={cap.key}
                            className="flex items-start justify-between gap-3 p-3 border rounded-lg bg-card"
                          >
                            <div className="flex items-start gap-2 min-w-0 flex-1">
                              <RiskIcon className={`h-4 w-4 mt-0.5 shrink-0 ${riskColor}`} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-medium text-sm">{cap.label}</span>
                                  {cap.requiresConsent && (
                                    <Badge variant="outline" className="text-[10px]">consent required</Badge>
                                  )}
                                  {!cap.defaultEnabled && (
                                    <Badge variant="outline" className="text-[10px]">opt-in</Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {cap.description}
                                </p>
                              </div>
                            </div>
                            <Switch
                              checked={isEnabled}
                              onCheckedChange={() => handleToggleCapability(cap.key)}
                              disabled={isPending}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              <div className="text-xs text-muted-foreground border-t pt-3">
                Changes take effect on the AI ISA's next call. Existing call logs
                and recordings are not affected. TCPA, DNC, and Fair Housing rules
                are enforced regardless of these toggles.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="duty" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Transfer & Duty Agent</CardTitle>
              <CardDescription>
                When the AI ISA can't resolve a caller's request, it transfers
                the call to the duty agent. Duty agent = brokerage admin (or
                team admin / solo agent for those scopes).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="p-3 rounded-lg border bg-muted/40">
                <p className="text-xs text-muted-foreground mb-1">Current Duty Agent</p>
                <div className="flex items-center gap-2">
                  {dutyAgent ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <X className="h-4 w-4 text-amber-600" />
                  )}
                  <span className="font-medium text-sm">{dutyAgentDisplay}</span>
                  {dutyAgent?.email && (
                    <span className="text-xs text-muted-foreground">({dutyAgent.email})</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Duty agent is the user with role <code>Admin</code> in this
                  brokerage. To change, update that user's role in Settings →
                  Team.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="voice" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Voice Provider</CardTitle>
              <CardDescription>
                The AI ISA speaks with your default twin's voice clone. Set up
                or switch your default twin in Twin Studio.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <a
                href="/dashboard/settings/twin-studio"
                className="block p-3 border rounded-lg hover:bg-muted/40 transition"
              >
                <p className="font-medium text-sm">Twin Studio →</p>
                <p className="text-xs text-muted-foreground">
                  Manage your AI digital twins — look, voice, personality.
                  Pick which one represents you on calls.
                </p>
              </a>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
