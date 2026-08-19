/**
 * ─────────────────────────────────────────────────────────────────────────────
 * AD-HOC MILESTONES — the affordance `createTransactionMilestone` was waiting for.
 *
 * `app/actions/copilot.ts:createTransactionMilestone` is the only lane in this
 * product for an agent to add ONE milestone by hand. Everything else that writes
 * `transaction_milestones` writes a SET: lib/transactions/milestone-service.ts
 * seeds a template, lib/application/transactions.ts:1422 writes an AI-generated
 * client timeline, app/actions/lender-portal-actions.ts:203 stamps a lender event.
 * Its docblock recorded the blocker precisely — "there is no 'add milestone'
 * affordance on any transaction surface" — and that is what this route is.
 *
 * WHY A SIBLING ROUTE. `transaction-detail-client.tsx` belongs to another lane this
 * wave. /dashboard/transactions/[id]/health is the existing precedent for a deal
 * sub-route, so this follows it. The one line still owed on the parent (a link to
 * this route from the deal header) is REPORTED, not written here.
 *
 * STILL OWED — SAID PLAINLY. There is no LINK into this route yet.
 * `test:orphan-routes` counts it as referenced only because
 * `createTransactionMilestone` now revalidates
 * `/dashboard/transactions/${tx.id}/milestones`, which is correct on its own merits
 * (this page lists the milestones server-side) but is not a way for a human to arrive.
 * The real entry is one link in app/dashboard/transactions/[id]/transaction-detail-client.tsx,
 * beside the existing MilestoneDeadlinesButton:
 *   <Link href={`/dashboard/transactions/${id}/milestones`}>Milestones</Link>
 * That file belongs to another lane and the line is reported, not written.
 *
 * THE ACTION TAKES A LISTING, NOT A TRANSACTION — it resolves the listing's most
 * recent transaction inside the caller's brokerage itself. So this page reads the
 * deal only to find its listing_id and to render what is already there; the write
 * path re-derives both the tenant and the transaction server-side and this page is
 * not load-bearing for either.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { redirect, notFound } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import Link from "next/link"
import { createClient } from "@/lib/supabase/server"
import { AddMilestoneForm } from "./add-milestone-form"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Milestones | Transaction",
  description: "Add and review the milestones on this deal",
}

export default async function TransactionMilestonesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  // SELF-HEAL BEFORE BOUNCING. An agent whose account is incomplete has a
  // brokerage the OS can provision for them, so bouncing them to onboarding is a
  // dead end they did not need. This resolves and, where it can, provisions in
  // place; the redirect below then fires ONLY for an account that genuinely
  // cannot self-provision — a pending brokerage invite, or a staff user whose
  // brokerage comes from their org rather than from themselves.
  await ensureAgentContextInPlace()

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")

  // `error` destructured on both reads. supabase-js RESOLVES a refused query, so
  // without it an RLS refusal is indistinguishable from "this deal has no
  // milestones" — and the page would quietly render an empty timeline for a deal
  // the caller simply cannot see.
  const { data: transaction, error: txError } = await supabase
    .from("transactions")
    .select("id, listing_id, property_address, status")
    .eq("id", id)
    .eq("brokerage_id", profile.brokerage_id)
    .maybeSingle()

  if (txError) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold">Milestones</h1>
        <p className="mt-2 text-sm text-destructive">
          This deal could not be read: {txError.message}
        </p>
      </div>
    )
  }
  if (!transaction) notFound()

  const { data: milestones, error: msError } = await supabase
    .from("transaction_milestones")
    .select("id, title, milestone_name, milestone_type, target_date, status, description")
    .eq("transaction_id", transaction.id)
    .eq("brokerage_id", profile.brokerage_id)
    .order("target_date", { ascending: true, nullsFirst: false })
    .limit(100)

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link
          href={`/dashboard/transactions/${id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Back to the deal
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Milestones</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {(transaction.property_address as string | null) ?? "This transaction"}
        </p>
      </div>

      {/* A milestone hangs off the LISTING in the action's signature. Without one
          there is nothing to resolve a transaction from, so say that plainly rather
          than render a form whose every submission would be refused. */}
      {transaction.listing_id ? (
        <AddMilestoneForm listingId={transaction.listing_id as string} />
      ) : (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          This deal is not attached to a listing, and a hand-added milestone is
          resolved through one. Attach the listing first.
        </div>
      )}

      <div>
        <h2 className="text-base font-medium">On this deal</h2>
        {msError ? (
          <p className="mt-2 text-sm text-destructive">
            The existing milestones could not be read: {msError.message}
          </p>
        ) : (milestones ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No milestones yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {(milestones ?? []).map((m) => (
              <li key={m.id as string} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">
                    {(m.title as string | null) || (m.milestone_name as string | null) || "Milestone"}
                  </span>
                  <span className="text-muted-foreground">
                    {m.target_date ? new Date(m.target_date as string).toLocaleDateString() : "no date"}
                    {" · "}
                    {(m.status as string | null) ?? "pending"}
                  </span>
                </div>
                {m.description ? (
                  <p className="mt-1 text-muted-foreground">{m.description as string}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
