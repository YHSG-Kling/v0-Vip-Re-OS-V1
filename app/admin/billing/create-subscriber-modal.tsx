"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { createSubscriber } from "@/app/actions/admin/create-subscriber"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Plus,
  User,
  Users,
  Building2,
  Globe,
  Check,
  ChevronRight,
  ChevronLeft,
  Copy,
  CheckCircle2,
} from "lucide-react"

interface Tier {
  id: string
  tier_name: string
  display_name: string
  monthly_price_cents: number
  annual_price_cents?: number
  description?: string
}

interface CreateSubscriberModalProps {
  tiers: Tier[]
  onCreated: (result: { brokerageId: string; userId: string }) => void
}

const TIER_META: Record<
  string,
  {
    icon: React.ReactNode
    features: string[]
    badge?: string
    badgeColor?: string
  }
> = {
  solo_agent: {
    icon: <User className="h-5 w-5" />,
    features: ["AI ISA", "Smart CRM", "Voice Assistant", "Social AI"],
  },
  team: {
    icon: <Users className="h-5 w-5" />,
    features: ["Everything in Solo", "Team coaching", "Team analytics", "Multi-agent"],
  },
  brokerage: {
    icon: <Building2 className="h-5 w-5" />,
    features: ["Everything in Team", "Compliance OS", "TC OS", "Broker command center"],
  },
  multi_location: {
    icon: <Globe className="h-5 w-5" />,
    features: [
      "Everything in Brokerage",
      "Multi-location",
      "Advanced reporting",
      "Priority support",
    ],
    badge: "Enterprise",
    badgeColor: "bg-purple-100 text-purple-700",
  },
}

const STEPS = ["Select Tier", "Account Info", "Review"]

type FormState = {
  tierId: string
  tierName: string
  billingCycle: "monthly" | "annual"
  brokerageName: string
  brokerageEmail: string
  brokerageCity: string
  brokerageState: string
  brokeragePhone: string
  adminFirstName: string
  adminLastName: string
  adminEmail: string
  stripeCustomerId: string
  notes: string
}

const EMPTY_FORM: FormState = {
  tierId: "",
  tierName: "",
  billingCycle: "monthly",
  brokerageName: "",
  brokerageEmail: "",
  brokerageCity: "",
  brokerageState: "",
  brokeragePhone: "",
  adminFirstName: "",
  adminLastName: "",
  adminEmail: "",
  stripeCustomerId: "",
  notes: "",
}

export function CreateSubscriberModal({ tiers, onCreated }: CreateSubscriberModalProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    brokerageId: string
    userId: string
    subscriptionId: string
  } | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [copied, setCopied] = useState(false)

  function updateForm(field: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  function handleOpen() {
    setOpen(true)
    setStep(1)
    setForm(EMPTY_FORM)
    setError(null)
    setResult(null)
  }

  function handleClose() {
    setOpen(false)
  }

  function handleReset() {
    setStep(1)
    setForm(EMPTY_FORM)
    setError(null)
    setResult(null)
  }

  function selectTier(tier: Tier) {
    updateForm("tierId", tier.id)
    updateForm("tierName", tier.tier_name)
  }

  const selectedTier = tiers.find((t) => t.id === form.tierId)

  function tierPrice(tier: Tier) {
    if (form.billingCycle === "annual" && tier.annual_price_cents) {
      return `$${Math.round(tier.annual_price_cents / 100 / 12)}/mo (billed annually)`
    }
    return `$${tier.monthly_price_cents / 100}/mo`
  }

  async function handleSubmit() {
    setError(null)
    setSubmitting(true)
    const res = await createSubscriber({
      brokerageName: form.brokerageName,
      brokerageEmail: form.brokerageEmail,
      brokerageCity: form.brokerageCity || undefined,
      brokerageState: form.brokerageState || undefined,
      brokeragePhone: form.brokeragePhone || undefined,
      adminFirstName: form.adminFirstName,
      adminLastName: form.adminLastName,
      adminEmail: form.adminEmail,
      tierId: form.tierId,
      tierName: form.tierName as any,
      billingCycle: form.billingCycle,
      stripeCustomerId: form.stripeCustomerId || undefined,
      notes: form.notes || undefined,
    })
    setSubmitting(false)
    if (res.success && res.brokerageId && res.userId && res.subscriptionId) {
      setResult({
        brokerageId: res.brokerageId,
        userId: res.userId,
        subscriptionId: res.subscriptionId,
      })
      onCreated({ brokerageId: res.brokerageId, userId: res.userId })
    } else {
      setError(res.error || "Creation failed. Please try again.")
    }
  }

  function copyBrokerageId() {
    if (result?.brokerageId) {
      navigator.clipboard.writeText(result.brokerageId)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <>
      <Button onClick={handleOpen} className="bg-green-600 hover:bg-green-700 text-white">
        <Plus className="h-4 w-4 mr-2" />
        Create Subscriber
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {/* Step progress */}
          {!result && (
            <div className="flex items-center gap-2 mb-2">
              {STEPS.map((label, i) => {
                const n = i + 1
                const isActive = step === n
                const isDone = step > n
                return (
                  <div key={label} className="flex items-center gap-2">
                    <div
                      className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border transition-colors ${
                        isDone
                          ? "bg-blue-600 border-blue-600 text-white"
                          : isActive
                          ? "bg-blue-600 border-blue-600 text-white"
                          : "border-gray-300 text-gray-400"
                      }`}
                    >
                      {isDone ? <Check className="h-3 w-3" /> : n}
                    </div>
                    <span
                      className={`text-sm ${
                        isActive ? "text-foreground font-medium" : "text-muted-foreground"
                      }`}
                    >
                      {label}
                    </span>
                    {i < STEPS.length - 1 && (
                      <ChevronRight className="h-4 w-4 text-muted-foreground mx-1" />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── STEP 1: TIER SELECTION ── */}
          {step === 1 && (
            <>
              <DialogHeader>
                <DialogTitle>Select Subscription Tier</DialogTitle>
                <DialogDescription>
                  Choose the tier this customer purchased
                </DialogDescription>
              </DialogHeader>

              <div className="grid grid-cols-2 gap-3 mt-4">
                {tiers.map((tier) => {
                  const meta = TIER_META[tier.tier_name] ?? {
                    icon: <Building2 className="h-5 w-5" />,
                    features: [],
                  }
                  const isSelected = form.tierId === tier.id
                  return (
                    <button
                      key={tier.id}
                      type="button"
                      onClick={() => selectTier(tier)}
                      className={`text-left rounded-lg border-2 p-4 transition-all ${
                        isSelected
                          ? "border-blue-600 bg-blue-50"
                          : "border-border hover:border-blue-300"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div
                          className={`p-1.5 rounded ${
                            isSelected ? "text-blue-600" : "text-muted-foreground"
                          }`}
                        >
                          {meta.icon}
                        </div>
                        <div className="flex items-center gap-1">
                          {meta.badge && (
                            <Badge className={`text-xs ${meta.badgeColor}`}>{meta.badge}</Badge>
                          )}
                          {isSelected && <Check className="h-4 w-4 text-blue-600" />}
                        </div>
                      </div>
                      <p className="font-semibold text-sm">{tier.display_name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{tierPrice(tier)}</p>
                      <ul className="mt-2 space-y-1">
                        {meta.features.map((f) => (
                          <li key={f} className="text-xs text-muted-foreground flex items-center gap-1">
                            <Check className="h-3 w-3 text-green-500 shrink-0" />
                            {f}
                          </li>
                        ))}
                      </ul>
                    </button>
                  )
                })}
              </div>

              {/* Billing cycle toggle */}
              <div className="mt-4 flex items-center gap-3">
                <span className="text-sm font-medium">Billing cycle:</span>
                <div className="flex rounded-lg border overflow-hidden">
                  {(["monthly", "annual"] as const).map((cycle) => (
                    <button
                      key={cycle}
                      type="button"
                      onClick={() => updateForm("billingCycle", cycle)}
                      className={`px-4 py-1.5 text-sm transition-colors ${
                        form.billingCycle === cycle
                          ? "bg-blue-600 text-white"
                          : "bg-background text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {cycle === "monthly" ? "Monthly" : "Annual"}
                      {cycle === "annual" && (
                        <span className="ml-1 text-xs opacity-80">save ~17%</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end mt-4">
                <Button
                  onClick={() => setStep(2)}
                  disabled={!form.tierId}
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </>
          )}

          {/* ── STEP 2: ACCOUNT INFO ── */}
          {step === 2 && (
            <>
              <DialogHeader>
                <DialogTitle>Account Information</DialogTitle>
                <DialogDescription>
                  The admin user will receive an invite email to set their password
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-6 mt-4">
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">Brokerage Details</h3>
                  <div className="space-y-2">
                    <div>
                      <Label htmlFor="brokerageName">Brokerage Name *</Label>
                      <Input
                        id="brokerageName"
                        value={form.brokerageName}
                        onChange={(e) => updateForm("brokerageName", e.target.value)}
                        placeholder="Acme Realty Group"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="brokerageEmail">Brokerage Email *</Label>
                      <Input
                        id="brokerageEmail"
                        type="email"
                        value={form.brokerageEmail}
                        onChange={(e) => updateForm("brokerageEmail", e.target.value)}
                        placeholder="hello@acmerealty.com"
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="brokeragePhone">Phone</Label>
                      <Input
                        id="brokeragePhone"
                        value={form.brokeragePhone}
                        onChange={(e) => updateForm("brokeragePhone", e.target.value)}
                        placeholder="(555) 000-0000"
                        className="mt-1"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label htmlFor="brokerageCity">City</Label>
                        <Input
                          id="brokerageCity"
                          value={form.brokerageCity}
                          onChange={(e) => updateForm("brokerageCity", e.target.value)}
                          placeholder="Austin"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label htmlFor="brokerageState">State</Label>
                        <Input
                          id="brokerageState"
                          value={form.brokerageState}
                          onChange={(e) => updateForm("brokerageState", e.target.value)}
                          placeholder="TX"
                          maxLength={2}
                          className="mt-1"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">Admin User</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label htmlFor="adminFirstName">First Name *</Label>
                      <Input
                        id="adminFirstName"
                        value={form.adminFirstName}
                        onChange={(e) => updateForm("adminFirstName", e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="adminLastName">Last Name *</Label>
                      <Input
                        id="adminLastName"
                        value={form.adminLastName}
                        onChange={(e) => updateForm("adminLastName", e.target.value)}
                        className="mt-1"
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="adminEmail">Admin Email *</Label>
                    <Input
                      id="adminEmail"
                      type="email"
                      value={form.adminEmail}
                      onChange={(e) => updateForm("adminEmail", e.target.value)}
                      placeholder="admin@acmerealty.com"
                      className="mt-1"
                    />
                  </div>
                  {form.adminEmail && (
                    <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-800">
                      An invite email will be sent to <strong>{form.adminEmail}</strong> with a
                      link to set their password and complete onboarding.
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">Optional</h3>
                  <div>
                    <Label htmlFor="stripeCustomerId">Stripe Customer ID</Label>
                    <Input
                      id="stripeCustomerId"
                      value={form.stripeCustomerId}
                      onChange={(e) => updateForm("stripeCustomerId", e.target.value)}
                      placeholder="cus_..."
                      className="mt-1"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Paste here if you already created the customer in the Stripe dashboard.
                      Leave blank to create automatically.
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea
                      id="notes"
                      value={form.notes}
                      onChange={(e) => updateForm("notes", e.target.value)}
                      placeholder="Sales notes, special arrangements..."
                      rows={3}
                      className="mt-1"
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-between mt-4">
                <Button variant="outline" onClick={() => setStep(1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
                <Button
                  onClick={() => setStep(3)}
                  disabled={
                    !form.brokerageName ||
                    !form.brokerageEmail ||
                    !form.adminFirstName ||
                    !form.adminLastName ||
                    !form.adminEmail
                  }
                >
                  Review
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </>
          )}

          {/* ── STEP 3: REVIEW ── */}
          {step === 3 && !result && (
            <>
              <DialogHeader>
                <DialogTitle>Review New Subscriber</DialogTitle>
                <DialogDescription>Confirm all details before provisioning</DialogDescription>
              </DialogHeader>

              <Card className="mt-4">
                <CardContent className="p-4 space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <div>
                      <p className="text-xs text-muted-foreground">Tier</p>
                      <p className="font-medium">
                        {selectedTier?.display_name} —{" "}
                        <span className="capitalize">{form.billingCycle}</span>
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Price</p>
                      <p className="font-medium">{selectedTier ? tierPrice(selectedTier) : "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Brokerage</p>
                      <p className="font-medium">{form.brokerageName}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Location</p>
                      <p className="font-medium">
                        {[form.brokerageCity, form.brokerageState].filter(Boolean).join(", ") ||
                          "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Admin</p>
                      <p className="font-medium">
                        {form.adminFirstName} {form.adminLastName}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Invite Email</p>
                      <p className="font-medium">{form.adminEmail}</p>
                    </div>
                  </div>

                  <div className="border-t pt-3 space-y-1.5">
                    <p className="text-xs font-semibold text-foreground">
                      What happens when you confirm:
                    </p>
                    {[
                      "Brokerage account created",
                      "Admin user created (status: pending)",
                      `Subscription activated on ${selectedTier?.display_name ?? form.tierName}`,
                      form.stripeCustomerId
                        ? "Stripe customer linked (existing ID)"
                        : "Stripe customer created automatically",
                      `Invite email sent to ${form.adminEmail}`,
                      "Audit log entry created",
                    ].map((item) => (
                      <div key={item} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        {item}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {error && (
                <div className="mt-3 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div className="flex justify-between mt-4">
                <Button variant="outline" onClick={() => setStep(2)} disabled={submitting}>
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Edit
                </Button>
                <Button
                  className="bg-green-600 hover:bg-green-700 text-white"
                  onClick={handleSubmit}
                  disabled={submitting}
                >
                  {submitting ? "Creating..." : "Create Subscriber"}
                </Button>
              </div>
            </>
          )}

          {/* ── SUCCESS STATE ── */}
          {result && (
            <div className="space-y-6 py-4">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="h-8 w-8 text-green-600" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-foreground">Subscriber Created</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Account provisioned and invite sent
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Brokerage ID</p>
                    <p className="text-sm font-mono">{result.brokerageId}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={copyBrokerageId}>
                    {copied ? (
                      <Check className="h-4 w-4 text-green-600" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Admin Email</p>
                    <p className="text-sm">{form.adminEmail}</p>
                  </div>
                  <Badge className="bg-green-100 text-green-700 text-xs">Invite sent</Badge>
                </div>
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Subscription</p>
                    <p className="text-sm">{selectedTier?.display_name}</p>
                  </div>
                  <Badge className="bg-green-100 text-green-700 text-xs">Active</Badge>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    handleClose()
                    router.refresh()
                  }}
                >
                  View in Billing
                </Button>
                <Button className="flex-1" onClick={handleReset}>
                  Create Another
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
