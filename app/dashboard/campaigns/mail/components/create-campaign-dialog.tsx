"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { toast } from "sonner"
import { Loader2, TrendingUp, Palette, Users, FileText } from "lucide-react"
import { createMailCampaign } from "@/app/actions/direct-mail"
import {
  aiWritePostcardCopy,
  aiSuggestDesign,
  aiSelectTargetAudience,
  aiPredictCampaignROI,
} from "@/app/actions/ai-direct-mail"

import { createClient } from "@/lib/supabase/client"

interface CreateCampaignDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

const TEMPLATE_TYPE_OPTIONS = [
  { value: "just_listed", label: "Just Listed" },
  { value: "just_sold", label: "Just Sold" },
  { value: "market_update", label: "Market Update" },
  { value: "open_house", label: "Open House" },
  { value: "farming", label: "Farming" },
  { value: "brand_awareness", label: "Brand Awareness" },
]

// Expanded audience types for all real estate use cases
const TARGET_AUDIENCE_OPTIONS = [
  { value: "homeowners", label: "Homeowners in Target Area" },
  { value: "renters", label: "Renters (First-Time Buyer Prospects)" },
  { value: "fsbo", label: "FSBO (For Sale By Owner)" },
  { value: "expired", label: "Expired Listings" },
  { value: "divorce_probate", label: "Divorce / Probate Prospects" },
  { value: "investors", label: "Investor Prospects" },
  { value: "past_clients", label: "Past Clients (Sphere of Influence)" },
  { value: "geographic_farm", label: "Geographic Farm (Neighborhood)" },
  { value: "new_movers", label: "New Movers" },
]

export type AudienceSegment =
  | "homeowners"
  | "renters"
  | "fsbo"
  | "expired"
  | "divorce_probate"
  | "investors"
  | "past_clients"
  | "geographic_farm"
  | "new_movers"

// Average commission assumptions for ROI calculation
const AVG_COMMISSION_BY_SEGMENT: Record<AudienceSegment, number> = {
  homeowners: 15000,
  renters: 10000,
  fsbo: 18000,
  expired: 16000,
  divorce_probate: 14000,
  investors: 12000,
  past_clients: 15000,
  geographic_farm: 13000,
  new_movers: 10000,
}

// Estimated response rates per segment
const EST_RESPONSE_RATE_BY_SEGMENT: Record<AudienceSegment, number> = {
  homeowners: 0.012,
  renters: 0.008,
  fsbo: 0.025,
  expired: 0.022,
  divorce_probate: 0.018,
  investors: 0.015,
  past_clients: 0.035,
  geographic_farm: 0.01,
  new_movers: 0.014,
}

export function CreateCampaignDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateCampaignDialogProps) {
  const [creating, setCreating] = useState(false)
  const [agentId, setAgentId] = useState("")
  const [brokerageId, setBrokerageId] = useState("")

  // AI state
  const [aiCopyLoading, setAiCopyLoading] = useState(false)
  const [aiDesignLoading, setAiDesignLoading] = useState(false)
  const [aiAudienceLoading, setAiAudienceLoading] = useState(false)
  const [aiRoiLoading, setAiRoiLoading] = useState(false)
  const [aiCopyGenerated, setAiCopyGenerated] = useState(false)
  const [aiDesignSuggestion, setAiDesignSuggestion] = useState<any>(null)
  const [roiPrediction, setRoiPrediction] = useState<any>(null)

  const [formData, setFormData] = useState({
    campaignName: "",
    targetAudience: "",
    copyText: "",
    templateType: "just_listed",
    audienceSegment: "homeowners" as AudienceSegment,
    designUrl: "",
    quantity: 500,
    mailingDate: "",
    perPieceCost: 0.79,
    campaignGoal: "brand_awareness" as "listings" | "buyers" | "farming" | "brand_awareness" | "past_clients",
    area: "",
    budget: 500,
  })

  // Load session IDs on mount
  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }: { data: { user: any } }) => {
      if (!user) return
      setAgentId(user.id)
      const { data } = await supabase
        .from("users")
        .select("brokerage_id")
        .eq("id", user.id)
        .maybeSingle()
      if (data?.brokerage_id) setBrokerageId(data.brokerage_id)
    })
  }, [])

  async function handleAiWriteCopy() {
    if (!agentId || !brokerageId) {
      toast.error("Session not loaded yet, please wait.")
      return
    }
    setAiCopyLoading(true)
    try {
      const result = await aiWritePostcardCopy({
        agentId,
        brokerageId,
        templateType: formData.templateType,
        targetAudience: formData.audienceSegment,
        callToAction: "call",
      })
      if (result.success && result.copy) {
        const { copy } = result
        const generated = `${copy.headline}\n\n${copy.bodyText}\n\n${copy.callToAction}`
        setFormData((f) => ({ ...f, copyText: generated }))
        setAiCopyGenerated(true)
        toast.success("AI copy generated")
      } else {
        toast.error((result as any).error ?? "Failed to generate copy")
      }
    } catch {
      toast.error("Copy generation failed")
    } finally {
      setAiCopyLoading(false)
    }
  }

  async function handleAiSuggestDesign() {
    setAiDesignLoading(true)
    try {
      const result = await aiSuggestDesign({
        templateType: formData.templateType,
        targetDemo: formData.audienceSegment,
      })
      if (result.success && result.design) {
        setAiDesignSuggestion(result.design)
        toast.success("Design suggestion ready")
      } else {
        toast.error((result as any).error ?? "Failed to suggest design")
      }
    } catch {
      toast.error("Design suggestion failed")
    } finally {
      setAiDesignLoading(false)
    }
  }

  async function handleAiSelectAudience() {
    if (!agentId || !brokerageId) {
      toast.error("Session not loaded yet, please wait.")
      return
    }
    if (!formData.area) {
      toast.error("Please enter a target area first")
      return
    }
    setAiAudienceLoading(true)
    try {
      const result = await aiSelectTargetAudience({
        agentId,
        brokerageId,
        campaignGoal: formData.campaignGoal,
        budget: formData.budget,
        area: formData.area,
      })
      if (result.success && result.targeting) {
        const { targeting } = result
        const primary = targeting.primarySegment
        const description = `${primary.name}: ${primary.reasoning} (Est. ${primary.estimatedCount.toLocaleString()} contacts, ${(primary.estimatedResponseRate * 100).toFixed(1)}% response rate)`
        setFormData((f) => ({ ...f, targetAudience: description }))
        toast.success("Target audience selected")
      } else {
        toast.error((result as any).error ?? "Audience selection failed")
      }
    } catch {
      toast.error("Audience selection failed")
    } finally {
      setAiAudienceLoading(false)
    }
  }

  async function handlePredictROI() {
    if (!agentId || !brokerageId) {
      toast.error("Session not loaded yet, please wait.")
      return
    }
    setAiRoiLoading(true)
    try {
      const result = await aiPredictCampaignROI({
        agentId,
        brokerageId,
        mailType: "postcard_4x6",
        quantity: formData.quantity,
        targetSegment: formData.audienceSegment,
        avgHomeValue: 500000,
      })
      if (result.success && result.prediction) {
        setRoiPrediction({ ...result.prediction, costs: result.costs })
        toast.success("ROI prediction ready")
      } else {
        toast.error((result as any).error ?? "ROI prediction failed")
      }
    } catch {
      toast.error("ROI prediction failed")
    } finally {
      setAiRoiLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!agentId || !brokerageId) {
      toast.error("Session not loaded yet, please wait.")
      return
    }
    if (!formData.campaignName.trim()) {
      toast.error("Campaign name is required")
      return
    }
    if (!formData.targetAudience.trim()) {
      toast.error("Target audience is required")
      return
    }
    setCreating(true)
    try {
      const result = await createMailCampaign({
        brokerageId,
        agentId,
        campaignName: formData.campaignName.trim(),
        targetAudience: formData.targetAudience.trim(),
        designUrl: formData.designUrl || undefined,
        copyText: formData.copyText || undefined,
        quantity: formData.quantity,
        mailingDate: formData.mailingDate || undefined,
        perPieceCost: formData.perPieceCost,
        createdBy: agentId,
      })

      if (result.success) {
        const lobWarning = (result as any).lobWarning as string | undefined
        if (lobWarning) {
          toast.success(`Campaign saved — ${lobWarning}`)
        } else {
          toast.success("Campaign created")
        }
        setFormData({
          campaignName: "",
          targetAudience: "",
          copyText: "",
          templateType: "just_listed",
          audienceSegment: "homeowners",
          designUrl: "",
          quantity: 500,
          mailingDate: "",
          perPieceCost: 0.79,
          campaignGoal: "brand_awareness",
          area: "",
          budget: 500,
        })
        setAiCopyGenerated(false)
        setAiDesignSuggestion(null)
        setRoiPrediction(null)
        onCreated()
      } else {
        toast.error((result as any).error ?? "Failed to create campaign")
      }
    } catch {
      toast.error("Failed to create campaign")
    } finally {
      setCreating(false)
    }
  }

  // ── Static ROI calculation ─────────────────────────────────────────────────
  const totalCost = formData.quantity * formData.perPieceCost
  const responseRate = EST_RESPONSE_RATE_BY_SEGMENT[formData.audienceSegment] ?? 0.01
  const avgCommission = AVG_COMMISSION_BY_SEGMENT[formData.audienceSegment] ?? 12000
  const estimatedResponses = Math.round(formData.quantity * responseRate)
  const projectedRevenue = estimatedResponses * avgCommission
  const staticROI = totalCost > 0 ? ((projectedRevenue - totalCost) / totalCost) * 100 : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Mail Campaign</DialogTitle>
            <DialogDescription>
              Set up a new direct mail campaign. Use AI to write copy, suggest design, and select your audience.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-4">
            {/* Campaign Name */}
            <div className="grid gap-2">
              <Label htmlFor="campaignName">Campaign Name</Label>
              <Input
                id="campaignName"
                placeholder="e.g., Spring 2026 Farm Postcards"
                value={formData.campaignName}
                onChange={(e) => setFormData({ ...formData, campaignName: e.target.value })}
                required
              />
            </div>

            {/* Template Type + Audience Segment */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Campaign Type</Label>
                <Select
                  value={formData.templateType}
                  onValueChange={(v) => setFormData({ ...formData, templateType: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Audience Type</Label>
                <Select
                  value={formData.audienceSegment}
                  onValueChange={(v) =>
                    setFormData({ ...formData, audienceSegment: v as AudienceSegment })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TARGET_AUDIENCE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Separator />

            {/* AI SECTION — Copy */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="copyText">Postcard Copy</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAiWriteCopy}
                  disabled={aiCopyLoading}
                >
                  {aiCopyLoading ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  AI Write Copy
                </Button>
              </div>
              <div className="relative">
                <Textarea
                  id="copyText"
                  placeholder="Headline, body copy, and call to action..."
                  value={formData.copyText}
                  onChange={(e) => setFormData({ ...formData, copyText: e.target.value })}
                  rows={4}
                  className={aiCopyGenerated ? "border-primary ring-1 ring-primary" : ""}
                />
                {aiCopyGenerated && (
                  <Badge className="absolute top-2 right-2 text-[10px] bg-primary/10 text-primary border-0">
                    AI Generated
                  </Badge>
                )}
              </div>
            </div>

            {/* AI SECTION — Design */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Design</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAiSuggestDesign}
                  disabled={aiDesignLoading}
                >
                  {aiDesignLoading ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Palette className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  AI Suggest Design
                </Button>
              </div>
              <Input
                type="url"
                placeholder="https://example.com/design.pdf (or use AI suggestion below)"
                value={formData.designUrl}
                onChange={(e) => setFormData({ ...formData, designUrl: e.target.value })}
              />
              {aiDesignSuggestion && (
                <div className="rounded-lg border bg-muted/50 p-3 text-sm space-y-2">
                  <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">AI Design Suggestion</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Layout: </span>
                      <span className="font-medium capitalize">{aiDesignSuggestion.layout?.style?.replace(/_/g, " ")}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Finish: </span>
                      <span className="font-medium capitalize">{aiDesignSuggestion.printSpecs?.finish}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Headline font: </span>
                      <span className="font-medium">{aiDesignSuggestion.typography?.headlineFont}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">Colors: </span>
                      {aiDesignSuggestion.colorScheme && (
                        <div className="flex gap-0.5">
                          {[aiDesignSuggestion.colorScheme.primary, aiDesignSuggestion.colorScheme.secondary, aiDesignSuggestion.colorScheme.accent].map((c: string, i: number) => (
                            <span key={i} className="inline-block h-3.5 w-3.5 rounded-sm border" style={{ background: c }} />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* AI SECTION — Audience */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="targetAudience">Target Audience Description</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAiSelectAudience}
                  disabled={aiAudienceLoading}
                >
                  {aiAudienceLoading ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Users className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  AI Select Audience
                </Button>
              </div>
              <Textarea
                id="targetAudience"
                placeholder="Describe your target audience, or click AI Select Audience to auto-fill"
                value={formData.targetAudience}
                onChange={(e) => setFormData({ ...formData, targetAudience: e.target.value })}
                required
                rows={2}
              />
              <div className="grid grid-cols-3 gap-2">
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">Area / City</Label>
                  <Input
                    placeholder="e.g., Austin, TX"
                    value={formData.area}
                    onChange={(e) => setFormData({ ...formData, area: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">Campaign Goal</Label>
                  <Select
                    value={formData.campaignGoal}
                    onValueChange={(v) => setFormData({ ...formData, campaignGoal: v as typeof formData.campaignGoal })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="listings">Get Listings</SelectItem>
                      <SelectItem value="buyers">Find Buyers</SelectItem>
                      <SelectItem value="farming">Farming</SelectItem>
                      <SelectItem value="brand_awareness">Brand Awareness</SelectItem>
                      <SelectItem value="past_clients">Past Clients</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">Budget ($)</Label>
                  <Input
                    type="number"
                    min="100"
                    value={formData.budget}
                    onChange={(e) => setFormData({ ...formData, budget: parseInt(e.target.value) || 500 })}
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* Quantity, date, cost */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Quantity</Label>
                <Select
                  value={formData.quantity.toString()}
                  onValueChange={(v) => setFormData({ ...formData, quantity: parseInt(v) })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[100, 250, 500, 1000, 2500, 5000, 10000].map((n) => (
                      <SelectItem key={n} value={n.toString()}>
                        {n.toLocaleString()} pieces
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Mailing Date (Optional)</Label>
                <Input
                  type="date"
                  value={formData.mailingDate}
                  onChange={(e) => setFormData({ ...formData, mailingDate: e.target.value })}
                  min={new Date().toISOString().split("T")[0]}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Cost Per Piece ($)</Label>
              <Input
                type="number"
                step="0.01"
                min="0.10"
                value={formData.perPieceCost}
                onChange={(e) => setFormData({ ...formData, perPieceCost: parseFloat(e.target.value) || 0 })}
              />
            </div>

            {/* ROI Prediction */}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">ROI Prediction</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handlePredictROI}
                  disabled={aiRoiLoading}
                >
                  {aiRoiLoading ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <TrendingUp className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  AI Predict ROI
                </Button>
              </div>
              {roiPrediction ? (
                <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-lg font-bold text-primary">
                        {(roiPrediction.estimatedResponseRate * 100).toFixed(1)}%
                      </p>
                      <p className="text-xs text-muted-foreground">Response Rate</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold">{roiPrediction.estimatedLeads}</p>
                      <p className="text-xs text-muted-foreground">Est. Leads</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-green-600">
                        {roiPrediction.roi > 0 ? "+" : ""}{roiPrediction.roi.toFixed(0)}%
                      </p>
                      <p className="text-xs text-muted-foreground">AI ROI</p>
                    </div>
                  </div>
                  {roiPrediction.costs && (
                    <p className="text-xs text-muted-foreground text-center">
                      Total cost: ${roiPrediction.costs.total.toFixed(2)} — Est. GCI: ${roiPrediction.estimatedGCI?.toLocaleString() ?? "—"}
                    </p>
                  )}
                  <Badge variant="outline" className="text-xs">
                    Confidence: {roiPrediction.confidenceLevel}
                  </Badge>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/50 p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Estimated ROI</p>
                  <div className="grid grid-cols-3 gap-3 text-center mt-1">
                    <div>
                      <p className="text-base font-bold text-primary">
                        {(responseRate * 100).toFixed(1)}%
                      </p>
                      <p className="text-xs text-muted-foreground">Est. Response</p>
                    </div>
                    <div>
                      <p className="text-base font-bold">{estimatedResponses}</p>
                      <p className="text-xs text-muted-foreground">Est. Responses</p>
                    </div>
                    <div>
                      <p className={`text-base font-bold ${staticROI >= 0 ? "text-green-600" : "text-destructive"}`}>
                        {staticROI > 0 ? "+" : ""}{staticROI.toFixed(0)}%
                      </p>
                      <p className="text-xs text-muted-foreground">Est. ROI</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    ${totalCost.toFixed(2)} cost — ${projectedRevenue.toLocaleString()} projected revenue
                  </p>
                  <p className="text-[10px] text-muted-foreground text-center">
                    Based on industry benchmarks · Click AI Predict ROI for detailed analysis
                  </p>
                </div>
              )}
            </div>

            {/* Cost summary */}
            <div className="rounded-lg bg-muted p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Estimated Total Cost</span>
                <span className="text-lg font-bold">
                  ${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {formData.quantity.toLocaleString()} pieces × ${formData.perPieceCost.toFixed(2)}/piece
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={creating || !formData.campaignName || !formData.targetAudience}
            >
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Campaign"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
