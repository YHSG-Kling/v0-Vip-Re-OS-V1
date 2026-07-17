export const dynamic = "force-dynamic"

import { Suspense } from "react"
import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getErrorMetrics } from "@/app/actions/error-handler"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AlertTriangle, TrendingUp, Clock, CheckCircle } from "lucide-react"
import ErrorHandlerClient from "./error-handler-client"

export const metadata = {
  title: "Error Handler | VIP-OS Admin",
  description: "Monitor and manage system automation errors",
}

async function ErrorMetricsSection() {
  try {
    const metrics = await getErrorMetrics()

    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Critical Errors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{metrics.severityCounts.critical}</p>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-orange-500" />
              Total Errors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{metrics.totalErrors24h}</p>
            <p className="text-xs text-muted-foreground">Last 24 hours</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-blue-500" />
              Retry Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{metrics.retrySuccessRate}%</p>
            <p className="text-xs text-muted-foreground">Success rate</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-500" />
              Top Error Type
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold truncate">
              {metrics.topErrors[0]?.error_type || "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              {metrics.topErrors[0]?.error_count || 0} occurrences
            </p>
          </CardContent>
        </Card>
      </div>
    )
  } catch (error) {
    console.error("Error loading metrics:", error)
    return <div className="text-sm text-muted-foreground">Failed to load metrics</div>
  }
}

export default async function ErrorHandlerPage() {
  const { role } = await getAgentContext()

  // Only admins and compliance officers can access
  if (!["broker", "admin", "superadmin", "compliance_officer"].includes(role)) {
    redirect("/dashboard")
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Error Handler</h1>
          <p className="text-muted-foreground">
            Monitor, debug, and resolve system automation errors
          </p>
        </div>

        {/* Metrics */}
        <div className="mb-8">
          <Suspense
            fallback={
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-24" />
                ))}
              </div>
            }
          >
            <ErrorMetricsSection />
          </Suspense>
        </div>

        {/* Error Groups and Details */}
        <Suspense fallback={<Skeleton className="h-96" />}>
          <ErrorHandlerClient />
        </Suspense>
      </div>
    </main>
  )
}
