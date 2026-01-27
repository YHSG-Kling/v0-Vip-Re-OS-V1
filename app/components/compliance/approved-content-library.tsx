"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Library, Search, Copy, Eye, CheckCircle, Filter, FileText } from "lucide-react"
import { getApprovedContentLibrary } from "@/app/actions/compliance-monitoring"
import { useToast } from "@/hooks/use-toast"

export default function ApprovedContentLibrary() {
  const [content, setContent] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedContent, setSelectedContent] = useState<any>(null)
  const [filters, setFilters] = useState({
    category: "all_categories",
    channel: "all_channels",
    leadType: "all_lead_types",
  })
  const [searchQuery, setSearchQuery] = useState("")
  const { toast } = useToast()

  useEffect(() => {
    loadContent()
  }, [filters])

  async function loadContent() {
    setLoading(true)
    try {
      const data = await getApprovedContentLibrary({
        category: filters.category === "all_categories" ? undefined : filters.category,
        channel: filters.channel === "all_channels" ? undefined : filters.channel,
        leadType: filters.leadType === "all_lead_types" ? undefined : filters.leadType,
      })
      setContent(data)
    } catch (error) {
      console.error("[v0] Error loading approved content:", error)
    }
    setLoading(false)
  }

  const filteredContent = content.filter((item) => {
    if (!searchQuery) return true
    const searchLower = searchQuery.toLowerCase()
    return (
      item.content_template?.toLowerCase().includes(searchLower) ||
      item.content_category?.toLowerCase().includes(searchLower) ||
      item.content_approvals?.content_title?.toLowerCase().includes(searchLower)
    )
  })

  const handleCopyContent = async (text: string) => {
    await navigator.clipboard.writeText(text)
    toast({
      title: "Copied!",
      description: "Content copied to clipboard",
    })
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Filter className="h-5 w-5" />
            Filter Content
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search content..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            <Select value={filters.category} onValueChange={(v) => setFilters({ ...filters, category: v })}>
              <SelectTrigger>
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_categories">All Categories</SelectItem>
                <SelectItem value="email_template">Email Template</SelectItem>
                <SelectItem value="print_mailer">Print Mailer</SelectItem>
                <SelectItem value="social_post">Social Post</SelectItem>
                <SelectItem value="video_script">Video Script</SelectItem>
                <SelectItem value="listing_description">Listing Description</SelectItem>
                <SelectItem value="them_first_nurture">Them-First Nurture</SelectItem>
                <SelectItem value="market_update">Market Update</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filters.channel} onValueChange={(v) => setFilters({ ...filters, channel: v })}>
              <SelectTrigger>
                <SelectValue placeholder="All Channels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_channels">All Channels</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="print">Print</SelectItem>
                <SelectItem value="sms">SMS</SelectItem>
                <SelectItem value="social">Social</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filters.leadType} onValueChange={(v) => setFilters({ ...filters, leadType: v })}>
              <SelectTrigger>
                <SelectValue placeholder="All Lead Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_lead_types">All Lead Types</SelectItem>
                <SelectItem value="cold_lead">Cold Lead</SelectItem>
                <SelectItem value="warm_lead">Warm Lead</SelectItem>
                <SelectItem value="active_client">Active Client</SelectItem>
                <SelectItem value="past_client">Past Client</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Content Library */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Library className="h-5 w-5" />
            Approved Content Library
          </CardTitle>
          <CardDescription>Pre-approved templates ready for immediate use ({filteredContent.length} items)</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-muted-foreground">Loading content...</p>
            </div>
          ) : filteredContent.length === 0 ? (
            <div className="text-center py-12">
              <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No Content Found</h3>
              <p className="text-muted-foreground">
                {searchQuery || filters.category !== "all_categories" || filters.channel !== "all_channels" || filters.leadType !== "all_lead_types"
                  ? "Try adjusting your filters"
                  : "No approved content templates yet. Submit content for approval to build your library."}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredContent.map((item) => (
                <Card key={item.id} className="overflow-hidden">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <Badge variant="secondary">{item.content_category?.replace(/_/g, " ")}</Badge>
                      <Badge variant="outline" className="text-green-600 border-green-600">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Approved
                      </Badge>
                    </div>

                    {item.content_approvals?.content_title && (
                      <h4 className="font-medium mb-2 line-clamp-1">{item.content_approvals.content_title}</h4>
                    )}

                    <p className="text-sm text-muted-foreground line-clamp-3 mb-3">{item.content_template}</p>

                    <div className="flex flex-wrap gap-1 mb-3">
                      {item.allowed_channels?.map((ch: string) => (
                        <Badge key={ch} variant="outline" className="text-xs">
                          {ch}
                        </Badge>
                      ))}
                    </div>

                    {item.allowed_lead_types && (
                      <div className="flex flex-wrap gap-1 mb-3">
                        {item.allowed_lead_types.map((lt: string) => (
                          <Badge key={lt} variant="secondary" className="text-xs">
                            {lt.replace(/_/g, " ")}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 bg-transparent"
                        onClick={() => setSelectedContent(item)}
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        View
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleCopyContent(item.content_template)}
                      >
                        <Copy className="w-4 h-4 mr-1" />
                        Copy
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content Detail Dialog */}
      <Dialog open={!!selectedContent} onOpenChange={(open) => !open && setSelectedContent(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedContent?.content_approvals?.content_title || "Approved Content"}</DialogTitle>
          </DialogHeader>

          {selectedContent && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Category:</span>
                  <p className="font-medium">{selectedContent.content_category?.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Approved:</span>
                  <p className="font-medium">
                    {selectedContent.content_approvals?.approved_at
                      ? new Date(selectedContent.content_approvals.approved_at).toLocaleDateString()
                      : "N/A"}
                  </p>
                </div>
              </div>

              <div>
                <span className="text-sm text-muted-foreground">Allowed Channels:</span>
                <div className="flex gap-2 mt-1">
                  {selectedContent.allowed_channels?.map((ch: string) => (
                    <Badge key={ch} variant="outline">
                      {ch}
                    </Badge>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-sm text-muted-foreground">Allowed Lead Types:</span>
                <div className="flex gap-2 mt-1">
                  {selectedContent.allowed_lead_types?.map((lt: string) => (
                    <Badge key={lt} variant="secondary">
                      {lt.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-sm text-muted-foreground">Content:</span>
                <div className="mt-1 p-4 bg-muted rounded-lg font-mono text-sm whitespace-pre-wrap">
                  {selectedContent.content_template}
                </div>
              </div>

              {selectedContent.content_approvals?.usage_count !== undefined && (
                <p className="text-sm text-muted-foreground">
                  Used {selectedContent.content_approvals.usage_count} times
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedContent(null)} className="bg-transparent">
              Close
            </Button>
            <Button onClick={() => selectedContent && handleCopyContent(selectedContent.content_template)}>
              <Copy className="w-4 h-4 mr-2" />
              Copy to Clipboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
