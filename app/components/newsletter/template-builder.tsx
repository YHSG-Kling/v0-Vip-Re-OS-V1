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
import { Loader2, Plus, Trash2, Check, Send, X } from 'lucide-react'
import {
  createTemplate,
  type CreateTemplateInput,
} from '@/app/actions/newsletter/create-template'
import { listTemplates } from '@/app/actions/newsletter/list-templates'
import {
  NEWSLETTER_SECTION_TYPES,
  type NewsletterSectionType,
} from '@/lib/kernel/newsletter/section-types'
import type { TemplateSectionBlueprint } from '@/lib/kernel/newsletter/template-blueprint'
import { deleteTemplate } from '@/app/actions/newsletter/delete-template'
import {
  submitTemplateForApproval,
  approveTemplate,
  rejectTemplate,
  canApproveNewsletterTemplates,
} from '@/app/actions/newsletter/approve-template'
import {
  updateTemplate,
  type UpdateTemplateInput,
} from '@/app/actions/newsletter/update-template'
import { Pencil } from 'lucide-react'

interface Template {
  id: string
  template_name: string
  template_description?: string
  brand_colors: Record<string, string>
  logo_url?: string
  approval_status: 'draft' | 'pending_review' | 'approved' | 'rejected'
  is_default: boolean
  version_number: number
  /** Decoded section blueprint stored on the template row. `null` means the
   *  template carries no blueprint (prose content, or created by another
   *  producer) — distinct from `[]`, which means it was authored with no
   *  sections. The card must not print a count for the null case. */
  sections: TemplateSectionBlueprint[] | null
  created_at: string
}

export function TemplateBuilder() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({
    templateName: '',
    templateDescription: '',
    brandColors: { primary: '#000000', secondary: '#FFFFFF', accent: '#0066CC' },
    logoUrl: '',
    isDefault: false,
  })
  const { toast } = useToast()

  // ── THE APPROVAL RAIL'S OTHER HALF ──────────────────────────────────────────
  // Templates could be SUBMITTED for approval from this screen and then nothing:
  // no verb anywhere in the tree flipped a pending_review row to approved or
  // rejected, and scheduleNewsletter refuses an unapproved template — so every
  // submitted template was stuck forever. `canApprove` decides whether the
  // decision buttons are drawn; the server enforces the same predicate on the
  // write, so this is presentation, not the boundary.
  const [canApprove, setCanApprove] = useState(false)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

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
    // Authority probe. A refused/absent answer leaves canApprove false, so the
    // decision buttons simply are not drawn — never drawn optimistically.
    canApproveNewsletterTemplates()
      .then(r => setCanApprove(r.allowed))
      .catch(() => setCanApprove(false))
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

  async function handleApproveTemplate(templateId: string) {
    try {
      setIsSaving(true)
      const result = await approveTemplate(templateId)
      if (result.success) {
        toast({ title: 'Approved', description: result.message })
        await loadTemplates()
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to approve template',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleRejectTemplate(templateId: string) {
    const reason = rejectReason.trim()
    // rejected_reason is the whole point of a rejection — an empty one tells the
    // author nothing and the row would record a decision with no cause.
    if (reason.length < 5) {
      toast({
        title: 'Reason required',
        description: 'Say what needs to change — at least a few words.',
        variant: 'destructive',
      })
      return
    }
    try {
      setIsSaving(true)
      const result = await rejectTemplate(templateId, reason)
      if (result.success) {
        toast({ title: 'Rejected', description: result.message })
        setRejectingId(null)
        setRejectReason('')
        await loadTemplates()
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to reject template',
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

  function handleOpenEdit(template: Template) {
    setEditingTemplateId(template.id)
    setEditForm({
      templateName: template.template_name,
      templateDescription: template.template_description ?? '',
      brandColors: {
        primary: template.brand_colors?.primary ?? '#000000',
        secondary: template.brand_colors?.secondary ?? '#FFFFFF',
        accent: template.brand_colors?.accent ?? '#0066CC',
      },
      logoUrl: template.logo_url ?? '',
      isDefault: template.is_default,
    })
    setIsEditDialogOpen(true)
  }

  async function handleUpdateTemplate() {
    if (!editingTemplateId) return

    try {
      setIsSaving(true)

      if (!editForm.templateName.trim()) {
        toast({
          title: 'Validation Error',
          description: 'Template name is required',
          variant: 'destructive',
        })
        return
      }

      const input: UpdateTemplateInput = {
        templateId: editingTemplateId,
        templateName: editForm.templateName,
        templateDescription: editForm.templateDescription,
        brandColors: editForm.brandColors,
        logoUrl: editForm.logoUrl,
        isDefault: editForm.isDefault,
      }

      const result = await updateTemplate(input)

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        })

        setIsEditDialogOpen(false)
        setEditingTemplateId(null)
        await loadTemplates()
      }
    } catch (error) {
      console.error('Failed to update template:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update template',
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
                      v{template.version_number}
                    </CardDescription>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleOpenEdit(template)}
                      disabled={isSaving}
                      className="gap-2"
                    >
                      <Pencil className="w-4 h-4" />
                      Edit
                    </Button>

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

                    {/* The decision. Only drawn for broker-side reviewers (and
                        solo-tier principals, who ARE their own broker) and only
                        on a template that is actually waiting. */}
                    {canApprove && template.approval_status === 'pending_review' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => handleApproveTemplate(template.id)}
                          disabled={isSaving}
                          className="gap-2"
                        >
                          <Check className="w-4 h-4" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRejectingId(rejectingId === template.id ? null : template.id)
                            setRejectReason('')
                          }}
                          disabled={isSaving}
                          className="gap-2 text-red-600"
                        >
                          <X className="w-4 h-4" />
                          Reject
                        </Button>
                      </>
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

              {(template.template_description || template.sections || rejectingId === template.id) && (
                <CardContent className="pt-0 space-y-2">
                  {rejectingId === template.id && (
                    <div className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-3">
                      <Label className="text-xs text-red-800">
                        Why is this being rejected? The author sees this reason.
                      </Label>
                      <Input
                        value={rejectReason}
                        onChange={e => setRejectReason(e.target.value)}
                        placeholder="e.g. Logo is the old brand mark — swap it and resubmit."
                        disabled={isSaving}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleRejectTemplate(template.id)}
                          disabled={isSaving}
                        >
                          {isSaving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                          Confirm rejection
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRejectingId(null)
                            setRejectReason('')
                          }}
                          disabled={isSaving}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {template.template_description && (
                    <p className="text-sm text-slate-600">{template.template_description}</p>
                  )}
                  {/* Only rendered when a blueprint was actually decoded. A
                      template with no blueprint shows nothing here rather than
                      "0 sections", which would be a number we did not read. */}
                  {template.sections && (
                    <p className="text-xs text-slate-500">
                      {template.sections.length} section{template.sections.length === 1 ? '' : 's'}
                      {template.sections.length > 0 && (
                        <>: {template.sections.map(s => s.sectionName).join(' · ')}</>
                      )}
                    </p>
                  )}
                </CardContent>
              )}
            </Card>
          ))
        )}
      </div>

      {/* Edit Template Dialog */}
      <Dialog
        open={isEditDialogOpen}
        onOpenChange={open => {
          setIsEditDialogOpen(open)
          if (!open) setEditingTemplateId(null)
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Newsletter Template</DialogTitle>
            <DialogDescription>
              Update the name, description, branding, and default status of this template
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="basic" className="space-y-4">
            <TabsList>
              <TabsTrigger value="basic">Basic Info</TabsTrigger>
              <TabsTrigger value="branding">Branding</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="space-y-4">
              <div>
                <Label htmlFor="edit-template-name">Template Name *</Label>
                <Input
                  id="edit-template-name"
                  placeholder="e.g., Weekly Market Update"
                  value={editForm.templateName}
                  onChange={e => setEditForm({ ...editForm, templateName: e.target.value })}
                />
              </div>

              <div>
                <Label htmlFor="edit-template-description">Description</Label>
                <Input
                  id="edit-template-description"
                  placeholder="What is this template for?"
                  value={editForm.templateDescription}
                  onChange={e =>
                    setEditForm({ ...editForm, templateDescription: e.target.value })
                  }
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="edit-is-default"
                  checked={editForm.isDefault}
                  onChange={e => setEditForm({ ...editForm, isDefault: e.target.checked })}
                  className="w-4 h-4"
                />
                <Label htmlFor="edit-is-default" className="cursor-pointer">
                  Set as default template
                </Label>
              </div>
            </TabsContent>

            <TabsContent value="branding" className="space-y-4">
              <div>
                <Label htmlFor="edit-logo-url">Logo URL</Label>
                <Input
                  id="edit-logo-url"
                  placeholder="https://example.com/logo.png"
                  value={editForm.logoUrl}
                  onChange={e => setEditForm({ ...editForm, logoUrl: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="edit-primary-color">Primary Color</Label>
                  <Input
                    id="edit-primary-color"
                    type="color"
                    value={editForm.brandColors.primary}
                    onChange={e =>
                      setEditForm({
                        ...editForm,
                        brandColors: { ...editForm.brandColors, primary: e.target.value },
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="edit-secondary-color">Secondary Color</Label>
                  <Input
                    id="edit-secondary-color"
                    type="color"
                    value={editForm.brandColors.secondary}
                    onChange={e =>
                      setEditForm({
                        ...editForm,
                        brandColors: { ...editForm.brandColors, secondary: e.target.value },
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="edit-accent-color">Accent Color</Label>
                  <Input
                    id="edit-accent-color"
                    type="color"
                    value={editForm.brandColors.accent}
                    onChange={e =>
                      setEditForm({
                        ...editForm,
                        brandColors: { ...editForm.brandColors, accent: e.target.value },
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
              onClick={() => setIsEditDialogOpen(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleUpdateTemplate} disabled={isSaving} className="gap-2">
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
