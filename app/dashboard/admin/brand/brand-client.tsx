"use client"

import { useState, useTransition } from "react"
import { createClient } from "@/lib/supabase/client"
import {
  getBrandRequirementsAction,
  validateBrandComplianceAction,
  classifyTemplateAction,
  checkAutoApprovalEligibilityAction,
} from "@/app/actions/brand-template-registry"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Shield, CheckCircle2, AlertTriangle, XCircle, Plus, Pencil, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { format } from "date-fns"

// ─── Types ────────────────────────────────────────────────────────────────────

interface BrandTemplate {
  id: string
  template_name: string
  template_type: string
  content_html: string
  is_active: boolean
  created_at: string
}

interface VoiceProfile {
  id: string
  tone: string | null
  formality_level: string | null
  key_brand_messages: string[] | null
  prohibited_words: string[] | null
  preferred_words: string[] | null
  is_active: boolean
  tagline: string | null
  mission_statement: string | null
  updated_at: string
}

interface Stats {
  total_classifications: number
  brokerage_approved_count: number
  auto_approval_eligible_count: number
  average_confidence_score: number
  total_brand_validations: number
  compliant_count: number
  non_compliant_count: number
}

interface ComplianceHistoryRow {
  id: string
  title: string | null
  activity_type: string
  status: string | null
  created_at: string
  agent_id: string | null
}

interface Props {
  brokerageId: string
  templates: BrandTemplate[]
  voiceProfile: VoiceProfile | null
  stats: Stats | null
  complianceHistory: ComplianceHistoryRow[]
}

// ─── Tag input helper ─────────────────────────────────────────────────────────

function TagInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
}) {
  const [draft, setDraft] = useState("")

  function addTag() {
    const trimmed = draft.trim()
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed])
    }
    setDraft("")
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag() } }}
          placeholder="Type and press Enter"
          className="flex-1"
        />
        <Button type="button" variant="outline" size="sm" onClick={addTag}>Add</Button>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-1">
        {value.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="cursor-pointer select-none"
            onClick={() => onChange(value.filter((t) => t !== tag))}
          >
            {tag} &times;
          </Badge>
        ))}
      </div>
    </div>
  )
}

// ─── Template type label helper ───────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  email_signature: "Email Signature",
  letterhead: "Letterhead",
  business_card: "Business Card",
  custom: "Custom",
}

// ─── Main client component ────────────────────────────────────────────────────

export function BrandComplianceClient({
  brokerageId,
  templates: initialTemplates,
  voiceProfile: initialVoice,
  stats,
  complianceHistory,
}: Props) {
  const supabase = createClient()
  const [isPending, startTransition] = useTransition()

  // ── State ──────────────────────────────────────────────────────────────────

  const [templates, setTemplates] = useState<BrandTemplate[]>(initialTemplates)
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(initialVoice)
  const [templateFilter, setTemplateFilter] = useState<string>("all")

  // Voice edit sheet state
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false)
  const [voiceDraft, setVoiceDraft] = useState({
    tone: initialVoice?.tone ?? "professional",
    formality_level: initialVoice?.formality_level ?? "semi_formal",
    key_brand_messages: initialVoice?.key_brand_messages ?? [],
    prohibited_words: initialVoice?.prohibited_words ?? [],
  })
  const [savingVoice, setSavingVoice] = useState(false)

  // Add template dialog state
  const [addTemplateOpen, setAddTemplateOpen] = useState(false)
  const [newTemplate, setNewTemplate] = useState({
    template_name: "",
    template_type: "email_signature",
    content_html: "",
  })
  const [savingTemplate, setSavingTemplate] = useState(false)

  // Per-template compliance / auto-approve state
  const [complianceResults, setComplianceResults] = useState<
    Record<string, { checking: boolean; result: { is_compliant: boolean; warnings: string[] } | null; error: string | null }>
  >({})
  const [autoApproveResults, setAutoApproveResults] = useState<
    Record<string, { checking: boolean; eligible: boolean | null; reason: string | null }>
  >({})

  // ── Derived ────────────────────────────────────────────────────────────────

  const filteredTemplates = templateFilter === "all"
    ? templates
    : templates.filter((t) => t.template_type === templateFilter)

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleSaveVoice() {
    setSavingVoice(true)
    try {
      const { error } = await supabase
        .from("brand_voice_profile")
        .upsert(
          {
            brokerage_id: brokerageId,
            tone: voiceDraft.tone,
            formality_level: voiceDraft.formality_level,
            key_brand_messages: voiceDraft.key_brand_messages,
            prohibited_words: voiceDraft.prohibited_words,
            is_active: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "brokerage_id" }
        )
      if (error) throw error
      setVoiceProfile((prev) => ({
        ...(prev ?? { id: "", preferred_words: [], tagline: null, mission_statement: null }),
        tone: voiceDraft.tone,
        formality_level: voiceDraft.formality_level,
        key_brand_messages: voiceDraft.key_brand_messages,
        prohibited_words: voiceDraft.prohibited_words,
        is_active: true,
        updated_at: new Date().toISOString(),
      }))
      toast.success("Brand voice profile saved")
      setVoiceDialogOpen(false)
    } catch (err: any) {
      toast.error(err.message ?? "Failed to save brand voice")
    } finally {
      setSavingVoice(false)
    }
  }

  async function handleToggleTemplate(template: BrandTemplate) {
    const next = !template.is_active
    const { error } = await supabase
      .from("brand_templates")
      .update({ is_active: next })
      .eq("id", template.id)
    if (error) { toast.error(error.message); return }
    setTemplates((prev) =>
      prev.map((t) => (t.id === template.id ? { ...t, is_active: next } : t))
    )
    toast.success(`Template ${next ? "activated" : "deactivated"}`)
  }

  async function handleCheckCompliance(template: BrandTemplate) {
    setComplianceResults((prev) => ({
      ...prev,
      [template.id]: { checking: true, result: null, error: null },
    }))
    try {
      // Step 1: get brand requirements for this template type
      const reqResult = await getBrandRequirementsAction({
        content_type: template.template_type as any,
        channel_intent: "email",
        audience_scope: "lead",
      })
      if (!reqResult.success || !reqResult.data) throw new Error(reqResult.error ?? "Requirements fetch failed")

      // Step 2: validate compliance
      const valResult = await validateBrandComplianceAction(
        { raw_content: template.content_html ?? "" },
        reqResult.data
      )
      if (!valResult.success || !valResult.data) throw new Error(valResult.error ?? "Validation failed")

      setComplianceResults((prev) => ({
        ...prev,
        [template.id]: {
          checking: false,
          result: {
            is_compliant: valResult.data!.is_compliant,
            warnings: valResult.data!.warnings,
          },
          error: null,
        },
      }))
    } catch (err: any) {
      setComplianceResults((prev) => ({
        ...prev,
        [template.id]: { checking: false, result: null, error: err.message },
      }))
    }
  }

  async function handleCheckAutoApprove(template: BrandTemplate) {
    setAutoApproveResults((prev) => ({
      ...prev,
      [template.id]: { checking: true, eligible: null, reason: null },
    }))
    try {
      // Step 1: classify the template to get a TemplateClassification
      const classResult = await classifyTemplateAction({
        content_type: template.template_type as any,
        channel_intent: "email",
        is_brokerage_template: true,
        has_required_disclaimers: true,
      })
      if (!classResult.success || !classResult.data) throw new Error(classResult.error ?? "Classification failed")

      // Step 2: check auto-approval eligibility
      const eligResult = await checkAutoApprovalEligibilityAction(classResult.data)
      if (!eligResult.success || !eligResult.data) throw new Error(eligResult.error ?? "Eligibility check failed")

      setAutoApproveResults((prev) => ({
        ...prev,
        [template.id]: {
          checking: false,
          eligible: eligResult.data!.eligible,
          reason: eligResult.data!.reason,
        },
      }))
    } catch (err: any) {
      setAutoApproveResults((prev) => ({
        ...prev,
        [template.id]: { checking: false, eligible: null, reason: err.message },
      }))
    }
  }

  async function handleAddTemplate() {
    if (!newTemplate.template_name.trim()) { toast.error("Template name is required"); return }
    if (!newTemplate.content_html.trim()) { toast.error("Content is required"); return }
    setSavingTemplate(true)
    try {
      const { data, error } = await supabase
        .from("brand_templates")
        .insert({
          brokerage_id: brokerageId,
          template_name: newTemplate.template_name,
          template_type: newTemplate.template_type,
          content_html: newTemplate.content_html,
          is_active: true,
        })
        .select("id, template_name, template_type, content_html, is_active, created_at")
        .single()
      if (error) throw error
      setTemplates((prev) => [data, ...prev])
      setNewTemplate({ template_name: "", template_type: "email_signature", content_html: "" })
      setAddTemplateOpen(false)
      toast.success("Template added")
    } catch (err: any) {
      toast.error(err.message ?? "Failed to add template")
    } finally {
      setSavingTemplate(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Shield className="h-7 w-7 text-foreground" />
        <div>
          <h1 className="text-2xl font-semibold text-balance">Brand &amp; Compliance OS</h1>
          <p className="text-sm text-muted-foreground">Manage brand voice, templates, and compliance tracking</p>
        </div>
      </div>

      {/* ── SECTION 4: Statistics ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Total Templates", value: templates.length },
          { label: "Active Templates", value: templates.filter((t) => t.is_active).length },
          {
            label: "Compliance Rate",
            value: stats
              ? stats.total_brand_validations > 0
                ? `${Math.round((stats.compliant_count / stats.total_brand_validations) * 100)}%`
                : "—"
              : "—",
          },
          {
            label: "Auto-Approve Eligible",
            value: stats?.auto_approval_eligible_count ?? "—",
          },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardDescription className="text-xs">{stat.label}</CardDescription>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-2xl font-semibold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── SECTION 1: Brand Voice Profile ────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Brand Voice Profile</CardTitle>
            <CardDescription>
              {voiceProfile
                ? `Last updated ${format(new Date(voiceProfile.updated_at), "MMM d, yyyy")}`
                : "No brand voice profile configured yet"}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setVoiceDraft({
                tone: voiceProfile?.tone ?? "professional",
                formality_level: voiceProfile?.formality_level ?? "semi_formal",
                key_brand_messages: voiceProfile?.key_brand_messages ?? [],
                prohibited_words: voiceProfile?.prohibited_words ?? [],
              })
              setVoiceDialogOpen(true)
            }}
          >
            <Pencil className="h-4 w-4 mr-1.5" />
            Edit Brand Voice
          </Button>
        </CardHeader>
        <CardContent>
          {voiceProfile ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-widest">Tone</p>
                <Badge variant="secondary" className="capitalize">{voiceProfile.tone ?? "—"}</Badge>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-widest">Formality</p>
                <Badge variant="secondary" className="capitalize">{voiceProfile.formality_level?.replace("_", " ") ?? "—"}</Badge>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-widest">Key Brand Messages</p>
                {(voiceProfile.key_brand_messages ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">None set</p>
                ) : (
                  <ul className="space-y-1">
                    {(voiceProfile.key_brand_messages ?? []).map((msg) => (
                      <li key={msg} className="text-sm flex items-start gap-1.5">
                        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        {msg}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-widest">Prohibited Words</p>
                {(voiceProfile.prohibited_words ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">None set</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {(voiceProfile.prohibited_words ?? []).map((w) => (
                      <Badge key={w} variant="destructive" className="text-xs font-normal">{w}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No brand voice profile configured. Click Edit Brand Voice to set one up.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── SECTION 2: Template Library ───────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Template Library</CardTitle>
            <CardDescription>{templates.length} templates</CardDescription>
          </div>
          <Button size="sm" onClick={() => setAddTemplateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add Template
          </Button>
        </CardHeader>
        <CardContent>
          <Tabs value={templateFilter} onValueChange={setTemplateFilter}>
            <TabsList className="mb-4">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="email_signature">Email Signature</TabsTrigger>
              <TabsTrigger value="letterhead">Letterhead</TabsTrigger>
              <TabsTrigger value="business_card">Business Card</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>

            <TabsContent value={templateFilter} className="mt-0">
              {filteredTemplates.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No templates in this category.
                </p>
              ) : (
                <div className="space-y-3">
                  {filteredTemplates.map((template) => {
                    const compliance = complianceResults[template.id]
                    const autoApprove = autoApproveResults[template.id]

                    return (
                      <div
                        key={template.id}
                        className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm">{template.template_name}</p>
                            <Badge variant="outline" className="text-xs">
                              {TYPE_LABELS[template.template_type] ?? template.template_type}
                            </Badge>
                            <Badge
                              variant={template.is_active ? "default" : "secondary"}
                              className="text-xs"
                            >
                              {template.is_active ? "Active" : "Inactive"}
                            </Badge>
                          </div>

                          {/* Compliance result */}
                          {compliance?.result && (
                            <div className="flex items-center gap-1.5 text-xs mt-1">
                              {compliance.result.is_compliant ? (
                                <>
                                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                                  <span className="text-green-700">Compliant</span>
                                </>
                              ) : (
                                <>
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                                  <span className="text-amber-700">
                                    Issues found
                                    {compliance.result.warnings.length > 0 &&
                                      `: ${compliance.result.warnings.slice(0, 2).join(", ")}`}
                                  </span>
                                </>
                              )}
                            </div>
                          )}
                          {compliance?.error && (
                            <p className="text-xs text-destructive mt-1">{compliance.error}</p>
                          )}

                          {/* Auto-approve result */}
                          {autoApprove?.eligible !== null && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Auto-approve:{" "}
                              <span className={autoApprove.eligible ? "text-green-700 font-medium" : "text-foreground"}>
                                {autoApprove.eligible ? "Eligible" : "Not eligible"}
                              </span>
                              {autoApprove.reason ? ` — ${autoApprove.reason}` : ""}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0 flex-wrap">
                          {/* Active toggle */}
                          <Switch
                            checked={template.is_active}
                            onCheckedChange={() => handleToggleTemplate(template)}
                            aria-label="Toggle template active"
                          />

                          {/* Check compliance */}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={compliance?.checking}
                            onClick={() => handleCheckCompliance(template)}
                          >
                            {compliance?.checking ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                            ) : null}
                            Check Compliance
                          </Button>

                          {/* Auto-approve chip */}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={autoApprove?.checking}
                            className={
                              autoApprove?.eligible === true
                                ? "text-green-700 border border-green-300 bg-green-50"
                                : autoApprove?.eligible === false
                                ? "text-muted-foreground border"
                                : "border"
                            }
                            onClick={() => handleCheckAutoApprove(template)}
                          >
                            {autoApprove?.checking ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                            ) : null}
                            Auto-Approve?
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* ── SECTION 3: Compliance History ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Compliance History</CardTitle>
          <CardDescription>Recent brand compliance activity from system logs</CardDescription>
        </CardHeader>
        <CardContent>
          {complianceHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No compliance history yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {complianceHistory.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {format(new Date(row.created_at), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell className="text-sm">{row.title ?? "Brand activity"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs capitalize">
                        {row.activity_type.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {row.status === "completed" || row.status === "passed" ? (
                        <span className="flex items-center gap-1 text-xs text-green-700 font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Pass
                        </span>
                      ) : row.status === "failed" ? (
                        <span className="flex items-center gap-1 text-xs text-destructive font-medium">
                          <XCircle className="h-3.5 w-3.5" /> Fail
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{row.status ?? "—"}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Edit Brand Voice Dialog ────────────────────────────────────────── */}
      <Dialog open={voiceDialogOpen} onOpenChange={setVoiceDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Brand Voice</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Tone</Label>
              <Select
                value={voiceDraft.tone}
                onValueChange={(v) => setVoiceDraft((d) => ({ ...d, tone: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["professional", "conversational", "luxury", "friendly", "authoritative", "warm"].map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Formality</Label>
              <Select
                value={voiceDraft.formality_level}
                onValueChange={(v) => setVoiceDraft((d) => ({ ...d, formality_level: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="formal">Formal</SelectItem>
                  <SelectItem value="semi_formal">Semi-formal</SelectItem>
                  <SelectItem value="casual">Casual</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <TagInput
              label="Key Brand Messages"
              value={voiceDraft.key_brand_messages}
              onChange={(v) => setVoiceDraft((d) => ({ ...d, key_brand_messages: v }))}
            />
            <TagInput
              label="Prohibited Words"
              value={voiceDraft.prohibited_words}
              onChange={(v) => setVoiceDraft((d) => ({ ...d, prohibited_words: v }))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiceDialogOpen(false)} disabled={savingVoice}>
              Cancel
            </Button>
            <Button onClick={handleSaveVoice} disabled={savingVoice}>
              {savingVoice ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add Template Dialog ────────────────────────────────────────────── */}
      <Dialog open={addTemplateOpen} onOpenChange={setAddTemplateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Template Name</Label>
              <Input
                value={newTemplate.template_name}
                onChange={(e) => setNewTemplate((d) => ({ ...d, template_name: e.target.value }))}
                placeholder="e.g. Standard Email Signature"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={newTemplate.template_type}
                onValueChange={(v) => setNewTemplate((d) => ({ ...d, template_type: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABELS).map(([val, label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Content HTML</Label>
              <Textarea
                value={newTemplate.content_html}
                onChange={(e) => setNewTemplate((d) => ({ ...d, content_html: e.target.value }))}
                placeholder="<p>Your template HTML...</p>"
                rows={5}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddTemplateOpen(false)} disabled={savingTemplate}>
              Cancel
            </Button>
            <Button onClick={handleAddTemplate} disabled={savingTemplate}>
              {savingTemplate ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</> : "Add Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
