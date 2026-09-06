"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Archive, ArrowUpCircle, Layers, Plus, Star, Trash2, UserPlus } from "lucide-react"
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
import {
  listVendorPackageEnrolmentsAction,
  enrolVendorInPackageAction,
  endVendorPackageEnrolmentAction,
  type VendorPackageEnrolmentRow,
  type EnrollableVendor,
} from "@/app/actions/vendors/vendor-plan-subscriptions"

/**
 * VENDOR PACKAGES — the brokerage's own catalogue, and who is enrolled in it.
 *
 * ══ THIS PANEL USED TO SAY THE OPPOSITE OF WHAT IS TRUE ══
 *
 * It shipped as "plans published by marketplace vendors … subscribing records
 * which plan your brokerage is on" — the brokerage PAYING a vendor monthly. The
 * owner ruling, verbatim:
 *
 *   "vendor packages are for brokerages to charge the vendor on a subscription
 *    to the platform. vendors do bill the brokerages for jobs but not a monthly
 *    subscription."
 *
 * The brokerage is the SELLER. It authors packages here and enrols its own
 * vendors in them; money flows VENDOR → BROKERAGE every period. What the
 * brokerage PAYS a vendor is per job, on the vendor's invoice
 * (vendor_invoices, billed_to='brokerage') — a different tab, a different table
 * row, and never monthly.
 *
 * NOTHING HERE TAKES MONEY. Enrolling records the arrangement and starts its
 * credit period; the collectable amount is raised through the existing
 * tenant→vendor ledger (vendor_invoices, billed_to='vendor'), the same one
 * issueVendorCharge and premium placement use. Saying so on the card is
 * load-bearing, not cosmetic.
 *
 * The form runs `validateVendorPlan` — the SAME function the server action runs
 * against the SAME live CHECK constraints — so the error names the field before
 * a round trip. The client copy is a convenience; the server copy is the gate,
 * and it runs regardless.
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

export function VendorPlanCataloguePanel() {
  const [plans, setPlans] = useState<VendorPlan[] | null>(null)
  const [enrolments, setEnrolments] = useState<VendorPackageEnrolmentRow[]>([])
  const [enrollable, setEnrollable] = useState<EnrollableVendor[]>([])
  const [direction, setDirection] = useState<string>("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<VendorPlanInput>(EMPTY)
  const [formOpen, setFormOpen] = useState(false)
  const [enrolFor, setEnrolFor] = useState<string | null>(null)
  const [enrolVendorId, setEnrolVendorId] = useState<string>("")
  const [fieldErrors, setFieldErrors] = useState<string[]>([])
  const [serverError, setServerError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function refresh() {
    const [planRes, enrolRes] = await Promise.all([
      listVendorPlansAction(),
      listVendorPackageEnrolmentsAction(),
    ])
    if (planRes.ok) setPlans(planRes.plans)
    else { setPlans([]); setServerError(planRes.error) }
    if (enrolRes.ok) {
      setEnrolments(enrolRes.enrolments)
      setEnrollable(enrolRes.enrollableVendors)
      setDirection(enrolRes.direction)
    } else {
      // A refused enrolment read must not render as "nobody is enrolled" — that
      // would offer a Delete on a package vendors are actually paying for.
      setEnrolments([]); setEnrollable([]); setServerError(enrolRes.error)
    }
  }

  useEffect(() => { void refresh() }, [])

  function openNew() {
    setEditingId(null); setDraft(EMPTY); setFieldErrors([]); setServerError(null); setFormOpen(true)
  }
  function openEdit(plan: VendorPlan) {
    setEditingId(plan.id); setDraft(toInput(plan)); setFieldErrors([]); setServerError(null); setFormOpen(true)
  }

  function save() {
    const local = validateVendorPlan(draft)
    if (local.length > 0) { setFieldErrors(local); setServerError(null); return }
    setFieldErrors([]); setServerError(null)
    startTransition(async () => {
      const res = editingId
        ? await updateVendorPlanAction({ planId: editingId, input: draft })
        : await createVendorPlanAction(draft)
      if (res.ok) { setFormOpen(false); await refresh() }
      else { setServerError(res.error); setFieldErrors(res.fieldErrors ?? []) }
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

  const enrolledByPlan = new Map<string, VendorPackageEnrolmentRow[]>()
  for (const e of enrolments) {
    if (!enrolledByPlan.has(e.plan_id)) enrolledByPlan.set(e.plan_id, [])
    enrolledByPlan.get(e.plan_id)!.push(e)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5" /> Vendor packages
        </CardTitle>
        <CardDescription>
          Recurring packages <strong>you charge your vendors</strong> for access and placement in your
          marketplace. Enrolling a vendor records the arrangement and starts its credit period — it
          does not take a card payment. Raise the amount on the vendor&apos;s bill like any other
          vendor charge. What you <em>pay</em> a vendor is per job, on their invoice — never monthly.
          {direction && (
            <span className="block mt-1 text-[11px] uppercase tracking-wide">{direction}</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {serverError && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{serverError}</div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {plans === null
              ? "Loading vendor packages…"
              : plans.length === 0
                ? "No packages yet — there is nothing to enrol a vendor in."
                : `${plans.length} package${plans.length === 1 ? "" : "s"} on your catalogue.`}
          </p>
          <Button size="sm" onClick={openNew} disabled={pending}>
            <Plus className="h-4 w-4 mr-1" /> New package
          </Button>
        </div>

        {formOpen && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{editingId ? "Edit package" : "New package"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {fieldErrors.length > 0 && (
                <ul className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 list-disc pl-6">
                  {fieldErrors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="pkg-name">Package name</Label>
                  <Input id="pkg-name" {...field("name")} placeholder="Preferred Partner" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pkg-cycle">Billing cycle</Label>
                  <select
                    id="pkg-cycle"
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
                  <Label htmlFor="pkg-price">Monthly price the vendor pays you (USD)</Label>
                  <Input id="pkg-price" inputMode="decimal" {...field("price_per_month")} placeholder="0" />
                  <p className="text-xs text-muted-foreground">0 is allowed — a pay-per-credit package with no monthly fee.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pkg-credit">Overage price per credit (USD, optional)</Label>
                  <Input id="pkg-credit" inputMode="decimal" {...field("price_per_credit")} placeholder="Leave blank if not metered" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pkg-credits">Credits included per month (optional)</Label>
                  <Input id="pkg-credits" inputMode="numeric" {...field("max_credits_per_month")} placeholder="Leave blank for unlimited" />
                  <p className="text-xs text-muted-foreground">Must be greater than 0 when set — leave blank for no cap.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="pkg-trial">Trial days</Label>
                  <Input id="pkg-trial" inputMode="numeric" {...field("trial_days")} placeholder="0" />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pkg-desc">Description</Label>
                <Textarea id="pkg-desc" rows={2} {...field("description")} placeholder="What a vendor gets for this fee" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pkg-features">Features (one per line)</Label>
                <Textarea
                  id="pkg-features"
                  rows={3}
                  value={(draft.features ?? []).join("\n")}
                  onChange={(e) => setDraft((d) => ({ ...d, features: e.target.value.split("\n") }))}
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={save} disabled={pending}>{editingId ? "Save package" : "Publish package"}</Button>
                <Button variant="outline" onClick={() => setFormOpen(false)} disabled={pending}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {(plans ?? []).map((plan) => {
            const rows = enrolledByPlan.get(plan.id) ?? []
            const activeRows = rows.filter((r) => r.status === "active")
            return (
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
                  <p className="text-xs text-muted-foreground">Charged to each enrolled vendor.</p>
                </CardHeader>
                <CardContent className="space-y-2 text-xs">
                  {plan.description && <p className="text-muted-foreground">{plan.description}</p>}
                  <div className="text-muted-foreground">
                    {plan.price_per_credit !== null ? `$${Number(plan.price_per_credit).toFixed(2)} per credit · ` : ""}
                    {plan.max_credits_per_month === null ? "Unlimited credits" : `${plan.max_credits_per_month} credits/mo`}
                    {plan.trial_days > 0 ? ` · ${plan.trial_days}-day trial` : ""}
                  </div>
                  <div className="text-muted-foreground">
                    {plan.enrolled_vendor_count ?? 0} vendor{(plan.enrolled_vendor_count ?? 0) === 1 ? "" : "s"} enrolled
                  </div>

                  {activeRows.length > 0 && (
                    <ul className="space-y-1 border-t pt-2">
                      {activeRows.map((r) => (
                        <li key={r.subscription_id} className="flex items-center justify-between gap-2">
                          <span className="truncate">
                            {r.vendor_name ?? "Unnamed vendor"}
                            <span className="text-muted-foreground">
                              {" "}· {r.credits_used_this_period} credits · renews{" "}
                              {new Date(r.current_period_end).toLocaleDateString()}
                            </span>
                          </span>
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={pending}
                            onClick={() => act(() => endVendorPackageEnrolmentAction({ subscriptionId: r.subscription_id }))}>
                            End
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {plan.status === "active" && (
                    <div className="border-t pt-2 space-y-1">
                      {enrolFor === plan.id ? (
                        <div className="flex gap-1">
                          <select
                            className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                            value={enrolVendorId}
                            onChange={(e) => setEnrolVendorId(e.target.value)}
                          >
                            <option value="">Choose a vendor…</option>
                            {enrollable.map((v) => (
                              <option key={v.vendor_id} value={v.vendor_id}>
                                {v.name}{v.category ? ` (${v.category})` : ""}
                              </option>
                            ))}
                          </select>
                          <Button size="sm" className="h-8" disabled={pending || !enrolVendorId}
                            onClick={() => {
                              const vid = enrolVendorId
                              setEnrolFor(null); setEnrolVendorId("")
                              act(() => enrolVendorInPackageAction({ vendorId: vid, planId: plan.id }))
                            }}>
                            Enrol
                          </Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={pending || enrollable.length === 0}
                          onClick={() => { setEnrolFor(plan.id); setEnrolVendorId("") }}>
                          <UserPlus className="h-3 w-3 mr-1" />
                          {enrollable.length === 0 ? "No vendors left to enrol" : "Enrol a vendor"}
                        </Button>
                      )}
                    </div>
                  )}

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
                    {(plan.enrolled_vendor_count ?? 0) === 0 && (
                      <Button size="sm" variant="outline" disabled={pending}
                        onClick={() => act(() => deleteVendorPlanAction({ planId: plan.id }))}>
                        <Trash2 className="h-3 w-3 mr-1" /> Delete
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
