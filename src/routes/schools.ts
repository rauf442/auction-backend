// backend/src/routes/schools.ts
import express from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import multer from 'multer';

const router = express.Router();
router.get('/public', async (req, res) => {
  try {
    const { data: schools, error } = await supabaseAdmin
      .from('schools')
      .select('id, name, location')
      .eq('status', 'active')
      .order('name', { ascending: true })
      .limit(1000)

    if (error) return res.status(500).json({ success: false })
    res.json({ success: true, data: schools })
  } catch (e: any) {
    res.status(500).json({ success: false })
  }
})
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

// Extend Request interface for multer
declare global {
  namespace Express {
    interface Request {
      file?: Express.Multer.File;
    }
  }
}

// School interface matching the database schema
interface School {
  id?: string;
  name: string;
  founded_year?: number;
  closed_year?: number;
  location?: string;
  country?: string;
  school_type?: string;
  art_movements?: string;
  specialties?: string;
  description?: string;
  history?: string;
  notable_alumni?: string;
  teaching_philosophy?: string;
  programs_offered?: string;
  facilities?: string;
  reputation_notes?: string;
  ai_generated_fields?: Record<string, any>;
  ai_generated_at?: string;
  ai_source?: string;
  status?: 'active' | 'inactive' | 'archived';
  is_verified?: boolean;
  created_at?: string;
  updated_at?: string;
}

// GET /api/schools - Get all schools with optional filtering
router.get('/', async (req, res) => {
  try {
    const { 
      status, 
      country,
      school_type,
      search, 
      page = 1, 
      limit = 25,
      sort_field = 'created_at',
      sort_direction = 'desc'
    } = req.query;

    let query = supabaseAdmin
      .from('schools')
      .select('*');

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (country) {
      query = query.eq('country', country);
    }

    if (school_type) {
      query = query.eq('school_type', school_type);
    }

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,location.ilike.%${search}%,country.ilike.%${search}%,description.ilike.%${search}%`
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

    const { data: schools, error, count } = await query;

    if (error) {
      console.error('Error fetching schools:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch schools',
        details: error.message 
      });
    }

    // Get total count for pagination
    const { count: totalCount } = await supabaseAdmin
      .from('schools')
      .select('*', { count: 'exact', head: true });

    // Calculate status counts
    const { data: statusCounts } = await supabaseAdmin
      .from('schools')
      .select('status')
      .not('status', 'eq', 'archived');

    const counts = {
      active: 0,
      inactive: 0,
      archived: 0
    };

    statusCounts?.forEach(school => {
      if (school.status in counts) {
        counts[school.status as keyof typeof counts]++;
      }
    });

    res.json({
      success: true,
      data: schools,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount || 0,
        pages: Math.ceil((totalCount || 0) / limitNum)
      },
      counts
    });
  } catch (error: any) {
    console.error('Error in GET /schools:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// GET /api/schools/:id - Get specific school
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: school, error } = await supabaseAdmin
      .from('schools')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'School not found' });
      }
      console.error('Error fetching school:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch school',
        details: error.message 
      });
    }

    res.json({
      success: true,
      data: school
    });
  } catch (error: any) {
    console.error('Error in GET /schools/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/schools - Create new school
router.post('/', async (req, res) => {
  try {
    const schoolData: School = req.body;
    const userId = (req as any).user?.id;

    // Validate required fields
    if (!schoolData.name) {
      return res.status(400).json({ 
        error: 'School name is required' 
      });
    }

    // Check if school already exists
    const { data: existingSchool } = await supabaseAdmin
      .from('schools')
      .select('id')
      .eq('name', schoolData.name)
      .single();

    if (existingSchool) {
      return res.status(400).json({ 
        error: 'School with this name already exists' 
      });
    }

    // Add audit fields
    const newSchool = {
      ...schoolData,
      status: schoolData.status || 'active'
    };

    const { data: school, error } = await supabaseAdmin
      .from('schools')
      .insert([newSchool])
      .select()
      .single();

    if (error) {
      console.error('Error creating school:', error);
      return res.status(500).json({ 
        error: 'Failed to create school',
        details: error.message 
      });
    }

    res.status(201).json({
      success: true,
      data: school
    });
  } catch (error: any) {
    console.error('Error in POST /schools:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// PUT /api/schools/:id - Update school
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const schoolData: School = req.body;
    const userId = (req as any).user?.id;

    // Validate required fields
    if (!schoolData.name) {
      return res.status(400).json({ 
        error: 'School name is required' 
      });
    }

    // Check if school exists
    const { data: existingSchool, error: fetchError } = await supabaseAdmin
      .from('schools')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingSchool) {
      return res.status(404).json({ error: 'School not found' });
    }

    // Check if another school with the same name exists
    const { data: duplicateSchool } = await supabaseAdmin
      .from('schools')
      .select('id')
      .eq('name', schoolData.name)
      .neq('id', id)
      .single();

    if (duplicateSchool) {
      return res.status(400).json({ 
        error: 'Another school with this name already exists' 
      });
    }

    // Update the school
    const updatedSchool = {
      ...schoolData,
    };

    const { data: school, error } = await supabaseAdmin
      .from('schools')
      .update(updatedSchool)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating school:', error);
      return res.status(500).json({ 
        error: 'Failed to update school',
        details: error.message 
      });
    }

    res.json({
      success: true,
      data: school
    });
  } catch (error: any) {
    console.error('Error in PUT /schools/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// DELETE /api/schools/:id - Delete school (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id;

    // Check if school exists
    const { data: existingSchool, error: fetchError } = await supabaseAdmin
      .from('schools')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingSchool) {
      return res.status(404).json({ error: 'School not found' });
    }

    // Check if school is referenced by any items
    const { data: referencedItems } = await supabaseAdmin
      .from('items')
      .select('id')
      .eq('school_id', id)
      .limit(1);

    if (referencedItems && referencedItems.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete school that is referenced by items. Please remove the school from all items first.' 
      });
    }

    // Soft delete by setting status to archived
    const { data: school, error } = await supabaseAdmin
      .from('schools')
      .update({ 
        status: 'archived',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error deleting school:', error);
      return res.status(500).json({ 
        error: 'Failed to delete school',
        details: error.message 
      });
    }

    res.json({
      success: true,
      message: 'School archived successfully'
    });
  } catch (error: any) {
    console.error('Error in DELETE /schools/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/schools/generate-ai - Generate school info using AI
router.post('/generate-ai', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ 
        error: 'School name is required for AI generation' 
      });
    }

    // Use environment variable for Gemini API key
    const apiKey = process.env.GEMINI_API_KEY || 'AIzaSyD5kSMyozQcOV7JmmwEXEqGOXhMMGGV1yg';
    const aiModel = process.env.AI_MODEL || '';

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
      Generate detailed information about the art school or institution "${name}". Please provide the response in JSON format with the following fields:
      
      {
        "founded_year": number or null,
        "closed_year": number or null,
        "location": "string (city/location)",
        "country": "string",
        "school_type": "string (e.g., Art School, Academy, University)",
        "art_movements": "string (associated art movements)",
        "specialties": "string (specialties and focus areas)",
        "description": "string (brief description, 2-3 sentences)",
        "history": "string (detailed history)",
        "notable_alumni": "string (list of notable alumni)",
        "teaching_philosophy": "string (teaching approach and philosophy)",
        "programs_offered": "string (programs and courses)",
        "facilities": "string (facilities description)",
        "reputation_notes": "string (reputation and recognition)"
      }
      
      If the school is not well-known or information is not available, return null for unknown fields. 
      Make sure founded_year and closed_year are numbers or null, not strings.
      Provide accurate historical information only.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    try {
      // Extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const schoolInfo = JSON.parse(jsonMatch[0]);
      
      // Add AI generation metadata
      const aiGeneratedData = {
        ...schoolInfo,
        ai_generated_fields: Object.keys(schoolInfo).filter(key => schoolInfo[key] !== null),
        ai_generated_at: new Date().toISOString(),
        ai_source: 'gemini'
      };

      res.json({
        success: true,
        data: aiGeneratedData
      });
    } catch (parseError) {
      console.error('Error parsing AI response:', parseError);
      res.status(500).json({ 
        error: 'Failed to parse AI response',
        details: 'The AI response was not in the expected format'
      });
    }
  } catch (error: any) {
    console.error('Error in POST /schools/generate-ai:', error);
    res.status(500).json({ 
      error: 'Failed to generate school information',
      details: error.message 
    });
  }
});

// GET /api/schools/export/csv - Export schools to CSV
router.get('/export/csv', async (req, res) => {
  try {
    const { status, country, school_type, search } = req.query;

    let query = supabaseAdmin
      .from('schools')
      .select('*');

    // Apply filters (same as the main GET endpoint)
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (country) {
      query = query.eq('country', country);
    }

    if (school_type) {
      query = query.eq('school_type', school_type);
    }

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,location.ilike.%${search}%,country.ilike.%${search}%,description.ilike.%${search}%`
      );
    }

    // Order by name for consistent CSV output
    query = query.order('name', { ascending: true });

    const { data: schools, error } = await query;

    if (error) {
      console.error('Error fetching schools for export:', error);
      return res.status(500).json({
        error: 'Failed to fetch schools for export',
        details: error.message
      });
    }

    // CSV headers
    const csvHeaders = [
      'ID', 'Name', 'Founded Year', 'Closed Year', 'Location', 'Country', 
      'School Type', 'Art Movements', 'Specialties', 'Description', 'History',
      'Notable Alumni', 'Teaching Philosophy', 'Programs Offered', 'Facilities',
      'Reputation Notes', 'Status', 'Is Verified', 'Created At'
    ];

    // Convert schools to CSV rows
    const csvRows = (schools || []).map(school => [
      school.id || '',
      school.name || '',
      school.founded_year || '',
      school.closed_year || '',
      school.location || '',
      school.country || '',
      school.school_type || '',
      school.art_movements || '',
      school.specialties || '',
      school.description || '',
      school.history || '',
      school.notable_alumni || '',
      school.teaching_philosophy || '',
      school.programs_offered || '',
      school.facilities || '',
      school.reputation_notes || '',
      school.status || '',
      school.is_verified ? 'Yes' : 'No',
      school.created_at || ''
    ]);

    // Create CSV content
    const csvContent = [
      csvHeaders.join(','),
      ...csvRows.map(row => 
        row.map(field => {
          // Escape fields that contain commas, quotes, or newlines
          const stringField = String(field);
          if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
            return `"${stringField.replace(/"/g, '""')}"`;
          }
          return stringField;
        }).join(',')
      )
    ].join('\n');

    // Set response headers for file download
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="schools-export-${timestamp}.csv"`);
    res.send(csvContent);

  } catch (error: any) {
    console.error('Error in GET /schools/export/csv:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /api/schools/bulk - Bulk actions for schools
router.post('/bulk', async (req, res) => {
  try {
    const { action, school_ids, data } = req.body;
    const userId = (req as any).user?.id;

    if (!action || !school_ids || !Array.isArray(school_ids)) {
      return res.status(400).json({
        error: 'Action and school_ids array are required'
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
        // Soft delete by archiving
        result = await supabaseAdmin
          .from('schools')
          .update({ status: 'archived' })
          .in('id', school_ids)
          .select('id');

        message = `Successfully archived ${result.data?.length || 0} schools`;
        break;

      case 'archive':
        result = await supabaseAdmin
          .from('schools')
          .update({ status: 'archived' })
          .in('id', school_ids)
          .select('id');

        message = `Successfully archived ${result.data?.length || 0} schools`;
        break;

      case 'activate':
        result = await supabaseAdmin
          .from('schools')
          .update({ status: 'active' })
          .in('id', school_ids)
          .select('id');

        message = `Successfully activated ${result.data?.length || 0} schools`;
        break;

      case 'update_status':
        if (!data?.status) {
          return res.status(400).json({
            error: 'Status is required for update_status action'
          });
        }

        result = await supabaseAdmin
          .from('schools')
          .update({ status: data.status })
          .in('id', school_ids)
          .select('id');

        message = `Successfully updated status for ${result.data?.length || 0} schools`;
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
    console.error('Error in POST /schools/bulk:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /api/schools/import/csv - Import schools from CSV
router.post('/import/csv', csvUpload.single('file'), async (req, res) => {
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
        errors: parseResult.errors.map((err: any) => err.message)
      });
    }

    const schools = parseResult.data;
    let imported = 0;
    const errors: string[] = [];

    // Process each school
    for (let i = 0; i < schools.length; i++) {
      const school = schools[i] as Record<string, any>;

      try {
        // Map CSV columns to school fields
        const schoolData = {
          name: school.name || school.school_name,
          founded_year: school.founded_year ? parseInt(school.founded_year) : null,
          closed_year: school.closed_year ? parseInt(school.closed_year) : null,
          location: school.location || school.city,
          country: school.country,
          school_type: school.school_type || school.type,
          art_movements: school.art_movements,
          specialties: school.specialties,
          description: school.description,
          history: school.history,
          notable_alumni: school.notable_alumni,
          teaching_philosophy: school.teaching_philosophy,
          programs_offered: school.programs_offered,
          facilities: school.facilities,
          reputation_notes: school.reputation_notes,
          status: school.status || 'active'
        };

        // Validate required fields
        if (!schoolData.name) {
          errors.push(`Row ${i + 1}: School name is required`);
          continue;
        }

        // Insert school
        const { data, error } = await supabaseAdmin
          .from('schools')
          .insert([schoolData])
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
      message: `Imported ${imported} schools successfully`,
      imported,
      errors
    });

  } catch (error: any) {
    console.error('Error in POST /schools/import/csv:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      imported: 0,
      errors: [error.message]
    });
  }
});

export default router; 