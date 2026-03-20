"use client"

import { useState, useTransition } from "react"
import { cn } from "@/lib/utils"
import {
  createOffer, sendOfferForESign,
  type OfferFormData, type StrategyRecommendation,
} from "@/app/actions/buyer-offers"
import { runCompleteOfferWorkflow } from "@/app/actions/ai-offer-creation"
import { Loader2, Sparkles, Check } from "lucide-react"

interface OfferFormWizardProps {
  contactId:    string
  brokerageId:  string
  agentUserId:  string
  contactName:  string
  contactEmail: string
  recommendation:  StrategyRecommendation | null
  formSource:      string
  formProviderRef?: string
  esignProvider?:  string
  propertyAddress: string
  propertyCity?:   string
  propertyState?:  string
  propertyZip?:    string
  listingId?:      string | null
  propertyAddressAiFilled?: boolean
  // Offer OS additions
  contingencies?:       string[]
  buyerMaxBudget?:      number
  buyerRiskTolerance?:  "conservative" | "moderate" | "aggressive"
  onBack:          () => void
  onSuccess:       () => void
}

const STEPS = [
  "Price",
  "Earnest Money",
  "Contingencies",
  "Dates",
  "Closing Terms",
  "Possession",
  "Special Conditions",
  "Seller Concessions",
  "Review",
] as const

type Step = typeof STEPS[number]

function defaultForm(
  rec: StrategyRecommendation | null,
  propertyAddress: string
): OfferFormData {
  const c = rec?.recommended_contingencies
  return {
    property_address:            propertyAddress,
    offer_price:                 rec?.recommended_price ?? 0,
    earnest_money:               rec?.recommended_earnest ?? 0,
    earnest_money_amount:        rec?.recommended_earnest ?? 0,
    financing_type:              "conventional",
    financing_contingency:       c?.financing ?? true,
    financing_contingency_days:  c?.financing_days ?? 21,
    inspection_contingency:      c?.inspection ?? true,
    inspection_period_days:      c?.inspection_days ?? 10,
    appraisal_contingency:       c?.appraisal ?? true,
    appraisal_contingency_days:  c?.appraisal_days ?? 21,
    closing_date:                "",
    possession_terms:            "day of closing",
    escalation_clause:           false,
    form_source:                 "in_app",
    strategy_recommendation_id:  rec?.id ?? null,
  }
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {children}
    </div>
  )
}

function Input({ value, onChange, type = "text", placeholder, className }: {
  value: string | number
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  className?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(
        "w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
        className
      )}
    />
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors",
          checked ? "bg-primary" : "bg-muted"
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </button>
      <span className="text-sm">{label}</span>
    </label>
  )
}

export function OfferFormWizard({
  contactId, brokerageId, agentUserId, contactName, contactEmail,
  recommendation, formSource, formProviderRef, esignProvider,
  propertyAddress, propertyCity, propertyState, propertyZip,
  listingId, propertyAddressAiFilled, onBack, onSuccess,
}: OfferFormWizardProps) {
  const [step, setStep]           = useState<Step>("Price")
  const [form, setForm]           = useState<OfferFormData>(() => ({
    ...defaultForm(recommendation, propertyAddress),
    property_city:              propertyCity,
    property_state:             propertyState,
    property_zip:               propertyZip,
    listing_id:                 listingId ?? null,
    property_address_ai_filled: propertyAddressAiFilled ?? false,
    form_source:                formSource,
    form_provider_ref:          formProviderRef,
    esign_provider:             esignProvider,
  }))
  const [createdOfferId, setCreatedOfferId] = useState<string | null>(null)
  const [submitError, setSubmitError]       = useState<string | null>(null)
  const [isPending, startTrans]             = useTransition()

  const stepIndex = STEPS.indexOf(step)
  const progress  = ((stepIndex + 1) / STEPS.length) * 100

  function set<K extends keyof OfferFormData>(key: K, value: OfferFormData[K]) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function next() {
    const idx = STEPS.indexOf(step)
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1])
  }

  function prev() {
    const idx = STEPS.indexOf(step)
    if (idx === 0) { onBack(); return }
    setStep(STEPS[idx - 1])
  }

  function submitOffer() {
    setSubmitError(null)
    startTrans(async () => {
      const result = await createOffer(contactId, brokerageId, agentUserId, form)
      if (result.success && result.offerId) {
        setCreatedOfferId(result.offerId)
        setStep("Review") // stay on review but show eSign panel
      } else {
        setSubmitError(result.error ?? "Failed to create offer")
      }
    })
  }

  function sendESign() {
    if (!createdOfferId) return
    startTrans(async () => {
      await sendOfferForESign(createdOfferId, contactId, brokerageId, agentUserId)
      onSuccess()
    })
  }

  // ── STEP RENDERERS ─────────────────────────────────────────────────────────

  function renderStep() {
    switch (step) {
      case "Price":
        return (
          <div className="space-y-4">
            <Field label="Offer Price" required>
              <Input type="number" value={form.offer_price || ""} onChange={v => set("offer_price", Number(v))} placeholder="0" />
            </Field>
            <Field label="Financing Type" required>
              <select
                value={form.financing_type}
                onChange={e => set("financing_type", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {["conventional","FHA","VA","USDA","cash","other"].map(t => (
                  <option key={t} value={t}>{t.toUpperCase()}</option>
                ))}
              </select>
            </Field>
            <Field label="Down Payment Amount">
              <Input type="number" value={form.down_payment_amount ?? ""} onChange={v => set("down_payment_amount", Number(v))} placeholder="0" />
            </Field>
            <Field label="Down Payment %">
              <Input type="number" value={form.down_payment_percent ?? ""} onChange={v => set("down_payment_percent", Number(v))} placeholder="20" />
            </Field>
          </div>
        )

      case "Earnest Money":
        return (
          <div className="space-y-4">
            <Field label="Earnest Money Amount" required>
              <Input type="number" value={form.earnest_money_amount || ""} onChange={v => {
                const n = Number(v)
                set("earnest_money", n)
                set("earnest_money_amount", n)
              }} placeholder="0" />
            </Field>
            <div className="rounded-md bg-muted/40 border border-border p-3 text-xs text-muted-foreground">
              Recommended: ${recommendation?.recommended_earnest.toLocaleString() ?? "—"}
            </div>
          </div>
        )

      case "Contingencies":
        return (
          <div className="space-y-5">
            <div className="space-y-3">
              <Toggle
                checked={form.financing_contingency}
                onChange={v => set("financing_contingency", v)}
                label="Financing Contingency"
              />
              {form.financing_contingency && (
                <Field label="Financing Contingency Days">
                  <Input type="number" value={form.financing_contingency_days} onChange={v => set("financing_contingency_days", Number(v))} />
                </Field>
              )}
            </div>
            <div className="space-y-3">
              <Toggle
                checked={form.inspection_contingency}
                onChange={v => set("inspection_contingency", v)}
                label="Inspection Contingency"
              />
              {form.inspection_contingency && (
                <Field label="Inspection Period Days">
                  <Input type="number" value={form.inspection_period_days} onChange={v => set("inspection_period_days", Number(v))} />
                </Field>
              )}
            </div>
            <div className="space-y-3">
              <Toggle
                checked={form.appraisal_contingency}
                onChange={v => set("appraisal_contingency", v)}
                label="Appraisal Contingency"
              />
              {form.appraisal_contingency && (
                <Field label="Appraisal Contingency Days">
                  <Input type="number" value={form.appraisal_contingency_days} onChange={v => set("appraisal_contingency_days", Number(v))} />
                </Field>
              )}
            </div>
          </div>
        )

      case "Dates":
        return (
          <div className="space-y-4">
            <Field label="Closing Date">
              <Input type="date" value={form.closing_date} onChange={v => set("closing_date", v)} />
            </Field>
          </div>
        )

      case "Closing Terms":
        return (
          <div className="space-y-4">
            <Field label="Closing Cost Contribution from Seller ($)">
              <Input type="number" value={form.closing_cost_contribution ?? ""} onChange={v => set("closing_cost_contribution", Number(v))} placeholder="0" />
            </Field>
            <div className="space-y-3">
              <Toggle
                checked={form.escalation_clause}
                onChange={v => set("escalation_clause", v)}
                label="Escalation Clause"
              />
              {form.escalation_clause && (
                <Field label="Escalation Cap ($)">
                  <Input type="number" value={form.escalation_cap ?? ""} onChange={v => set("escalation_cap", Number(v))} placeholder="0" />
                </Field>
              )}
            </div>
          </div>
        )

      case "Possession":
        return (
          <div className="space-y-4">
            <Field label="Possession Terms" required>
              <select
                value={form.possession_terms}
                onChange={e => set("possession_terms", e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {["day of closing","3 days after closing","7 days after closing","30 days after closing","seller leaseback","other"].map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </Field>
          </div>
        )

      case "Special Conditions":
        return (
          <div className="space-y-4">
            <Field label="Special Conditions">
              <textarea
                value={form.special_conditions ?? ""}
                onChange={e => set("special_conditions", e.target.value)}
                rows={5}
                placeholder="Any special conditions or terms..."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              />
            </Field>
            <Field label="Buyer Notes (internal)">
              <textarea
                value={form.buyer_notes ?? ""}
                onChange={e => set("buyer_notes", e.target.value)}
                rows={3}
                placeholder="Internal notes for this offer..."
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              />
            </Field>
          </div>
        )

      case "Seller Concessions":
        return (
          <div className="space-y-4">
            <Field label="Seller Concessions ($)">
              <Input type="number" value={form.seller_concessions ?? ""} onChange={v => set("seller_concessions" as any, Number(v))} placeholder="0" />
            </Field>
          </div>
        )

      case "Review":
        if (createdOfferId) {
          // eSign panel
          return (
            <div className="space-y-5">
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3 text-sm">
                <p className="font-semibold">Offer Created</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div><p className="text-xs text-muted-foreground">Property</p><p className="font-medium">{form.property_address}</p></div>
                  <div><p className="text-xs text-muted-foreground">Price</p><p className="font-medium">${form.offer_price.toLocaleString()}</p></div>
                  <div><p className="text-xs text-muted-foreground">Earnest</p><p className="font-medium">${form.earnest_money_amount.toLocaleString()}</p></div>
                  <div><p className="text-xs text-muted-foreground">Closing</p><p className="font-medium">{form.closing_date || "TBD"}</p></div>
                </div>
              </div>
              <div className="rounded-lg border border-border p-4 space-y-3">
                <div className="flex items-center gap-2">
                  {esignProvider ? (
                    <>
                      <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 capitalize">
                        {esignProvider}
                      </span>
                      <span className="text-xs text-muted-foreground">configured</span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">In-app form — no eSign provider</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Send to: <span className="text-foreground font-medium">{contactName}</span>
                  {contactEmail && <span className="text-muted-foreground"> — {contactEmail}</span>}
                </p>
                <button
                  onClick={sendESign}
                  disabled={isPending}
                  className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {isPending ? "Sending..." : "Send for Signature"}
                </button>
              </div>
            </div>
          )
        }

        // Review before submit
        return (
          <div className="space-y-4 text-sm">
            {submitError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {submitError}
              </div>
            )}
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <div><p className="text-xs text-muted-foreground">Property</p><p className="font-medium">{form.property_address}</p></div>
                <div><p className="text-xs text-muted-foreground">Offer Price</p><p className="font-medium">${form.offer_price.toLocaleString()}</p></div>
                <div><p className="text-xs text-muted-foreground">Earnest Money</p><p className="font-medium">${form.earnest_money_amount.toLocaleString()}</p></div>
                <div><p className="text-xs text-muted-foreground">Financing</p><p className="font-medium uppercase">{form.financing_type}</p></div>
                <div><p className="text-xs text-muted-foreground">Financing Contingency</p><p className="font-medium">{form.financing_contingency ? `${form.financing_contingency_days}d` : "Waived"}</p></div>
                <div><p className="text-xs text-muted-foreground">Inspection</p><p className="font-medium">{form.inspection_contingency ? `${form.inspection_period_days}d` : "Waived"}</p></div>
                <div><p className="text-xs text-muted-foreground">Appraisal</p><p className="font-medium">{form.appraisal_contingency ? `${form.appraisal_contingency_days}d` : "Waived"}</p></div>
                <div><p className="text-xs text-muted-foreground">Closing Date</p><p className="font-medium">{form.closing_date || "TBD"}</p></div>
                <div><p className="text-xs text-muted-foreground">Possession</p><p className="font-medium">{form.possession_terms}</p></div>
                <div><p className="text-xs text-muted-foreground">Form Source</p><p className="font-medium capitalize">{form.form_source}</p></div>
                {form.escalation_clause && (
                  <div><p className="text-xs text-muted-foreground">Escalation Cap</p><p className="font-medium">${form.escalation_cap?.toLocaleString() ?? "—"}</p></div>
                )}
              </div>
            </div>
            {form.buyer_notes && (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">Notes: </span>{form.buyer_notes}
              </div>
            )}
          </div>
        )
    }
  }

  const isReview     = step === "Review"
  const isESignPanel = isReview && !!createdOfferId

  return (
    <div className="flex flex-col h-full">
      {/* Progress */}
      <div className="px-5 pt-4 pb-2">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-muted-foreground">
            Step {stepIndex + 1} of {STEPS.length} — {step}
          </p>
          <button onClick={onBack} className="text-xs text-muted-foreground hover:underline">
            Back to Strategy
          </button>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex gap-0.5 mt-1.5 overflow-x-auto">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={cn(
                "flex-shrink-0 h-1 flex-1 rounded-full transition-colors",
                i < stepIndex ? "bg-primary" : i === stepIndex ? "bg-primary/60" : "bg-muted"
              )}
            />
          ))}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {renderStep()}
      </div>

      {/* Footer nav */}
      {!isESignPanel && (
        <div className="border-t border-border px-5 py-4 flex items-center gap-3">
          <button
            onClick={prev}
            disabled={isPending}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted/50 disabled:opacity-50 transition-colors"
          >
            {stepIndex === 0 ? "Back to Strategy" : "Back"}
          </button>
          {isReview ? (
            <button
              onClick={submitOffer}
              disabled={isPending}
              className="ml-auto rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {isPending ? "Creating..." : "Create Offer"}
            </button>
          ) : (
            <button
              onClick={next}
              disabled={isPending}
              className="ml-auto rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              Next
            </button>
          )}
        </div>
      )}
    </div>
  )
}
