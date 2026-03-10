"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ChevronDown, ChevronUp } from "lucide-react"

interface Props {
  data: any[]
}

export function RecruitROITable({ data }: Props) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null)

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          No recruit data available
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-Recruit ROI Analysis</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left p-3 font-semibold">Recruit</th>
                <th className="text-right p-3 font-semibold">Investment</th>
                <th className="text-right p-3 font-semibold">LTV</th>
                <th className="text-right p-3 font-semibold">ROI</th>
                <th className="text-center p-3 font-semibold">Breakeven</th>
                <th className="text-center p-3 font-semibold">Status</th>
                <th className="w-10"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((row: any) => (
                <div key={row.id} className="border-b">
                  <div className="flex items-center p-3 hover:bg-muted/50">
                    <td className="flex-1">{`${row.agents?.first_name} ${row.agents?.last_name}`}</td>
                    <td className="text-right">${((row.total_recruiting_cost || 0) / 100).toLocaleString()}</td>
                    <td className="text-right font-semibold">${((row.lifetime_brokerage_net || 0) / 100).toLocaleString()}</td>
                    <td className={`text-right font-bold ${(row.roi_pct || 0) > 100 ? 'text-green-600' : (row.roi_pct || 0) > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                      {(row.roi_pct || 0).toFixed(0)}%
                    </td>
                    <td className="text-center">
                      <Badge variant={(row.breakeven_month || 0) <= 6 ? "default" : "secondary"}>
                        {row.breakeven_month || "N/A"} mo
                      </Badge>
                    </td>
                    <td className="text-center">
                      <Badge variant={row.agents?.status === 'active' ? 'default' : 'secondary'}>
                        {row.agents?.status || 'Unknown'}
                      </Badge>
                    </td>
                    <td>
                      <button
                        onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
                        className="p-1"
                      >
                        {expandedRow === row.id ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                  </div>
                  
                  {expandedRow === row.id && (
                    <div className="bg-muted/30 p-4 border-t grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Year 1 Revenue</p>
                        <p className="font-semibold">${((row.year1_revenue || 0) / 100).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Year 2 Revenue</p>
                        <p className="font-semibold">${((row.year2_revenue || 0) / 100).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Year 3 Revenue</p>
                        <p className="font-semibold">${((row.year3_revenue || 0) / 100).toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Hire Date</p>
                        <p className="font-semibold">{new Date(row.hire_date).toLocaleDateString()}</p>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
