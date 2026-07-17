"use client"

import { toast } from "sonner"
import { Copy, Mail } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export interface NewsletterTeaser {
  id: string
  content: string
  source_type: string
  source_id: string | null
  status: string
  created_at: string | null
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-blue-100 text-blue-800",
  queued: "bg-amber-100 text-amber-800",
  sent: "bg-green-100 text-green-800",
  archived: "bg-gray-100 text-gray-600",
}

/**
 * Newsletter teasers repurposed from podcast episodes (newsletter_teasers —
 * written by generatePodcastNewsletterTeaser). Paste-ready paragraphs for the
 * next newsletter send.
 */
export function NewsletterTeasersCard({ teasers }: { teasers: NewsletterTeaser[] }) {
  if (teasers.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Newsletter Teasers
        </CardTitle>
        <CardDescription>
          AI-drafted newsletter paragraphs repurposed from your content — copy into your next send
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {teasers.map((teaser) => (
          <div key={teaser.id} className="p-3 rounded-md border space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge className={STATUS_STYLES[teaser.status] ?? "bg-gray-100 text-gray-600"}>
                  {teaser.status}
                </Badge>
                <Badge variant="outline" className="text-xs capitalize">
                  {teaser.source_type.replace(/_/g, " ")}
                </Badge>
                {teaser.created_at && (
                  <span className="text-xs text-muted-foreground">
                    {new Date(teaser.created_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs shrink-0"
                onClick={() => {
                  navigator.clipboard.writeText(teaser.content)
                  toast.success("Teaser copied!")
                }}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
            </div>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{teaser.content}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
