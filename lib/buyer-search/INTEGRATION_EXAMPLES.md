# System 5.1B – Integration Examples

Complete code examples for integrating the buyer-initiated search system into your application.

---

## Example 1: Simple Search Bar Component

**Use Case**: Buyer portal with basic search functionality

```tsx
'use client'

import { useState } from 'react'
import { searchPropertiesWithNaturalLanguage } from '@/app/actions/buyer-property-search'
import type { BuyerSearchResult } from '@/app/actions/buyer-property-search'

interface SearchBarProps {
  contactId: string // Authenticated buyer ID
}

export function PropertySearchBar({ contactId }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BuyerSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    
    if (query.trim().length < 5) {
      setError('Please enter a more detailed search')
      return
    }

    setLoading(true)
    setError(null)

    const response = await searchPropertiesWithNaturalLanguage({
      contactId,
      naturalLanguageQuery: query,
      options: { limit: 20 }
    })

    if (response.success) {
      setResults(response.results)
      if (response.results.length === 0) {
        setError('No properties match your criteria. Try adjusting your search.')
      }
    } else {
      setError(response.error || 'Search failed')
    }

    setLoading(false)
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Try: 3 bed house under $400k in Austin"
          className="flex-1 px-4 py-2 border rounded-lg"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || query.trim().length < 5}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {results.map((result) => (
          <PropertyCard key={result.listing_id} result={result} />
        ))}
      </div>
    </div>
  )
}

function PropertyCard({ result }: { result: BuyerSearchResult }) {
  return (
    <div className="p-6 border rounded-lg hover:shadow-lg transition-shadow">
      <h3 className="text-xl font-semibold mb-2">{result.headline}</h3>
      
      <div className="flex gap-4 text-sm text-gray-600 mb-4">
        <span>${(result.price! / 1000).toFixed(0)}K</span>
        <span>{result.bedrooms} bed</span>
        <span>{result.bathrooms} bath</span>
        <span>{result.city}, {result.state}</span>
      </div>

      <ul className="space-y-2 mb-4">
        {result.bullets.map((bullet, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-green-600 mt-1">✓</span>
            <span className="text-gray-700">{bullet}</span>
          </li>
        ))}
      </ul>

      <p className="text-gray-600 mb-4">{result.narrative}</p>

      <button className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
        {result.callToAction}
      </button>
    </div>
  )
}
```

---

## Example 2: AI Chatbot Integration

**Use Case**: Conversational property search within a chatbot

```typescript
import { searchPropertiesWithNaturalLanguage, previewSearchIntent } from '@/app/actions/buyer-property-search'

// In your chatbot message handler
async function handleChatMessage(contactId: string, message: string) {
  // Detect if message is a search query
  if (isSearchIntent(message)) {
    // Preview what we understood
    const preview = await previewSearchIntent({
      contactId,
      naturalLanguageQuery: message
    })

    if (preview.success && preview.preview.ambiguities.length > 0) {
      // Ask for clarification
      return {
        type: 'clarification',
        message: `I understood: ${preview.preview.understood.bedrooms} bedrooms, ${preview.preview.understood.price_range}. Could you clarify: ${preview.preview.ambiguities.join(', ')}?`,
        preview: preview.preview
      }
    }

    // Execute search
    const results = await searchPropertiesWithNaturalLanguage({
      contactId,
      naturalLanguageQuery: message,
      options: { limit: 5 } // Limit for chat context
    })

    if (results.success && results.results.length > 0) {
      return {
        type: 'property_results',
        message: `I found ${results.results.length} properties that match:`,
        properties: results.results,
        metadata: results.metadata
      }
    } else {
      return {
        type: 'no_results',
        message: 'I couldn\'t find properties matching those criteria. Would you like to adjust your search?',
        suggestions: generateSearchSuggestions(preview.preview)
      }
    }
  }

  // Handle non-search messages...
}

function isSearchIntent(message: string): boolean {
  const searchKeywords = [
    'looking for',
    'need',
    'want',
    'find',
    'show me',
    'search',
    'bedroom',
    'house',
    'condo',
    'property'
  ]

  const lowerMessage = message.toLowerCase()
  return searchKeywords.some(keyword => lowerMessage.includes(keyword))
}

function generateSearchSuggestions(preview: any): string[] {
  const suggestions: string[] = []

  if (preview.ambiguities.includes('No price range specified')) {
    suggestions.push('Add a budget: "under $400k"')
  }

  if (preview.ambiguities.includes('No location specified')) {
    suggestions.push('Add a location: "in Austin"')
  }

  if (preview.ambiguities.includes('No bedroom count specified')) {
    suggestions.push('Add bedrooms: "3+ beds"')
  }

  return suggestions
}
```

---

## Example 3: Intent Preview (Clarification UI)

**Use Case**: Show buyer what was understood before executing search

```tsx
'use client'

import { useState, useEffect } from 'react'
import { previewSearchIntent, searchPropertiesWithNaturalLanguage } from '@/app/actions/buyer-property-search'

export function SearchWithPreview({ contactId }: { contactId: string }) {
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [results, setResults] = useState<any[]>([])

  // Live preview as user types
  useEffect(() => {
    if (query.length < 10) {
      setPreview(null)
      return
    }

    const timer = setTimeout(async () => {
      const response = await previewSearchIntent({
        contactId,
        naturalLanguageQuery: query
      })

      if (response.success) {
        setPreview(response.preview)
      }
    }, 500) // Debounce 500ms

    return () => clearTimeout(timer)
  }, [query, contactId])

  async function executeSearch() {
    const response = await searchPropertiesWithNaturalLanguage({
      contactId,
      naturalLanguageQuery: query,
      options: { limit: 20 }
    })

    if (response.success) {
      setResults(response.results)
    }
  }

  return (
    <div className="space-y-4">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Describe what you're looking for..."
        className="w-full px-4 py-3 border rounded-lg"
      />

      {preview && (
        <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h4 className="font-semibold mb-2">Here's what I understood:</h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="font-medium">Price:</span> {preview.understood.price_range}
            </div>
            <div>
              <span className="font-medium">Bedrooms:</span> {preview.understood.bedrooms}
            </div>
            <div>
              <span className="font-medium">Location:</span> {preview.understood.location}
            </div>
            <div>
              <span className="font-medium">Type:</span> {preview.understood.property_type}
            </div>
          </div>

          {preview.ambiguities.length > 0 && (
            <div className="mt-3 text-sm text-orange-700">
              <span className="font-medium">Could you clarify:</span> {preview.ambiguities.join(', ')}
            </div>
          )}

          <div className="mt-3">
            <span className="text-xs text-gray-600">
              Confidence: {(preview.confidence * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      )}

      <button
        onClick={executeSearch}
        disabled={!preview || preview.confidence < 0.3}
        className="px-6 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50"
      >
        Search Properties
      </button>

      {/* Results display */}
      <div className="space-y-4">
        {results.map((result) => (
          <div key={result.listing_id}>{/* Property card */}</div>
        ))}
      </div>
    </div>
  )
}
```

---

## Example 4: Property Detail Explanation

**Use Case**: Explain why a specific property was recommended

```tsx
'use client'

import { useState, useEffect } from 'react'
import { explainPropertyMatchForBuyer } from '@/app/actions/buyer-property-search'

interface PropertyExplanationProps {
  contactId: string
  listingId: string
}

export function PropertyMatchExplanation({ contactId, listingId }: PropertyExplanationProps) {
  const [explanation, setExplanation] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadExplanation() {
      const response = await explainPropertyMatchForBuyer({
        contactId,
        listingId,
        context: 'Why was this recommended?'
      })

      if (response.success) {
        setExplanation(response.explanation)
      }
      setLoading(false)
    }

    loadExplanation()
  }, [contactId, listingId])

  if (loading) {
    return <div>Loading explanation...</div>
  }

  if (!explanation) {
    return null
  }

  return (
    <div className="p-6 bg-gradient-to-br from-blue-50 to-white rounded-lg border border-blue-100">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-2xl">💡</span>
        <h3 className="text-lg font-semibold">Why We Recommended This</h3>
      </div>

      <h4 className="text-xl font-semibold mb-3">{explanation.headline}</h4>

      <ul className="space-y-2 mb-4">
        {explanation.bullets.map((bullet: string, i: number) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-green-600 font-bold">→</span>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>

      <p className="text-gray-700 italic mb-4">{explanation.narrative}</p>

      <button className="w-full py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">
        {explanation.callToAction}
      </button>
    </div>
  )
}
```

---

## Example 5: Saved Searches (Future-Ready)

**Use Case**: Allow buyers to save search criteria for future notifications

```tsx
'use client'

import { useState } from 'react'
import { previewSearchIntent } from '@/app/actions/buyer-property-search'

export function SaveSearchButton({ contactId, query }: { contactId: string, query: string }) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function handleSave() {
    setSaving(true)

    // Preview the intent to show what's being saved
    const preview = await previewSearchIntent({
      contactId,
      naturalLanguageQuery: query
    })

    if (preview.success) {
      // For now, log as activity (future: save to saved_searches table)
      // This creates audit trail for when feature is fully implemented
      console.log('Saving search criteria:', preview.preview)

      // Future enhancement: POST to /api/saved-searches
      // await saveSearchCriteria(contactId, preview.preview)

      setSaved(true)
    }

    setSaving(false)
  }

  return (
    <button
      onClick={handleSave}
      disabled={saving || saved}
      className="flex items-center gap-2 px-4 py-2 border rounded-lg hover:bg-gray-50"
    >
      {saved ? '✓ Saved' : saving ? 'Saving...' : '🔔 Save This Search'}
    </button>
  )
}
```

---

## Example 6: Mobile-Optimized Search

**Use Case**: Voice-to-text property search on mobile

```tsx
'use client'

import { useState } from 'react'
import { searchPropertiesWithNaturalLanguage } from '@/app/actions/buyer-property-search'

export function VoiceSearchButton({ contactId }: { contactId: string }) {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')

  function startVoiceSearch() {
    if (!('webkitSpeechRecognition' in window)) {
      alert('Voice search not supported in this browser')
      return
    }

    const recognition = new (window as any).webkitSpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = false

    recognition.onstart = () => setListening(true)
    recognition.onend = () => setListening(false)

    recognition.onresult = async (event: any) => {
      const speechResult = event.results[0][0].transcript
      setTranscript(speechResult)

      // Execute search with voice input
      const response = await searchPropertiesWithNaturalLanguage({
        contactId,
        naturalLanguageQuery: speechResult,
        options: { limit: 10 }
      })

      if (response.success) {
        // Display results...
        console.log('Voice search results:', response.results)
      }
    }

    recognition.start()
  }

  return (
    <div>
      <button
        onClick={startVoiceSearch}
        disabled={listening}
        className="px-4 py-2 bg-purple-600 text-white rounded-lg"
      >
        {listening ? '🎤 Listening...' : '🎤 Voice Search'}
      </button>
      {transcript && <p className="mt-2 text-sm">You said: "{transcript}"</p>}
    </div>
  )
}
```

---

## Example 7: Search Analytics Dashboard

**Use Case**: Track buyer search patterns for agents

```tsx
import { getBuyerSearchHistory } from '@/lib/buyer-search/search-logger'

export async function BuyerSearchAnalytics({ contactId }: { contactId: string }) {
  const history = await getBuyerSearchHistory({ contactId, limit: 50 })

  if (!history.success) {
    return <div>Failed to load search history</div>
  }

  // Analyze patterns
  const searchesByPersona = history.searches.reduce((acc: any, search) => {
    const persona = search.persona_detected || 'unknown'
    acc[persona] = (acc[persona] || 0) + 1
    return acc
  }, {})

  const avgConfidence =
    history.searches.reduce((sum, s) => sum + (s.confidence_level === 'high' ? 3 : s.confidence_level === 'medium' ? 2 : 1), 0) /
    history.searches.length

  return (
    <div className="p-6 bg-white rounded-lg border">
      <h3 className="text-xl font-semibold mb-4">Search Insights</h3>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="p-4 bg-blue-50 rounded">
          <div className="text-2xl font-bold">{history.searches.length}</div>
          <div className="text-sm text-gray-600">Total Searches</div>
        </div>

        <div className="p-4 bg-green-50 rounded">
          <div className="text-2xl font-bold">{avgConfidence.toFixed(1)}/3</div>
          <div className="text-sm text-gray-600">Avg Confidence</div>
        </div>

        <div className="p-4 bg-purple-50 rounded">
          <div className="text-2xl font-bold">
            {Object.keys(searchesByPersona)[0] || 'N/A'}
          </div>
          <div className="text-sm text-gray-600">Primary Persona</div>
        </div>
      </div>

      <div>
        <h4 className="font-semibold mb-2">Recent Searches</h4>
        <ul className="space-y-2">
          {history.searches.slice(0, 10).map((search) => (
            <li key={search.search_id} className="text-sm text-gray-600">
              {new Date(search.searched_at).toLocaleDateString()} - 
              Listing {search.listing_id.slice(0, 8)} - 
              {search.confidence_level.toUpperCase()}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

---

## Example 8: A/B Testing Different Explanations

**Use Case**: Test which explanation style performs better

```typescript
import { generateMatchExplanation } from '@/lib/buyer-search/explanation-generator'
import { inferBuyerPersona } from '@/lib/buyer-search/persona-inference'
import { parseNaturalLanguageQuery } from '@/lib/buyer-search/intent-parser'

async function testExplanationVariants(
  listing: any,
  query: string,
  contactId: string
) {
  const intent = parseNaturalLanguageQuery(query)
  const persona = inferBuyerPersona(intent)

  // Variant A: Standard persona-based
  const explanationA = generateMatchExplanation(listing, intent, persona, 85)

  // Variant B: Force different persona to test tone
  const personaB = { ...persona, persona: 'investor' as const }
  const explanationB = generateMatchExplanation(listing, intent, personaB, 85)

  // Log both variants for A/B testing
  console.log('Variant A (detected persona):', explanationA)
  console.log('Variant B (investor tone):', explanationB)

  // In production: Show one variant, track which gets more engagement
  // return Math.random() > 0.5 ? explanationA : explanationB
}
```

---

## Example 9: Multi-Language Support (Future)

**Use Case**: Detect language and adjust explanations

```typescript
// Future enhancement: Language detection and translation
async function searchInMultipleLanguages(
  contactId: string,
  query: string,
  language: string = 'en'
) {
  // Translate query to English for parsing (future: i18n support)
  const englishQuery = await translateToEnglish(query, language)

  const results = await searchPropertiesWithNaturalLanguage({
    contactId,
    naturalLanguageQuery: englishQuery,
    options: { limit: 20 }
  })

  // Translate results back to buyer's language
  if (results.success && language !== 'en') {
    results.results = await translateResults(results.results, language)
  }

  return results
}

// Placeholder for future i18n
async function translateToEnglish(text: string, from: string) {
  return text // Future: Use translation API
}

async function translateResults(results: any[], to: string) {
  return results // Future: Translate headlines, bullets, narratives
}
```

---

## Integration Checklist

Before integrating System 5.1B:

- [ ] Verify `conversation_insights` exist for buyers
- [ ] Ensure `listings` table has active records
- [ ] Test with various query patterns
- [ ] Handle empty results gracefully
- [ ] Add loading states
- [ ] Implement error boundaries
- [ ] Track search analytics
- [ ] Test on mobile devices
- [ ] Validate contact authentication
- [ ] Review GDPR/privacy compliance

---

## Performance Tips

1. **Debounce Search**: Wait 500ms after user stops typing before executing search
2. **Cache Results**: Store recent search results client-side to avoid re-fetching
3. **Limit Results**: Default to 20 results, paginate if needed
4. **Prefetch**: Load property images in background after search completes
5. **Progressive Enhancement**: Show basic results first, enhance with explanations async

---

## Support

For additional integration support, see:
- `/lib/buyer-search/README.md` – System overview
- `/SYSTEM_5.1B_IMPLEMENTATION_SUMMARY.md` – Implementation details
- Unit tests in `/lib/buyer-search/__tests__/` – Example usage patterns
