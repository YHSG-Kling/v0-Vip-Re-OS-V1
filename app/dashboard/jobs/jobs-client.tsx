"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Play } from "lucide-react"
import { runJobAction } from "@/app/actions/jobs"
import type { JobKey, JobSpec } from "@/lib/kernel/jobs"
import type { SphereAction } from "@/lib/sphere/next-best-actions"

export function JobsClient({
  catalog,
  listings,
  sphereActions,
}: {
  catalog: JobSpec[]
  listings: Array<{ id: string; label: string }>
  sphereActions: SphereAction[]
}) {
  const [listingId, setListingId] = useState<string>(listings[0]?.id ?? "")
  const [runningJob, setRunningJob] = useState<JobKey | null>(null)
  const [results, setResults] = useState<Partial<Record<JobKey, { ok: boolean; lines: string[] }>>>({})
  const [, startTransition] = useTransition()

  const run = (job: JobKey, needsListing: boolean) => {
    setRunningJob(job)
    startTransition(async () => {
      try {
        const r = await runJobAction({ job, listingId: needsListing ? listingId : null })
        setResults((prev) => ({ ...prev, [job]: { ok: r.ok, lines: r.ok ? r.results : [r.error ?? "Job failed"] } }))
      } finally {
        setRunningJob(null)
      }
    })
  }

  return (
    <div className="mt-6 grid gap-6 md:grid-cols-3">
      {catalog.map((job) => {
        const result = results[job.key]
        return (
          <Card key={job.key} className="flex flex-col">
            <CardHeader>
              <CardTitle className="text-base">{job.title}</CardTitle>
              <p className="text-xs text-muted-foreground">{job.team}</p>
            </CardHeader>
            <CardContent className="flex flex-col flex-1 gap-4">
              <p className="text-sm text-muted-foreground flex-1">{job.description}</p>
              {job.key === "sphere_pass" && sphereActions.length > 0 && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="text-xs font-semibold mb-2">Who to work today (and why)</div>
                  <ul className="space-y-2">
                    {sphereActions.map((a) => (
                      <li key={a.contactId} className="text-xs">
                        <span className="font-medium">{a.name}</span>
                        <span className="text-muted-foreground"> — {a.why}</span>
                        <div className="text-muted-foreground/80 italic">{a.action}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {job.needsListing && (
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={listingId}
                  onChange={(e) => setListingId(e.target.value)}
                  aria-label="Pick a listing"
                >
                  {listings.length === 0 && <option value="">No active listings</option>}
                  {listings.map((l) => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
              )}
              <Button
                onClick={() => run(job.key, job.needsListing)}
                disabled={runningJob !== null || (job.needsListing && !listingId)}
                className="w-full"
              >
                {runningJob === job.key ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> The team is working…</>
                ) : (
                  <><Play className="h-4 w-4 mr-2" /> Run it</>
                )}
              </Button>
              {result && (
                <ul className={`text-xs space-y-1 rounded-md border p-3 ${result.ok ? "bg-muted/40" : "bg-destructive/10 border-destructive/30"}`}>
                  {result.lines.map((line, i) => (
                    <li key={i}>· {line}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
