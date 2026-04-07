'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"

export function ProgressDashboard({ brokerageId }: { brokerageId: string }) {
  const [dashboard, setDashboard] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/education/progress?brokerageId=${brokerageId}`)
      .then(res => res.json())
      .then(data => {
        setDashboard(data)
        setLoading(false)
      })
  }, [brokerageId])

  if (loading) return <div>Loading dashboard...</div>
  if (!dashboard) return <div>No data available</div>

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-gray-600">Total Enrolled</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{dashboard.totalEnrolled || 0}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-gray-600">Completion Rate</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{dashboard.completionRate || 0}%</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-gray-600">Avg Time Per Resource</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-bold">{dashboard.avgTimePerResource || 0}min</div>
        </CardContent>
      </Card>
    </div>
  )
}
