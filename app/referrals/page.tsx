import { Card, CardContent } from "@/components/ui/card"
import { getAgentContext } from "@/lib/identity"
import {
  loadReferralPipelineAction,
  loadReputationWorkspaceAction,
} from "@/app/actions/reputation-kernel"
import { getLifetimeCustomers, getUpcomingAnniversaries } from "@/app/actions/lifetime-customers"
import { REFERRAL_STATUSES_CONVERTED } from "@/lib/referrals/referral-status"
import { ReferralsOsClient } from "./referrals-os-client"

export const dynamic = "force-dynamic"

/*
 * /referrals WAS FOUR LINES: `redirect("/lifetime-customers?tab=referrals")`.
 *
 * That alias landed on the lifetime-customers `radar` tab, which carries none of
 * what this composition carries — no referral ROI rollup, no advocacy/sphere
 * score, no top-referrer leaderboard, no review-request flow, no gifting flow,
 * no anniversary/repeat-business prompts. So `ReferralsOsClient` and the five
 * panels reachable ONLY through it (ReferralCommandStrip, AdvocacyRadar,
 * AdvocacyActionStack, ReferralAiDraftingPanel, RepeatBusinessPanel) were built,
 * exported, and imported by nobody. Not duplicated elsewhere — dark.
 *
 * WHY THIS LOADER WRITES NO QUERIES OF ITS OWN. Every figure below comes from an
 * action that already existed and was already tenant-scoped:
 *
 *   loadReferralPipelineAction   → referral rows AND the `counts` rollup that the
 *                                  radar tab computed and then threw away
 *   loadReputationWorkspaceAction→ agent_reviews for the review panel
 *   getLifetimeCustomers         → past clients + their closed transactions +
 *                                  client_engagement_scores (sphere maths below)
 *   getUpcomingAnniversaries     → closed transactions whose anniversary is near
 *
 * A second copy of any of those reads is how the four referral surfaces ended up
 * with four different ideas of what a referral status is (see
 * lib/referrals/referral-status.ts). There is no fifth copy here.
 */

interface Props {
  searchParams: Promise<{ action?: string; contactId?: string }>
}

/** The engagement row getLifetimeCustomers aliases onto each client. */
interface EngagementRow {
  engagement_score?: number | null
  last_touchpoint_date?: string | null
  referrals_given?: number | null
  touchpoints_count?: number | null
}

interface ClientRow {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  referral_potential?: string | null
  transactions?: Array<{
    id: string
    actual_close_date?: string | null
    property_address?: string | null
    status?: string | null
  }>
  client_engagement_scores?: EngagementRow[]
}

function fullName(c: { first_name?: string | null; last_name?: string | null }): string {
  return `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim()
}

export default async function ReferralsPage({ searchParams }: Props) {
  const { action, contactId } = await searchParams
  const { agentId, brokerageId } = await getAgentContext()

  // Same convention as app/referrals/pipeline/page.tsx: getAgentContext never
  // throws and returns nulls when the session has no agent profile. Rendering the
  // OS with empty-string ids would hand every panel an id that fails isValidUUID
  // upstream and produce silent no-ops, so say so instead.
  if (!agentId || !brokerageId) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-12 text-center">
            <p className="font-medium">Referral &amp; Advocacy Engine unavailable</p>
            <p className="mt-2 text-sm text-muted-foreground">
              This workspace has no agent profile attached to your sign-in, so there is no
              book of business to load referrals against.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // supabase-js RESOLVES a failed query, and these actions mirror that: they
  // return { success: false, error } rather than throwing. A dropped error here
  // would render as "you have no referrals", which is the one thing an empty
  // referral board must never be able to mean by accident.
  const [pipelineRes, workspaceRes, clientsRes, anniversaryRes] = await Promise.all([
    loadReferralPipelineAction(),
    loadReputationWorkspaceAction(),
    getLifetimeCustomers(),
    getUpcomingAnniversaries(),
  ])

  const loadErrors: string[] = []

  const pipeline = pipelineRes.success && "data" in pipelineRes ? pipelineRes.data : undefined
  if (!pipelineRes.success) loadErrors.push(`Referrals: ${pipelineRes.error ?? "could not be loaded"}`)

  const workspace = workspaceRes.success && "data" in workspaceRes ? workspaceRes.data : undefined
  if (!workspaceRes.success) loadErrors.push(`Reviews: ${workspaceRes.error ?? "could not be loaded"}`)

  const clients: ClientRow[] =
    clientsRes.success && "clients" in clientsRes ? ((clientsRes.clients ?? []) as ClientRow[]) : []
  if (!clientsRes.success) {
    loadErrors.push(`Past clients: ${("error" in clientsRes && clientsRes.error) || "could not be loaded"}`)
  }

  const anniversaryRows =
    anniversaryRes.success && anniversaryRes.anniversaries
      ? (anniversaryRes.anniversaries as Array<{
          contact_id?: string | null
          close_date?: string | null
          property_address?: string | null
          contacts?: { first_name?: string | null; last_name?: string | null } | null
        }>)
      : []
  if (!anniversaryRes.success) {
    loadErrors.push(`Anniversaries: ${anniversaryRes.error ?? "could not be loaded"}`)
  }

  // ── Referral rollup ────────────────────────────────────────────────────────
  const referralRows = pipeline?.referrals ?? []
  const counts = pipeline?.counts ?? {}

  const totalReferrals = referralRows.length

  // "converted" is NOT a storable referral status — referrals_status_check admits
  // received|contacted|qualified|assigned|under_contract|closed|lost. Every ROI
  // figure that counted `status === "converted"` was therefore permanently zero.
  const converted = REFERRAL_STATUSES_CONVERTED.reduce((sum, s) => sum + (counts[s] ?? 0), 0)

  // Pending = still in play: not yet producing business and not lost.
  const pendingReferrals = Object.entries(counts).reduce(
    (sum, [status, n]) =>
      status === "lost" || (REFERRAL_STATUSES_CONVERTED as string[]).includes(status) ? sum : sum + n,
    0,
  )

  // value_estimate is the DEAL-value column. commission_amount and
  // commission_potential are a different unit; summing them into the same total
  // would silently mix gross deal value with the agent's cut.
  const totalValue = referralRows.reduce((sum, r) => sum + (Number(r.value_estimate) || 0), 0)

  const roiSummary = {
    totalReferrals,
    converted,
    conversionRate: totalReferrals > 0 ? (converted / totalReferrals) * 100 : 0,
    totalValue,
  }

  // ── Leaderboard: who actually sends this agent business ────────────────────
  // The referrer's name lives on the referral row itself (source_contact_name,
  // or the free-text referred_by when no contact was linked). No extra read.
  const referrerTally = new Map<string, number>()
  for (const r of referralRows) {
    const name = (r.source_contact_name ?? r.referred_by ?? "").trim()
    if (!name) continue
    referrerTally.set(name, (referrerTally.get(name) ?? 0) + 1)
  }
  const topReferrers = [...referrerTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }))
  const leaderboardWidget = topReferrers.length > 0 ? { topReferrers } : null

  // ── Sphere maths, all of it from stored rows ───────────────────────────────
  // engagement  = mean of client_engagement_scores.score (the stored score)
  // loyalty     = share of past clients who have closed with this agent twice
  // advocacy    = share of past clients who have given at least one referral
  // Each component is counted, never estimated. With no past clients there is
  // nothing to average, so the whole card is null and the panel says so.
  const engagementRows = clients
    .map((c) => c.client_engagement_scores?.[0])
    .filter((e): e is EngagementRow => Boolean(e))

  const engagement =
    engagementRows.length > 0
      ? Math.round(
          engagementRows.reduce((s, e) => s + (Number(e.engagement_score) || 0), 0) /
            engagementRows.length,
        )
      : 0

  const repeatClients = clients.filter((c) => (c.transactions?.length ?? 0) > 1).length
  const loyalty = clients.length > 0 ? Math.round((repeatClients / clients.length) * 100) : 0

  const advocateClients = clients.filter(
    (c) => (Number(c.client_engagement_scores?.[0]?.referrals_given) || 0) > 0,
  ).length
  const advocacy = clients.length > 0 ? Math.round((advocateClients / clients.length) * 100) : 0

  const sphereScore =
    clients.length > 0
      ? {
          overall: Math.round((engagement + loyalty + advocacy) / 3),
          engagement,
          loyalty,
          advocacy,
        }
      : null

  // Same bands app/lifetime-customers/page.tsx uses for its sphere tiles, so the
  // two screens cannot disagree about who is a champion. A client with no score
  // row counts as at-risk — nobody has scored them, which is exactly the state
  // that tile is for.
  const scoreOf = (c: ClientRow) => Number(c.client_engagement_scores?.[0]?.engagement_score) || 0
  const sphereSegments =
    clients.length > 0
      ? {
          champions: clients.filter((c) => scoreOf(c) >= 70).length,
          engaged: clients.filter((c) => scoreOf(c) >= 50 && scoreOf(c) < 70).length,
          cooling: clients.filter((c) => scoreOf(c) >= 30 && scoreOf(c) < 50).length,
          atRisk: clients.filter((c) => scoreOf(c) < 30).length,
        }
      : null

  // Top advocates: referrals actually given first, engagement as the tiebreak.
  // contacts.referral_potential is a real column and is preferred when it has
  // been written; otherwise the count of referrals given IS the potential.
  const POTENTIALS = ["high", "medium", "low"] as const
  const advocateList = clients
    .map((c) => {
      const given = Number(c.client_engagement_scores?.[0]?.referrals_given) || 0
      const stated = (c.referral_potential ?? "").toLowerCase()
      const potential = (POTENTIALS as readonly string[]).includes(stated)
        ? (stated as (typeof POTENTIALS)[number])
        : given >= 2
          ? "high"
          : given === 1
            ? "medium"
            : "low"
      return { id: c.id, name: fullName(c) || "Unnamed contact", score: scoreOf(c), given, potential }
    })
    .filter((a) => a.given > 0 || a.score >= 70)
    .sort((a, b) => b.given - a.given || b.score - a.score)
    .slice(0, 5)
    .map(({ id, name, score, potential }) => ({ id, name, score, potential }))
  const topAdvocates = advocateList.length > 0 ? advocateList : null

  // ── Recent closings (review candidates) ────────────────────────────────────
  const recentClosings = clients
    .flatMap((c) =>
      (c.transactions ?? [])
        .filter((t) => Boolean(t.actual_close_date))
        .map((t) => ({
          id: t.id,
          contact_id: c.id,
          contactName: fullName(c) || "Unnamed contact",
          address: t.property_address ?? "Address not recorded",
          closeDate: t.actual_close_date as string,
          transactionId: t.id,
          // Without this the panel's Send button posted an empty address to
          // sendThankYouNoteAction and the request went nowhere.
          contactEmail: c.email ?? undefined,
        })),
    )
    .sort((a, b) => new Date(b.closeDate).getTime() - new Date(a.closeDate).getTime())
    .slice(0, 8)

  const existingReviews = (workspace?.reviews ?? []).map((r) => ({
    id: r.id,
    platform: r.platform,
    rating: r.rating,
    review_text: r.review_text ?? "",
  }))

  // ── Anniversaries ──────────────────────────────────────────────────────────
  const thisYear = new Date().getFullYear()
  const upcomingAnniversaries = anniversaryRows
    .filter((t) => Boolean(t.contact_id && t.close_date))
    .map((t) => ({
      contactId: t.contact_id as string,
      contactName: t.contacts ? fullName(t.contacts) || "Unnamed contact" : "Unnamed contact",
      address: t.property_address ?? "Address not recorded",
      yearsCount: Math.max(1, thisYear - new Date(t.close_date as string).getFullYear()),
      closeDate: t.close_date as string,
    }))

  // ── The contact picker's options ───────────────────────────────────────────
  // An agents.id is not a contacts.id. The composition used to substitute one for
  // the other; this list is what makes a REAL contact selectable instead.
  const sphereContacts = clients
    .map((c) => ({ id: c.id, name: fullName(c) || "Unnamed contact" }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const selectedContactId =
    contactId && sphereContacts.some((c) => c.id === contactId) ? contactId : null

  return (
    <div className="container mx-auto p-6">
      {loadErrors.length > 0 && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p className="font-medium">Some of this page could not be loaded:</p>
          <ul className="list-inside list-disc">
            {loadErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <ReferralsOsClient
        agentId={agentId}
        brokerageId={brokerageId}
        referralCount={totalReferrals}
        pendingReferrals={pendingReferrals}
        roiSummary={roiSummary}
        referrals={referralRows.map((r) => ({
          id: r.id,
          referral_name: r.referral_name,
          status: r.status,
          source_contact_id: r.referred_contact_id ?? undefined,
          source_contact_name: r.source_contact_name ?? r.referred_by ?? undefined,
          created_at: r.created_at,
          value_estimate: Number(r.value_estimate) || undefined,
        }))}
        sphereScore={sphereScore}
        topAdvocates={topAdvocates}
        sphereSegments={sphereSegments}
        leaderboardWidget={leaderboardWidget}
        recentClosings={recentClosings}
        existingReviews={existingReviews}
        upcomingAnniversaries={upcomingAnniversaries}
        sphereContacts={sphereContacts}
        selectedContactId={selectedContactId}
        initialAction={action === "create" ? "create" : null}
      />
    </div>
  )
}
