"use client"

import { useEffect, useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type RuleType = "round_robin" | "load_balance" | "geo_based" | "specialization"

interface AssignmentRule {
  id: string
  name: string
  rule_type: RuleType
  conditions: Record<string, unknown>
  agent_ids: string[]
  priority: number
  is_active: boolean
  times_triggered: number
}

interface AgentOption {
  id: string
  full_name: string | null
}

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  round_robin: "Round Robin",
  load_balance: "Load Balance",
  geo_based: "Geographic",
  specialization: "Specialization",
}

function conditionsSummary(conditions: Record<string, unknown>): string {
  const parts: string[] = []
  if (conditions.min_score !== undefined) parts.push(`Score ≥ ${conditions.min_score}`)
  if (conditions.max_score !== undefined) parts.push(`Score ≤ ${conditions.max_score}`)
  if (Array.isArray(conditions.zip_codes) && conditions.zip_codes.length > 0)
    parts.push(`ZIPs: ${(conditions.zip_codes as string[]).join(", ")}`)
  if (Array.isArray(conditions.sources) && conditions.sources.length > 0)
    parts.push(`Sources: ${(conditions.sources as string[]).join(", ")}`)
  if (Array.isArray(conditions.urgency_levels) && conditions.urgency_levels.length > 0)
    parts.push(`Urgency: ${(conditions.urgency_levels as string[]).join(", ")}`)
  return parts.length > 0 ? parts.join(" · ") : "All leads"
}

const EMPTY_FORM = {
  name: "",
  rule_type: "round_robin" as RuleType,
  priority: 10,
  agent_ids: [] as string[],
  min_score: "",
  max_score: "",
  zip_codes: "",
  sources: "",
  urgency_levels: "",
}

export default function AssignmentRulesPage() {
  const supabase = createClient()
  const [rules, setRules] = useState<AssignmentRule[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [brokerageId, setBrokerageId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AssignmentRule | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: profile } = await supabase
        .from("user_profiles")
        .select("brokerage_id")
        .eq("user_id", user.id)
        .single()

      if (!profile?.brokerage_id) return
      setBrokerageId(profile.brokerage_id)

      const [{ data: rulesData }, { data: agentsData }] = await Promise.all([
        supabase
          .from("assignment_rules")
          .select("id, name, rule_type, conditions, agent_ids, priority, is_active, times_triggered")
          .eq("brokerage_id", profile.brokerage_id)
          .order("priority", { ascending: false }),
        supabase
          .from("agents")
          .select("id, full_name")
          .eq("brokerage_id", profile.brokerage_id)
          .eq("is_active", true),
      ])

      setRules((rulesData ?? []) as AssignmentRule[])
      setAgents((agentsData ?? []) as AgentOption[])
    } finally {
      setLoading(false)
    }
  }

  function openCreate() {
    setEditingRule(null)
    setForm(EMPTY_FORM)
    setModalOpen(true)
  }

  function openEdit(rule: AssignmentRule) {
    setEditingRule(rule)
    const cond = rule.conditions ?? {}
    setForm({
      name: rule.name,
      rule_type: rule.rule_type,
      priority: rule.priority,
      agent_ids: rule.agent_ids ?? [],
      min_score: cond.min_score !== undefined ? String(cond.min_score) : "",
      max_score: cond.max_score !== undefined ? String(cond.max_score) : "",
      zip_codes: Array.isArray(cond.zip_codes) ? (cond.zip_codes as string[]).join(", ") : "",
      sources: Array.isArray(cond.sources) ? (cond.sources as string[]).join(", ") : "",
      urgency_levels: Array.isArray(cond.urgency_levels)
        ? (cond.urgency_levels as string[]).join(", ")
        : "",
    })
    setModalOpen(true)
  }

  function buildConditions(): Record<string, unknown> {
    const cond: Record<string, unknown> = {}
    if (form.min_score !== "") cond.min_score = Number(form.min_score)
    if (form.max_score !== "") cond.max_score = Number(form.max_score)
    if (form.zip_codes.trim() !== "")
      cond.zip_codes = form.zip_codes.split(",").map((z) => z.trim()).filter(Boolean)
    if (form.sources.trim() !== "")
      cond.sources = form.sources.split(",").map((s) => s.trim()).filter(Boolean)
    if (form.urgency_levels.trim() !== "")
      cond.urgency_levels = form.urgency_levels.split(",").map((u) => u.trim()).filter(Boolean)
    return cond
  }

  function handleSave() {
    if (!brokerageId) return
    startTransition(async () => {
      const payload = {
        brokerage_id: brokerageId,
        name: form.name,
        rule_type: form.rule_type,
        conditions: buildConditions(),
        agent_ids: form.agent_ids,
        priority: form.priority,
        is_active: true,
      }

      if (editingRule) {
        await supabase.from("assignment_rules").update(payload).eq("id", editingRule.id)
      } else {
        await supabase.from("assignment_rules").insert({ ...payload, times_triggered: 0 })
      }

      setModalOpen(false)
      await load()
    })
  }

  function handleToggleActive(rule: AssignmentRule) {
    startTransition(async () => {
      await supabase
        .from("assignment_rules")
        .update({ is_active: !rule.is_active })
        .eq("id", rule.id)
      await load()
    })
  }

  function toggleAgentId(agentId: string) {
    setForm((prev) => ({
      ...prev,
      agent_ids: prev.agent_ids.includes(agentId)
        ? prev.agent_ids.filter((id) => id !== agentId)
        : [...prev.agent_ids, agentId],
    }))
  }

  if (loading) {
    return (
      <main className="p-6">
        <p className="text-muted-foreground">Loading assignment rules...</p>
      </main>
    )
  }

  return (
    <main className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assignment Rules</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how leads are automatically routed to agents.
          </p>
        </div>
        <Button onClick={openCreate}>+ Add Rule</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Rules</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Priority</TableHead>
                <TableHead>Rule Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Conditions</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Triggered</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No rules yet. Click "+ Add Rule" to create one.
                  </TableCell>
                </TableRow>
              )}
              {rules.map((rule) => {
                const ruleAgents = agents.filter((a) => rule.agent_ids?.includes(a.id))
                return (
                  <TableRow key={rule.id} className={rule.is_active ? "" : "opacity-50"}>
                    <TableCell>
                      <Badge variant="outline">{rule.priority}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">{rule.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {RULE_TYPE_LABELS[rule.rule_type] ?? rule.rule_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {conditionsSummary(rule.conditions ?? {})}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {ruleAgents.length === 0 ? (
                          <span className="text-muted-foreground text-sm">None</span>
                        ) : (
                          ruleAgents.slice(0, 3).map((a) => (
                            <Badge key={a.id} variant="outline" className="text-xs">
                              {a.full_name ?? a.id.slice(0, 8)}
                            </Badge>
                          ))
                        )}
                        {ruleAgents.length > 3 && (
                          <Badge variant="outline" className="text-xs">
                            +{ruleAgents.length - 3}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{rule.times_triggered ?? 0}</TableCell>
                    <TableCell>
                      <Switch
                        checked={rule.is_active}
                        onCheckedChange={() => handleToggleActive(rule)}
                        disabled={isPending}
                        aria-label={`Toggle ${rule.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(rule)}
                      >
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Rule Form Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingRule ? "Edit Rule" : "Add Assignment Rule"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="rule-name">Rule Name</Label>
              <Input
                id="rule-name"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. High-Score Leads"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Rule Type</Label>
                <Select
                  value={form.rule_type}
                  onValueChange={(v) => setForm((p) => ({ ...p, rule_type: v as RuleType }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="round_robin">Round Robin</SelectItem>
                    <SelectItem value="load_balance">Load Balance</SelectItem>
                    <SelectItem value="geo_based">Geographic</SelectItem>
                    <SelectItem value="specialization">Specialization</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label htmlFor="priority">Priority</Label>
                <Input
                  id="priority"
                  type="number"
                  min={1}
                  value={form.priority}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, priority: Number(e.target.value) }))
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Conditions</Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="min-score" className="text-xs text-muted-foreground">
                    Min Score
                  </Label>
                  <Input
                    id="min-score"
                    type="number"
                    placeholder="0"
                    value={form.min_score}
                    onChange={(e) => setForm((p) => ({ ...p, min_score: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="max-score" className="text-xs text-muted-foreground">
                    Max Score
                  </Label>
                  <Input
                    id="max-score"
                    type="number"
                    placeholder="100"
                    value={form.max_score}
                    onChange={(e) => setForm((p) => ({ ...p, max_score: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="zip-codes" className="text-xs text-muted-foreground">
                  ZIP Codes (comma-separated)
                </Label>
                <Input
                  id="zip-codes"
                  placeholder="90210, 10001"
                  value={form.zip_codes}
                  onChange={(e) => setForm((p) => ({ ...p, zip_codes: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sources" className="text-xs text-muted-foreground">
                  Sources (comma-separated)
                </Label>
                <Input
                  id="sources"
                  placeholder="zillow, realtor, referral"
                  value={form.sources}
                  onChange={(e) => setForm((p) => ({ ...p, sources: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="urgency" className="text-xs text-muted-foreground">
                  Urgency Levels (comma-separated)
                </Label>
                <Input
                  id="urgency"
                  placeholder="hot, warm"
                  value={form.urgency_levels}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, urgency_levels: e.target.value }))
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Assign to Agents</Label>
              <div className="border rounded-md p-3 max-h-40 overflow-y-auto space-y-2">
                {agents.length === 0 && (
                  <p className="text-sm text-muted-foreground">No active agents found.</p>
                )}
                {agents.map((agent) => (
                  <label
                    key={agent.id}
                    className="flex items-center gap-2 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={form.agent_ids.includes(agent.id)}
                      onChange={() => toggleAgentId(agent.id)}
                      className="rounded"
                    />
                    {agent.full_name ?? agent.id.slice(0, 12)}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isPending || !form.name.trim()}>
              {editingRule ? "Save Changes" : "Create Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
