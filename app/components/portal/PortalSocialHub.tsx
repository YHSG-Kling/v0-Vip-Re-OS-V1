"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Share2,
  Facebook,
  Instagram,
  Linkedin,
  Twitter,
  Eye,
  Heart,
  MessageCircle,
  Repeat2,
  Download,
  Copy,
  Check,
  Calendar,
  Users,
} from "lucide-react"
import { toast } from "sonner"

interface PortalSocialHubProps {
  contact: any
  contactId: string
  listing: any
  socialPosts: any[]
}

const platformIcons: Record<string, any> = {
  facebook: Facebook,
  instagram: Instagram,
  linkedin: Linkedin,
  twitter: Twitter,
}

const platformColors: Record<string, string> = {
  facebook: "bg-blue-600",
  instagram: "bg-gradient-to-r from-purple-500 to-pink-500",
  linkedin: "bg-blue-700",
  twitter: "bg-sky-500",
}

export default function PortalSocialHub({ contact, contactId, listing, socialPosts }: PortalSocialHubProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const publishedPosts = socialPosts.filter((p) => p.status === "published")
  const scheduledPosts = socialPosts.filter((p) => p.status === "scheduled")

  // Calculate total engagement
  const totalEngagement = publishedPosts.reduce(
    (acc, post) => {
      const analytics = post.social_post_analytics?.[0] || {}
      return {
        impressions: acc.impressions + (analytics.impressions || 0),
        likes: acc.likes + (analytics.likes || 0),
        comments: acc.comments + (analytics.comments || 0),
        shares: acc.shares + (analytics.shares || 0),
      }
    },
    { impressions: 0, likes: 0, comments: 0, shares: 0 },
  )

  const handleCopyContent = (post: any) => {
    navigator.clipboard.writeText(post.content + "\n\n" + (post.hashtags?.map((h: string) => `#${h}`).join(" ") || ""))
    setCopiedId(post.id)
    toast.success("Post content copied! Paste it into your social media.")
    setTimeout(() => setCopiedId(null), 3000)
  }

  const handleShareToSocial = (platform: string, post: any) => {
    const listingUrl = `${window.location.origin}/properties/${listing.mls_number || listing.id}`
    const text = encodeURIComponent(post.content)

    const shareUrls: Record<string, string> = {
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(listingUrl)}&quote=${text}`,
      twitter: `https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(listingUrl)}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(listingUrl)}`,
    }

    if (shareUrls[platform]) {
      window.open(shareUrls[platform], "_blank", "width=600,height=400")
    }
  }

  const handleDownloadImage = (url: string) => {
    const a = document.createElement("a")
    a.href = url
    a.download = `listing-${listing.mls_number || listing.id}-image.jpg`
    a.click()
    toast.success("Image downloaded!")
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Share2 className="w-6 h-6" />
          Social Media Hub
        </h1>
        <p className="text-muted-foreground">
          View, share, and track social media posts about your listing at {listing.address || listing.property_address}
        </p>
      </div>

      {/* Engagement Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">{totalEngagement.impressions.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground">Impressions</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Heart className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-2xl font-bold">{totalEngagement.likes.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground">Likes</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-green-500" />
              <div>
                <p className="text-2xl font-bold">{totalEngagement.comments.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground">Comments</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2">
              <Repeat2 className="w-5 h-5 text-purple-500" />
              <div>
                <p className="text-2xl font-bold">{totalEngagement.shares.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground">Shares</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Help Your Agent Card */}
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Help Spread the Word!
          </CardTitle>
          <CardDescription>
            Your personal network is powerful! Share these posts on your own social media to reach potential buyers your
            agent might not know.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const url = `${window.location.origin}/properties/${listing.mls_number || listing.id}`
                navigator.clipboard.writeText(url)
                toast.success("Listing link copied!")
              }}
            >
              <Copy className="w-4 h-4 mr-2" />
              Copy Listing Link
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                window.open(
                  `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.origin + "/properties/" + (listing.mls_number || listing.id))}`,
                  "_blank",
                )
              }
            >
              <Facebook className="w-4 h-4 mr-2" />
              Share on Facebook
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                window.open(
                  `https://twitter.com/intent/tweet?url=${encodeURIComponent(window.location.origin + "/properties/" + (listing.mls_number || listing.id))}&text=${encodeURIComponent(`Check out this property: ${listing.address || "Beautiful home for sale!"}`)}`,
                  "_blank",
                )
              }
            >
              <Twitter className="w-4 h-4 mr-2" />
              Share on Twitter
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Posts Tabs */}
      <Tabs defaultValue="published" className="space-y-4">
        <TabsList>
          <TabsTrigger value="published">Published ({publishedPosts.length})</TabsTrigger>
          <TabsTrigger value="scheduled">Coming Soon ({scheduledPosts.length})</TabsTrigger>
          <TabsTrigger value="content">Ready to Share</TabsTrigger>
        </TabsList>

        {/* Published Posts */}
        <TabsContent value="published" className="space-y-4">
          {publishedPosts.length > 0 ? (
            publishedPosts.map((post) => {
              const analytics = post.social_post_analytics?.[0] || {}
              return (
                <Card key={post.id}>
                  <CardContent className="pt-6">
                    <div className="flex gap-4">
                      {/* Media Preview */}
                      {post.media_urls?.[0] && (
                        <div className="w-24 h-24 rounded-lg overflow-hidden bg-slate-100 flex-shrink-0">
                          <img
                            src={post.media_urls[0] || "/placeholder.svg"}
                            alt="Post media"
                            className="w-full h-full object-cover"
                          />
                        </div>
                      )}

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          {post.platforms?.map((platform: string) => {
                            const Icon = platformIcons[platform] || Share2
                            return (
                              <Badge key={platform} variant="outline" className="gap-1">
                                <Icon className="w-3 h-3" />
                                {platform}
                              </Badge>
                            )
                          })}
                          <span className="text-xs text-muted-foreground ml-auto">
                            {new Date(post.published_at || post.scheduled_for).toLocaleDateString()}
                          </span>
                        </div>

                        <p className="text-sm line-clamp-3 mb-2">{post.content}</p>

                        {post.hashtags?.length > 0 && (
                          <p className="text-xs text-blue-600 mb-3">
                            {post.hashtags.map((h: string) => `#${h}`).join(" ")}
                          </p>
                        )}

                        {/* Engagement */}
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Eye className="w-4 h-4" /> {analytics.impressions || 0}
                          </span>
                          <span className="flex items-center gap-1">
                            <Heart className="w-4 h-4" /> {analytics.likes || 0}
                          </span>
                          <span className="flex items-center gap-1">
                            <MessageCircle className="w-4 h-4" /> {analytics.comments || 0}
                          </span>
                          <span className="flex items-center gap-1">
                            <Repeat2 className="w-4 h-4" /> {analytics.shares || 0}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-2">
                        <Button size="sm" variant="outline" onClick={() => handleCopyContent(post)}>
                          {copiedId === post.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleShareToSocial("facebook", post)}>
                          <Facebook className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => handleShareToSocial("twitter", post)}>
                          <Twitter className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <Share2 className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="font-medium mb-1">No Published Posts Yet</h3>
                <p className="text-sm text-muted-foreground">
                  Your agent will create social media posts to market your listing. Check back soon!
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Scheduled Posts */}
        <TabsContent value="scheduled" className="space-y-4">
          {scheduledPosts.length > 0 ? (
            scheduledPosts.map((post) => (
              <Card key={post.id}>
                <CardContent className="pt-6">
                  <div className="flex gap-4">
                    {post.media_urls?.[0] && (
                      <div className="w-24 h-24 rounded-lg overflow-hidden bg-slate-100 flex-shrink-0">
                        <img
                          src={post.media_urls[0] || "/placeholder.svg"}
                          alt="Post media"
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}

                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="secondary">
                          <Calendar className="w-3 h-3 mr-1" />
                          Scheduled
                        </Badge>
                        {post.platforms?.map((platform: string) => {
                          const Icon = platformIcons[platform] || Share2
                          return (
                            <Badge key={platform} variant="outline" className="gap-1">
                              <Icon className="w-3 h-3" />
                            </Badge>
                          )
                        })}
                      </div>

                      <p className="text-sm line-clamp-2 mb-2">{post.content}</p>

                      <p className="text-xs text-muted-foreground">
                        Scheduled for: {new Date(post.scheduled_for).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <Calendar className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="font-medium mb-1">No Scheduled Posts</h3>
                <p className="text-sm text-muted-foreground">
                  Your agent is working on upcoming content for your listing.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Ready to Share Content */}
        <TabsContent value="content" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Share-Ready Content</CardTitle>
              <CardDescription>
                Copy these captions and use them when sharing your listing on your personal social media
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Pre-written captions built from the seller's real listing data.
                  Facts we don't have (price, bed/bath) are omitted rather than
                  invented — never fabricate listing details. */}
              {(() => {
                const addr = listing.address || listing.property_address || ""
                const beds = listing.bedrooms ?? null
                const baths = listing.bathrooms ?? null
                const price = listing.price ?? listing.list_price ?? null
                const specs = [
                  beds != null ? `${beds} bed${beds === 1 ? "" : "s"}` : null,
                  baths != null ? `${baths} bath${baths === 1 ? "" : "s"}` : null,
                ].filter(Boolean).join(", ")
                const bedBath = [
                  beds != null ? `${beds}BR` : null,
                  baths != null ? `${baths}BA` : null,
                ].filter(Boolean).join("/")
                const at = addr ? ` at ${addr}` : ""
                const feature = listing.property_type === "condo"
                  ? "stunning views — perfect for morning coffee with a view"
                  : "beautiful outdoor space — perfect for gatherings"
                const templates = [
                  {
                    title: "Announcement Post",
                    content: `Big news! Our home${at} is now on the market!${specs ? ` ${specs}.` : ""} Know anyone looking? Send them our way! 🏡`,
                    hashtags: ["justlisted", "homeforsale", "realestate", "dreamhome"],
                  },
                  {
                    title: "Feature Highlight",
                    content: `One of our favorite things about ${addr || "our home"} is the ${feature}! ☀️`,
                    hashtags: ["homefeatures", "realestate", "homeforsale"],
                  },
                  {
                    title: "Open House Invite",
                    content: `You're invited! Come see our home${at} this weekend. We'd love for our friends and family to spread the word! 🏠✨`,
                    hashtags: ["openhouse", "homeforsale", "realestate"],
                  },
                  ...(price != null ? [{
                    title: "Price Mention",
                    content: `Looking for a great home at $${price.toLocaleString()}?${bedBath ? ` Our ${bedBath}${at}` : at ? ` Our home${at}` : ""} might be perfect! Share with anyone house hunting! 🏡💕`,
                    hashtags: ["realestate", "homeforsale", "pricedjustright"],
                  }] : []),
                ]
                return templates
              })().map((template, idx) => (
                <div key={idx} className="p-4 border rounded-lg">
                  <div className="flex justify-between items-start mb-2">
                    <h4 className="font-medium">{template.title}</h4>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(
                          template.content + "\n\n" + template.hashtags.map((h) => `#${h}`).join(" "),
                        )
                        toast.success("Caption copied!")
                      }}
                    >
                      <Copy className="w-4 h-4 mr-1" />
                      Copy
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">{template.content}</p>
                  <p className="text-xs text-blue-600">{template.hashtags.map((h) => `#${h}`).join(" ")}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Downloadable Images */}
          {listing.photos?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Listing Photos</CardTitle>
                <CardDescription>Download these to share on your social media</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {listing.photos.slice(0, 8).map((photo: string, idx: number) => (
                    <div key={idx} className="relative group">
                      <img
                        src={photo || "/placeholder.svg"}
                        alt={`Listing photo ${idx + 1}`}
                        className="w-full h-24 object-cover rounded-lg"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleDownloadImage(photo)}
                      >
                        <Download className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
