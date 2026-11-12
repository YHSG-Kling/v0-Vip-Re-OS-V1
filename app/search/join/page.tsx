/**
 * app/search/join/page.tsx
 *
 * THE COLLABORATOR'S VIEW (C28 — wave 149, lane 149B, owner ruling 6): "the buyer shares the homes they were searching
 * and brings in a family member to give their opinion on the selected properties."
 *
 * WHAT STOOD HERE: the invitation's landing page accepted a PLAINTEXT token and then sent the family member to the
 * homepage — they were "in" a search they could not see, so no opinion could ever be given (all five family-search
 * tables held zero rows, live 2026-11-03).
 *
 * NOW: the token is the credential (an invitee has no account on this tenant). The server action hash-matches it,
 * checks scope feedback_only, expiry and revocation, and returns ONLY the shared homes' public listing facts and this
 * person's own opinions — never the buyer's criteria, CRM fields, documents, messages, other members or any other portal
 * data. No tenant, contact or user id is read from the URL.
 */

import { acceptInvitation } from "@/app/actions/collaborative-search"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FamilyOpinionForm } from "./family-opinion-form"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Homes shared with you",
  description: "Give your opinion on the homes someone close to you is considering.",
  robots: { index: false, follow: false },
}

export default async function JoinCollaborativeSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  if (!token) {
    return (
      <Shell title="This link is incomplete">
        <p className="text-sm text-muted-foreground">
          The link is missing part of its address. Open it straight from the message you were sent, or ask the person who
          shared these homes to send it again.
        </p>
      </Shell>
    )
  }

  const result = await acceptInvitation(token)
  if (!result.ok) {
    return (
      <Shell title="We couldn't open these homes">
        <p className="text-sm text-muted-foreground">{result.error}</p>
      </Shell>
    )
  }

  const { view } = result
  const who = view.buyerFirstName ?? "Someone close to you"
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{who} would love your opinion</h1>
        <p className="text-sm text-muted-foreground">
          {view.collaboratorName ? `Hi ${view.collaboratorName} — ` : ""}these are the homes {who} is considering. Tell them how
          each one feels to you. Only {who} sees what you say{view.homes.length ? "" : " — there are no homes on the list right now"}.
        </p>
      </header>
      {view.homes.map((h) => (
        <Card key={h.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{h.facts.address ?? "A shared home"}</CardTitle>
            <CardDescription>
              {[h.facts.city, h.facts.state].filter(Boolean).join(", ")}
              {h.facts.price != null ? ` · $${h.facts.price.toLocaleString("en-US")}` : ""}
              {h.facts.beds != null ? ` · ${h.facts.beds} bd` : ""}
              {h.facts.baths != null ? ` · ${h.facts.baths} ba` : ""}
              {h.facts.sqft != null ? ` · ${h.facts.sqft.toLocaleString("en-US")} sq ft` : ""}
            </CardDescription>
            {/* Wave 150 (150W): where the home came from (the MLS a listing names, or the site a link came from). */}
            {h.facts.source_line && <p className="text-xs text-muted-foreground">{h.facts.source_line}</p>}
          </CardHeader>
          <CardContent className="space-y-3">
            {h.facts.photo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={h.facts.photo} alt={`Photo of ${h.facts.address ?? "the home"}`} className="h-48 w-full rounded-md object-cover" />
            )}
            <FamilyOpinionForm token={token} sharedHomeId={h.id} initialVote={h.myVote} initialComment={h.myComment} />
          </CardContent>
        </Card>
      ))}
      <p className="text-xs text-muted-foreground">
        This link only shows the homes that were shared with you. It doesn't sign you up for anything, and {who} can close it
        at any time.
      </p>
    </div>
  )
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>Homes shared with you</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}
