"use client"

/**
 * Family / collaborative search — the buyer-portal surface over
 * app/actions/collaborative-search.ts.
 *
 * ORPHAN BURN-DOWN: this dashboard only ever called 7 of the module's actions.
 * Member removal, search-criteria editing, per-property ratings detail, property
 * add/remove and portal activity tracking all existed server-side with no caller,
 * so a family search could be created but never curated. Wired here; every call
 * reads its outcome and a refusal is surfaced instead of silently doing nothing.
 *
 * DRIFT FIXED: the property rows returned by getSearchProperties key on
 * `property_mls_id` (addPropertyToSearch's own comment records `property_id` as
 * the phantom column it replaced). This component still read `prop.property_id`,
 * which is undefined — so every vote and every consensus lookup was keyed on
 * `undefined`. Now keyed on property_mls_id end to end.
 */

import { useState, useEffect, useCallback } from "react"
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
  Trash2,
  SlidersHorizontal,
} from "lucide-react"
import {
  createCollaborativeSearch,
  getCollaborativeSearches,
  getCollaborativeSearchById,
  updateSearchCriteria,
  inviteFamilyMember,
  removeMember,
  rateProperty,
  getPropertyRatings,
  getSearchProperties,
  addPropertyToSearch,
  removePropertyFromSearch,
  getConsensus,
  markAsFinalist,
  trackPortalActivity,
} from "@/app/actions/collaborative-search"

export interface SavedPropertyOption {
  listing_id: string
  property_address: string | null
  city: string | null
  state: string | null
  list_price: number | null
  bedrooms: number | null
  bathrooms: number | null
}

interface CollaborativeSearchDashboardProps {
  contactId: string
  contactEmail: string
  savedProperties?: SavedPropertyOption[]
}

export function CollaborativeSearchDashboard({
  contactId,
  contactEmail,
  savedProperties = [],
}: CollaborativeSearchDashboardProps) {
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
  const [error, setError] = useState<string | null>(null)

  // Criteria editor
  const [showCriteria, setShowCriteria] = useState(false)
  const [critMinPrice, setCritMinPrice] = useState("")
  const [critMaxPrice, setCritMaxPrice] = useState("")
  const [critBeds, setCritBeds] = useState("")
  const [critBaths, setCritBaths] = useState("")
  const [critAreas, setCritAreas] = useState("")
  const [criteriaNotice, setCriteriaNotice] = useState<string | null>(null)

  // Per-property ratings detail
  const [ratingsFor, setRatingsFor] = useState<string | null>(null)
  const [ratings, setRatings] = useState<any[]>([])
  const [ratingsLoading, setRatingsLoading] = useState(false)

  // Add-a-property
  const [addListingId, setAddListingId] = useState("")
  const [busy, setBusy] = useState(false)

  const loadSearches = useCallback(async () => {
    setLoading(true)
    const data = await getCollaborativeSearches(contactId)
    setSearches(data)
    setActiveSearch((prev: any) => {
      if (prev) return data.find((s: any) => s.id === prev.id) ?? prev
      return data.length > 0 ? data[0] : null
    })
    setLoading(false)
  }, [contactId])

  useEffect(() => {
    loadSearches()
  }, [loadSearches])

  const loadSearchData = useCallback(async () => {
    if (!activeSearch) return
    const [props, cons] = await Promise.all([
      getSearchProperties(activeSearch.id),
      getConsensus(activeSearch.id),
    ])
    setProperties(props)
    setConsensus(cons)
  }, [activeSearch])

  useEffect(() => {
    loadSearchData()
  }, [loadSearchData])

  // Seed the criteria editor from whatever the active search already carries.
  useEffect(() => {
    const c = (activeSearch?.search_criteria ?? {}) as Record<string, any>
    setCritMinPrice(c.min_price != null ? String(c.min_price) : "")
    setCritMaxPrice(c.max_price != null ? String(c.max_price) : "")
    setCritBeds(c.min_beds != null ? String(c.min_beds) : "")
    setCritBaths(c.min_baths != null ? String(c.min_baths) : "")
    setCritAreas(Array.isArray(c.areas) ? c.areas.join(", ") : "")
    setCriteriaNotice(null)
  }, [activeSearch?.id])

  // Refresh ONLY the active search row (members + criteria) after a membership
  // change, without re-pulling every search the contact owns.
  async function refreshActiveSearch() {
    if (!activeSearch) return
    // Named for what it holds, not for its freshness: a bare `fresh` tells a
    // reader nothing about WHICH thing came back empty, and the honesty guard
    // reads the same way — it could not connect the tested value to the noun
    // the message names.
    const freshSearch = await getCollaborativeSearchById(activeSearch.id)
    if (!freshSearch) {
      setError("Could not reload the search after that change.")
      return
    }
    setActiveSearch(freshSearch)
    setSearches((prev) =>
      prev.map((s) => (s.id === freshSearch.id ? { ...s, ...freshSearch } : s)),
    )
  }

  async function handleCreateSearch() {
    if (!newSearchName.trim()) return
    setError(null)
    const result = await createCollaborativeSearch(contactId, newSearchName)
    if ((result as any).error || !(result as any).data) {
      setError((result as any).error ?? "The search was not created.")
      return
    }
    setShowCreateDialog(false)
    setNewSearchName("")
    await loadSearches()
  }

  async function handleInvite() {
    if (!inviteEmail.trim() || !activeSearch) return
    setError(null)
    const result = await inviteFamilyMember(activeSearch.id, inviteEmail, inviteName, inviteRole)
    if ((result as any).error || !(result as any).data) {
      setError((result as any).error ?? "The invitation was not sent.")
      return
    }
    setShowInviteDialog(false)
    setInviteEmail("")
    setInviteName("")
    await refreshActiveSearch()
  }

  async function handleRemoveMember(memberId: string) {
    if (!activeSearch) return
    setError(null)
    setBusy(true)
    const res = await removeMember(activeSearch.id, memberId)
    setBusy(false)
    if ((res as any).error) {
      setError((res as any).error)
      return
    }
    await refreshActiveSearch()
  }

  async function handleSaveCriteria() {
    if (!activeSearch) return
    setError(null)
    setCriteriaNotice(null)
    const toNum = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? undefined : Number(v))
    const criteria: Record<string, any> = {
      min_price: toNum(critMinPrice),
      max_price: toNum(critMaxPrice),
      min_beds: toNum(critBeds),
      min_baths: toNum(critBaths),
      areas: critAreas.split(",").map((a) => a.trim()).filter(Boolean),
    }
    setBusy(true)
    const res = await updateSearchCriteria(activeSearch.id, criteria)
    setBusy(false)
    if ((res as any).error) {
      setError((res as any).error)
      return
    }
    setActiveSearch((prev: any) => (prev ? { ...prev, search_criteria: criteria } : prev))
    setCriteriaNotice("Criteria saved — everyone on this search sees the update.")
    await trackPortalActivity(contactId, "collaborative_search_criteria_updated", {
      collaborative_search_id: activeSearch.id,
    })
  }

  async function handleRate(propertyId: string, vote: "love" | "like" | "neutral" | "dislike" | "pass") {
    if (!activeSearch || !propertyId) return
    setError(null)
    const ratingMap = { love: 5, like: 4, neutral: 3, dislike: 2, pass: 1 }
    const res = await rateProperty(activeSearch.id, propertyId, contactEmail, ratingMap[vote], vote)
    if ((res as any).error) {
      setError((res as any).error)
      return
    }
    await trackPortalActivity(contactId, "collaborative_search_vote", {
      collaborative_search_id: activeSearch.id,
      vote,
    }, propertyId)
    await loadSearchData()
    if (ratingsFor === propertyId) await loadRatings(propertyId)
  }

  async function loadRatings(propertyId: string) {
    if (!activeSearch) return
    setRatingsLoading(true)
    const rows = await getPropertyRatings(activeSearch.id, propertyId)
    setRatings(rows)
    setRatingsLoading(false)
  }

  async function handleToggleRatings(propertyId: string) {
    if (ratingsFor === propertyId) {
      setRatingsFor(null)
      setRatings([])
      return
    }
    setRatingsFor(propertyId)
    await loadRatings(propertyId)
  }

  async function handleAddProperty() {
    if (!activeSearch || !addListingId) return
    setError(null)
    const saved = savedProperties.find((s) => s.listing_id === addListingId)
    if (!saved) {
      setError("That property is no longer in your saved list.")
      return
    }
    setBusy(true)
    const res = await addPropertyToSearch(
      activeSearch.id,
      saved.listing_id,
      {
        address: saved.property_address,
        city: saved.city,
        state: saved.state,
        price: saved.list_price,
        bedrooms: saved.bedrooms,
        bathrooms: saved.bathrooms,
      },
      contactEmail,
    )
    setBusy(false)
    if ((res as any).error || !(res as any).data) {
      setError((res as any).error ?? "The property was not added.")
      return
    }
    setAddListingId("")
    await trackPortalActivity(contactId, "collaborative_search_property_added", {
      collaborative_search_id: activeSearch.id,
    }, saved.listing_id)
    await loadSearchData()
  }

  async function handleRemoveProperty(propertyId: string) {
    if (!activeSearch || !propertyId) return
    setError(null)
    setBusy(true)
    const res = await removePropertyFromSearch(activeSearch.id, propertyId)
    setBusy(false)
    if ((res as any).error) {
      setError((res as any).error)
      return
    }
    if (ratingsFor === propertyId) { setRatingsFor(null); setRatings([]) }
    await loadSearchData()
  }

  async function handleToggleFinalist(propertyId: string, currentStatus: boolean) {
    if (!activeSearch || !propertyId) return
    setError(null)
    const res = await markAsFinalist(activeSearch.id, propertyId, !currentStatus)
    if ((res as any).error) {
      setError((res as any).error)
      return
    }
    await loadSearchData()
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
          {error && <p className="text-sm text-destructive">{error}</p>}
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

  const alreadyAdded = new Set(properties.map((p) => p.property_mls_id))
  const addableProperties = savedProperties.filter((s) => !alreadyAdded.has(s.listing_id))

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

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
          <Button variant="outline" size="sm" onClick={() => setShowCriteria((v) => !v)}>
            <SlidersHorizontal className="h-4 w-4 mr-2" />
            {showCriteria ? "Hide criteria" : "Criteria"}
          </Button>
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
              <DialogDescription>They&apos;ll be able to view properties and add their ratings</DialogDescription>
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

      {/* Shared search criteria */}
      {showCriteria && activeSearch && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <SlidersHorizontal className="h-5 w-5" />
              Shared Criteria
            </CardTitle>
            <CardDescription>
              What this family search is looking for. Everyone invited sees the same criteria.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label className="text-xs">Min price</Label>
                <Input inputMode="numeric" value={critMinPrice} onChange={(e) => setCritMinPrice(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Max price</Label>
                <Input inputMode="numeric" value={critMaxPrice} onChange={(e) => setCritMaxPrice(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Min beds</Label>
                <Input inputMode="numeric" value={critBeds} onChange={(e) => setCritBeds(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Min baths</Label>
                <Input inputMode="numeric" value={critBaths} onChange={(e) => setCritBaths(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Areas / neighborhoods (comma separated)</Label>
              <Input value={critAreas} onChange={(e) => setCritAreas(e.target.value)} placeholder="Westlake, Zilker, 78704" />
            </div>
            {criteriaNotice && <p className="text-sm text-emerald-600">{criteriaNotice}</p>}
            <Button size="sm" onClick={handleSaveCriteria} disabled={busy}>
              {busy ? "Saving…" : "Save criteria"}
            </Button>
          </CardContent>
        </Card>
      )}

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
                  {member.role !== "owner" && (
                    <button
                      type="button"
                      aria-label={`Remove ${member.name || member.email}`}
                      className="ml-1 rounded-sm opacity-70 hover:opacity-100 disabled:opacity-40"
                      disabled={busy}
                      onClick={() => handleRemoveMember(member.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
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
          {/* Add from the buyer's own saved properties — the only list this
              portal can honestly offer; nothing is invented here. */}
          {activeSearch && (
            <Card>
              <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1">
                  <Label className="text-sm">Add one of your saved homes to this search</Label>
                  {addableProperties.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {savedProperties.length === 0
                        ? "You have no saved homes yet — save one from your search results first."
                        : "Every home you've saved is already in this search."}
                    </p>
                  ) : (
                    <Select value={addListingId} onValueChange={setAddListingId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a saved home" />
                      </SelectTrigger>
                      <SelectContent>
                        {addableProperties.map((s) => (
                          <SelectItem key={s.listing_id} value={s.listing_id}>
                            {s.property_address ?? "Property"}
                            {s.list_price ? ` — $${s.list_price.toLocaleString()}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <Button
                  onClick={handleAddProperty}
                  disabled={busy || !addListingId || addableProperties.length === 0}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add to search
                </Button>
              </CardContent>
            </Card>
          )}

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
                // The row's identifier is property_mls_id — the ratings and
                // consensus tables key on the SAME value.
                const propertyKey = prop.property_mls_id
                const myRating = prop.property_family_ratings?.find((r: any) => r.member_email === contactEmail)
                const consensusData = consensus.find((c) => c.property_id === propertyKey)

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
                              onClick={() => handleRate(propertyKey, vote)}
                            >
                              <Icon className="h-4 w-4 mr-1" />
                              {label}
                            </Button>
                          ))}
                        </div>
                      </div>

                      {/* Who voted what */}
                      <div className="space-y-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-0 text-sm"
                          onClick={() => handleToggleRatings(propertyKey)}
                        >
                          <Users className="h-4 w-4 mr-2" />
                          {ratingsFor === propertyKey ? "Hide family votes" : "See family votes"}
                        </Button>
                        {ratingsFor === propertyKey && (
                          <div className="rounded-lg border p-3 space-y-2">
                            {ratingsLoading ? (
                              <p className="text-sm text-muted-foreground">Loading votes…</p>
                            ) : ratings.length === 0 ? (
                              <p className="text-sm text-muted-foreground">Nobody has voted on this home yet.</p>
                            ) : (
                              ratings.map((r: any) => (
                                <div key={r.id} className="flex items-start justify-between gap-3 text-sm">
                                  <div className="min-w-0">
                                    <p className="font-medium truncate">
                                      {r.collaborative_search_members?.name || r.member_email}
                                      <span className="ml-1 text-xs text-muted-foreground">
                                        ({r.collaborative_search_members?.role ?? "member"})
                                      </span>
                                    </p>
                                    {r.comments && (
                                      <p className="text-xs text-muted-foreground">{r.comments}</p>
                                    )}
                                    {(r.pros?.length > 0 || r.cons?.length > 0) && (
                                      <p className="text-xs text-muted-foreground">
                                        {r.pros?.length > 0 && <>+ {r.pros.join(", ")} </>}
                                        {r.cons?.length > 0 && <>− {r.cons.join(", ")}</>}
                                      </p>
                                    )}
                                  </div>
                                  <Badge variant="secondary" className="shrink-0 capitalize">
                                    {r.vote}
                                    {r.rating != null && ` · ${r.rating}/5`}
                                  </Badge>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 bg-transparent"
                          onClick={() => handleToggleFinalist(propertyKey, consensusData?.is_finalist || false)}
                        >
                          <Trophy className="h-4 w-4 mr-2" />
                          {consensusData?.is_finalist ? "Remove from Finalists" : "Mark as Finalist"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          disabled={busy}
                          onClick={() => handleRemoveProperty(propertyKey)}
                          aria-label="Remove property from this search"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
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
