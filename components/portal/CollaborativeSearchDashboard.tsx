"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Users,
  Plus,
  Home,
  Heart,
  ThumbsUp,
  ThumbsDown,
  Minus,
  X,
  Star,
  Mail,
  CheckCircle2,
  Clock,
  Trophy,
} from "lucide-react"
import {
  createCollaborativeSearch,
  getCollaborativeSearches,
  inviteFamilyMember,
  rateProperty,
  getSearchProperties,
  getConsensus,
  markAsFinalist,
} from "@/app/actions/collaborative-search"

interface CollaborativeSearchDashboardProps {
  contactId: string
  contactEmail: string
}

export function CollaborativeSearchDashboard({ contactId, contactEmail }: CollaborativeSearchDashboardProps) {
  const [searches, setSearches] = useState<any[]>([])
  const [activeSearch, setActiveSearch] = useState<any>(null)
  const [properties, setProperties] = useState<any[]>([])
  const [consensus, setConsensus] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [newSearchName, setNewSearchName] = useState("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteName, setInviteName] = useState("")
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("viewer")

  useEffect(() => {
    loadSearches()
  }, [contactId])

  useEffect(() => {
    if (activeSearch) {
      loadSearchData()
    }
  }, [activeSearch])

  async function loadSearches() {
    setLoading(true)
    const data = await getCollaborativeSearches(contactId)
    setSearches(data)
    if (data.length > 0 && !activeSearch) {
      setActiveSearch(data[0])
    }
    setLoading(false)
  }

  async function loadSearchData() {
    if (!activeSearch) return
    const [props, cons] = await Promise.all([getSearchProperties(activeSearch.id), getConsensus(activeSearch.id)])
    setProperties(props)
    setConsensus(cons)
  }

  async function handleCreateSearch() {
    if (!newSearchName.trim()) return
    const result = await createCollaborativeSearch(contactId, newSearchName)
    if (result.data) {
      setShowCreateDialog(false)
      setNewSearchName("")
      loadSearches()
    }
  }

  async function handleInvite() {
    if (!inviteEmail.trim() || !activeSearch) return
    const result = await inviteFamilyMember(activeSearch.id, inviteEmail, inviteName, inviteRole)
    if (result.data) {
      setShowInviteDialog(false)
      setInviteEmail("")
      setInviteName("")
      loadSearches()
    }
  }

  async function handleRate(propertyId: string, vote: "love" | "like" | "neutral" | "dislike" | "pass") {
    if (!activeSearch) return
    const ratingMap = { love: 5, like: 4, neutral: 3, dislike: 2, pass: 1 }
    await rateProperty(activeSearch.id, propertyId, contactEmail, ratingMap[vote], vote)
    loadSearchData()
  }

  async function handleToggleFinalist(propertyId: string, currentStatus: boolean) {
    if (!activeSearch) return
    await markAsFinalist(activeSearch.id, propertyId, !currentStatus)
    loadSearchData()
  }

  const voteButtons = [
    { vote: "love" as const, icon: Heart, label: "Love", color: "text-red-500 hover:bg-red-50" },
    { vote: "like" as const, icon: ThumbsUp, label: "Like", color: "text-green-500 hover:bg-green-50" },
    { vote: "neutral" as const, icon: Minus, label: "Neutral", color: "text-gray-500 hover:bg-gray-50" },
    { vote: "dislike" as const, icon: ThumbsDown, label: "Dislike", color: "text-orange-500 hover:bg-orange-50" },
    { vote: "pass" as const, icon: X, label: "Pass", color: "text-red-600 hover:bg-red-50" },
  ]

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </CardContent>
      </Card>
    )
  }

  if (searches.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 space-y-4">
          <Users className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <h3 className="font-semibold text-lg">No Collaborative Searches Yet</h3>
            <p className="text-muted-foreground text-sm mt-1">
              Start a search to collaborate with family members on finding your perfect home
            </p>
          </div>
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Start Family Search
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Collaborative Search</DialogTitle>
                <DialogDescription>
                  Name your search and invite family members to help find your perfect home
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Search Name</Label>
                  <Input
                    placeholder="e.g., Our Dream Home Search"
                    value={newSearchName}
                    onChange={(e) => setNewSearchName(e.target.value)}
                  />
                </div>
                <Button onClick={handleCreateSearch} className="w-full">
                  Create Search
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Search Selector and Actions */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={activeSearch?.id} onValueChange={(id) => setActiveSearch(searches.find((s) => s.id === id))}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select a search" />
            </SelectTrigger>
            <SelectContent>
              {searches.map((search) => (
                <SelectItem key={search.id} value={search.id}>
                  {search.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
            <DialogTrigger asChild>
              <Button variant="outline" size="icon">
                <Plus className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Search</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Search Name</Label>
                  <Input
                    placeholder="e.g., Beach House Hunt"
                    value={newSearchName}
                    onChange={(e) => setNewSearchName(e.target.value)}
                  />
                </div>
                <Button onClick={handleCreateSearch} className="w-full">
                  Create
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
          <DialogTrigger asChild>
            <Button>
              <Mail className="h-4 w-4 mr-2" />
              Invite Family
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite Family Member</DialogTitle>
              <DialogDescription>They'll be able to view properties and add their ratings</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  placeholder="family@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Name</Label>
                <Input placeholder="Their name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as any)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">Viewer - Can rate properties</SelectItem>
                    <SelectItem value="editor">Editor - Can add properties too</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleInvite} className="w-full">
                Send Invitation
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Members */}
      {activeSearch && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="h-5 w-5" />
              Family Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {activeSearch.collaborative_search_members?.map((member: any) => (
                <Badge
                  key={member.id}
                  variant={member.invite_status === "accepted" ? "default" : "secondary"}
                  className="flex items-center gap-1"
                >
                  {member.invite_status === "accepted" ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <Clock className="h-3 w-3" />
                  )}
                  {member.name || member.email}
                  <span className="text-xs opacity-70">({member.role})</span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Content Tabs */}
      <Tabs defaultValue="properties" className="space-y-4">
        <TabsList>
          <TabsTrigger value="properties" className="flex items-center gap-2">
            <Home className="h-4 w-4" />
            Properties ({properties.length})
          </TabsTrigger>
          <TabsTrigger value="consensus" className="flex items-center gap-2">
            <Trophy className="h-4 w-4" />
            Top Picks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="properties" className="space-y-4">
          {properties.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Home className="h-12 w-12 text-muted-foreground mb-4" />
                <p className="text-muted-foreground">No properties added yet</p>
                <p className="text-sm text-muted-foreground">Browse properties and add them to this search</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {properties.map((prop) => {
                const propertyData = prop.property_data || {}
                const myRating = prop.property_family_ratings?.find((r: any) => r.member_email === contactEmail)
                const consensusData = consensus.find((c) => c.property_id === prop.property_id)

                return (
                  <Card key={prop.id} className={consensusData?.is_finalist ? "ring-2 ring-amber-400" : ""}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-lg">{propertyData.address || "Property"}</CardTitle>
                          <CardDescription>
                            {propertyData.bedrooms} bed | {propertyData.bathrooms} bath |{" "}
                            {propertyData.sqft?.toLocaleString()} sqft
                          </CardDescription>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-lg">${propertyData.price?.toLocaleString() || "N/A"}</p>
                          {consensusData?.is_finalist && (
                            <Badge className="bg-amber-100 text-amber-800">
                              <Trophy className="h-3 w-3 mr-1" />
                              Finalist
                            </Badge>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Consensus Stats */}
                      {consensusData && consensusData.total_votes > 0 && (
                        <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                          <div className="flex items-center gap-4 text-sm">
                            <span className="flex items-center gap-1">
                              <Heart className="h-4 w-4 text-red-500" />
                              {consensusData.love_count}
                            </span>
                            <span className="flex items-center gap-1">
                              <ThumbsUp className="h-4 w-4 text-green-500" />
                              {consensusData.like_count}
                            </span>
                            <span className="flex items-center gap-1">
                              <ThumbsDown className="h-4 w-4 text-orange-500" />
                              {consensusData.dislike_count}
                            </span>
                          </div>
                          <Badge
                            variant={
                              consensusData.consensus_status === "consensus_yes"
                                ? "default"
                                : consensusData.consensus_status === "consensus_no"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {consensusData.consensus_status === "consensus_yes"
                              ? "Family Approved!"
                              : consensusData.consensus_status === "consensus_no"
                                ? "Not a Match"
                                : "Mixed Opinions"}
                          </Badge>
                        </div>
                      )}

                      {/* Vote Buttons */}
                      <div className="space-y-2">
                        <Label className="text-sm">Your Vote:</Label>
                        <div className="flex flex-wrap gap-2">
                          {voteButtons.map(({ vote, icon: Icon, label, color }) => (
                            <Button
                              key={vote}
                              variant={myRating?.vote === vote ? "default" : "outline"}
                              size="sm"
                              className={myRating?.vote === vote ? "" : color}
                              onClick={() => handleRate(prop.property_id, vote)}
                            >
                              <Icon className="h-4 w-4 mr-1" />
                              {label}
                            </Button>
                          ))}
                        </div>
                      </div>

                      {/* Mark as Finalist */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full bg-transparent"
                        onClick={() => handleToggleFinalist(prop.property_id, consensusData?.is_finalist || false)}
                      >
                        <Trophy className="h-4 w-4 mr-2" />
                        {consensusData?.is_finalist ? "Remove from Finalists" : "Mark as Finalist"}
                      </Button>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="consensus" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Trophy className="h-5 w-5 text-amber-500" />
                Family Top Picks
              </CardTitle>
              <CardDescription>Properties with the highest family approval</CardDescription>
            </CardHeader>
            <CardContent>
              {consensus.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No ratings yet. Start voting on properties to see consensus!
                </p>
              ) : (
                <div className="space-y-4">
                  {consensus
                    .filter((c) => c.total_votes > 0)
                    .sort((a, b) => (b.avg_rating || 0) - (a.avg_rating || 0))
                    .slice(0, 5)
                    .map((item, idx) => {
                      const propertyData = item.collaborative_search_properties?.[0]?.property_data || {}
                      return (
                        <div key={item.id} className="flex items-center justify-between p-4 rounded-lg border">
                          <div className="flex items-center gap-4">
                            <div
                              className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
                                idx === 0
                                  ? "bg-amber-100 text-amber-800"
                                  : idx === 1
                                    ? "bg-gray-100 text-gray-800"
                                    : idx === 2
                                      ? "bg-orange-100 text-orange-800"
                                      : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {idx + 1}
                            </div>
                            <div>
                              <p className="font-medium">{propertyData.address || "Property"}</p>
                              <p className="text-sm text-muted-foreground">
                                {item.total_votes} votes | Avg: {item.avg_rating?.toFixed(1)}/5
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {item.is_finalist && <Badge className="bg-amber-100 text-amber-800">Finalist</Badge>}
                            <div className="flex items-center gap-1">
                              <Star className="h-4 w-4 text-amber-500" />
                              <span className="font-semibold">{item.avg_rating?.toFixed(1)}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
