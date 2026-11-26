// ROOT not-found — the page every unmatched URL and every `notFound()` call
// lands on.
//
// Lane 89D (wave 89 production walkthrough). Measured on base 1e4fac17: no
// not-found.tsx anywhere in app/, so a mistyped URL, a retired route in a
// bookmark, or a `notFound()` thrown by a listing / contact / portal page all
// rendered Next's unstyled default — outside the brand, with no way back.
// The dangling-link and orphan-route sweeps hold the product's OWN links to 0
// dangling; this covers the links the product cannot see (inbound, bookmarked,
// mistyped). Server component; no data access; never redirects.
import Link from "next/link"
import { SearchX } from "lucide-react"

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <SearchX className="h-10 w-10 text-muted-foreground" />
      <h2 className="text-lg font-semibold">That page isn&rsquo;t here</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        The link may be out of date, or the record it pointed at has moved. Your work is still
        where you left it.
      </p>
      <div className="flex gap-3 text-sm">
        <Link href="/dashboard" className="text-blue-600 hover:underline">
          Back to Dashboard
        </Link>
        <Link href="/login" className="text-blue-600 hover:underline">
          Sign in
        </Link>
      </div>
    </div>
  )
}
