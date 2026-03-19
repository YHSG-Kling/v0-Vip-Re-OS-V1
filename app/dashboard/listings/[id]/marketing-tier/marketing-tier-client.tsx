"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  RefreshCw,
  DollarSign,
  Target,
  Package,
  Settings,
  Plus,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ArrowRight,
  Loader2,
  Trash2,
} from "lucide-react"
import { assignTierToListing, createTier, createTierBudget, createTierDistribution, deleteTierBudget, deleteTierDistribution, updateTier } from "@/lib/listings/tier-assigner"

interface MarketingTierClientProps {
  listing: {
    id: string
    address: string
    city: string
    state: string
    zip: string
    list_price: number | null
    marketing_budget: number | null
    marketing_tier_id: string | null
    brokerage_id: string
  }
  currentTier: {
    id: string
    tier_name: string
    min_price: number | null
    max_price: number | null
    description: string | null
    is_active: boolean
  } | null
  tierBudgets: Array<{ id: string; channel_type: string; default_budget: number }>
  tierDistributions: Array<{ id: string; asset_type: string; channel_type: string; is_required: boolean }>
  allTiers: Array<{
    id: string
    tier_name: string
    min_price: number | null
    max_price: number | null
    description: string | null
    is_active: boolean
  }>
  campaigns: Array<{
    id: string
    campaign_name: string
    campaign_type: string
    status: string
    budget_total: number | null
    budget_spent: number | null
    created_at: string
  }>
  assets: Array<{ id: string; asset_type: string; asset_name: string; campaign_id: string }>
  userId: string
  brokerageId: string
  isAdmin: boolean
}

export function MarketingTierClient({
  listing,
  currentTier,
  tierBudgets,
  tierDistributions,
  allTiers,
  campaigns,
  assets,
  userId,
  brokerageId,
  isAdmin,
}: MarketingTierClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [activeTab, setActiveTab] = useState("summary")

  // Dialog states
  const [showCreateTierDialog, setShowCreateTierDialog] = useState(false)
  const [showCreateBudgetDialog, setShowCreateBudgetDialog] = useState(false)
  const [showCreateDistributionDialog, setShowCreateDistributionDialog] = useState(false)

  // Form states
  const [newTier, setNewTier] = useState({ tierName: "", minPrice: "", maxPrice: "", description: "" })
  const [newBudget, setNewBudget] = useState({ tierId: "", channelType: "", defaultBudget: "" })
  const [newDistribution, setNewDistribution] = useState({ tierId: "", assetType: "", channelType: "", isRequired: true })

  const formatCurrency = (amount: number | null) => {
    if (amount === null || amount === undefined) return "$0"
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount)
  }

  const formatPriceRange = (min: number | null, max: number | null) => {
    if (min === null && max === null) return "Any price"
    if (min === null) return `Up to ${formatCurrency(max)}`
    if (max === null) return `${formatCurrency(min)}+`
    return `${formatCurrency(min)} - ${formatCurrency(max)}`
  }

  const totalBudget = tierBudgets.reduce((sum, b) => sum + b.default_budget, 0)

  // Check which required distributions are completed
  const requiredDistributions = tierDistributions.filter(d => d.is_required)
  const completedDistributions = requiredDistributions.filter(d =>
    assets.some(a => a.asset_type === d.asset_type)
  )

  const handleReassignTier = () => {
    startTransition(async () => {
      const result = await assignTierToListing(listing.id, brokerageId, userId)
      if (result.success) {
        router.refresh()
      }
    })
  }

  const handleCreateTier = async () => {
    const result = await createTier({
      brokerageId,
      actorUserId: userId,
      tierName: newTier.tierName,
      minPrice: newTier.minPrice ? parseFloat(newTier.minPrice) : null,
      maxPrice: newTier.maxPrice ? parseFloat(newTier.maxPrice) : null,
      description: newTier.description || undefined,
    })
    if (result.success) {
      setShowCreateTierDialog(false)
      setNewTier({ tierName: "", minPrice: "", maxPrice: "", description: "" })
      router.refresh()
    }
  }

  const handleCreateBudget = async () => {
    const result = await createTierBudget({
      tierId: newBudget.tierId,
      brokerageId,
      actorUserId: userId,
      channelType: newBudget.channelType,
      defaultBudget: parseFloat(newBudget.defaultBudget),
    })
    if (result.success) {
      setShowCreateBudgetDialog(false)
      setNewBudget({ tierId: "", channelType: "", defaultBudget: "" })
      router.refresh()
    }
  }

  const handleCreateDistribution = async () => {
    const result = await createTierDistribution({
      tierId: newDistribution.tierId,
      brokerageId,
      actorUserId: userId,
      assetType: newDistribution.assetType,
      channelType: newDistribution.channelType,
      isRequired: newDistribution.isRequired,
    })
    if (result.success) {
      setShowCreateDistributionDialog(false)
      setNewDistribution({ tierId: "", assetType: "", channelType: "", isRequired: true })
      router.refresh()
    }
  }

  const handleDeleteBudget = async (budgetId: string) => {
    await deleteTierBudget(budgetId, userId)
    router.refresh()
  }

  const handleDeleteDistribution = async (distributionId: string) => {
    await deleteTierDistribution(distributionId, userId)
    router.refresh()
  }

  const handleToggleTierActive = async (tierId: string, isActive: boolean) => {
    await updateTier({ tierId, actorUserId: userId, isActive })
    router.refresh()
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Marketing Tier</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {listing.address}, {listing.city} {listing.state} {listing.zip}
          </p>
        </div>
        <Button onClick={handleReassignTier} disabled={isPending} variant="outline">
          {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Re-assign Tier
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="budgets">Budgets</TabsTrigger>
          <TabsTrigger value="distributions">Requirements</TabsTrigger>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>

        {/* SUMMARY TAB */}
        <TabsContent value="summary" className="space-y-4 mt-4">
          <div className="grid gap-4 md:grid-cols-3">
            {/* Tier Summary Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Current Tier</CardTitle>
              </CardHeader>
              <CardContent>
                {currentTier ? (
                  <div className="space-y-2">
                    <p className="text-2xl font-bold">{currentTier.tier_name}</p>
                    <p className="text-sm text-muted-foreground">{currentTier.description || "No description"}</p>
                    <Badge variant="outline">{formatPriceRange(currentTier.min_price, currentTier.max_price)}</Badge>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-amber-600">
                      <AlertCircle className="h-5 w-5" />
                      <span className="font-medium">No Matching Tier</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      No tier matches the listing price of {formatCurrency(listing.list_price)}.
                      Contact your broker to configure tiers.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Listing Price Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Listing Price</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatCurrency(listing.list_price)}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Marketing Budget: {formatCurrency(listing.marketing_budget)}
                </p>
              </CardContent>
            </Card>

            {/* Total Budget Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Tier Total Budget</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatCurrency(totalBudget)}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Across {tierBudgets.length} channels
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Quick Status */}
          {currentTier && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Requirements Status</CardTitle>
                <CardDescription>
                  {completedDistributions.length} of {requiredDistributions.length} required items completed
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {requiredDistributions.map((dist) => {
                    const isComplete = assets.some(a => a.asset_type === dist.asset_type)
                    return (
                      <Badge
                        key={dist.id}
                        variant={isComplete ? "default" : "secondary"}
                        className={isComplete ? "bg-green-600" : "bg-red-100 text-red-700"}
                      >
                        {isComplete ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <XCircle className="mr-1 h-3 w-3" />}
                        {dist.asset_type} ({dist.channel_type})
                      </Badge>
                    )
                  })}
                  {requiredDistributions.length === 0 && (
                    <p className="text-sm text-muted-foreground">No required distributions configured for this tier.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* BUDGETS TAB */}
        <TabsContent value="budgets" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Budget Allocation
              </CardTitle>
              <CardDescription>
                Channel budgets configured for {currentTier?.tier_name ?? "this tier"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {tierBudgets.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Channel</TableHead>
                      <TableHead className="text-right">Default Budget</TableHead>
                      {isAdmin && <TableHead className="w-20">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tierBudgets.map((budget) => (
                      <TableRow key={budget.id}>
                        <TableCell className="font-medium capitalize">{budget.channel_type.replace(/_/g, " ")}</TableCell>
                        <TableCell className="text-right">{formatCurrency(budget.default_budget)}</TableCell>
                        {isAdmin && (
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteBudget(budget.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                    <TableRow className="bg-muted/50">
                      <TableCell className="font-bold">Total</TableCell>
                      <TableCell className="text-right font-bold">{formatCurrency(totalBudget)}</TableCell>
                      {isAdmin && <TableCell />}
                    </TableRow>
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground py-4">No budgets configured for this tier.</p>
              )}

              {listing.marketing_budget !== totalBudget && currentTier && (
                <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-800">
                    <strong>Budget Mismatch:</strong> Listing budget ({formatCurrency(listing.marketing_budget)}) differs from tier total ({formatCurrency(totalBudget)}).
                    Re-assign tier to sync.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* DISTRIBUTIONS TAB */}
        <TabsContent value="distributions" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="h-5 w-5" />
                Required Distributions
              </CardTitle>
              <CardDescription>
                Assets that must be created for this tier
              </CardDescription>
            </CardHeader>
            <CardContent>
              {tierDistributions.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Asset Type</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Status</TableHead>
                      {isAdmin && <TableHead className="w-20">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tierDistributions.map((dist) => {
                      const isComplete = assets.some(a => a.asset_type === dist.asset_type)
                      return (
                        <TableRow key={dist.id}>
                          <TableCell className="font-medium capitalize">{dist.asset_type.replace(/_/g, " ")}</TableCell>
                          <TableCell className="capitalize">{dist.channel_type.replace(/_/g, " ")}</TableCell>
                          <TableCell>
                            {dist.is_required ? (
                              <Badge variant="destructive">Required</Badge>
                            ) : (
                              <Badge variant="secondary">Optional</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {isComplete ? (
                              <Badge className="bg-green-600">
                                <CheckCircle2 className="mr-1 h-3 w-3" />
                                Complete
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-amber-600 border-amber-300">
                                <XCircle className="mr-1 h-3 w-3" />
                                Missing
                              </Badge>
                            )}
                          </TableCell>
                          {isAdmin && (
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteDistribution(dist.id)}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground py-4">No distributions configured for this tier.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* CAMPAIGNS TAB */}
        <TabsContent value="campaigns" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Package className="h-5 w-5" />
                  Marketing Campaigns
                </CardTitle>
                <CardDescription>
                  Campaigns created for this listing
                </CardDescription>
              </div>
              <Link href={`/content-studio?listing_id=${listing.id}`}>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Campaign
                </Button>
              </Link>
            </CardHeader>
            <CardContent>
              {campaigns.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Budget</TableHead>
                      <TableHead className="text-right">Spent</TableHead>
                      <TableHead className="w-20"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaigns.map((campaign) => (
                      <TableRow key={campaign.id}>
                        <TableCell className="font-medium">{campaign.campaign_name}</TableCell>
                        <TableCell className="capitalize">{campaign.campaign_type?.replace(/_/g, " ") ?? "-"}</TableCell>
                        <TableCell>
                          <Badge variant={campaign.status === "active" ? "default" : "secondary"}>
                            {campaign.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(campaign.budget_total)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(campaign.budget_spent)}</TableCell>
                        <TableCell>
                          <Link href={`/content-studio/campaigns/${campaign.id}`}>
                            <Button variant="ghost" size="sm">
                              <ArrowRight className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8">
                  <Package className="mx-auto h-12 w-12 text-muted-foreground/50" />
                  <p className="mt-2 text-sm text-muted-foreground">No campaigns yet for this listing.</p>
                  <Link href={`/content-studio?listing_id=${listing.id}`}>
                    <Button className="mt-4">
                      <Plus className="mr-2 h-4 w-4" />
                      Create First Campaign
                    </Button>
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* SETTINGS TAB (Admin Only) */}
        {isAdmin && (
          <TabsContent value="settings" className="mt-4 space-y-4">
            {/* Tier Management */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Settings className="h-5 w-5" />
                    Tier Settings
                  </CardTitle>
                  <CardDescription>
                    Manage marketing tiers for your brokerage
                  </CardDescription>
                </div>
                <Dialog open={showCreateTierDialog} onOpenChange={setShowCreateTierDialog}>
                  <DialogTrigger asChild>
                    <Button>
                      <Plus className="mr-2 h-4 w-4" />
                      Create Tier
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Create Marketing Tier</DialogTitle>
                      <DialogDescription>
                        Define a new marketing tier with price range and description.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="tierName">Tier Name</Label>
                        <Input
                          id="tierName"
                          placeholder="e.g., Premium, Standard, Luxury"
                          value={newTier.tierName}
                          onChange={(e) => setNewTier({ ...newTier, tierName: e.target.value })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="minPrice">Min Price ($)</Label>
                          <Input
                            id="minPrice"
                            type="number"
                            placeholder="0"
                            value={newTier.minPrice}
                            onChange={(e) => setNewTier({ ...newTier, minPrice: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="maxPrice">Max Price ($)</Label>
                          <Input
                            id="maxPrice"
                            type="number"
                            placeholder="No limit"
                            value={newTier.maxPrice}
                            onChange={(e) => setNewTier({ ...newTier, maxPrice: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="description">Description</Label>
                        <Textarea
                          id="description"
                          placeholder="Describe this tier..."
                          value={newTier.description}
                          onChange={(e) => setNewTier({ ...newTier, description: e.target.value })}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowCreateTierDialog(false)}>Cancel</Button>
                      <Button onClick={handleCreateTier} disabled={!newTier.tierName}>Create Tier</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
              <CardContent>
                {allTiers.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tier Name</TableHead>
                        <TableHead>Price Range</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Active</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allTiers.map((tier) => (
                        <TableRow key={tier.id}>
                          <TableCell className="font-medium">{tier.tier_name}</TableCell>
                          <TableCell>{formatPriceRange(tier.min_price, tier.max_price)}</TableCell>
                          <TableCell className="max-w-[200px] truncate">{tier.description || "-"}</TableCell>
                          <TableCell>
                            <Switch
                              checked={tier.is_active}
                              onCheckedChange={(checked) => handleToggleTierActive(tier.id, checked)}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground py-4">No tiers configured. Create your first tier to get started.</p>
                )}
              </CardContent>
            </Card>

            {/* Add Budget */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Tier Budgets</CardTitle>
                  <CardDescription>Add channel budgets to tiers</CardDescription>
                </div>
                <Dialog open={showCreateBudgetDialog} onOpenChange={setShowCreateBudgetDialog}>
                  <DialogTrigger asChild>
                    <Button variant="outline">
                      <Plus className="mr-2 h-4 w-4" />
                      Add Budget
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Tier Budget</DialogTitle>
                      <DialogDescription>
                        Configure a default budget for a marketing channel.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Select Tier</Label>
                        <Select value={newBudget.tierId} onValueChange={(v) => setNewBudget({ ...newBudget, tierId: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a tier" />
                          </SelectTrigger>
                          <SelectContent>
                            {allTiers.map((tier) => (
                              <SelectItem key={tier.id} value={tier.id}>{tier.tier_name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Channel Type</Label>
                        <Select value={newBudget.channelType} onValueChange={(v) => setNewBudget({ ...newBudget, channelType: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select channel" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="social_media">Social Media</SelectItem>
                            <SelectItem value="paid_ads">Paid Ads</SelectItem>
                            <SelectItem value="direct_mail">Direct Mail</SelectItem>
                            <SelectItem value="email">Email</SelectItem>
                            <SelectItem value="video">Video</SelectItem>
                            <SelectItem value="print">Print</SelectItem>
                            <SelectItem value="signage">Signage</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Default Budget ($)</Label>
                        <Input
                          type="number"
                          placeholder="500"
                          value={newBudget.defaultBudget}
                          onChange={(e) => setNewBudget({ ...newBudget, defaultBudget: e.target.value })}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowCreateBudgetDialog(false)}>Cancel</Button>
                      <Button onClick={handleCreateBudget} disabled={!newBudget.tierId || !newBudget.channelType || !newBudget.defaultBudget}>
                        Add Budget
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
            </Card>

            {/* Add Distribution */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Tier Distributions</CardTitle>
                  <CardDescription>Define required assets for each tier</CardDescription>
                </div>
                <Dialog open={showCreateDistributionDialog} onOpenChange={setShowCreateDistributionDialog}>
                  <DialogTrigger asChild>
                    <Button variant="outline">
                      <Plus className="mr-2 h-4 w-4" />
                      Add Requirement
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Distribution Requirement</DialogTitle>
                      <DialogDescription>
                        Define an asset type that must be created for this tier.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Select Tier</Label>
                        <Select value={newDistribution.tierId} onValueChange={(v) => setNewDistribution({ ...newDistribution, tierId: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a tier" />
                          </SelectTrigger>
                          <SelectContent>
                            {allTiers.map((tier) => (
                              <SelectItem key={tier.id} value={tier.id}>{tier.tier_name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Asset Type</Label>
                        <Select value={newDistribution.assetType} onValueChange={(v) => setNewDistribution({ ...newDistribution, assetType: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select asset type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="listing_video">Listing Video</SelectItem>
                            <SelectItem value="social_post">Social Post</SelectItem>
                            <SelectItem value="postcard">Postcard</SelectItem>
                            <SelectItem value="flyer">Flyer</SelectItem>
                            <SelectItem value="blog_post">Blog Post</SelectItem>
                            <SelectItem value="email_template">Email Template</SelectItem>
                            <SelectItem value="virtual_tour">Virtual Tour</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Channel Type</Label>
                        <Select value={newDistribution.channelType} onValueChange={(v) => setNewDistribution({ ...newDistribution, channelType: v })}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select channel" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="social_media">Social Media</SelectItem>
                            <SelectItem value="paid_ads">Paid Ads</SelectItem>
                            <SelectItem value="direct_mail">Direct Mail</SelectItem>
                            <SelectItem value="email">Email</SelectItem>
                            <SelectItem value="website">Website</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Switch
                          id="isRequired"
                          checked={newDistribution.isRequired}
                          onCheckedChange={(checked) => setNewDistribution({ ...newDistribution, isRequired: checked })}
                        />
                        <Label htmlFor="isRequired">Required</Label>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowCreateDistributionDialog(false)}>Cancel</Button>
                      <Button onClick={handleCreateDistribution} disabled={!newDistribution.tierId || !newDistribution.assetType || !newDistribution.channelType}>
                        Add Requirement
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardHeader>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
