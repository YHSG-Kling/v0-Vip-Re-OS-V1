"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Archive, ArrowUpCircle, Plus, Star, Trash2 } from "lucide-react"
import {
  VENDOR_PLAN_BILLING_CYCLES,
  validateVendorPlan,
  type VendorPlanBillingCycle,
} from "@/lib/vendors/vendor-validators"
import {
  createVendorPlanAction,
  updateVendorPlanAction,
  setVendorPlanStatusAction,
  setDefaultVendorPlanAction,
  deleteVendorPlanAction,
  listVendorPlansAction,
  type VendorPlan,
  type VendorPlanInput,
} from "@/app/actions/vendors/vendor-plans"

/**
 * The vendor's own plan catalogue editor.
 *
 * The form runs `validateVendorPlan` — the SAME function the server action runs against the SAME
 * live CHECK constraints — so the vendor sees the field error before a round trip. The client copy
 * is a convenience; the server copy is the gate, and it runs regardless.
 *
 * Every refusal from the server is rendered verbatim. Nothing here optimistically shows a plan as
 * saved: the list is replaced from the server's response, so what is on screen is what is in the
 * table.
 */

const EMPTY: VendorPlanInput = {
  name: "",
  description: "",
  price_per_month: "",
  price_per_credit: "",
  max_credits_per_month: "",
  billing_cycle: "monthly",
  trial_days: "",
  features: [],
}

function toInput(plan: VendorPlan): VendorPlanInput {
  return {
    name: plan.name,
    description: plan.description ?? "",
    price_per_month: plan.price_per_month ?? "",
    price_per_credit: plan.price_per_credit ?? "",
    max_credits_per_month: plan.max_credits_per_month ?? "",
    billing_cycle: plan.billing_cycle,
    trial_days: plan.trial_days ?? "",
    features: Array.isArray(plan.features_json) ? (plan.features_json as string[]) : [],
    status: plan.status,
  }
}

export function VendorPlansClient({ initialPlans }: { initialPlans: VendorPlan[] }) {
  const [plans, setPlans] = useState<VendorPlan[]>(initialPlans)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<VendorPlanInput>(EMPTY)
  const [formOpen, setFormOpen] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<string[]>([])
  const [serverError, setServerError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function refresh() {
    const res = await listVendorPlansAction()
    if (res.ok) setPlans(res.plans)
    else setServerError(res.error)
  }

  function openNew() {
    setEditingId(null); setDraft(EMPTY); setFieldErrors([]); setServerError(null); setFormOpen(true)
  }
  function openEdit(plan: VendorPlan) {
    setEditingId(plan.id); setDraft(toInput(plan)); setFieldErrors([]); setServerError(null); setFormOpen(true)
  }

  function save() {
    // Same validator the server runs — a fast local echo of the live CHECK constraints.
    const local = validateVendorPlan(draft)
    if (local.length > 0) { setFieldErrors(local); setServerError(null); return }
    setFieldErrors([]); setServerError(null)
    startTransition(async () => {
      const res = editingId
        ? await updateVendorPlanAction({ planId: editingId, input: draft })
        : await createVendorPlanAction(draft)
      if (res.ok) {
        setFormOpen(false)
        await refresh()
      } else {
        setServerError(res.error)
        setFieldErrors(res.fieldErrors ?? [])
      }
    })
  }

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setServerError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setServerError(res.error ?? "That did not work.")
      await refresh()
    })
  }

  const field = (key: keyof VendorPlanInput) => ({
    value: (draft[key] as string | number | undefined) ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft((d) => ({ ...d, [key]: e.target.value })),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {plans.length === 0
            ? "No plans published yet — brokerages have nothing to subscribe to."
            : `${plans.length} plan${plans.length === 1 ? "" : "s"} on your catalogue.`}
        </p>
        <Button size="sm" onClick={openNew} disabled={pending}>
          <Plus className="h-4 w-4 mr-1" /> New plan
        </Button>
      </div>

      {serverError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{serverError}</div>
      )}

      {formOpen && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{editingId ? "Edit plan" : "New plan"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {fieldErrors.length > 0 && (
              <ul className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 list-disc pl-6">
                {fieldErrors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="plan-name">Plan name</Label>
                <Input id="plan-name" {...field("name")} placeholder="Starter" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="plan-cycle">Billing cycle</Label>
                <select
                  id="plan-cycle"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={draft.billing_cycle}
                  onChange={(e) => setDraft((d) => ({ ...d, billing_cycle: e.target.value as VendorPlanBillingCycle }))}
                >
                  {VENDOR_PLAN_BILLING_CYCLES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="plan-price">Monthly price (USD)</Label>
                <Input id="plan-price" inputMode="decimal" {...field("price_per_month")} placeholder="0" />
                <p className="text-xs text-muted-foreground">0 is allowed — a pay-per-credit plan with no monthly fee.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="plan-credit">Price per credit (USD, optional)</Label>
                <Input id="plan-credit" inputMode="decimal" {...field("price_per_credit")} placeholder="Leave blank if not metered" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="plan-credits">Max credits per month (optional)</Label>
                <Input id="plan-credits" inputMode="numeric" {...field("max_credits_per_month")} placeholder="Leave blank for unlimited" />
                <p className="text-xs text-muted-foreground">Must be greater than 0 when set — leave blank for no cap.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="plan-trial">Trial days</Label>
                <Input id="plan-trial" inputMode="numeric" {...field("trial_days")} placeholder="0" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="plan-desc">Description</Label>
              <Textarea id="plan-desc" rows={2} {...field("description")} placeholder="What a brokerage gets on this plan" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="plan-features">Features (one per line)</Label>
              <Textarea
                id="plan-features"
                rows={3}
                value={(draft.features ?? []).join("\n")}
                onChange={(e) => setDraft((d) => ({ ...d, features: e.target.value.split("\n") }))}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={save} disabled={pending}>{editingId ? "Save plan" : "Publish plan"}</Button>
              <Button variant="outline" onClick={() => setFormOpen(false)} disabled={pending}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => (
          <Card key={plan.id} className={plan.status === "archived" ? "opacity-60" : plan.is_default ? "border-primary" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center justify-between gap-2">
                <span className="truncate">{plan.name}</span>
                <span className="flex gap-1 shrink-0">
                  {plan.is_default && <Badge variant="secondary" className="text-[10px]">Default</Badge>}
                  {plan.status === "archived" && <Badge variant="outline" className="text-[10px]">Archived</Badge>}
                </span>
              </CardTitle>
              <div className="text-2xl font-bold">
                ${Number(plan.price_per_month).toFixed(2)}
                <span className="text-sm font-normal text-muted-foreground">
                  /{plan.billing_cycle === "annual" ? "yr" : "mo"}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {plan.description && <p className="text-muted-foreground">{plan.description}</p>}
              <div className="text-muted-foreground">
                {plan.price_per_credit !== null ? `$${Number(plan.price_per_credit).toFixed(2)} per credit · ` : ""}
                {plan.max_credits_per_month === null ? "Unlimited credits" : `${plan.max_credits_per_month} credits/mo`}
                {plan.trial_days > 0 ? ` · ${plan.trial_days}-day trial` : ""}
              </div>
              <div className="text-muted-foreground">
                {plan.subscriber_count ?? 0} brokerage subscription{(plan.subscriber_count ?? 0) === 1 ? "" : "s"}
              </div>
              <div className="flex flex-wrap gap-1 pt-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => openEdit(plan)}>Edit</Button>
                {plan.status === "active" ? (
                  <>
                    {!plan.is_default && (
                      <Button size="sm" variant="outline" disabled={pending}
                        onClick={() => act(() => setDefaultVendorPlanAction({ planId: plan.id }))}>
                        <Star className="h-3 w-3 mr-1" /> Default
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={pending}
                      onClick={() => act(() => setVendorPlanStatusAction({ planId: plan.id, status: "archived" }))}>
                      <Archive className="h-3 w-3 mr-1" /> Archive
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" disabled={pending}
                    onClick={() => act(() => setVendorPlanStatusAction({ planId: plan.id, status: "active" }))}>
                    <ArrowUpCircle className="h-3 w-3 mr-1" /> Restore
                  </Button>
                )}
                {(plan.subscriber_count ?? 0) === 0 && (
                  <Button size="sm" variant="outline" disabled={pending}
                    onClick={() => act(() => deleteVendorPlanAction({ planId: plan.id }))}>
                    <Trash2 className="h-3 w-3 mr-1" /> Delete
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
