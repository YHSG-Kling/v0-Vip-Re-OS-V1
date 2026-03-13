'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth/client'
import { createClient } from '@/lib/supabase/client'
import LoadingSpinner from '@/app/components/LoadingSpinner'
import { Users, Search, Plus, Filter, Mail, Phone, MapPin, Calendar, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Contact {
  id: string
  first_name: string | null
  last_name: string | null
  name: string | null
  email: string | null
  phone: string | null
  contact_type: string | null
  buyer_stage: string | null
  seller_stage: string | null
  city: string | null
  state: string | null
  created_at: string
}

export default function CRMPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const [searchQuery, setSearchQuery] = useState('')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [stats, setStats] = useState({ total: 0, active: 0, buyers: 0, sellers: 0 })

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [user, authLoading, router])

  useEffect(() => {
    async function fetchContacts() {
      if (!user) return
      
      const supabase = createClient()
      const { data, error } = await supabase
        .from('contacts')
        .select('id, first_name, last_name, name, email, phone, contact_type, buyer_stage, seller_stage, city, state, created_at')
        .order('created_at', { ascending: false })
        .limit(50)

      if (!error && data) {
        setContacts(data)
        setStats({
          total: data.length,
          active: data.filter(c => c.buyer_stage === 'active' || c.seller_stage === 'active').length,
          buyers: data.filter(c => c.contact_type === 'buyer').length,
          sellers: data.filter(c => c.contact_type === 'seller').length,
        })
      }
      setIsLoading(false)
    }

    if (user) {
      fetchContacts()
    }
  }, [user])

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="lg" text="Loading contacts..." />
      </div>
    )
  }

  if (!user) {
    return null
  }

  const getDisplayName = (contact: Contact) => {
    if (contact.first_name || contact.last_name) {
      return `${contact.first_name || ''} ${contact.last_name || ''}`.trim()
    }
    return contact.name || 'Unknown'
  }

  const getInitials = (contact: Contact) => {
    const name = getDisplayName(contact)
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  const getStatusBadge = (contact: Contact) => {
    const stage = contact.buyer_stage || contact.seller_stage
    if (!stage) return <Badge variant="secondary">New</Badge>
    
    switch (stage) {
      case 'active':
        return <Badge className="bg-green-100 text-green-800">Active</Badge>
      case 'nurture':
        return <Badge className="bg-blue-100 text-blue-800">Nurture</Badge>
      case 'hot':
        return <Badge className="bg-red-100 text-red-800">Hot Lead</Badge>
      default:
        return <Badge variant="secondary">{stage}</Badge>
    }
  }

  const getTypeBadge = (type: string | null) => {
    if (!type) return null
    switch (type) {
      case 'buyer':
        return <Badge className="bg-blue-100 text-blue-800">Buyer</Badge>
      case 'seller':
        return <Badge className="bg-purple-100 text-purple-800">Seller</Badge>
      case 'investor':
        return <Badge className="bg-amber-100 text-amber-800">Investor</Badge>
      default:
        return <Badge variant="secondary">{type}</Badge>
    }
  }

  const filteredContacts = contacts.filter(contact => {
    if (!searchQuery) return true
    const name = getDisplayName(contact).toLowerCase()
    const email = (contact.email || '').toLowerCase()
    const phone = (contact.phone || '').toLowerCase()
    const query = searchQuery.toLowerCase()
    return name.includes(query) || email.includes(query) || phone.includes(query)
  })

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">CRM & Contacts</h1>
            <p className="text-gray-500 mt-1">Manage your contacts and relationships</p>
          </div>
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Add Contact
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-500 text-sm mb-1">Total Contacts</p>
                  <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
                </div>
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Users className="text-blue-600 h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-500 text-sm mb-1">Active</p>
                  <p className="text-2xl font-bold text-gray-900">{stats.active}</p>
                </div>
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <Users className="text-green-600 h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-500 text-sm mb-1">Buyers</p>
                  <p className="text-2xl font-bold text-gray-900">{stats.buyers}</p>
                </div>
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Users className="text-blue-600 h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-500 text-sm mb-1">Sellers</p>
                  <p className="text-2xl font-bold text-gray-900">{stats.sellers}</p>
                </div>
                <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                  <Users className="text-purple-600 h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Search and Filters */}
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 h-4 w-4" />
            <Input
              type="text"
              placeholder="Search contacts by name, email, or phone..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Button variant="outline">
            <Filter className="h-4 w-4 mr-2" />
            Filters
          </Button>
        </div>
      </div>

      {/* Contacts Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contact</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredContacts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-gray-500">
                  {searchQuery ? `No contacts found matching "${searchQuery}"` : 'No contacts yet'}
                </TableCell>
              </TableRow>
            ) : (
              filteredContacts.map((contact) => (
                <TableRow 
                  key={contact.id} 
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => router.push(`/contacts/${contact.id}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-white font-semibold text-sm">
                        {getInitials(contact)}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{getDisplayName(contact)}</p>
                        <p className="text-sm text-gray-500">{contact.email || 'No email'}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {getTypeBadge(contact.contact_type)}
                  </TableCell>
                  <TableCell>
                    {getStatusBadge(contact)}
                  </TableCell>
                  <TableCell>
                    {contact.city || contact.state ? (
                      <div className="flex items-center gap-1 text-gray-500 text-sm">
                        <MapPin className="h-3 w-3" />
                        {[contact.city, contact.state].filter(Boolean).join(', ')}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-sm">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation() }}>
                        <Mail className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation() }}>
                        <Phone className="h-4 w-4" />
                      </Button>
                      <ChevronRight className="h-4 w-4 text-gray-400" />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
