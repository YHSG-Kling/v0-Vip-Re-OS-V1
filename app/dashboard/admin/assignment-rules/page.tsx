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
import { previewRuleRouting, type MatchableRule } from "@/lib/lead-assignment/rule-matcher"

type RuleType = "round_robin" | "load_balance" | "geo_based" | "specialization"

interface AssignmentRule {
  id: string
  name: string
  rule_type: RuleType
  conditions: Record<string, unknown>
  agent_ids: string[]
  team_id: string | null
  priority: number
  is_active: boolean
  times_triggered: number
}

interface TeamOption {
  id: string
  name: string
}

interface AgentOption {
  id: string
  full_name: string | null
  users?: { first_name: string | null; last_name: string | null } | null
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
  if (Array.isArray(conditions.motivation_types) && conditions.motivation_types.length > 0)
    parts.push(`Motivation: ${(conditions.motivation_types as string[]).join(", ")}`)
  if (Array.isArray(conditions.contact_personas) && conditions.contact_personas.length > 0)
    parts.push(`Personas: ${(conditions.contact_personas as string[]).join(", ")}`)
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
  motivation_types: "",
  contact_personas: "",
  team_id: "" as string,
}

const EMPTY_PREVIEW = { lead_score: "75", property_zip_code: "", source: "", urgency_level: "" }

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
  const [planTier, setPlanTier] = useState<string | null>(null)
  const [teams, setTeams] = useState<TeamOption[]>([])
  const [teamMembers, setTeamMembers] = useState<Record<string, string[]>>({})
  const [preview, setPreview] = useState(EMPTY_PREVIEW)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: profile } = await supabase
        .from("users")
        .select("brokerage_id")
        .eq("id", user.id)
        .single()

      if (!profile?.brokerage_id) return
      setBrokerageId(profile.brokerage_id)

      const [{ data: rulesData }, { data: agentsData }, { data: brokerageRow }, { data: teamsData }] = await Promise.all([
        supabase
          .from("assignment_rules")
          .select("id, name, rule_type, conditions, agent_ids, team_id, priority, is_active, times_triggered")
          .eq("brokerage_id", profile.brokerage_id)
          .order("priority", { ascending: false }),
        supabase
          .from("agents")
          .select("id, team_id, users!user_id ( first_name, last_name )")
          .eq("brokerage_id", profile.brokerage_id)
          .eq("is_active", true),
        supabase
          .from("brokerages")
          .select("plan_tier")
          .eq("id", profile.brokerage_id)
          .maybeSingle(),
        supabase
          .from("teams")
          .select("id, name")
          .eq("brokerage_id", profile.brokerage_id)
          .is("deleted_at", null),
      ])

      setRules((rulesData ?? []) as AssignmentRule[])
      setAgents((agentsData ?? []) as AgentOption[])
      setPlanTier((brokerageRow as { plan_tier?: string } | null)?.plan_tier ?? null)
      setTeams((teamsData ?? []) as TeamOption[])
      // teams.id -> member agents.id, for team-scoped rules without explicit agents
      const members: Record<string, string[]> = {}
      for (const a of (agentsData ?? []) as Array<{ id: string; team_id?: string | null }>) {
        if (a.team_id) (members[a.team_id] ??= []).push(a.id)
      }
      setTeamMembers(members)
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
      motivation_types: Array.isArray(cond.motivation_types)
        ? (cond.motivation_types as string[]).join(", ")
        : "",
      contact_personas: Array.isArray(cond.contact_personas)
        ? (cond.contact_personas as string[]).join(", ")
        : "",
      team_id: rule.team_id ?? "",
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
    if (form.motivation_types.trim() !== "")
      cond.motivation_types = form.motivation_types.split(",").map((m) => m.trim()).filter(Boolean)
    if (form.contact_personas.trim() !== "")
      cond.contact_personas = form.contact_personas.split(",").map((c) => c.trim()).filter(Boolean)
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
        team_id: form.team_id || null,
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

  function handleDelete(rule: AssignmentRule) {
    if (!window.confirm(`Delete rule "${rule.name}"? Routing falls through to lower-priority rules / load-balance.`)) return
    startTransition(async () => {
      await supabase.from("assignment_rules").delete().eq("id", rule.id)
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

      {/* HOW ASSIGNMENT RESOLVES — the canonical precedence chain, shown truthfully.
          Same order resolveAgentForContact / Engine 2 run: a contact created from a
          qualified lead (or captured from a form) is routed by the FIRST step that
          produces an agent. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How assignment resolves</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            <li className="flex gap-3">
              <Badge variant="outline" className="shrink-0">1</Badge>
              <div>
                <span className="font-medium">Capture owner</span>
                <span className="text-muted-foreground"> — a form, QR code, or ad tagged to a specific agent keeps that agent, regardless of rules below.</span>
              </div>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="shrink-0">2</Badge>
              <div>
                <span className="font-medium">Solo-agent shortcut</span>
                <span className="text-muted-foreground"> — on a solo plan every contact goes to the solo agent. </span>
                {planTier === "solo_agent" ? (
                  <Badge className="ml-1">ACTIVE for this brokerage — rules below are bypassed</Badge>
                ) : (
                  <Badge variant="secondary" className="ml-1">not a solo plan — skipped</Badge>
                )}
              </div>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="shrink-0">3</Badge>
              <div>
                <span className="font-medium">Your rules below</span>
                <span className="text-muted-foreground"> — evaluated highest-priority first; the first rule whose conditions ALL match picks the agent (Round Robin rotates; other types take the first agent). Team-scoped rules outrank brokerage-wide rules at equal priority, never fire for a contact that belongs to a different team, and route within the team's members when no agents are hand-picked — this is how a team plan or a multi-location brokerage (each office = a team) keeps its leads in-house.</span>
              </div>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="shrink-0">4</Badge>
              <div>
                <span className="font-medium">Team fallback</span>
                <span className="text-muted-foreground"> — a contact with a team affinity (its capture owner's team) load-balances within that team first, then goes to the TEAM LEAD, before ever leaving the team.</span>
              </div>
            </li>
            <li className="flex gap-3">
              <Badge variant="outline" className="shrink-0">5</Badge>
              <div>
                <span className="font-medium">Load-balance fallback</span>
                <span className="text-muted-foreground"> — when nothing above fires, the active agent with the fewest contacts gets the assignment. No lead is ever left unrouted.</span>
              </div>
            </li>
          </ol>
        </CardContent>
      </Card>

      {/* ROUTING PREVIEW — dry-runs step 3 with the EXACT matcher the engine uses
          (lib/lead-assignment/rule-matcher.ts). Pure client-side, no writes. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preview routing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label htmlFor="pv-score" className="text-xs text-muted-foreground">Lead score</Label>
              <Input id="pv-score" type="number" value={preview.lead_score}
                onChange={(e) => setPreview((p) => ({ ...p, lead_score: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-zip" className="text-xs text-muted-foreground">ZIP</Label>
              <Input id="pv-zip" placeholder="33133" value={preview.property_zip_code}
                onChange={(e) => setPreview((p) => ({ ...p, property_zip_code: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-source" className="text-xs text-muted-foreground">Source</Label>
              <Input id="pv-source" placeholder="zillow" value={preview.source}
                onChange={(e) => setPreview((p) => ({ ...p, source: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pv-urgency" className="text-xs text-muted-foreground">Urgency</Label>
              <Input id="pv-urgency" placeholder="hot" value={preview.urgency_level}
                onChange={(e) => setPreview((p) => ({ ...p, urgency_level: e.target.value }))} />
            </div>
          </div>
          {(() => {
            if (planTier === "solo_agent") {
              return (
                <p className="text-sm">
                  <Badge>solo-agent shortcut</Badge>
                  <span className="text-muted-foreground ml-2">This brokerage is on a solo plan — every contact routes to the solo agent before rules are consulted.</span>
                </p>
              )
            }
            const result = previewRuleRouting(rules as unknown as MatchableRule[], {
              lead_score: preview.lead_score === "" ? null : Number(preview.lead_score),
              property_zip_code: preview.property_zip_code || null,
              source: preview.source || null,
              urgency_level: preview.urgency_level || null,
            }, { teamMembers })
            if (result.rule) {
              const agent = agents.find((a) => a.id === result.agentId)
              const agentName = agent
                ? (agent.full_name ?? [agent.users?.first_name, agent.users?.last_name].filter(Boolean).join(" ")) || result.agentId
                : result.agentId
              const ruleTeam = teams.find((t) => t.id === (result.rule as { team_id?: string | null }).team_id)
              return (
                <p className="text-sm">
                  <Badge>rule: {result.rule.name ?? result.rule.id}</Badge>
                  {ruleTeam && <Badge variant="secondary" className="ml-1">team: {ruleTeam.name}</Badge>}
                  <span className="ml-2">→ <span className="font-medium">{agentName}</span></span>
                  <span className="text-muted-foreground ml-2">(this exact matcher runs in the assignment engine)</span>
                </p>
              )
            }
            return (
              <p className="text-sm">
                <Badge variant="secondary">load-balance fallback</Badge>
                <span className="text-muted-foreground ml-2">No rule matches this lead — it routes to the active agent with the fewest contacts.</span>
              </p>
            )
          })()}
        </CardContent>
      </Card>

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
                <TableHead>Scope</TableHead>
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
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
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
                    <TableCell>
                      {rule.team_id ? (
                        <Badge variant="outline" className="text-xs">
                          {teams.find((t) => t.id === rule.team_id)?.name ?? "Team"}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Brokerage-wide</span>
                      )}
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
                              {(a.full_name ?? [a.users?.first_name, a.users?.last_name].filter(Boolean).join(" ")) || a.id.slice(0, 8)}
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
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(rule)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleDelete(rule)}
                          disabled={isPending}
                        >
                          Delete
                        </Button>
                      </div>
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
                  Urgency Levels (comma-separated: hot, warm, cool, cold)
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
              <div className="space-y-1">
                <Label htmlFor="motivations" className="text-xs text-muted-foreground">
                  Motivation Types (comma-separated, e.g. seller_motivated, buyer_motivated)
                </Label>
                <Input
                  id="motivations"
                  placeholder="seller_motivated"
                  value={form.motivation_types}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, motivation_types: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="personas" className="text-xs text-muted-foreground">
                  Contact Personas (comma-separated, e.g. first_time_buyer, investor_flipper)
                </Label>
                <Input
                  id="personas"
                  placeholder="first_time_buyer"
                  value={form.contact_personas}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, contact_personas: e.target.value }))
                  }
                />
              </div>
            </div>

            {teams.length > 0 && (
              <div className="space-y-1">
                <Label>Team scope</Label>
                <Select
                  value={form.team_id || "brokerage_wide"}
                  onValueChange={(v) => setForm((p) => ({ ...p, team_id: v === "brokerage_wide" ? "" : v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="brokerage_wide">Brokerage-wide</SelectItem>
                    {teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Team-scoped rules route within the team (its members when no agents are picked below) and never fire for another team's contacts.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>Assign to Agents{form.team_id ? " (optional — defaults to the team's members)" : ""}</Label>
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
                    {(agent.full_name ?? [agent.users?.first_name, agent.users?.last_name].filter(Boolean).join(" ")) || agent.id.slice(0, 12)}
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
