// backend/src/routes/galleries.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import multer from 'multer';

// Define AuthRequest interface to match middleware
interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
  file?: Express.Multer.File;
}

const router = express.Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// Configure multer for CSV file upload
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit for CSV files
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
});

// Gallery interface matching the database schema
interface Gallery {
  id?: string;
  name: string;
  location?: string;
  country?: string;
  founded_year?: number;
  director?: string;
  website?: string;
  description?: string;
  about?: string;
  specialties?: string;
  notable_exhibitions?: string;
  represented_artists?: string;
  address?: string;
  phone?: string;
  email?: string;
  gallery_type?: 'commercial' | 'museum' | 'institution' | 'private' | 'cooperative';
  status?: 'active' | 'inactive' | 'archived';
  is_verified?: boolean;
  created_at?: string;
  updated_at?: string;
}

// GET /api/galleries - Get all galleries with optional filtering
router.get('/', async (req, res) => {
  try {
    const { 
      status, 
      location,
      country,
      gallery_type,
      search, 
      page = 1, 
      limit = 25,
      sort_field = 'created_at',
      sort_direction = 'desc'
    } = req.query;

    let query = supabaseAdmin
      .from('galleries')
      .select('*');

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (location) {
      query = query.eq('location', location);
    }

    if (country) {
      query = query.eq('country', country);
    }

    if (gallery_type) {
      query = query.eq('gallery_type', gallery_type);
    }

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,location.ilike.%${search}%,country.ilike.%${search}%,description.ilike.%${search}%,director.ilike.%${search}%`
      );
    }

    // Apply sorting
    query = query.order(sort_field as string, { 
      ascending: sort_direction === 'asc' 
    });

    // Apply pagination
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;
    
    query = query.range(offset, offset + limitNum - 1);

    const { data: galleries, error, count } = await query;

    if (error) {
      console.error('Error fetching galleries:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch galleries',
        details: error.message 
      });
    }

    // Get total count for pagination
    const { count: totalCount } = await supabaseAdmin
      .from('galleries')
      .select('*', { count: 'exact', head: true });

    res.json({
      success: true,
      data: galleries || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount || 0,
        pages: Math.ceil((totalCount || 0) / limitNum)
      }
    });

  } catch (error: any) {
    console.error('Error in GET /galleries:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// GET /api/galleries/:id - Get specific gallery
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: gallery, error } = await supabaseAdmin
      .from('galleries')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Gallery not found' });
      }
      console.error('Error fetching gallery:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch gallery',
        details: error.message 
      });
    }

    res.json({
      success: true,
      data: gallery
    });

  } catch (error: any) {
    console.error('Error in GET /galleries/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/galleries - Create new gallery
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const galleryData: Omit<Gallery, 'id' | 'created_at' | 'updated_at'> = req.body;

    // Validate required fields
    if (!galleryData.name) {
      return res.status(400).json({ error: 'Gallery name is required' });
    }

    // Add audit fields
    const userId = req.user?.id;
    const galleryToCreate = {
      ...galleryData,
    };

    const { data: gallery, error } = await supabaseAdmin
      .from('galleries')
      .insert([galleryToCreate])
      .select()
      .single();

    if (error) {
      console.error('Error creating gallery:', error);
      return res.status(500).json({ 
        error: 'Failed to create gallery',
        details: error.message 
      });
    }

    res.status(201).json({
      success: true,
      data: gallery
    });

  } catch (error: any) {
    console.error('Error in POST /galleries:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// PUT /api/galleries/:id - Update gallery
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const galleryData: Partial<Gallery> = req.body;

    // Validate that gallery exists
    const { data: existingGallery, error: fetchError } = await supabaseAdmin
      .from('galleries')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Gallery not found' });
      }
      console.error('Error checking gallery existence:', fetchError);
      return res.status(500).json({ 
        error: 'Failed to update gallery',
        details: fetchError.message 
      });
    }

    const galleryToUpdate = {
      ...galleryData,
      updated_at: new Date().toISOString()
    };

    const { data: gallery, error } = await supabaseAdmin
      .from('galleries')
      .update(galleryToUpdate)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating gallery:', error);
      return res.status(500).json({ 
        error: 'Failed to update gallery',
        details: error.message 
      });
    }

    res.json({
      success: true,
      data: gallery
    });

  } catch (error: any) {
    console.error('Error in PUT /galleries/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// DELETE /api/galleries/:id - Delete gallery
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if gallery exists
    const { data: existingGallery, error: fetchError } = await supabaseAdmin
      .from('galleries')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Gallery not found' });
      }
      console.error('Error checking gallery existence:', fetchError);
      return res.status(500).json({ 
        error: 'Failed to delete gallery',
        details: fetchError.message 
      });
    }

    // TODO: Check if gallery is referenced by any items
    // For now, we'll allow deletion

    const { error } = await supabaseAdmin
      .from('galleries')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting gallery:', error);
      return res.status(500).json({ 
        error: 'Failed to delete gallery',
        details: error.message 
      });
    }

    res.json({
      success: true,
      message: 'Gallery deleted successfully'
    });

  } catch (error: any) {
    console.error('Error in DELETE /galleries/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/galleries/generate-ai - Generate gallery info using AI
router.post('/generate-ai', async (req, res) => {
  try {
    const { name, location } = req.body;

    if (!name) {
      return res.status(400).json({ 
        error: 'Gallery name is required for AI generation' 
      });
    }

    // Use environment variable for Gemini API key
    const apiKey = process.env.GEMINI_API_KEY || 'AIzaSyD5kSMyozQcOV7JmmwEXEqGOXhMMGGV1yg';
    const aiModel = process.env.AI_MODEL || 'gemini-pro';

    if (!apiKey) {
      return res.status(500).json({ 
        error: 'Gemini API key not configured' 
      });
    }

    // Import Google AI SDK dynamically
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: aiModel });

    const prompt = `
      Generate detailed information about the gallery "${name}"${location ? ` located at ${location}` : ''}. Please provide the response in JSON format with the following fields:
      
      {
        "location": "string (city/location)",
        "country": "string", 
        "founded_year": number or null,
        "director": "string (current or notable director)",
        "website": "string (official website URL)",
        "description": "string (brief description, 2-3 sentences)",
        "about": "string (detailed information about the gallery)",
        "specialties": "string (specialties and focus areas)",
        "notable_exhibitions": "string (notable exhibitions held)",
        "represented_artists": "string (key artists represented)",
        "address": "string (full address if known)",
        "phone": "string (contact phone if known)",
        "email": "string (contact email if known)",
        "gallery_type": "string (commercial, museum, institution, private, or cooperative)"
      }
      
      If the gallery is not well-known or information is not available, return null for unknown fields.
      For gallery_type, choose one of: commercial, museum, institution, private, cooperative.
      Provide accurate historical information only. If this is a famous gallery, include comprehensive details.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    try {
      // Extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }

      const aiData = JSON.parse(jsonMatch[0]);
      
      // Mark which fields were AI generated
      const aiGeneratedFields: { [key: string]: boolean } = {};
      Object.keys(aiData).forEach(key => {
        if (aiData[key] !== null && aiData[key] !== undefined && aiData[key] !== '') {
          aiGeneratedFields[key] = true;
        }
      });

      res.json({
        success: true,
        data: {
          ...aiData,
          ai_generated_fields: aiGeneratedFields
        }
      });

    } catch (parseError: any) {
      console.error('Error parsing AI response:', parseError);
      res.status(500).json({ 
        error: 'Failed to parse AI response',
        details: parseError.message 
      });
    }

  } catch (error: any) {
    console.error('Error in gallery AI generation:', error);
    res.status(500).json({ 
      error: 'Failed to generate gallery information',
      details: error.message 
    });
  }
});

// GET /api/galleries/export/csv - Export galleries as CSV
router.get('/export/csv', async (req, res) => {
  try {
    const { data: galleries, error } = await supabaseAdmin
      .from('galleries')
      .select('*')
      .order('name');

    if (error) {
      console.error('Error fetching galleries for export:', error);
      return res.status(500).json({ 
        error: 'Failed to export galleries',
        details: error.message 
      });
    }

    // Convert to CSV format
    const headers = [
      'Name', 'Location', 'Country', 'Founded Year', 'Director', 
      'Website', 'Gallery Type', 'Phone', 'Email', 'Status'
    ];
    
    const csvRows = [
      headers.join(','),
      ...(galleries || []).map(gallery => [
        `"${gallery.name || ''}"`,
        `"${gallery.location || ''}"`,
        `"${gallery.country || ''}"`,
        gallery.founded_year || '',
        `"${gallery.director || ''}"`,
        `"${gallery.website || ''}"`,
        `"${gallery.gallery_type || ''}"`,
        `"${gallery.phone || ''}"`,
        `"${gallery.email || ''}"`,
        `"${gallery.status || ''}"`
      ].join(','))
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=galleries.csv');
    res.send(csvRows.join('\n'));

  } catch (error: any) {
    console.error('Error in GET /galleries/export/csv:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/galleries/bulk - Bulk actions for galleries
router.post('/bulk', async (req, res) => {
  try {
    const { action, ids, data } = req.body;
    const userId = (req as any).user?.id;

    if (!action || !ids || !Array.isArray(ids)) {
      return res.status(400).json({
        error: 'Action and ids array are required'
      });
    }

    const validActions = ['delete', 'archive', 'activate', 'update_status'];
    if (!validActions.includes(action)) {
      return res.status(400).json({
        error: `Invalid action. Must be one of: ${validActions.join(', ')}`
      });
    }

    let result;
    let message = '';

    switch (action) {
      case 'delete':
        // Hard delete for galleries (since there's no soft delete logic in frontend)
        result = await supabaseAdmin
          .from('galleries')
          .delete()
          .in('id', ids)
          .select('id');

        message = `Successfully deleted ${result.data?.length || 0} galleries`;
        break;

      case 'archive':
        result = await supabaseAdmin
          .from('galleries')
          .update({ status: 'archived' })
          .in('id', ids)
          .select('id');

        message = `Successfully archived ${result.data?.length || 0} galleries`;
        break;

      case 'activate':
        result = await supabaseAdmin
          .from('galleries')
          .update({ status: 'active' })
          .in('id', ids)
          .select('id');

        message = `Successfully activated ${result.data?.length || 0} galleries`;
        break;

      case 'update_status':
        if (!data?.status) {
          return res.status(400).json({
            error: 'Status is required for update_status action'
          });
        }

        result = await supabaseAdmin
          .from('galleries')
          .update({ status: data.status })
          .in('id', ids)
          .select('id');

        message = `Successfully updated status for ${result.data?.length || 0} galleries`;
        break;

      default:
        return res.status(400).json({
          error: 'Unsupported action'
        });
    }

    if (result.error) {
      console.error('Error in bulk action:', result.error);
      return res.status(500).json({
        error: 'Failed to perform bulk action',
        details: result.error.message
      });
    }

    res.json({
      success: true,
      message,
      affected_count: result.data?.length || 0
    });

  } catch (error: any) {
    console.error('Error in POST /galleries/bulk:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /api/galleries/import/csv - Import galleries from CSV
router.post('/import/csv', csvUpload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded'
      });
    }

    // Import papaparse for CSV parsing
    const Papa = await import('papaparse');

    // Parse CSV content
    const csvText = req.file.buffer.toString('utf-8');
    const parseResult = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header: string) => header.toLowerCase().trim()
    });

    if (parseResult.errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Failed to parse CSV file',
        imported: 0,
        errors: parseResult.errors.map(err => err.message)
      });
    }

    const galleries = parseResult.data;
    let imported = 0;
    const errors: string[] = [];

    // Process each gallery
    for (let i = 0; i < galleries.length; i++) {
      const gallery = galleries[i] as Record<string, any>;

      try {
        // Map CSV columns to gallery fields
        const galleryData = {
          name: gallery.name || gallery.gallery_name,
          location: gallery.location || gallery.city,
          country: gallery.country,
          founded_year: gallery.founded_year ? parseInt(gallery.founded_year) : null,
          director: gallery.director,
          website: gallery.website || gallery.url,
          description: gallery.description,
          about: gallery.about,
          specialties: gallery.specialties,
          notable_exhibitions: gallery.notable_exhibitions,
          represented_artists: gallery.represented_artists,
          address: gallery.address,
          phone: gallery.phone || gallery.telephone,
          email: gallery.email,
          gallery_type: gallery.gallery_type || gallery.type,
          status: gallery.status || 'active'
        };

        // Validate required fields
        if (!galleryData.name) {
          errors.push(`Row ${i + 1}: Gallery name is required`);
          continue;
        }

        // Insert gallery
        const { data, error } = await supabaseAdmin
          .from('galleries')
          .insert([galleryData])
          .select()
          .single();

        if (error) {
          errors.push(`Row ${i + 1}: ${error.message}`);
        } else {
          imported++;
        }

      } catch (error: any) {
        errors.push(`Row ${i + 1}: ${error.message}`);
      }
    }

    res.json({
      success: true,
      message: `Imported ${imported} galleries successfully`,
      imported,
      errors
    });

  } catch (error: any) {
    console.error('Error in POST /galleries/import/csv:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      imported: 0,
      errors: [error.message]
    });
  }
});

export default router; 