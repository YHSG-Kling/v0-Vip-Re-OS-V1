'use client'

import React, { useState, useEffect } from 'react'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Trash2, Check, Send } from 'lucide-react'
import {
  createTemplate,
  type CreateTemplateInput,
} from '@/app/actions/newsletter/create-template'
import { listTemplates } from '@/app/actions/newsletter/list-templates'
import {
  NEWSLETTER_SECTION_TYPES,
  type NewsletterSectionType,
} from '@/lib/kernel/newsletter/section-types'
import { deleteTemplate } from '@/app/actions/newsletter/delete-template'
import { submitTemplateForApproval } from '@/app/actions/newsletter/approve-template'

interface Template {
  id: string
  template_name: string
  template_description?: string
  brand_colors: Record<string, string>
  logo_url?: string
  approval_status: 'draft' | 'pending_review' | 'approved' | 'rejected'
  is_default: boolean
  version_number: number
  sections: Array<{
    id: string
    section_name: string
    section_type: string
    section_order: number
    is_dynamic: boolean
  }>
  created_at: string
}

export function TemplateBuilder() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const { toast } = useToast()

  // Form state
  const [formData, setFormData] = useState({
    templateName: '',
    templateDescription: '',
    brandColors: { primary: '#000000', secondary: '#FFFFFF', accent: '#0066CC' },
    logoUrl: '',
    sections: [] as Array<{
      // Canonical newsletter section taxonomy — see
      // lib/kernel/newsletter/section-types.ts for the full list + display
      // labels. Legacy keys (real_estate_tip, agent_feature) are aliased.
      sectionType: NewsletterSectionType
      sectionName: string
      aiPrompt?: string
      sectionOrder: number
      isDynamic: boolean
    }>,
  })

  useEffect(() => {
    loadTemplates()
  }, [])

  async function loadTemplates() {
    try {
      setLoading(true)
      const data = await listTemplates()
      setTemplates(data as Template[])
    } catch (error) {
      console.error('Failed to load templates:', error)
      toast({
        title: 'Error',
        description: 'Failed to load newsletter templates',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateTemplate() {
    try {
      setIsSaving(true)

      if (!formData.templateName.trim()) {
        toast({
          title: 'Validation Error',
          description: 'Template name is required',
          variant: 'destructive',
        })
        return
      }

      if (formData.sections.length < 2) {
        toast({
          title: 'Validation Error',
          description: 'Template must have at least 2 sections',
          variant: 'destructive',
        })
        return
      }

      const input: CreateTemplateInput = {
        templateName: formData.templateName,
        templateDescription: formData.templateDescription,
        brandColors: formData.brandColors,
        logoUrl: formData.logoUrl,
        sections: formData.sections,
      }

      const result = await createTemplate(input)

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        })

        setFormData({
          templateName: '',
          templateDescription: '',
          brandColors: { primary: '#000000', secondary: '#FFFFFF', accent: '#0066CC' },
          logoUrl: '',
          sections: [],
        })

        setIsDialogOpen(false)
        await loadTemplates()
      }
    } catch (error) {
      console.error('Failed to create template:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create template',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSubmitForApproval(templateId: string) {
    try {
      setIsSaving(true)
      const result = await submitTemplateForApproval(templateId)

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        })

        await loadTemplates()
      }
    } catch (error) {
      console.error('Failed to submit for approval:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to submit for approval',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteTemplate(templateId: string) {
    try {
      setIsSaving(true)
      const result = await deleteTemplate(templateId)

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        })

        await loadTemplates()
      }
    } catch (error) {
      console.error('Failed to delete template:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete template',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Newsletter Templates</h2>
          <p className="text-sm text-slate-500 mt-1">
            Create and manage broker-approved newsletter templates
          </p>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              New Template
            </Button>
          </DialogTrigger>

          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create New Newsletter Template</DialogTitle>
              <DialogDescription>
                Build a professional newsletter template for your brokerage
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="basic" className="space-y-4">
              <TabsList>
                <TabsTrigger value="basic">Basic Info</TabsTrigger>
                <TabsTrigger value="sections">Sections</TabsTrigger>
                <TabsTrigger value="branding">Branding</TabsTrigger>
              </TabsList>

              <TabsContent value="basic" className="space-y-4">
                <div>
                  <Label htmlFor="template-name">Template Name *</Label>
                  <Input
                    id="template-name"
                    placeholder="e.g., Weekly Market Update"
                    value={formData.templateName}
                    onChange={e => setFormData({ ...formData, templateName: e.target.value })}
                  />
                </div>

                <div>
                  <Label htmlFor="template-description">Description</Label>
                  <Input
                    id="template-description"
                    placeholder="What is this template for?"
                    value={formData.templateDescription}
                    onChange={e =>
                      setFormData({ ...formData, templateDescription: e.target.value })
                    }
                  />
                </div>
              </TabsContent>

              <TabsContent value="sections" className="space-y-4">
                <div>
                  <Label>Include Sections * (minimum 2)</Label>
                  <div className="space-y-3 mt-3">
                    {Object.values(NEWSLETTER_SECTION_TYPES)
                      .filter(def => def.key !== 'custom')
                      .map(def => ({ type: def.key, label: def.label }))
                      .map(section => (
                      <div key={section.type} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id={section.type}
                          checked={formData.sections.some(s => s.sectionType === section.type)}
                          onChange={e => {
                            if (e.target.checked) {
                              setFormData({
                                ...formData,
                                sections: [
                                  ...formData.sections,
                                  {
                                    sectionType: section.type,
                                    sectionName: section.label,
                                    sectionOrder: formData.sections.length + 1,
                                    isDynamic: true,
                                  },
                                ],
                              })
                            } else {
                              setFormData({
                                ...formData,
                                sections: formData.sections.filter(
                                  s => s.sectionType !== section.type,
                                ),
                              })
                            }
                          }}
                          className="w-4 h-4"
                        />
                        <Label htmlFor={section.type} className="cursor-pointer">
                          {section.label}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="branding" className="space-y-4">
                <div>
                  <Label htmlFor="logo-url">Logo URL</Label>
                  <Input
                    id="logo-url"
                    placeholder="https://example.com/logo.png"
                    value={formData.logoUrl}
                    onChange={e => setFormData({ ...formData, logoUrl: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <Label htmlFor="primary-color">Primary Color</Label>
                    <Input
                      id="primary-color"
                      type="color"
                      value={formData.brandColors.primary}
                      onChange={e =>
                        setFormData({
                          ...formData,
                          brandColors: { ...formData.brandColors, primary: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="secondary-color">Secondary Color</Label>
                    <Input
                      id="secondary-color"
                      type="color"
                      value={formData.brandColors.secondary}
                      onChange={e =>
                        setFormData({
                          ...formData,
                          brandColors: { ...formData.brandColors, secondary: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="accent-color">Accent Color</Label>
                    <Input
                      id="accent-color"
                      type="color"
                      value={formData.brandColors.accent}
                      onChange={e =>
                        setFormData({
                          ...formData,
                          brandColors: { ...formData.brandColors, accent: e.target.value },
                        })
                      }
                    />
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex gap-3 justify-end pt-4">
              <Button
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button onClick={handleCreateTemplate} disabled={isSaving} className="gap-2">
                {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Template
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Templates Grid */}
      <div className="space-y-4">
        {templates.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-slate-500 mb-4">No templates created yet</p>
              <Button variant="outline" onClick={() => setIsDialogOpen(true)}>
                Create your first template
              </Button>
            </CardContent>
          </Card>
        ) : (
          templates.map(template => (
            <Card key={template.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <CardTitle>{template.template_name}</CardTitle>
                      <Badge
                        variant={
                          template.approval_status === 'approved'
                            ? 'default'
                            : template.approval_status === 'pending_review'
                              ? 'secondary'
                              : 'outline'
                        }
                        className="gap-1"
                      >
                        {template.approval_status === 'approved' && (
                          <Check className="w-3 h-3" />
                        )}
                        {template.approval_status.replace('_', ' ').toUpperCase()}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">
                      {template.sections.length} sections • v{template.version_number}
                    </CardDescription>
                  </div>

                  <div className="flex gap-2">
                    {template.approval_status === 'draft' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSubmitForApproval(template.id)}
                        disabled={isSaving}
                        className="gap-2"
                      >
                        <Send className="w-4 h-4" />
                        Submit
                      </Button>
                    )}

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteTemplate(template.id)}
                      disabled={isSaving}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              {template.template_description && (
                <CardContent className="pt-0">
                  <p className="text-sm text-slate-600">{template.template_description}</p>
                </CardContent>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  )
}
