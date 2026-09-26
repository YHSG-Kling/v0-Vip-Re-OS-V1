"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { saveVideoTemplate } from "@/app/actions/video-generation"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

const CATEGORIES = [
  "education",
  "property_tour",
  "agent_brand",
  "market_update",
  "listing_presentation",
  "ugc",
  "custom",
]

const SCRIPT_TYPES = [
  "property_tour",
  "buyer_education",
  "seller_education",
  "market_update",
  "agent_intro",
  "listing_presentation",
  "quick_tip",
  "market_fact",
  "personal_story",
  "listing_spotlight",
  "education_bite",
]

interface TemplateFormProps {
  brokerageId: string
  agentId: string
  teamId?: string | null
  userType: string
  initial?: {
    id?: string
    template_name?: string
    category?: string
    script_type?: string
    default_script?: string
    duration_seconds?: number
    tags?: string[]
    agent_id?: string | null
    team_id?: string | null
  }
}

export function TemplateFormClient({ brokerageId, agentId, teamId, userType, initial }: TemplateFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const canCreateBrokerageTemplate = isAdminOrBroker({ user_type: userType })
  const canCreateTeamTemplate = isAdminOrBroker({ user_type: userType })
  const canCreateBrokerageWide = canCreateBrokerageTemplate

  const [form, setForm] = useState({
    template_name: initial?.template_name ?? "",
    category: initial?.category ?? "custom",
    script_type: initial?.script_type ?? "",
    default_script: initial?.default_script ?? "",
    duration_seconds: initial?.duration_seconds ?? 60,
    tags: (initial?.tags ?? []).join(", "),
    scope: initial?.team_id ? "team" : (canCreateBrokerageTemplate && !initial?.agent_id ? "brokerage" : "agent"),
  })

  function set(key: string, value: string | number | boolean) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!form.template_name.trim()) {
      setError("Template name is required")
      return
    }

    startTransition(async () => {
      try {
        await saveVideoTemplate({
          brokerageId,
          agentId: form.scope === "agent" ? agentId : undefined,
          teamId: form.scope === "team" ? (teamId ?? undefined) : undefined,
          templateName: form.template_name.trim(),
          category: form.category,
          scriptType: form.script_type || undefined,
          defaultScript: form.default_script || undefined,
          durationSeconds: form.duration_seconds,
          tags: form.tags.split(",").map(t => t.trim()).filter(Boolean),
          createdBy: agentId,
        })
        router.push("/dashboard/videos/templates")
        router.refresh()
      } catch (err: any) {
        setError(err.message ?? "Failed to save template")
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      <div className="space-y-2">
        <Label htmlFor="template_name">Template Name *</Label>
        <Input
          id="template_name"
          value={form.template_name}
          onChange={e => set("template_name", e.target.value)}
          placeholder="e.g. First-Time Buyer Process"
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Category</Label>
          <Select value={form.category} onValueChange={v => set("category", v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map(c => (
                <SelectItem key={c} value={c} className="capitalize">
                  {c.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Script Type</Label>
          <Select value={form.script_type} onValueChange={v => set("script_type", v)}>
            <SelectTrigger>
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              {SCRIPT_TYPES.map(s => (
                <SelectItem key={s} value={s} className="capitalize">
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="default_script">Default Script (optional)</Label>
        <Textarea
          id="default_script"
          value={form.default_script}
          onChange={e => set("default_script", e.target.value)}
          placeholder="Paste a default script or outline for this template..."
          rows={8}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="duration">Duration (seconds)</Label>
          <Input
            id="duration"
            type="number"
            min={15}
            max={600}
            value={form.duration_seconds}
            onChange={e => set("duration_seconds", Number(e.target.value))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="tags">Tags (comma-separated)</Label>
          <Input
            id="tags"
            value={form.tags}
            onChange={e => set("tags", e.target.value)}
            placeholder="buyer, education, mortgage"
          />
        </div>
      </div>

      {(canCreateTeamTemplate || canCreateBrokerageTemplate) && (
        <div className="space-y-2">
          <Label>Template Scope</Label>
          <Select value={form.scope} onValueChange={v => set("scope", v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">My Templates (just me)</SelectItem>
              {canCreateTeamTemplate && teamId && (
                <SelectItem value="team">Team Templates (visible to my team)</SelectItem>
              )}
              {canCreateBrokerageTemplate && (
                <SelectItem value="brokerage">Brokerage Templates (all agents)</SelectItem>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {form.scope === "brokerage" && "All agents in your brokerage can use this template."}
            {form.scope === "team" && "All agents in your team can use this template."}
            {form.scope === "agent" && "Only you can see and use this template."}
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : "Save Template"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
