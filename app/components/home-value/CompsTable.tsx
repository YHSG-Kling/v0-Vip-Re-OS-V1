"use client"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { MapPin, Calendar, Home } from "lucide-react"

interface Comp {
  address: string
  sale_price: number
  beds: number
  baths: number
  sqft: number
  price_per_sqft: number
  sale_date: string
  /**
   * Null when the comp source could not attribute a distance. The comp finder
   * searches WITHIN a radius but returns no per-comp distance, so this column
   * shows "—" rather than a number nobody measured. Older rows written before
   * the CMA repoint may still carry a value.
   */
  distance_miles: number | null
  /** Source the sale was grounded in, when the finder returned one. */
  citation?: string | null
}

interface CompsTableProps {
  comps: Comp[]
}

export function CompsTable({ comps }: CompsTableProps) {
  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value)

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }

  if (!comps || comps.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Home className="h-5 w-5" />
            Comparable Sales
          </CardTitle>
          <CardDescription>Recent similar property sales in your area</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            Comparable sales data loading — check back soon.
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Home className="h-5 w-5" />
          Comparable Sales
        </CardTitle>
        <CardDescription>
          {comps.length} similar properties recently sold near you
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead className="text-right">Sale Price</TableHead>
                <TableHead className="text-center">Beds</TableHead>
                <TableHead className="text-center">Baths</TableHead>
                <TableHead className="text-right">Sq Ft</TableHead>
                <TableHead className="text-right">$/Sq Ft</TableHead>
                <TableHead className="text-center">Sale Date</TableHead>
                <TableHead className="text-right">Distance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comps.map((comp, index) => (
                <TableRow key={index}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
                      {/* Linked to its source when the comp finder returned one,
                          so the seller can check the sale rather than take it
                          on faith. */}
                      {comp.citation ? (
                        <a
                          href={comp.citation}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate max-w-[200px] underline underline-offset-2 hover:text-primary"
                        >
                          {comp.address}
                        </a>
                      ) : (
                        <span className="truncate max-w-[200px]">{comp.address}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatCurrency(comp.sale_price)}
                  </TableCell>
                  <TableCell className="text-center">{comp.beds}</TableCell>
                  <TableCell className="text-center">{comp.baths}</TableCell>
                  <TableCell className="text-right">
                    {comp.sqft.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    ${Math.round(comp.price_per_sqft)}
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Calendar className="h-3 w-3 text-muted-foreground" />
                      {formatDate(comp.sale_date)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {comp.distance_miles != null ? `${comp.distance_miles.toFixed(1)} mi` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
