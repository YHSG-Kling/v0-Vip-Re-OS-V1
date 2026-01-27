# Sidebar Component - Next.js Implementation

## Overview

The Sidebar component has been converted from React Router to Next.js routing.

## Key Changes

### 1. Imports
```typescript
// Before (Vite/React Router)
import { useNavigate, useLocation } from 'react-router-dom'

// After (Next.js)
import Link from 'next/link'
import { usePathname } from 'next/navigation'
```

### 2. Props Interface
```typescript
// Before - Required onChangeView callback
interface SidebarProps {
  role: UserRole
  onChangeView: (view: string) => void
  currentView: string
  onLogout: () => void
}

// After - Uses Next.js routing internally
interface SidebarProps {
  role: UserRole
  onLogout: () => void
}
```

### 3. Active Route Detection
```typescript
// Before - Passed as prop
const { currentView } = props

// After - Derived from pathname
const pathname = usePathname()
const currentView = pathname.replace(/^\//, '').replace(/\//g, '-')
// Examples:
// /agent/dashboard -> agent-dashboard
// /crm -> crm
// /offers/lab -> offers-lab
```

### 4. Navigation Links
```typescript
// Before - Button with onClick
<button
  onClick={() => onChangeView(item.id)}
  className="..."
>
  <Icon />
  {item.label}
</button>

// After - Next.js Link component
<Link
  href={`/${item.id.replace(/-/g, '/')}`}
  className="..."
>
  <Icon />
  {item.label}
</Link>
```

## Usage in Next.js

### In Layout or Root Component

```typescript
// app/layout.tsx or similar
import { Sidebar } from './components/Sidebar'
import { UserRole } from './types'

export default function RootLayout({ children }) {
  const handleLogout = async () => {
    // Implement logout logic
    await signOut()
    router.push('/login')
  }

  return (
    <html>
      <body>
        <Sidebar 
          role={UserRole.AGENT}
          onLogout={handleLogout}
        />
        <main className="ml-64">
          {children}
        </main>
      </body>
    </html>
  )
}
```

### Route Mapping

The Sidebar converts route IDs to paths automatically:

| Route ID | Generated Path | Page Location |
|----------|---------------|---------------|
| `agent-dashboard` | `/agent/dashboard` | `app/agent/dashboard/page.tsx` |
| `crm` | `/crm` | `app/crm/page.tsx` |
| `offer-lab` | `/offer/lab` | `app/offer/lab/page.tsx` |
| `inbox` | `/inbox` | `app/inbox/page.tsx` |
| `approvals` | `/approvals` | `app/approvals/page.tsx` |

## Benefits

1. **No State Management**: Navigation is handled by Next.js router
2. **Better SEO**: Proper URL-based routing
3. **Browser Navigation**: Back/forward buttons work correctly
4. **Prefetching**: Next.js automatically prefetches linked routes
5. **Type Safety**: TypeScript can validate route paths

## Migration Notes

- The component maintains the same visual design
- All role-based permissions logic is preserved
- Section grouping works identically
- Active state highlighting is automatic based on pathname
