-- Create articles table for News, Views & Insights
-- This table will store all articles/news that can be displayed on metsab and aurum websites

CREATE TABLE IF NOT EXISTS public.articles (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  excerpt TEXT,
  content TEXT NOT NULL,
  author_name TEXT,
  author_title TEXT,
  cover_image_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ,
  brand_id INTEGER REFERENCES public.brands(id) ON DELETE CASCADE,
  category TEXT,
  tags TEXT[] DEFAULT '{}',
  featured BOOLEAN DEFAULT false,
  views_count INTEGER DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  seo_keywords TEXT[],
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_articles_status ON public.articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_brand_id ON public.articles(brand_id);
CREATE INDEX IF NOT EXISTS idx_articles_published_at ON public.articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_slug ON public.articles(slug);
CREATE INDEX IF NOT EXISTS idx_articles_featured ON public.articles(featured) WHERE featured = true;
CREATE INDEX IF NOT EXISTS idx_articles_category ON public.articles(category);

-- Create trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_articles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_articles_timestamp ON public.articles;
CREATE TRIGGER trigger_update_articles_timestamp
  BEFORE UPDATE ON public.articles
  FOR EACH ROW
  EXECUTE FUNCTION update_articles_updated_at();

-- Enable Row Level Security (RLS)
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;

-- Allow public read access to published articles
CREATE POLICY "Public can view published articles"
  ON public.articles
  FOR SELECT
  USING (status = 'published');

-- Allow authenticated users full access (admin panel)
CREATE POLICY "Authenticated users can manage articles"
  ON public.articles
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON public.articles TO anon;
GRANT ALL ON public.articles TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE articles_id_seq TO authenticated;

-- Insert sample article for testing
INSERT INTO public.articles (title, slug, excerpt, content, author_name, author_title, status, published_at, category, featured)
VALUES 
  ('Welcome to Our News Section', 'welcome-to-our-news-section', 'Stay updated with the latest news and insights from the art world.', 
   '<h2>Welcome to Our News and Insights</h2><p>We are excited to bring you the latest updates from the world of fine art and antiques. Our team of experts will share valuable insights, market trends, and upcoming events.</p><p>Stay tuned for more articles!</p>',
   'Editorial Team', 'Content Manager', 'published', NOW(), 'Announcements', true)
ON CONFLICT (slug) DO NOTHING;

