"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { CheckCircle2, Circle, AlertCircle, Rocket } from "lucide-react"

interface ReadinessItem {
  id: string
  label: string
  status: "complete" | "incomplete" | "warning"
  href?: string
  note?: string
}

interface ListingLaunchReadinessProps {
  listingId: string
  items: ReadinessItem[]
}

export function ListingLaunchReadiness({ listingId, items }: ListingLaunchReadinessProps) {
  const complete = items.filter(i => i.status === "complete").length
  const total = items.length
  const percentage = total > 0 ? Math.round((complete / total) * 100) : 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-indigo-600" />
            Launch Readiness
          </span>
          <Badge variant={percentage === 100 ? "default" : "secondary"} className="text-xs">
            {complete}/{total} ready
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={percentage} className="h-2" />
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-2">
              {item.status === "complete" && (
                <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
              )}
              {item.status === "incomplete" && (
                <Circle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              )}
              {item.status === "warning" && (
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                {item.href ? (
                  <Link href={item.href} className="text-xs hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span className="text-xs">{item.label}</span>
                )}
                {item.note && (
                  <p className="text-xs text-muted-foreground">{item.note}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
