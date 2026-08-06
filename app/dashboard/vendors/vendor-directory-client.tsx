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
import { VendorCategorySelect } from "@/app/components/vendors/vendor-category-select"
import { VENDOR_CATEGORY_LABELS, type VendorCategory } from "@/lib/kernel/vendor-categories"

/** Stored token → the words a broker reads. vendors.category is lowercase_snake
 *  ("pest_control", "title"), which is right for a vocabulary and wrong for a
 *  card heading. Falls back to a title-cased form so a pre-m304 row still reads
 *  as words rather than as a token. */
function categoryLabel(raw: string | null | undefined): string {
  if (!raw) return "General"
  return (
    VENDOR_CATEGORY_LABELS[raw as VendorCategory] ??
    raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  )
}
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
  ShieldCheck,
  ShieldAlert,
} from "lucide-react"
import {
  searchVendors,
  createVendorBooking,
  rateVendorBooking,
  markBookingComplete,
  getVendorCostComparison,
  getVendorReviews,
  submitVendorReview,
  flagVendorReview,
} from "@/app/actions/vendor-marketplace"
import {
  createVendorRecordAction,
  attachVendorDeliverableAction,
  updateVendorRecordAction,
  assignVendorToListingAction,
  assignVendorToTransactionAction,
  updateVendorBookingStatusAction,
} from "@/app/actions/vendors-kernel"
import { recordVendorInsuranceAction } from "@/app/actions/vendor-verification"
import {
  readVendorInsurance,
  type InsurancePosture,
  type InsuranceRecord,
} from "@/lib/vendors/insurance-posture"

/** vendor_assignments.assignment_type is CHECK-constrained to exactly these ten
 *  values — a DIFFERENT and much shorter vocabulary than vendors.category (38
 *  values) and than the free-text service_type on vendor_bookings. The picker
 *  below cannot express anything outside it, and the server action re-checks the
 *  same list before the kernel is called. */
const VENDOR_ASSIGNMENT_TYPES = [
  "inspector",
  "lender",
  "title",
  "stager",
  "photographer",
  "cleaner",
  "contractor",
  "mover",
  "insurance",
  "other",
] as const

/** vendor_bookings.status transitions the kernel will accept, keyed by the
 *  status a booking is currently in. Mirrors BOOKING_STATUS_TRANSITIONS in
 *  lib/kernel/vendors.ts, which mirrors the live CHECK
 *  (booked | confirmed | completed | cancelled | no_show). Offering a button for
 *  a transition the kernel refuses would just be a guaranteed error message. */
const BOOKING_NEXT_STATUSES: Record<string, Array<"confirmed" | "completed" | "cancelled" | "no_show">> = {
  booked: ["confirmed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
}

const BOOKING_STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirm",
  completed: "Mark complete",
  cancelled: "Cancel",
  no_show: "No-show",
}

/** Badge styling per insurance posture. Grey is reserved for the two states we
 *  genuinely do not know ("never" / "no_expiry") — colouring an unknown green or
 *  red would be the same fabricated verdict the server action refuses to make. */
const INSURANCE_BADGE: Record<InsurancePosture, string> = {
  verified:  "bg-green-100 text-green-800 border-green-200",
  expiring:  "bg-amber-100 text-amber-900 border-amber-300",
  expired:   "bg-red-100 text-red-800 border-red-300",
  no_expiry: "bg-muted text-muted-foreground border-transparent",
  never:     "bg-muted text-muted-foreground border-transparent",
}

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
  /** m376 credential bag — the certificate of insurance lives under `.insurance`. */
  compliance_credentials?: Record<string, InsuranceRecord | null | undefined> | null
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

interface Listing {
  id: string
  address: string | null
  status: string | null
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
  listings?: Listing[]
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
  listings = [],
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
  const [newVendorCategory, setNewVendorCategory] = useState<VendorCategory | "">("")
  const [newVendorPhone, setNewVendorPhone] = useState("")
  const [newVendorEmail, setNewVendorEmail] = useState("")
  const [newVendorWebsite, setNewVendorWebsite] = useState("")
  const [newVendorNotes, setNewVendorNotes] = useState("")
  const [createVendorError, setCreateVendorError] = useState("")

  // Edit Vendor dialog state (updateVendorRecordAction)
  const [editVendorOpen, setEditVendorOpen] = useState(false)
  const [editVendor, setEditVendor] = useState<Vendor | null>(null)
  const [editName, setEditName] = useState("")
  const [editCategory, setEditCategory] = useState<VendorCategory | "">("")
  const [editPhone, setEditPhone] = useState("")
  const [editEmail, setEditEmail] = useState("")
  const [editWebsite, setEditWebsite] = useState("")
  const [editNotes, setEditNotes] = useState("")
  const [editVendorError, setEditVendorError] = useState("")

  // Insurance dialog state (recordVendorInsuranceAction). The certificate of
  // insurance was previously recordable ONLY from the approval queue, which
  // lists status='pending' vendors — so once a vendor was approved, or once the
  // nightly sweep suspended them for a lapse, there was NOWHERE in the product
  // to record the renewal. This is that surface.
  const [insuranceDialogOpen, setInsuranceDialogOpen] = useState(false)
  const [insuranceVendor, setInsuranceVendor] = useState<Vendor | null>(null)
  const [insCarrier, setInsCarrier] = useState("")
  const [insPolicyNumber, setInsPolicyNumber] = useState("")
  const [insCoverage, setInsCoverage] = useState("")
  const [insEffective, setInsEffective] = useState("")
  const [insExpiry, setInsExpiry] = useState("")
  const [insUrl, setInsUrl] = useState("")
  const [insuranceError, setInsuranceError] = useState("")
  const [insuranceNotice, setInsuranceNotice] = useState("")

  // Assign to Listing dialog state (assignVendorToListingAction)
  const [listingDialogOpen, setListingDialogOpen] = useState(false)
  const [listingVendor, setListingVendor] = useState<Vendor | null>(null)
  const [listingId, setListingId] = useState("")
  const [listingServiceType, setListingServiceType] = useState("")
  const [listingDate, setListingDate] = useState("")
  const [listingCost, setListingCost] = useState("")
  const [listingNotes, setListingNotes] = useState("")
  const [listingError, setListingError] = useState("")
  const [listingNotice, setListingNotice] = useState("")

  // Assign to Transaction dialog state (assignVendorToTransactionAction)
  const [assignDialogOpen, setAssignDialogOpen] = useState(false)
  const [assignVendor, setAssignVendor] = useState<Vendor | null>(null)
  const [assignTransactionId, setAssignTransactionId] = useState("")
  const [assignType, setAssignType] = useState<string>("")
  const [assignDate, setAssignDate] = useState("")
  const [assignNotes, setAssignNotes] = useState("")
  const [assignError, setAssignError] = useState("")
  const [assignNotice, setAssignNotice] = useState("")

  // Booking status transitions (updateVendorBookingStatusAction)
  const [bookingStatuses, setBookingStatuses] = useState<Record<string, string>>({})
  const [statusBookingId, setStatusBookingId] = useState<string | null>(null)
  const [statusError, setStatusError] = useState("")
  const [statusNotice, setStatusNotice] = useState("")

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

  // Write-a-review state. submitVendorReview is the transaction-linked lane:
  // rateVendorBooking only exists once a booking has been completed and rated,
  // so a vendor an agent worked with off-booking had no way to be reviewed.
  const [newReviewRating, setNewReviewRating] = useState(5)
  const [newReviewHeadline, setNewReviewHeadline] = useState("")
  const [newReviewBody, setNewReviewBody] = useState("")
  const [newReviewTransactionId, setNewReviewTransactionId] = useState("")
  const [reviewFormError, setReviewFormError] = useState("")
  const [reviewFormNotice, setReviewFormNotice] = useState("")
  const [flaggingReviewId, setFlaggingReviewId] = useState<string | null>(null)

  // Calendar overlay: all bookings for selected vendor in next 30 days
  const [vendorCalendarBookings, setVendorCalendarBookings] = useState<{ date: string; count: number }[]>([])
  const [calendarLoading, setCalendarLoading] = useState(false)

  useEffect(() => {
    if (!selectedVendor || !bookingDialogOpen) {
      setVendorCalendarBookings([])
      setVendorBookingsOnDate([])
      return
    }
    let cancelled = false
    setCalendarLoading(true)
    import("@/lib/supabase/client").then(({ createClient }) => {
      const supabase = createClient()
      const today = new Date()
      const in30 = new Date(today); in30.setDate(in30.getDate() + 30)
      supabase
        .from("vendor_bookings")
        .select("scheduled_date, status, service_type")
        .eq("vendor_id", selectedVendor.id)
        .gte("scheduled_date", today.toISOString().slice(0, 10))
        .lte("scheduled_date", in30.toISOString().slice(0, 10))
        .then(({ data }: { data: { scheduled_date: string; status: string; service_type: string | null }[] | null }) => {
          if (cancelled) return
          const byDate: Record<string, number> = {}
          for (const b of data ?? []) {
            const d = (b.scheduled_date ?? "").slice(0, 10)
            if (d) byDate[d] = (byDate[d] ?? 0) + 1
          }
          setVendorCalendarBookings(Object.entries(byDate).map(([date, count]) => ({ date, count })))
          setCalendarLoading(false)
        })
    })
    return () => { cancelled = true }
  }, [selectedVendor?.id, bookingDialogOpen])

  // Availability check: existing bookings on selected date
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

  // ─── EDIT a vendor record ────────────────────────────────────────────────
  // A vendor could be created and never corrected — a wrong phone number or a
  // miscategorised trade was permanent from this screen. The category picker is
  // the same constraint-safe control the create dialog uses; the placement flags
  // (preferred / display_priority / visible_in_portal) are deliberately NOT here,
  // because those are sold and are written only by the premium-placement lane.
  const openEditVendor = (vendor: Vendor) => {
    setEditVendor(vendor)
    setEditName(vendor.name ?? "")
    setEditCategory((vendor.category as VendorCategory | null) ?? "")
    setEditPhone(vendor.phone ?? "")
    setEditEmail(vendor.email ?? "")
    setEditWebsite(vendor.website ?? "")
    setEditNotes(vendor.notes ?? "")
    setEditVendorError("")
    setEditVendorOpen(true)
  }

  const handleUpdateVendor = () => {
    if (!editVendor) return
    if (!editName.trim()) {
      setEditVendorError("Vendor name is required.")
      return
    }
    setEditVendorError("")
    startTransition(async () => {
      const result = await updateVendorRecordAction({
        vendorId: editVendor.id,
        patch: {
          name: editName.trim(),
          ...(editCategory ? { category: editCategory } : {}),
          phone: editPhone.trim(),
          email: editEmail.trim(),
          website: editWebsite.trim(),
          notes: editNotes.trim(),
        },
      })
      if (!result.success) {
        setEditVendorError(result.error ?? "Failed to update vendor.")
        return
      }
      // Only now does the local list move — the dialog never closes on a refusal.
      setVendors((prev) =>
        prev.map((v) =>
          v.id === editVendor.id
            ? {
                ...v,
                name: editName.trim(),
                category: editCategory || v.category,
                phone: editPhone.trim() || null,
                email: editEmail.trim() || null,
                website: editWebsite.trim() || null,
                notes: editNotes.trim() || null,
              }
            : v,
        ),
      )
      setEditVendorOpen(false)
      setEditVendor(null)
      router.refresh()
    })
  }

  // ─── RECORD a vendor's CERTIFICATE OF INSURANCE ──────────────────────────
  // Pre-fills from whatever is already on file so an admin can see the policy
  // they are replacing rather than typing blind into an empty form.
  const openInsuranceDialog = (vendor: Vendor) => {
    const current = readVendorInsurance(vendor.compliance_credentials, new Date())
    setInsuranceVendor(vendor)
    setInsCarrier(current.carrier ?? "")
    setInsPolicyNumber(current.policyNumber ?? "")
    setInsCoverage(current.coverageAmount != null ? String(current.coverageAmount) : "")
    setInsEffective(current.effectiveDate ?? "")
    setInsExpiry(current.expiry ?? "")
    setInsUrl(current.certificateUrl ?? "")
    setInsuranceError("")
    setInsuranceNotice("")
    setInsuranceDialogOpen(true)
  }

  const handleRecordInsurance = () => {
    if (!insuranceVendor) return
    setInsuranceError("")
    setInsuranceNotice("")
    startTransition(async () => {
      const result = await recordVendorInsuranceAction({
        vendorId: insuranceVendor.id,
        carrier: insCarrier.trim(),
        policyNumber: insPolicyNumber.trim(),
        coverageAmount: Number(insCoverage),
        effectiveDate: insEffective,
        expiry: insExpiry,
        certificateUrl: insUrl.trim() || undefined,
      })
      // READ THE OUTCOME. A refusal (not an admin, vendor outside your
      // brokerage, a date the CHECK rejects) leaves the dialog open showing the
      // server's own words, and the list is NOT moved — the badge must never
      // claim a certificate that was not stored.
      if (!result.success) {
        setInsuranceError(result.error)
        return
      }
      // The verdict below is the server's, computed from the row it read back.
      setInsuranceNotice(result.status.detail)
      setVendors((prev) =>
        prev.map((v) =>
          v.id === insuranceVendor.id
            ? {
                ...v,
                compliance_credentials: {
                  ...(v.compliance_credentials ?? {}),
                  insurance: {
                    carrier: result.status.carrier,
                    policy_number: result.status.policyNumber,
                    coverage_amount: result.status.coverageAmount,
                    effective_date: result.status.effectiveDate,
                    expiry: result.status.expiry,
                    url: result.status.certificateUrl,
                    verified_at: result.status.verifiedAt,
                    verified_by: result.status.verifiedBy,
                  },
                },
              }
            : v,
        ),
      )
      router.refresh()
    })
  }

  // ─── BOOK a vendor against a LISTING ─────────────────────────────────────
  const openListingDialog = (vendor: Vendor) => {
    setListingVendor(vendor)
    setListingServiceType(vendor.category || "")
    setListingId("")
    setListingDate("")
    setListingCost("")
    setListingNotes("")
    setListingError("")
    setListingNotice("")
    setListingDialogOpen(true)
  }

  const handleAssignToListing = () => {
    if (!listingVendor) return
    if (!listingId || !listingServiceType.trim()) {
      setListingError("Pick a listing and name the service.")
      return
    }
    setListingError("")
    startTransition(async () => {
      const result = await assignVendorToListingAction({
        vendorId: listingVendor.id,
        listingId,
        serviceType: listingServiceType.trim(),
        scheduledDate: listingDate || undefined,
        cost: listingCost ? parseFloat(listingCost) : undefined,
        notes: listingNotes || undefined,
      })
      if (!result.success) {
        setListingError(result.error ?? "Failed to book that vendor for the listing.")
        return
      }
      setListingNotice("Booked against the listing — the vendor has been emailed the job details.")
      setListingDialogOpen(false)
      setListingVendor(null)
      router.refresh()
    })
  }

  // ─── ASSIGN a vendor to a TRANSACTION ────────────────────────────────────
  // An assignment is a DIFFERENT record from a booking: it writes
  // vendor_assignments plus a vendor_jobs row, which is what the deal screen and
  // the vendor's own job list read. Nothing on the platform could create one.
  const openAssignDialog = (vendor: Vendor) => {
    setAssignVendor(vendor)
    setAssignTransactionId("")
    setAssignType(
      (VENDOR_ASSIGNMENT_TYPES as readonly string[]).includes(vendor.category ?? "")
        ? (vendor.category as string)
        : "",
    )
    setAssignDate("")
    setAssignNotes("")
    setAssignError("")
    setAssignNotice("")
    setAssignDialogOpen(true)
  }

  const handleAssignToTransaction = () => {
    if (!assignVendor) return
    if (!assignTransactionId || !assignType) {
      setAssignError("Pick a deal and an assignment type.")
      return
    }
    setAssignError("")
    startTransition(async () => {
      const result = await assignVendorToTransactionAction({
        vendorId: assignVendor.id,
        transactionId: assignTransactionId,
        assignmentType: assignType,
        scheduledDate: assignDate || undefined,
        notes: assignNotes || undefined,
      })
      if (!result.success) {
        setAssignError(result.error ?? "Failed to assign that vendor to the deal.")
        return
      }
      setAssignNotice("Assigned — the deal now carries a vendor job for this work.")
      setAssignDialogOpen(false)
      setAssignVendor(null)
      router.refresh()
    })
  }

  // ─── TRANSITION a booking's status ───────────────────────────────────────
  // markBookingComplete can only ever say "completed". Confirming a booking a
  // vendor has accepted, cancelling one, or recording a no-show had no writer on
  // any screen — so a booking sat at "booked" forever and the no-show autopilot
  // had nothing to read.
  const handleBookingStatus = (
    bookingId: string,
    toStatus: "confirmed" | "completed" | "cancelled" | "no_show",
  ) => {
    setStatusBookingId(bookingId)
    setStatusError("")
    setStatusNotice("")
    startTransition(async () => {
      const result = await updateVendorBookingStatusAction({ bookingId, toStatus })
      if (!result.success) {
        setStatusError(result.error ?? "Could not change that booking's status.")
        setStatusBookingId(null)
        return
      }
      setBookingStatuses((prev) => ({ ...prev, [bookingId]: toStatus }))
      setStatusNotice(`Booking is now ${toStatus.replace(/_/g, " ")}.`)
      setStatusBookingId(null)
      router.refresh()
    })
  }

  /** The status the UI should believe for a booking: the one this session moved
   *  it to, otherwise the one the server sent. */
  const effectiveStatus = (booking: Booking) => bookingStatuses[booking.id] ?? booking.status

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
    setReviewFormError("")
    setReviewFormNotice("")
    setNewReviewRating(5)
    setNewReviewHeadline("")
    setNewReviewBody("")
    setNewReviewTransactionId("")
    startTransition(async () => {
      const reviews = await getVendorReviews(vendor.id)
      setVendorReviews(reviews)
      setReviewsDialogOpen(true)
    })
  }

  const handleSubmitReview = () => {
    if (!reviewsVendor) return
    setReviewFormError("")
    setReviewFormNotice("")
    if (newReviewBody.trim().length < 50) {
      setReviewFormError("A review needs at least 50 characters — shorter ones go to a human moderator instead of publishing.")
      return
    }
    startTransition(async () => {
      try {
        const result = await submitVendorReview({
          vendorId: reviewsVendor.id,
          rating: newReviewRating,
          body: newReviewBody.trim(),
          headline: newReviewHeadline.trim() || undefined,
          transactionId: newReviewTransactionId || undefined,
        })
        // Report what the server actually decided — screenReview may have routed
        // this to a human, and saying "published" would be a lie.
        setReviewFormNotice(
          result.moderationStatus === "approved"
            ? `Published${result.isVerified ? " as a verified review" : " (unverified — not linked to a deal you were a party to)"}.`
            : "Submitted for moderation — a broker admin will review it before it appears.",
        )
        setNewReviewBody("")
        setNewReviewHeadline("")
        const reviews = await getVendorReviews(reviewsVendor.id)
        setVendorReviews(reviews)
        router.refresh()
      } catch (err) {
        setReviewFormError(err instanceof Error ? err.message : "Could not submit the review")
      }
    })
  }

  const handleFlagReview = (reviewId: string) => {
    setFlaggingReviewId(reviewId)
    startTransition(async () => {
      try {
        const result = await flagVendorReview(reviewId, "inappropriate")
        setReviewFormNotice(
          result.status === "under_review"
            ? "Flagged — this review has reached the flag threshold and is now with a moderator."
            : `Flagged (${result.flagCount} flag${result.flagCount === 1 ? "" : "s"} so far).`,
        )
        if (reviewsVendor) setVendorReviews(await getVendorReviews(reviewsVendor.id))
      } catch (err) {
        setReviewFormError(err instanceof Error ? err.message : "Could not flag the review")
      } finally {
        setFlaggingReviewId(null)
      }
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
                  <Select
                    value={filterServiceType || "__all__"}
                    onValueChange={(v) => setFilterServiceType(v === "__all__" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All types" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All types</SelectItem>
                      {serviceTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {categoryLabel(type)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Min Rating</Label>
                  <Select
                    value={filterMinRating || "__any__"}
                    onValueChange={(v) => setFilterMinRating(v === "__any__" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Any rating" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">Any rating</SelectItem>
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
            {vendors.map((vendor) => {
              // Computed on every render from the STORED expiry — the bench
              // ages by itself. Nothing writes a "compliant" flag anywhere.
              const insurance = readVendorInsurance(vendor.compliance_credentials, new Date())
              return (
              <Card key={vendor.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{vendor.name}</CardTitle>
                      <CardDescription>{categoryLabel(vendor.category)}</CardDescription>
                    </div>
                    {!vendor.brokerage_id && (
                      <Badge variant="outline" className="text-xs">Global</Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {renderStars(vendor.rating)}

                  {/* INSURANCE POSTURE — four distinguishable states, never a
                      claim: green only when a stored expiry is still more than
                      60 days out, amber inside the reminder window, red once it
                      has passed, and grey when we have simply never checked. */}
                  <div className="flex items-center gap-2">
                    <Badge
                      className={`text-[11px] border ${INSURANCE_BADGE[insurance.posture]}`}
                      title={insurance.detail}
                    >
                      {insurance.posture === "expired" && <ShieldAlert className="h-3 w-3 mr-1" />}
                      {insurance.posture === "expiring" && <ShieldAlert className="h-3 w-3 mr-1" />}
                      {insurance.posture === "verified" && <ShieldCheck className="h-3 w-3 mr-1" />}
                      {insurance.label}
                    </Badge>
                    {insurance.coverageAmount != null && (
                      <span className="text-[11px] text-muted-foreground">
                        ${insurance.coverageAmount.toLocaleString()} limit
                      </span>
                    )}
                  </div>
                  {(insurance.posture === "expired" || insurance.posture === "expiring") && (
                    <p className="text-[11px] text-muted-foreground leading-snug">{insurance.detail}</p>
                  )}

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

                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      size="sm"
                      onClick={() => handleBookVendor(vendor)}
                      className="flex-1 min-w-[80px]"
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
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEditVendor(vendor)}
                      className="bg-transparent"
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant={insurance.posture === "expired" ? "destructive" : "outline"}
                      onClick={() => openInsuranceDialog(vendor)}
                      className={insurance.posture === "expired" ? "" : "bg-transparent"}
                      title="Record this vendor's certificate of insurance — carrier, policy, limit and expiry"
                    >
                      Insurance
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openAssignDialog(vendor)}
                      className="bg-transparent"
                      title="Create a vendor_assignments + vendor_jobs record on a deal"
                    >
                      Assign to deal
                    </Button>
                    {listings.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openListingDialog(vendor)}
                        className="bg-transparent"
                        title="Book this vendor against a listing (pre-contract work)"
                      >
                        Book for listing
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
              )
            })}
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
                  {statusError && <p className="text-sm text-destructive">{statusError}</p>}
                  {statusNotice && <p className="text-sm text-emerald-700">{statusNotice}</p>}
                  {recentBookings.map((booking) => (
                    <div
                      key={booking.id}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{booking.vendors?.name || "Unknown Vendor"}</span>
                          {getStatusBadge(effectiveStatus(booking))}
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
                      <div className="flex flex-wrap gap-2 justify-end">
                        {/* Full transition graph — confirm / cancel / no-show /
                            complete, offered only where the kernel will accept
                            them. A terminal booking shows no buttons at all. */}
                        {(BOOKING_NEXT_STATUSES[effectiveStatus(booking)] ?? []).map((next) => (
                          <Button
                            key={next}
                            size="sm"
                            variant={next === "cancelled" || next === "no_show" ? "ghost" : "outline"}
                            onClick={() => handleBookingStatus(booking.id, next)}
                            disabled={isPending && statusBookingId === booking.id}
                            className={next === "cancelled" || next === "no_show" ? "" : "bg-transparent"}
                          >
                            {BOOKING_STATUS_LABEL[next]}
                          </Button>
                        ))}
                        {effectiveStatus(booking) === "scheduled" && (
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
                        {effectiveStatus(booking) === "completed" && !booking.agent_rating && (
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
                    {categoryLabel(type)}
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
                      {/* asChild — the anchor IS the button, so the link is on
                          the control itself rather than on a wrapper. */}
                      <Button asChild size="sm" variant="outline" className="ml-4 shrink-0 bg-transparent">
                        <a href={doc.file_url} target="_blank" rel="noopener noreferrer">
                          View
                        </a>
                      </Button>
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
              {selectedVendor?.name} - {categoryLabel(selectedVendor?.category)}
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
              {/* 30-day mini calendar availability overlay */}
              {calendarLoading ? (
                <p className="text-xs text-muted-foreground">Loading availability…</p>
              ) : (
                <VendorAvailabilityCalendar
                  bookedDates={vendorCalendarBookings}
                  selectedDate={bookingDate}
                  onSelectDate={setBookingDate}
                />
              )}
              {bookingDate && !calendarLoading && (
                <div className="text-xs mt-1">
                  {availabilityLoading ? (
                    <span className="text-muted-foreground">Checking…</span>
                  ) : vendorBookingsOnDate.length === 0 ? (
                    <span className="text-emerald-700 font-medium">✓ Available on this date</span>
                  ) : (
                    <div>
                      <span className="text-amber-700 font-medium">
                        {vendorBookingsOnDate.length} existing booking{vendorBookingsOnDate.length > 1 ? "s" : ""} — confirm with vendor
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
              {categoryLabel(reviewsVendor?.category)} - {renderStars(reviewsVendor?.rating ?? null)}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 max-h-72 overflow-y-auto">
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
                    {review.headline && <p className="text-sm font-medium">{review.headline}</p>}
                    {review.review && (
                      <p className="text-sm">{review.review}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      {review.is_verified ? (
                        <Badge variant="secondary" className="text-[10px]">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Verified {review.verification_method === "transaction_party" ? "deal party" : "booking party"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">Unverified</Badge>
                      )}
                      {review.moderation_status !== "approved" && (
                        <Badge variant="outline" className="text-[10px] capitalize">
                          {String(review.moderation_status).replace(/_/g, " ")}
                        </Badge>
                      )}
                      {(review.flag_count ?? 0) > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {review.flag_count} flag{review.flag_count === 1 ? "" : "s"}
                        </Badge>
                      )}
                    </div>
                    {review.vendor_response && (
                      <div className="mt-2 rounded border-l-2 border-primary/40 bg-muted/40 p-2">
                        <p className="text-[11px] font-medium text-muted-foreground">Vendor response</p>
                        <p className="text-sm">{review.vendor_response}</p>
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs text-muted-foreground">
                        - {review.users?.first_name} {review.users?.last_name}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={isPending || flaggingReviewId === review.id}
                        onClick={() => handleFlagReview(review.id)}
                      >
                        <AlertCircle className="h-3 w-3 mr-1" /> Flag
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* WRITE A REVIEW — verification is decided by the server from the
              deal you name; it can never be self-asserted here. */}
          <div className="border-t pt-4 space-y-3">
            <p className="text-sm font-medium">Write a review</p>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <button key={star} type="button" onClick={() => setNewReviewRating(star)}>
                  <Star
                    className={`h-5 w-5 ${star <= newReviewRating ? "fill-yellow-400 text-yellow-400" : "text-gray-300"}`}
                  />
                </button>
              ))}
              <span className="ml-2 text-sm text-muted-foreground">{newReviewRating} of 5</span>
            </div>
            <Input
              value={newReviewHeadline}
              onChange={(e) => setNewReviewHeadline(e.target.value)}
              placeholder="Headline (optional)"
            />
            <Textarea
              value={newReviewBody}
              onChange={(e) => setNewReviewBody(e.target.value)}
              placeholder="What was the work like? At least 50 characters."
              rows={3}
            />
            <div className="space-y-1">
              <Label className="text-xs">Link to a transaction (makes the review verified)</Label>
              <Select value={newReviewTransactionId} onValueChange={setNewReviewTransactionId}>
                <SelectTrigger>
                  <SelectValue placeholder="No transaction" />
                </SelectTrigger>
                <SelectContent>
                  {transactions.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.property_address}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {reviewFormError && <p className="text-sm text-destructive">{reviewFormError}</p>}
            {reviewFormNotice && <p className="text-sm text-muted-foreground">{reviewFormNotice}</p>}
            <DialogFooter>
              <Button onClick={handleSubmitReview} disabled={isPending || !newReviewBody.trim()}>
                Submit review
              </Button>
            </DialogFooter>
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
              <Label htmlFor="new-vendor-category">
                Category / Service Type <span className="text-destructive">*</span>
              </Label>
              {/* vendors.category is CHECK-constrained — a free-text box here
                  could only ever produce a rejected INSERT (its placeholder used
                  to suggest "Home Inspection, Photography", neither of which the
                  column has ever admitted). The picker cannot express an
                  invalid value. */}
              <VendorCategorySelect
                id="new-vendor-category"
                value={newVendorCategory}
                onChange={setNewVendorCategory}
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

      {/* Edit Vendor Dialog */}
      <Dialog open={editVendorOpen} onOpenChange={setEditVendorOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Vendor</DialogTitle>
            <DialogDescription>
              Correct this vendor&apos;s details. Paid directory placement is not edited here — it
              is sold and written by the placement lane.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>
                Name <span className="text-destructive">*</span>
              </Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-vendor-category">Category / Service Type</Label>
              {/* Same CHECK-constrained picker as the create dialog — a free-text
                  box here could only ever produce a rejected UPDATE. */}
              <VendorCategorySelect
                id="edit-vendor-category"
                value={editCategory}
                onChange={setEditCategory}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} type="tel" />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} type="email" />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Website</Label>
              <Input value={editWebsite} onChange={(e) => setEditWebsite(e.target.value)} type="url" />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={2} />
            </div>

            {editVendorError && <p className="text-sm text-destructive">{editVendorError}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditVendorOpen(false)
                setEditVendorError("")
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button onClick={handleUpdateVendor} disabled={isPending || !editName.trim()}>
              {isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Certificate of Insurance Dialog — recordVendorInsuranceAction */}
      <Dialog open={insuranceDialogOpen} onOpenChange={setInsuranceDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Certificate of Insurance</DialogTitle>
            <DialogDescription>
              {insuranceVendor?.name} — record the liability certificate. The expiry you enter is the
              date every compliance verdict is computed from: once it passes, the nightly sweep
              suspends this vendor off the bench automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* What is on file right now, stated before anything is changed. */}
            {insuranceVendor && (() => {
              const current = readVendorInsurance(insuranceVendor.compliance_credentials, new Date())
              return (
                <div className="rounded border p-2 text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">On file:</span>
                    <Badge className={`text-[11px] border ${INSURANCE_BADGE[current.posture]}`}>
                      {current.label}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground leading-snug">{current.detail}</p>
                </div>
              )
            })()}

            <div className="space-y-2">
              <Label>
                Carrier <span className="text-destructive">*</span>
              </Label>
              <Input
                value={insCarrier}
                onChange={(e) => setInsCarrier(e.target.value)}
                placeholder="e.g. Travelers, Hartford"
              />
            </div>

            <div className="space-y-2">
              <Label>
                Policy number <span className="text-destructive">*</span>
              </Label>
              <Input
                value={insPolicyNumber}
                onChange={(e) => setInsPolicyNumber(e.target.value)}
                placeholder="As printed on the certificate"
              />
            </div>

            <div className="space-y-2">
              <Label>
                Coverage limit (USD) <span className="text-destructive">*</span>
              </Label>
              <Input
                type="number"
                min={0}
                step={1}
                value={insCoverage}
                onChange={(e) => setInsCoverage(e.target.value)}
                placeholder="1000000"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>
                  Effective <span className="text-destructive">*</span>
                </Label>
                <Input type="date" value={insEffective} onChange={(e) => setInsEffective(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>
                  Expires <span className="text-destructive">*</span>
                </Label>
                <Input type="date" value={insExpiry} onChange={(e) => setInsExpiry(e.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Certificate link</Label>
              <Input
                value={insUrl}
                onChange={(e) => setInsUrl(e.target.value)}
                placeholder="https://… (optional)"
              />
            </div>

            {insuranceError && <p className="text-sm text-destructive">{insuranceError}</p>}
            {insuranceNotice && <p className="text-sm text-green-700">{insuranceNotice}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setInsuranceDialogOpen(false)
                setInsuranceError("")
                setInsuranceNotice("")
              }}
              className="bg-transparent"
            >
              Close
            </Button>
            <Button
              onClick={handleRecordInsurance}
              disabled={
                isPending ||
                !insCarrier.trim() ||
                !insPolicyNumber.trim() ||
                !insCoverage.trim() ||
                !insEffective ||
                !insExpiry
              }
            >
              {isPending ? "Verifying..." : "Record & verify"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Book for Listing Dialog */}
      <Dialog open={listingDialogOpen} onOpenChange={setListingDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Book for a Listing</DialogTitle>
            <DialogDescription>
              {listingVendor?.name} — pre-contract work booked against the property itself
              (staging, photography, pre-list inspection, cleaning).
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>
                Listing <span className="text-destructive">*</span>
              </Label>
              <Select value={listingId} onValueChange={setListingId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a listing" />
                </SelectTrigger>
                <SelectContent>
                  {listings.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.address ?? "Listing"}
                      {l.status ? ` (${l.status})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>
                Service Type <span className="text-destructive">*</span>
              </Label>
              <Input
                value={listingServiceType}
                onChange={(e) => setListingServiceType(e.target.value)}
                placeholder="e.g., staging"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Scheduled Date</Label>
                <Input type="date" value={listingDate} onChange={(e) => setListingDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Estimated Cost ($)</Label>
                <Input
                  type="number"
                  value={listingCost}
                  onChange={(e) => setListingCost(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={listingNotes} onChange={(e) => setListingNotes(e.target.value)} rows={2} />
            </div>

            {listingError && <p className="text-sm text-destructive">{listingError}</p>}
            {listingNotice && <p className="text-sm text-emerald-700">{listingNotice}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setListingDialogOpen(false)
                setListingError("")
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAssignToListing}
              disabled={isPending || !listingId || !listingServiceType.trim()}
            >
              {isPending ? "Booking..." : "Book for listing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign to Deal Dialog */}
      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign to a Deal</DialogTitle>
            <DialogDescription>
              {assignVendor?.name} — creates the assignment and the vendor job the deal screen and
              the vendor&apos;s own job list read. This is a different record from a booking.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>
                Transaction <span className="text-destructive">*</span>
              </Label>
              <Select value={assignTransactionId} onValueChange={setAssignTransactionId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a deal" />
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
              <Label>
                Assignment Type <span className="text-destructive">*</span>
              </Label>
              {/* vendor_assignments.assignment_type admits exactly these ten
                  values — NOT the 38-value vendors.category vocabulary and not
                  the free-text service types the booking form offers. */}
              <Select value={assignType} onValueChange={setAssignType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an assignment type" />
                </SelectTrigger>
                <SelectContent>
                  {VENDOR_ASSIGNMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">
                      {t.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Scheduled Date</Label>
              <Input type="date" value={assignDate} onChange={(e) => setAssignDate(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={assignNotes} onChange={(e) => setAssignNotes(e.target.value)} rows={2} />
            </div>

            {assignError && <p className="text-sm text-destructive">{assignError}</p>}
            {assignNotice && <p className="text-sm text-emerald-700">{assignNotice}</p>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAssignDialogOpen(false)
                setAssignError("")
              }}
              className="bg-transparent"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAssignToTransaction}
              disabled={isPending || !assignTransactionId || !assignType}
            >
              {isPending ? "Assigning..." : "Assign to deal"}
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

// ─── Vendor Availability Calendar ────────────────────────────────────────────

function VendorAvailabilityCalendar({
  bookedDates,
  selectedDate,
  onSelectDate,
}: {
  bookedDates: { date: string; count: number }[]
  selectedDate: string
  onSelectDate: (date: string) => void
}) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const bookedSet = new Set(bookedDates.map((b) => b.date))
  const bookedCountMap = Object.fromEntries(bookedDates.map((b) => [b.date, b.count]))

  // Build 30-day grid starting today
  const days: Date[] = []
  for (let i = 0; i < 30; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    days.push(d)
  }

  const toISO = (d: Date) => d.toISOString().slice(0, 10)

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground flex items-center gap-3">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300" /> Available</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-amber-100 border border-amber-300" /> Has booking(s)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-primary border-primary border" /> Selected</span>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {days.map((day) => {
          const iso = toISO(day)
          const isSelected = iso === selectedDate
          const isBooked = bookedSet.has(iso)
          const count = bookedCountMap[iso] ?? 0
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onSelectDate(iso)}
              title={isBooked ? `${count} booking${count > 1 ? "s" : ""} on this day` : "Available"}
              className={[
                "rounded text-xs py-1 text-center transition-colors",
                isSelected
                  ? "bg-primary text-primary-foreground font-semibold"
                  : isBooked
                  ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                  : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
              ].join(" ")}
            >
              <div className="font-medium">{day.getDate()}</div>
              <div className="text-[9px] opacity-70">{day.toLocaleDateString("en-US", { month: "short" })}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
