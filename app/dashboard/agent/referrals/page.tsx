"use client"

import { useEffect, useState, useTransition } from "react"
import {
  listPartnersWithReferrals,
  createReferral,
  createPartner,
  updateReferralStatus,
  type ReferralPartnerRow,
  type ReferralRow,
  type CreateReferralParams,
} from "@/app/actions/referrals/referral-actions"
import { getReferralPartnerStats } from "@/app/actions/multi-persona"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type PipelineStage = ReferralRow["status"]

const PIPELINE_STAGES: { key: PipelineStage; label: string }[] = [
  { key: "received",       label: "Received" },
  { key: "contacted",      label: "Contacted" },
  { key: "qualified",      label: "Qualified" },
  { key: "under_contract", label: "Under Contract" },
  { key: "closed",         label: "Closed" },
]

// These were DISPLAY labels — "Lender", "Commission Split" — stored straight into
// CHECK-constrained columns, so every Add Partner on this screen threw
// `violates check constraint "referral_partners_agreement_type_check"`. The
// canonical lists store a value and show a label; see the module for the proof.
import {
  REFERRAL_PARTNER_TYPES, REFERRAL_AGREEMENT_TYPES,
  type ReferralPartnerType, type ReferralAgreementType,
} from "@/lib/referrals/partner-vocabulary"

const PARTNER_TYPES = REFERRAL_PARTNER_TYPES
const AGREEMENT_TYPES = REFERRAL_AGREEMENT_TYPES

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, prefix = "$") {
  if (n == null) return "—"
  return `${prefix}${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function calcCommission(
  dealValue: number,
  partner: ReferralPartnerRow | null
): number {
  if (!partner) return 0
  if (partner.referral_fee_flat) return partner.referral_fee_flat
  if (partner.commission_split_percentage)
    return dealValue * (partner.commission_split_percentage / 100)
  return 0
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function ReferralsPage() {
  const [partners, setPartners]           = useState<ReferralPartnerRow[]>([])
  const [referrals, setReferrals]         = useState<ReferralRow[]>([])
  const [activePartner, setActivePartner] = useState<ReferralPartnerRow | null>(null)
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [isPending, startTransition]      = useTransition()

  // Modals
  const [showAddPartner, setShowAddPartner]     = useState(false)
  const [showAddReferral, setShowAddReferral]   = useState(false)
  const [showCalculator, setShowCalculator]     = useState(false)

  // Add partner form
  const [pName, setPName]               = useState("")
  const [pType, setPType]               = useState(PARTNER_TYPES[0].value)
  const [pAgreement, setPAgreement]     = useState(AGREEMENT_TYPES[0].value)
  const [pSplit, setPSplit]             = useState<string>("")
  const [pFlat, setPFlat]               = useState<string>("")

  // Add referral form
  const [rPartnerId, setRPartnerId]     = useState("")
  const [rSource, setRSource]           = useState("")
  const [rCommission, setRCommission]   = useState<string>("")
  const [rFirstName, setRFirstName]     = useState("")
  const [rLastName, setRLastName]       = useState("")
  const [rEmail, setREmail]             = useState("")
  const [rPhone, setRPhone]             = useState("")

  // Calculator
  const [calcDeal, setCalcDeal]         = useState<string>("")
  const [calcPartner, setCalcPartner]   = useState<ReferralPartnerRow | null>(null)

  // Load
  useEffect(() => {
    listPartnersWithReferrals()
      .then(({ partners, referrals }) => {
        setPartners(partners)
        setReferrals(referrals)
        if (partners.length > 0) setActivePartner(partners[0])
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false))
  }, [])

  function reload() {
    setLoading(true)
    listPartnersWithReferrals()
      .then(({ partners, referrals }) => {
        setPartners(partners)
        setReferrals(referrals)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to reload"))
      .finally(() => setLoading(false))
  }

  // BROKERAGE-WIDE PARTNER SCORECARD.
  // Everything else on this page is derived from `referrals`, which
  // listPartnersWithReferrals scopes to THIS AGENT (and caps at 200). So the
  // partner card could only ever answer "how has this partner done for me".
  // getReferralPartnerStats answers the question the agent actually asks before
  // sending business — how does this partner convert for the BROKERAGE — and it
  // had no caller. Loaded for the selected partner only.
  const [partnerStats, setPartnerStats] = useState<{
    totalReferrals: number
    convertedReferrals: number
    totalCommission: number
    conversionRate: number
  } | null>(null)
  const [partnerStatsLoading, setPartnerStatsLoading] = useState(false)

  useEffect(() => {
    if (!activePartner) { setPartnerStats(null); return }
    let cancelled = false
    setPartnerStatsLoading(true)
    setPartnerStats(null)
    getReferralPartnerStats(activePartner.id)
      .then((s) => { if (!cancelled) setPartnerStats(s) })
      .catch(() => { if (!cancelled) setPartnerStats(null) })
      .finally(() => { if (!cancelled) setPartnerStatsLoading(false) })
    return () => { cancelled = true }
  }, [activePartner])

  // Derived
  const partnerReferrals = activePartner
    ? referrals.filter((r) => r.partner_id === activePartner.id)
    : referrals

  const totalCommission = referrals
    .filter((r) => r.status === "closed")
    .reduce((sum, r) => sum + (r.commission_amount ?? 0), 0)

  const closedCount = referrals.filter((r) => r.status === "closed").length

  // Handlers
  function handleAddPartner(e: React.FormEvent) {
    e.preventDefault()
    startTransition(() => {
      createPartner({
        partnerName: pName,
        partnerType: pType,
        agreementType: pAgreement,
        commissionSplitPercentage: pSplit ? parseFloat(pSplit) : undefined,
        referralFeeFlat: pFlat ? parseFloat(pFlat) : undefined,
      })
        .then(() => {
          setShowAddPartner(false)
          setPName(""); setPType(PARTNER_TYPES[0].value); setPAgreement(AGREEMENT_TYPES[0].value)
          setPSplit(""); setPFlat("")
          reload()
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to add partner"))
    })
  }

  function handleAddReferral(e: React.FormEvent) {
    e.preventDefault()
    const params: CreateReferralParams = {
      partnerId: rPartnerId,
      referralSource: rSource || undefined,
      commissionAmount: rCommission ? parseFloat(rCommission) : undefined,
      referredPerson: (rFirstName || rLastName || rEmail || rPhone)
        ? { firstName: rFirstName, lastName: rLastName, email: rEmail, phone: rPhone }
        : undefined,
    }
    startTransition(() => {
      createReferral(params)
        .then(() => {
          setShowAddReferral(false)
          setRPartnerId(""); setRSource(""); setRCommission("")
          setRFirstName(""); setRLastName(""); setREmail(""); setRPhone("")
          reload()
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to add referral"))
    })
  }

  function handleStatusChange(referralId: string, status: PipelineStage) {
    startTransition(() => {
      updateReferralStatus(referralId, status)
        .then(() => reload())
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to update status"))
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground font-sans">
        Loading referrals...
      </div>
    )
  }

  return (
    <div className="font-sans min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Referral Intelligence</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage partners, track pipeline, and analyze commissions.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowCalculator(true)}
              className="px-3 py-2 text-sm border border-border rounded-md bg-background hover:bg-muted transition-colors"
            >
              Commission Calculator
            </button>
            <button
              onClick={() => setShowAddReferral(true)}
              disabled={partners.length === 0}
              className="px-3 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              + New Referral
            </button>
            <button
              onClick={() => setShowAddPartner(true)}
              className="px-3 py-2 text-sm border border-border rounded-md bg-background hover:bg-muted transition-colors"
            >
              + Add Partner
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-destructive/10 text-destructive rounded-md text-sm">
            {error}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Partners",           value: partners.length },
            { label: "Total Referrals",    value: referrals.length },
            { label: "Closed Deals",       value: closedCount },
            { label: "Commission Earned",  value: fmt(totalCommission) },
          ].map((s) => (
            <div key={s.label} className="bg-card border border-border rounded-lg p-4">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-2xl font-bold mt-1">{s.value}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">

          {/* Partner List */}
          <div className="lg:col-span-1">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
              Partners
            </h2>
            {partners.length === 0 ? (
              <p className="text-sm text-muted-foreground">No partners yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {partners.map((p) => {
                  const count = referrals.filter((r) => r.partner_id === p.id).length
                  return (
                    <button
                      key={p.id}
                      onClick={() => setActivePartner(p)}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        activePartner?.id === p.id
                          ? "border-primary bg-primary/5"
                          : "border-border bg-card hover:bg-muted"
                      }`}
                    >
                      <p className="font-medium text-sm truncate">{p.partner_name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {p.partner_type} · {count} referrals
                      </p>
                      {p.commission_split_percentage != null && (
                        <p className="text-xs text-muted-foreground">
                          {p.commission_split_percentage}% split
                        </p>
                      )}
                      {p.referral_fee_flat != null && (
                        <p className="text-xs text-muted-foreground">
                          {fmt(p.referral_fee_flat)} flat fee
                        </p>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Brokerage-wide scorecard for the selected partner */}
            {activePartner && (
              <div className="mt-4 rounded-lg border border-border bg-card p-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {activePartner.partner_name} — brokerage-wide
                </p>
                {partnerStatsLoading ? (
                  <p className="text-xs text-muted-foreground mt-2">Loading…</p>
                ) : partnerStats ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">Referrals</p>
                      <p className="font-semibold text-sm">{partnerStats.totalReferrals}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Converted</p>
                      <p className="font-semibold text-sm">{partnerStats.convertedReferrals}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Conversion</p>
                      <p className="font-semibold text-sm">{partnerStats.conversionRate.toFixed(0)}%</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Commission</p>
                      <p className="font-semibold text-sm">{fmt(partnerStats.totalCommission)}</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground mt-2">
                    Brokerage-wide stats unavailable.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Pipeline */}
          <div className="lg:col-span-3">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Pipeline{activePartner ? ` — ${activePartner.partner_name}` : " (All)"}
              </h2>
              {activePartner && (
                <button
                  onClick={() => setActivePartner(null)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Show all
                </button>
              )}
            </div>

            {/* Kanban */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {PIPELINE_STAGES.map((stage) => {
                const stageReferrals = partnerReferrals.filter(
                  (r) => r.status === stage.key
                )
                return (
                  <div key={stage.key} className="flex flex-col gap-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {stage.label}
                      <span className="ml-1 text-foreground">({stageReferrals.length})</span>
                    </div>
                    {stageReferrals.map((r) => (
                      <div
                        key={r.id}
                        className="bg-card border border-border rounded-md p-2 text-xs"
                      >
                        <p className="font-medium truncate">
                          {r.referral_partners?.partner_name ?? "Unknown"}
                        </p>
                        <p className="text-muted-foreground truncate">
                          {r.referral_source ?? "No source"}
                        </p>
                        {r.commission_amount != null && (
                          <p className="text-foreground font-medium mt-1">
                            {fmt(r.commission_amount)}
                          </p>
                        )}
                        <p className="text-muted-foreground mt-1">
                          {new Date(r.created_at).toLocaleDateString()}
                        </p>
                        {/* Stage advance */}
                        {stage.key !== "closed" && (
                          <select
                            value={r.status}
                            onChange={(e) =>
                              handleStatusChange(r.id, e.target.value as PipelineStage)
                            }
                            disabled={isPending}
                            className="mt-1 w-full text-xs bg-background border border-border rounded p-0.5"
                          >
                            {PIPELINE_STAGES.map((s) => (
                              <option key={s.key} value={s.key}>{s.label}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    ))}
                    {stageReferrals.length === 0 && (
                      <div className="bg-muted/40 border border-dashed border-border rounded-md p-2 text-xs text-muted-foreground text-center">
                        Empty
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── ADD PARTNER MODAL ─────────────────────────────────────────────── */}
      {showAddPartner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-4">Add Referral Partner</h2>
            <form onSubmit={handleAddPartner} className="flex flex-col gap-3">
              <input
                required
                placeholder="Partner Name"
                value={pName}
                onChange={(e) => setPName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
              />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">Type</label>
                  <select
                    value={pType}
                    onChange={(e) => setPType(e.target.value as ReferralPartnerType)}
                    className="w-full mt-1 px-2 py-2 text-sm border border-border rounded-md bg-background"
                  >
                    {PARTNER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Agreement</label>
                  <select
                    value={pAgreement}
                    onChange={(e) => setPAgreement(e.target.value as ReferralAgreementType)}
                    className="w-full mt-1 px-2 py-2 text-sm border border-border rounded-md bg-background"
                  >
                    {AGREEMENT_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">Split %</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    placeholder="e.g. 25"
                    value={pSplit}
                    onChange={(e) => setPSplit(e.target.value)}
                    className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-md bg-background"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Flat Fee $</label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    placeholder="e.g. 500"
                    value={pFlat}
                    onChange={(e) => setPFlat(e.target.value)}
                    className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-md bg-background"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setShowAddPartner(false)}
                  className="px-4 py-2 text-sm border border-border rounded-md hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                >
                  {isPending ? "Saving..." : "Add Partner"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── ADD REFERRAL MODAL ────────────────────────────────────────────── */}
      {showAddReferral && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-4">New Referral</h2>
            <form onSubmit={handleAddReferral} className="flex flex-col gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Partner *</label>
                <select
                  required
                  value={rPartnerId}
                  onChange={(e) => setRPartnerId(e.target.value)}
                  className="w-full mt-1 px-2 py-2 text-sm border border-border rounded-md bg-background"
                >
                  <option value="">Select partner...</option>
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>{p.partner_name}</option>
                  ))}
                </select>
              </div>
              <input
                placeholder="Source (e.g. open house, event)"
                value={rSource}
                onChange={(e) => setRSource(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
              />
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Expected Commission $"
                value={rCommission}
                onChange={(e) => setRCommission(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
              />
              <p className="text-xs text-muted-foreground font-medium">
                Referred Person (optional — creates contact if email/phone provided)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <input
                  placeholder="First Name"
                  value={rFirstName}
                  onChange={(e) => setRFirstName(e.target.value)}
                  className="px-3 py-2 text-sm border border-border rounded-md bg-background"
                />
                <input
                  placeholder="Last Name"
                  value={rLastName}
                  onChange={(e) => setRLastName(e.target.value)}
                  className="px-3 py-2 text-sm border border-border rounded-md bg-background"
                />
              </div>
              <input
                type="email"
                placeholder="Email"
                value={rEmail}
                onChange={(e) => setREmail(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
              />
              <input
                type="tel"
                placeholder="Phone"
                value={rPhone}
                onChange={(e) => setRPhone(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setShowAddReferral(false)}
                  className="px-4 py-2 text-sm border border-border rounded-md hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                >
                  {isPending ? "Saving..." : "Add Referral"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── COMMISSION CALCULATOR MODAL ───────────────────────────────────── */}
      {showCalculator && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Commission Calculator</h2>
            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Deal Value $</label>
                <input
                  type="number"
                  step="1000"
                  min="0"
                  placeholder="e.g. 500000"
                  value={calcDeal}
                  onChange={(e) => setCalcDeal(e.target.value)}
                  className="w-full mt-1 px-3 py-2 text-sm border border-border rounded-md bg-background"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Partner</label>
                <select
                  value={calcPartner?.id ?? ""}
                  onChange={(e) =>
                    setCalcPartner(partners.find((p) => p.id === e.target.value) ?? null)
                  }
                  className="w-full mt-1 px-2 py-2 text-sm border border-border rounded-md bg-background"
                >
                  <option value="">Select partner...</option>
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>{p.partner_name}</option>
                  ))}
                </select>
              </div>
              {calcDeal && calcPartner && (
                <div className="bg-muted rounded-md p-4 mt-2">
                  <p className="text-sm text-muted-foreground">Estimated Commission</p>
                  <p className="text-3xl font-bold mt-1 text-foreground">
                    {fmt(calcCommission(parseFloat(calcDeal), calcPartner))}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {calcPartner.referral_fee_flat != null
                      ? `Flat fee: ${fmt(calcPartner.referral_fee_flat)}`
                      : `${calcPartner.commission_split_percentage ?? 0}% of deal value`}
                  </p>
                </div>
              )}
              <button
                onClick={() => setShowCalculator(false)}
                className="mt-2 px-4 py-2 text-sm border border-border rounded-md hover:bg-muted w-full"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
