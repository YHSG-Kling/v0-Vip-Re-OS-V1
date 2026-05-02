"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { Badge } from "@/app/components/ui/badge"
import { Scissors, FileText, Mail, ExternalLink } from "lucide-react"

interface Episode {
  id: string
  title: string
  status: string
  category?: string
  duration_seconds?: number | null
}

interface Props {
  episodes: Episode[]
}

export function RepurposeTab({ episodes }: Props) {
  const publishedEpisodes = episodes.filter((e) => e.status === "published" || e.status === "completed")

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Turn this episode into more content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-gray-600">
          <p>
            Each published episode can become short-form clips for social, a blog post from the transcript,
            and a teaser paragraph for your next newsletter — without re-recording.
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
            <li className="flex items-start gap-2 p-3 rounded-lg border bg-white">
              <Scissors className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-gray-900">Social clips</p>
                <p className="text-xs text-gray-500">Short, captioned highlights for Reels / Shorts / TikTok.</p>
              </div>
            </li>
            <li className="flex items-start gap-2 p-3 rounded-lg border bg-white">
              <FileText className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-gray-900">Blog post</p>
                <p className="text-xs text-gray-500">Long-form post built from the episode transcript.</p>
              </div>
            </li>
            <li className="flex items-start gap-2 p-3 rounded-lg border bg-white">
              <Mail className="h-4 w-4 text-primary shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-gray-900">Newsletter teaser</p>
                <p className="text-xs text-gray-500">One-paragraph promo to drop into your next send.</p>
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Published episodes</CardTitle>
        </CardHeader>
        <CardContent>
          {publishedEpisodes.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No published episodes yet. Publish an episode and it will appear here, ready to repurpose.
            </p>
          ) : (
            <ul className="divide-y">
              {publishedEpisodes.map((ep) => (
                <li key={ep.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{ep.title}</p>
                    {ep.category && (
                      <Badge variant="secondary" className="mt-1 text-xs">
                        {ep.category}
                      </Badge>
                    )}
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/dashboard/campaigns/repurpose?source=podcast&episodeId=${ep.id}`}>
                      Repurpose
                      <ExternalLink className="h-3 w-3 ml-1" />
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
