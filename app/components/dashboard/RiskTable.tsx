"use client"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import type { TransactionRisk } from "@/lib/data/serviceDeliveryMetrics"

interface RiskTableProps {
  transactions: TransactionRisk[]
}

export function RiskTable({ transactions }: RiskTableProps) {
  const getRiskColor = (risk: string) => {
    switch (risk) {
      case "critical":
        return "destructive"
      case "high":
        return "destructive"
      case "medium":
        return "secondary"
      default:
        return "default"
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-slate-50 border-b">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                Address
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                Client
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                Pipeline
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                Overdue
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                Health Score
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Days</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Risk</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-slate-200">
            {transactions.map((tx) => (
              <tr key={tx.transactionId} className="hover:bg-slate-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-900">{tx.address}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">{tx.clientName}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">{tx.pipeline}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900 font-semibold">
                  {tx.overdueMilestones}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <span className="text-sm font-semibold text-slate-900">{tx.healthScore}</span>
                    <div className="ml-2 w-16 bg-slate-100 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${
                          tx.healthScore >= 70 ? "bg-green-500" : tx.healthScore >= 50 ? "bg-yellow-500" : "bg-red-500"
                        }`}
                        style={{ width: `${tx.healthScore}%` }}
                      />
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-600">{tx.daysInContract}</td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <Badge variant={getRiskColor(tx.riskLevel)}>{tx.riskLevel.toUpperCase()}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
