"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Plus,
  Settings,
  Play,
  Pause,
  Trash2,
  ChevronDown,
  ChevronUp,
  Loader2,
  ArrowRight,
} from "lucide-react"
import {
  toggleAIAgentTemplate,
  createAIAgentTemplate,
  togglePlaybook,
  createPlaybook,
  createStageRule,
  deleteStageRule,
} from "@/app/actions/services-config"

// ============================================================================
// TYPES
// ============================================================================

interface ServicesSettingsContentProps {
  services: any[]
  agents: any[]
  playbooks: any[]
  rules: any[]
}

// ============================================================================
// ROOT COMPONENT
// ============================================================================

export default function ServicesSettingsContent({
  services,
  agents,
  playbooks,
  rules,
}: ServicesSettingsContentProps) {
  return (
    <Tabs defaultValue="services" className="space-y-4">
      <div className="overflow-x-auto">
        <TabsList className="flex min-w-max sm:grid sm:w-full sm:grid-cols-5">
          <TabsTrigger value="services" className="min-h-[44px] sm:min-h-0 min-w-[130px] sm:min-w-0">Services Registry</TabsTrigger>
          <TabsTrigger value="agents" className="min-h-[44px] sm:min-h-0 min-w-[140px] sm:min-w-0">AI Agent Templates</TabsTrigger>
          <TabsTrigger value="assistants" className="min-h-[44px] sm:min-h-0 min-w-[130px] sm:min-w-0">My AI Assistants</TabsTrigger>
          <TabsTrigger value="playbooks" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">Playbooks</TabsTrigger>
          <TabsTrigger value="stages" className="min-h-[44px] sm:min-h-0 min-w-[100px] sm:min-w-0">Stage Rules</TabsTrigger>
        </TabsList>
      </div>

      {/* TAB 1: Services Registry */}
      <TabsContent value="services">
        <Card>
          <CardHeader>
            <CardTitle>External Services</CardTitle>
            <CardDescription>Configure API integrations and external services</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {services.map((service) => (
              <ServiceCard key={service.id} {...service} />
            ))}
          </CardContent>
        </Card>
      </TabsContent>

      {/* TAB 2: AI Agent Templates */}
      <TabsContent value="agents">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>AI Agent Templates</CardTitle>
                <CardDescription>Pre-configured AI agents for different tasks</CardDescription>
              </div>
              <CreateAgentSheet />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No AI agent templates configured yet
              </p>
            ) : (
              agents.map((agent) => (
                <AIAgentCard key={agent.id} agent={agent} />
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* TAB 3: My AI Assistants — driven by real active agent templates */}
      <TabsContent value="assistants">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Active AI Assistants</CardTitle>
                <CardDescription>AI agent templates currently enabled for your account</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {agents.filter((a) => !!a.active).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No active AI assistants. Enable an agent template in the AI Agent Templates tab.
              </p>
            ) : (
              agents
                .filter((a) => !!a.active)
                .map((agent) => (
                  <AssistantInstanceCard
                    key={agent.id}
                    name={agent.agent_name}
                    template={agent.agent_type}
                    status="active"
                  />
                ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* TAB 4: Playbooks */}
      <TabsContent value="playbooks">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Automation Playbooks</CardTitle>
                <CardDescription>Workflow automations triggered by events</CardDescription>
              </div>
              <CreatePlaybookSheet />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {playbooks.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No playbooks configured yet
              </p>
            ) : (
              playbooks.map((playbook) => (
                <PlaybookCard key={playbook.id} playbook={playbook} />
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* TAB 5: Stage Rules */}
      <TabsContent value="stages">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Stage Transition Rules</CardTitle>
                <CardDescription>Automatic stage progression rules</CardDescription>
              </div>
              <CreateStageRuleSheet />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No stage rules configured yet
              </p>
            ) : (
              rules.map((rule) => <StageRuleCard key={rule.id} rule={rule} />)
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

// ============================================================================
// COMPONENT: Service Card
// ============================================================================

function ServiceCard({ id, name, type, status, description, config_keys }: any) {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Settings className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-lg">{name}</CardTitle>
              <CardDescription>{type}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status === "connected" ? "default" : "secondary"}>
              {status === "connected" ? "Connected" : "Not Configured"}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      {isExpanded && (
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">{description}</p>
          <div className="space-y-3">
            {config_keys.map((key: string) => (
              <div key={key} className="grid grid-cols-3 gap-2 items-center">
                <Label className="capitalize">{key.replace(/_/g, " ")}</Label>
                <Input
                  type="password"
                  placeholder={`Enter ${key.replace(/_/g, " ")}`}
                  className="col-span-2"
                />
              </div>
            ))}
            <Button className="w-full">Save Configuration</Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

// ============================================================================
// COMPONENT: Create Agent Sheet
// ============================================================================

function CreateAgentSheet() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [form, setForm] = useState({
    agent_name: "",
    agent_type: "",
    system_prompt: "",
    model: "openai/gpt-4o-mini",
    temperature: 0.7,
    capabilities: "",
  })

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        await createAIAgentTemplate({
          agent_name: form.agent_name,
          agent_type: form.agent_type,
          system_prompt: form.system_prompt,
          model: form.model,
          temperature: form.temperature,
          capabilities: form.capabilities
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        })
        setOpen(false)
        setForm({
          agent_name: "",
          agent_type: "",
          system_prompt: "",
          model: "openai/gpt-4o-mini",
          temperature: 0.7,
          capabilities: "",
        })
        router.refresh()
      } catch (err) {
        console.error("[v0] Error creating agent template:", err)
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Create Template
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Create AI Agent Template</SheetTitle>
          <SheetDescription>
            Define a reusable AI agent configuration for your team
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-6">
          <div className="space-y-2">
            <Label htmlFor="agent_name">Agent Name</Label>
            <Input
              id="agent_name"
              placeholder="e.g. Lead Qualifier"
              value={form.agent_name}
              onChange={(e) => setForm({ ...form, agent_name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent_type">Agent Type</Label>
            <Select
              value={form.agent_type}
              onValueChange={(v) => setForm({ ...form, agent_type: v })}
            >
              <SelectTrigger id="agent_type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="copilot">Copilot</SelectItem>
                <SelectItem value="lead_qualifier">Lead Qualifier</SelectItem>
                <SelectItem value="content_creator">Content Creator</SelectItem>
                <SelectItem value="transaction_coordinator">Transaction Coordinator</SelectItem>
                <SelectItem value="follow_up">Follow-up Agent</SelectItem>
                <SelectItem value="analytics">Analytics Agent</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="model">Model</Label>
            <Select
              value={form.model}
              onValueChange={(v) => setForm({ ...form, model: v })}
            >
              <SelectTrigger id="model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai/gpt-4o-mini">GPT-4o Mini</SelectItem>
                <SelectItem value="openai/gpt-4o">GPT-4o</SelectItem>
                <SelectItem value="anthropic/claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</SelectItem>
                <SelectItem value="anthropic/claude-3-haiku-20240307">Claude 3 Haiku</SelectItem>
                <SelectItem value="google/gemini-1.5-flash">Gemini 1.5 Flash</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="temperature">
              Temperature:{" "}
              <span className="text-muted-foreground">{form.temperature}</span>
            </Label>
            <input
              id="temperature"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={form.temperature}
              onChange={(e) =>
                setForm({ ...form, temperature: parseFloat(e.target.value) })
              }
              className="w-full"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="system_prompt">System Prompt</Label>
            <Textarea
              id="system_prompt"
              placeholder="You are a helpful real estate AI assistant..."
              rows={5}
              value={form.system_prompt}
              onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="capabilities">
              Capabilities{" "}
              <span className="text-muted-foreground text-xs">(comma-separated)</span>
            </Label>
            <Input
              id="capabilities"
              placeholder="e.g. lead_scoring, email_drafting, follow_up"
              value={form.capabilities}
              onChange={(e) => setForm({ ...form, capabilities: e.target.value })}
            />
          </div>
        </div>
        <SheetFooter>
          <Button
            onClick={handleSubmit}
            disabled={
              isPending || !form.agent_name || !form.agent_type || !form.system_prompt
            }
            className="w-full"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Template"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ============================================================================
// COMPONENT: AI Agent Card
// ============================================================================

function AIAgentCard({ agent }: { agent: any }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleToggle = (checked: boolean) => {
    startTransition(async () => {
      try {
        await toggleAIAgentTemplate(agent.id, checked)
        router.refresh()
      } catch (err) {
        console.error("[v0] Error toggling agent:", err)
      }
    })
  }

  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{agent.agent_name}</CardTitle>
            <CardDescription>
              {agent.system_prompt?.substring(0, 100)}...
            </CardDescription>
          </div>
          <Switch
            checked={!!agent.active}
            onCheckedChange={handleToggle}
            disabled={isPending}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 mb-3">
          <Badge variant="outline">{agent.model}</Badge>
          <Badge variant="outline">{agent.agent_type}</Badge>
          <Badge variant="outline">temp: {agent.temperature}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {capabilities.map((cap: string) => (
            <Badge key={cap} variant="secondary">
              {cap.replace(/_/g, " ")}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================================
// COMPONENT: Assistant Instance Card
// ============================================================================

function AssistantInstanceCard({
  name,
  template,
  status,
}: {
  name: string
  template: string
  status: "active" | "paused"
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{name}</CardTitle>
            <CardDescription>Type: {template?.replace(/_/g, " ")}</CardDescription>
          </div>
          <Badge variant={status === "active" ? "default" : "secondary"}>
            {status === "active" ? (
              <>
                <Play className="mr-1 h-3 w-3" />
                Active
              </>
            ) : (
              <>
                <Pause className="mr-1 h-3 w-3" />
                Paused
              </>
            )}
          </Badge>
        </div>
      </CardHeader>
    </Card>
  )
}

// ============================================================================
// COMPONENT: Create Playbook Sheet
// ============================================================================

function CreatePlaybookSheet() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [form, setForm] = useState({
    playbook_name: "",
    trigger_type: "",
    steps_raw: "",
    target_persona_ids_raw: "",
  })

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        await createPlaybook({
          playbook_name: form.playbook_name,
          trigger_type: form.trigger_type,
          steps: form.steps_raw
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((description, i) => ({ step: i + 1, description })),
          target_persona_ids: form.target_persona_ids_raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        })
        setOpen(false)
        setForm({
          playbook_name: "",
          trigger_type: "",
          steps_raw: "",
          target_persona_ids_raw: "",
        })
        router.refresh()
      } catch (err) {
        console.error("[v0] Error creating playbook:", err)
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Create Playbook
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Create Automation Playbook</SheetTitle>
          <SheetDescription>
            Define a triggered workflow with sequential steps
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-6">
          <div className="space-y-2">
            <Label htmlFor="playbook_name">Playbook Name</Label>
            <Input
              id="playbook_name"
              placeholder="e.g. New Lead Welcome Sequence"
              value={form.playbook_name}
              onChange={(e) => setForm({ ...form, playbook_name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trigger_type">Trigger Event</Label>
            <Select
              value={form.trigger_type}
              onValueChange={(v) => setForm({ ...form, trigger_type: v })}
            >
              <SelectTrigger id="trigger_type">
                <SelectValue placeholder="Select trigger" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new_lead">New Lead Created</SelectItem>
                <SelectItem value="stage_change">Stage Change</SelectItem>
                <SelectItem value="offer_received">Offer Received</SelectItem>
                <SelectItem value="contract_signed">Contract Signed</SelectItem>
                <SelectItem value="closing_scheduled">Closing Scheduled</SelectItem>
                <SelectItem value="closed">Transaction Closed</SelectItem>
                <SelectItem value="missed_follow_up">Missed Follow-up</SelectItem>
                <SelectItem value="manual">Manual Trigger</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="steps_raw">
              Steps{" "}
              <span className="text-muted-foreground text-xs">(one per line)</span>
            </Label>
            <Textarea
              id="steps_raw"
              placeholder={"Send welcome email\nAssign to agent queue\nSchedule follow-up call in 2 days"}
              rows={6}
              value={form.steps_raw}
              onChange={(e) => setForm({ ...form, steps_raw: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="target_persona_ids_raw">
              Target Personas{" "}
              <span className="text-muted-foreground text-xs">(comma-separated IDs or names)</span>
            </Label>
            <Input
              id="target_persona_ids_raw"
              placeholder="e.g. buyer, seller, investor"
              value={form.target_persona_ids_raw}
              onChange={(e) =>
                setForm({ ...form, target_persona_ids_raw: e.target.value })
              }
            />
          </div>
        </div>
        <SheetFooter>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !form.playbook_name || !form.trigger_type}
            className="w-full"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Playbook"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ============================================================================
// COMPONENT: Playbook Card
// ============================================================================

function PlaybookCard({ playbook }: { playbook: any }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleToggle = (checked: boolean) => {
    startTransition(async () => {
      try {
        await togglePlaybook(playbook.id, checked)
        router.refresh()
      } catch (err) {
        console.error("[v0] Error toggling playbook:", err)
      }
    })
  }

  const steps = Array.isArray(playbook.steps) ? playbook.steps : []
  const personas = Array.isArray(playbook.target_persona_ids)
    ? playbook.target_persona_ids
    : []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{playbook.playbook_name}</CardTitle>
            <CardDescription>Trigger: {playbook.trigger_type}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={!!playbook.active}
              onCheckedChange={handleToggle}
              disabled={isPending}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Steps: </span>
              <span className="font-medium">{steps.length}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Used: </span>
              <span className="font-medium">{playbook.usage_count ?? 0}x</span>
            </div>
          </div>
          <div className="flex gap-1 flex-wrap">
            {personas.slice(0, 3).map((persona: string, i: number) => (
              <Badge key={i} variant="outline" className="text-xs">
                {persona}
              </Badge>
            ))}
            {personas.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{personas.length - 3}
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================================
// COMPONENT: Create Stage Rule Sheet
// ============================================================================

function CreateStageRuleSheet() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [form, setForm] = useState({
    rule_type: "lead",
    from_stage: "",
    to_stage: "",
    conditions_raw: "",
    auto_transition: false,
    actions_raw: "",
  })

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        await createStageRule({
          rule_type: form.rule_type,
          from_stage: form.from_stage,
          to_stage: form.to_stage,
          required_conditions: form.conditions_raw
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((description) => ({ description })),
          auto_transition: form.auto_transition,
          actions_on_transition: form.actions_raw
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((description) => ({ description })),
        })
        setOpen(false)
        setForm({
          rule_type: "lead",
          from_stage: "",
          to_stage: "",
          conditions_raw: "",
          auto_transition: false,
          actions_raw: "",
        })
        router.refresh()
      } catch (err) {
        console.error("[v0] Error creating stage rule:", err)
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Create Rule
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Create Stage Transition Rule</SheetTitle>
          <SheetDescription>
            Define conditions and actions for automatic stage progression
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 py-6">
          <div className="space-y-2">
            <Label htmlFor="rule_entity_type">Entity Type</Label>
            <Select
              value={form.rule_type}
              onValueChange={(v) => setForm({ ...form, rule_type: v })}
            >
              <SelectTrigger id="rule_entity_type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">Lead</SelectItem>
                <SelectItem value="transaction">Transaction</SelectItem>
                <SelectItem value="contact">Contact</SelectItem>
                <SelectItem value="listing">Listing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
            <div className="space-y-2">
              <Label htmlFor="from_stage">From Stage</Label>
              <Input
                id="from_stage"
                placeholder="e.g. New"
                value={form.from_stage}
                onChange={(e) => setForm({ ...form, from_stage: e.target.value })}
              />
            </div>
            <ArrowRight className="h-4 w-4 mb-2 text-muted-foreground" />
            <div className="space-y-2">
              <Label htmlFor="to_stage">To Stage</Label>
              <Input
                id="to_stage"
                placeholder="e.g. Qualified"
                value={form.to_stage}
                onChange={(e) => setForm({ ...form, to_stage: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="conditions_raw">
              Required Conditions{" "}
              <span className="text-muted-foreground text-xs">(one per line)</span>
            </Label>
            <Textarea
              id="conditions_raw"
              placeholder={"Contact has phone number\nLead source is verified\nBudget confirmed"}
              rows={4}
              value={form.conditions_raw}
              onChange={(e) => setForm({ ...form, conditions_raw: e.target.value })}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Auto Transition</p>
              <p className="text-xs text-muted-foreground">
                Automatically advance when all conditions are met
              </p>
            </div>
            <Switch
              checked={form.auto_transition}
              onCheckedChange={(v) => setForm({ ...form, auto_transition: v })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="actions_raw">
              Actions on Transition{" "}
              <span className="text-muted-foreground text-xs">(one per line)</span>
            </Label>
            <Textarea
              id="actions_raw"
              placeholder={"Send congratulations email\nAssign to priority queue\nCreate follow-up task"}
              rows={4}
              value={form.actions_raw}
              onChange={(e) => setForm({ ...form, actions_raw: e.target.value })}
            />
          </div>
        </div>
        <SheetFooter>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !form.from_stage || !form.to_stage}
            className="w-full"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Rule"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ============================================================================
// COMPONENT: Stage Rule Card
// ============================================================================

function StageRuleCard({ rule }: { rule: any }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleDelete = () => {
    startTransition(async () => {
      try {
        await deleteStageRule(rule.id)
        router.refresh()
      } catch (err) {
        console.error("[v0] Error deleting stage rule:", err)
      }
    })
  }

  const conditions = Array.isArray(rule.required_conditions)
    ? rule.required_conditions
    : []
  const actions = Array.isArray(rule.actions_on_transition)
    ? rule.actions_on_transition
    : []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge>{rule.entity_type ?? rule.rule_type}</Badge>
              {rule.auto_transition && (
                <Badge variant="secondary">Auto</Badge>
              )}
            </div>
            <CardTitle className="text-lg">
              {rule.from_stage}{" "}
              <ArrowRight className="inline h-4 w-4 mx-1" />
              {rule.to_stage}
            </CardTitle>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={isPending}>
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Stage Rule?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently remove the rule for{" "}
                  <strong>
                    {rule.from_stage} → {rule.to_stage}
                  </strong>
                  . This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {conditions.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-1">Required Conditions:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                {conditions.map((condition: any, i: number) => (
                  <li key={i}>
                    ✓{" "}
                    {typeof condition === "string"
                      ? condition
                      : condition.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {actions.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-1">Actions on Transition:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                {actions.map((action: any, i: number) => (
                  <li key={i}>
                    →{" "}
                    {typeof action === "string" ? action : action.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
