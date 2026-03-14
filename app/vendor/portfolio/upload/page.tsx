'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Image, ArrowLeft, Upload } from 'lucide-react'
import Link from 'next/link'

export default function VendorPortfolioUploadPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ title: '', description: '', project_type: '' })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => { router.push('/vendor/portfolio') }, 1000)
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/vendor/portfolio"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Upload className="w-6 h-6 text-purple-600" />
          Upload Portfolio Work
        </h1>
      </div>
      <Card>
        <CardContent className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Project Title</Label>
              <Input value={form.title} onChange={e => setForm({...form, title: e.target.value})} placeholder="e.g. 4BR Home Inspection - Maple Ave" required />
            </div>
            <div>
              <Label>Project Type</Label>
              <Input value={form.project_type} onChange={e => setForm({...form, project_type: e.target.value})} placeholder="e.g. Home Inspection, Photography, Staging" />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Describe this project..." rows={3} />
            </div>
            <div>
              <Label>Upload Photos / Files</Label>
              <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
                <Image className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">Click to upload or drag and drop</p>
                <p className="text-xs text-muted-foreground mt-1">PNG, JPG, PDF up to 50MB</p>
                <Input type="file" multiple accept="image/*,.pdf" className="mt-3" />
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="submit" className="bg-purple-600 hover:bg-purple-700 text-white" disabled={loading}>
                {loading ? 'Uploading...' : 'Upload to Portfolio'}
              </Button>
              <Link href="/vendor/portfolio"><Button variant="outline" type="button">Cancel</Button></Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
