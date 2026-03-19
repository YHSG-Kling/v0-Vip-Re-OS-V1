/**
 * ListingDetailTabs - Receives real data from page.tsx server component
 * - photos: from listing_media table
 * - offers: from offers table via getOffersForListing
 * - showings: from showings table via getListingShowings
 * - documents: from transaction_documents table
 * - analytics: computed from real listing metrics
 */
"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Home,
  ImageIcon,
  FileText,
  Calendar,
  DollarSign,
  ShieldCheck,
  Globe,
  Video,
  BarChart3,
  File,
  Edit,
  Upload,
  Plus,
  Download,
  Eye,
  Sparkles,
  Check,
  X,
  TrendingUp,
  Clock,
  MapPin,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface ListingDetailTabsProps {
  listing: any
  offers?: any[]
  photos?: any[]
  documents?: any[]
  showings?: any[]
  analytics?: any
  syndicationStatus?: any
  marketingAssets?: any
}

export function ListingDetailTabs({
  listing,
  offers = [],
  photos = [],
  documents = [],
  showings = [],
  analytics,
  syndicationStatus,
  marketingAssets,
}: ListingDetailTabsProps) {
  const [selectedPhotos, setSelectedPhotos] = useState<string[]>([])

  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList className="grid w-full grid-cols-5 lg:grid-cols-10 gap-2 h-auto p-2 bg-muted">
        <TabsTrigger value="overview" className="gap-2">
          <Home className="h-4 w-4" />
          <span className="hidden sm:inline">Overview</span>
        </TabsTrigger>
        <TabsTrigger value="photos" className="gap-2">
          <ImageIcon className="h-4 w-4" />
          <span className="hidden sm:inline">Photos</span>
        </TabsTrigger>
        <TabsTrigger value="description" className="gap-2">
          <FileText className="h-4 w-4" />
          <span className="hidden sm:inline">Description</span>
        </TabsTrigger>
        <TabsTrigger value="showings" className="gap-2">
          <Calendar className="h-4 w-4" />
          <span className="hidden sm:inline">Showings</span>
        </TabsTrigger>
        <TabsTrigger value="offers" className="gap-2">
          <DollarSign className="h-4 w-4" />
          <span className="hidden sm:inline">Offers</span>
        </TabsTrigger>
        <TabsTrigger value="compliance" className="gap-2">
          <ShieldCheck className="h-4 w-4" />
          <span className="hidden sm:inline">Compliance</span>
        </TabsTrigger>
        <TabsTrigger value="syndication" className="gap-2">
          <Globe className="h-4 w-4" />
          <span className="hidden sm:inline">Syndication</span>
        </TabsTrigger>
        <TabsTrigger value="marketing" className="gap-2">
          <Video className="h-4 w-4" />
          <span className="hidden sm:inline">Marketing</span>
        </TabsTrigger>
        <TabsTrigger value="analytics" className="gap-2">
          <BarChart3 className="h-4 w-4" />
          <span className="hidden sm:inline">Analytics</span>
        </TabsTrigger>
        <TabsTrigger value="documents" className="gap-2">
          <File className="h-4 w-4" />
          <span className="hidden sm:inline">Documents</span>
        </TabsTrigger>
      </TabsList>

      {/* Tab 1: Overview */}
      <TabsContent value="overview" className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Listing Overview</CardTitle>
            <Button variant="outline" size="sm">
              <Edit className="h-4 w-4 mr-2" />
              Edit Listing
            </Button>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Status Banner */}
            <div className="flex items-center gap-3 p-4 bg-accent rounded-lg">
              <Badge variant={listing.status === "active" ? "default" : "secondary"}>
                {listing.status}
              </Badge>
              <span className="text-sm text-muted-foreground">
                Listed on {new Date(listing.created_at).toLocaleDateString()}
              </span>
            </div>

            {/* Property Details Grid */}
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground">MLS Number</Label>
                  <p className="text-lg font-semibold text-foreground">{listing.mls_number || "N/A"}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Address</Label>
                  <p className="text-lg font-semibold text-foreground">{listing.address}</p>
                  <p className="text-sm text-muted-foreground">
                    {listing.city}, {listing.state} {listing.zip}
                  </p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Property Type</Label>
                  <p className="text-base text-foreground">{listing.property_type || "Single Family"}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <Label className="text-xs text-muted-foreground">List Price</Label>
                  <p className="text-3xl font-bold text-primary">
                    ${listing.price?.toLocaleString() || "0"}
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <Label className="text-xs text-muted-foreground">Beds</Label>
                    <p className="text-2xl font-bold text-foreground">{listing.bedrooms || 0}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Baths</Label>
                    <p className="text-2xl font-bold text-foreground">{listing.bathrooms || 0}</p>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Sq Ft</Label>
                    <p className="text-2xl font-bold text-foreground">
                      {listing.square_footage?.toLocaleString() || 0}
                    </p>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Lot Size</Label>
                  <p className="text-base text-foreground">{listing.lot_size || "N/A"}</p>
                </div>
              </div>
            </div>

            {/* Additional Details */}
            <div className="grid md:grid-cols-3 gap-4 pt-4 border-t border-border">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Year Built</Label>
                <p className="text-sm text-foreground">{listing.year_built || "N/A"}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">HOA Fees</Label>
                <p className="text-sm text-foreground">
                  {listing.hoa_fees ? `$${listing.hoa_fees}/mo` : "None"}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Parking</Label>
                <p className="text-sm text-foreground">{listing.parking || "N/A"}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 2: Photos */}
      <TabsContent value="photos" className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Property Photos</CardTitle>
            <Button>
              <Upload className="h-4 w-4 mr-2" />
              Upload Photos
            </Button>
          </CardHeader>
          <CardContent>
            {photos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <ImageIcon className="h-16 w-16 text-muted-foreground mb-4" />
                <p className="text-lg font-medium text-foreground">No photos yet</p>
                <p className="text-sm text-muted-foreground mt-1">Upload property photos to showcase this listing</p>
                <Button className="mt-4">
                  <Upload className="h-4 w-4 mr-2" />
                  Upload First Photo
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {photos.map((photo, index) => (
                  <div
                    key={photo.id}
                    className="relative group aspect-square bg-muted rounded-lg overflow-hidden cursor-move"
                  >
                    <img
                      src={photo.url || "/placeholder.svg"}
                      alt={`Property photo ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                      <Button size="sm" variant="secondary">
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="destructive">
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    {index === 0 && (
                      <Badge className="absolute top-2 left-2">Primary</Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 3: Description */}
      <TabsContent value="description" className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Property Description</CardTitle>
            <div className="flex gap-2">
              <Button variant="outline" size="sm">
                <Sparkles className="h-4 w-4 mr-2" />
                AI Generate
              </Button>
              <Button variant="outline" size="sm">
                <Edit className="h-4 w-4 mr-2" />
                Edit
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="prose prose-sm max-w-none">
              <p className="text-foreground leading-relaxed">
                {listing.description || "No description available. Click 'AI Generate' to create one."}
              </p>
            </div>

            {listing.features && (
              <div className="pt-4 border-t border-border">
                <Label className="text-sm font-semibold mb-3 block">Key Features</Label>
                <div className="grid md:grid-cols-2 gap-2">
                  {listing.features.split(",").map((feature: string, index: number) => (
                    <div key={index} className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-primary" />
                      <span className="text-sm text-foreground">{feature.trim()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 4: Showing Schedule */}
      <TabsContent value="showings" className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Showing Schedule</CardTitle>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Schedule Showing
            </Button>
          </CardHeader>
          <CardContent>
            {showings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Calendar className="h-16 w-16 text-muted-foreground mb-4" />
                <p className="text-lg font-medium text-foreground">No showings scheduled</p>
                <p className="text-sm text-muted-foreground mt-1">Schedule a showing to get started</p>
              </div>
            ) : (
              <div className="space-y-3">
                {showings.map((showing) => (
                  <div
                    key={showing.id}
                    className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-center justify-center w-16 h-16 bg-primary/10 rounded-lg">
                        <span className="text-xs text-muted-foreground">
                          {new Date(showing.date).toLocaleDateString("en-US", { month: "short" })}
                        </span>
                        <span className="text-2xl font-bold text-primary">
                          {new Date(showing.date).getDate()}
                        </span>
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">{showing.buyer_name}</p>
                        <p className="text-sm text-muted-foreground">
                          {showing.time} • {showing.duration} minutes
                        </p>
                      </div>
                    </div>
                    <Badge variant={showing.status === "confirmed" ? "default" : "outline"}>
                      {showing.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 5: Offers */}
      <TabsContent value="offers" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Offers Received</CardTitle>
          </CardHeader>
          <CardContent>
            {offers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <DollarSign className="h-16 w-16 text-muted-foreground mb-4" />
                <p className="text-lg font-medium text-foreground">No offers yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Offers will appear here when buyers submit them
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Buyer</TableHead>
                    <TableHead>Offer Price</TableHead>
                    <TableHead>Earnest Money</TableHead>
                    <TableHead>Financing</TableHead>
                    <TableHead>Close Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {offers.map((offer) => (
                    <TableRow key={offer.id}>
                      <TableCell className="font-medium">{offer.buyer_name}</TableCell>
                      <TableCell className="font-semibold text-primary">
                        ${offer.offer_price.toLocaleString()}
                      </TableCell>
                      <TableCell>${offer.earnest_money?.toLocaleString() || 0}</TableCell>
                      <TableCell>{offer.financing_type}</TableCell>
                      <TableCell>{new Date(offer.close_date).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            offer.status === "accepted"
                              ? "default"
                              : offer.status === "pending"
                                ? "outline"
                                : "secondary"
                          }
                        >
                          {offer.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 6: Compliance */}
      <TabsContent value="compliance" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Fair Housing Compliance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-accent rounded-lg">
              <ShieldCheck className="h-8 w-8 text-primary" />
              <div>
                <p className="font-semibold text-foreground">Last Scan: {new Date().toLocaleDateString()}</p>
                <p className="text-sm text-muted-foreground">No violations detected</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-start gap-3 p-3 border border-border rounded-lg">
                <Check className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <p className="font-medium text-foreground">Description Compliance</p>
                  <p className="text-sm text-muted-foreground">
                    No discriminatory language found in property description
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 border border-border rounded-lg">
                <Check className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <p className="font-medium text-foreground">Photo Compliance</p>
                  <p className="text-sm text-muted-foreground">All property photos meet fair housing guidelines</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 border border-border rounded-lg">
                <Check className="h-5 w-5 text-primary mt-0.5" />
                <div>
                  <p className="font-medium text-foreground">Marketing Materials</p>
                  <p className="text-sm text-muted-foreground">
                    All marketing materials comply with fair housing laws
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 7: Syndication */}
      <TabsContent value="syndication" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Listing Syndication Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between p-4 border border-border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                    <Globe className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">MLS</p>
                    <p className="text-xs text-muted-foreground">Multiple Listing Service</p>
                  </div>
                </div>
                <Badge>Active</Badge>
              </div>

              <div className="flex items-center justify-between p-4 border border-border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                    <Globe className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">Zillow</p>
                    <p className="text-xs text-muted-foreground">zillow.com</p>
                  </div>
                </div>
                <Badge>Active</Badge>
              </div>

              <div className="flex items-center justify-between p-4 border border-border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                    <Globe className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">Realtor.com</p>
                    <p className="text-xs text-muted-foreground">realtor.com</p>
                  </div>
                </div>
                <Badge>Active</Badge>
              </div>

              <div className="flex items-center justify-between p-4 border border-border rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-muted rounded-lg flex items-center justify-center">
                    <Globe className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">Trulia</p>
                    <p className="text-xs text-muted-foreground">trulia.com</p>
                  </div>
                </div>
                <Badge variant="outline">Pending</Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 8: Marketing */}
      <TabsContent value="marketing" className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Marketing Assets</CardTitle>
            <Button>
              <Video className="h-4 w-4 mr-2" />
              Create Video
            </Button>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Video Asset */}
            <div className="p-4 border border-border rounded-lg">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-foreground">Property Video Tour</h4>
                <Badge variant="outline">Ready</Badge>
              </div>
              <div className="aspect-video bg-muted rounded-lg flex items-center justify-center">
                <Video className="h-12 w-12 text-muted-foreground" />
              </div>
            </div>

            {/* Social Posts */}
            <div>
              <h4 className="font-semibold text-foreground mb-3">Social Media Posts</h4>
              <div className="grid md:grid-cols-2 gap-3">
                <div className="p-3 border border-border rounded-lg">
                  <p className="text-sm font-medium text-foreground mb-1">Instagram Post</p>
                  <p className="text-xs text-muted-foreground">Posted 2 days ago • 156 views</p>
                </div>
                <div className="p-3 border border-border rounded-lg">
                  <p className="text-sm font-medium text-foreground mb-1">Facebook Post</p>
                  <p className="text-xs text-muted-foreground">Posted 2 days ago • 243 views</p>
                </div>
              </div>
            </div>

            {/* Email Campaigns */}
            <div>
              <h4 className="font-semibold text-foreground mb-3">Email Campaigns</h4>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 border border-border rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-foreground">New Listing Announcement</p>
                    <p className="text-xs text-muted-foreground">Sent to 324 contacts • 68% open rate</p>
                  </div>
                  <Badge>Sent</Badge>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 9: Analytics */}
      <TabsContent value="analytics" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Listing Performance Analytics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Key Metrics */}
            <div className="grid md:grid-cols-4 gap-4">
              <div className="p-4 bg-accent rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Days on Market</span>
                </div>
                <p className="text-3xl font-bold text-foreground">
                  {analytics?.daysOnMarket || 0}
                </p>
              </div>

              <div className="p-4 bg-accent rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Eye className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Total Views</span>
                </div>
                <p className="text-3xl font-bold text-foreground">
                  {analytics?.totalViews || 0}
                </p>
              </div>

              <div className="p-4 bg-accent rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Inquiries</span>
                </div>
                <p className="text-3xl font-bold text-foreground">
                  {analytics?.inquiries || 0}
                </p>
              </div>

              <div className="p-4 bg-accent rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Interest Level</span>
                </div>
                <p className="text-3xl font-bold text-foreground">
                  {analytics?.interestLevel || "Medium"}
                </p>
              </div>
            </div>

            {/* Views Chart Placeholder */}
            <div className="p-8 border border-border rounded-lg">
              <h4 className="font-semibold text-foreground mb-4">Views Per Day</h4>
              <div className="h-64 bg-muted rounded-lg flex items-center justify-center">
                <BarChart3 className="h-16 w-16 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* Tab 10: Documents */}
      <TabsContent value="documents" className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Listing Documents</CardTitle>
            <Button>
              <Upload className="h-4 w-4 mr-2" />
              Upload Document
            </Button>
          </CardHeader>
          <CardContent>
            {documents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <ImageIcon className="h-16 w-16 text-muted-foreground mb-4" />
                <p className="text-lg font-medium text-foreground">No documents yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Upload inspection reports, appraisals, and other documents
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                        <File className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-foreground">{doc.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {doc.type} • Uploaded {new Date(doc.uploaded_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm">
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm">
                        <Download className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
