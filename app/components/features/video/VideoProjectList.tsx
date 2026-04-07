"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createVideoProjectAction } from "@/app/actions/video"

export function VideoProjectList({ brokerageId }: { brokerageId: string }) {
  const [projects, setProjects] = useState<any[]>([])
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

    if (result.success) {
      setProjects([...projects, result.data])
      setNewProject({ title: "", description: "" })
      setShowCreate(false)
    }
    setIsLoading(false)
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

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        {projects.map((project) => (
          <Card key={project.projectId}>
            <CardHeader>
              <CardTitle className="text-lg">{project.title}</CardTitle>
              <CardDescription>Created: {new Date(project.createdAt).toLocaleDateString()}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button size="sm" variant="outline">
                  Edit
                </Button>
                <Button size="sm" variant="outline">
                  Preview
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {projects.length === 0 && !showCreate && (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            No video projects yet. Create one to get started.
          </CardContent>
        </Card>
      )}
    </div>
  )
}
