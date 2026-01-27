import { readFileSync, readdirSync, statSync } from 'fs';
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

const uiComponentsToCheck = [
  'app/components/ui/button.tsx',
  'app/components/ui/card.tsx',
  'app/components/ui/dialog.tsx',
  'app/components/ui/form.tsx',
  'app/components/ui/input.tsx',
  'app/components/ui/tabs.tsx',
  'app/components/ui/select.tsx',
];

function getAllTsxFilesInFolder(folderPath) {
  const files = [];
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

function checkFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const firstLine = content.split('\n')[0].trim();
    const hasUseClient = firstLine === '"use client"' || firstLine === "'use client'";
    return { path: filePath, hasUseClient, exists: true };
  } catch (e) {
    return { path: filePath, hasUseClient: false, exists: false };
  }
}

// Collect all files to check
let allFiles = [...filesToCheck, ...uiComponentsToCheck];

// Add all files from folders
for (const folder of foldersToCheck) {
  const files = getAllTsxFilesInFolder(folder);
  allFiles = allFiles.concat(files);
}

// Check all files
const results = allFiles.map(checkFile);

// Report
const missing = results.filter(r => r.exists && !r.hasUseClient);
const present = results.filter(r => r.exists && r.hasUseClient);
const notFound = results.filter(r => !r.exists);

console.log('\n=== USE CLIENT VERIFICATION REPORT ===\n');
console.log(`✅ Files with "use client": ${present.length}`);
console.log(`❌ Files missing "use client": ${missing.length}`);
console.log(`⚠️  Files not found: ${notFound.length}`);
console.log(`📊 Total files checked: ${allFiles.length}\n`);

if (missing.length > 0) {
  console.log('Files missing "use client":');
  missing.forEach(r => console.log(`  - ${r.path}`));
  console.log('');
}

if (notFound.length > 0) {
  console.log('Files not found:');
  notFound.forEach(r => console.log(`  - ${r.path}`));
  console.log('');
}

console.log('✅ All component files have been verified!\n');
