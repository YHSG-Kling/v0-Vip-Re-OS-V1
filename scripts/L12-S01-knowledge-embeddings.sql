-- L12-S01: Knowledge Embeddings for RAG
-- Enable vector extension and add embedding column to help_topics_kb

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to help_topics_kb
ALTER TABLE help_topics_kb
ADD COLUMN IF NOT EXISTS content_embedding VECTOR(1536);

-- Create index for vector similarity search
CREATE INDEX IF NOT EXISTS help_topics_kb_embedding_idx 
ON help_topics_kb 
USING ivfflat (content_embedding vector_cosine_ops)
WITH (lists = 100);

-- Create function for semantic search
CREATE OR REPLACE FUNCTION match_help_topics(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5,
  p_brokerage_id UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  topic_key TEXT,
  title TEXT,
  content TEXT,
  category TEXT,
  tags TEXT[],
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    h.id,
    h.topic_key,
    h.title,
    h.content,
    h.category,
    h.tags,
    1 - (h.content_embedding <=> query_embedding) AS similarity
  FROM help_topics_kb h
  WHERE h.is_active = TRUE
    AND h.content_embedding IS NOT NULL
    AND (h.brokerage_id IS NULL OR h.brokerage_id = p_brokerage_id)
    AND 1 - (h.content_embedding <=> query_embedding) > match_threshold
  ORDER BY h.content_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Add feature flag for knowledge management
INSERT INTO feature_flags (feature_key, display_name, description, category, enabled, brokerage_access)
VALUES (
  'knowledge_management',
  'Knowledge Management',
  'Admin knowledge base with vector search and RAG',
  'admin',
  TRUE,
  TRUE
) ON CONFLICT (feature_key) DO NOTHING;

-- Create knowledge_articles table for more structured articles
CREATE TABLE IF NOT EXISTS knowledge_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  content TEXT NOT NULL,
  excerpt TEXT,
  category TEXT NOT NULL CHECK (category IN ('onboarding', 'compliance', 'marketing', 'transactions', 'leads', 'integrations', 'general')),
  tags TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  view_count INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  not_helpful_count INTEGER DEFAULT 0,
  content_embedding VECTOR(1536),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(brokerage_id, slug)
);

-- Create index for knowledge_articles embeddings
CREATE INDEX IF NOT EXISTS knowledge_articles_embedding_idx 
ON knowledge_articles 
USING ivfflat (content_embedding vector_cosine_ops)
WITH (lists = 100);

-- Create function for semantic search on knowledge_articles
CREATE OR REPLACE FUNCTION match_knowledge_articles(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5,
  p_brokerage_id UUID DEFAULT NULL,
  p_category TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  slug TEXT,
  content TEXT,
  excerpt TEXT,
  category TEXT,
  tags TEXT[],
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ka.id,
    ka.title,
    ka.slug,
    ka.content,
    ka.excerpt,
    ka.category,
    ka.tags,
    1 - (ka.content_embedding <=> query_embedding) AS similarity
  FROM knowledge_articles ka
  WHERE ka.status = 'published'
    AND ka.content_embedding IS NOT NULL
    AND (ka.brokerage_id IS NULL OR ka.brokerage_id = p_brokerage_id)
    AND (p_category IS NULL OR ka.category = p_category)
    AND 1 - (ka.content_embedding <=> query_embedding) > match_threshold
  ORDER BY ka.content_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Enable RLS
ALTER TABLE knowledge_articles ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY knowledge_articles_select ON knowledge_articles
FOR SELECT
USING (
  status = 'published' 
  AND (brokerage_id IS NULL OR brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid()))
);

CREATE POLICY knowledge_articles_admin ON knowledge_articles
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = auth.uid()
    AND (u.role IN ('admin', 'superadmin') OR u.platform_role IN ('admin', 'superadmin'))
    AND (brokerage_id IS NULL OR u.brokerage_id = knowledge_articles.brokerage_id)
  )
);

-- Create embedding queue table for async processing
CREATE TABLE IF NOT EXISTS embedding_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table TEXT NOT NULL,
  source_id UUID NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE(source_table, source_id)
);

-- Create index for queue processing
CREATE INDEX IF NOT EXISTS embedding_queue_status_idx ON embedding_queue(status, created_at);
