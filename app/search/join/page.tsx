/**
 * app/search/join/page.tsx
 *
 * The landing page for a collaborative-search invitation.
 *
 * WHY THIS EXISTS: sendCollaborativeSearchInvite (lib/services/communication.service.tsx)
 * has always mailed invitees a link to `/search/join?token=…` — and that route did
 * not exist, so every family-search invitation this product ever sent landed on a
 * 404 and `acceptInvitation` had no caller anywhere. This is that caller.
 *
 * AUTH: the invite token IS the credential — an invitee is by definition someone
 * without an account on this brokerage. acceptInvitation only matches a row whose
 * invite_token equals the token AND whose invite_status is still 'pending', so a
 * replayed or bogus token cannot flip anything.
 */

import Link from "next/link"
import { acceptInvitation } from "@/app/actions/collaborative-search"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Join a family home search | VIP Real Estate AI OS",
  description: "Accept your invitation to collaborate on a property search.",
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
          The invitation link is missing its token. Open the link straight from the email you were
          sent, or ask whoever invited you to send it again.
        </p>
      </Shell>
    )
  }

  const result = await acceptInvitation(token)

  if ((result as any).error || !(result as any).data) {
    return (
      <Shell title="We couldn't accept this invitation">
        <p className="text-sm text-muted-foreground">
          {(result as any).error ?? "This invitation could not be accepted."}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Invitations expire, and each one can only be accepted once. If you have already joined,
          use the link in the most recent email. Otherwise ask for a fresh invitation.
        </p>
      </Shell>
    )
  }

  const member = (result as any).data
  const search = member.collaborative_searches

  return (
    <Shell title="You're in">
      <p className="text-sm">
        You&apos;ve joined{" "}
        <span className="font-medium">{search?.name ?? "the family home search"}</span> as{" "}
        <span className="font-medium">{member.role ?? "a member"}</span>.
      </p>
      {search?.description && (
        <p className="mt-2 text-sm text-muted-foreground">{search.description}</p>
      )}
      <p className="mt-4 text-sm text-muted-foreground">
        The person who invited you will see you on the search right away. They can share
        properties with you from their portal, and your votes count toward the family consensus.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm font-medium underline">
        Go to the homepage
      </Link>
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>Family home search</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}
