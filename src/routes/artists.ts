// backend/src/routes/artists.ts
import express from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';

const router = express.Router();
// Public route - no auth required (must be BEFORE authMiddleware)
router.get('/public', async (req, res) => {
  try {
    const { data: artists, error } = await supabaseAdmin
      .from('artists')
      .select('id, name, birth_year, death_year, nationality')
      .eq('status', 'active')
      .order('name', { ascending: true })
      .limit(1000)

    if (error) return res.status(500).json({ success: false })
    res.json({ success: true, data: artists })
  } catch (e: any) {
    res.status(500).json({ success: false })
  }
})
// Apply auth middleware to all routes
router.use(authMiddleware);

// Artist interface matching the database schema
interface Artist {
  id?: string;
  name: string;
  birth_year?: number;
  death_year?: number;
  nationality?: string;
  art_movement?: string;
  medium?: string;
  description?: string;
  key_description?: string;
  biography?: string;
  notable_works?: string;
  exhibitions?: string;
  awards?: string;
  signature_style?: string;
  market_value_range?: string;
  ai_generated_fields?: Record<string, any>;
  ai_generated_at?: string;
  ai_source?: string;
  status?: 'active' | 'inactive' | 'archived';
  is_verified?: boolean;
  created_at?: string;
  updated_at?: string;
}

// GET /api/artists - Get all artists with optional filtering
router.get('/', async (req, res) => {
  try {
    const { 
      status, 
      nationality,
      art_movement,
      search, 
      page = 1, 
      limit = 25,
      sort_field = 'id',
      sort_direction = 'asc'
    } = req.query;

    let query = supabaseAdmin
      .from('artists')
      .select('*');

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (nationality) {
      query = query.eq('nationality', nationality);
    }

    if (art_movement) {
      query = query.eq('art_movement', art_movement);
    }

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,nationality.ilike.%${search}%,art_movement.ilike.%${search}%,description.ilike.%${search}%`
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

    const { data: artists, error, count } = await query;

    if (error) {
      console.error('Error fetching artists:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch artists',
        details: error.message 
      });
    }

    // Get total count for pagination
    const { count: totalCount } = await supabaseAdmin
      .from('artists')
      .select('*', { count: 'exact', head: true });

    // Calculate status counts
    const { data: statusCounts } = await supabaseAdmin
      .from('artists')
      .select('status')
      .not('status', 'eq', 'archived');

    const counts = {
      active: 0,
      inactive: 0,
      archived: 0
    };

    statusCounts?.forEach(artist => {
      if (artist.status in counts) {
        counts[artist.status as keyof typeof counts]++;
      }
    });

    res.json({
      success: true,
      data: artists,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount || 0,
        pages: Math.ceil((totalCount || 0) / limitNum)
      },
      counts
    });
  } catch (error: any) {
    console.error('Error in GET /artists:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// GET /api/artists/:id - Get specific artist
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: artist, error } = await supabaseAdmin
      .from('artists')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Artist not found' });
      }
      console.error('Error fetching artist:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch artist',
        details: error.message 
      });
    }

    res.json({
      success: true,
      data: artist
    });
  } catch (error: any) {
    console.error('Error in GET /artists/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/artists - Create new artist
router.post('/', async (req, res) => {
  try {
    const artistData: Artist = req.body;
    const userId = (req as any).user?.id;

    // Validate required fields
    if (!artistData.name) {
      return res.status(400).json({ 
        error: 'Artist name is required' 
      });
    }

    // Check if artist already exists
    const { data: existingArtist } = await supabaseAdmin
      .from('artists')
      .select('id')
      .eq('name', artistData.name)
      .single();

    if (existingArtist) {
      return res.status(400).json({ 
        error: 'Artist with this name already exists' 
      });
    }

    // Add audit fields
    const newArtist = {
      ...artistData,
      status: artistData.status || 'active'
    };

    const { data: artist, error } = await supabaseAdmin
      .from('artists')
      .insert([newArtist])
      .select()
      .single();

    if (error) {
      console.error('Error creating artist:', error);
      return res.status(500).json({ 
        error: 'Failed to create artist',
        details: error.message 
      });
    }

    res.status(201).json({
      success: true,
      data: artist
    });
  } catch (error: any) {
    console.error('Error in POST /artists:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// PUT /api/artists/:id - Update artist
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const artistData: Artist = req.body;
    const userId = (req as any).user?.id;

    // Validate required fields
    if (!artistData.name) {
      return res.status(400).json({ 
        error: 'Artist name is required' 
      });
    }

    // Check if artist exists
    const { data: existingArtist, error: fetchError } = await supabaseAdmin
      .from('artists')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingArtist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Check if another artist with the same name exists
    const { data: duplicateArtist } = await supabaseAdmin
      .from('artists')
      .select('id')
      .eq('name', artistData.name)
      .neq('id', id)
      .single();

    if (duplicateArtist) {
      return res.status(400).json({ 
        error: 'Another artist with this name already exists' 
      });
    }

    // Update the artist
    const updatedArtist = {
      ...artistData,
    };

    const { data: artist, error } = await supabaseAdmin
      .from('artists')
      .update(updatedArtist)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating artist:', error);
      return res.status(500).json({ 
        error: 'Failed to update artist',
        details: error.message 
      });
    }

    res.json({
      success: true,
      data: artist
    });
  } catch (error: any) {
    console.error('Error in PUT /artists/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// DELETE /api/artists/:id - Delete artist (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.id;

    // Check if artist exists
    const { data: existingArtist, error: fetchError } = await supabaseAdmin
      .from('artists')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existingArtist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    // Check if artist is referenced by any items
    const { data: referencedItems } = await supabaseAdmin
      .from('items')
      .select('id')
      .eq('artist_id', id)
      .limit(1);

    if (referencedItems && referencedItems.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete artist that is referenced by items. Please remove the artist from all items first.' 
      });
    }

    // Soft delete by setting status to archived
    const { data: artist, error } = await supabaseAdmin
      .from('artists')
      .update({ 
        status: 'archived',
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error deleting artist:', error);
      return res.status(500).json({ 
        error: 'Failed to delete artist',
        details: error.message 
      });
    }

    res.json({
      success: true,
      message: 'Artist archived successfully'
    });
  } catch (error: any) {
    console.error('Error in DELETE /artists/:id:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// POST /api/artists/generate-ai - Generate artist info using AI
router.post('/generate-ai', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ 
        error: 'Artist name is required for AI generation' 
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
      Generate detailed information about the artist "${name}". Please provide the response in JSON format with the following fields:
      
      {
        "birth_year": number or null,
        "death_year": number or null,
        "nationality": "string",
        "art_movement": "string",
        "medium": "string",
        "description": "string (brief description, 2-3 sentences)",
        "biography": "string (detailed biography)",
        "notable_works": "string (list of notable works)",
        "exhibitions": "string (major exhibitions)",
        "awards": "string (awards and honors)",
        "signature_style": "string (description of artistic style)",
        "market_value_range": "string (estimated market value range)"
      }
      
      If the artist is not well-known or information is not available, return null for unknown fields. 
      Make sure birth_year and death_year are numbers or null, not strings.
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

      const artistInfo = JSON.parse(jsonMatch[0]);
      
      // Add AI generation metadata
      const aiGeneratedData = {
        ...artistInfo,
        ai_generated_fields: Object.keys(artistInfo).filter(key => artistInfo[key] !== null),
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
    console.error('Error in POST /artists/generate-ai:', error);
    res.status(500).json({ 
      error: 'Failed to generate artist information',
      details: error.message 
    });
  }
});

// POST /api/artists/bulk - Bulk actions for artists
router.post('/bulk', async (req, res) => {
  try {
    const { action, artist_ids, data } = req.body;
    const userId = (req as any).user?.id;

    if (!action || !artist_ids || !Array.isArray(artist_ids)) {
      return res.status(400).json({
        error: 'Action and artist_ids array are required'
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
          .from('artists')
          .update({ status: 'archived' })
          .in('id', artist_ids)
          .select('id');

        message = `Successfully archived ${result.data?.length || 0} artists`;
        break;

      case 'archive':
        result = await supabaseAdmin
          .from('artists')
          .update({ status: 'archived' })
          .in('id', artist_ids)
          .select('id');

        message = `Successfully archived ${result.data?.length || 0} artists`;
        break;

      case 'activate':
        result = await supabaseAdmin
          .from('artists')
          .update({ status: 'active' })
          .in('id', artist_ids)
          .select('id');

        message = `Successfully activated ${result.data?.length || 0} artists`;
        break;

      case 'update_status':
        if (!data?.status) {
          return res.status(400).json({
            error: 'Status is required for update_status action'
          });
        }

        result = await supabaseAdmin
          .from('artists')
          .update({ status: data.status })
          .in('id', artist_ids)
          .select('id');

        message = `Successfully updated status for ${result.data?.length || 0} artists`;
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
    console.error('Error in POST /artists/bulk:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

export default router;

// GET /api/artists/export/csv - Export artists to CSV
router.get('/export/csv', async (req, res) => {
  try {
    const { status, nationality, art_movement, search } = req.query as any;

    let query = supabaseAdmin
      .from('artists')
      .select('*');

    if (status && status !== 'all') query = query.eq('status', status);
    if (nationality) query = query.eq('nationality', nationality);
    if (art_movement) query = query.eq('art_movement', art_movement);
    if (search) {
      const s = String(search);
      query = query.or(
        `name.ilike.%${s}%,nationality.ilike.%${s}%,art_movement.ilike.%${s}%,description.ilike.%${s}%`
      );
    }

    const { data: artists, error } = await query.order('name', { ascending: true });
    if (error) {
      console.error('Error fetching artists for export:', error);
      return res.status(500).json({ error: 'Failed to fetch artists for export', details: error.message });
    }

    const headers = [
      'ID','Name','Birth Year','Death Year','Nationality','Art Movement','Medium','Description','Key Description','Status','Verified','Created At'
    ];

    const rows = (artists || []).map((a:any) => [
      a.id || '',
      a.name || '',
      a.birth_year ?? '',
      a.death_year ?? '',
      a.nationality || '',
      a.art_movement || '',
      a.medium || '',
      a.description || '',
      a.key_description || '',
      a.status || '',
      a.is_verified ? 'Yes' : 'No',
      a.created_at || ''
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(field => {
        const s = String(field);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(','))
    ].join('\n');

    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="artists-export-${timestamp}.csv"`);
    res.send(csv);
  } catch (e:any) {
    console.error('Error in GET /artists/export/csv:', e);
    res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});