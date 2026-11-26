/**
 * RoleGateNotice — the honest in-place answer to "this seat may not open this
 * surface", for a page a role's NAVIGATION links to.
 *
 * Lane 89D (wave 89 production walkthrough). The pattern is the one the
 * walkthrough already ruled for /dashboard/settings/usage: a nav entry that
 * lands on `redirect("/dashboard")` is "a click that appeared to do nothing"
 * (app/dashboard/settings/usage/page.tsx:31-53). Bouncing without saying why
 * was the defect there; this component is that page's notice generalised so
 * the next surface does not inline a fifth copy of the same three sentences.
 *
 * Server-safe (no hooks) — a server page returns it in place of the redirect.
 * It never widens access: the page's gate decides, this only says so.
 */
import Link from "next/link"

export function RoleGateNotice({
  surface,
  audience,
  fallbackHref = "/dashboard",
  fallbackLabel = "dashboard",
}: {
  /** What the page is, in the user's words ("the Intelligence Center"). */
  surface: string
  /** Who the surface is for ("your broker, brokerage admins and compliance officer"). */
  audience: string
  fallbackHref?: string
  fallbackLabel?: string
}) {
  return (
    <div className="p-6 max-w-lg space-y-2">
      <p className="text-sm font-medium">{surface} is a brokerage-level surface</p>
      <p className="text-sm text-muted-foreground">
        It is visible to {audience}. Your own work is on your{" "}
        <Link href={fallbackHref} className="text-blue-600 hover:underline">
          {fallbackLabel}
        </Link>
        .
      </p>
    </div>
  )
}
