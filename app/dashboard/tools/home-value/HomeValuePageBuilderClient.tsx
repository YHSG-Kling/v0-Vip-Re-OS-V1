"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { savePageConfig, convertValuationRequestToContact, type HomeValuePageConfig, type WorkingHourSlot } from "@/app/actions/home-value"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Copy, Check, ExternalLink, Save, Globe, Clock, ClipboardList, Palette, Inbox, ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"

// ── Next-action logic ─────────────────────────────────────────────────────────
// Uses only real columns that exist on valuation_requests post-migration:
//   qualification_data, contact_id, cma_sent, appointment_scheduled

interface NextAction {
  label: string
  urgency: "high" | "medium" | "low"
}

function getNextAction(request: ValuationRequest): NextAction {
  if (!request.qualification_data) return { label: "Qualify seller", urgency: "high" }
  if (!request.contact_id)         return { label: "Convert to contact", urgency: "high" }
  if (!(request as any).cma_sent)  return { label: "Send CMA", urgency: "medium" }
  if (!(request as any).appointment_scheduled) return { label: "Book consultation", urgency: "medium" }
  return { label: "Track listing", urgency: "low" }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const QUESTION_FIELDS: Array<{
  key: keyof HomeValuePageConfig
  labelKey: keyof HomeValuePageConfig
  defaultLabel: string
  description: string
}> = [
  {
    key: "showQSellTimeline",
    labelKey: "labelSellTimeline",
    defaultLabel: "When are you thinking about selling?",
    description: "Sell timeline",
  },
  {
    key: "showQMotivation",
    labelKey: "labelMotivation",
    defaultLabel: "What's driving the potential sale?",
    description: "Motivation",
  },
  {
    key: "showQMortgageStatus",
    labelKey: "labelMortgageStatus",
    defaultLabel: "What's the mortgage situation?",
    description: "Mortgage status",
  },
  {
    key: "showQPriceExpectation",
    labelKey: "labelPriceExpectation",
    defaultLabel: "What price range are you expecting?",
    description: "Price expectation",
  },
  {
    key: "showQHasAgent",
    labelKey: "labelHasAgent",
    defaultLabel: "Are you currently working with a real estate agent?",
    description: "Agent status",
  },
  {
    key: "showQBuyAfterSell",
    labelKey: "labelBuyAfterSell",
    defaultLabel: "Will you be buying after you sell?",
    description: "Buy after sell",
  },
  {
    key: "showQAdditionalNotes",
    labelKey: "labelBuyAfterSell", // notes has no custom label
    defaultLabel: "Anything else we should know?",
    description: "Additional notes (optional)",
  },
]

const DEFAULT_WORKING_HOURS: WorkingHourSlot[] = [
  { day: 1, start_hour: 9, end_hour: 17 },
  { day: 2, start_hour: 9, end_hour: 17 },
  { day: 3, start_hour: 9, end_hour: 17 },
  { day: 4, start_hour: 9, end_hour: 17 },
  { day: 5, start_hour: 9, end_hour: 17 },
]

function defaultConfig(agentId: string, brokerageId: string): HomeValuePageConfig {
  return {
    agentId,
    brokerageId,
    headline: "What's Your Home Worth?",
    subheadline: "Get a free AI-powered estimate in minutes — no obligation.",
    ctaButtonText: "Get My Free Estimate",
    primaryColor: "#6366f1",
    agentBioOverride: null,
    showQSellTimeline: true,
    showQMotivation: true,
    showQMortgageStatus: true,
    showQPriceExpectation: true,
    showQHasAgent: true,
    showQBuyAfterSell: true,
    showQAdditionalNotes: true,
    labelSellTimeline: null,
    labelMotivation: null,
    labelMortgageStatus: null,
    labelPriceExpectation: null,
    labelHasAgent: null,
    labelBuyAfterSell: null,
    workingHours: DEFAULT_WORKING_HOURS,
    showScheduler: true,
  }
}

interface ValuationRequest {
  id: string
  property_address: string | null
  bedrooms: number | null
  bathrooms: number | null
  square_feet: number | null
  condition: string | null
  qualification_data: Record<string, string> | null
  utm_source: string | null
  submitted_at: string | null
  contact_id: string | null
  cma_sent: boolean | null
  appointment_scheduled: boolean | null
  contacts: { first_name: string | null; last_name: string | null; email: string | null } | null
}

interface Props {
  agentId: string
  userId: string
  brokerageId: string
  agentSlug: string
  baseUrl: string
  initialConfig: HomeValuePageConfig | null
  newRequests: ValuationRequest[]
  convertedRequests: ValuationRequest[]
}

export function HomeValuePageBuilderClient({
  agentId,
  userId,
  brokerageId,
  agentSlug,
  baseUrl,
  initialConfig,
  newRequests,
  convertedRequests,
}: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const [config, setConfig] = useState<HomeValuePageConfig>(
    initialConfig ?? defaultConfig(agentId, brokerageId),
  )
  const [activeTab, setActiveTab] = useState<Tab>("branding")
  const [isPending, startTransition] = useTransition()
  const [copied, setCopied] = useState(false)
  const [convertingId, setConvertingId] = useState<string | null>(null)

  const pageUrl = `${baseUrl}/home-value?agent=${agentSlug}&brokerage=${brokerageId}`
  const embedSnippet = `<iframe
  src="${pageUrl}"
  width="100%"
  height="820"
  frameborder="0"
  style="border-radius:12px;max-width:680px;"
  title="Home Value Estimate"
></iframe>`

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function set<K extends keyof HomeValuePageConfig>(key: K, value: HomeValuePageConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }))
  }

  async function handleConvert(requestId: string) {
    setConvertingId(requestId)
    try {
      const res = await convertValuationRequestToContact({
        requestId,
        brokerageId,
        agentId,
        userId,
      })
      if (res.success) {
        toast({ title: "Contact created — portal invite sent" })
        router.refresh()
      } else {
        toast({ title: "Convert failed", description: res.error, variant: "destructive" })
      }
    } finally {
      setConvertingId(null)
    }
  }

  function handleSave() {
    startTransition(async () => {
      const result = await savePageConfig(config)
      if (result.success) {
        toast({ title: "Page saved", description: "Your home value page is live." })
        router.refresh()
      } else {
        toast({ title: "Save failed", description: result.error, variant: "destructive" })
      }
    })
  }

  // Working hours helpers
  function toggleDay(day: number) {
    const existing = config.workingHours.find((h) => h.day === day)
    if (existing) {
      setConfig((prev) => ({
        ...prev,
        workingHours: prev.workingHours.filter((h) => h.day !== day),
      }))
    } else {
      setConfig((prev) => ({
        ...prev,
        workingHours: [...prev.workingHours, { day, start_hour: 9, end_hour: 17 }].sort(
          (a, b) => a.day - b.day,
        ),
      }))
    }
  }

  function setHour(day: number, field: "start_hour" | "end_hour", value: number) {
    setConfig((prev) => ({
      ...prev,
      workingHours: prev.workingHours.map((h) =>
        h.day === day ? { ...h, [field]: value } : h,
      ),
    }))
  }

  const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: "branding", label: "Branding", icon: <Palette className="h-4 w-4" /> },
    { id: "questions", label: "Questions", icon: <ClipboardList className="h-4 w-4" /> },
    { id: "hours", label: "Hours", icon: <Clock className="h-4 w-4" /> },
    { id: "embed", label: "Publish", icon: <Globe className="h-4 w-4" /> },
    {
      id: "requests",
      label: "Requests",
      icon: <Inbox className="h-4 w-4" />,
      badge: newRequests.length > 0 ? newRequests.length : undefined,
    },
  ]

  const activeQCount = QUESTION_FIELDS.filter(
    (f) => config[f.key as keyof HomeValuePageConfig] === true,
  ).length

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Home Value Page Builder</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Customize the page you share with sellers
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" asChild>
            <a href={pageUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Preview Live
            </a>
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>

      <div className="flex h-[calc(100vh-73px)]">
        {/* Settings Panel */}
        <div className="w-[420px] shrink-0 border-r overflow-y-auto bg-card">
          {/* Tab nav */}
          <div className="flex border-b px-4 pt-3 gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-md border-b-2 transition-colors",
                  activeTab === t.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.icon}
                {t.label}
                {t.badge != null && (
                  <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-semibold text-white">
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="p-5 space-y-6">
            {/* ── Branding ── */}
            {activeTab === "branding" && (
              <>
                <section className="space-y-4">
                  <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
                    Page Content
                  </h2>

                  <div className="space-y-2">
                    <Label htmlFor="headline">Headline</Label>
                    <Input
                      id="headline"
                      value={config.headline}
                      onChange={(e) => set("headline", e.target.value)}
                      placeholder="What's Your Home Worth?"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="subheadline">Subheadline</Label>
                    <Input
                      id="subheadline"
                      value={config.subheadline}
                      onChange={(e) => set("subheadline", e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ctaText">Button Text</Label>
                    <Input
                      id="ctaText"
                      value={config.ctaButtonText}
                      onChange={(e) => set("ctaButtonText", e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="primaryColor">Accent Color</Label>
                    <div className="flex items-center gap-3">
                      <input
                        id="primaryColor"
                        type="color"
                        value={config.primaryColor}
                        onChange={(e) => set("primaryColor", e.target.value)}
                        className="h-9 w-16 cursor-pointer rounded border border-input"
                      />
                      <Input
                        value={config.primaryColor}
                        onChange={(e) => set("primaryColor", e.target.value)}
                        className="font-mono text-sm w-32"
                        maxLength={7}
                      />
                    </div>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
                    Agent Bio
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Shown above the form. Leave blank to use your profile bio.
                  </p>
                  <Textarea
                    value={config.agentBioOverride ?? ""}
                    onChange={(e) =>
                      set("agentBioOverride", e.target.value || null)
                    }
                    rows={4}
                    placeholder="Helping Austin homeowners maximize their equity for over 15 years..."
                    className="resize-none text-sm"
                  />
                </section>

                <Separator />

                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">
                        Appointment Scheduler
                      </h2>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Show scheduling widget on the result page
                      </p>
                    </div>
                    <Switch
                      checked={config.showScheduler}
                      onCheckedChange={(v) => set("showScheduler", v)}
                    />
                  </div>
                </section>
              </>
            )}

            {/* ── Questions ── */}
            {activeTab === "questions" && (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">
                      Qualification Questions
                    </h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {activeQCount} of {QUESTION_FIELDS.length} questions active
                    </p>
                  </div>
                  <Badge variant="secondary">{activeQCount} shown</Badge>
                </div>

                <div className="space-y-4">
                  {QUESTION_FIELDS.map((field) => {
                    const isOn = config[field.key as keyof HomeValuePageConfig] as boolean
                    const labelValue =
                      field.key !== "showQAdditionalNotes"
                        ? (config[field.labelKey as keyof HomeValuePageConfig] as string | null) ??
                          ""
                        : null

                    return (
                      <div
                        key={field.key}
                        className={cn(
                          "rounded-lg border p-4 space-y-3 transition-colors",
                          isOn ? "border-border bg-background" : "border-dashed bg-muted/30 opacity-60",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground">
                              {field.description}
                            </p>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {field.defaultLabel}
                            </p>
                          </div>
                          <Switch
                            checked={isOn}
                            onCheckedChange={(v) =>
                              set(field.key as keyof HomeValuePageConfig, v as any)
                            }
                          />
                        </div>

                        {isOn && labelValue !== null && (
                          <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">
                              Custom label (optional)
                            </Label>
                            <Input
                              value={labelValue}
                              placeholder={field.defaultLabel}
                              onChange={(e) =>
                                set(
                                  field.labelKey as keyof HomeValuePageConfig,
                                  (e.target.value || null) as any,
                                )
                              }
                              className="text-sm h-8"
                            />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {/* ── Hours ── */}
            {activeTab === "hours" && (
              <>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">
                    Appointment Availability
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Homeowners see slots at least 48 hours out. Toggle days on or off and set start
                    and end hours for each day. Evening hours are supported.
                  </p>
                </div>

                <div className="space-y-3">
                  {DAYS.map((dayName, dayIndex) => {
                    const slot = config.workingHours.find((h) => h.day === dayIndex)
                    const isActive = !!slot

                    return (
                      <div
                        key={dayIndex}
                        className={cn(
                          "rounded-lg border p-3 transition-colors",
                          isActive ? "border-border bg-background" : "border-dashed bg-muted/30 opacity-60",
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={isActive}
                            onCheckedChange={() => toggleDay(dayIndex)}
                          />
                          <span className="w-8 text-sm font-medium text-foreground">{dayName}</span>

                          {isActive && slot && (
                            <div className="flex items-center gap-2 flex-1">
                              <select
                                value={slot.start_hour}
                                onChange={(e) =>
                                  setHour(dayIndex, "start_hour", parseInt(e.target.value))
                                }
                                className="flex-1 text-sm border border-input rounded-md px-2 py-1 bg-background text-foreground"
                              >
                                {Array.from({ length: 24 }, (_, i) => (
                                  <option key={i} value={i}>
                                    {i === 0
                                      ? "12:00 AM"
                                      : i < 12
                                      ? `${i}:00 AM`
                                      : i === 12
                                      ? "12:00 PM"
                                      : `${i - 12}:00 PM`}
                                  </option>
                                ))}
                              </select>
                              <span className="text-xs text-muted-foreground">to</span>
                              <select
                                value={slot.end_hour}
                                onChange={(e) =>
                                  setHour(dayIndex, "end_hour", parseInt(e.target.value))
                                }
                                className="flex-1 text-sm border border-input rounded-md px-2 py-1 bg-background text-foreground"
                              >
                                {Array.from({ length: 24 }, (_, i) => (
                                  <option key={i} value={i} disabled={i <= slot.start_hour}>
                                    {i === 0
                                      ? "12:00 AM"
                                      : i < 12
                                      ? `${i}:00 AM`
                                      : i === 12
                                      ? "12:00 PM"
                                      : `${i - 12}:00 PM`}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          {!isActive && (
                            <span className="text-xs text-muted-foreground ml-2">Unavailable</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {/* ── Embed ── */}
            {activeTab === "embed" && (
              <>
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Publish Your Page</h2>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Share the direct link or embed the form on your website using the iframe snippet.
                    Save your settings first.
                  </p>
                </div>

                {/* Direct link */}
                <section className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Direct Link
                  </h3>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-muted rounded-md px-3 py-2 font-mono text-foreground truncate">
                      {pageUrl}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopy(pageUrl)}
                    >
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </section>

                <Separator />

                {/* Embed snippet */}
                <section className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Website Embed (iframe)
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Paste this into any page on your website where you want the form to appear.
                  </p>
                  <div className="relative">
                    <pre className="bg-muted rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {embedSnippet}
                    </pre>
                    <Button
                      variant="outline"
                      size="sm"
                      className="absolute top-2 right-2"
                      onClick={() => handleCopy(embedSnippet)}
                    >
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </section>

                <Separator />

                {/* WordPress / Webflow tips */}
                <section className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Platform Instructions
                  </h3>
                  <div className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                    <p>
                      <span className="font-semibold text-foreground">WordPress:</span> Add a
                      "Custom HTML" block and paste the embed code.
                    </p>
                    <p>
                      <span className="font-semibold text-foreground">Webflow:</span> Use an Embed
                      element in your designer and paste the code.
                    </p>
                    <p>
                      <span className="font-semibold text-foreground">Squarespace:</span> Add a
                      Code Block and paste.
                    </p>
                    <p>
                      <span className="font-semibold text-foreground">Wix:</span> Add {"→"} Embed
                      Code {"→"} Embed HTML, paste the snippet.
                    </p>
                  </div>
                </section>
              </>
            )}

            {/* ── Requests tab ── */}
            {activeTab === "requests" && (
              <div className="space-y-6">
                {/* New requests */}
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
                    New Requests ({newRequests.length})
                  </h2>
                  {newRequests.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No new requests yet.</p>
                  ) : (
                    newRequests.map((req) => {
                      const qual = (req.qualification_data as any) ?? {}
                      const next = getNextAction(req)
                      return (
                        <Card key={req.id} className="border-orange-200">
                          <CardContent className="p-4 space-y-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="space-y-0.5 min-w-0">
                                <p className="font-medium text-sm leading-snug truncate">
                                  {req.property_address ?? "Unknown address"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {[req.bedrooms && `${req.bedrooms}bd`, req.bathrooms && `${req.bathrooms}ba`, req.square_feet && `${req.square_feet.toLocaleString()} sqft`, req.condition].filter(Boolean).join(" · ")}
                                </p>
                                <div className="space-y-0.5 pt-1">
                                  {qual.sellTimeline && (
                                    <p className="text-xs text-muted-foreground">Timeline: {qual.sellTimeline}</p>
                                  )}
                                  {qual.motivation && (
                                    <p className="text-xs text-muted-foreground">Motivation: {qual.motivation}</p>
                                  )}
                                  {qual.hasAgent === "no" && (
                                    <p className="text-xs text-green-700 font-medium">No agent yet</p>
                                  )}
                                  {req.utm_source && (
                                    <p className="text-xs text-muted-foreground">Source: {req.utm_source}</p>
                                  )}
                                </div>
                              </div>
                              <div className="flex flex-col items-end gap-1.5 shrink-0">
                                {req.submitted_at && (
                                  <span className="text-xs text-muted-foreground">
                                    {format(new Date(req.submitted_at), "MMM d, h:mm a")}
                                  </span>
                                )}
                                {/* Next-action badge */}
                                <Badge
                                  className={cn(
                                    "text-xs flex items-center gap-1",
                                    next.urgency === "high"
                                      ? "bg-red-100 text-red-800 border-red-200"
                                      : next.urgency === "medium"
                                      ? "bg-amber-100 text-amber-800 border-amber-200"
                                      : "bg-green-100 text-green-800 border-green-200",
                                  )}
                                  variant="outline"
                                >
                                  <ArrowRight className="h-2.5 w-2.5" />
                                  {next.label}
                                </Badge>
                              </div>
                            </div>
                            {/* Quick-action buttons */}
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                disabled={convertingId === req.id}
                                onClick={() => handleConvert(req.id)}
                              >
                                {convertingId === req.id ? "Converting..." : "Convert to Contact"}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  router.push(
                                    `/dashboard/listings?new_cma=true&address=${encodeURIComponent(req.property_address ?? "")}`,
                                  )
                                }
                              >
                                Open CMA Builder
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  router.push(
                                    `/dashboard/calendar?new=true&title=${encodeURIComponent(`Consultation: ${req.property_address ?? "property"}`)}`,
                                  )
                                }
                              >
                                Schedule Consultation
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-indigo-700 hover:text-indigo-800"
                                onClick={() =>
                                  router.push(
                                    `/dashboard/ai-isa?source=home_value&request=${req.id}`,
                                  )
                                }
                              >
                                Send to AI-ISA
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      )
                    })
                  )}
                </section>

                <Separator />

                {/* Converted */}
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">
                    Converted ({convertedRequests.length})
                  </h2>
                  {convertedRequests.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No converted requests yet.</p>
                  ) : (
                    <div className="divide-y divide-border rounded-md border border-border">
                      {convertedRequests.map((req) => {
                        const c = req.contacts
                        return (
                          <div key={req.id} className="flex items-center justify-between px-3 py-2.5 gap-2">
                            <div className="min-w-0 space-y-0.5">
                              <p className="text-sm font-medium truncate">
                                {req.property_address ?? "Unknown address"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {c ? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.email : ""}
                              </p>
                            </div>
                            <Link href={`/crm?contactId=${req.contact_id}`}>
                              <Button size="sm" variant="outline">
                                View in CRM
                              </Button>
                            </Link>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>

        {/* Live Preview Panel */}
        <div className="flex-1 overflow-hidden bg-muted/20 flex flex-col">
          <div className="border-b bg-card px-5 py-3 flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">Live Preview</p>
            <Badge variant="outline" className="text-xs">
              Updates as you type
            </Badge>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            <div className="mx-auto max-w-lg">
              {/* Mini page preview */}
              <div
                className="rounded-2xl border shadow-sm bg-white overflow-hidden"
                style={{ fontFamily: "system-ui, sans-serif" }}
              >
                {/* Hero */}
                <div
                  className="px-8 py-10 text-center"
                  style={{ background: `linear-gradient(135deg, ${config.primaryColor}18 0%, white 100%)` }}
                >
                  <h1
                    className="text-2xl font-bold leading-tight"
                    style={{ color: "#0f172a" }}
                  >
                    {config.headline || "What's Your Home Worth?"}
                  </h1>
                  <p className="text-sm mt-2" style={{ color: "#64748b" }}>
                    {config.subheadline || "Get a free AI-powered estimate in minutes."}
                  </p>
                  <button
                    className="mt-5 px-5 py-2.5 rounded-lg text-sm font-semibold text-white"
                    style={{ background: config.primaryColor }}
                  >
                    {config.ctaButtonText || "Get My Free Estimate"}
                  </button>
                </div>

                {/* Questions preview */}
                <div className="px-6 py-5 border-t space-y-3 bg-gray-50">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Qualification Step — {activeQCount} questions
                  </p>
                  {QUESTION_FIELDS.filter(
                    (f) => config[f.key as keyof HomeValuePageConfig] === true,
                  ).map((field) => {
                    const customLabel =
                      field.labelKey !== "labelBuyAfterSell"
                        ? (config[field.labelKey as keyof HomeValuePageConfig] as string | null)
                        : null
                    return (
                      <div
                        key={field.key}
                        className="bg-white rounded-lg border border-gray-200 px-3 py-2.5"
                      >
                        <p className="text-xs font-medium text-gray-700">
                          {customLabel || field.defaultLabel}
                        </p>
                      </div>
                    )
                  })}
                  {activeQCount === 0 && (
                    <p className="text-xs text-gray-400 italic">
                      No qualification questions enabled
                    </p>
                  )}
                </div>

                {/* Hours preview */}
                {config.showScheduler && (
                  <div className="px-6 py-5 border-t bg-white">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      Appointment Scheduler
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {config.workingHours.length === 0 && (
                        <p className="text-xs text-gray-400 italic">No availability set</p>
                      )}
                      {config.workingHours.map((h) => (
                        <span
                          key={h.day}
                          className="text-xs rounded-full px-2.5 py-1 font-medium text-white"
                          style={{ background: config.primaryColor }}
                        >
                          {DAYS[h.day]}{" "}
                          {h.start_hour < 12 ? `${h.start_hour}am` : `${h.start_hour - 12 || 12}pm`}–{h.end_hour < 12 ? `${h.end_hour}am` : `${h.end_hour - 12 || 12}pm`}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      Slots shown 48+ hours from now
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
