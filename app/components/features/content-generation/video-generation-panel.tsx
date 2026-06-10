'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Video, Play, Download, Share2, Eye, CheckCircle, Clock, XCircle } from 'lucide-react'
import { generateListingVideo, publishVideoToPlatforms, getVideoProjects } from '@/app/actions/listing-video'

interface VideoGenerationPanelProps {
  transactionId?: string
  propertyId?: string
  agentId: string
}

export function VideoGenerationPanel({ transactionId, propertyId, agentId }: VideoGenerationPanelProps) {
  const [projects, setProjects] = useState<any[]>([])
  const [generating, setGenerating] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadProjects()
  }, [])

  async function loadProjects() {
    setLoading(true)
    const data = await getVideoProjects(agentId)
    setProjects(data)
    setLoading(false)
  }

  async function createVideo(videoType: 'full_tour' | 'social_snippet' | 'reel' | 'instagram_story') {
    setGenerating(true)
    const result = await generateListingVideo({
      transactionId,
      propertyId,
      agentId,
      videoType,
    })

    if (result.success) {
      await loadProjects()
    }
    setGenerating(false)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>AI Video Generation</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Automatically create professional property videos with D-ID + ElevenLabs
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => createVideo('full_tour')} disabled={generating}>
              <Video className="h-4 w-4 mr-2" />
              Full Tour
            </Button>
            <Button size="sm" variant="outline" onClick={() => createVideo('social_snippet')} disabled={generating}>
              30s Snippet
            </Button>
            <Button size="sm" variant="outline" onClick={() => createVideo('reel')} disabled={generating}>
              Reel
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="text-center py-8">
            <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-3 animate-spin" />
            <p className="text-sm text-muted-foreground">Loading videos...</p>
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-8">
            <Video className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No videos generated yet. Click a button above to create one.</p>
          </div>
        ) : (
          projects.map((project) => <VideoProjectCard key={project.id} project={project} onUpdate={loadProjects} />)
        )}
      </CardContent>
    </Card>
  )
}

function VideoProjectCard({ project, onUpdate }: { project: any; onUpdate: () => void }) {
  const [publishing, setPublishing] = useState(false)

  const statusConfig: Record<string, any> = {
    pending: { icon: Clock, color: 'text-gray-600', label: 'Pending' },
    generating: { icon: Clock, color: 'text-blue-600', label: 'Creating Video...' },
    completed: { icon: CheckCircle, color: 'text-green-600', label: 'Ready' },
    failed: { icon: XCircle, color: 'text-red-600', label: 'Failed' },
  }

  // provider_status is canonical (D-ID); fall back to legacy heygen_status for old rows.
  const providerStatus = project.provider_status || project.heygen_status || 'pending'
  const config = statusConfig[providerStatus] ?? statusConfig.pending
  const Icon = config.icon

  async function handlePublish() {
    setPublishing(true)
    await publishVideoToPlatforms({
      projectId: project.id,
      platforms: ['youtube', 'facebook', 'instagram'],
    })
    setPublishing(false)
    onUpdate()
  }

  return (
    <div className="flex items-center gap-4 p-4 border rounded-lg">
      {/* Thumbnail */}
      <div className="w-32 h-20 bg-muted rounded-lg flex items-center justify-center flex-shrink-0 relative overflow-hidden">
        {project.thumbnail_url ? (
          <img src={project.thumbnail_url || "/placeholder.svg"} className="w-full h-full object-cover" alt="Video thumbnail" />
        ) : (
          <Video className="h-8 w-8 text-muted-foreground" />
        )}
        {project.duration_seconds && (
          <Badge className="absolute bottom-1 right-1 text-xs">
            {Math.floor(project.duration_seconds / 60)}:{(project.duration_seconds % 60).toString().padStart(2, '0')}
          </Badge>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="font-medium capitalize">{project.video_type.replace('_', ' ')}</p>
          <Icon className={`h-4 w-4 ${config.color}`} />
          <Badge variant="outline" className="text-xs">
            {config.label}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            {project.video_type === 'full_tour' ? '16:9' : project.video_type === 'social_snippet' ? '1:1' : '9:16'}
          </span>
          {project.view_count > 0 && (
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {project.view_count} views
            </span>
          )}
          {project.distributed_via?.length > 0 && (
            <span>Published to {project.distributed_via.join(', ')}</span>
          )}
        </div>

        {/* Script preview */}
        {project.script_content && (
          <div className="mt-2 p-2 bg-muted rounded text-xs">
            <p className="line-clamp-2">{project.script_content}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {providerStatus === 'completed' && (
          <>
            {project.video_url && (
              <Button size="sm" variant="outline" asChild>
                <a href={project.video_url} target="_blank" rel="noopener noreferrer">
                  <Play className="h-4 w-4 mr-1" />
                  Preview
                </a>
              </Button>
            )}
            {!project.distributed_via?.length && (
              <Button size="sm" onClick={handlePublish} disabled={publishing}>
                <Share2 className="h-4 w-4 mr-1" />
                Publish
              </Button>
            )}
          </>
        )}

        {providerStatus === 'completed' && project.video_url && (
          <Button size="sm" variant="outline" asChild>
            <a href={project.video_url} download>
              <Download className="h-4 w-4 mr-1" />
              Download
            </a>
          </Button>
        )}

        {!project.compliance_approved && providerStatus === 'pending' && (
          <Button size="sm">
            <CheckCircle className="h-4 w-4 mr-1" />
            Approve Script
          </Button>
        )}
      </div>
    </div>
  )
}
