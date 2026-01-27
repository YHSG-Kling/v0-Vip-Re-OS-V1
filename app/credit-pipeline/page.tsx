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
import { DollarSign, TrendingUp, Clock, Plus } from "lucide-react"
import { advanceCreditFlow, getCreditPipelineStats } from "@/app/actions/credit-copilot"
import { createClient } from "@/lib/supabase/client"

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
  total_value: number
  total_accounts: number
  avg_time_to_close: number
  by_stage: Record<string, number>
  accounts: CreditAccount[]
}

export default function CreditPipelinePage() {
  const [accounts, setAccounts] = useState<CreditAccount[]>([])
  const [stats, setStats] = useState<PipelineStats | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return

      const pipelineStats = await getCreditPipelineStats(user.id)
      setStats(pipelineStats)
      setAccounts(pipelineStats.accounts || [])
    } catch (error) {
      console.error("[v0] Error loading pipeline:", error)
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
      await advanceCreditFlow(accountId, newStage)
      await loadPipeline()
    } catch (error) {
      console.error("[v0] Error moving account:", error)
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
                  <span className="font-medium">$2,400 / $5,000</span>
                </div>
                <Progress value={48} />
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
      <Button className="fixed bottom-8 right-8 rounded-full h-14 w-14" size="icon">
        <Plus className="h-6 w-6" />
      </Button>
    </div>
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

        <Button variant="outline" size="sm" className="w-full bg-transparent">
          View Details
        </Button>
      </CardContent>
    </Card>
  )
}
