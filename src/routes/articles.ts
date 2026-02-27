// backend/src/routes/articles.ts
import { Router, Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabaseAdmin } from '../utils/supabase'

const router = Router()

// Extend Request interface to include user property
interface AuthenticatedRequest extends Request {
  user?: {
    id: number
    email: string
    role: string
  }
}

// GET /api/articles - Get all articles with filtering
router.get('/', async (req: Request, res: Response) => {
  try {
    const { 
      status, 
      brand_id, 
      category, 
      featured, 
      limit = '50', 
      offset = '0',
      published_only = 'false'
    } = req.query

    let query = supabaseAdmin
      .from('articles')
      .select(`
        *,
        brand:brands(id, name, code)
      `)
      .order('created_at', { ascending: false })

    // Apply filters
    if (status) {
      query = query.eq('status', status)
    }

    if (published_only === 'true') {
      query = query.eq('status', 'published')
    }

    if (brand_id) {
      query = query.eq('brand_id', parseInt(brand_id as string))
    }

    if (category) {
      query = query.eq('category', category)
    }

    if (featured === 'true') {
      query = query.eq('featured', true)
    }

    // Apply pagination
    query = query.range(
      parseInt(offset as string), 
      parseInt(offset as string) + parseInt(limit as string) - 1
    )

    const { data: articles, error, count } = await query

    if (error) {
      console.error('Error fetching articles:', error)
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch articles',
        error: error.message
      })
    }

    res.json({
      success: true,
      data: articles || [],
      pagination: {
        total: count || 0,
        limit: parseInt(limit as string),
        offset: parseInt(offset as string)
      }
    })

  } catch (error: any) {
    console.error('Error in GET /api/articles:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/articles/:id - Get single article by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params

    const { data: article, error } = await supabaseAdmin
      .from('articles')
      .select(`
        *,
        brand:brands(id, name, code, logo_url)
      `)
      .eq('id', parseInt(id))
      .single()

    if (error || !article) {
      return res.status(404).json({
        success: false,
        message: 'Article not found'
      })
    }

    // Increment view count
    await supabaseAdmin
      .from('articles')
      .update({ views_count: (article.views_count || 0) + 1 })
      .eq('id', parseInt(id))

    res.json({
      success: true,
      data: article
    })

  } catch (error: any) {
    console.error('Error in GET /api/articles/:id:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// GET /api/articles/slug/:slug - Get single article by slug
router.get('/slug/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params

    const { data: article, error } = await supabaseAdmin
      .from('articles')
      .select(`
        *,
        brand:brands(id, name, code, logo_url)
      `)
      .eq('slug', slug)
      .single()

    if (error || !article) {
      return res.status(404).json({
        success: false,
        message: 'Article not found'
      })
    }

    // Increment view count
    await supabaseAdmin
      .from('articles')
      .update({ views_count: (article.views_count || 0) + 1 })
      .eq('slug', slug)

    res.json({
      success: true,
      data: article
    })

  } catch (error: any) {
    console.error('Error in GET /api/articles/slug/:slug:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// POST /api/articles - Create new article (authenticated)
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      title,
      slug,
      excerpt,
      content,
      author_name,
      author_title,
      cover_image_url,
      status = 'draft',
      published_at,
      brand_id,
      category,
      tags,
      featured = false,
      seo_title,
      seo_description,
      seo_keywords
    } = req.body

    // Validate required fields
    if (!title || !slug || !content) {
      return res.status(400).json({
        success: false,
        message: 'Title, slug, and content are required'
      })
    }

    // Check if slug already exists
    const { data: existingArticle } = await supabaseAdmin
      .from('articles')
      .select('id')
      .eq('slug', slug)
      .single()

    if (existingArticle) {
      return res.status(400).json({
        success: false,
        message: 'Article with this slug already exists'
      })
    }

    const articleData: any = {
      title,
      slug,
      excerpt,
      content,
      author_name,
      author_title,
      cover_image_url,
      status,
      brand_id,
      category,
      tags: tags || [],
      featured,
      seo_title,
      seo_description,
      seo_keywords: seo_keywords || [],
      created_by: req.user?.id,
      updated_by: req.user?.id
    }

    // Set published_at if status is published and not provided
    if (status === 'published' && !published_at) {
      articleData.published_at = new Date().toISOString()
    } else if (published_at) {
      articleData.published_at = published_at
    }

    const { data: article, error } = await supabaseAdmin
      .from('articles')
      .insert(articleData)
      .select()
      .single()

    if (error) {
      console.error('Error creating article:', error)
      return res.status(500).json({
        success: false,
        message: 'Failed to create article',
        error: error.message
      })
    }

    res.status(201).json({
      success: true,
      data: article,
      message: 'Article created successfully'
    })

  } catch (error: any) {
    console.error('Error in POST /api/articles:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// PUT /api/articles/:id - Update article (authenticated)
router.put('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params
    const {
      title,
      slug,
      excerpt,
      content,
      author_name,
      author_title,
      cover_image_url,
      status,
      published_at,
      brand_id,
      category,
      tags,
      featured,
      seo_title,
      seo_description,
      seo_keywords
    } = req.body

    // Check if article exists
    const { data: existingArticle, error: fetchError } = await supabaseAdmin
      .from('articles')
      .select('*')
      .eq('id', parseInt(id))
      .single()

    if (fetchError || !existingArticle) {
      return res.status(404).json({
        success: false,
        message: 'Article not found'
      })
    }

    // Check if slug is being changed and if it already exists
    if (slug && slug !== existingArticle.slug) {
      const { data: duplicateSlug } = await supabaseAdmin
        .from('articles')
        .select('id')
        .eq('slug', slug)
        .neq('id', parseInt(id))
        .single()

      if (duplicateSlug) {
        return res.status(400).json({
          success: false,
          message: 'Article with this slug already exists'
        })
      }
    }

    const updateData: any = {
      updated_by: req.user?.id
    }

    // Only update fields that are provided
    if (title !== undefined) updateData.title = title
    if (slug !== undefined) updateData.slug = slug
    if (excerpt !== undefined) updateData.excerpt = excerpt
    if (content !== undefined) updateData.content = content
    if (author_name !== undefined) updateData.author_name = author_name
    if (author_title !== undefined) updateData.author_title = author_title
    if (cover_image_url !== undefined) updateData.cover_image_url = cover_image_url
    if (status !== undefined) {
      updateData.status = status
      // Auto-set published_at when status changes to published
      if (status === 'published' && !existingArticle.published_at) {
        updateData.published_at = new Date().toISOString()
      }
    }
    if (published_at !== undefined) updateData.published_at = published_at
    if (brand_id !== undefined) updateData.brand_id = brand_id
    if (category !== undefined) updateData.category = category
    if (tags !== undefined) updateData.tags = tags
    if (featured !== undefined) updateData.featured = featured
    if (seo_title !== undefined) updateData.seo_title = seo_title
    if (seo_description !== undefined) updateData.seo_description = seo_description
    if (seo_keywords !== undefined) updateData.seo_keywords = seo_keywords

    const { data: article, error } = await supabaseAdmin
      .from('articles')
      .update(updateData)
      .eq('id', parseInt(id))
      .select()
      .single()

    if (error) {
      console.error('Error updating article:', error)
      return res.status(500).json({
        success: false,
        message: 'Failed to update article',
        error: error.message
      })
    }

    res.json({
      success: true,
      data: article,
      message: 'Article updated successfully'
    })

  } catch (error: any) {
    console.error('Error in PUT /api/articles/:id:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

// DELETE /api/articles/:id - Delete article (authenticated)
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params

    // Check if article exists
    const { data: existingArticle, error: fetchError } = await supabaseAdmin
      .from('articles')
      .select('*')
      .eq('id', parseInt(id))
      .single()

    if (fetchError || !existingArticle) {
      return res.status(404).json({
        success: false,
        message: 'Article not found'
      })
    }

    const { error } = await supabaseAdmin
      .from('articles')
      .delete()
      .eq('id', parseInt(id))

    if (error) {
      console.error('Error deleting article:', error)
      return res.status(500).json({
        success: false,
        message: 'Failed to delete article',
        error: error.message
      })
    }

    res.json({
      success: true,
      message: 'Article deleted successfully'
    })

  } catch (error: any) {
    console.error('Error in DELETE /api/articles/:id:', error)
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    })
  }
})

export default router

