'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"

export function EducationLibrary({ brokerageId }: { brokerageId: string }) {
  const [resources, setResources] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/education/resources?brokerageId=${brokerageId}`)
      .then(res => res.json())
      .then(data => {
        setResources(data.resources || [])
        setLoading(false)
      })
  }, [brokerageId])

  if (loading) return <div>Loading resources...</div>

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Education Library</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {resources.map(resource => (
          <Card key={resource.id}>
            <CardHeader>
              <CardTitle className="text-lg">{resource.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-600 mb-4">{resource.description}</p>
              <div className="flex justify-between items-center">
                <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                  {resource.content_type}
                </span>
                <span className="text-xs text-gray-500">
                  {resource.estimated_minutes}min
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
