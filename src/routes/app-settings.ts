// backend/src/routes/app-settings.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Extend Request interface to include user property
interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
  };
}

// GET /api/app-settings/google-sheets - Get global Google Sheets URLs
router.get('/google-sheets', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { data: settings, error } = await supabaseAdmin
      .from('app_settings')
      .select('key, value')
      .in('key', [
        'google_sheet_url_clients',
        'google_sheet_url_consignments', 
        'google_sheet_url_artworks',
        'google_sheet_url_auctions'
      ]);

    if (error) {
      console.error('Error fetching Google Sheets settings:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch Google Sheets settings',
        details: error.message
      });
    }

    // Transform the settings into a more convenient format
    const googleSheetsUrls = {
      clients: '',
      consignments: '',
      artworks: '',
      auctions: ''
    };

    settings?.forEach(setting => {
      let value = setting.value;
      
      // Handle both string and JSON stored values
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          // If it's not valid JSON, treat it as a plain string
        }
      }
      
      // Extract URL from value (could be string or object with url property)
      const url = typeof value === 'object' && value !== null ? value.url : value;
      
      switch (setting.key) {
        case 'google_sheet_url_clients':
          googleSheetsUrls.clients = url || '';
          break;
        case 'google_sheet_url_consignments':
          googleSheetsUrls.consignments = url || '';
          break;
        case 'google_sheet_url_artworks':
          googleSheetsUrls.artworks = url || '';
          break;
        case 'google_sheet_url_auctions':
          googleSheetsUrls.auctions = url || '';
          break;
      }
    });

    res.json({
      success: true,
      data: googleSheetsUrls
    });

  } catch (error: any) {
    console.error('Error in GET /app-settings/google-sheets:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /api/app-settings/google-sheets - Save global Google Sheets URL for a module
router.post('/google-sheets', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { module, url } = req.body;

    if (!module || !['clients', 'consignments', 'artworks', 'auctions'].includes(module)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid module. Must be one of: clients, consignments, artworks, auctions'
      });
    }

    const settingKey = `google_sheet_url_${module}`;
    const settingValue = { url: url || '' };

    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .upsert([{
        key: settingKey,
        value: settingValue,
        updated_at: new Date().toISOString()
      }], {
        onConflict: 'key'
      });

    if (error) {
      console.error('Error saving Google Sheets setting:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to save Google Sheets URL',
        details: error.message
      });
    }

    res.json({
      success: true,
      message: `Google Sheets URL for ${module} saved successfully`
    });

  } catch (error: any) {
    console.error('Error in POST /app-settings/google-sheets:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /api/app-settings/google-sheets/:module - Get Google Sheets URL for a specific module
router.get('/google-sheets/:module', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { module } = req.params;

    if (!['clients', 'consignments', 'artworks', 'auctions'].includes(module)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid module. Must be one of: clients, consignments, artworks, auctions'
      });
    }

    const settingKey = `google_sheet_url_${module}`;

    const { data: setting, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', settingKey)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching Google Sheets setting:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch Google Sheets URL',
        details: error.message
      });
    }

    let url = '';
    if (setting && setting.value) {
      // Handle both string and object values
      if (typeof setting.value === 'string') {
        try {
          const parsed = JSON.parse(setting.value);
          url = typeof parsed === 'object' && parsed !== null ? parsed.url : parsed;
        } catch {
          url = setting.value;
        }
      } else if (typeof setting.value === 'object' && setting.value !== null) {
        url = setting.value.url || '';
      } else {
        url = setting.value || '';
      }
    }

    res.json({
      success: true,
      data: { url }
    });

  } catch (error: any) {
    console.error('Error in GET /app-settings/google-sheets/:module:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

export default router;
