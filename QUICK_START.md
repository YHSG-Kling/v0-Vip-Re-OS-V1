# Quick Start Guide - Supabase Migration

## Step 1: Create Database Tables

1. Go to your Supabase project at [supabase.com](https://supabase.com)
2. Click on "SQL Editor" in the left sidebar
3. Click "New Query"
4. Copy the entire contents of `scripts/020-create-complete-supabase-schema.sql`
5. Paste into the SQL Editor
6. Click "Run" or press Ctrl/Cmd + Enter
7. Wait for the success message (should take 5-10 seconds)

## Step 2: Verify Setup

1. Come back to this v0 app
2. Go to `/seed` page
3. Click "Verify Supabase Tables" button
4. You should see all tables with 0 records (that's correct!)

## Step 3: Seed Data

1. Click "Seed Test Users" to create test accounts
2. Click "Migrate Contacts to Supabase" to move Airtable contacts
3. Or click "Seed Test Contacts" to create new test contacts directly in Supabase

## Done!

Your app is now running on Supabase with proper production-ready database architecture.

## Troubleshooting

**Error: "supabaseService.getSupabase is not a function"**
- This means the Supabase tables don't exist yet
- Follow Step 1 above to create the tables
- Hard refresh your browser (Ctrl/Cmd + Shift + R)

**Error: "Failed to connect to Supabase"**
- Check that Supabase integration is connected in v0
- Check the "Vars" section in v0 to ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set

**Tables show 0 records but I migrated contacts**
- The migration might have failed silently
- Check the migration results in the UI
- Try running the SQL schema script again
