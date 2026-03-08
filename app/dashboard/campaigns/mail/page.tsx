import { Suspense } from "react"
import { MailDashboard } from "./mail-dashboard"

export const metadata = {
  title: "Direct Mail | VIP Agents AI",
  description: "Manage direct mail campaigns, recipients, tracking, and responses",
}

export default function DirectMailPage() {
  return (
    <div className="flex flex-col h-full">
      <Suspense fallback={<MailLoadingSkeleton />}>
        <MailDashboard />
      </Suspense>
    </div>
  )
}

function MailLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-10 w-32 bg-muted rounded animate-pulse" />
      </div>
      <div className="h-10 w-full max-w-md bg-muted rounded animate-pulse" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-48 bg-muted rounded-xl animate-pulse" />
        ))}
      </div>
    </div>
  )
}
