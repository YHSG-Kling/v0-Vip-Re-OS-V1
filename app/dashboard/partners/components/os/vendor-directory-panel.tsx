"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Star, Search, Plus, Building2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import Link from "next/link"

interface VendorDirectoryPanelProps {
  brokerageId: string
}

interface VendorEntry {
  id: string
  name: string
  category: string
  rating: number
  status: string
}

export function VendorDirectoryPanel({ brokerageId }: VendorDirectoryPanelProps) {
  const [vendors, setVendors] = useState<VendorEntry[]>([])
  const [filteredVendors, setFilteredVendors] = useState<VendorEntry[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadVendors() {
      const supabase = createClient()

      const { data } = await supabase
        .from("vendors")
        .select("id, name, category, rating, status")
        .eq("brokerage_id", brokerageId)
        .eq("status", "active")
        .order("name")
        .limit(50)

      setVendors(data || [])
      setFilteredVendors(data || [])
      setLoading(false)
    }

    loadVendors()
  }, [brokerageId])

  useEffect(() => {
    if (!search.trim()) {
      setFilteredVendors(vendors)
    } else {
      const searchLower = search.toLowerCase()
      setFilteredVendors(
        vendors.filter(
          v =>
            v.name.toLowerCase().includes(searchLower) ||
            v.category.toLowerCase().includes(searchLower)
        )
      )
    }
  }, [search, vendors])

  const getCategoryColor = (category: string) => {
    switch (category.toLowerCase()) {
      case "lender":
        return "bg-blue-100 text-blue-700 dark:bg-blue-900/20"
      case "title":
        return "bg-purple-100 text-purple-700 dark:bg-purple-900/20"
      case "inspector":
        return "bg-orange-100 text-orange-700 dark:bg-orange-900/20"
      case "photographer":
        return "bg-pink-100 text-pink-700 dark:bg-pink-900/20"
      case "contractor":
        return "bg-green-100 text-green-700 dark:bg-green-900/20"
      default:
        return "bg-gray-100 text-gray-700 dark:bg-gray-900/20"
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Vendor Directory</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Vendor Directory</CardTitle>
            <CardDescription>{vendors.length} active vendors</CardDescription>
          </div>
          <Link href="/dashboard/vendors/new">
            <Button size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search vendors..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Vendor List */}
        <div className="max-h-[300px] space-y-2 overflow-y-auto">
          {filteredVendors.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Building2 className="h-8 w-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {search ? "No vendors match your search" : "No vendors in directory"}
              </p>
            </div>
          ) : (
            filteredVendors.slice(0, 10).map(vendor => (
              <Link
                key={vendor.id}
                href={`/dashboard/vendors/${vendor.id}`}
                className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <div>
                    <p className="font-medium">{vendor.name}</p>
                    <Badge className={`text-xs ${getCategoryColor(vendor.category)}`}>
                      {vendor.category}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                  <span className="text-sm font-medium">{vendor.rating?.toFixed(1) || "N/A"}</span>
                </div>
              </Link>
            ))
          )}
        </div>

        {filteredVendors.length > 10 && (
          <Link href="/dashboard/vendors" className="block">
            <Button variant="outline" className="w-full">
              View All {filteredVendors.length} Vendors
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
