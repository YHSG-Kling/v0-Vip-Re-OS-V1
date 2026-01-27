"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  ArrowLeft,
  Search,
  MessageCircle,
  Phone,
  Mail,
  FileText,
  Home,
  DollarSign,
  Calendar,
  HelpCircle,
  ExternalLink,
} from "lucide-react"

interface Contact {
  id: string
  first_name?: string
  last_name?: string
  name?: string
  agents?: {
    name?: string
    first_name?: string
    last_name?: string
    phone?: string
    email?: string
  }
}

interface HelpPageContentProps {
  contact: Contact
  contactId: string
}

export default function HelpPageContent({ contact, contactId }: HelpPageContentProps) {
  const faqs = [
    {
      icon: Home,
      question: "How do I schedule a showing?",
      answer:
        "Navigate to the Properties tab, find a property you like, and click 'Schedule Showing'. You can select your preferred dates and times.",
    },
    {
      icon: DollarSign,
      question: "How do I submit an offer?",
      answer:
        "When you're ready to make an offer, go to the property page and click 'Make Offer'. Your agent will guide you through the process.",
    },
    {
      icon: FileText,
      question: "Where can I find my documents?",
      answer:
        "All your documents are available in the Documents tab. You can view, download, and upload documents there.",
    },
    {
      icon: Calendar,
      question: "How do I track my transaction progress?",
      answer:
        "Your Dashboard shows your current journey progress and upcoming milestones. The Journey tab has detailed step-by-step tracking.",
    },
    {
      icon: MessageCircle,
      question: "How do I contact my agent?",
      answer:
        "You can message your agent directly through the portal or use the contact information below to call or email them.",
    },
  ]

  const agentName =
    contact.agents?.name || contact.agents?.first_name
      ? `${contact.agents?.first_name} ${contact.agents?.last_name || ""}`.trim()
      : "Your Agent"

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href={`/portal/${contactId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Help & Support</h1>
          <p className="text-muted-foreground">Find answers and get assistance</p>
        </div>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search for help..." className="pl-10" />
          </div>
        </CardContent>
      </Card>

      {/* Contact Your Agent */}
      <Card className="bg-primary/5 border-primary/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-primary" />
            Contact Your Agent
          </CardTitle>
          <CardDescription>Get personalized help from {agentName}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <Button variant="default">
              <MessageCircle className="h-4 w-4 mr-2" />
              Send Message
            </Button>
            <Button variant="outline">
              <Phone className="h-4 w-4 mr-2" />
              {contact.agents?.phone || "(555) 123-4567"}
            </Button>
            <Button variant="outline">
              <Mail className="h-4 w-4 mr-2" />
              Email Agent
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* FAQs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5" />
            Frequently Asked Questions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {faqs.map((faq, index) => {
            const Icon = faq.icon
            return (
              <div key={index} className="p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="font-medium">{faq.question}</h3>
                    <p className="text-sm text-muted-foreground">{faq.answer}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* Additional Resources */}
      <Card>
        <CardHeader>
          <CardTitle>Additional Resources</CardTitle>
          <CardDescription>Helpful guides and information</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link
              href={`/portal/${contactId}/journey`}
              className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
            >
              <div className="p-2 rounded-lg bg-blue-100">
                <FileText className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="font-medium">Homebuying Guide</p>
                <p className="text-sm text-muted-foreground">Step-by-step process</p>
              </div>
              <ExternalLink className="h-4 w-4 ml-auto text-muted-foreground" />
            </Link>

            <Link
              href={`/portal/${contactId}/documents`}
              className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
            >
              <div className="p-2 rounded-lg bg-green-100">
                <FileText className="h-4 w-4 text-green-600" />
              </div>
              <div>
                <p className="font-medium">Document Checklist</p>
                <p className="text-sm text-muted-foreground">Required paperwork</p>
              </div>
              <ExternalLink className="h-4 w-4 ml-auto text-muted-foreground" />
            </Link>

            <a
              href="https://www.hud.gov/topics/buying_a_home"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
            >
              <div className="p-2 rounded-lg bg-purple-100">
                <Home className="h-4 w-4 text-purple-600" />
              </div>
              <div>
                <p className="font-medium">HUD Resources</p>
                <p className="text-sm text-muted-foreground">Official homebuyer info</p>
              </div>
              <ExternalLink className="h-4 w-4 ml-auto text-muted-foreground" />
            </a>

            <a
              href="https://www.consumerfinance.gov/owning-a-home/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent/50 transition-colors"
            >
              <div className="p-2 rounded-lg bg-amber-100">
                <DollarSign className="h-4 w-4 text-amber-600" />
              </div>
              <div>
                <p className="font-medium">CFPB Guide</p>
                <p className="text-sm text-muted-foreground">Financial protection info</p>
              </div>
              <ExternalLink className="h-4 w-4 ml-auto text-muted-foreground" />
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Emergency Contact */}
      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-full bg-amber-100">
              <Phone className="h-6 w-6 text-amber-600" />
            </div>
            <div>
              <p className="font-medium">Need Urgent Help?</p>
              <p className="text-sm text-muted-foreground">
                Call our support line: <strong>(800) 555-0199</strong>
              </p>
              <p className="text-xs text-muted-foreground mt-1">Available Monday - Friday, 9am - 6pm EST</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
