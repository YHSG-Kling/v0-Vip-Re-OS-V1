'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/lib/auth/client'
import { getContacts } from '@/app/actions/contacts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Users,
  Search,
  Plus,
  Mail,
  Phone,
  MapPin,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import Link from 'next/link'

interface Contact {
  id: string
  first_name: string
  last_name: string
  email: string
  phone?: string
  contact_type?: string
  status?: string
  city?: string
  state?: string
  created_at?: string
}

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-slate-100 text-slate-700',
  contacted: 'bg-blue-100 text-blue-700',
  qualified: 'bg-indigo-100 text-indigo-700',
  appointment_booked: 'bg-purple-100 text-purple-700',
  signed_agreement: 'bg-yellow-100 text-yellow-700',
  active_listing: 'bg-orange-100 text-orange-700',
  pending: 'bg-amber-100 text-amber-700',
  sold: 'bg-green-100 text-green-700',
  lifetime_customer: 'bg-emerald-100 text-emerald-700',
}

const TYPE_COLORS: Record<string, string> = {
  buyer: 'bg-blue-50 text-blue-700',
  seller: 'bg-green-50 text-green-700',
  investor: 'bg-purple-50 text-purple-700',
  other: 'bg-gray-50 text-gray-600',
}

export default function CRMPage() {
  const { user, loading: authLoading } = useAuth()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [filtered, setFiltered] = useState<Contact[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadContacts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getContacts({ limit: 100 })
      if (result.success) {
        setContacts(result.contacts)
        setFiltered(result.contacts)
      } else {
        setError(result.error ?? 'Failed to load contacts')
      }
    } catch (err) {
      setError('Failed to load contacts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authLoading && user) {
      loadContacts()
    }
  }, [authLoading, user, loadContacts])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      contacts.filter(
        (c) =>
          `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone?.includes(q) ||
          c.city?.toLowerCase().includes(q)
      )
    )
  }, [search, contacts])

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Contacts</h1>
          <p className="text-sm text-gray-500 mt-1">
            {loading ? 'Loading...' : `${filtered.length} contact${filtered.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadContacts}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" asChild>
            <Link href="/contacts/new">
              <Plus className="h-4 w-4 mr-2" />
              Add Contact
            </Link>
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          placeholder="Search by name, email, phone, or city..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Error state */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
          <button
            onClick={loadContacts}
            className="ml-2 underline font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-16">
          <Users className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-1">
            {search ? 'No contacts match your search' : 'No contacts yet'}
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            {search
              ? 'Try adjusting your search terms'
              : 'Add your first contact to get started'}
          </p>
          {!search && (
            <Button size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" asChild>
              <Link href="/contacts/new">
                <Plus className="h-4 w-4 mr-2" />
                Add Contact
              </Link>
            </Button>
          )}
        </div>
      )}

      {/* Contact list */}
      {!loading && filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((contact) => (
            <Card
              key={contact.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
            >
              <CardContent className="p-4">
                <Link href={`/contacts/${contact.id}`} className="block">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-gray-900 truncate">
                          {contact.first_name} {contact.last_name}
                        </h3>
                        {contact.contact_type && (
                          <Badge
                            className={`text-xs ${
                              TYPE_COLORS[contact.contact_type] ?? TYPE_COLORS.other
                            }`}
                          >
                            {contact.contact_type}
                          </Badge>
                        )}
                        {contact.status && (
                          <Badge
                            className={`text-xs ${
                              STATUS_COLORS[contact.status] ?? 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {contact.status.replace(/_/g, ' ')}
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
                        {contact.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="h-3.5 w-3.5" />
                            {contact.email}
                          </span>
                        )}
                        {contact.phone && (
                          <span className="flex items-center gap-1">
                            <Phone className="h-3.5 w-3.5" />
                            {contact.phone}
                          </span>
                        )}
                        {(contact.city || contact.state) && (
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5" />
                            {[contact.city, contact.state].filter(Boolean).join(', ')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
