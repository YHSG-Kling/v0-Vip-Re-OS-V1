"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { MediaGrid } from "./components/media-grid"
import { VideoPanel } from "./components/video-panel"
import { SocialPanel } from "./components/social-panel"
import { ImageIcon, VideoIcon, Share2Icon } from "lucide-react"

interface Listing {
  id: string
  address: string
  lifecycle_stage: string | null
  status: string | null
}

interface MediaManagerClientProps {
  listingId: string
  listing: Listing
  brokerageId: string
  agentId: string
  userRole: string | null
  initialMedia: any[]
  initialVideos: any[]
  initialPosts: any[]
  videoTemplates: any[]
  socialAccounts: any[]
}

export function MediaManagerClient({
  listingId,
  listing,
  brokerageId,
  agentId,
  userRole,
  initialMedia,
  initialVideos,
  initialPosts,
  videoTemplates,
  socialAccounts,
}: MediaManagerClientProps) {
  const [media, setMedia] = useState(initialMedia)
  const [videos, setVideos] = useState(initialVideos)
  const [posts, setPosts] = useState(initialPosts)

  const canApprove = userRole === "admin" || userRole === "broker"

  const pendingMedia  = media.filter(m => m.approval_required && !m.is_approved).length
  const pendingPosts  = posts.filter(p => p.approval_status === "pending").length
  const failedCompliance = media.filter(m => !m.kernel_compliance_passed).length

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto font-sans">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-foreground text-balance">
            Media Manager
          </h1>
          {failedCompliance > 0 && (
            <Badge variant="destructive" className="text-xs">
              {failedCompliance} compliance issue{failedCompliance > 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground text-pretty">{listing.address}</p>
        <div className="flex items-center gap-2 mt-1">
          {listing.lifecycle_stage && (
            <Badge variant="secondary" className="text-xs capitalize">
              {listing.lifecycle_stage.replace(/_/g, " ")}
            </Badge>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="media" className="w-full">
        <TabsList className="w-full max-w-md">
          <TabsTrigger value="media" className="flex items-center gap-2 flex-1">
            <ImageIcon className="w-4 h-4" />
            <span>Photos & Docs</span>
            {pendingMedia > 0 && (
              <Badge variant="destructive" className="text-xs ml-1 px-1.5 py-0">
                {pendingMedia}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="video" className="flex items-center gap-2 flex-1">
            <VideoIcon className="w-4 h-4" />
            <span>AI Video</span>
          </TabsTrigger>
          <TabsTrigger value="social" className="flex items-center gap-2 flex-1">
            <Share2Icon className="w-4 h-4" />
            <span>Social</span>
            {pendingPosts > 0 && (
              <Badge variant="destructive" className="text-xs ml-1 px-1.5 py-0">
                {pendingPosts}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="media" className="mt-6">
          <MediaGrid
            listingId={listingId}
            brokerageId={brokerageId}
            media={media}
            canApprove={canApprove}
            onMediaChange={setMedia}
          />
        </TabsContent>

        <TabsContent value="video" className="mt-6">
          <VideoPanel
            listingId={listingId}
            brokerageId={brokerageId}
            videos={videos}
            templates={videoTemplates}
            onVideosChange={setVideos}
          />
        </TabsContent>

        <TabsContent value="social" className="mt-6">
          <SocialPanel
            listingId={listingId}
            brokerageId={brokerageId}
            agentId={agentId}
            posts={posts}
            accounts={socialAccounts}
            canApprove={canApprove}
            onPostsChange={setPosts}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
