"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Plus, Settings, Play, Pause, Trash2, ChevronDown, ChevronUp } from "lucide-react"
import { toggleAIAgentTemplate, togglePlaybook } from "@/app/actions/services-config"
import { useRouter } from "next/navigation"

interface ServicesSettingsContentProps {
  services: any[]
  agents: any[]
  playbooks: any[]
  rules: any[]
}

export default function ServicesSettingsContent({ services, agents, playbooks, rules }: ServicesSettingsContentProps) {
  const router = useRouter()

  return (
    <Tabs defaultValue="services" className="space-y-4">
      <TabsList className="grid w-full grid-cols-5">
        <TabsTrigger value="services">Services Registry</TabsTrigger>
        <TabsTrigger value="agents">AI Agent Templates</TabsTrigger>
        <TabsTrigger value="assistants">My AI Assistants</TabsTrigger>
        <TabsTrigger value="playbooks">Playbooks</TabsTrigger>
        <TabsTrigger value="stages">Stage Rules</TabsTrigger>
      </TabsList>

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
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Template
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No AI agent templates configured yet</p>
            ) : (
              agents.map((agent) => <AIAgentCard key={agent.id} agent={agent} onToggle={toggleAIAgentTemplate} />)
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* TAB 3: My AI Assistants */}
      <TabsContent value="assistants">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Active AI Assistants</CardTitle>
                <CardDescription>Your personal AI assistants currently running</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <AssistantInstanceCard
              name="Daily Copilot"
              template="AI Copilot"
              status="active"
              last_run="2 minutes ago"
              tasks_generated={12}
              accuracy_rate={94}
            />
            <AssistantInstanceCard
              name="Content Assistant"
              template="Content Creator"
              status="active"
              last_run="5 minutes ago"
              tasks_generated={8}
              accuracy_rate={97}
            />
            <AssistantInstanceCard
              name="Lead Response Bot"
              template="Lead Qualifier"
              status="active"
              last_run="Just now"
              tasks_generated={24}
              accuracy_rate={89}
            />
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
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Playbook
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {playbooks.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No playbooks configured yet</p>
            ) : (
              playbooks.map((playbook) => (
                <PlaybookCard key={playbook.id} playbook={playbook} onToggle={togglePlaybook} />
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
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Rule
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No stage rules configured yet</p>
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
            <Button variant="outline" size="sm" onClick={() => setIsExpanded(!isExpanded)}>
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
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
                <Label className="capitalize">{key.replace("_", " ")}</Label>
                <Input type="password" placeholder={`Enter ${key}`} className="col-span-2" />
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
// COMPONENT: AI Agent Card
// ============================================================================

function AIAgentCard({ agent, onToggle }: any) {
  const [isToggling, setIsToggling] = useState(false)
  const router = useRouter()

  const handleToggle = async (checked: boolean) => {
    setIsToggling(true)
    try {
      await onToggle(agent.id, checked)
      router.refresh()
    } catch (error) {
      console.error("Error toggling agent:", error)
    } finally {
      setIsToggling(false)
    }
  }

  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{agent.agent_name}</CardTitle>
            <CardDescription>{agent.system_prompt?.substring(0, 100)}...</CardDescription>
          </div>
          <Switch checked={agent.active} onCheckedChange={handleToggle} disabled={isToggling} />
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
              {cap.replace("_", " ")}
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

function AssistantInstanceCard({ name, template, status, last_run, tasks_generated, accuracy_rate }: any) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{name}</CardTitle>
            <CardDescription>Based on {template}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
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
            <Button variant="ghost" size="sm">
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Last Run</p>
            <p className="font-medium">{last_run}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Tasks Generated</p>
            <p className="font-medium">{tasks_generated}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Accuracy</p>
            <p className="font-medium">{accuracy_rate}%</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================================
// COMPONENT: Playbook Card
// ============================================================================

function PlaybookCard({ playbook, onToggle }: any) {
  const [isToggling, setIsToggling] = useState(false)
  const router = useRouter()

  const handleToggle = async (checked: boolean) => {
    setIsToggling(true)
    try {
      await onToggle(playbook.id, checked)
      router.refresh()
    } catch (error) {
      console.error("Error toggling playbook:", error)
    } finally {
      setIsToggling(false)
    }
  }

  const steps = Array.isArray(playbook.steps) ? playbook.steps : []
  const personas = Array.isArray(playbook.target_persona_ids) ? playbook.target_persona_ids : []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{playbook.playbook_name}</CardTitle>
            <CardDescription>Trigger: {playbook.trigger_type}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={playbook.active} onCheckedChange={handleToggle} disabled={isToggling} />
            <Button variant="outline" size="sm">
              Edit
            </Button>
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
              <span className="font-medium">{playbook.usage_count}x</span>
            </div>
          </div>
          <div className="flex gap-1">
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
// COMPONENT: Stage Rule Card
// ============================================================================

function StageRuleCard({ rule }: any) {
  const conditions = Array.isArray(rule.required_conditions) ? rule.required_conditions : []
  const actions = Array.isArray(rule.actions_on_transition) ? rule.actions_on_transition : []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge>{rule.entity_type}</Badge>
              {rule.auto_transition && <Badge variant="secondary">Auto</Badge>}
            </div>
            <CardTitle className="text-lg">
              {rule.from_stage} → {rule.to_stage}
            </CardTitle>
          </div>
          <Button variant="outline" size="sm">
            Edit
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium mb-1">Required Conditions:</p>
            <ul className="text-sm text-muted-foreground space-y-1">
              {conditions.map((condition: any, i: number) => (
                <li key={i}>✓ {typeof condition === "string" ? condition : condition.description}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-medium mb-1">Actions on Transition:</p>
            <ul className="text-sm text-muted-foreground space-y-1">
              {actions.map((action: any, i: number) => (
                <li key={i}>→ {typeof action === "string" ? action : action.description}</li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
