"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { GraduationCap, ExternalLink, CheckCircle2 } from "lucide-react"
import { launchCeCourse } from "@/app/actions/ce-provider"
import type { CeCenter } from "@/app/actions/ce-provider"

/**
 * In-app CE — accredited courses from the connected provider. The platform is NOT the accreditor; it
 * surfaces the provider's accredited catalog, launches the course, and records the credit the provider
 * reports (into the CE ledger the license-readiness engine reads). Honest empty state when no provider.
 */
export function CeCenterPanel({ center }: { center: CeCenter }) {
  const [busy, setBusy] = useState<string | null>(null)

  async function launch(courseId: string) {
    setBusy(courseId)
    try {
      const res = await launchCeCourse(courseId)
      if ("url" in res && res.url) window.open(res.url, "_blank", "noopener,noreferrer")
    } finally { setBusy(null) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5" /> Complete CE in-app
          <Badge variant="secondary">{center.progress.completed}/{center.progress.required || "—"} hrs</Badge>
        </CardTitle>
        <CardDescription>
          {center.connected
            ? `Accredited courses via ${center.providerName}. Credit is issued by the provider and posts to your CE record automatically.`
            : "No accredited CE provider is connected yet. Ask your broker to connect one — platform lessons are professional development, not CE credit."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {center.progress.required > 0 && (
          <div className="h-2 w-full rounded bg-muted overflow-hidden">
            <div className="h-full bg-green-500" style={{ width: `${center.progress.pct}%` }} />
          </div>
        )}

        {center.connected && center.courses.length > 0 && (
          <div className="grid gap-2 md:grid-cols-2">
            {center.courses.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 p-3 border rounded-lg">
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.title}</div>
                  <div className="text-xs text-muted-foreground capitalize">{c.category.replace("_", " ")} · {c.hours} hr{c.hours === 1 ? "" : "s"}{c.state ? ` · ${c.state}` : ""}</div>
                </div>
                <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => launch(c.id)}>
                  <ExternalLink className="h-4 w-4 mr-1" /> {busy === c.id ? "Opening…" : "Start"}
                </Button>
              </div>
            ))}
          </div>
        )}

        {center.completions.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Completed (accredited)</h4>
            <div className="space-y-1.5">
              {center.completions.slice(0, 8).map((comp, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                  <span className="truncate">{comp.course_name}</span>
                  <span className="text-xs text-muted-foreground">· {comp.hours} hr · {comp.provider}</span>
                  {comp.certificate_url && (
                    <a href={comp.certificate_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline ml-auto">Certificate</a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
