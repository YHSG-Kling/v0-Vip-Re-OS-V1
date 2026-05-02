"use client"

import { useState, useTransition, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Search,
  Star,
  Phone,
  Mail,
  Globe,
  Calendar,
  DollarSign,
  Building2,
  Users,
  Clock,
  CheckCircle2,
  AlertCircle,
  Filter,
  TrendingUp,
  Plus,
  Paperclip,
  Package,
} from "lucide-react"
import {
  searchVendors,
  createVendorBooking,
  rateVendorBooking,
  markBookingComplete,
  getVendorCostComparison,
  getVendorReviews,
} from "@/app/actions/vendor-marketplace"
import {
  createVendorRecordAction,
  attachVendorDeliverableAction,
} from "@/app/actions/vendors-kernel"

interface Vendor {
  id: string
  name: string
  email: string | null
  phone: string | null
  website: string | null
  category: string | null
  notes: string | null
  rating: number | null
  brokerage_id: string | null
  vendor_rating?: {
    avg_agent_rating: number | null
    avg_client_rating: number | null
    total_bookings: number
    five_star_count: number
    one_star_count: number
  } | null
}

interface Booking {
  id: string
  vendor_id: string
  transaction_id: string
  service_type: string
  scheduled_date: string
  cost: number | null
  status: string
  agent_rating: number | null
  completed_at: string | null
  vendors?: { id: string; name: string; category: string; rating: number | null }
  transactions?: { id: string; property_address: string }
}

interface Transaction {
  id: string
  property_address: string
  stage: string
}

interface Deliverable {
  id: string
  doc_name: string | null
  file_url: string
  notes: string | null
  created_at: string
  metadata: {
    vendor_booking_id?: string
    vendor_id?: string
    service_type?: string
  } | null
}

interface VendorDirectoryClientProps {
  initialVendors: Vendor[]
  recentBookings: Booking[]
  pendingRatings: Booking[]
  transactions: Transaction[]
  serviceTypes: string[]
  brokerageId: string
  userRole: string
  deliverables?: Deliverable[]
}

export function VendorDirectoryClient({
  initialVendors,
  recentBookings,
  pendingRatings,
  transactions,
  serviceTypes,
  brokerageId,
  userRole,
  deliverables = [],
}: VendorDirectoryClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Search & filter state
  const [vendors, setVendors] = useState<Vendor[]>(initialVendors)
  const [searchName, setSearchName] = useState("")
  const [filterServiceType, setFilterServiceType] = useState<string>("")
  const [filterMinRating, setFilterMinRating] = useState<string>("")

  // Create Vendor dialog state
  const [createVendorOpen, setCreateVendorOpen] = useState(false)
  const [newVendorName, setNewVendorName] = useState("")
  const [newVendorCategory, setNewVendorCategory] = useState("")
  const [newVendorPhone, setNewVendorPhone] = useState("")
  const [newVendorEmail, setNewVendorEmail] = useState("")
  const [newVendorWebsite, setNewVendorWebsite] = useState("")
  const [newVendorNotes, setNewVendorNotes] = useState("")
  const [createVendorError, setCreateVendorError] = useState("")

  // Attach Deliverable dialog state
  const [deliverableDialogOpen, setDeliverableDialogOpen] = useState(false)
  const [deliverableBookingId, setDeliverableBookingId] = useState("")
  const [deliverableVendorId, setDeliverableVendorId] = useState("")
  const [deliverableUrl, setDeliverableUrl] = useState("")
  const [deliverableDescription, setDeliverableDescription] = useState("")
  const [deliverableFileName, setDeliverableFileName] = useState("")
  const [deliverableError, setDeliverableError] = useState("")

  // Booking dialog state
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false)
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null)
  const [bookingTransactionId, setBookingTransactionId] = useState("")
  const [bookingServiceType, setBookingServiceType] = useState("")
  const [bookingDate, setBookingDate] = useState("")
  const [bookingCost, setBookingCost] = useState("")
  const [bookingNotes, setBookingNotes] = useState("")
  // Real-time availability: existing bookings on selected date for selected vendor
  const [vendorBookingsOnDate, setVendorBookingsOnDate] = useState<{ scheduled_date: string; status: string; service_type: string | null }[]>([])
  const [availabilityLoading, setAvailabilityLoading] = useState(false)

  // Rating dialog state
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false)
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [ratingValue, setRatingValue] = useState(5)
  const [ratingReview, setRatingReview] = useState("")

  // Cost comparison state
  const [costComparisonDialogOpen, setCostComparisonDialogOpen] = useState(false)
  const [costComparisonType, setCostComparisonType] = useState("")
  const [costComparisonData, setCostComparisonData] = useState<any[]>([])

  // Reviews dialog state
  const [reviewsDialogOpen, setReviewsDialogOpen] = useState(false)
  const [reviewsVendor, setReviewsVendor] = useState<Vendor | null>(null)
  const [vendorReviews, setVendorReviews] = useState<any[]>([])

  // Availability check: load bookings for selected vendor on selected date
  useEffect(() => {
    if (!selectedVendor || !bookingDate) {
      setVendorBookingsOnDate([])
      return
    }
    let cancelled = false
    setAvailabilityLoading(true)
    import("@/lib/supabase/client").then(({ createClient }) => {
      const supabase = createClient()
      const dayStart = `${bookingDate}T00:00:00`
      const dayEnd   = `${bookingDate}T23:59:59`
      supabase
        .from("vendor_bookings")
        .select("scheduled_date, status, service_type")
        .eq("vendor_id", selectedVendor.id)
        .gte("scheduled_date", dayStart)
        .lte("scheduled_date", dayEnd)
        .then(({ data }: { data: { scheduled_date: string; status: string; service_type: string | null }[] | null }) => {
          if (!cancelled) {
            setVendorBookingsOnDate(data ?? [])
            setAvailabilityLoading(false)
          }
        })
    })
    return () => { cancelled = true }
  }, [selectedVendor?.id, bookingDate])

  const handleCreateVendor = () => {
    if (!newVendorName.trim()) {
      setCreateVendorError("Vendor name is required.")
      return
    }
    setCreateVendorError("")
    startTransition(async () => {
      const result = await createVendorRecordAction({
        name:     newVendorName.trim(),
        category: newVendorCategory || undefined,
        phone:    newVendorPhone || undefined,
        email:    newVendorEmail || undefined,
        website:  newVendorWebsite || undefined,
        notes:    newVendorNotes || undefined,
      })
      if (!result.success) {
        setCreateVendorError(result.error ?? "Failed to create vendor.")
        return
      }
      setCreateVendorOpen(false)
      setNewVendorName("")
      setNewVendorCategory("")
      setNewVendorPhone("")
      setNewVendorEmail("")
      setNewVendorWebsite("")
      setNewVendorNotes("")
      router.refresh()
    })
  }

  const handleAttachDeliverable = () => {
    if (!deliverableBookingId || !deliverableUrl || !deliverableDescription) {
      setDeliverableError("Booking, URL and description are required.")
      return
    }
    setDeliverableError("")
    startTransition(async () => {
      const result = await attachVendorDeliverableAction({
        bookingId:   deliverableBookingId,
        vendorId:    deliverableVendorId,
        documentUrl: deliverableUrl,
        description: deliverableDescription,
        fileName:    deliverableFileName || undefined,
      })
      if (!result.success) {
        setDeliverableError(result.error ?? "Failed to attach deliverable.")
        return
      }
      setDeliverableDialogOpen(false)
      setDeliverableBookingId("")
      setDeliverableVendorId("")
      setDeliverableUrl("")
      setDeliverableDescription("")
      setDeliverableFileName("")
      router.refresh()
    })
  }

  const handleSearch = () => {
    startTransition(async () => {
      const results = await searchVendors({
        name: searchName || undefined,
        serviceType: filterServiceType || undefined,
        minRating: filterMinRating ? parseFloat(filterMinRating) : undefined,
      })
      setVendors(results)
    })
  }

  const handleClearFilters = () => {
    setSearchName("")
    setFilterServiceType("")
    setFilterMinRating("")
    startTransition(async () => {
      const results = await searchVendors({ limit: 50 })
      setVendors(results)
    })
  }

  const handleBookVendor = (vendor: Vendor) => {
    setSelectedVendor(vendor)
    setBookingServiceType(vendor.category || "")
    setBookingDialogOpen(true)
  }

  const submitBooking = () => {
    if (!selectedVendor || !bookingTransactionId || !bookingDate) return

    startTransition(async () => {
      await createVendorBooking({
        vendorId: selectedVendor.id,
        transactionId: bookingTransactionId,
        serviceType: bookingServiceType,
        scheduledDate: bookingDate,
        cost: bookingCost ? parseFloat(bookingCost) : undefined,
        notes: bookingNotes || undefined,
      })
      setBookingDialogOpen(false)
      resetBookingForm()
      router.refresh()
    })
  }

  const resetBookingForm = () => {
    setSelectedVendor(null)
    setBookingTransactionId("")
    setBookingServiceType("")
    setBookingDate("")
    setBookingCost("")
    setBookingNotes("")
  }

  const handleRateBooking = (booking: Booking) => {
    setSelectedBooking(booking)
    setRatingValue(5)
    setRatingReview("")
    setRatingDialogOpen(true)
  }

  const submitRating = () => {
    if (!selectedBooking) return

    startTransition(async () => {
      await rateVendorBooking({
        bookingId: selectedBooking.id,
        rating: ratingValue,
        review: ratingReview || undefined,
      })
      setRatingDialogOpen(false)
      setSelectedBooking(null)
      router.refresh()
    })
  }

  const handleMarkComplete = (bookingId: string) => {
    startTransition(async () => {
      await markBookingComplete(bookingId)
      router.refresh()
    })
  }

  const handleShowCostComparison = (serviceType: string) => {
    setCostComparisonType(serviceType)
    startTransition(async () => {
      const data = await getVendorCostComparison(serviceType)
      setCostComparisonData(data)
      setCostComparisonDialogOpen(true)
    })
  }

  const handleShowReviews = (vendor: Vendor) => {
    setReviewsVendor(vendor)
    startTransition(async () => {
      const reviews = await getVendorReviews(vendor.id)
      setVendorReviews(reviews)
      setReviewsDialogOpen(true)
    })
  }

  const renderStars = (rating: number | null) => {
    if (!rating) return <span className="text-muted-foreground text-sm">No ratings</span>
    return (
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`h-4 w-4 ${star <= rating ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
          />
        ))}
        <span className="ml-1 text-sm font-medium">{rating.toFixed(1)}</span>
      </div>
    )
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-100 text-green-800">Completed</Badge>
      case "scheduled":
        return <Badge className="bg-blue-100 text-blue-800">Scheduled</Badge>
      case "in_progress":
        return <Badge className="bg-purple-100 text-purple-800">In Progress</Badge>
      case "cancelled":
        return <Badge variant="destructive">Cancelled</Badge>
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Vendor Directory</h1>
          <p className="text-muted-foreground">Find and book trusted vendors for your transactions</p>
        </div>
        <div className="flex items-center gap-3">
          {pendingRatings.length > 0 && (
            <Badge variant="secondary" className="text-sm px-3 py-1">
              {pendingRatings.length} Pending Rating{pendingRatings.length !== 1 ? "s" : ""}
            </Badge>
          )}
          <Button onClick={() => setCreateVendorOpen(true)} size="sm">
            <Plus className="h-4 w-4 mr-2" />
            New Vendor
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              Total Vendors
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{vendors.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Recent Bookings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{recentBookings.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Star className="h-4 w-4" />
              Pending Ratings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{pendingRatings.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Service Types
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{serviceTypes.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="directory" className="space-y-4">
        <TabsList>
          <TabsTrigger value="directory">Vendor Directory</TabsTrigger>
          <TabsTrigger value="bookings">Recent Bookings</TabsTrigger>
          <TabsTrigger value="ratings">
            Rate Vendors
            {pendingRatings.length > 0 && (
              <Badge variant="destructive" className="ml-2">{pendingRatings.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="compare">Cost Comparison</TabsTrigger>
          <TabsTrigger value="deliverables" className="flex items-center gap-1.5">
            <Package className="h-4 w-4" />
            Deliverables
            {deliverables.length > 0 && (
              <Badge variant="secondary" className="ml-1">{deliverables.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Directory Tab */}
        <TabsContent value="directory" className="space-y-4">
          {/* Search & Filters */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Filter className="h-5 w-5" />
                Search & Filter
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by name..."
                      value={searchName}
                      onChange={(e) => setSearchName(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Service Type</Label>
                  <Select value={filterServiceType} onValueChange={setFilterServiceType}>
                    <SelectTrigger>
                      <SelectValue placeholder="All types" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">All types</SelectItem>
                      {serviceTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Min Rating</Label>
                  <Select value={filterMinRating} onValueChange={setFilterMinRating}>
                    <SelectTrigger>
                      <SelectValue placeholder="Any rating" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Any rating</SelectItem>
                      <SelectItem value="4">4+ stars</SelectItem>
                      <SelectItem value="3">3+ stars</SelectItem>
                      <SelectItem value="2">2+ stars</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>&nbsp;</Label>
                  <div className="flex gap-2">
                    <Button onClick={handleSearch} disabled={isPending} className="flex-1">
                      {isPending ? "Searching..." : "Search"}
                    </Button>
                    <Button variant="outline" onClick={handleClearFilters} className="bg-transparent">
                      Clear
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Vendor Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {vendors.map((vendor) => (
              <Card key={vendor.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{vendor.name}</CardTitle>
                      <CardDescription>{vendor.category || "General"}</CardDescription>
                    </div>
                    {!vendor.brokerage_id && (
                      <Badge variant="outline" className="text-xs">Global</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {renderStars(vendor.rating)}

                  {vendor.vendor_rating && (
                    <div className="text-xs text-muted-foreground">
                      {vendor.vendor_rating.total_bookings} booking(s) in your brokerage
                    </div>
                  )}

                  <div className="space-y-1 text-sm">
                    {vendor.phone && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Phone className="h-3 w-3" />
                        {vendor.phone}
                      </div>
                    )}
                    {vendor.email && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Mail className="h-3 w-3" />
                        {vendor.email}
                      </div>
                    )}
                    {vendor.website && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Globe className="h-3 w-3" />
                        <a href={vendor.website} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          Website
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button
                      size="sm"
                      onClick={() => handleBookVendor(vendor)}
                      className="flex-1"
                    >
                      Book
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleShowReviews(vendor)}
                      className="bg-transparent"
                    >
                      Reviews
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {vendors.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Building2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No vendors found matching your criteria.</p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Bookings Tab */}
        <TabsContent value="bookings" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Bookings</CardTitle>
              <CardDescription>Vendor services booked for your transactions</CardDescription>
            </CardHeader>
            <CardContent>
              {recentBookings.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No recent bookings</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {recentBookings.map((booking) => (
                    <div
                      key={booking.id}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{booking.vendors?.name || "Unknown Vendor"}</span>
                          {getStatusBadge(booking.status)}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {booking.service_type} - {booking.transactions?.property_address || "Unknown Property"}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(booking.scheduled_date).toLocaleDateString()}
                          </span>
                          {booking.cost && (
                            <span className="flex items-center gap-1">
                              <DollarSign className="h-3 w-3" />${booking.cost}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {booking.status === "scheduled" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleMarkComplete(booking.id)}
                            disabled={isPending}
                            className="bg-transparent"
                          >
                            Mark Complete
                          </Button>
                        )}
                        {booking.status === "completed" && !booking.agent_rating && (
                          <Button
                            size="sm"
                            onClick={() => handleRateBooking(booking)}
                          >
                            Rate
                          </Button>
                        )}
                        {booking.agent_rating && (
                          <div className="flex items-center gap-1">
                            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                            <span className="text-sm font-medium">{booking.agent_rating}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Ratings Tab */}
        <TabsContent value="ratings" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Pending Ratings</CardTitle>
              <CardDescription>Rate vendors after completed services to help your team</CardDescription>
            </CardHeader>
            <CardContent>
              {pendingRatings.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <CheckCircle2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>All completed bookings have been rated!</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingRatings.map((booking) => (
                    <div
                      key={booking.id}
                      className="flex items-center justify-between p-4 border rounded-lg bg-orange-50 border-orange-200"
                    >
                      <div className="space-y-1">
                        <div className="font-medium">{booking.vendors?.name || "Unknown Vendor"}</div>
                        <div className="text-sm text-muted-foreground">
                          {booking.service_type} - {booking.transactions?.property_address}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Completed: {booking.completed_at ? new Date(booking.completed_at).toLocaleDateString() : "N/A"}
                        </div>
                      </div>
                      <Button onClick={() => handleRateBooking(booking)}>
                        <Star className="h-4 w-4 mr-2" />
                        Rate Now
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Cost Comparison Tab */}
        <TabsContent value="compare" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Cost Comparison by Service Type
              </CardTitle>
              <CardDescription>Compare vendor costs based on past bookings in your brokerage</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {serviceTypes.map((type) => (
                  <Button
                    key={type}
                    variant="outline"
                    onClick={() => handleShowCostComparison(type)}
                    disabled={isPending}
                    className="bg-transparent"
                  >
                    {type}
                  </Button>
                ))}
              </div>
              {serviceTypes.length === 0 && (
                <p className="text-muted-foreground text-center py-4">
                  No service types found. Book vendors to see cost comparisons.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Deliverables Tab */}
        <TabsContent value="deliverables" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Package className="h-5 w-5" />
                    Vendor Deliverables
                  </CardTitle>
                  <CardDescription>Documents and files delivered by vendors for bookings</CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDeliverableDialogOpen(true)}
                  className="bg-transparent"
                >
                  <Paperclip className="h-4 w-4 mr-2" />
                  Attach Deliverable
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {deliverables.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <Package className="h-12 w-12 mx-auto mb-4 opacity-40" />
                  <p className="font-medium">No deliverables yet</p>
                  <p className="text-sm mt-1">
                    Attach vendor-supplied documents or files to a booking using the button above.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {deliverables.map((doc) => (
                    <div
                      key={doc.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="font-medium truncate">{doc.doc_name ?? doc.notes ?? "Untitled"}</div>
                        {doc.notes && doc.doc_name && (
                          <div className="text-sm text-muted-foreground">{doc.notes}</div>
                        )}
                        {doc.metadata?.service_type && (
                          <Badge variant="secondary" className="text-xs">
                            {doc.metadata.service_type}
                          </Badge>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {new Date(doc.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <a
                        href={doc.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-4 shrink-0"
                      >
                        <Button size="sm" variant="outline" className="bg-transparent">
                          View
                        </Button>
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Booking Dialog */}
      <Dialog open={bookingDialogOpen} onOpenChange={setBookingDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Book Vendor</DialogTitle>
            <DialogDescription>
              {selectedVendor?.name} - {selectedVendor?.category}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Transaction</Label>
              <Select value={bookingTransactionId} onValueChange={setBookingTransactionId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select transaction" />
                </SelectTrigger>
                <SelectContent>
                  {transactions.map((txn) => (
                    <SelectItem key={txn.id} value={txn.id}>
                      {txn.property_address} ({txn.stage})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Service Type</Label>
              <Input
                value={bookingServiceType}
                onChange={(e) => setBookingServiceType(e.target.value)}
                placeholder="e.g., Home Inspection"
              />
            </div>

            <div className="space-y-2">
              <Label>Scheduled Date</Label>
              <Input
                type="date"
                value={bookingDate}
                onChange={(e) => setBookingDate(e.target.value)}
              />
              {bookingDate && (
                <div className="text-xs mt-1">
                  {availabilityLoading ? (
                    <span className="text-muted-foreground">Checking availability…</span>
                  ) : vendorBookingsOnDate.length === 0 ? (
                    <span className="text-emerald-700 font-medium">✓ Available on this date</span>
                  ) : (
                    <div>
                      <span className="text-amber-700 font-medium">
                        {vendorBookingsOnDate.length} booking{vendorBookingsOnDate.length > 1 ? "s" : ""} already on this date:
                      </span>
                      <ul className="ml-2 mt-0.5 space-y-0.5">
                        {vendorBookingsOnDate.map((b, i) => (
                          <li key={i} className="text-muted-foreground capitalize">
                            • {b.service_type ?? "booking"} ({b.status})
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Estimated Cost ($)</Label>
              <Input
                type="number"
                value={bookingCost}
                onChange={(e) => setBookingCost(e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={bookingNotes}
                onChange={(e) => setBookingNotes(e.target.value)}
                placeholder="Optional notes..."
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBookingDialogOpen(false)} className="bg-transparent">
              Cancel
            </Button>
            <Button
              onClick={submitBooking}
              disabled={isPending || !bookingTransactionId || !bookingDate}
            >
              {isPending ? "Booking..." : "Book Vendor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rating Dialog */}
      <Dialog open={ratingDialogOpen} onOpenChange={setRatingDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rate Vendor</DialogTitle>
            <DialogDescription>
              {selectedBooking?.vendors?.name} - {selectedBooking?.service_type}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Rating</Label>
              <div className="flex items-center gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setRatingValue(star)}
                    className="p-1"
                  >
                    <Star
                      className={`h-8 w-8 transition-colors ${
                        star <= ratingValue ? "fill-yellow-400 text-yellow-400" : "text-gray-300 hover:text-yellow-300"
                      }`}
                    />
                  </button>
                ))}
                <span className="ml-2 text-lg font-medium">{ratingValue}/5</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Review (Optional)</Label>
              <Textarea
                value={ratingReview}
                onChange={(e) => setRatingReview(e.target.value)}
                placeholder="Share your experience with this vendor..."
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Reviews are only visible to agents in your brokerage.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRatingDialogOpen(false)} className="bg-transparent">
              Cancel
            </Button>
            <Button onClick={submitRating} disabled={isPending}>
              {isPending ? "Submitting..." : "Submit Rating"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cost Comparison Dialog */}
      <Dialog open={costComparisonDialogOpen} onOpenChange={setCostComparisonDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cost Comparison: {costComparisonType}</DialogTitle>
            <DialogDescription>
              Based on past bookings in your brokerage
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {costComparisonData.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                No completed bookings with costs found for this service type.
              </p>
            ) : (
              <div className="space-y-3">
                {costComparisonData.map((vendor, idx) => (
                  <div
                    key={vendor.id}
                    className={`flex items-center justify-between p-3 border rounded-lg ${
                      idx === 0 ? "bg-green-50 border-green-200" : ""
                    }`}
                  >
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {vendor.name}
                        {idx === 0 && <Badge className="bg-green-600">Recommended</Badge>}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {renderStars(vendor.rating)}
                      </div>
                    </div>
                    <div className="text-right">
                      {vendor.avg_cost ? (
                        <>
                          <div className="font-bold text-lg">${vendor.avg_cost.toFixed(0)}</div>
                          <div className="text-xs text-muted-foreground">
                            avg of {vendor.booking_count} booking{vendor.booking_count !== 1 ? "s" : ""}
                          </div>
                          {vendor.min_cost !== vendor.max_cost && (
                            <div className="text-xs text-muted-foreground">
                              ${vendor.min_cost} - ${vendor.max_cost}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground text-sm">No cost data</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Reviews Dialog */}
      <Dialog open={reviewsDialogOpen} onOpenChange={setReviewsDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reviews: {reviewsVendor?.name}</DialogTitle>
            <DialogDescription>
              {reviewsVendor?.category} - {renderStars(reviewsVendor?.rating ?? null)}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 max-h-96 overflow-y-auto">
            {vendorReviews.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                No reviews yet for this vendor in your brokerage.
              </p>
            ) : (
              <div className="space-y-4">
                {vendorReviews.map((review) => (
                  <div key={review.id} className="p-3 border rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <Star
                            key={star}
                            className={`h-4 w-4 ${
                              star <= review.rating ? "fill-yellow-400 text-yellow-400" : "text-gray-300"
                            }`}
                          />
                        ))}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(review.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    {review.review && (
                      <p className="text-sm">{review.review}</p>
                    )}
                    <div className="text-xs text-muted-foreground mt-2">
                      - {review.users?.first_name} {review.users?.last_name}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Vendor Dialog */}
      <Dialog open={createVendorOpen} onOpenChange={setCreateVendorOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add New Vendor</DialogTitle>
            <DialogDescription>
              Create a new vendor record in your brokerage marketplace directory.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                placeholder="e.g., ABC Home Inspections"
              />
            </div>

            <div className="space-y-2">
              <Label>Category / Service Type</Label>
              <Input
                value={newVendorCategory}
                onChange={(e) => setNewVendorCategory(e.target.value)}
                placeholder="e.g., Home Inspection, Photography"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={newVendorPhone}
                  onChange={(e) => setNewVendorPhone(e.target.value)}
                  placeholder="(555) 000-0000"
                  type="tel"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  value={newVendorEmail}
                  onChange={(e) => setNewVendorEmail(e.target.value)}
                  placeholder="vendor@example.com"
                  type="email"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Website</Label>
              <Input
                value={newVendorWebsite}
                onChange={(e) => setNewVendorWebsite(e.target.value)}
                placeholder="https://vendor.com"
                type="url"
              />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={newVendorNotes}
                onChange={(e) => setNewVendorNotes(e.target.value)}
                placeholder="Optional notes about this vendor..."
                rows={2}
              />
            </div>

            {createVendorError && (
              <p className="text-sm text-destructive">{createVendorError}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateVendorOpen(false)
                setCreateVendorError("")
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button onClick={handleCreateVendor} disabled={isPending || !newVendorName.trim()}>
              {isPending ? "Creating..." : "Create Vendor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Attach Deliverable Dialog */}
      <Dialog open={deliverableDialogOpen} onOpenChange={setDeliverableDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Attach Vendor Deliverable</DialogTitle>
            <DialogDescription>
              Link a document or file delivered by a vendor to a specific booking.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>
                Booking <span className="text-destructive">*</span>
              </Label>
              <Select value={deliverableBookingId} onValueChange={(val) => {
                setDeliverableBookingId(val)
                const booking = recentBookings.find(b => b.id === val)
                if (booking) setDeliverableVendorId(booking.vendor_id)
              }}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a booking" />
                </SelectTrigger>
                <SelectContent>
                  {recentBookings.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.vendors?.name ?? "Vendor"} — {b.service_type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>
                File URL <span className="text-destructive">*</span>
              </Label>
              <Input
                value={deliverableUrl}
                onChange={(e) => setDeliverableUrl(e.target.value)}
                placeholder="https://..."
                type="url"
              />
            </div>

            <div className="space-y-2">
              <Label>File Name</Label>
              <Input
                value={deliverableFileName}
                onChange={(e) => setDeliverableFileName(e.target.value)}
                placeholder="e.g., inspection-report.pdf"
              />
            </div>

            <div className="space-y-2">
              <Label>
                Description <span className="text-destructive">*</span>
              </Label>
              <Textarea
                value={deliverableDescription}
                onChange={(e) => setDeliverableDescription(e.target.value)}
                placeholder="Brief description of the deliverable..."
                rows={2}
              />
            </div>

            {deliverableError && (
              <p className="text-sm text-destructive">{deliverableError}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeliverableDialogOpen(false)
                setDeliverableError("")
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAttachDeliverable}
              disabled={isPending || !deliverableBookingId || !deliverableUrl || !deliverableDescription}
            >
              {isPending ? "Attaching..." : "Attach Deliverable"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
