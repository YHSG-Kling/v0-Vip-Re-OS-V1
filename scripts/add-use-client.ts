import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const filesToCheck = [
  // Root components
  'app/components/Sidebar.tsx',
  'app/components/ChatWidget.tsx',
  'app/components/ContactDetail.tsx',
  'app/components/ContactDetailModal.tsx',
  'app/components/ContactForm.tsx',
  'app/components/ContactsList.tsx',
  'app/components/ContentGeneratorHub.tsx',
  'app/components/DealTeamSection.tsx',
  'app/components/JourneyCardsRenderer.tsx',
  'app/components/PersonaTools.tsx',
  'app/components/ProspectQuestionnaire.tsx',
  'app/components/ThemFirstChatAssistant.tsx',
  'app/components/TransparencyFeed.tsx',
  'app/components/VideosDashboard.tsx',
  'app/components/VoiceAssistant.tsx',
  'app/components/providers.tsx',
  'app/components/theme-provider.tsx',
  'app/components/ApprovalsBanner.tsx',
  'app/components/description-approval-card.tsx',
  'app/components/email-campaign-panel.tsx',
  'app/components/marketing-package-dashboard.tsx',
  'app/components/video-generation-panel.tsx',
];

const foldersToCheck = [
  'app/components/ai',
  'app/components/AI',
  'app/components/chat',
  'app/components/compliance',
  'app/components/dashboard',
  'app/components/intelligence',
  'app/components/coordinator',
  'app/components/content-studio',
  'app/components/lender',
  'app/components/mobile',
  'app/components/portal',
];

function getAllTsxFilesInFolder(folderPath: string): string[] {
  const files: string[] = [];
  try {
    const items = readdirSync(folderPath);
    for (const item of items) {
      const fullPath = join(folderPath, item);
      const stat = statSync(fullPath);
      if (stat.isFile() && item.endsWith('.tsx')) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    console.log(`Folder not found: ${folderPath}`);
  }
  return files;
}

function addUseClientToFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const firstLine = content.split('\n')[0].trim();
    const hasUseClient = firstLine === '"use client"' || firstLine === "'use client'";
    
    if (!hasUseClient) {
      const newContent = '"use client"\n\n' + content;
      writeFileSync(filePath, newContent, 'utf-8');
      return true;
    }
    return false;
  } catch (e) {
    console.error(`Error processing ${filePath}:`, e);
    return false;
  }
}

// Collect all files
let allFiles = [...filesToCheck];

// Add all files from folders
for (const folder of foldersToCheck) {
  const files = getAllTsxFilesInFolder(folder);
  allFiles = allFiles.concat(files);
}

// Process files
console.log('\n=== ADDING "use client" TO FILES ===\n');
let modified = 0;
let skipped = 0;

for (const filePath of allFiles) {
  const wasModified = addUseClientToFile(filePath);
  if (wasModified) {
    console.log(`✅ Added to: ${filePath}`);
    modified++;
  } else {
    skipped++;
  }
}

console.log(`\n📊 Summary:`);
console.log(`  Modified: ${modified}`);
console.log(`  Already had "use client": ${skipped}`);
console.log(`  Total processed: ${allFiles.length}\n`);
