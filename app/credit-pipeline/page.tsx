"use client"

import { useState, useEffect } from "react"
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DollarSign, TrendingUp, Clock, Plus } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"
import { advanceCreditFlow, getCreditPipelineStats, createCreditAccount } from "@/app/actions/credit-copilot"
import { getContacts } from "@/app/actions/contacts"

const FLOW_STAGES = [
  { id: "flow_a", name: "Lead", color: "bg-gray-500" },
  { id: "flow_b", name: "Application", color: "bg-blue-500" },
  { id: "flow_c", name: "Submitted", color: "bg-yellow-500" },
  { id: "flow_d", name: "Approved", color: "bg-green-500" },
  { id: "flow_e", name: "Funded", color: "bg-purple-500" },
]

interface CreditAccount {
  id: string
  contact_id: string
  partner_name: string
  account_status: string
  credit_amount: number
  current_stage: string
  stage_history: any[]
  contact?: {
    first_name: string
    last_name: string
  }
}

interface PipelineStats {
  success: boolean
  error?: string
  total_value: number
  total_accounts: number
  avg_time_to_close: number
  by_stage: Record<string, number>
  accounts: CreditAccount[]
  /** null = no budget row for this agent this month, which is not the same as $0. */
  budget: { used: number; limit: number } | null
}

interface PickerContact {
  id: string
  first_name: string | null
  last_name: string | null
}

export default function CreditPipelinePage() {
  const [accounts, setAccounts] = useState<CreditAccount[]>([])
  const [stats, setStats] = useState<PipelineStats | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  )

  useEffect(() => {
    loadPipeline()
  }, [])

  async function loadPipeline() {
    try {
      // The agent is resolved SERVER-side (agents.id ≠ users.id) — the client
      // never supplies the scoping id.
      const pipelineStats = await getCreditPipelineStats()
      if (!pipelineStats.success) {
        toast.error(pipelineStats.error || "Could not load the credit pipeline")
        return
      }
      setStats(pipelineStats)
      setAccounts(pipelineStats.accounts || [])
    } catch (error: any) {
      toast.error(error?.message || "Could not load the credit pipeline")
    } finally {
      setLoading(false)
    }
  }

  async function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)

    if (!over || active.id === over.id) return

    const accountId = active.id as string
    const newStage = over.id as string

    try {
      const res = await advanceCreditFlow(accountId, newStage)
      if (!res?.success) {
        toast.error("The stage change was not saved")
        return
      }
      await loadPipeline()
    } catch (error: any) {
      toast.error(error?.message || "The stage change was not saved")
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center h-96">
          <div className="text-muted-foreground">Loading pipeline...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8">
      {/* Header with Stats */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-4">Credit Pipeline</h1>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatsCard
            icon={DollarSign}
            label="Total Pipeline Value"
            value={`$${stats?.total_value?.toLocaleString() || 0}`}
            color="text-green-500"
          />
          <StatsCard
            icon={TrendingUp}
            label="Active Accounts"
            value={stats?.total_accounts || 0}
            color="text-blue-500"
          />
          <StatsCard
            icon={Clock}
            label="Avg Time to Close"
            value={`${stats?.avg_time_to_close || 0} days`}
            color="text-orange-500"
          />
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Budget Used</span>
                  <span className="font-medium">
                    {stats?.budget
                      ? `$${stats.budget.used.toLocaleString()} / $${stats.budget.limit.toLocaleString()}`
                      : "Not set"}
                  </span>
                </div>
                <Progress
                  value={
                    stats?.budget && stats.budget.limit > 0
                      ? Math.min(100, Math.round((stats.budget.used / stats.budget.limit) * 100))
                      : 0
                  }
                />
                {!stats?.budget && (
                  <p className="text-xs text-muted-foreground">
                    No credit budget recorded for this month yet
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Kanban Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {FLOW_STAGES.map((stage) => (
            <FlowStageColumn
              key={stage.id}
              stage={stage}
              accounts={accounts.filter((a) => a.current_stage === stage.id)}
              count={stats?.by_stage?.[stage.id] || 0}
            />
          ))}
        </div>

        <DragOverlay>
          {activeId ? <AccountCard account={accounts.find((a) => a.id === activeId)!} isDragging /> : null}
        </DragOverlay>
      </DndContext>

      {/* Add Account Button */}
      <Button
        className="fixed bottom-8 right-8 rounded-full h-14 w-14"
        size="icon"
        aria-label="Add credit account"
        onClick={() => setAddOpen(true)}
      >
        <Plus className="h-6 w-6" />
      </Button>

      <NewCreditAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={loadPipeline}
      />
    </div>
  )
}

// Component: New Credit Account dialog — the FAB's destination.
// Writes through createCreditAccount (credit_accounts + agent_credit_budgets usage).
function NewCreditAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => Promise<void> | void
}) {
  const [contacts, setContacts] = useState<PickerContact[]>([])
  const [contactId, setContactId] = useState("")
  const [partnerName, setPartnerName] = useState("")
  const [amount, setAmount] = useState("")
  const [stage, setStage] = useState("flow_a")
  const [saving, setSaving] = useState(false)
  const [loadingContacts, setLoadingContacts] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingContacts(true)
    getContacts({ limit: 200 })
      .then((res) => {
        if (cancelled) return
        if (!res.success) {
          toast.error(res.error || "Could not load contacts")
          return
        }
        setContacts((res.contacts ?? []) as PickerContact[])
      })
      .catch((e: any) => {
        if (!cancelled) toast.error(e?.message || "Could not load contacts")
      })
      .finally(() => {
        if (!cancelled) setLoadingContacts(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  async function handleCreate() {
    const parsedAmount = Number(amount)
    if (!contactId) {
      toast.error("Choose the contact this credit account belongs to")
      return
    }
    if (!partnerName.trim()) {
      toast.error("Enter the credit partner")
      return
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error("Enter a credit amount greater than zero")
      return
    }

    setSaving(true)
    try {
      const res = await createCreditAccount({
        contact_id: contactId,
        partner_name: partnerName.trim(),
        credit_amount: parsedAmount,
        initial_stage: stage,
      })
      if (!res?.success) {
        toast.error("The credit account was not created")
        return
      }
      toast.success("Credit account created")
      setContactId("")
      setPartnerName("")
      setAmount("")
      setStage("flow_a")
      onOpenChange(false)
      await onCreated()
    } catch (error: any) {
      toast.error(error?.message || "The credit account was not created")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New credit account</DialogTitle>
          <DialogDescription>
            Put a contact into the credit pipeline. The stage you pick fires that stage&apos;s follow-up automation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="credit-contact">Contact</Label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger id="credit-contact">
                <SelectValue placeholder={loadingContacts ? "Loading contacts…" : "Select a contact"} />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed contact"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!loadingContacts && contacts.length === 0 && (
              <p className="text-xs text-muted-foreground">No contacts are assigned to you yet.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="credit-partner">Credit partner</Label>
            <Input
              id="credit-partner"
              value={partnerName}
              onChange={(e) => setPartnerName(e.target.value)}
              placeholder="e.g. Summit Credit Restoration"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="credit-amount">Credit amount</Label>
            <Input
              id="credit-amount"
              type="number"
              min={0}
              step={100}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="2500"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="credit-stage">Starting stage</Label>
            <Select value={stage} onValueChange={setStage}>
              <SelectTrigger id="credit-stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FLOW_STAGES.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving ? "Creating…" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Component: Stats Card
function StatsCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any
  label: string
  value: string | number
  color: string
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <Icon className={`h-8 w-8 ${color}`} />
        </div>
      </CardContent>
    </Card>
  )
}

// Component: Flow Stage Column
function FlowStageColumn({
  stage,
  accounts,
  count,
}: {
  stage: { id: string; name: string; color: string }
  accounts: CreditAccount[]
  count: number
}) {
  const { setNodeRef } = useSortable({
    id: stage.id,
    data: { type: "column" },
  })

  return (
    <div className="space-y-3">
      {/* Column Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${stage.color}`} />
          <h3 className="font-semibold">{stage.name}</h3>
        </div>
        <Badge variant="secondary">{count}</Badge>
      </div>

      {/* Droppable Area */}
      <div ref={setNodeRef} className="min-h-[500px] p-3 bg-muted/30 rounded-lg space-y-2">
        <SortableContext items={accounts.map((a) => a.id)} strategy={verticalListSortingStrategy}>
          {accounts.map((account) => (
            <DraggableAccountCard key={account.id} account={account} />
          ))}
        </SortableContext>
      </div>
    </div>
  )
}

// Component: Draggable Account Card
function DraggableAccountCard({ account }: { account: CreditAccount }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: account.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <AccountCard account={account} />
    </div>
  )
}

// Component: Account Card
function AccountCard({ account, isDragging = false }: { account: CreditAccount; isDragging?: boolean }) {
  if (!account) return null

  const initials = `${account.contact?.first_name?.[0] || ""}${account.contact?.last_name?.[0] || ""}`

  return (
    <Card className={isDragging ? "opacity-50" : "cursor-move hover:shadow-md transition-shadow"}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Avatar className="h-8 w-8">
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">
              {account.contact?.first_name} {account.contact?.last_name}
            </p>
            <p className="text-xs text-muted-foreground">{account.partner_name}</p>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-medium">${account.credit_amount?.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Status</span>
            <Badge variant="outline" className="text-xs">
              {account.account_status}
            </Badge>
          </div>
        </div>

        <Button asChild variant="outline" size="sm" className="w-full bg-transparent">
          <Link href={`/crm/contacts/${account.contact_id}`}>View Details</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
