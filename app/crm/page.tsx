'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth/client'
import Sidebar from '@/app/components/Sidebar'
import LoadingSpinner from '@/app/components/LoadingSpinner'
import { Users, Search, Plus, Filter, Mail, Phone, MapPin, Calendar } from 'lucide-react'

export default function CRMPage() {
  const router = useRouter()
  const { user, isLoading, signOut } = useAuth()
  const [searchQuery, setSearchQuery] = useState('')

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login')
    }
  }, [user, isLoading, router])

  const handleLogout = async () => {
    await signOut()
    await fetch('/api/auth/logout', {
      method: 'POST',
    })
    logout()
    router.push('/login')
  }

  if (isLoading) {
    return <LoadingSpinner fullScreen size="lg" text="Loading CRM..." />
  }

  if (!user) {
    return null
  }

  // Sample contacts data - in production this would come from your database
  const contacts = [
    {
      id: 1,
      name: 'John Smith',
      email: 'john.smith@email.com',
      phone: '(555) 123-4567',
      type: 'Buyer',
      status: 'Active',
      lastContact: '2 days ago',
      location: 'Los Angeles, CA'
    },
    {
      id: 2,
      name: 'Sarah Johnson',
      email: 'sarah.j@email.com',
      phone: '(555) 234-5678',
      type: 'Seller',
      status: 'Hot Lead',
      lastContact: '5 hours ago',
      location: 'Beverly Hills, CA'
    },
    {
      id: 3,
      name: 'Michael Brown',
      email: 'mbrown@email.com',
      phone: '(555) 345-6789',
      type: 'Buyer',
      status: 'Nurture',
      lastContact: '1 week ago',
      location: 'Santa Monica, CA'
    },
    {
      id: 4,
      name: 'Emily Davis',
      email: 'emily.davis@email.com',
      phone: '(555) 456-7890',
      type: 'Investor',
      status: 'Active',
      lastContact: 'Yesterday',
      location: 'Pasadena, CA'
    },
  ]

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Hot Lead':
        return 'bg-red-500/10 text-red-400 border-red-500/20'
      case 'Active':
        return 'bg-green-500/10 text-green-400 border-green-500/20'
      case 'Nurture':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/20'
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
    }
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'Buyer':
        return 'bg-blue-500/10 text-blue-400'
      case 'Seller':
        return 'bg-purple-500/10 text-purple-400'
      case 'Investor':
        return 'bg-yellow-500/10 text-yellow-400'
      default:
        return 'bg-slate-500/10 text-slate-400'
    }
  }

  return (
    <div className="flex min-h-screen bg-slate-950">
      <Sidebar role={user.role} onLogout={handleLogout} />
      
      <main className="ml-64 flex-1 p-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold text-white mb-2">CRM & Contacts</h1>
              <p className="text-slate-400">Manage your contacts and relationships</p>
            </div>
            <button className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
              <Plus size={18} />
              Add Contact
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 text-sm mb-1">Total Contacts</p>
                  <p className="text-2xl font-bold text-white">248</p>
                </div>
                <div className="w-10 h-10 bg-blue-500/10 rounded-lg flex items-center justify-center">
                  <Users className="text-blue-400" size={20} />
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 text-sm mb-1">Active Leads</p>
                  <p className="text-2xl font-bold text-white">67</p>
                </div>
                <div className="w-10 h-10 bg-green-500/10 rounded-lg flex items-center justify-center">
                  <Users className="text-green-400" size={20} />
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 text-sm mb-1">Hot Leads</p>
                  <p className="text-2xl font-bold text-white">23</p>
                </div>
                <div className="w-10 h-10 bg-red-500/10 rounded-lg flex items-center justify-center">
                  <Users className="text-red-400" size={20} />
                </div>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 text-sm mb-1">This Week</p>
                  <p className="text-2xl font-bold text-white">12</p>
                </div>
                <div className="w-10 h-10 bg-purple-500/10 rounded-lg flex items-center justify-center">
                  <Calendar className="text-purple-400" size={20} />
                </div>
              </div>
            </div>
          </div>

          {/* Search and Filters */}
          <div className="flex items-center gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                type="text"
                placeholder="Search contacts by name, email, or phone..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-slate-800 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <button className="flex items-center gap-2 px-4 py-2.5 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-lg transition-colors">
              <Filter size={18} />
              Filters
            </button>
          </div>
        </div>

        {/* Contacts Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="text-left py-4 px-6 text-sm font-semibold text-slate-300">Contact</th>
                <th className="text-left py-4 px-6 text-sm font-semibold text-slate-300">Type</th>
                <th className="text-left py-4 px-6 text-sm font-semibold text-slate-300">Status</th>
                <th className="text-left py-4 px-6 text-sm font-semibold text-slate-300">Location</th>
                <th className="text-left py-4 px-6 text-sm font-semibold text-slate-300">Last Contact</th>
                <th className="text-left py-4 px-6 text-sm font-semibold text-slate-300">Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id} className="border-b border-slate-800 hover:bg-slate-800/50 transition-colors">
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-white font-semibold">
                        {contact.name.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div>
                        <p className="font-semibold text-white">{contact.name}</p>
                        <p className="text-sm text-slate-400">{contact.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-4 px-6">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${getTypeColor(contact.type)}`}>
                      {contact.type}
                    </span>
                  </td>
                  <td className="py-4 px-6">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border ${getStatusColor(contact.status)}`}>
                      {contact.status}
                    </span>
                  </td>
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-2 text-slate-400">
                      <MapPin size={14} />
                      <span className="text-sm">{contact.location}</span>
                    </div>
                  </td>
                  <td className="py-4 px-6">
                    <span className="text-sm text-slate-400">{contact.lastContact}</span>
                  </td>
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-2">
                      <button className="p-2 hover:bg-slate-700 rounded-lg transition-colors text-slate-400 hover:text-white">
                        <Mail size={16} />
                      </button>
                      <button className="p-2 hover:bg-slate-700 rounded-lg transition-colors text-slate-400 hover:text-white">
                        <Phone size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Empty state when search returns no results */}
        {searchQuery && contacts.length === 0 && (
          <div className="text-center py-12">
            <Users className="mx-auto text-slate-600 mb-4" size={48} />
            <p className="text-slate-400">No contacts found matching "{searchQuery}"</p>
          </div>
        )}
      </main>
    </div>
  )
}
