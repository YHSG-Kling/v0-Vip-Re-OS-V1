import { cp, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const folders = [
  'ui', 'portal', 'AI', 'ai', 'chat', 'compliance', 'dashboard',
  'intelligence', 'coordinator', 'content-studio', 'lender', 
  'listing', 'marketing', 'mobile', 'vendor', 'video'
];

async function copyFolders() {
  // Create app/components if it doesn't exist
  if (!existsSync('app/components')) {
    await mkdir('app/components', { recursive: true });
  }

  for (const folder of folders) {
    const src = join('components', folder);
    const dest = join('app/components', folder);
    
    if (existsSync(src)) {
      console.log(`Copying ${src} → ${dest}`);
      await cp(src, dest, { recursive: true });
    } else {
      console.log(`⚠️  ${src} does not exist, skipping...`);
    }
  }
  
  console.log('\n✅ Component folders copied successfully!');
}

copyFolders().catch(console.error);
