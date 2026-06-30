"use client"

/**
 * CdaSetupPanel — admin/broker onboarding card for the brokerage's CDA
 * (Commission Disbursement Authorization) policy.
 *
 *   • Captures whether the brokerage offers CDAs at all
 *   • If yes → upload CDA template PDFs (per state + transaction type)
 *   • If no  → set the default non-CDA payout method (DD or check)
 *
 * Delegates 100% of writes to existing server actions in
 * app/actions/brokerage-cda-setup.ts (no new actions / no schema changes
 * here). Slot into admin-onboarding-os-client.tsx alongside
 * SetupBlockersPanel / ProviderReadinessPanel.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ShieldCheck, FileText, Upload, ExternalLink, AlertTriangle, Loader2 } from "lucide-react"
import {
  setBrokerageCdaSettingAction,
  getBrokerageCdaSettingAction,
  uploadCdaTemplateAction,
  listCdaTemplatesAction,
  deactivateCdaTemplateAction,
} from "@/app/actions/brokerage-cda-setup"
import { ALL_US_STATES } from "@/lib/state-forms/registry"
import { upload } from "@vercel/blob/client"
import { toast } from "sonner"
import { CdaFieldMappingEditor } from "./cda-field-mapping-editor"

type Template = {
  id: string
  name: string
  description: string | null
  state: string | null
  transaction_type: string | null
  pdf_url: string | null
  is_active: boolean
}

const TX_TYPES = [
  { value: "sale_buy",  label: "Buy-side sale" },
  { value: "sale_sell", label: "Sell-side sale" },
  { value: "dual",      label: "Dual" },
  { value: "lease",     label: "Lease" },
  { value: "referral",  label: "Referral" },
] as const

export function CdaSetupPanel() {
  const [loading, setLoading] = useState(true)
  const [offersCda, setOffersCda] = useState<boolean | null>(null)
  const [payoutDefault, setPayoutDefault] = useState<"direct_deposit" | "check">("direct_deposit")
  const [templates, setTemplates] = useState<Template[]>([])
  const [pending, startTransition] = useTransition()

  // Upload form state
  const [tplName, setTplName] = useState("")
  const [tplDescription, setTplDescription] = useState("")
  const [tplState, setTplState] = useState<string>("")
  const [tplType, setTplType] = useState<string>("")
  const [uploading, setUploading] = useState(false)
  const [mappingTemplate, setMappingTemplate] = useState<Template | null>(null)

  useEffect(() => { void reload() }, [])

  async function reload() {
    setLoading(true)
    const settings = await getBrokerageCdaSettingAction()
    if (settings.success) {
      setOffersCda(settings.offersCda)
      if (settings.payoutDefault === "direct_deposit" || settings.payoutDefault === "check") {
        setPayoutDefault(settings.payoutDefault)
      }
    }
    const tpls = await listCdaTemplatesAction({ includeInactive: false })
    if (tpls.success) setTemplates(tpls.templates as Template[])
    setLoading(false)
  }

  async function saveSetting(nextOffers: boolean, nextPayout: typeof payoutDefault) {
    startTransition(async () => {
      const res = await setBrokerageCdaSettingAction({
        offersCda: nextOffers,
        nonCdaPayoutDefault: nextOffers ? null : nextPayout,
      })
      if (res.success) {
        setOffersCda(nextOffers)
        setPayoutDefault(nextPayout)
        toast.success("CDA setting saved")
      } else {
        toast.error("error" in res ? res.error : "Save failed")
      }
    })
  }

  async function handleUpload(file: File) {
    if (!tplName.trim()) { toast.error("Template name required"); return }
    setUploading(true)
    try {
      const blob = await upload(`cda-templates/${file.name}`, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
      })
      const res = await uploadCdaTemplateAction({
        name:            tplName.trim(),
        description:     tplDescription.trim() || undefined,
        state:           tplState || undefined,
        transactionType: (tplType || undefined) as any,
        pdfUrl:          blob.url,
      })
      if (res.success) {
        toast.success("Template uploaded")
        setTplName(""); setTplDescription(""); setTplState(""); setTplType("")
        void reload()
      } else {
        toast.error("error" in res ? res.error : "Upload failed")
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  async function handleDeactivate(id: string) {
    if (!confirm("Deactivate this CDA template? Existing in-flight CDAs are unaffected.")) return
    const res = await deactivateCdaTemplateAction({ id })
    if (res.success) {
      toast.success("Template deactivated")
      void reload()
    } else {
      toast.error("error" in res ? res.error : "Deactivate failed")
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> CDA Setup</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> CDA Setup</CardTitle>
        <CardDescription>
          Does your brokerage offer Commission Disbursement Authorizations? CDAs let agents get paid
          at closing directly from title or the closing attorney instead of waiting for the brokerage
          to disburse after funds clear.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Offers CDA toggle */}
        <div className="flex items-start gap-3">
          <Button
            variant={offersCda === true ? "default" : "outline"}
            disabled={pending}
            onClick={() => saveSetting(true, payoutDefault)}
          >
            We offer CDAs
          </Button>
          <Button
            variant={offersCda === false ? "default" : "outline"}
            disabled={pending}
            onClick={() => saveSetting(false, payoutDefault)}
          >
            We don't offer CDAs
          </Button>
        </div>

        {/* Non-CDA payout default */}
        {offersCda === false && (
          <div className="rounded-lg bg-muted p-3 space-y-2">
            <Label className="text-xs font-semibold">Default payout method (when an agent doesn't pick one)</Label>
            <Select
              value={payoutDefault}
              onValueChange={(v) => saveSetting(false, v as typeof payoutDefault)}
              disabled={pending}
            >
              <SelectTrigger className="w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct_deposit">Direct deposit</SelectItem>
                <SelectItem value="check">Check</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Template library — only visible when CDAs are offered */}
        {offersCda === true && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">CDA template library</Label>
              <Badge variant="outline">{templates.length} active</Badge>
            </div>

            {templates.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                <AlertTriangle className="h-5 w-5 mx-auto mb-1 text-amber-600" />
                No CDA templates uploaded yet. Agents won't have a form to fill out at closing.
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map(t => (
                  <div key={t.id} className="space-y-2">
                    <div className="flex items-center gap-3 rounded-lg border p-3">
                      <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{t.name}</span>
                          {t.state && <Badge variant="outline" className="text-[10px]">{t.state}</Badge>}
                          {t.transaction_type && <Badge variant="outline" className="text-[10px]">{t.transaction_type}</Badge>}
                        </div>
                        {t.description && <p className="text-xs text-muted-foreground truncate">{t.description}</p>}
                      </div>
                      {t.pdf_url && (
                        <a href={t.pdf_url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                      <Button
                        variant={mappingTemplate?.id === t.id ? "default" : "outline"}
                        size="sm"
                        onClick={() => setMappingTemplate(mappingTemplate?.id === t.id ? null : t)}
                      >
                        Map fields
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void handleDeactivate(t.id)}>Deactivate</Button>
                    </div>
                    {mappingTemplate?.id === t.id && (
                      <CdaFieldMappingEditor
                        templateId={t.id}
                        templateName={t.name}
                        onClose={() => setMappingTemplate(null)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Upload form */}
            <div className="rounded-lg border p-3 space-y-3">
              <Label className="text-sm font-semibold">Upload a new CDA template</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input placeholder="Template name (required)" value={tplName} onChange={e => setTplName(e.target.value)} />
                <Input placeholder="Description (optional)" value={tplDescription} onChange={e => setTplDescription(e.target.value)} />
                <Select value={tplState} onValueChange={setTplState}>
                  <SelectTrigger><SelectValue placeholder="State (optional — universal if blank)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Universal (any state)</SelectItem>
                    {ALL_US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={tplType} onValueChange={setTplType}>
                  <SelectTrigger><SelectValue placeholder="Transaction type (optional)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Any type</SelectItem>
                    {TX_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <input
                  id="cda-template-pdf"
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) void handleUpload(f)
                    e.currentTarget.value = ""
                  }}
                />
                <Button
                  variant="outline"
                  disabled={uploading || !tplName.trim()}
                  onClick={() => document.getElementById("cda-template-pdf")?.click()}
                >
                  {uploading
                    ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading…</>
                    : <><Upload className="h-4 w-4 mr-2" /> Choose PDF & upload</>}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
