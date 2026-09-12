"use client"

import { useState, useEffect } from "react"
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { DollarSign, TrendingUp, Clock, Plus, Handshake } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"
import {
  advanceCreditFlow,
  getCreditPipelineStats,
  createCreditAccount,
  referToCreditPartner,
  updateContactCreditStatus,
} from "@/app/actions/credit-copilot"
import { listPartnersWithReferrals } from "@/app/actions/referrals/referral-actions"
import { getContacts } from "@/app/actions/contacts"

// contacts.credit_status / credit_score_band / credit_pipeline_stage are free text
// in the live schema (verified: no CHECK on any of the three). Only lender_status is
// constrained — contacts_lender_status_check admits exactly cash | pre_approved |
// needs_pre_approval | unknown, or NULL. The closed sets below keep the column values
// consistent with what the credit flow automation itself writes (`credit_status: "good"`,
// `credit_pipeline_stage: "in_program" | "target_score_reached"` in
// app/actions/credit-copilot.ts) instead of letting free text fork the vocabulary.
const CREDIT_STATUS_OPTIONS = ["needs_work", "in_program", "good"] as const
const CREDIT_PIPELINE_STAGE_OPTIONS = ["lead", "in_program", "target_score_reached"] as const
const CREDIT_SCORE_BANDS = ["below_580", "580_619", "620_659", "660_699", "700_739", "740_plus"] as const
/** Mirrors contacts_lender_status_check exactly. */
const LENDER_STATUS_OPTIONS = ["cash", "pre_approved", "needs_pre_approval", "unknown"] as const

function humanize(v: string | null | undefined) {
  if (!v) return "—"
  return v.replace(/_/g, " ")
}

const FLOW_STAGES = [
  { id: "flow_a", name: "Lead", color: "bg-gray-500" },
  { id: "flow_b", name: "Application", color: "bg-blue-500" },
  { id: "flow_c", name: "Submitted", color: "bg-yellow-500" },
  { id: "flow_d", name: "Approved", color: "bg-green-500" },
  { id: "flow_e", name: "Funded", color: "bg-purple-500" },
]

interface CreditAccount {
  id: string
  contact_id: string
  partner_name: string
  account_status: string
  credit_amount: number
  current_stage: string
  stage_history: any[]
  contact?: {
    first_name: string
    last_name: string
  }
}

interface PipelineStats {
  success: boolean
  error?: string
  total_value: number
  total_accounts: number
  avg_time_to_close: number
  by_stage: Record<string, number>
  accounts: CreditAccount[]
  /** null = no budget row for this agent this month, which is not the same as $0. */
  budget: { used: number; limit: number } | null
  /**
   * credit_partner_referrals for this tenant. getCreditPipelineStats has returned
   * this since the reader was added, but nothing rendered it — so every referral
   * written by referToCreditPartner was invisible. An empty list here is a claim
   * that we never handed this consumer to a partner, so it is rendered explicitly.
   */
  referrals: Array<{
    id: string
    contact_id: string | null
    partner_name: string | null
    status: string | null
    referred_at: string | null
  }>
}

interface PartnerOption {
  id: string
  partner_name: string | null
  partner_type: string | null
  company_name: string | null
}

interface PickerContact {
  id: string
  first_name: string | null
  last_name: string | null
}

/**
 * The credit FILE — what GET /api/credit/status returns for one contact
 * (app/api/credit/status/route.ts). `creditStatus` is the credit_status TABLE row
 * (credit_score / debt_to_income / last_updated / notes, live columns per
 * scripts/schema-snapshot.ts), distinct from the free-text contacts.credit_status
 * column this dialog WRITES through updateContactCreditStatus. `creditLog` is the
 * contact's activities filtered to activity_type "credit-related". Until this
 * page fetched it, nothing in the tree read either.
 */
interface CreditFile {
  creditStatus: {
    credit_score: number | null
    debt_to_income: number | null
    last_updated: string | null
    notes: string | null
  } | null
  creditLog: Array<{
    id: string
    title: string | null
    description: string | null
    notes: string | null
    created_at: string | null
  }>
}

export default function CreditPipelinePage() {
  const [accounts, setAccounts] = useState<CreditAccount[]>([])
  const [stats, setStats] = useState<PipelineStats | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [manageAccount, setManageAccount] = useState<CreditAccount | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  )

  useEffect(() => {
    loadPipeline()
  }, [])

  async function loadPipeline() {
    try {
      // The agent is resolved SERVER-side (agents.id ≠ users.id) — the client
      // never supplies the scoping id.
      const pipelineStats = await getCreditPipelineStats()
      if (!pipelineStats.success) {
        toast.error(pipelineStats.error || "Could not load the credit pipeline")
        return
      }
      setStats(pipelineStats)
      setAccounts(pipelineStats.accounts || [])
    } catch (error: any) {
      toast.error(error?.message || "Could not load the credit pipeline")
    } finally {
      setLoading(false)
    }
  }

  async function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string)
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)

    if (!over || active.id === over.id) return

    const accountId = active.id as string
    const newStage = over.id as string

    try {
      const res = await advanceCreditFlow(accountId, newStage)
      if (!res?.success) {
        toast.error("The stage change was not saved")
        return
      }
      await loadPipeline()
    } catch (error: any) {
      toast.error(error?.message || "The stage change was not saved")
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="flex items-center justify-center h-96">
          <div className="text-muted-foreground">Loading pipeline...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8">
      {/* Header with Stats */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-4">Credit Pipeline</h1>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <StatsCard
            icon={DollarSign}
            label="Total Pipeline Value"
            value={`$${stats?.total_value?.toLocaleString() || 0}`}
            color="text-green-500"
          />
          <StatsCard
            icon={TrendingUp}
            label="Active Accounts"
            value={stats?.total_accounts || 0}
            color="text-blue-500"
          />
          <StatsCard
            icon={Clock}
            label="Avg Time to Close"
            value={`${stats?.avg_time_to_close || 0} days`}
            color="text-orange-500"
          />
          <Card>
            <CardContent className="pt-6">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Budget Used</span>
                  <span className="font-medium">
                    {stats?.budget
                      ? `$${stats.budget.used.toLocaleString()} / $${stats.budget.limit.toLocaleString()}`
                      : "Not set"}
                  </span>
                </div>
                <Progress
                  value={
                    stats?.budget && stats.budget.limit > 0
                      ? Math.min(100, Math.round((stats.budget.used / stats.budget.limit) * 100))
                      : 0
                  }
                />
                {!stats?.budget && (
                  <p className="text-xs text-muted-foreground">
                    No credit budget recorded for this month yet
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Kanban Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {FLOW_STAGES.map((stage) => (
            <FlowStageColumn
              key={stage.id}
              stage={stage}
              accounts={accounts.filter((a) => a.current_stage === stage.id)}
              count={stats?.by_stage?.[stage.id] || 0}
              onManage={setManageAccount}
            />
          ))}
        </div>

        <DragOverlay>
          {activeId ? <AccountCard account={accounts.find((a) => a.id === activeId)!} isDragging /> : null}
        </DragOverlay>
      </DndContext>

      {/* Partner referrals — the reader side of credit_partner_referrals. */}
      <Card className="mt-8">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 mb-4">
            <Handshake className="h-5 w-5 text-muted-foreground" />
            <h2 className="font-semibold">Credit partner referrals</h2>
            <Badge variant="secondary">{stats?.referrals?.length ?? 0}</Badge>
          </div>
          {(stats?.referrals?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No contact has been referred to a credit partner yet. Use &ldquo;Refer to partner&rdquo; on a pipeline card.
            </p>
          ) : (
            <div className="divide-y">
              {stats!.referrals.map((r) => (
                <div key={r.id} className="flex items-center justify-between py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{r.partner_name || "Unnamed partner"}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.referred_at ? new Date(r.referred_at).toLocaleDateString() : "No referral date"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="capitalize text-xs">
                      {humanize(r.status)}
                    </Badge>
                    {r.contact_id && (
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/crm/contacts/${r.contact_id}`}>Contact</Link>
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Account Button */}
      <Button
        className="fixed bottom-8 right-8 rounded-full h-14 w-14"
        size="icon"
        aria-label="Add credit account"
        onClick={() => setAddOpen(true)}
      >
        <Plus className="h-6 w-6" />
      </Button>

      <NewCreditAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={loadPipeline}
      />

      <ManageCreditAccountDialog
        account={manageAccount}
        onOpenChange={(v) => {
          if (!v) setManageAccount(null)
        }}
        onChanged={loadPipeline}
      />
    </div>
  )
}

/**
 * The door onto the two credit-copilot endpoints that had no surface:
 *  - updateContactCreditStatus (contacts.credit_status / credit_score_band /
 *    lender_status / credit_pipeline_stage — brokerage-scoped on the predicate)
 *  - referToCreditPartner (credit_partner_referrals; both ends tenant-verified)
 * Both disclose or rewrite consumer credit standing, so neither takes any tenant
 * id from this component — the server resolves the brokerage from the session and
 * only the contact/partner ids the agent picked are sent.
 */
function ManageCreditAccountDialog({
  account,
  onOpenChange,
  onChanged,
}: {
  account: CreditAccount | null
  onOpenChange: (v: boolean) => void
  onChanged: () => Promise<void> | void
}) {
  const [creditStatus, setCreditStatus] = useState("")
  const [scoreBand, setScoreBand] = useState("")
  const [lenderStatus, setLenderStatus] = useState("")
  const [pipelineStage, setPipelineStage] = useState("")
  const [savingStatus, setSavingStatus] = useState(false)

  const [partners, setPartners] = useState<PartnerOption[]>([])
  const [loadingPartners, setLoadingPartners] = useState(false)
  const [partnerId, setPartnerId] = useState("")
  const [referralNotes, setReferralNotes] = useState("")
  const [expectedTimeline, setExpectedTimeline] = useState("")
  const [referring, setReferring] = useState(false)

  // The READ side of the credit lane: GET /api/credit/status (session-tenant
  // gated on the server; only the contact id the agent picked is sent).
  const [creditFile, setCreditFile] = useState<CreditFile | null>(null)
  const [creditFileError, setCreditFileError] = useState<string | null>(null)
  const [loadingCreditFile, setLoadingCreditFile] = useState(false)

  const open = account !== null
  const contactId = account?.contact_id ?? null

  useEffect(() => {
    if (!open) return
    setCreditStatus("")
    setScoreBand("")
    setLenderStatus("")
    setPipelineStage("")
    setPartnerId("")
    setReferralNotes("")
    setExpectedTimeline("")
    setCreditFile(null)
    setCreditFileError(null)

    let cancelled = false

    if (contactId) {
      setLoadingCreditFile(true)
      fetch(`/api/credit/status?contactId=${encodeURIComponent(contactId)}`, { credentials: "same-origin" })
        .then(async (res) => {
          const body = await res.json().catch(() => null)
          if (cancelled) return
          if (!res.ok || !body?.success) {
            // 404 is the route's fail-closed answer for a foreign or unknown
            // contact; it is shown, never silently rendered as "no file".
            setCreditFileError(body?.error || `Credit file unavailable (${res.status})`)
            return
          }
          setCreditFile({ creditStatus: body.creditStatus ?? null, creditLog: body.creditLog ?? [] })
        })
        .catch((e: any) => {
          if (!cancelled) setCreditFileError(e?.message || "Could not load the credit file")
        })
        .finally(() => {
          if (!cancelled) setLoadingCreditFile(false)
        })
    }

    setLoadingPartners(true)
    listPartnersWithReferrals()
      .then((res) => {
        if (cancelled) return
        setPartners((res.partners ?? []) as PartnerOption[])
      })
      .catch((e: any) => {
        if (!cancelled) toast.error(e?.message || "Could not load credit partners")
      })
      .finally(() => {
        if (!cancelled) setLoadingPartners(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, contactId])

  async function handleSaveStatus() {
    if (!account?.contact_id) return
    if (!creditStatus) {
      toast.error("Choose the credit status to record")
      return
    }
    setSavingStatus(true)
    try {
      const res = await updateContactCreditStatus({
        contact_id: account.contact_id,
        credit_status: creditStatus,
        credit_score_band: scoreBand || undefined,
        lender_status: lenderStatus || undefined,
        credit_pipeline_stage: pipelineStage || undefined,
      })
      if (!res?.success) {
        toast.error("The credit status was not saved")
        return
      }
      toast.success("Credit status updated")
      await onChanged()
    } catch (error: any) {
      toast.error(error?.message || "The credit status was not saved")
    } finally {
      setSavingStatus(false)
    }
  }

  async function handleRefer() {
    if (!account?.contact_id) return
    if (!partnerId) {
      toast.error("Choose the credit partner to refer to")
      return
    }
    setReferring(true)
    try {
      const res = await referToCreditPartner({
        contact_id: account.contact_id,
        partner_id: partnerId,
        referral_notes: referralNotes.trim() || undefined,
        expected_timeline: expectedTimeline.trim() || undefined,
      })
      if (!res?.success) {
        toast.error("The referral was not recorded")
        return
      }
      toast.success("Referred to credit partner")
      setPartnerId("")
      setReferralNotes("")
      setExpectedTimeline("")
      onOpenChange(false)
      await onChanged()
    } catch (error: any) {
      toast.error(error?.message || "The referral was not recorded")
    } finally {
      setReferring(false)
    }
  }

  const contactName =
    [account?.contact?.first_name, account?.contact?.last_name].filter(Boolean).join(" ") || "this contact"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Credit posture — {contactName}</DialogTitle>
          <DialogDescription>
            Record where this client stands, or hand them to a credit partner. Referring discloses their credit
            situation to that partner, so only partners in your brokerage are offered.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Credit file</h3>
            {loadingCreditFile ? (
              <p className="text-sm text-muted-foreground">Loading credit file…</p>
            ) : creditFileError ? (
              <p className="text-sm text-destructive">{creditFileError}</p>
            ) : !creditFile ? (
              <p className="text-sm text-muted-foreground">No contact is attached to this account.</p>
            ) : (
              <div className="space-y-3">
                {creditFile.creditStatus ? (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Credit score</p>
                      <p className="font-semibold">{creditFile.creditStatus.credit_score ?? "—"}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Debt-to-income</p>
                      <p className="font-semibold">
                        {creditFile.creditStatus.debt_to_income != null
                          ? `${creditFile.creditStatus.debt_to_income}%`
                          : "—"}
                      </p>
                    </div>
                    <div className="col-span-2 text-xs text-muted-foreground">
                      Last updated{" "}
                      {creditFile.creditStatus.last_updated
                        ? new Date(creditFile.creditStatus.last_updated).toLocaleString()
                        : "never"}
                      {creditFile.creditStatus.notes ? ` · ${creditFile.creditStatus.notes}` : ""}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No credit file (score / DTI) recorded for this contact yet. The posture you save below writes the
                    contact&apos;s credit_status field, not this file.
                  </p>
                )}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Credit-related activity ({creditFile.creditLog.length})
                  </p>
                  {creditFile.creditLog.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No credit-related activity logged.</p>
                  ) : (
                    <ul className="divide-y rounded-md border text-sm">
                      {creditFile.creditLog.slice(0, 10).map((a) => (
                        <li key={a.id} className="px-3 py-2">
                          <p className="font-medium">{a.title || a.description || "Credit activity"}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.created_at ? new Date(a.created_at).toLocaleString() : "Undated"}
                            {a.notes ? ` · ${a.notes}` : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-semibold">Credit status</h3>
            <div className="space-y-2">
              <Label htmlFor="cc-status">Status</Label>
              <Select value={creditStatus} onValueChange={setCreditStatus}>
                <SelectTrigger id="cc-status">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_STATUS_OPTIONS.map((v) => (
                    <SelectItem key={v} value={v} className="capitalize">
                      {humanize(v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="cc-band">Score band</Label>
                <Select value={scoreBand} onValueChange={setScoreBand}>
                  <SelectTrigger id="cc-band">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    {CREDIT_SCORE_BANDS.map((v) => (
                      <SelectItem key={v} value={v}>
                        {humanize(v)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cc-lender">Lender status</Label>
                <Select value={lenderStatus} onValueChange={setLenderStatus}>
                  <SelectTrigger id="cc-lender">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    {LENDER_STATUS_OPTIONS.map((v) => (
                      <SelectItem key={v} value={v} className="capitalize">
                        {humanize(v)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cc-stage">Pipeline stage</Label>
              <Select value={pipelineStage} onValueChange={setPipelineStage}>
                <SelectTrigger id="cc-stage">
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_PIPELINE_STAGE_OPTIONS.map((v) => (
                    <SelectItem key={v} value={v} className="capitalize">
                      {humanize(v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleSaveStatus} disabled={savingStatus} size="sm">
              {savingStatus ? "Saving…" : "Save credit status"}
            </Button>
          </section>

          <section className="space-y-3 border-t pt-4">
            <h3 className="text-sm font-semibold">Refer to a credit partner</h3>
            <div className="space-y-2">
              <Label htmlFor="cc-partner">Partner</Label>
              <Select value={partnerId} onValueChange={setPartnerId}>
                <SelectTrigger id="cc-partner">
                  <SelectValue placeholder={loadingPartners ? "Loading partners…" : "Select a partner"} />
                </SelectTrigger>
                <SelectContent>
                  {partners.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.partner_name || p.company_name || "Unnamed partner"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!loadingPartners && partners.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No referral partners are set up for you yet. Add one under Referrals first.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="cc-timeline">Expected timeline</Label>
              <Input
                id="cc-timeline"
                value={expectedTimeline}
                onChange={(e) => setExpectedTimeline(e.target.value)}
                placeholder="e.g. 90 days"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cc-notes">Referral notes</Label>
              <Textarea
                id="cc-notes"
                value={referralNotes}
                onChange={(e) => setReferralNotes(e.target.value)}
                placeholder="What should the partner know?"
                rows={3}
              />
            </div>
            <Button onClick={handleRefer} disabled={referring} size="sm">
              {referring ? "Referring…" : "Refer to partner"}
            </Button>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Component: New Credit Account dialog — the FAB's destination.
// Writes through createCreditAccount (credit_accounts + agent_credit_budgets usage).
function NewCreditAccountDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => Promise<void> | void
}) {
  const [contacts, setContacts] = useState<PickerContact[]>([])
  const [contactId, setContactId] = useState("")
  const [partnerName, setPartnerName] = useState("")
  const [amount, setAmount] = useState("")
  const [stage, setStage] = useState("flow_a")
  const [saving, setSaving] = useState(false)
  const [loadingContacts, setLoadingContacts] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingContacts(true)
    getContacts({ limit: 200 })
      .then((res) => {
        if (cancelled) return
        if (!res.success) {
          toast.error(res.error || "Could not load contacts")
          return
        }
        setContacts((res.contacts ?? []) as PickerContact[])
      })
      .catch((e: any) => {
        if (!cancelled) toast.error(e?.message || "Could not load contacts")
      })
      .finally(() => {
        if (!cancelled) setLoadingContacts(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  async function handleCreate() {
    const parsedAmount = Number(amount)
    if (!contactId) {
      toast.error("Choose the contact this credit account belongs to")
      return
    }
    if (!partnerName.trim()) {
      toast.error("Enter the credit partner")
      return
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error("Enter a credit amount greater than zero")
      return
    }

    setSaving(true)
    try {
      const res = await createCreditAccount({
        contact_id: contactId,
        partner_name: partnerName.trim(),
        credit_amount: parsedAmount,
        initial_stage: stage,
      })
      if (!res?.success) {
        toast.error("The credit account was not created")
        return
      }
      toast.success("Credit account created")
      setContactId("")
      setPartnerName("")
      setAmount("")
      setStage("flow_a")
      onOpenChange(false)
      await onCreated()
    } catch (error: any) {
      toast.error(error?.message || "The credit account was not created")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New credit account</DialogTitle>
          <DialogDescription>
            Put a contact into the credit pipeline. The stage you pick fires that stage&apos;s follow-up automation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="credit-contact">Contact</Label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger id="credit-contact">
                <SelectValue placeholder={loadingContacts ? "Loading contacts…" : "Select a contact"} />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed contact"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!loadingContacts && contacts.length === 0 && (
              <p className="text-xs text-muted-foreground">No contacts are assigned to you yet.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="credit-partner">Credit partner</Label>
            <Input
              id="credit-partner"
              value={partnerName}
              onChange={(e) => setPartnerName(e.target.value)}
              placeholder="e.g. Summit Credit Restoration"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="credit-amount">Credit amount</Label>
            <Input
              id="credit-amount"
              type="number"
              min={0}
              step={100}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="2500"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="credit-stage">Starting stage</Label>
            <Select value={stage} onValueChange={setStage}>
              <SelectTrigger id="credit-stage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FLOW_STAGES.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving ? "Creating…" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Component: Stats Card
function StatsCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any
  label: string
  value: string | number
  color: string
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <Icon className={`h-8 w-8 ${color}`} />
        </div>
      </CardContent>
    </Card>
  )
}

// Component: Flow Stage Column
function FlowStageColumn({
  stage,
  accounts,
  count,
  onManage,
}: {
  stage: { id: string; name: string; color: string }
  accounts: CreditAccount[]
  count: number
  onManage: (account: CreditAccount) => void
}) {
  const { setNodeRef } = useSortable({
    id: stage.id,
    data: { type: "column" },
  })

  return (
    <div className="space-y-3">
      {/* Column Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${stage.color}`} />
          <h3 className="font-semibold">{stage.name}</h3>
        </div>
        <Badge variant="secondary">{count}</Badge>
      </div>

      {/* Droppable Area */}
      <div ref={setNodeRef} className="min-h-[500px] p-3 bg-muted/30 rounded-lg space-y-2">
        <SortableContext items={accounts.map((a) => a.id)} strategy={verticalListSortingStrategy}>
          {accounts.map((account) => (
            <DraggableAccountCard key={account.id} account={account} onManage={onManage} />
          ))}
        </SortableContext>
      </div>
    </div>
  )
}

// Component: Draggable Account Card
function DraggableAccountCard({
  account,
  onManage,
}: {
  account: CreditAccount
  onManage: (account: CreditAccount) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: account.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <AccountCard account={account} onManage={onManage} />
    </div>
  )
}

// Component: Account Card
function AccountCard({
  account,
  isDragging = false,
  onManage,
}: {
  account: CreditAccount
  isDragging?: boolean
  onManage?: (account: CreditAccount) => void
}) {
  if (!account) return null

  const initials = `${account.contact?.first_name?.[0] || ""}${account.contact?.last_name?.[0] || ""}`

  return (
    <Card className={isDragging ? "opacity-50" : "cursor-move hover:shadow-md transition-shadow"}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Avatar className="h-8 w-8">
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm truncate">
              {account.contact?.first_name} {account.contact?.last_name}
            </p>
            <p className="text-xs text-muted-foreground">{account.partner_name}</p>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-medium">${account.credit_amount?.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Status</span>
            <Badge variant="outline" className="text-xs">
              {account.account_status}
            </Badge>
          </div>
        </div>

        <div className="space-y-2">
          <Button asChild variant="outline" size="sm" className="w-full bg-transparent">
            <Link href={`/crm/contacts/${account.contact_id}`}>View Details</Link>
          </Button>
          {onManage && (
            <Button
              variant="outline"
              size="sm"
              className="w-full bg-transparent"
              // The card is a drag handle; without stopPropagation the pointer-down
              // starts a drag instead of opening the dialog.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onManage(account)
              }}
            >
              Credit status / refer
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
