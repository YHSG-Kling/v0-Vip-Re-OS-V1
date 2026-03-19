'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

interface DealPipelineRadarProps {
  brokerageId: string
}

export function DealPipelineRadar({ brokerageId }: DealPipelineRadarProps) {
  const pipelineData = [
    { stage: 'Pre-Approval', deals: 12, healthy: 10 },
    { stage: 'Underwriting', deals: 18, healthy: 15 },
    { stage: 'Appraisal', deals: 14, healthy: 12 },
    { stage: 'Clear to Close', deals: 8, healthy: 7 },
    { stage: 'Closing', deals: 5, healthy: 5 },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Deal Pipeline Radar</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={pipelineData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="stage" angle={-45} textAnchor="end" height={80} />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="deals" fill="#8884d8" name="Total Deals" />
            <Bar dataKey="healthy" fill="#82ca9d" name="Healthy" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
