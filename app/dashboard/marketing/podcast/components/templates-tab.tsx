"use client"

import { useState } from "react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Label } from "@/app/components/ui/label"
import { Textarea } from "@/app/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/app/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import { Plus, FileText, User, BarChart3, Loader2 } from "lucide-react"
import { createPodcastTemplate, updatePodcastTemplate } from "@/app/actions/podcast-generation"

interface Template {
  id: string
  name: string
  template_type: string
  host_name: string
  show_name: string
  use_count: number
  is_active: boolean
  description: string
}

interface TemplatesTabProps {
  templates: Template[]
  loading: boolean
  onUpdate: () => void
}

// podcast_templates.template_type admits exactly: interview | solo |
// educational | market_update | listing_spotlight. Two of the six offered here
// were not admitted — "property_spotlight" (the column says listing_spotlight)
// and "qa" (no such value) — so creating either template failed.
const TEMPLATE_TYPES = [
  { value: "interview", label: "Interview" },
  { value: "solo", label: "Solo Host" },
  { value: "educational", label: "Educational" },
  { value: "market_update", label: "Market Update" },
  { value: "listing_spotlight", label: "Listing Spotlight" },
]

export function TemplatesTab({ templates, loading, onUpdate }: TemplatesTabProps) {
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
  const [processing, setProcessing] = useState(false)
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    templateType: "solo",
    showName: "",
    hostName: "",
    voiceId: "",
  })

  function resetForm() {
    setFormData({
      name: "",
      description: "",
      templateType: "solo",
      showName: "",
      hostName: "",
      voiceId: "",
    })
  }

  function openEditDialog(template: Template) {
    setEditingTemplate(template)
    setFormData({
      name: template.name,
      description: template.description || "",
      templateType: template.template_type,
      showName: template.show_name,
      hostName: template.host_name,
      voiceId: "",
    })
    setIsCreateDialogOpen(true)
  }

  function closeDialog() {
    setIsCreateDialogOpen(false)
    setEditingTemplate(null)
    resetForm()
  }

  async function handleSubmit() {
    setProcessing(true)
    try {
      if (editingTemplate) {
        const result = await updatePodcastTemplate(editingTemplate.id, formData)
        if (result.success) {
          onUpdate()
          closeDialog()
        } else {
          console.error("Failed to update template:", result.error)
        }
      } else {
        const result = await createPodcastTemplate(formData)
        if (result.success) {
          onUpdate()
          closeDialog()
        } else {
          console.error("Failed to create template:", result.error)
        }
      }
    } finally {
      setProcessing(false)
    }
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader>
              <div className="h-5 bg-gray-200 rounded w-3/4" />
              <div className="h-4 bg-gray-200 rounded w-1/2 mt-2" />
            </CardHeader>
            <CardContent>
              <div className="h-16 bg-gray-200 rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        <Button onClick={() => setIsCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="p-4 bg-gray-100 rounded-full mb-4">
            <FileText className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No templates yet</h3>
          <p className="text-sm text-gray-500 max-w-sm mb-4">
            Create podcast templates to streamline your episode creation workflow.
          </p>
          <Button onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create Template
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((template) => (
            <Card
              key={template.id}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => openEditDialog(template)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <CardDescription className="line-clamp-2 mt-1">
                      {template.description || "No description"}
                    </CardDescription>
                  </div>
                  <Badge variant={template.is_active ? "default" : "secondary"}>
                    {template.is_active ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="pb-2">
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex items-center gap-2 text-gray-600">
                    <FileText className="h-4 w-4" />
                    <span className="capitalize">{template.template_type.replace("_", " ")}</span>
                  </div>
                  <div className="flex items-center gap-2 text-gray-600">
                    <User className="h-4 w-4" />
                    <span>{template.host_name}</span>
                  </div>
                </div>
              </CardContent>

              <CardFooter className="pt-2">
                <div className="flex items-center gap-1 text-sm text-gray-500">
                  <BarChart3 className="h-4 w-4" />
                  <span>Used {template.use_count} times</span>
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={closeDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? "Edit Template" : "Create Template"}</DialogTitle>
            <DialogDescription>
              {editingTemplate
                ? "Update your podcast template settings."
                : "Create a new podcast template to streamline episode creation."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Template Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="My Podcast Template"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe what this template is for..."
                rows={3}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="type">Template Type</Label>
              <Select
                value={formData.templateType}
                onValueChange={(value) => setFormData({ ...formData, templateType: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="showName">Show Name</Label>
              <Input
                id="showName"
                value={formData.showName}
                onChange={(e) => setFormData({ ...formData, showName: e.target.value })}
                placeholder="My Real Estate Podcast"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="hostName">Host Name</Label>
              <Input
                id="hostName"
                value={formData.hostName}
                onChange={(e) => setFormData({ ...formData, hostName: e.target.value })}
                placeholder="Jane Smith"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!formData.name || processing}>
              {processing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : editingTemplate ? (
                "Update"
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
