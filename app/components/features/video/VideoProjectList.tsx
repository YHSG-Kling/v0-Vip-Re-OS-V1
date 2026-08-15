"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { createVideoProjectAction } from "@/app/actions/video"
import type { VideoProject } from "@/app/actions/video/create-video-project"

interface VideoProjectListProps {
  brokerageId: string
  initialProjects?: VideoProject[]
  selectedProjectId?: string | null
  onSelect?: (id: string) => void
  onProjectCreated?: (projectId: string) => void
}

export function VideoProjectList({
  brokerageId,
  initialProjects = [],
  selectedProjectId,
  onSelect,
  onProjectCreated,
}: VideoProjectListProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newProject, setNewProject] = useState({ title: "", description: "" })

  async function handleCreate() {
    if (!newProject.title) return

    setIsLoading(true)
    const result = await createVideoProjectAction({
      agentId: "",
      brokerageId,
      title: newProject.title,
      description: newProject.description,
      sourceType: "manual",
    })

    if (result.success && result.data) {
      onProjectCreated?.(result.data.projectId)
      setNewProject({ title: "", description: "" })
      setShowCreate(false)
      router.refresh()
    }
    setIsLoading(false)
  }

  const statusColors: Record<string, string> = {
    draft: "secondary",
    setup: "secondary",
    scripting: "outline",
    generating: "outline",
    ready: "default",
    published: "default",
    failed: "destructive",
    distributed: "default",
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Video Projects</h2>
        <Button onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "New Project"}
        </Button>
      </div>

      {showCreate && (
        <Card>
          <CardHeader>
            <CardTitle>Create New Video Project</CardTitle>
            <CardDescription>Start a new video project for your listings or marketing campaigns</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              placeholder="Project title"
              value={newProject.title}
              onChange={(e) => setNewProject({ ...newProject, title: e.target.value })}
            />
            <Textarea
              placeholder="Description (optional)"
              value={newProject.description}
              onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
              rows={3}
            />
            <Button onClick={handleCreate} disabled={isLoading} className="w-full">
              {isLoading ? "Creating..." : "Create Project"}
            </Button>
          </CardContent>
        </Card>
      )}

      {initialProjects.length > 0 ? (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
          {initialProjects.map((project) => (
            <Card
              key={project.id}
              className={`cursor-pointer transition-colors hover:border-primary/50 ${
                selectedProjectId === project.id ? "border-primary ring-1 ring-primary" : ""
              }`}
              onClick={() => onSelect?.(project.id)}
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{project.title}</CardTitle>
                  <Badge variant={(statusColors[project.status] ?? "outline") as any}>
                    {project.status}
                  </Badge>
                </div>
                <CardDescription>
                  {project.video_type} • {new Date(project.created_at).toLocaleDateString()}
                </CardDescription>
              </CardHeader>
              {project.thumbnail_url && (
                <CardContent>
                  <img
                    src={project.thumbnail_url}
                    alt={project.title}
                    className="w-full h-32 object-cover rounded-md"
                  />
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      ) : !showCreate ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            No video projects yet. Create one to get started.
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
