"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Plus, DollarSign, CheckCircle2, XCircle, Loader2 } from "lucide-react"
import {
  createFeeType, toggleFeeType, markChargePaid, waiveCharge,
  type FeeType, type AgentFeeCharge, type FeeCadence, type AppliesTo,
} from "@/app/actions/brokerage-fees"

interface Props {
  initialFeeTypes: FeeType[]
  initialCharges: AgentFeeCharge[]
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
}

const STATUS_COLOR: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  paid: "bg-green-100 text-green-800",
  overdue: "bg-red-100 text-red-800",
  waived: "bg-gray-100 text-gray-600",
  disputed: "bg-orange-100 text-orange-800",
}

export function BrokerageFeesClient({ initialFeeTypes, initialCharges }: Props) {
  const [feeTypes, setFeeTypes] = useState(initialFeeTypes)
  const [charges, setCharges] = useState(initialCharges)
  const [tab, setTab] = useState<"fees" | "charges">("fees")
  const [createOpen, setCreateOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  // Create form state
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [cadence, setCadence] = useState<FeeCadence>("monthly")
  const [appliesTo, setAppliesTo] = useState<AppliesTo>("all_agents")
  const [createError, setCreateError] = useState<string | null>(null)

  function reset() {
    setName(""); setDescription(""); setAmount("")
    setCadence("monthly"); setAppliesTo("all_agents")
    setCreateError(null)
  }

  function handleCreate() {
    if (!name.trim() || !amount || parseFloat(amount) <= 0) {
      setCreateError("Name and a positive amount are required")
      return
    }
    startTransition(async () => {
      const result = await createFeeType({
        name: name.trim(),
        description: description.trim() || undefined,
        amount: parseFloat(amount),
        cadence,
        appliesTo,
      })
      if (result.success && result.feeTypeId) {
        // Re-fetch by adding optimistic entry; simplest is just refresh page
        window.location.reload()
      } else {
        setCreateError(result.error ?? "Failed to create fee")
      }
    })
  }

  async function handleToggle(feeTypeId: string, isActive: boolean) {
    const r = await toggleFeeType({ feeTypeId, isActive })
    if (r.success) {
      setFeeTypes((fs) => fs.map((f) => (f.id === feeTypeId ? { ...f, isActive } : f)))
    }
  }

  async function handleMarkPaid(chargeId: string) {
    const r = await markChargePaid({ chargeId, paymentMethod: "manual" })
    if (r.success) {
      setCharges((cs) =>
        cs.map((c) =>
          c.id === chargeId ? { ...c, status: "paid", paidAt: new Date().toISOString() } : c
        )
      )
    }
  }

  async function handleWaive(chargeId: string) {
    const r = await waiveCharge({ chargeId })
    if (r.success) {
      setCharges((cs) => cs.map((c) => (c.id === chargeId ? { ...c, status: "waived" } : c)))
    }
  }

  const totalOpen = charges.filter((c) => c.status === "open").reduce((s, c) => s + c.amount, 0)
  const totalPaid = charges.filter((c) => c.status === "paid").reduce((s, c) => s + c.amount, 0)
  const overdueCount = charges.filter((c) => c.status === "overdue").length

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="h-6 w-6 text-green-600" />
            Brokerage Fees
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recurring and one-time fees agents owe the brokerage (tech, desk, E&O, etc).
            Separate from commissions, which flow via CDA at closing.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) reset() }}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              New Fee
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Fee Type</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tech Fee" />
              </div>
              <div>
                <Label>Description (optional)</Label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Monthly tech stack access" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Amount</Label>
                  <Input type="number" min="0" step="0.01" value={amount}
                    onChange={(e) => setAmount(e.target.value)} placeholder="49.00" />
                </div>
                <div>
                  <Label>Cadence</Label>
                  <Select value={cadence} onValueChange={(v) => setCadence(v as FeeCadence)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="quarterly">Quarterly</SelectItem>
                      <SelectItem value="annual">Annual</SelectItem>
                      <SelectItem value="per_transaction">Per Transaction</SelectItem>
                      <SelectItem value="one_time">One-time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Applies To</Label>
                <Select value={appliesTo} onValueChange={(v) => setAppliesTo(v as AppliesTo)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all_agents">All Agents</SelectItem>
                    <SelectItem value="specific_agents">Specific Agents</SelectItem>
                    <SelectItem value="role">By Role</SelectItem>
                    <SelectItem value="team">By Team</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {createError && <p className="text-xs text-red-600">{createError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create Fee"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <StatCard label="Active Fee Types" value={String(feeTypes.filter((f) => f.isActive).length)} />
        <StatCard label="Open Charges" value={fmt(totalOpen)} variant="warning" />
        <StatCard label="Paid (this period)" value={fmt(totalPaid)} variant="success" />
        <StatCard label="Overdue" value={String(overdueCount)} variant={overdueCount > 0 ? "danger" : undefined} />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        <button onClick={() => setTab("fees")}
          className={`px-3 py-2 text-sm border-b-2 ${tab === "fees" ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}>
          Fee Types
        </button>
        <button onClick={() => setTab("charges")}
          className={`px-3 py-2 text-sm border-b-2 ${tab === "charges" ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}>
          Agent Charges
        </button>
      </div>

      {tab === "fees" && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Fee Types</CardTitle></CardHeader>
          <CardContent className="p-0">
            {feeTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No fees yet.</p>
            ) : (
              <div className="divide-y">
                {feeTypes.map((f) => (
                  <div key={f.id} className="px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm">{f.name}</p>
                        <Badge variant="outline" className="text-xs capitalize">{f.cadence.replace(/_/g, " ")}</Badge>
                        <Badge variant="outline" className="text-xs capitalize">{f.appliesTo.replace(/_/g, " ")}</Badge>
                        {!f.isActive && <Badge variant="secondary" className="text-xs">Inactive</Badge>}
                      </div>
                      {f.description && <p className="text-xs text-muted-foreground mt-0.5">{f.description}</p>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold">{fmt(f.amount)}</span>
                      <Button size="sm" variant="ghost" onClick={() => handleToggle(f.id, !f.isActive)}>
                        {f.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "charges" && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Agent Charges</CardTitle></CardHeader>
          <CardContent className="p-0">
            {charges.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No charges generated yet.</p>
            ) : (
              <div className="divide-y">
                {charges.map((c) => (
                  <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">{c.agentName}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.feeTypeName} · {new Date(c.periodStart).toLocaleDateString()}
                        {c.dueDate && ` · due ${new Date(c.dueDate).toLocaleDateString()}`}
                      </p>
                    </div>
                    <span className="font-semibold">{fmt(c.amount)}</span>
                    <Badge className={`text-xs capitalize ${STATUS_COLOR[c.status] ?? ""}`}>{c.status}</Badge>
                    {c.status === "open" && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleMarkPaid(c.id)}>
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Paid
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleWaive(c.id)}>
                          <XCircle className="h-3 w-3 mr-1" /> Waive
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function StatCard({
  label, value, variant,
}: {
  label: string
  value: string
  variant?: "success" | "warning" | "danger"
}) {
  const colorClass =
    variant === "danger"
      ? "text-red-600"
      : variant === "warning"
      ? "text-amber-600"
      : variant === "success"
      ? "text-green-600"
      : "text-gray-900"

  return (
    <Card>
      <CardContent className="p-3 text-center">
        <p className={`text-xl font-bold ${colorClass}`}>{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </CardContent>
    </Card>
  )
}
