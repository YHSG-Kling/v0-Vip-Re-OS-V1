"use client"

import { useState, useMemo } from "react"
import type {
  Contact,
  ContactType,
  ContactPersona,
  ContactTimeline,
  ContactStatus,
  ContactFilters,
} from "@/types/contact"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Search,
  MoreHorizontal,
  Eye,
  Edit,
  UserCheck,
  Mail,
  Trash2,
  ArrowUpDown,
  Download,
  Clock,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react"
import { getUrgencyColor, calculateDaysUntilTimeline } from "@/lib/contact-utils"

interface ContactsListProps {
  contacts: Contact[]
  onView: (contact: Contact) => void
  onEdit: (contact: Contact) => void
  onQualify: (contact: Contact) => void
  onDelete: (contact: Contact) => void
  onSendEmail: (contact: Contact) => void
  onBulkAction?: (action: string, contacts: Contact[]) => void
  isLoading?: boolean
}

const TYPE_COLORS: Record<ContactType, string> = {
  buyer: "bg-emerald-100 text-emerald-800",
  seller: "bg-blue-100 text-blue-800",
  investor: "bg-purple-100 text-purple-800",
  lender: "bg-amber-100 text-amber-800",
  commercial: "bg-slate-100 text-slate-800",
  agent: "bg-cyan-100 text-cyan-800",
  vendor: "bg-orange-100 text-orange-800",
  TC: "bg-pink-100 text-pink-800",
  other: "bg-gray-100 text-gray-800",
}

const PERSONA_LABELS: Record<ContactPersona, string> = {
  first_time_buyer: "First-Time Buyer",
  luxury_buyer: "Luxury Buyer",
  luxury_seller: "Luxury Seller",
  investor: "Investor",
  first_time_seller: "First-Time Seller",
  motivated_seller: "Motivated Seller",
  relocating: "Relocating",
  empty_nester: "Empty Nester",
  probate: "Probate",
  remote_seller: "Remote Seller",
  divorce: "Divorce",
  upsizers: "Upsizers",
  senior: "Senior",
  expired: "Expired",
  fsbo: "FSBO",
  other: "Other",
}

const STATUS_COLORS: Record<ContactStatus, string> = {
  new: "bg-gray-100 text-gray-800",
  contacted: "bg-yellow-100 text-yellow-800",
  qualified: "bg-blue-100 text-blue-800",
  appointment_booked: "bg-indigo-100 text-indigo-800",
  signed_agreement: "bg-purple-100 text-purple-800",
  pre_listing: "bg-cyan-100 text-cyan-800",
  active_listing: "bg-emerald-100 text-emerald-800",
  contingent: "bg-orange-100 text-orange-800",
  pending: "bg-amber-100 text-amber-800",
  sold: "bg-green-100 text-green-800",
  lifetime_customer: "bg-pink-100 text-pink-800",
}

export function ContactsList({
  contacts,
  onView,
  onEdit,
  onQualify,
  onDelete,
  onSendEmail,
  onBulkAction,
  isLoading,
}: ContactsListProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [filters, setFilters] = useState<ContactFilters>({})
  const [sortField, setSortField] = useState<keyof Contact>("created_at")
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(25)
  const [deleteConfirm, setDeleteConfirm] = useState<Contact | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const filteredContacts = useMemo(() => {
    let result = [...contacts]

    // Search
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      result = result.filter(
        (c) =>
          c.first_name.toLowerCase().includes(query) ||
          c.last_name.toLowerCase().includes(query) ||
          c.email.toLowerCase().includes(query) ||
          c.phone?.includes(query),
      )
    }

    // Filters
    if (filters.contact_type?.length) {
      result = result.filter((c) => filters.contact_type?.includes(c.contact_type))
    }
    if (filters.contact_persona?.length) {
      result = result.filter((c) => filters.contact_persona?.includes(c.contact_persona))
    }
    if (filters.timeline?.length) {
      result = result.filter((c) => filters.timeline?.includes(c.timeline))
    }
    if (filters.status?.length) {
      result = result.filter((c) => filters.status?.includes(c.status))
    }
    if (filters.has_login !== undefined) {
      result = result.filter((c) => c.has_login === filters.has_login)
    }

    // Sort
    result.sort((a, b) => {
      const aVal = a[sortField]
      const bVal = b[sortField]
      if (aVal === undefined || aVal === null) return 1
      if (bVal === undefined || bVal === null) return -1
      if (aVal < bVal) return sortOrder === "asc" ? -1 : 1
      if (aVal > bVal) return sortOrder === "asc" ? 1 : -1
      return 0
    })

    return result
  }, [contacts, searchQuery, filters, sortField, sortOrder])

  const paginatedContacts = useMemo(() => {
    const start = (page - 1) * perPage
    return filteredContacts.slice(start, start + perPage)
  }, [filteredContacts, page, perPage])

  const totalPages = Math.ceil(filteredContacts.length / perPage)

  const toggleSort = (field: keyof Contact) => {
    if (sortField === field) {
      setSortOrder((o) => (o === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortOrder("asc")
    }
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === paginatedContacts.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(paginatedContacts.map((c) => c.id)))
    }
  }

  const toggleSelect = (id: string) => {
    const newSet = new Set(selectedIds)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedIds(newSet)
  }

  const getTimelineDisplay = (contact: Contact) => {
    const colors = getUrgencyColor(contact.timeline)
    const days = calculateDaysUntilTimeline(contact.timeline)
    return (
      <div className="flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${colors.dot}`} />
        <span className={`text-xs font-medium ${colors.text}`}>{contact.timeline.replace("_", " ")}</span>
        {days <= 90 && <span className="text-xs text-red-600">({days}d)</span>}
      </div>
    )
  }

  const handleDeleteContact = async (contact: Contact) => {
    setIsDeleting(true)
    setDeleteError(null)

    try {
      const response = await fetch("/api/contacts/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to delete contact")
      }

      setDeleteConfirm(null)
      onDelete(contact)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Failed to delete contact")
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Search and Filters */}
      <div className="flex flex-wrap gap-4 items-center justify-between">
        <div className="flex items-center gap-2 flex-1 min-w-64">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search contacts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select
            value={filters.contact_type?.[0] || "all"}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, contact_type: v === "all" ? undefined : [v as ContactType] }))
            }
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="buyer">Buyer</SelectItem>
              <SelectItem value="seller">Seller</SelectItem>
              <SelectItem value="investor">Investor</SelectItem>
              <SelectItem value="lender">Lender</SelectItem>
              <SelectItem value="commercial">Commercial</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={filters.timeline?.[0] || "all"}
            onValueChange={(v) =>
              setFilters((f) => ({ ...f, timeline: v === "all" ? undefined : [v as ContactTimeline] }))
            }
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Timeline" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Timelines</SelectItem>
              <SelectItem value="0-3_months">0-3 Months (Urgent)</SelectItem>
              <SelectItem value="3-6_months">3-6 Months</SelectItem>
              <SelectItem value="6-12_months">6-12 Months</SelectItem>
              <SelectItem value="12+_months">12+ Months</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={filters.has_login === true ? "yes" : filters.has_login === false ? "no" : "all"}
            onValueChange={(v) => setFilters((f) => ({ ...f, has_login: v === "all" ? undefined : v === "yes" }))}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Has Login" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="yes">Has Login</SelectItem>
              <SelectItem value="no">No Login</SelectItem>
            </SelectContent>
          </Select>

          {selectedIds.size > 0 && onBulkAction && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Bulk Actions ({selectedIds.size})</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  onClick={() =>
                    onBulkAction(
                      "qualify",
                      contacts.filter((c) => selectedIds.has(c.id)),
                    )
                  }
                >
                  <UserCheck className="w-4 h-4 mr-2" /> Qualify Selected
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    onBulkAction(
                      "export",
                      contacts.filter((c) => selectedIds.has(c.id)),
                    )
                  }
                >
                  <Download className="w-4 h-4 mr-2" /> Export Selected
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-red-600"
                  onClick={() =>
                    onBulkAction(
                      "delete",
                      contacts.filter((c) => selectedIds.has(c.id)),
                    )
                  }
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Delete Selected
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Results count */}
      <div className="text-sm text-slate-500">
        Showing {paginatedContacts.length} of {filteredContacts.length} contacts
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="w-10">
                <Checkbox
                  checked={selectedIds.size === paginatedContacts.length && paginatedContacts.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
              </TableHead>
              <TableHead className="cursor-pointer" onClick={() => toggleSort("last_name")}>
                <div className="flex items-center gap-1">
                  Name <ArrowUpDown className="w-3 h-3" />
                </div>
              </TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Persona</TableHead>
              <TableHead className="cursor-pointer" onClick={() => toggleSort("timeline")}>
                <div className="flex items-center gap-1">
                  Timeline <ArrowUpDown className="w-3 h-3" />
                </div>
              </TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Login</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedContacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-slate-500">
                  No contacts found
                </TableCell>
              </TableRow>
            ) : (
              paginatedContacts.map((contact) => (
                <TableRow key={contact.id} className="hover:bg-slate-50">
                  <TableCell>
                    <Checkbox checked={selectedIds.has(contact.id)} onCheckedChange={() => toggleSelect(contact.id)} />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {contact.first_name} {contact.last_name}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">
                      <div>{contact.email}</div>
                      <div className="text-slate-500">{contact.phone}</div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={TYPE_COLORS[contact.contact_type]}>{contact.contact_type}</Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">{PERSONA_LABELS[contact.contact_persona]}</span>
                  </TableCell>
                  <TableCell>{getTimelineDisplay(contact)}</TableCell>
                  <TableCell>
                    <Badge className={STATUS_COLORS[contact.status]}>{contact.status.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    {contact.has_login ? (
                      <CheckCircle className="w-4 h-4 text-green-600" />
                    ) : (
                      <Clock className="w-4 h-4 text-slate-300" />
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onView(contact)}>
                          <Eye className="w-4 h-4 mr-2" /> View
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onEdit(contact)}>
                          <Edit className="w-4 h-4 mr-2" /> Edit
                        </DropdownMenuItem>
                        {!contact.has_login && (
                          <DropdownMenuItem onClick={() => onQualify(contact)}>
                            <UserCheck className="w-4 h-4 mr-2" /> Qualify & Create Login
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => onSendEmail(contact)}>
                          <Mail className="w-4 h-4 mr-2" /> Send Email
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-red-600" onClick={() => setDeleteConfirm(contact)}>
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <Select value={String(perPage)} onValueChange={(v) => setPerPage(Number(v))}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10">10 per page</SelectItem>
            <SelectItem value="25">25 per page</SelectItem>
            <SelectItem value="50">50 per page</SelectItem>
            <SelectItem value="100">100 per page</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page === 1}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm">
            Page {page} of {totalPages || 1}
          </span>
          <Button variant="outline" size="sm" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirm && (
                <div>
                  Are you sure you want to delete {deleteConfirm.first_name} {deleteConfirm.last_name}? This action
                  cannot be undone.
                  {deleteError && <div className="mt-3 text-red-600 text-sm font-medium">{deleteError}</div>}
                </div>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-3 justify-end">
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirm && handleDeleteContact(deleteConfirm)}
              disabled={isDeleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
