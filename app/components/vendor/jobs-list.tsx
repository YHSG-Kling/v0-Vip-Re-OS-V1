"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar, MapPin, Briefcase, Clock } from "lucide-react"

interface VendorJobsListProps {
  jobs: any[]
  vendorId: string
  selectedJobId?: string
}

export function VendorJobsList({ jobs, vendorId, selectedJobId }: VendorJobsListProps) {
  const groupedByTransaction: Record<string, any[]> = {}

  // Group jobs by transaction address
  jobs.forEach((job: any) => {
    const address = job.vendor_assignments?.transactions?.property_address || "Unknown"
    if (!groupedByTransaction[address]) {
      groupedByTransaction[address] = []
    }
    groupedByTransaction[address].push(job)
  })

  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <Briefcase className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">No jobs assigned yet</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {Object.entries(groupedByTransaction).map(([address, transactionJobs]) => (
        <Card key={address}>
          <CardHeader className="pb-3">
            <div className="flex items-start gap-2">
              <MapPin className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <CardTitle className="text-lg">{address}</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {transactionJobs.map((job: any) => (
              <Link
                key={job.id}
                href={`/portal/vendor?vendorId=${vendorId}&jobId=${job.id}`}
              >
                <div
                  className={`p-3 rounded-lg border-2 transition-colors cursor-pointer ${
                    selectedJobId === job.id
                      ? "border-blue-500 bg-blue-50"
                      : "border-transparent hover:bg-muted/50 hover:border-muted-foreground/20"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{job.job_title}</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        <Badge variant="secondary" className="text-xs">
                          {job.status}
                        </Badge>
                        {job.vendor_assignments?.scheduled_date && (
                          <Badge variant="outline" className="text-xs">
                            {new Date(job.vendor_assignments.scheduled_date).toLocaleDateString()}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  {job.cost_estimate && (
                    <p className="text-sm text-muted-foreground mt-2">
                      Est: ${job.cost_estimate.toLocaleString()}
                      {job.cost_actual && ` → Actual: $${job.cost_actual.toLocaleString()}`}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
