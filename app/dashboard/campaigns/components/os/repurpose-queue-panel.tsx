"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  RefreshCw,
  FileText,
  Video,
  Image,
  Mail,
  MessageSquare,
  ArrowRight,
  Sparkles,
  Scissors,
} from "lucide-react"
import Link from "next/link"

interface ContentAsset {
  id: string
  type: "blog" | "video" | "email" | "social" | "listing" | "snippet"
  title: string
  createdAt: string
  repurposeOptions: string[]
  /** For snippet type: the target platform (e.g., "Instagram Reels") */
  platform?: string
  /** For snippet type: caption preview text */
  caption?: string
}

interface RepurposeQueuePanelProps {
  assets: ContentAsset[]
  onRepurpose?: (assetId: string, targetFormat: string) => void
}

const typeIcons = {
  blog: FileText,
  video: Video,
  email: Mail,
  social: MessageSquare,
  listing: Image,
  snippet: Scissors,
}

const repurposeTargets = {
  blog: ["Social Posts", "Email Newsletter", "Video Script", "LinkedIn Article"],
  video: ["Social Clips", "Blog Post", "Email Snippet", "Quote Graphics"],
  email: ["Blog Post", "Social Thread", "Landing Page"],
  social: ["Blog Post", "Email Content", "Video Script"],
  listing: ["Social Posts", "Email Campaign", "Video Tour", "Print Flyer"],
  snippet: ["Schedule to Omnipresence", "Generate Caption Variants"],
}

export function RepurposeQueuePanel({ assets, onRepurpose }: RepurposeQueuePanelProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Repurpose Queue
            </CardTitle>
            <CardDescription>Turn one piece of content into many</CardDescription>
          </div>
          <Link href="/dashboard/campaigns/repurpose">
            <Button variant="outline" size="sm">
              View All
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {assets.length === 0 ? (
          <div className="text-center py-8">
            <RefreshCw className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground mb-2">No content ready to repurpose</p>
            <p className="text-xs text-muted-foreground">Create blog posts, videos, or emails to get started</p>
          </div>
        ) : (
          <div className="space-y-3">
            {assets.slice(0, 5).map((asset) => {
              const Icon = typeIcons[asset.type]
              const targets = repurposeTargets[asset.type]

              return (
                <div key={asset.id} className="p-3 border rounded-lg space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-primary/10">
                        <Icon className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">{asset.title}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <p className="text-xs text-muted-foreground capitalize">{asset.type}</p>
                          {asset.type === "snippet" && asset.platform && (
                            <Badge variant="secondary" className="text-[10px] py-0 h-4">
                              {asset.platform}
                            </Badge>
                          )}
                        </div>
                        {asset.type === "snippet" && asset.caption && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1 max-w-[200px] italic">
                            "{asset.caption}"
                          </p>
                        )}
                      </div>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {targets.length} options
                    </Badge>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {targets.slice(0, 3).map((target) => (
                      <Button
                        key={target}
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => onRepurpose?.(asset.id, target)}
                      >
                        <Sparkles className="h-3 w-3" />
                        {target}
                      </Button>
                    ))}
                    {targets.length > 3 && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs">
                        +{targets.length - 3} more
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {assets.length > 5 && (
          <Link href="/dashboard/campaigns/repurpose">
            <Button variant="ghost" className="w-full gap-2">
              View {assets.length - 5} more assets
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        )}

        {/* AI Repurpose Suggestion */}
        <div className="p-4 border rounded-lg bg-gradient-to-r from-primary/5 to-primary/10">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-full bg-primary/10">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="font-medium text-sm">AI Content Multiplier</p>
              <p className="text-xs text-muted-foreground">
                Automatically create 5+ pieces of content from one asset
              </p>
            </div>
            <Link href="/dashboard/campaigns/repurpose">
              <Button size="sm">Try Now</Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
