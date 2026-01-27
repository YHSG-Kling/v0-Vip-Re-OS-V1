"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FileText, Search, CheckCircle } from "lucide-react"
import { getChatTemplates, useChatTemplate } from "@/app/actions/ai-chat"

export default function TemplateSelector({
  leadType,
  sessionId,
  onSelectTemplate,
}: {
  leadType?: string
  sessionId: string
  onSelectTemplate: (template: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState<any[]>([])
  const [filteredTemplates, setFilteredTemplates] = useState<any[]>([])
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedTemplate, setSelectedTemplate] = useState<any | null>(null)

  useEffect(() => {
    if (open) {
      loadTemplates()
    }
  }, [open, leadType])

  useEffect(() => {
    if (searchTerm) {
      setFilteredTemplates(
        templates.filter(
          (t) =>
            t.template_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            t.template_content.toLowerCase().includes(searchTerm.toLowerCase()),
        ),
      )
    } else {
      setFilteredTemplates(templates)
    }
  }, [searchTerm, templates])

  const loadTemplates = async () => {
    try {
      const data = await getChatTemplates({
        leadType,
        complianceApproved: true,
      })
      setTemplates(data)
      setFilteredTemplates(data)
    } catch (error) {
      console.error("Error loading templates:", error)
    }
  }

  const handleSelectTemplate = async (template: any) => {
    setSelectedTemplate(template)
    setOpen(false)
  }

  useEffect(() => {
    if (selectedTemplate) {
      const fetchPersonalizedContent = async () => {
        try {
          const { personalizedContent } = await useChatTemplate(selectedTemplate.id, sessionId)
          onSelectTemplate(personalizedContent)
        } catch (error) {
          console.error("Error using template:", error)
        }
      }
      fetchPersonalizedContent()
    }
  }, [selectedTemplate, sessionId, onSelectTemplate])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileText className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] bg-background">
        <DialogHeader>
          <DialogTitle className="text-foreground">Select a Template</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search templates..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 bg-background text-foreground"
            />
          </div>

          {/* Templates List */}
          <ScrollArea className="h-[500px]">
            <div className="space-y-3">
              {filteredTemplates.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No templates found</p>
                </div>
              ) : (
                filteredTemplates.map((template) => (
                  <Card
                    key={template.id}
                    className="cursor-pointer hover:shadow-md transition-shadow bg-background border"
                    onClick={() => handleSelectTemplate(template)}
                  >
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h4 className="font-semibold text-foreground">{template.template_name}</h4>
                          <p className="text-xs text-muted-foreground mt-1">
                            {template.template_category.replace("_", " ")} • Used {template.usage_count} times
                          </p>
                        </div>
                        <div className="flex gap-2">
                          {template.compliance_approved && (
                            <Badge variant="default" className="text-xs">
                              <CheckCircle className="w-3 h-3 mr-1" />
                              Approved
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-xs">
                            Score: {template.them_first_score}
                          </Badge>
                        </div>
                      </div>

                      <div className="bg-muted p-3 rounded text-sm text-foreground">
                        <p className="line-clamp-3">{template.template_content}</p>
                      </div>

                      {template.target_scenario && (
                        <p className="text-xs text-muted-foreground">
                          <strong>When to use:</strong> {template.target_scenario}
                        </p>
                      )}

                      <div className="flex gap-2">
                        {template.allowed_lead_types?.map((type: string) => (
                          <Badge key={type} variant="secondary" className="text-xs">
                            {type}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}
