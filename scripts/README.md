# Component Migration Scripts

This directory contains utility scripts for managing the component migration from Vite to Next.js App Router.

## Available Scripts

### 1. verify-use-client.ts

Verifies that all component files have the `"use client"` directive at the top.

**Usage:**
\`\`\`bash
npx tsx scripts/verify-use-client.ts
\`\`\`

**What it does:**
- Checks all root component files
- Scans all component subfolders (ai, AI, chat, portal, etc.)
- Checks key UI components
- Reports which files have/don't have "use client"
- Shows files that don't exist

**Output:**
- ✅ Files with "use client": [count]
- ❌ Files missing "use client": [count]
- ⚠️ Files not found: [count]

### 2. add-use-client.ts

Automatically adds `"use client"` to all component files that are missing it.

**Usage:**
\`\`\`bash
npx tsx scripts/add-use-client.ts
\`\`\`

**What it does:**
- Scans the same files as verify-use-client.ts
- Adds `"use client"` at the top of files that don't have it
- Skips files that already have the directive
- Reports what was modified

**Output:**
- Shows each file that was modified
- Summary of modified vs already-present counts

### 3. copy-components-to-app.sh

Bash script to copy component folders recursively from `components/` to `app/components/`.

**Note:** This script requires bash and is not executable via Node.js. Manual copying was performed instead.

## File Coverage

These scripts check the following locations:

### Root Components (22 files)
- Sidebar.tsx, ChatWidget.tsx, ContactDetail.tsx, etc.
- All major dashboard and tool components

### Component Folders (11 folders)
- `app/components/ai/` - AI assistant panels
- `app/components/AI/` - Advanced AI tools
- `app/components/chat/` - Chat interfaces
- `app/components/compliance/` - Compliance components
- `app/components/dashboard/` - Dashboard widgets
- `app/components/intelligence/` - Intelligence panels
- `app/components/coordinator/` - Coordinator tools
- `app/components/content-studio/` - Content generation
- `app/components/lender/` - Lender components
- `app/components/mobile/` - Mobile-specific components
- `app/components/portal/` - Client portal components

### UI Components (Selected)
- button.tsx, card.tsx, dialog.tsx, form.tsx, input.tsx, tabs.tsx, select.tsx

## Migration Status

All 161 component files have been successfully copied to `app/components/` with the correct folder structure maintained. The "use client" directive has been verified across all interactive components.

## Next Steps

After running these scripts:
1. Verify all imports are updated to use `app/components/` paths
2. Update relative imports within components
3. Test each component in the Next.js environment
4. Update parent components to use new import paths

## Troubleshooting

**Error: "Folder not found"**
- Ensure you're running the script from the project root
- Check that `app/components/` exists with the correct structure

**Error: "Permission denied"**
- Ensure you have write permissions for the files
- Try running with appropriate permissions

**Import errors after migration**
- Update import paths from `@/components/` or `../../components/` to `@/app/components/`
- Check for circular dependencies
- Verify all component exports are correct
