# Next.js 14 Project Structure

This is a clean, production-ready Next.js 14 project with TypeScript, Tailwind CSS, and Zustand state management.

## Directory Structure

```
/
├── app/                          # Next.js App Router directory
│   ├── api/                      # API routes
│   │   └── auth/                 # Authentication endpoints
│   │       ├── login/            # Login endpoint
│   │       ├── logout/           # Logout endpoint
│   │       └── demo-users/       # Demo users endpoint
│   ├── components/               # React components (organized by feature)
│   │   ├── AI/                   # AI-related components
│   │   ├── chat/                 # Chat components
│   │   ├── compliance/           # Compliance components
│   │   ├── portal/               # Portal components
│   │   ├── ui/                   # Reusable UI components (shadcn/ui)
│   │   ├── LoadingSpinner.tsx   # Loading spinner component
│   │   └── Sidebar.tsx          # Sidebar component
│   ├── dashboard/                # Dashboard pages
│   ├── login/                    # Login page
│   ├── layout.tsx                # Root layout
│   ├── page.tsx                  # Root page (redirects)
│   └── globals.css               # Global styles
├── lib/                          # Utility functions
├── hooks/                        # Custom React hooks
├── stores/                       # Zustand stores
│   └── authStore.tsx            # Authentication store
├── types/                        # TypeScript type definitions
│   ├── index.ts                 # Type exports
│   └── contact.ts               # Contact types
├── middleware.ts                 # Next.js middleware (route protection)
├── next.config.ts               # Next.js configuration
├── tailwind.config.ts           # Tailwind CSS configuration
├── tsconfig.json                # TypeScript configuration
├── postcss.config.js            # PostCSS configuration
├── package.json                 # Dependencies and scripts
└── .gitignore                   # Git ignore rules
```

## Configuration Files (Project Root)

All configuration files are at the project root for Next.js compatibility:

- `package.json` - Dependencies and npm scripts (dev, build, start, lint)
- `next.config.ts` - Next.js configuration
- `tsconfig.json` - TypeScript compiler options with path aliases
- `tailwind.config.ts` - Tailwind CSS theme and plugin configuration
- `postcss.config.js` - PostCSS plugins (Tailwind CSS)
- `middleware.ts` - Route protection middleware

## Path Aliases (tsconfig.json)

```json
"@/*": ["./*"]                    # Root directory
"@/components/*": ["./app/components/*"]  # Components
"@/lib/*": ["./lib/*"]            # Utilities
"@/hooks/*": ["./hooks/*"]        # Hooks
"@/stores/*": ["./stores/*"]      # Zustand stores
"@/types/*": ["./types/*"]        # Types
"@/app/*": ["./app/*"]            # App directory
```

## Import Convention

Always use path aliases for imports:

```typescript
// ✅ Correct
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/authStore'
import { User, UserRole } from '@/types'

// ❌ Avoid
import { Button } from '../../../components/ui/button'
import { useAuthStore } from '../../stores/authStore'
```

## Authentication Flow

1. Root page (`/`) redirects to `/login`
2. User selects from demo users on login page
3. Login API sets HTTP-only auth cookie
4. Middleware protects routes (redirects to `/login` if not authenticated)
5. Dashboard checks auth state and displays user info

## Dark Theme

The project uses a dark theme by default:
- HTML has `className="dark"` in `app/layout.tsx`
- Tailwind configured with dark mode: 'class'
- Design tokens in `app/globals.css` for dark theme colors
- Primary: blue-600, Background: slate-950, Text: white/slate-100

## Running the Project

```bash
# Development
pnpm dev

# Build for production
pnpm build

# Run production build
pnpm start

# Lint code
pnpm lint
```

## Legacy Folders (Ignore These)

The following folders at the root may exist but should be ignored:
- `/components/` - Duplicates of `/app/components/` (legacy)
- Old project structure artifacts

The active codebase is entirely within the `/app/` directory structure.
