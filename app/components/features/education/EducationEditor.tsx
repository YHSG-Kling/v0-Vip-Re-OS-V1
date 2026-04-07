'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Button } from "@/app/components/ui/button"
import { createResourceAction } from "@/app/actions/education-kernel"

export function EducationEditor({ brokerageId }: { brokerageId: string }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [contentType, setContentType] = useState('article')
  const [content, setContent] = useState('')
  const [minutes, setMinutes] = useState(5)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      await createResourceAction({
        title,
        description,
        contentType,
        content,
        estimatedMinutes: minutes,
        brokerageId,
      })
      setTitle('')
      setDescription('')
      setContent('')
    } catch (error) {
      console.error('Failed to create resource:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Education Resource</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full border rounded px-3 py-2"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full border rounded px-3 py-2"
              rows={2}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Content Type</label>
            <select
              value={contentType}
              onChange={e => setContentType(e.target.value)}
              className="w-full border rounded px-3 py-2"
            >
              <option>article</option>
              <option>video</option>
              <option>interactive</option>
              <option>assessment</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Content</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              className="w-full border rounded px-3 py-2"
              rows={4}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Estimated Minutes</label>
            <input
              type="number"
              value={minutes}
              onChange={e => setMinutes(parseInt(e.target.value))}
              className="w-full border rounded px-3 py-2"
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? 'Creating...' : 'Create Resource'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
