import { redirect } from "next/navigation"
import Link from "next/link"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { accessSharedDocument } from "@/app/actions/dotloop-integration"
import { SharedDocumentView } from "./shared-document-view"

export const dynamic = "force-dynamic"
export const metadata = { title: "Shared Document" }

/**
 * /documents/shared/[token] — THE ROUTE THAT NEVER EXISTED.
 *
 * `createDocumentShareLink` has always minted URLs at this path while
 * app/documents/ contained nothing but a redirect stub, so every share link the
 * product ever produced 404'd. This is the surface those tokens were written for.
 *
 * It is deliberately an AUTHENTICATED, BROKERAGE-SCOPED page, per the owner's
 * ruling that "the share document is so the whole team has access". The token
 * identifies WHICH document; the session identifies WHO is asking, and
 * accessSharedDocument refuses anyone outside the document's brokerage. It is
 * not a public bearer link, and nothing on this page renders before that check
 * has passed.
 *
 * NOTE ON COUNTING: each load of this page is one "open" against the link's
 * max_access_count. That is the intended meaning of the cap — a page view is an
 * access — and it is consumed atomically inside the action, not here.
 */
export default async function SharedDocumentPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // Session first. An unauthenticated visitor is bounced to sign-in and is never
  // told whether the token is real.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) {
    redirect("/login")
  }

  const result = await accessSharedDocument(token)

  if (result.passwordRequired) {
    return <SharedDocumentView token={token} initial={result} />
  }

  if (!result.success) {
    return (
      <div className="max-w-xl mx-auto p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <h1 className="text-lg font-semibold text-red-900">Document unavailable</h1>
          <p className="mt-2 text-sm text-red-800">{result.error}</p>
          <p className="mt-4 text-xs text-red-700">
            Shared documents are limited to the brokerage that owns them. If you believe you should
            have access, ask the person who shared it to send a new link to your team account.
          </p>
          <Link
            href="/dashboard/documents"
            className="mt-4 inline-block text-sm text-red-900 underline"
          >
            Back to Document Center
          </Link>
        </div>
      </div>
    )
  }

  return <SharedDocumentView token={token} initial={result} />
}
