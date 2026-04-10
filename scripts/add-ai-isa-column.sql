-- Add AI-ISA enabled column to contacts table
ALTER TABLE contacts 
ADD COLUMN IF NOT EXISTS ai_isa_enabled boolean DEFAULT false;

-- Add index for quick filtering
CREATE INDEX IF NOT EXISTS idx_contacts_ai_isa_enabled ON contacts(ai_isa_enabled);

-- Comment
COMMENT ON COLUMN contacts.ai_isa_enabled IS 'Whether AI-ISA (AI Intelligent Sales Assistant) is enabled for this contact';
