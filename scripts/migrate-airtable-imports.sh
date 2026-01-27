#!/bin/bash

# Replace airtableService imports
find pages client components -type f -name "*.tsx" -o -name "*.ts" | while read file; do
  sed -i 's/import.*airtableService.*from.*airtable/import { supabaseService } from "..\/..\/services\/supabaseService"/g' "$file"
  sed -i 's/import.*n8nService.*from.*n8n/import { executeWorkflow } from "..\/..\/app\/actions\/workflows"/g' "$file"
  sed -i 's/airtableService\./supabaseService\./g' "$file"
  sed -i 's/n8nService\.triggerWorkflow/executeWorkflow/g' "$file"
done

echo "Migration complete: All airtableService and n8nService imports have been updated to Supabase and Server Actions"
