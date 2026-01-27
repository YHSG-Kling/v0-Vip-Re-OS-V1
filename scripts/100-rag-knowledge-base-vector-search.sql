-- RAG Knowledge Base with Vector Embeddings for AI Tools Hub
-- Enables semantic search for "Explain This" and other AI-powered client education tools

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- RAG Knowledge Base (documents with vector embeddings)
CREATE TABLE IF NOT EXISTS rag_knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_title TEXT NOT NULL,
  document_type TEXT, -- faq, process_guide, contract_explainer, market_report, glossary
  content TEXT NOT NULL,
  embedding vector(1536), -- OpenAI text-embedding-3-small
  metadata JSONB,
  accessible_to_roles JSONB DEFAULT '["agent", "broker", "tc", "buyer", "seller"]'::jsonb,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- AI Tool Favorites
CREATE TABLE IF NOT EXISTS ai_tool_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  tool_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, tool_name)
);

-- Enhance ai_tool_usage table with additional fields
ALTER TABLE ai_tool_usage 
ADD COLUMN IF NOT EXISTS user_type TEXT, -- agent, broker, tc, buyer, seller
ADD COLUMN IF NOT EXISTS tool_category TEXT, -- generation, analysis, automation, education
ADD COLUMN IF NOT EXISTS input_data JSONB,
ADD COLUMN IF NOT EXISTS output_data JSONB,
ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER,
ADD COLUMN IF NOT EXISTS success BOOLEAN DEFAULT true;

-- Vector similarity search function
CREATE OR REPLACE FUNCTION match_documents (
  query_embedding vector(1536),
  match_threshold FLOAT,
  match_count INT,
  filter_roles JSONB DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  document_title TEXT,
  document_type TEXT,
  content TEXT,
  similarity FLOAT,
  metadata JSONB
)
LANGUAGE SQL STABLE
AS $$
  SELECT
    rag_knowledge_base.id,
    rag_knowledge_base.document_title,
    rag_knowledge_base.document_type,
    rag_knowledge_base.content,
    1 - (rag_knowledge_base.embedding <=> query_embedding) AS similarity,
    rag_knowledge_base.metadata
  FROM rag_knowledge_base
  WHERE 
    (1 - (rag_knowledge_base.embedding <=> query_embedding)) > match_threshold
    AND (filter_roles IS NULL OR rag_knowledge_base.accessible_to_roles ?| ARRAY(SELECT jsonb_array_elements_text(filter_roles)))
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

-- Create index for performance (ivfflat for cosine similarity)
CREATE INDEX IF NOT EXISTS rag_knowledge_base_embedding_idx 
ON rag_knowledge_base 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS ai_tool_usage_user_id_idx ON ai_tool_usage(user_id);
CREATE INDEX IF NOT EXISTS ai_tool_usage_created_at_idx ON ai_tool_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS ai_tool_favorites_user_id_idx ON ai_tool_favorites(user_id);
CREATE INDEX IF NOT EXISTS rag_knowledge_base_document_type_idx ON rag_knowledge_base(document_type);

-- Row Level Security
ALTER TABLE rag_knowledge_base ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_tool_favorites ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can read knowledge base accessible to their role"
  ON rag_knowledge_base FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Users can manage their own favorites"
  ON ai_tool_favorites FOR ALL
  USING (auth.uid() = user_id);

-- Seed sample knowledge base documents
INSERT INTO rag_knowledge_base (document_title, document_type, content, accessible_to_roles) VALUES
('What is Earnest Money?', 'glossary', 'Earnest money is a deposit made to a seller showing the buyer''s good faith in a transaction. It becomes part of the down payment if the offer is accepted. Typically 1-3% of the purchase price, it demonstrates serious intent to buy and is held in escrow until closing.', '["buyer", "seller", "agent"]'),
('Understanding Contingencies', 'process_guide', 'Contingencies are conditions that must be met for a real estate transaction to proceed. Common contingencies include financing (buyer must secure a loan), inspection (property must pass inspection), and appraisal (property must appraise at purchase price). These protect both buyers and sellers.', '["buyer", "seller", "agent"]'),
('What is a CMA?', 'glossary', 'A Comparative Market Analysis (CMA) is a report that shows the estimated value of a property based on recently sold comparable homes in the area. Agents use CMAs to help sellers price their homes competitively and help buyers make informed offers.', '["buyer", "seller", "agent", "broker"]'),
('Pre-Approval vs Pre-Qualification', 'process_guide', 'Pre-qualification is an informal estimate of how much you might be able to borrow. Pre-approval is a formal commitment from a lender based on verification of your financial information. Pre-approval carries more weight with sellers because it shows you''re a serious, qualified buyer.', '["buyer", "agent"]'),
('Title Insurance Explained', 'contract_explainer', 'Title insurance protects you from financial loss due to defects in a property''s title. The lender''s policy protects the lender, while the owner''s policy (optional but recommended) protects you. It''s a one-time premium paid at closing that covers you for as long as you own the home.', '["buyer", "seller", "agent"]'),
('What is Escrow?', 'glossary', 'Escrow is a neutral third party that holds money and documents during a real estate transaction. The escrow company ensures all conditions are met before releasing funds and transferring property ownership. They also handle the closing process and distribute funds to all parties.', '["buyer", "seller", "agent"]');

COMMIT;
