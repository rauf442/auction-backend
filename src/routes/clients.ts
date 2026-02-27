// backend/src/routes/clients.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import Papa from 'papaparse';
import { parsePhoneNumber, AsYouType } from 'libphonenumber-js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Simple in-memory cache to prevent duplicate sync requests
const syncCache = new Map<string, number>();
const SYNC_CACHE_TTL = 30000; // 30 seconds

// Extend Request interface to include user property
interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
  };
}

// Interface for Client with integer ID
interface Client {
  id?: number;
  title?: string;
  first_name: string;
  last_name: string;
  salutation?: string;
  birth_date?: string;
  preferred_language?: string;
  time_zone?: string;
  tags?: string;
  email?: string;
  phone_number?: string;
  company_name?: string;
  vat_number?: string;
  instagram_url?: string;
  has_no_email?: boolean;
  vat_applicable?: boolean;
  secondary_email?: string;
  secondary_phone_number?: string;
  // New unified client type replaces boolean flags
  client_type?: 'buyer' | 'vendor' | 'supplier' | 'buyer_vendor';
  default_vat_scheme?: string;
  default_ldl?: string;
  default_consignment_charges?: string;
  billing_address1?: string;
  billing_address2?: string;
  billing_address3?: string;
  billing_city?: string;
  billing_post_code?: string;
  billing_country?: string;
  billing_region?: string;
  bank_account_details?: string;
  bank_address?: string;
  shipping_same_as_billing?: boolean;
  shipping_address1?: string;
  shipping_address2?: string;
  shipping_address3?: string;
  shipping_city?: string;
  shipping_post_code?: string;
  shipping_country?: string;
  shipping_region?: string;
  status?: string;
  role?: string;
  paddle_no?: string;
  identity_cert?: string;
  platform?: 'Liveauctioneer' | 'The saleroom' | 'Invaluable' | 'Easylive auctions' | 'Private' | 'Others';
  brand_id?: string; // FK to brands(id)
  // Bidder Analytics fields
  card_on_file?: boolean;
  auctions_attended?: number;
  bids_placed?: number;
  items_won?: number;
  tax_exemption?: boolean;
  payment_rate?: number;
  avg_hammer_price_low?: number;
  avg_hammer_price_high?: number;
  disputes_open?: number;
  disputes_closed?: number;
  bidder_notes?: string;
  created_at?: string;
  updated_at?: string;
}

// Parse and format phone numbers using libphonenumber-js
const sanitizePhoneNumber = (raw: any): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;

  try {
    const rawString = String(raw).trim();

    // Handle formats like: "92 (321)2119000", "1 (917)7210426", "1 2013883534", "1 (832) 438-4118"
    // First, clean the string by removing extra spaces, parentheses, dashes, etc.
    let cleaned = rawString
      .replace(/[()\-\s]/g, '') // Remove parentheses, dashes, and spaces
      .replace(/,/g, '') // Remove commas
      .replace(/\./g, ''); // Remove dots

    // If it's just digits, try to parse it
    if (/^\d+$/.test(cleaned)) {
      // First check for known country codes manually (libphonenumber-js may not recognize some)
      if (cleaned.startsWith('92') && cleaned.length === 12) {
        // Pakistan: 92 + 10 digits
        return `92 ${cleaned.substring(2)}`;
      } else if (cleaned.startsWith('91') && cleaned.length === 12) {
        // India: 91 + 10 digits
        return `91 ${cleaned.substring(2)}`;
      } else if (cleaned.startsWith('44') && cleaned.length >= 11) {
        // UK: 44 + remaining digits
        return `44 ${cleaned.substring(2)}`;
      }

      // Try to parse as international number using libphonenumber-js
      try {
        const phoneNumber = parsePhoneNumber(cleaned, 'US'); // Default to US, but it will detect country
        if (phoneNumber && phoneNumber.isValid()) {
          // Format as [Country code] [phone] like "92 3212119000" or "1 8324384118"
          const countryCode = phoneNumber.countryCallingCode;
          const nationalNumber = phoneNumber.nationalNumber;

          // Special handling for specific country codes to ensure proper formatting
          if (countryCode === '1' && nationalNumber.length === 10) {
            // US: 1 + 10 digits
            return `1 ${nationalNumber}`;
          } else {
            // Default formatting for other countries
            return `${countryCode} ${nationalNumber}`;
          }
        }
      } catch (parseError) {
        // If parsing fails, try to manually extract country code and number
      }

      // Manual parsing for cases where libphonenumber-js fails
      if (cleaned.length === 10) {
        // Default to US for 10-digit numbers with no country code
        return `1 ${cleaned}`;
      } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
        // US number: 1 + 10 digits
        return `1 ${cleaned.substring(1)}`;
      } else if (cleaned.length > 10) {
        // Try to extract country code, default to US if no match
        const possibleCountryCodes = ['92', '44', '91', '86', '81', '49', '33', '39', '7', '55', '52'];
        let foundCode = false;
        for (const code of possibleCountryCodes) {
          if (cleaned.startsWith(code)) {
            const remaining = cleaned.substring(code.length);
            if (remaining.length >= 7 && remaining.length <= 10) {
              return `${code} ${remaining}`;
            }
          }
        }
        // Default to US for unrecognized formats
        return `1 ${cleaned}`;
      }
    }

    // If all parsing fails, return the cleaned digits-only version with US default
    const digitsOnly = cleaned.replace(/\D/g, '');
    if (digitsOnly.length === 10) {
      // Default to US for 10-digit numbers
      return `1 ${digitsOnly}`;
    } else if (digitsOnly.length > 10) {
      // Try to find a known country code, otherwise default to US
      const possibleCountryCodes = ['92', '44', '91', '86', '81', '49', '33', '39', '7', '55', '52'];
      for (const code of possibleCountryCodes) {
        if (digitsOnly.startsWith(code)) {
          const remaining = digitsOnly.substring(code.length);
          if (remaining.length >= 7 && remaining.length <= 10) {
            return `${code} ${remaining}`;
          }
        }
      }
      // Default to US if no known country code found
      return `1 ${digitsOnly}`;
    }
    return digitsOnly.length > 0 ? digitsOnly : null;
  } catch (error) {
    console.error('Error parsing phone number:', raw, error);
    // Fallback to basic digit extraction with US default
    const digits = String(raw).replace(/\D+/g, '');
    if (digits.length === 10) {
      return `1 ${digits}`;
    } else if (digits.length > 10) {
      // Try to find known country codes, default to US
      const possibleCountryCodes = ['92', '44', '91', '86', '81', '49', '33', '39', '7', '55', '52'];
      for (const code of possibleCountryCodes) {
        if (digits.startsWith(code)) {
          const remaining = digits.substring(code.length);
          if (remaining.length >= 7 && remaining.length <= 10) {
            return `${code} ${remaining}`;
          }
        }
      }
      return `1 ${digits}`;
    }
    return digits.length > 0 ? digits : null;
  }
};

// Find matching client for Google Sheets sync using preserved CSV ID field
const findMatchingClient = async (record: any): Promise<{ shouldUpdate: boolean; clientId: number | null }> => {
  try {
    // Use the preserved CSV ID for matching
    const originalCsvId = record.csv_id || record.id;

    // Priority 1: Match by ID from CSV if available and valid
    if (originalCsvId && !isNaN(parseInt(originalCsvId)) && parseInt(originalCsvId) > 0) {
      const csvId = parseInt(originalCsvId);
      const { data: clientById } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('id', csvId)
        .maybeSingle();

      if (clientById?.id) {
        console.log(`✅ CSV ID ${csvId} matches existing client ID ${clientById.id} - will UPDATE`);
        return { shouldUpdate: true, clientId: clientById.id };
      } else {
        console.log(`❌ CSV ID ${csvId} not found in database - will CREATE new client`);
        return { shouldUpdate: false, clientId: null };
      }
    }

    // All other matches require brand_id to be present
    if (!record.brand_id) {
      console.log(`❌ No brand_id provided for record: ${record.first_name || 'Unknown'} ${record.last_name || 'Unknown'} - will CREATE new client`);
      return { shouldUpdate: false, clientId: null };
    }

    // Priority 2: Match by email if available (within same brand)
    if (record.email && String(record.email).trim() !== '') {
      const { data: clientByEmail } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('email', String(record.email).trim().toLowerCase())
        .eq('brand_id', record.brand_id)
        .maybeSingle();

      if (clientByEmail?.id) {
        console.log(`✅ Matched client by email in brand ${record.brand_id}: ${record.email} -> ID: ${clientByEmail.id} - will UPDATE`);
        return { shouldUpdate: true, clientId: clientByEmail.id };
      }
    }

    // Priority 3: Match by first_name + last_name + company_name combination (within same brand)
    if (record.first_name && record.last_name) {
      let query = supabaseAdmin
        .from('clients')
        .select('id')
        .eq('first_name', String(record.first_name).trim())
        .eq('last_name', String(record.last_name).trim())
        .eq('brand_id', record.brand_id);

      // Add company_name filter if available
      if (record.company_name && String(record.company_name).trim() !== '') {
        query = query.eq('company_name', String(record.company_name).trim());
      }

      const { data: clientByName } = await query.maybeSingle();

      if (clientByName?.id) {
        console.log(`✅ Matched client by name in brand ${record.brand_id}${record.company_name ? ' + company' : ''}: ${record.first_name} ${record.last_name}${record.company_name ? ` (${record.company_name})` : ''} -> ID: ${clientByName.id} - will UPDATE`);
        return { shouldUpdate: true, clientId: clientByName.id };
      }
    }

    // Priority 4: Match by phone number if available (within same brand)
    if (record.phone_number) {
      const sanitizedPhone = sanitizePhoneNumber(record.phone_number);
      if (sanitizedPhone) {
        const { data: clientByPhone } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('phone_number', sanitizedPhone)
          .eq('brand_id', record.brand_id)
          .maybeSingle();

        if (clientByPhone?.id) {
          console.log(`✅ Matched client by phone in brand ${record.brand_id}: ${record.phone_number} -> ID: ${clientByPhone.id} - will UPDATE`);
          return { shouldUpdate: true, clientId: clientByPhone.id };
        }
      }
    }

    console.log(`❌ No matching client found for record: ${record.first_name || 'Unknown'} ${record.last_name || 'Unknown'} in brand ${record.brand_id} - will CREATE new client`);
    return { shouldUpdate: false, clientId: null };
  } catch (error) {
    console.error('❌ Error finding matching client:', error);
    return { shouldUpdate: false, clientId: null };
  }
};

// Resolve a brand provided as id/code/name into a numeric brand_id
const resolveBrandId = async (value: any): Promise<number | null> => {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  
  console.log(`Resolving brand: "${raw}"`);
  
  // First try parsing as a numeric ID
  const asNum = parseInt(raw, 10);
  if (!Number.isNaN(asNum)) {
    console.log(`Brand resolved as numeric ID: ${asNum}`);
    return asNum;
  }
  
  // Try by code (uppercase)
  {
    const code = raw.toUpperCase();
    const { data } = await supabaseAdmin
      .from('brands')
      .select('id, code')
      .eq('code', code)
      .maybeSingle();
    if (data?.id) {
      console.log(`Brand resolved by code "${code}" to ID: ${data.id}`);
      return data.id as number;
    }
  }
  
  // Try by name (case-insensitive exact match first)
  {
    const { data } = await supabaseAdmin
      .from('brands')
      .select('id, name')
      .ilike('name', raw)
      .maybeSingle();
    if (data?.id) {
      console.log(`Brand resolved by name "${raw}" to ID: ${data.id}`);
      return data.id as number;
    }
  }
  
  console.log(`Brand not found: "${raw}"`);
  return null;
};

// Convert Google Sheets URL to CSV export format
const convertToGoogleSheetsCSVUrl = (url: string): string => {
  try {
    // Check if it's already a CSV export URL
    if (url.includes('/export?format=csv') || url.includes('&format=csv')) {
      return url;
    }

    // Handle Google Sheets URLs
    if (url.includes('docs.google.com/spreadsheets')) {
      // Extract sheet ID from various Google Sheets URL formats
      let sheetId = '';
      
      // Format: https://docs.google.com/spreadsheets/d/{ID}/edit#gid=0
      const editMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (editMatch) {
        sheetId = editMatch[1];
      }
      
      if (sheetId) {
        // Convert to CSV export URL
        return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
      }
    }

    // If it's not a recognized Google Sheets URL, return as-is and hope it's a direct CSV URL
    return url;
  } catch (error) {
    console.error('Error converting Google Sheets URL:', error);
    return url;
  }
};

// Minimal CSV row parser that supports quotes and commas within quotes
const parseCsvRow = (row: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map(s => s.trim());
};

// GET /clients - List clients with filtering, pagination, and search
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const startTime = Date.now();
  console.log('🚀 GET /clients REQUEST:', {
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    origin: req.get('Origin'),
    referer: req.get('Referer'),
    query: req.query,
    userId: req.user?.id,
    timestamp: new Date().toISOString()
  });

  try {
    const {
      status,
      search,
      page = 1,
      limit = 25,
      sort_field = 'id',
      sort_direction = 'asc',
      client_type,
      platform,
      tags,
      registration_date,
      brand_code
    } = req.query as any;

    let query = supabaseAdmin
      .from('clients')
      .select('*, brands (code, name)');

    // Filter by status
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    // Filter by brand code (translate to brand_id)
    if (brand_code && String(brand_code).toUpperCase() !== 'ALL') {
      const code = String(brand_code).toUpperCase();
      const { data: brandRow } = await supabaseAdmin
        .from('brands')
        .select('id, code')
        .eq('code', code)
        .maybeSingle();
      if (brandRow?.id) {
        query = query.eq('brand_id', brandRow.id);
      }
    }

    // Search across multiple fields; support [AAA-]ID patterns by extracting trailing number
    if (search) {
      const s = String(search);
      const match = s.match(/^(?:[a-zA-Z]{2,4}-)?(\d{1,})$/);
      if (match) {
        const idNum = parseInt(match[1]);
        if (!Number.isNaN(idNum)) {
          query = query.or(`id.eq.${idNum},first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,company_name.ilike.%${s}%,phone_number.ilike.%${s}%,tags.ilike.%${s}%,bidder_notes.ilike.%${s}%`);
        }
      } else {
        query = query.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,company_name.ilike.%${s}%,phone_number.ilike.%${s}%,tags.ilike.%${s}%,bidder_notes.ilike.%${s}%`);
      }
    }
    // Filter by tags
    if (tags && String(tags).trim() !== '') {
      query = query.ilike('tags', `%${tags}%`);
    }

    // Filter by registration date ranges
    if (registration_date && registration_date !== 'all') {
      const now = new Date();
      let threshold: Date | null = null;
      switch (registration_date) {
        case '30days':
          threshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '3months':
          threshold = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        case '6months':
          threshold = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
          break;
        case '1year':
          threshold = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          break;
      }
      if (threshold) {
        query = query.gte('created_at', threshold.toISOString());
      }
    }

    // Filter by client_type if provided
    if (client_type && client_type !== 'all') {
      query = query.eq('client_type', client_type);
    }

    // Filter by platform if provided
    console.log('platform', platform);
    if (platform && platform !== 'all') {
      query = query.eq('platform', platform);
    }

    // Sort by specified field and direction
    query = query.order(sort_field as string, {
      ascending: sort_direction === 'asc'
    });

    // Pagination
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;
    query = query.range(offset, offset + limitNum - 1);

    const { data: clients, error } = await query;

    if (error) {
      console.error('Error fetching clients:', error);
      return res.status(500).json({
        error: 'Failed to fetch clients',
        details: error.message
      });
    }

    // Map nested brands(code,name) into flat brand_code/brand_name fields for UI
    const enrichedClients = (clients || []).map((c: any) => {
      const brandRel = (c as any).brands || {};
      return {
        ...c,
        brand: brandRel?.code || null,
        brand_code: brandRel?.code || null,
        brand_name: brandRel?.name || null,
      };
    });

    // Get total count for pagination
    const { count: totalCount } = await supabaseAdmin
      .from('clients')
      .select('*', { count: 'exact', head: true });

    // Get status counts for filters
    const { data: statusCounts } = await supabaseAdmin
      .from('clients')
      .select('status')
      .not('status', 'eq', 'deleted');

    const counts = {
      active: 0,
      suspended: 0,
      pending: 0,
      archived: 0,
      deleted: 0
    };

    statusCounts?.forEach(client => {
      if (client.status in counts) {
        counts[client.status as keyof typeof counts]++;
      }
    });

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log('✅ GET /clients SUCCESS:', {
      status: 200,
      clientCount: enrichedClients.length,
      totalCount: totalCount || 0,
      pagination: {
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil((totalCount || 0) / limitNum)
      },
      duration: `${duration}ms`,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      data: enrichedClients,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount || 0,
        pages: Math.ceil((totalCount || 0) / limitNum)
      },
      counts
    });

  } catch (error: any) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    console.error('❌ GET /clients ERROR:', {
      error: error.message,
      stack: error.stack,
      status: 500,
      duration: `${duration}ms`,
      userId: req.user?.id,
      query: req.query,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /clients/:id - Get single client by integer ID
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    // Parse and validate integer ID
    const clientId = parseInt(id);
    if (isNaN(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format. Must be an integer.' });
    }

    const { data: client, error } = await supabaseAdmin
      .from('clients')
      .select('*, brands (code, name)')
      .eq('id', clientId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Client not found' });
      }
      console.error('Error fetching client:', error);
      return res.status(500).json({
        error: 'Failed to fetch client',
        details: error.message
      });
    }

    // Map nested brands(code,name) into flat brand_code/brand_name fields for UI
    const brandRel = (client as any).brands || {};
    const enrichedClient = {
      ...client,
      brand: brandRel?.code || null,
      brand_code: brandRel?.code || null,
      brand_name: brandRel?.name || null,
    };

    res.json({
      success: true,
      data: enrichedClient
    });

  } catch (error: any) {
    console.error('Error in GET /clients/:id:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /clients - Create new client
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const clientData: Client = req.body;
    const userId = req.user?.id;

    // Validate required fields
    if (!clientData.first_name || !clientData.last_name) {
      return res.status(400).json({
        error: 'First name and last name are required'
      });
    }

    // Check for duplicate email within the same brand
    if (clientData.email && clientData.brand_id) {
      const { data: existingClient } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('email', clientData.email)
        .eq('brand_id', clientData.brand_id)
        .single();

      if (existingClient) {
        return res.status(409).json({
          error: 'Client with this email already exists in the same brand'
        });
      }
    }

    // Prepare client data with audit fields
    const allowedTypes = ['buyer', 'vendor', 'supplier', 'buyer_vendor'];
    const typeSafe = clientData.client_type && allowedTypes.includes(clientData.client_type) 
      ? clientData.client_type 
      : 'buyer';

    // Prepare client data and ensure no ID is passed for new clients
    // Filter out non-database fields to prevent schema cache errors
    const { id, created_at, updated_at, ...clientDataWithoutId } = clientData as any;
    // Remove UI-only fields that don't exist in database schema
    delete clientDataWithoutId.brand;
    delete clientDataWithoutId.brand_code;
    delete clientDataWithoutId.brand_name;
    const newClient = {
      ...clientDataWithoutId,
      client_type: typeSafe
    };

    // Explicitly remove any id field to ensure Supabase auto-generates it
    delete (newClient as any).id;

    // If brand_id is provided, validate it's an integer id that exists; keep it as integer
    if (clientData.brand_id) {
      const brandIdNum = parseInt(String(clientData.brand_id))
      if (!Number.isNaN(brandIdNum)) {
        const { data: brandExists } = await supabaseAdmin
          .from('brands')
          .select('id')
          .eq('id', brandIdNum)
          .maybeSingle()
        if (brandExists?.id) {
          (newClient as any).brand_id = brandIdNum
        }
      }
    }

    const { data: client, error } = await supabaseAdmin
      .from('clients')
      .insert([newClient])
      .select()
      .single();

        if (error) {
      console.error('Error creating client:', error);
      return res.status(500).json({ 
        error: 'Failed to create client',
        details: error.message 
      });
    }

    // Auto-sync to Google Sheets if configured
    if (client?.id) {
      autoSyncClientToGoogleSheets(client.id);
    }

    res.status(201).json({
      success: true,
      data: client,
      message: 'Client created successfully'
    });

  } catch (error: any) {
    console.error('Error in POST /clients:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// PUT /clients/:id - Update client by integer ID
router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const clientData: Client = req.body;
    const userId = req.user?.id;

    // Parse and validate integer ID
    const clientId = parseInt(id);
    if (isNaN(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format. Must be an integer.' });
    }

    // Check if client exists
    const { data: existingClient, error: fetchError } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .single();

    if (fetchError || !existingClient) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Check for duplicate email within the same brand (excluding current client)
    if (clientData.email && clientData.brand_id) {
      const { data: emailClient } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('email', clientData.email)
        .eq('brand_id', clientData.brand_id)
        .neq('id', clientId)
        .single();

      if (emailClient) {
        return res.status(409).json({
          error: 'Another client with this email already exists in the same brand'
        });
      }
    }

    // Prepare update data with audit fields
    const allowedTypes = ['buyer', 'vendor', 'supplier', 'buyer_vendor'];

    // Filter out non-database fields to prevent schema cache errors
    const filteredClientData = { ...clientData };
    // Remove UI-only fields that don't exist in database schema
    delete (filteredClientData as any).brand;
    delete (filteredClientData as any).brands;
    delete (filteredClientData as any).brand_code;
    delete (filteredClientData as any).brand_name;

    const updateData = {
      ...filteredClientData,
      ...(clientData.client_type && allowedTypes.includes(clientData.client_type) ? { client_type: clientData.client_type } : {})
    } as Partial<Client>;
    console.log('updateData', updateData);

    // If brand_id is provided, validate integer and keep as integer
    if (clientData.brand_id) {
      const brandIdNum = parseInt(String(clientData.brand_id))
      if (!Number.isNaN(brandIdNum)) {
        const { data: brandExists } = await supabaseAdmin
          .from('brands')
          .select('id')
          .eq('id', brandIdNum)
          .maybeSingle()
        if (brandExists?.id) {
          (updateData as any).brand_id = brandIdNum
        }
      }
    }

    const { data: client, error } = await supabaseAdmin
      .from('clients')
      .update(updateData)
      .eq('id', clientId)
      .select()
      .single();

        if (error) {
      console.error('Error updating client:', error);
      return res.status(500).json({ 
        error: 'Failed to update client',
        details: error.message 
      });
    }

    // Auto-sync to Google Sheets if configured
    console.log('client', client?.id);
    if (client?.id) {
      autoSyncClientToGoogleSheets(client.id);
    }

    res.json({
      success: true,
      data: client,
      message: 'Client updated successfully'
    });

  } catch (error: any) {
    console.error('Error in PUT /clients/:id:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// DELETE /clients/:id - Delete client by integer ID (soft delete by default)
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { hard_delete = false } = req.query;
    const userId = req.user?.id;

    // Parse and validate integer ID
    const clientId = parseInt(id);
    if (isNaN(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format. Must be an integer.' });
    }

    if (hard_delete === 'true') {
      // Check for dependencies before hard deletion
      const { data: consignments } = await supabaseAdmin
        .from('consignments')
        .select('id')
        .eq('client_id', clientId);

      const { data: itemsAsBuyer } = await supabaseAdmin
        .from('items')
        .select('id')
        .eq('buyer_id', clientId);

      if (consignments && consignments.length > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete client with existing consignments. Please remove or reassign consignments first.' 
        });
      }

      if (itemsAsBuyer && itemsAsBuyer.length > 0) {
        return res.status(400).json({ 
          error: 'Cannot delete client who has purchased items. Please reassign buyer records first.' 
        });
      }

      // Hard delete - permanently remove client
      const { error } = await supabaseAdmin
        .from('clients')
        .delete()
        .eq('id', clientId);

      if (error) {
        console.error('Error hard deleting client:', error);
        return res.status(500).json({
          error: 'Failed to delete client',
          details: error.message
        });
      }

      res.json({
        success: true,
        message: 'Client permanently deleted'
      });
    } else {
      // Soft delete - mark as deleted
      const { data: client, error } = await supabaseAdmin
        .from('clients')
        .update({
          status: 'deleted'
        })
        .eq('id', clientId)
        .select()
        .single();

      if (error) {
        console.error('Error soft deleting client:', error);
        return res.status(500).json({
          error: 'Failed to delete client',
          details: error.message
        });
      }

      res.json({
        success: true,
        data: client,
        message: 'Client marked as deleted'
      });
    }

  } catch (error: any) {
    console.error('Error in DELETE /clients/:id:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /clients/bulk-action - Bulk operations on clients
router.post('/bulk-action', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action, client_ids, data } = req.body;
    const userId = req.user?.id;

    if (!action || !client_ids || !Array.isArray(client_ids)) {
      return res.status(400).json({
        error: 'Action and client_ids array are required'
      });
    }

    // Parse client IDs to integers
    const parsedClientIds = client_ids.map((id: any) => {
      const parsed = parseInt(id);
      if (isNaN(parsed)) {
        throw new Error(`Invalid client ID: ${id}`);
      }
      return parsed;
    });

    let result;
    switch (action) {
      case 'delete':
        result = await supabaseAdmin
          .from('clients')
          .update({
            status: 'deleted'
          })
          .in('id', parsedClientIds);
        break;

      case 'update_status':
        if (!data?.status) {
          return res.status(400).json({
            error: 'Status is required for update_status action'
          });
        }
        result = await supabaseAdmin
          .from('clients')
          .update({
            status: data.status
          })
          .in('id', parsedClientIds);
        break;

      default:
        return res.status(400).json({
          error: 'Invalid action. Supported actions: delete, update_status'
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
      message: `Bulk ${action} completed successfully`,
      affected_count: parsedClientIds.length
    });

  } catch (error: any) {
    console.error('Error in POST /clients/bulk-action:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /clients/validate-csv - Validate CSV data (expects full_name column)
router.post('/validate-csv', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { csv_data } = req.body;

    if (!csv_data) {
      return res.status(400).json({
        error: 'CSV data is required'
      });
    }

    const lines = csv_data.trim().split('\n');
    if (lines.length < 2) {
      return res.status(400).json({
        error: 'CSV must contain at least a header row and one data row'
      });
    }

    const headers = lines[0].split(',').map((h: string) => h.trim().toLowerCase());
    const dataRows = lines.slice(1);

    // Check required fields (support both formats)
    const requiredFields = ['full name', 'brand', 'platform']; // Using 'full name' to match export header
    const missingRequired = requiredFields.filter(field => !headers.includes(field));

    if (missingRequired.length > 0) {
      return res.status(400).json({
        error: `Missing required fields: ${missingRequired.join(', ')}`
      });
    }

    const errors: string[] = [];
    const sampleClients: any[] = [];
    let validRows = 0;

    // Validate first 5 rows as samples
    for (let i = 0; i < Math.min(dataRows.length, 5); i++) {
      const row = dataRows[i];
      const values = parseCsvRow(row).map((v: string) => v.replace(/^"(.*)"$/, '$1'));

      if (values.length !== headers.length) {
        errors.push(`Row ${i + 2}: Column count mismatch`);
        continue;
      }

      const rowObj: Record<string, any> = {};
      headers.forEach((header: string, index: number) => {
        let value: any = values[index];
        if (['has_no_email', 'vat_applicable', 'shipping_same_as_billing'].includes(header)) {
          value = String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes';
        }
        rowObj[header] = value ?? null;
      });

      // Derive first_name and last_name from full_name (support both formats)
      const fullNameRaw = String(rowObj['full name'] || rowObj['full_name'] || '').trim();
      const nameParts = fullNameRaw.split(/\s+/).filter(Boolean);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || ''; // Join remaining parts as last name

      // Validate email format (if provided)
      if (rowObj.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rowObj.email)) {
        errors.push(`Row ${i + 2}: Invalid email format`);
        continue;
      }

      sampleClients.push({
        first_name: firstName,
        last_name: lastName,
        email: rowObj.email || '',
        phone_number: rowObj.phone_number || '',
        client_type: rowObj.client_type || 'buyer',
        brand: rowObj.brand || '',
        platform: rowObj.platform || ''
      });
      validRows++;
    }

    res.json({
      success: true,
      validation_result: {
        total_rows: dataRows.length,
        valid_rows: validRows,
        errors: errors.slice(0, 10), // Limit errors shown
        sample_clients: sampleClients
      }
    });

  } catch (error: any) {
    console.error('Error in POST /clients/validate-csv:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /clients/upload-csv - Upload and process CSV data (expects full_name column)
router.post('/upload-csv', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { csv_data } = req.body;
    const userId = req.user?.id;

    if (!csv_data) {
      return res.status(400).json({
        error: 'CSV data is required'
      });
    }

    const lines = csv_data.trim().split('\n');
    const headers = lines[0].split(',').map((h: string) => h.trim().toLowerCase());
    const dataRows = lines.slice(1);

    const importedClients: any[] = [];
    const errors: string[] = [];
    const existingEmails: string[] = [];
    const duplicateEmails: string[] = [];
    const processedKeys = new Set<string>(); // Track processed records to prevent duplicates
    let duplicateCount = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const values = parseCsvRow(row).map((v: string) => v.replace(/^"(.*)"$/, '$1'));

      if (values.length !== headers.length) {
        errors.push(`Row ${i + 2}: Column count mismatch`);
        continue;
      }

      // Set default values
      const clientData: any = {
        status: 'active',
        role: 'BUYER',
        client_type: 'buyer',
        preferred_language: 'English',
        time_zone: 'UTC',
        shipping_same_as_billing: true,
        identity_cert: 'Uncertified',
      };

      // Map CSV values to client data
      const rowObj: Record<string, any> = {};
      headers.forEach((header: string, index: number) => {
        let value: any = values[index];
        if (['has_no_email', 'vat_applicable', 'shipping_same_as_billing'].includes(header)) {
          value = String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'yes';
        }
        rowObj[header] = value ?? null;
      });

      // Derive first_name and last_name from full_name (support both formats)
      const fullNameRaw = String(rowObj['full name'] || rowObj['full_name'] || '').trim();
      const nameParts = fullNameRaw.split(/\s+/).filter(Boolean);
      clientData.first_name = nameParts[0] || '';
      clientData.last_name = nameParts.slice(1).join(' ') || ''; // Join remaining parts as last name

      // Handle header format variations (spaces vs underscores) for CSV upload
      const csvHeaderMappings: Record<string, string> = {
        'phone number': 'phone_number',
        'secondary phone number': 'secondary_phone_number',
        'full name': 'full_name',
        'client type': 'client_type',
        'buyer premium': 'buyer_premium',
        'vendor premium': 'vendor_premium',
        'vat number': 'vat_number',
        'billing address1': 'billing_address1',
        'billing address2': 'billing_address2',
        'billing address3': 'billing_address3',
        'billing post code': 'billing_post_code',
        'billing city': 'billing_city',
        'billing country': 'billing_country',
        'billing region': 'billing_region',
        'bank account details': 'bank_account_details',
        'bank address': 'bank_address',
        'shipping same as billing': 'shipping_same_as_billing',
        'shipping address1': 'shipping_address1',
        'shipping address2': 'shipping_address2',
        'shipping address3': 'shipping_address3',
        'shipping post code': 'shipping_post_code',
        'shipping city': 'shipping_city',
        'shipping country': 'shipping_country',
        'shipping region': 'shipping_region',
        'preferred language': 'preferred_language',
        'time zone': 'time_zone',
        'has no email': 'has_no_email',
        'vat applicable': 'vat_applicable',
        'secondary email': 'secondary_email',
        'default vat scheme': 'default_vat_scheme',
        'default ldl': 'default_ldl',
        'default consignment charges': 'default_consignment_charges',
        'identity cert': 'identity_cert',
        'birth date': 'birth_date',
        'paddle no': 'paddle_no',
        'avg hammer price low': 'avg_hammer_price_low',
        'avg hammer price high': 'avg_hammer_price_high',
        'card on file': 'card_on_file',
        'auctions attended': 'auctions_attended',
        'bids placed': 'bids_placed',
        'items won': 'items_won',
        'tax exemption': 'tax_exemption',
        'payment rate': 'payment_rate',
        'disputes open': 'disputes_open',
        'disputes closed': 'disputes_closed',
        'bidder notes': 'bidder_notes'
      };

      // Apply CSV mappings to ensure consistent field names
      Object.keys(csvHeaderMappings).forEach(spacedHeader => {
        if (rowObj[spacedHeader] !== undefined && rowObj[csvHeaderMappings[spacedHeader]] === undefined) {
          rowObj[csvHeaderMappings[spacedHeader]] = rowObj[spacedHeader];
        }
      });

      // Assign other fields
      Object.entries(rowObj).forEach(([key, value]) => {
        if (key === 'full_name' || key === 'full name' || key === 'id') return; // ignore
        if (key === 'client_type' && value) {
          const val = String(value).toLowerCase();
          if (['buyer','vendor','supplier','buyer_vendor'].includes(val)) {
            clientData.client_type = val;
          }
          return;
        }
        if (key === 'platform' && value) {
          // normalize platform casing to one of the allowed union values
          const normalized = String(value).toLowerCase();
          const map: Record<string, Client['platform']> = {
            'liveauctioneer': 'Liveauctioneer',
            'the saleroom': 'The saleroom',
            'invaluable': 'Invaluable',
            'easylive auctions': 'Easylive auctions',
            'private': 'Private',
            'others': 'Others'
          };
          clientData.platform = map[normalized] || 'Private';
          return;
        }
        if (value !== null && value !== '') {
          clientData[key] = value;
        }
      });

      // Resolve brand (name/code/id) to brand_id
      const brandRaw = rowObj.brand || rowObj.brand_name || rowObj.brand_code || rowObj.brand_id;
      if (!brandRaw) {
        errors.push(`Row ${i + 2}: Missing brand`);
        continue;
      }
      const brandId = await resolveBrandId(brandRaw);
      if (!brandId) {
        errors.push(`Row ${i + 2}: Unknown brand: ${brandRaw}`);
        continue;
      }
      clientData.brand_id = brandId;

      if (!clientData.platform) {
        errors.push(`Row ${i + 2}: Missing platform`);
        continue;
      }

      // Sanitize phone numbers
      if (clientData.phone_number) clientData.phone_number = sanitizePhoneNumber(clientData.phone_number) as any;
      if (clientData.secondary_phone_number) clientData.secondary_phone_number = sanitizePhoneNumber(clientData.secondary_phone_number) as any;

      // Check for duplicate emails
      if (clientData.email) {
        if (duplicateEmails.includes(clientData.email)) {
          errors.push(`Row ${i + 2}: Duplicate email in import data: ${clientData.email}`);
          continue;
        }

        // Check if email already exists in the same brand
        const { data: existingClient } = await supabaseAdmin
          .from('clients')
          .select('email')
          .eq('email', clientData.email)
          .eq('brand_id', clientData.brand_id)
          .single();

        if (existingClient) {
          existingEmails.push(clientData.email);
          errors.push(`Row ${i + 2}: Email already exists in the same brand: ${clientData.email}`);
          continue;
        }

        duplicateEmails.push(clientData.email);
      }

      // 🔍 Check if client already exists before inserting
      const matchResult = await findMatchingClient(clientData);
      let client;

      if (matchResult.shouldUpdate && matchResult.clientId) {
        console.log(`Row ${i + 2}: Updating existing client ID ${matchResult.clientId}`);

        // Update existing client
        const { data: updatedClient, error: updateError } = await supabaseAdmin
          .from('clients')
          .update(clientData)
          .eq('id', matchResult.clientId)
          .select()
          .single();

        if (updateError) {
          errors.push(`Row ${i + 2}: Update error - ${updateError.message}`);
          continue;
        }

        client = updatedClient;
      } else {
        console.log(`Row ${i + 2}: Creating new client`);

        // Always remove ID field for new client creation
        const { id, ...clientDataWithoutId } = clientData;

        // Insert new client
        const { data: newClient, error: insertError } = await supabaseAdmin
          .from('clients')
          .insert([clientDataWithoutId])
          .select()
          .single();

        if (insertError) {
          errors.push(`Row ${i + 2}: Insert error - ${insertError.message}`);
          continue;
        }

        client = newClient;
      }

      // Create a unique key for deduplication (brand + email + phone + name combination)
      const uniqueKey = [
        String(clientData.brand_id || '').toLowerCase().trim(),
        String(clientData.email || '').toLowerCase().trim(),
        String(clientData.phone_number || '').toLowerCase().trim(),
        String(clientData.first_name || '').toLowerCase().trim(),
        String(clientData.last_name || '').toLowerCase().trim(),
        String(clientData.company_name || '').toLowerCase().trim()
      ].join('|');

      // Skip if we've already processed this exact record
      if (processedKeys.has(uniqueKey)) {
        console.log(`⚠️ Skipping duplicate record (row ${i + 2}): ${clientData.first_name} ${clientData.last_name} - ${clientData.email || 'no email'}`);
        duplicateCount++;
        continue;
      }

      // Mark this record as processed
      processedKeys.add(uniqueKey);

      importedClients.push(client);
    }

    res.json({
      success: true,
      message: `Successfully imported ${importedClients.length} clients`,
      imported_count: importedClients.length,
      clients: importedClients,
      errors: errors.slice(0, 20), // Limit errors shown
      existing_emails: existingEmails,
      duplicate_emails: [...new Set(duplicateEmails)], // Remove duplicates
      duplicates_skipped: duplicateCount,
      total_processed: importedClients.length + duplicateCount
    });

  } catch (error: any) {
    console.error('Error in POST /clients/upload-csv:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// POST /clients/sync-google-sheet - Import/sync clients from a Google Sheet CSV URL
router.post('/sync-google-sheet', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sheet_url, default_brand } = req.body as { sheet_url?: string; default_brand?: string };
    console.log('Original sheet_url:', sheet_url);
    console.log('Default brand for empty fields:', default_brand);

    if (!sheet_url) {
      return res.status(400).json({ error: 'sheet_url is required' });
    }

    // Check for duplicate sync requests
    const cacheKey = `${sheet_url}_${req.user?.id || 'anonymous'}`;
    const now = Date.now();
    const lastSync = syncCache.get(cacheKey);

    if (lastSync && (now - lastSync) < SYNC_CACHE_TTL) {
      console.log('⚠️ Duplicate sync request detected, skipping');
      return res.status(429).json({
        error: 'Sync already in progress. Please wait 30 seconds before trying again.'
      });
    }

    // Update cache with current timestamp
    syncCache.set(cacheKey, now);

    // Clean up old cache entries
    for (const [key, timestamp] of syncCache.entries()) {
      if (now - timestamp > SYNC_CACHE_TTL) {
        syncCache.delete(key);
      }
    }

    // Convert to proper CSV export URL
    const csvUrl = convertToGoogleSheetsCSVUrl(sheet_url);
    console.log('Converted CSV URL:', csvUrl);

    // Fetch CSV with proper headers
    const response = await fetch(csvUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      console.error('Fetch failed:', response.status, response.statusText);
      return res.status(400).json({ 
        error: `Failed to fetch sheet: ${response.statusText}`,
        details: `Status: ${response.status}, URL: ${csvUrl}`
      });
    }
    
    const csvText = await response.text();
    console.log('CSV Text Length:', csvText.length);
    console.log('CSV Text Preview:', csvText.substring(0, 500));

    // Use Papa Parse for better CSV parsing
    const parseResult = Papa.parse<string[]>(csvText, {
      header: false,
      skipEmptyLines: true,
      transform: (value: string) => value.trim()
    });

    if (parseResult.errors && parseResult.errors.length > 0) {
      console.error('Papa Parse errors:', parseResult.errors);
      return res.status(400).json({ 
        error: 'CSV parsing failed', 
        details: parseResult.errors.map((e: any) => e.message).join(', ') 
      });
    }

    const rows = parseResult.data;
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV must contain at least a header row and one data row' });
    }

    const headers = rows[0].map((h: any) => h.trim().toLowerCase());
    const dataRows = rows.slice(1);

    console.log('Parsed headers:', headers);
    console.log('Data rows count:', dataRows.length);
    console.log('First data row sample:', dataRows[0]);

    // ✅ INFO: Check for ID column for proper matching
    if (headers.includes('id')) {
      console.log('📋 INFO: Google Sheets contains "id" column - will use for matching existing clients');
      console.log('   If ID matches existing client, it will be updated');
      console.log('   If ID does not match, a new client will be created');
    }

    // Build upsert payloads
    const upserts: any[] = [];
    const errors: string[] = [];
    const processedKeys = new Set<string>(); // Track processed records to prevent duplicates
    let duplicateCount = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const values = dataRows[i];
      if (!values || values.length === 0) continue;

      // Skip rows where all values are empty
      if (values.every((val: any) => !val || String(val).trim() === '')) continue;

      if (values.length !== headers.length) {
        errors.push(`Row ${i + 2}: Column count mismatch (expected ${headers.length}, got ${values.length})`);
        continue;
      }
      
      const obj: Record<string, any> = {};
      headers.forEach((header: string, index: number) => {
        // Skip any legacy or unsupported fields
        if (header === 'display_id' || header === 'client_id' || header === 'created_at' || header === 'updated_at') {
          return; // Skip these fields
        }
        
        let value: any = values[index] || '';
        
        // Handle boolean fields
        if (['has_no_email', 'vat_applicable', 'shipping_same_as_billing'].includes(header)) {
          const strValue = String(value).toLowerCase().trim();
          value = strValue === 'true' || strValue === 'yes' || strValue === '1';
        }
        
        // Clean up string values
        if (typeof value === 'string') {
          value = value.trim();
          if (value === '') value = null;
        }
        
        obj[header] = value;
      });

      // Only log headers once for the first data row
      if (i === 0) {
        console.log('CSV headers:', headers);
        console.log('First row processed obj keys:', Object.keys(obj));
      }

      // Support full_name split (handle both header formats)
      const fullNameField = obj['full name'] || obj['full_name'] || obj.full_name;
      if (fullNameField) {
        const parts = String(fullNameField).trim().split(/\s+/).filter(Boolean);
        obj.first_name = parts[0] || '';
        obj.last_name = parts.slice(1).join(' ') || ''; // Join remaining parts as last name
      }

      // Handle header format variations (spaces vs underscores)
      // Map spaced headers to underscore versions for consistency
      const headerMappings: Record<string, string> = {
        'phone number': 'phone_number',
        'secondary phone number': 'secondary_phone_number',
        'full name': 'full_name',
        'client type': 'client_type',
        'buyer premium': 'buyer_premium',
        'vendor premium': 'vendor_premium',
        'vat number': 'vat_number',
        'billing address1': 'billing_address1',
        'billing address2': 'billing_address2',
        'billing address3': 'billing_address3',
        'billing post code': 'billing_post_code',
        'billing city': 'billing_city',
        'billing country': 'billing_country',
        'billing region': 'billing_region',
        'bank account details': 'bank_account_details',
        'bank address': 'bank_address',
        'shipping same as billing': 'shipping_same_as_billing',
        'shipping address1': 'shipping_address1',
        'shipping address2': 'shipping_address2',
        'shipping address3': 'shipping_address3',
        'shipping post code': 'shipping_post_code',
        'shipping city': 'shipping_city',
        'shipping country': 'shipping_country',
        'shipping region': 'shipping_region',
        'preferred language': 'preferred_language',
        'time zone': 'time_zone',
        'has no email': 'has_no_email',
        'vat applicable': 'vat_applicable',
        'secondary email': 'secondary_email',
        'default vat scheme': 'default_vat_scheme',
        'default ldl': 'default_ldl',
        'default consignment charges': 'default_consignment_charges',
        'identity cert': 'identity_cert',
        'birth date': 'birth_date',
        'paddle no': 'paddle_no',
        'avg hammer price low': 'avg_hammer_price_low',
        'avg hammer price high': 'avg_hammer_price_high',
        'card on file': 'card_on_file',
        'auctions attended': 'auctions_attended',
        'bids placed': 'bids_placed',
        'items won': 'items_won',
        'tax exemption': 'tax_exemption',
        'payment rate': 'payment_rate',
        'disputes open': 'disputes_open',
        'disputes closed': 'disputes_closed',
        'bidder notes': 'bidder_notes'
      };

      // Apply mappings to ensure consistent field names
      Object.keys(headerMappings).forEach(spacedHeader => {
        if (obj[spacedHeader] !== undefined && obj[headerMappings[spacedHeader]] === undefined) {
          obj[headerMappings[spacedHeader]] = obj[spacedHeader];
        }
      });

      // Enhanced validation - require names
      if (!obj.first_name || String(obj.first_name).trim() === '') {
        const errorMsg = `Row ${i + 2}: Missing first name`;
        console.error('VALIDATION ERROR:', errorMsg);
        errors.push(errorMsg);
        continue;
      }
      if (!obj.last_name || String(obj.last_name).trim() === '') {
        const errorMsg = `Row ${i + 2}: Missing last name`;
        console.error('VALIDATION ERROR:', errorMsg);
        errors.push(errorMsg);
        continue;
      }

      // Validate email format if provided
      if (obj.email && String(obj.email).trim() !== '') {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(String(obj.email))) {
          const errorMsg = `Row ${i + 2}: Invalid email format: ${obj.email}`;
          console.error('VALIDATION ERROR:', errorMsg);
          errors.push(errorMsg);
          continue;
        }
      }

      // Normalize client_type
      if (obj.client_type) {
        const v = String(obj.client_type).toLowerCase();
        if (!['buyer','vendor','supplier','buyer_vendor'].includes(v)) obj.client_type = 'buyer';
      } else {
        obj.client_type = 'buyer';
      }

      // Normalize platform
      if (obj.platform) {
        const platformMap: Record<string, string> = {
          'liveauctioneer': 'Liveauctioneer',
          'the saleroom': 'The saleroom',
          'invaluable': 'Invaluable',
          'easylive auctions': 'Easylive auctions',
          'private': 'Private',
          'others': 'Others'
        };
        const normalizedPlatform = platformMap[String(obj.platform).toLowerCase()];
        if (normalizedPlatform) {
          obj.platform = normalizedPlatform;
        } else {
          obj.platform = 'Private'; // default
        }
      }

      // Prepare client data - preserve CSV ID for matching, remove only for new inserts
      const record: any = {
        status: obj.status || 'active',
        role: obj.role || 'BUYER',
        client_type: obj.client_type,
        preferred_language: obj.preferred_language || 'English',
        time_zone: obj.time_zone || 'UTC',
        shipping_same_as_billing: obj.shipping_same_as_billing ?? true,
        identity_cert: obj.identity_cert || 'Uncertified',
        // identity
        first_name: String(obj.first_name).trim(),
        last_name: String(obj.last_name).trim(),
        email: obj.email && String(obj.email).trim() !== '' ? String(obj.email).trim() : null,
        phone_number: sanitizePhoneNumber(obj.phone_number),
        company_name: obj.company_name && String(obj.company_name).trim() !== '' ? String(obj.company_name).trim() : null,
        instagram_url: obj.instagram_url || null,
        vat_number: obj.vat_number || null,
        tags: obj.tags || null,
        // billing
        billing_address1: obj.billing_address1 || null,
        billing_address2: obj.billing_address2 || null,
        billing_address3: obj.billing_address3 || null,
        billing_city: obj.billing_city || null,
        billing_post_code: obj.billing_post_code || null,
        billing_country: obj.billing_country || null,
        billing_region: obj.billing_region || null,
        bank_account_details: obj.bank_account_details || null,
        bank_address: obj.bank_address || null,
        buyer_premium: obj.buyer_premium ? parseFloat(String(obj.buyer_premium)) : null,
        vendor_premium: obj.vendor_premium ? parseFloat(String(obj.vendor_premium)) : null,
        // shipping
        shipping_address1: obj.shipping_address1 || null,
        shipping_address2: obj.shipping_address2 || null,
        shipping_address3: obj.shipping_address3 || null,
        shipping_city: obj.shipping_city || null,
        shipping_post_code: obj.shipping_post_code || null,
        shipping_country: obj.shipping_country || null,
        shipping_region: obj.shipping_region || null,
        paddle_no: obj.paddle_no || null,
        platform: obj.platform || 'Private'
      };

      // Preserve original CSV ID for matching logic - will be removed only for new inserts
      if (obj.id && !isNaN(parseInt(obj.id)) && parseInt(obj.id) > 0) {
        record.csv_id = parseInt(obj.id); // Store for matching, but don't set as database id
      }

      // Resolve brand to brand_id if provided, or use default_brand for empty brand fields
      let brandToResolve = obj.brand || obj.brand_id || obj.brand_code;

      // If no brand specified and we have a default_brand, use it
      if (!brandToResolve && default_brand) {
        brandToResolve = default_brand;
        console.log(`Row ${i + 2}: Using default brand '${default_brand}' for empty brand field`);
      }

      if (brandToResolve) {
        const brandIdForUpsert = await resolveBrandId(brandToResolve);
        if (brandIdForUpsert) {
          record.brand_id = brandIdForUpsert;
        } else {
          const errorMsg = `Row ${i + 2}: Unknown brand: ${brandToResolve}`;
          console.error('BRAND RESOLUTION ERROR:', errorMsg);
          errors.push(errorMsg);
          continue;
        }
      } else {
        // No brand specified and no default - this might be an error depending on your business rules
        console.log(`Row ${i + 2}: No brand specified`);
      }

      // 🔍 Find matching existing client for update instead of creating duplicate
      const matchResult = await findMatchingClient(record);
      if (matchResult.shouldUpdate && matchResult.clientId) {
        console.log(`Row ${i + 2}: Will UPDATE existing client ID ${matchResult.clientId} (matched by ID: ${record.csv_id || obj.id})`);
        // Set flags for batch processing to know this should be an update
        record._shouldUpdate = true;
        record._targetId = matchResult.clientId;
      } else {
        console.log(`Row ${i + 2}: Will CREATE new client (no existing match found for ID: ${record.csv_id || obj.id || 'none'})`);
        // Set flags for batch processing to know this should be an insert
        record._shouldUpdate = false;
      }

      // Create a unique key for deduplication (brand + email + phone + name combination)
      const uniqueKey = [
        String(record.brand_id || '').toLowerCase().trim(),
        String(record.email || '').toLowerCase().trim(),
        String(record.phone_number || '').toLowerCase().trim(),
        String(record.first_name || '').toLowerCase().trim(),
        String(record.last_name || '').toLowerCase().trim(),
        String(record.company_name || '').toLowerCase().trim()
      ].join('|');

      // Skip if we've already processed this exact record
      if (processedKeys.has(uniqueKey)) {
        console.log(`⚠️ Skipping duplicate record (row ${i + 2}): ${record.first_name} ${record.last_name} - ${record.email || 'no email'}`);
        duplicateCount++;
        continue;
      }

      // Mark this record as processed
      processedKeys.add(uniqueKey);

      // Remove any fields that don't exist in the database schema
      // ⚠️  IMPORTANT: 'id' is intentionally excluded to prevent sequence conflicts
      const allowedFields = [
        'title', 'first_name', 'last_name', 'salutation', 'birth_date',
        'preferred_language', 'time_zone', 'tags', 'email', 'phone_number',
        'company_name', 'vat_number', 'instagram_url', 'has_no_email',
        'vat_applicable', 'secondary_email', 'secondary_phone_number',
        'client_type', 'default_vat_scheme', 'default_ldl', 'default_consignment_charges',
        'buyer_premium', 'vendor_premium',
        'billing_address1', 'billing_address2', 'billing_address3', 'billing_city',
        'billing_post_code', 'billing_country', 'billing_region',
        'shipping_same_as_billing', 'shipping_address1', 'shipping_address2',
        'shipping_address3', 'shipping_city', 'shipping_post_code',
        'shipping_country', 'shipping_region', 'status', 'role', 'paddle_no',
        'identity_cert', 'platform', 'brand_id'
      ];

      // Filter record to only include allowed fields - be more aggressive
      const cleanRecord: any = {};
      allowedFields.forEach(field => {
        if (record.hasOwnProperty(field) && record[field] !== undefined) {
          cleanRecord[field] = record[field];
        }
      });

      // Explicitly ensure no temporary/tracking fields exist
      delete cleanRecord.display_id;
      delete cleanRecord.client_id;
      delete cleanRecord.created_at;
      delete cleanRecord.updated_at;
      delete cleanRecord.csv_id; // Remove temporary CSV ID field used for matching

      // Preserve update/insert routing flags for batching logic (will be stripped before DB ops)
      if (record._shouldUpdate !== undefined) {
        (cleanRecord as any)._shouldUpdate = record._shouldUpdate;
      }
      if (record._targetId !== undefined) {
        (cleanRecord as any)._targetId = record._targetId;
      }

      // Only log clean record structure for the first few rows
      if (i <= 2) {
        console.log(`Row ${i + 2} clean record keys:`, Object.keys(cleanRecord));
        console.log(`Row ${i + 2} clean record sample:`, {
          id: cleanRecord.id,
          first_name: cleanRecord.first_name,
          last_name: cleanRecord.last_name,
          brand_id: cleanRecord.brand_id,
          email: cleanRecord.email
        });
      }

      upserts.push(cleanRecord);
    }

    if (upserts.length === 0) {
      return res.json({ success: true, upserted: 0, errors });
    }

    // Process upserts in smaller batches to handle constraints better
    const batchSize = 50;
    let totalUpserted = 0;
    const batchErrors: string[] = [];

    for (let i = 0; i < upserts.length; i += batchSize) {
      const batch = upserts.slice(i, i + batchSize);

      try {
        // Group records by brand_id for proper duplicate detection
        const recordsByBrand = new Map<number, any[]>();
        for (const record of batch) {
          const brandId = record.brand_id;
          if (!recordsByBrand.has(brandId)) {
            recordsByBrand.set(brandId, []);
          }
          recordsByBrand.get(brandId)!.push(record);
        }

        // Check for duplicates within each brand
        for (const [brandId, brandRecords] of recordsByBrand) {
          // Check for duplicate emails within the same brand in this batch
          const brandEmails = brandRecords
            .filter(record => record.email)
            .map(record => ({ email: record.email.toLowerCase(), record }));

          const emailMap = new Map<string, any[]>();
          for (const item of brandEmails) {
            if (!emailMap.has(item.email)) {
              emailMap.set(item.email, []);
            }
            emailMap.get(item.email)!.push(item.record);
          }

          // Find duplicates within this brand
          const duplicateEmailsInBrand: string[] = [];
          for (const [email, records] of emailMap) {
            if (records.length > 1) {
              duplicateEmailsInBrand.push(email);
            }
          }

          if (duplicateEmailsInBrand.length > 0) {
            batchErrors.push(`Batch ${Math.floor(i/batchSize) + 1}: Duplicate emails in brand ${brandId}: ${duplicateEmailsInBrand.join(', ')}`);
            continue;
          }

          // Check for existing emails in database for this brand
          const uniqueEmails = [...new Set(brandEmails.map(item => item.email))];
          if (uniqueEmails.length > 0) {
            const { data: existingClients } = await supabaseAdmin
              .from('clients')
              .select('email, id')
              .in('email', uniqueEmails)
              .eq('brand_id', brandId);

            if (existingClients && existingClients.length > 0) {
              // Filter out records that would conflict with existing emails (unless updating by id)
              const filteredBrandRecords = brandRecords.filter(record => {
                if (!record.email) return true;
                const existingClient = existingClients.find(ec =>
                  ec.email.toLowerCase() === record.email.toLowerCase()
                );
                if (existingClient) {
                  // Allow if we're updating the same record by target id
                  if ((record as any)._shouldUpdate === true && (record as any)._targetId === existingClient.id) {
                    return true;
                  }
                  // Also allow if an explicit id matches (defensive)
                  if ((record as any).id && (record as any).id === existingClient.id) {
                    return true;
                  }
                  batchErrors.push(`Email already exists in brand ${brandId}: ${record.email} (Client ID: ${existingClient.id})`);
                  return false;
                }
                return true;
              });

              // Update the records for this brand
              recordsByBrand.set(brandId, filteredBrandRecords);
            }
          }
        }

        // Rebuild batch from filtered records
        const filteredBatch: any[] = [];
        for (const brandRecords of recordsByBrand.values()) {
          filteredBatch.push(...brandRecords);
        }

        if (filteredBatch.length === 0) continue;

        // Update batch with filtered records
        batch.splice(0, batch.length, ...filteredBatch);

        // Log what we're about to send to database for the first batch
        if (i === 0) {
          console.log('First batch sample records being sent to database:');
          batch.slice(0, 2).forEach((record, idx) => {
            console.log(`  Record ${idx + 1} keys:`, Object.keys(record));
            console.log(`  Record ${idx + 1} data:`, JSON.stringify(record, null, 2));
          });
        }

        // Separate records that should be updated vs inserted based on our matching logic
        const updates: any[] = [];
        const inserts: any[] = [];

        // Process each record in the batch
        for (const record of batch) {
          // Check if this record has a database ID set (meaning it should be updated)
          if (record._shouldUpdate === true && record._targetId) {
            // This is an update - use the target database ID
            const updateRecord = { ...record };
            delete updateRecord._shouldUpdate;
            delete updateRecord._targetId;
            delete updateRecord.csv_id; // Remove CSV ID to avoid conflicts in update
            delete updateRecord.id; // Remove any remaining ID fields

            updates.push({
              record: updateRecord,
              targetId: record._targetId
            });
          } else {
            // This is an insert - remove any ID fields to prevent conflicts
            const { id, csv_id, _shouldUpdate, _targetId, ...insertRecord } = record;
            inserts.push(insertRecord);
          }
        }

        let data: any[] = [];
        let error: any = null;

        // Handle updates first - use individual update operations
        if (updates.length > 0) {
          console.log(`Processing ${updates.length} updates...`);
          for (const update of updates) {
            try {
              const { data: updateData, error: updateError } = await supabaseAdmin
                .from('clients')
                .update(update.record)
                .eq('id', update.targetId)
                .select('id')
                .single();

              if (updateError) {
                console.error(`Update failed for client ID ${update.targetId}:`, updateError);
                // Continue with other updates even if one fails
              } else if (updateData) {
                data.push(updateData);
                console.log(`✅ Updated client ID ${update.targetId}`);
              }
            } catch (updateErr: any) {
              console.error(`Exception updating client ID ${update.targetId}:`, updateErr);
            }
          }
          console.log(`Updated ${data.length} existing clients`);
        }

        // Handle inserts
        if (inserts.length > 0) {
          console.log(`Processing ${inserts.length} inserts...`);
          try {
            const { data: insertData, error: insertError } = await supabaseAdmin
              .from('clients')
              .insert(inserts)
              .select('id');

            if (insertError) {
              error = insertError;
              console.error('Insert error:', insertError);
            } else {
              data = data.concat(insertData || []);
              console.log(`✅ Created ${insertData?.length || 0} new clients`);
            }
          } catch (insertErr: any) {
            console.error('Exception during insert:', insertErr);
            error = insertErr;
          }
        }
          
        if (error) {
          const errorMsg = `Batch ${Math.floor(i/batchSize) + 1}: Database error - ${error.message}`;
          console.error('Supabase upsert error details:', {
            error,
            batchSize: batch.length,
            firstRecordKeys: batch[0] ? Object.keys(batch[0]) : 'no records',
            fullError: JSON.stringify(error, null, 2)
          });
          console.error('ERROR MESSAGE FOR USER:', errorMsg);
          batchErrors.push(errorMsg);
          continue;
        }

        totalUpserted += data?.length || 0;
        
      } catch (error: any) {
        const errorMsg = `Batch ${Math.floor(i/batchSize) + 1}: Processing error - ${error.message}`;
        console.error('BATCH PROCESSING ERROR:', errorMsg);
        console.error('Full batch error details:', error);
        batchErrors.push(errorMsg);
      }
    }

    const allErrors = [...errors, ...batchErrors];
    
    console.log('Sync complete:', {
      totalProcessed: upserts.length + duplicateCount,
      totalUpserted,
      duplicatesSkipped: duplicateCount,
      totalErrors: allErrors.length
    });

    // Log all errors that will be shown to the user
    if (allErrors.length > 0) {
      console.error('=== ALL ERRORS THAT WILL BE SHOWN TO USER ===');
      allErrors.slice(0, 50).forEach((error, index) => {
        console.error(`Error ${index + 1}:`, error);
      });
      console.error('=== END OF USER ERRORS ===');
    }
    
    res.json({ 
      success: true, 
      upserted: totalUpserted,
      processed: upserts.length,
      errors: allErrors.slice(0, 50), // Limit errors to prevent overwhelming response
      summary: {
        csvUrl,
        rowsInCsv: dataRows.length,
        rowsProcessed: upserts.length + duplicateCount,
        rowsUpserted: totalUpserted,
        duplicatesSkipped: duplicateCount,
        errorCount: allErrors.length
      }
    });
  } catch (error: any) {
    console.error('Error in POST /clients/sync-google-sheet:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// GET /clients/export/csv - Export clients to CSV (full_name format)
router.get('/export/csv', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, search } = req.query;

    let query = supabaseAdmin
      .from('clients')
      .select('*, brands (name, code)');

    // Apply filters
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (search) {
      const s = String(search);
      const match = s.match(/^(?:[a-zA-Z]{2,4}-)?(\d{1,})$/);
      if (match) {
        const idNum = parseInt(match[1]);
        if (!Number.isNaN(idNum)) {
          query = query.or(`id.eq.${idNum},first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,company_name.ilike.%${s}%`);
        }
      } else {
        query = query.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,company_name.ilike.%${s}%`);
      }
    }

    // Force export ordering by id DESC as requested
    query = query.order('id', { ascending: true });
    const { data: clients, error } = await query;

    if (error) {
      console.error('Error fetching clients for export:', error);
      return res.status(500).json({
        error: 'Failed to fetch clients for export',
        details: error.message
      });
    }

    // Define CSV headers (consistent with Google Sheets format)
    const csvHeaders = [
      'id','Full Name','brand','platform','email','Phone Number','company_name','instagram_url','role','client_type','vat_number','tags','billing_country','billing_city','identity_cert','title','salutation','birth_date','preferred_language','time_zone','has_no_email','vat_applicable','secondary_email','Secondary Phone Number','default_vat_scheme','default_ldl','default_consignment_charges','billing_address1','billing_address2','billing_address3','billing_post_code','billing_region','bank_account_details','bank_address','Buyer Premium','Vendor Premium','shipping_same_as_billing','shipping_address1','shipping_address2','shipping_address3','shipping_city','shipping_post_code','shipping_country','shipping_region','paddle_no'
    ];

    // Map client data to CSV rows (full_name = first_name + last_name)
    const csvRows = clients?.map(client => {
      const fullName = `${client.first_name || ''} ${client.last_name || ''}`.trim();
      const brandName = (client as any).brands?.name || '';
      const phone = sanitizePhoneNumber(client.phone_number) || '';
      const secondaryPhone = sanitizePhoneNumber((client as any).secondary_phone_number) || '';
      return [
        client.id,
        fullName,
        brandName,
        client.platform || '',
        client.email || '',
        phone,
        client.company_name || '',
        client.instagram_url || '',
        client.role,
        client.client_type || 'buyer',
        client.vat_number || '',
        client.tags || '',
        client.billing_country || '',
        client.billing_city || '',
        client.identity_cert,
        client.title || '',
        client.salutation || '',
        client.birth_date || '',
        client.preferred_language || '',
        client.time_zone || '',
        client.has_no_email ? 'true' : 'false',
        client.vat_applicable ? 'true' : 'false',
        client.secondary_email || '',
        secondaryPhone,
        client.default_vat_scheme || '',
        client.default_ldl || '',
        client.default_consignment_charges || '',
        client.billing_address1 || '',
        client.billing_address2 || '',
        client.billing_address3 || '',
        client.billing_post_code || '',
        client.billing_region || '',
        client.bank_account_details || '',
        client.bank_address || '',
        client.buyer_premium || '',
        client.vendor_premium || '',
        client.shipping_same_as_billing ? 'true' : 'false',
        client.shipping_address1 || '',
        client.shipping_address2 || '',
        client.shipping_address3 || '',
        client.shipping_city || '',
        client.shipping_post_code || '',
        client.shipping_country || '',
        client.shipping_region || '',
        client.paddle_no || ''
      ];
    }) || [];

    // Create CSV content
    const csvContent = [
      csvHeaders.join(','),
      ...csvRows.map(row => 
        row.map(field => 
          typeof field === 'string' && field.includes(',') 
            ? `"${field.replace(/"/g, '""')}"` 
            : field
        ).join(',')
      )
    ].join('\n');

    // Set response headers for file download
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="clients-export-${timestamp}.csv"`);
    res.send(csvContent);

  } catch (error: any) {
    console.error('Error in GET /clients/export/csv:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// GET /clients/:id/overview - Client overview: purchases, consignments, invoices
router.get('/:id/overview', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const clientId = parseInt(id);
    if (isNaN(clientId)) {
      return res.status(400).json({ error: 'Invalid client ID format. Must be an integer.' });
    }

    // Fetch client
    const { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();
    if (clientError) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Purchases (items where buyer_id = clientId)
    const { data: purchases } = await supabaseAdmin
      .from('items')
      .select('*')
      .eq('buyer_id', clientId)
      .order('created_at', { ascending: false })
      .limit(10);

    // Consignments (where client_id = clientId)
    const { data: consignments } = await supabaseAdmin
      .from('consignments')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(10);

    // Invoices (where client_id = clientId)
    const { data: invoices } = await supabaseAdmin
      .from('invoices')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(10);



    res.json({
      success: true,
      data: {
        client,
        purchases: purchases || [],
        consignments: consignments || [],
        invoices: invoices || []
      }
    });
  } catch (error: any) {
    console.error('Error in GET /clients/:id/overview:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /clients/export-to-google-sheet - Export clients to Google Sheet
router.post('/export-to-google-sheet', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sheet_url } = req.body as { sheet_url?: string };
    if (!sheet_url) {
      return res.status(400).json({ error: 'sheet_url is required' });
    }

    // Fetch all active clients for export
    const { data: clients, error: fetchError } = await supabaseAdmin
      .from('clients')
      .select('*, brands (name, code)')
      .eq('status', 'active')
      .order('id', { ascending: true });

    if (fetchError) {
      console.error('Error fetching clients for Google Sheets export:', fetchError);
      return res.status(500).json({ 
        error: 'Failed to fetch clients for export', 
        details: fetchError.message 
      });
    }

    if (!clients || clients.length === 0) {
      return res.json({ success: true, message: 'No clients to export', exported: 0 });
    }

    // Convert clients to CSV format for Google Sheets
    const csvHeaders = [
      'id', 'full_name', 'brand', 'platform', 'email', 'Phone Number', 'company_name',
      'instagram_url', 'role', 'client_type', 'vat_number', 'tags', 'billing_country',
      'billing_city', 'identity_cert', 'title', 'salutation', 'birth_date',
      'preferred_language', 'time_zone', 'has_no_email', 'vat_applicable',
      'secondary_email', 'secondary_phone_number', 'default_vat_scheme', 'default_ldl',
      'default_consignment_charges', 'billing_address1', 'billing_address2',
      'billing_address3', 'billing_post_code', 'billing_region', 'bank_account_details', 'bank_address', 'buyer_premium', 'vendor_premium', 'shipping_same_as_billing',
      'shipping_address1', 'shipping_address2', 'shipping_address3', 'shipping_city',
      'shipping_post_code', 'shipping_country', 'shipping_region', 'paddle_no'
    ].join(',');

    const csvRows = clients.map(client => {
      const fullName = `${client.first_name || ''} ${client.last_name || ''}`.trim();
      const brandName = (client as any).brands?.name || '';
      const phone = sanitizePhoneNumber(client.phone_number) || '';
      const secondaryPhone = sanitizePhoneNumber((client as any).secondary_phone_number) || '';
      return [
        client.id || '',
        `"${fullName}"`,
        brandName,
        client.platform || '',
        client.email || '',
        phone,
        client.company_name ? `"${client.company_name}"` : '',
        client.instagram_url || '',
        client.role || '',
        client.client_type || '',
        client.vat_number || '',
        client.tags || '',
        client.billing_country || '',
        client.billing_city || '',
        client.identity_cert || '',
        client.title || '',
        client.salutation || '',
        client.birth_date || '',
        client.preferred_language || '',
        client.time_zone || '',
        client.has_no_email ? '1' : '0',
        client.vat_applicable ? '1' : '0',
        client.secondary_email || '',
        secondaryPhone,
        client.default_vat_scheme || '',
        client.default_ldl || '',
        client.default_consignment_charges || '',
        client.billing_address1 || '',
        client.billing_address2 || '',
        client.billing_address3 || '',
        client.billing_post_code || '',
        client.billing_region || '',
        client.bank_account_details || '',
        client.bank_address || '',
        client.shipping_same_as_billing ? '1' : '0',
        client.shipping_address1 || '',
        client.shipping_address2 || '',
        client.shipping_address3 || '',
        client.shipping_city || '',
        client.shipping_post_code || '',
        client.shipping_country || '',
        client.shipping_region || '',
        client.paddle_no || ''
      ].join(',');
    });

    // Write to Google Sheets using the Google Sheets API
    const success = await writeClientsToGoogleSheets(sheet_url, clients);

    if (success) {
      res.json({ 
        success: true, 
        message: `Successfully exported ${clients.length} clients to Google Sheets`, 
        exported: clients.length
      });
    } else {
      res.status(500).json({
        error: 'Failed to export clients to Google Sheets. Please check your Google Sheets configuration and permissions.'
      });
    }

  } catch (error: any) {
    console.error('Error in POST /clients/export-to-google-sheet:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// POST /clients/sync-to-google-sheet - Sync clients to Google Sheets
router.post('/sync-to-google-sheet', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { sheet_url, client_ids } = req.body;

    if (!sheet_url) {
      return res.status(400).json({ error: 'Google Sheets URL is required' });
    }

    // Get clients data
    let query = supabaseAdmin
      .from('clients')
      .select('*, brands (name, code)')
      .eq('status', 'active');

    // Filter by specific client IDs if provided
    if (client_ids && Array.isArray(client_ids) && client_ids.length > 0) {
      query = query.in('id', client_ids);
    }

    const { data: clients, error } = await query.order('id', { ascending: true });

    if (error) {
      console.error('Error fetching clients for sync:', error);
      return res.status(500).json({ error: 'Failed to fetch clients' });
    }

    // Write to Google Sheets
    const success = await writeClientsToGoogleSheets(sheet_url, clients || []);

    if (success) {
      res.json({
        success: true,
        message: `Successfully synced ${(clients || []).length} clients to Google Sheets`,
        count: (clients || []).length
      });
    } else {
      res.status(500).json({
        error: 'Failed to sync clients to Google Sheets. Please check your Google Sheets configuration.'
      });
    }

  } catch (error: any) {
    console.error('Error in POST /clients/sync-to-google-sheet:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /clients/sync-manager/manual - Manually trigger Google Sheets sync
router.post('/sync-manager/manual', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const result = await getGoogleSheetsSyncManager().triggerManualSync();
    res.json(result);

  } catch (error: any) {
    console.error('Error in POST /clients/sync-manager/manual:', error);
    res.status(500).json({
      success: false,
      message: `Manual sync failed: ${error.message}`
    });
  }
});

// POST /clients/sync-manager/start-scheduled - Start scheduled sync
router.post('/sync-manager/start-scheduled', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    getGoogleSheetsSyncManager().startScheduledSync();
    res.json({
      success: true,
      message: 'Scheduled sync started (runs every 15 minutes)'
    });

  } catch (error: any) {
    console.error('Error starting scheduled sync:', error);
    res.status(500).json({
      success: false,
      message: `Failed to start scheduled sync: ${error.message}`
    });
  }
});

// POST /clients/sync-manager/stop-scheduled - Stop scheduled sync
router.post('/sync-manager/stop-scheduled', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    getGoogleSheetsSyncManager().stopScheduledSync();
    res.json({
      success: true,
      message: 'Scheduled sync stopped'
    });

  } catch (error: any) {
    console.error('Error stopping scheduled sync:', error);
    res.status(500).json({
      success: false,
      message: `Failed to stop scheduled sync: ${error.message}`
    });
  }
});

// POST /clients/sync-manager/start-polling - Start polling sync
router.post('/sync-manager/start-polling', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { interval_minutes = 15 } = req.body;
    getGoogleSheetsSyncManager().startPolling(interval_minutes);

    res.json({
      success: true,
      message: `Polling sync started (checks every ${interval_minutes} minutes)`
    });

  } catch (error: any) {
    console.error('Error starting polling sync:', error);
    res.status(500).json({
      success: false,
      message: `Failed to start polling sync: ${error.message}`
    });
  }
});

// POST /clients/sync-manager/stop-polling - Stop polling sync
router.post('/sync-manager/stop-polling', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    getGoogleSheetsSyncManager().stopPolling();
    res.json({
      success: true,
      message: 'Polling sync stopped'
    });

  } catch (error: any) {
    console.error('Error stopping polling sync:', error);
    res.status(500).json({
      success: false,
      message: `Failed to stop polling sync: ${error.message}`
    });
  }
});

// GET /clients/sync-manager/status - Get sync status
router.get('/sync-manager/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const status = getGoogleSheetsSyncManager().getSyncStatus();
    res.json({
      success: true,
      status
    });

  } catch (error: any) {
    console.error('Error getting sync status:', error);
    res.status(500).json({
      success: false,
      message: `Failed to get sync status: ${error.message}`
    });
  }
});

// Helper function to write clients data to Google Sheets
async function writeClientsToGoogleSheets(sheetUrl: string | { url: string }, clients: any[]): Promise<boolean> {
  try {
    const { google } = require('googleapis');
    
    // Handle both string and object formats for sheetUrl
    const actualSheetUrl = typeof sheetUrl === 'string' ? sheetUrl : sheetUrl.url;
    console.log('sheeturl', actualSheetUrl);

    // Extract sheet ID from URL
    const sheetIdMatch = actualSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      throw new Error('Invalid Google Sheets URL format');
    }
    
    const spreadsheetId = sheetIdMatch[1];
    
    // Initialize Google Sheets API with service account
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID || 'msaber-project',
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID
      } as any,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Prepare data for Google Sheets
    const headers = [
      'ID', 'Full Name', 'Brand', 'Platform', 'Email', 'Phone Number', 'Company Name',
      'Instagram URL', 'Role', 'Client Type', 'VAT Number', 'Tags', 'Billing Country',
      'Billing City', 'Identity Cert', 'Title', 'Salutation', 'Birth Date',
      'Preferred Language', 'Time Zone', 'Has No Email', 'VAT Applicable',
      'Secondary Email', 'Secondary Phone Number', 'Default VAT Scheme', 'Default LDL',
      'Default Consignment Charges', 'Billing Address1', 'Billing Address2',
      'Billing Address3', 'Billing Post Code', 'Billing Region', 'Bank Account Details', 'Bank Address', 'Buyer Premium', 'Vendor Premium', 'Shipping Same As Billing',
      'Shipping Address1', 'Shipping Address2', 'Shipping Address3', 'Shipping City',
      'Shipping Post Code', 'Shipping Country', 'Shipping Region', 'Paddle No',
      // Bidder Analytics fields
      'Card on File', 'Auctions Attended', 'Bids Placed', 'Items Won',
      'Tax Exemption', 'Payment Rate %', 'Avg Hammer Price Low', 'Avg Hammer Price High',
      'Disputes Open', 'Disputes Closed', 'Bidder Notes'
    ];

    const data = [
      headers,
      ...clients.map(client => {
        const fullName = `${client.first_name || ''} ${client.last_name || ''}`.trim();
        const brandName = (client as any).brands?.name || '';
        const phone = sanitizePhoneNumber(client.phone_number) || '';
        const secondaryPhone = sanitizePhoneNumber((client as any).secondary_phone_number) || '';
        
        return [
          client.id || '',
          fullName,
          brandName,
          client.platform || '',
          client.email || '',
          phone,
          client.company_name || '',
          client.instagram_url || '',
          client.role || '',
          client.client_type || '',
          client.vat_number || '',
          client.tags || '',
          client.billing_country || '',
          client.billing_city || '',
          client.identity_cert || '',
          client.title || '',
          client.salutation || '',
          client.birth_date || '',
          client.preferred_language || '',
          client.time_zone || '',
          client.has_no_email ? 'Yes' : 'No',
          client.vat_applicable ? 'Yes' : 'No',
          client.secondary_email || '',
          secondaryPhone,
          client.default_vat_scheme || '',
          client.default_ldl || '',
          client.default_consignment_charges || '',
          client.billing_address1 || '',
          client.billing_address2 || '',
          client.billing_address3 || '',
          client.billing_post_code || '',
          client.billing_region || '',
          client.bank_account_details || '',
          client.bank_address || '',
          client.buyer_premium || '',
          client.vendor_premium || '',
          client.shipping_same_as_billing ? 'Yes' : 'No',
          client.shipping_address1 || '',
          client.shipping_address2 || '',
          client.shipping_address3 || '',
          client.shipping_city || '',
          client.shipping_post_code || '',
          client.shipping_country || '',
          client.shipping_region || '',
          client.paddle_no || '',
          // Bidder Analytics fields
          client.card_on_file ? 'Yes' : 'No',
          client.auctions_attended || 0,
          client.bids_placed || 0,
          client.items_won || 0,
          client.tax_exemption ? 'Yes' : 'No',
          client.payment_rate || 0,
          client.avg_hammer_price_low || 0,
          client.avg_hammer_price_high || 0,
          client.disputes_open || 0,
          client.disputes_closed || 0,
          client.bidder_notes || ''
        ];
      })
    ];

    // Clear existing data first
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Sheet1',
    });

    // Write new data
    const result = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: data,
      },
    });

    console.log('Successfully wrote clients to Google Sheets:', result.data.updatedCells);
    return true;

  } catch (error: any) {
    console.error('Error writing clients to Google Sheets:', error.message);
    return false;
  }
}

// Function to auto-sync a single client to Google Sheets (only updates that specific row)
async function autoSyncSingleClientToGoogleSheets(clientId: number): Promise<boolean> {
  try {
    console.log(`🔄 AUTO-SYNC: Starting single client sync for client ID ${clientId}`);

    const { google } = require('googleapis');

    // Get Google Sheets URL from app settings
    const { data: settingData } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'google_sheet_url_clients')
      .single();

    if (!settingData?.value) {
      console.log('❌ AUTO-SYNC: No Google Sheets URL configured for clients auto-sync');
      return false;
    }

    // Get the client data
    const { data: client, error } = await supabaseAdmin
      .from('clients')
      .select('*, brands (name, code)')
      .eq('id', clientId)
      .single();

    if (error || !client) {
      console.error('❌ AUTO-SYNC: Error fetching client for auto-sync:', error);
      return false;
    }

    console.log(`📊 AUTO-SYNC: Processing client ${client.first_name} ${client.last_name} (ID: ${clientId})`);

    // Extract URL from setting value (could be string or object with url property)
    let actualSheetUrl = '';
    if (typeof settingData.value === 'string') {
      try {
        const parsed = JSON.parse(settingData.value);
        actualSheetUrl = typeof parsed === 'object' && parsed !== null ? parsed.url : parsed;
      } catch {
        actualSheetUrl = settingData.value;
      }
    } else if (typeof settingData.value === 'object' && settingData.value !== null) {
      actualSheetUrl = settingData.value.url || '';
    } else {
      actualSheetUrl = settingData.value || '';
    }

    if (!actualSheetUrl || actualSheetUrl.trim() === '') {
      console.log('❌ AUTO-SYNC: Google Sheets URL is empty or invalid');
      return false;
    }

    const sheetIdMatch = actualSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      console.log('❌ AUTO-SYNC: Invalid Google Sheets URL format:', actualSheetUrl);
      return false;
    }

    const spreadsheetId = sheetIdMatch[1];

    // Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID || 'msaber-project',
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID
      } as any,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // First, get only column A (IDs) to efficiently find the target row
    const idResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A:A',
    });

    const idColumn = idResponse.data.values || [];
    if (idColumn.length < 1) {
      console.log('Sheet is empty, will add header and first client');
    }

    // Find the row index for this client (ID is in column A, index 0)
    let targetRowIndex = -1;
    let lastPopulatedRow = 0;

    console.log(`🔍 AUTO-SYNC: Scanning ${idColumn.length - 1} rows for client ID ${clientId}`);

    for (let i = 1; i < idColumn.length; i++) { // Start from row 1 (skip header)
      if (idColumn[i] && idColumn[i][0]) {
        lastPopulatedRow = i;
        if (parseInt(idColumn[i][0]) === clientId) {
          targetRowIndex = i;
          break;
        }
      }
    }

    console.log(`🎯 AUTO-SYNC: ${targetRowIndex >= 0 ? 'Found existing client at row ' + (targetRowIndex + 1) : 'Client not found, will add as new row after row ' + (lastPopulatedRow + 1)}`);

    // Prepare the updated row data for this client
    const fullName = `${client.first_name || ''} ${client.last_name || ''}`.trim();
    const brandName = (client as any).brands?.name || '';
    const phone = sanitizePhoneNumber(client.phone_number) || '';
    const secondaryPhone = sanitizePhoneNumber((client as any).secondary_phone_number) || '';

    const updatedRow = [
      client.id || '',
      fullName,
      brandName,
      client.platform || '',
      client.email || '',
      phone,
      client.company_name || '',
      client.instagram_url || '',
      client.role || '',
      client.client_type || '',
      client.vat_number || '',
      client.tags || '',
      client.billing_country || '',
      client.billing_city || '',
      client.identity_cert || '',
      client.title || '',
      client.salutation || '',
      client.birth_date || '',
      client.preferred_language || '',
      client.time_zone || '',
      client.has_no_email ? 'Yes' : 'No',
      client.vat_applicable ? 'Yes' : 'No',
      client.secondary_email || '',
      secondaryPhone,
      client.default_vat_scheme || '',
      client.default_ldl || '',
      client.default_consignment_charges || '',
      client.billing_address1 || '',
      client.billing_address2 || '',
      client.billing_address3 || '',
      client.billing_post_code || '',
      client.billing_region || '',
      client.bank_account_details || '',
      client.bank_address || '',
      client.buyer_premium || '',
      client.vendor_premium || '',
      client.shipping_same_as_billing ? 'Yes' : 'No',
      client.shipping_address1 || '',
      client.shipping_address2 || '',
      client.shipping_address3 || '',
      client.shipping_city || '',
      client.shipping_post_code || '',
      client.shipping_country || '',
      client.shipping_region || '',
      client.paddle_no || '',
      // Bidder Analytics fields
      client.card_on_file ? 'Yes' : 'No',
      client.auctions_attended || 0,
      client.bids_placed || 0,
      client.items_won || 0,
      client.tax_exemption ? 'Yes' : 'No',
      client.payment_rate || 0,
      client.avg_hammer_price_low || 0,
      client.avg_hammer_price_high || 0,
      client.disputes_open || 0,
      client.disputes_closed || 0,
      client.bidder_notes || ''
    ];

    // Function to convert column number to Excel column letter
    const getColumnLetter = (columnNumber: number): string => {
      let columnLetter = '';
      while (columnNumber > 0) {
        columnNumber--;
        columnLetter = String.fromCharCode(65 + (columnNumber % 26)) + columnLetter;
        columnNumber = Math.floor(columnNumber / 26);
      }
      return columnLetter;
    };

    if (targetRowIndex >= 0) {
      // Update existing row directly
      const lastColumnLetter = getColumnLetter(updatedRow.length);
      const range = `Sheet1!A${targetRowIndex + 1}:${lastColumnLetter}${targetRowIndex + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [updatedRow],
        },
      });
      console.log(`✅ AUTO-SYNC: Successfully updated existing client ${clientId} in Google Sheets (row ${targetRowIndex + 1})`);
    } else {
      // Client not found in sheet, add to next row after last populated row
      const nextRowIndex = lastPopulatedRow + 1;

      // If this is the very first data row (no header exists), add header first
      if (idColumn.length === 0) {
        console.log(`📝 AUTO-SYNC: Sheet is empty, adding headers and client ${clientId} as first data row`);

        const headers = [
          'ID', 'Full Name', 'Brand', 'Platform', 'Email', 'Phone Number', 'Company Name',
          'Instagram URL', 'Role', 'Client Type', 'VAT Number', 'Tags', 'Billing Country',
          'Billing City', 'Identity Cert', 'Title', 'Salutation', 'Birth Date',
          'Preferred Language', 'Time Zone', 'Has No Email', 'VAT Applicable',
          'Secondary Email', 'Secondary Phone Number', 'Default VAT Scheme', 'Default LDL',
          'Default Consignment Charges', 'Billing Address1', 'Billing Address2',
          'Billing Address3', 'Billing Post Code', 'Billing Region', 'Bank Account Details', 'Bank Address', 'Buyer Premium', 'Vendor Premium', 'Shipping Same As Billing',
          'Shipping Address1', 'Shipping Address2', 'Shipping Address3', 'Shipping City',
          'Shipping Post Code', 'Shipping Country', 'Shipping Region', 'Paddle No',
          // Bidder Analytics fields
          'Card on File', 'Auctions Attended', 'Bids Placed', 'Items Won',
          'Tax Exemption', 'Payment Rate %', 'Avg Hammer Price Low', 'Avg Hammer Price High',
          'Disputes Open', 'Disputes Closed', 'Bidder Notes'
        ];

        // Add header row first
        const headerLastColumnLetter = getColumnLetter(headers.length);
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Sheet1!A1:${headerLastColumnLetter}1`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [headers],
          },
        });

        // Add client data in row 2
        const dataLastColumnLetter = getColumnLetter(updatedRow.length);
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `Sheet1!A2:${dataLastColumnLetter}2`,
          valueInputOption: 'RAW',
          requestBody: {
            values: [updatedRow],
          },
        });
        console.log(`✅ AUTO-SYNC: Successfully added new client ${clientId} to Google Sheets (created headers + added as row 2)`);
      } else {
        // Add client data to next available row
        const appendLastColumnLetter = getColumnLetter(updatedRow.length);
        const range = `Sheet1!A${nextRowIndex + 1}:${appendLastColumnLetter}${nextRowIndex + 1}`;
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: {
            values: [updatedRow],
          },
        });
        console.log(`✅ AUTO-SYNC: Successfully added new client ${clientId} to Google Sheets (added to row ${nextRowIndex + 1})`);
      }
    }

    console.log(`🎉 AUTO-SYNC: Completed processing 1 client (ID: ${clientId}). No batch processing involved.`);
    return true;

  } catch (error) {
    console.error(`❌ AUTO-SYNC: Failed to sync client ${clientId} to Google Sheets:`, error);
    return false;
  }
}

// Enhanced Google Sheets Sync Manager
class GoogleSheetsSyncManager {
  private isPolling = false;
  private lastSyncTimestamps = new Map<string, Date>();
  private syncInProgress = new Set<string>();
  private cronJob: any = null;

  constructor() {
    this.initializeScheduledSync();
  }

  // Initialize scheduled sync jobs
  private initializeScheduledSync() {
    try {
      const cron = require('node-cron');

      // Run every 15 minutes as requested
      this.cronJob = cron.schedule('*/15 * * * *', async () => {
        console.log('⏰ SCHEDULED SYNC: Starting 15-minute interval sync');
        await this.performScheduledSync();
      }, {
        scheduled: false // Don't start automatically
      });

      console.log('✅ Cron job initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize cron job:', error);
      // Set to null so other methods can handle gracefully
      this.cronJob = null as any;
    }
  }

  // Start scheduled sync
  startScheduledSync() {
    if (this.cronJob) {
      this.cronJob.start();
      console.log('✅ SCHEDULED SYNC: Started 15-minute interval sync');
    } else {
      console.log('⚠️ SCHEDULED SYNC: Cron job not available');
    }
  }

  // Stop scheduled sync
  stopScheduledSync() {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log('⏹️ SCHEDULED SYNC: Stopped 15-minute interval sync');
    } else {
      console.log('⚠️ SCHEDULED SYNC: Cron job not available');
    }
  }

  // Get sync status
  getSyncStatus() {
    return {
      pollingActive: this.isPolling,
      scheduledActive: this.cronJob ? !this.cronJob.destroyed : false,
      lastSyncTimestamps: Object.fromEntries(this.lastSyncTimestamps),
      syncInProgress: Array.from(this.syncInProgress),
      cronAvailable: !!this.cronJob
    };
  }

  // Perform scheduled sync
  private async performScheduledSync() {
    const configKey = 'google_sheet_url_clients';
    try {
      if (this.syncInProgress.has(configKey)) {
        console.log('⚠️ SCHEDULED SYNC: Sync already in progress, skipping');
        return;
      }

      this.syncInProgress.add(configKey);
      console.log('🔄 SCHEDULED SYNC: Checking for Google Sheets changes');

      const changes = await this.pollGoogleSheetsForChanges();
      if (changes && changes.length > 0) {
        console.log(`📊 SCHEDULED SYNC: Found ${changes.length} changes, processing...`);
        await this.processGoogleSheetsChanges(changes);
        this.lastSyncTimestamps.set(configKey, new Date());
      } else {
        console.log('📊 SCHEDULED SYNC: No changes detected');
      }
    } catch (error: any) {
      console.error('❌ SCHEDULED SYNC: Error during sync:', error);
    } finally {
      this.syncInProgress.delete(configKey);
    }
  }

  // Poll Google Sheets for changes
  private async pollGoogleSheetsForChanges(): Promise<any[] | null> {
    try {
      const { google } = require('googleapis');

      // Get Google Sheets URL from app settings
      const { data: settingData } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', 'google_sheet_url_clients')
        .single();

      if (!settingData?.value) {
        console.log('❌ POLLING: No Google Sheets URL configured');
        return null;
      }

      // Extract URL
      let actualSheetUrl = '';
      if (typeof settingData.value === 'string') {
        try {
          const parsed = JSON.parse(settingData.value);
          actualSheetUrl = typeof parsed === 'object' && parsed !== null ? parsed.url : parsed;
        } catch {
          actualSheetUrl = settingData.value;
        }
      } else if (typeof settingData.value === 'object' && settingData.value !== null) {
        actualSheetUrl = settingData.value.url || '';
      }

      if (!actualSheetUrl) {
        console.log('❌ POLLING: Google Sheets URL is empty');
        return null;
      }

      // Extract spreadsheet ID
      const sheetIdMatch = actualSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!sheetIdMatch) {
        console.log('❌ POLLING: Invalid Google Sheets URL format');
        return null;
      }

      const spreadsheetId = sheetIdMatch[1];

      // Initialize Google Sheets API
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: 'service_account',
          project_id: process.env.GOOGLE_PROJECT_ID || 'msaber-project',
          private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
          client_id: process.env.GOOGLE_CLIENT_ID
        } as any,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });

      const sheets = google.sheets({ version: 'v4', auth });

      // Get the last modified timestamp from the last sync
      const lastSyncKey = `google_sheet_clients_last_modified`;
      const { data: lastModifiedData } = await supabaseAdmin
        .from('app_settings')
        .select('value')
        .eq('key', lastSyncKey)
        .single();

      // Get current sheet data
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: 'Sheet1',
      });

      const rows = response.data.values || [];
      if (rows.length < 2) {
        console.log('❌ POLLING: Sheet has no data rows');
        return null;
      }

      const headers = rows[0].map((h: any) => String(h).toLowerCase().trim());
      const dataRows = rows.slice(1);

      // Process rows and detect changes
      const changes: any[] = [];
      for (let i = 0; i < dataRows.length; i++) {
        const values = dataRows[i];
        if (!values || values.length === 0) continue;

        const obj: Record<string, any> = {};
        headers.forEach((header: string, index: number) => {
          obj[header] = values[index] || '';
        });

        // Skip empty rows
        if (!obj.first_name && !obj.last_name && !obj['full name'] && !obj.email) continue;

        // Check if this row has been modified since last sync
        const rowLastModified = new Date(); // In a real implementation, you'd get this from sheet metadata

        changes.push({
          rowIndex: i + 2, // +2 because we skip header and 0-index
          record: obj,
          lastModified: rowLastModified,
          changeType: 'update'
        });
      }

      // Store the current timestamp as last sync time
      await supabaseAdmin
        .from('app_settings')
        .upsert({
          key: lastSyncKey,
          value: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

      return changes;

    } catch (error) {
      console.error('❌ POLLING: Error polling Google Sheets:', error);
      return null;
    }
  }

  // Process Google Sheets changes
  private async processGoogleSheetsChanges(changes: any[]) {
    try {
      console.log(`🔄 PROCESSING: Processing ${changes.length} Google Sheets changes`);

      for (const change of changes) {
        try {
          const transformedRecord = this.transformGoogleSheetsRecord(change.record);

          // Find matching client or create new one
          const matchResult = await findMatchingClient(transformedRecord);

          if (matchResult.shouldUpdate && matchResult.clientId) {
            console.log(`🔄 POLLING: Updating existing client ID ${matchResult.clientId}`);

            const { error } = await supabaseAdmin
              .from('clients')
              .update(transformedRecord)
              .eq('id', matchResult.clientId);

            if (error) {
              console.error(`❌ POLLING: Error updating client ${matchResult.clientId}:`, error);
            } else {
              console.log(`✅ POLLING: Successfully updated client ${matchResult.clientId}`);
            }
          } else {
            console.log(`➕ POLLING: Creating new client from Google Sheets`);

            const { data: newClient, error } = await supabaseAdmin
              .from('clients')
              .insert([transformedRecord])
              .select()
              .single();

            if (error) {
              console.error('❌ POLLING: Error creating new client:', error);
            } else {
              console.log(`✅ POLLING: Successfully created new client ID ${newClient?.id}`);
            }
          }
        } catch (error: any) {
          console.error('❌ POLLING: Error processing change:', error);
        }
      }

      console.log(`✅ POLLING: Completed processing ${changes.length} changes`);
    } catch (error: any) {
      console.error('❌ POLLING: Error processing changes:', error);
    }
  }

  // Transform Google Sheets record to match database schema
  private transformGoogleSheetsRecord(record: Record<string, any>): Record<string, any> {
    // Support full_name split
    let firstName = record['first_name'] || '';
    let lastName = record['last_name'] || '';

    if (record['full name'] && !firstName && !lastName) {
      const parts = String(record['full name']).trim().split(/\s+/).filter(Boolean);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    // Transform to match database schema
    const transformed: any = {
      first_name: firstName,
      last_name: lastName,
      email: record.email || null,
      phone_number: sanitizePhoneNumber(record.phone_number || record['phone number']),
      company_name: record.company_name || record['company name'] || null,
      platform: this.normalizePlatform(record.platform || record['Platform'] || 'Private'),
      client_type: this.normalizeClientType(record.client_type || record['client type'] || 'buyer'),
      status: record.status || record['Status'] || 'active',
      role: record.role || record['Role'] || 'BUYER',
      preferred_language: record.preferred_language || record['preferred language'] || 'English',
      time_zone: record.time_zone || record['time zone'] || 'UTC',
      shipping_same_as_billing: this.parseBoolean(record.shipping_same_as_billing || record['shipping same as billing']),

      // Address fields
      billing_address1: record.billing_address1 || record['billing address1'] || null,
      billing_city: record.billing_city || record['billing city'] || null,
      billing_post_code: record.billing_post_code || record['billing post code'] || null,
      billing_country: record.billing_country || record['billing country'] || null,

      // Financial fields
      buyer_premium: this.parseFloat(record.buyer_premium || record['buyer premium']),
      vendor_premium: this.parseFloat(record.vendor_premium || record['vendor premium']),

      // Analytics fields
      card_on_file: this.parseBoolean(record.card_on_file || record['card on file']),
      auctions_attended: this.parseInt(record.auctions_attended || record['auctions attended']),
      bids_placed: this.parseInt(record.bids_placed || record['bids placed']),
      items_won: this.parseInt(record.items_won || record['items won']),
      bidder_notes: record.bidder_notes || record['bidder notes'] || null,
    };

    // Handle ID if provided
    if (record.id) {
      const id = parseInt(record.id);
      if (!isNaN(id)) {
        transformed.id = id;
      }
    }

    return transformed;
  }

  // Helper methods for data transformation
  private normalizeClientType(type: any): 'buyer' | 'vendor' | 'supplier' | 'buyer_vendor' {
    if (!type) return 'buyer';
    const normalized = String(type).toLowerCase();
    if (['buyer', 'vendor', 'supplier', 'buyer_vendor'].includes(normalized)) {
      return normalized as any;
    }
    return 'buyer';
  }

  private normalizePlatform(platform: any): string {
    if (!platform) return 'Private';
    const normalized = String(platform).toLowerCase();
    const platformMap: Record<string, string> = {
      'liveauctioneer': 'Liveauctioneer',
      'the saleroom': 'The saleroom',
      'invaluable': 'Invaluable',
      'easylive auctions': 'Easylive auctions',
      'private': 'Private',
      'others': 'Others'
    };
    return platformMap[normalized] || 'Private';
  }

  private parseBoolean(value: any): boolean {
    if (typeof value === 'boolean') return value;
    const str = String(value).toLowerCase();
    return str === 'true' || str === 'yes' || str === '1';
  }

  private parseFloat(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  private parseInt(value: any): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = parseInt(value);
    return isNaN(parsed) ? null : parsed;
  }

  // Manual trigger for sync
  async triggerManualSync(): Promise<{ success: boolean; message: string; changesProcessed?: number }> {
    try {
      console.log('🔄 MANUAL SYNC: Starting manual Google Sheets sync');

      const changes = await this.pollGoogleSheetsForChanges();
      if (changes && changes.length > 0) {
        await this.processGoogleSheetsChanges(changes);
        console.log(`✅ MANUAL SYNC: Successfully processed ${changes.length} changes`);
        return {
          success: true,
          message: `Successfully synced ${changes.length} changes from Google Sheets`,
          changesProcessed: changes.length
        };
      } else {
        console.log('📊 MANUAL SYNC: No changes detected');
        return {
          success: true,
          message: 'No changes detected in Google Sheets'
        };
      }
    } catch (error) {
      console.error('❌ MANUAL SYNC: Error during manual sync:', error);
      return {
        success: false,
        message: `Manual sync failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // Start polling mode
  startPolling(intervalMinutes: number = 15) {
    if (this.isPolling) {
      console.log('⚠️ POLLING: Already polling, stopping first');
      this.stopPolling();
    }

    this.isPolling = true;
    console.log(`✅ POLLING: Started polling every ${intervalMinutes} minutes`);

    const poll = async () => {
      if (!this.isPolling) return;

      await this.performScheduledSync();

      // Schedule next poll
      setTimeout(poll, intervalMinutes * 60 * 1000);
    };

    // Start first poll immediately
    setTimeout(poll, 1000);
  }

  // Stop polling mode
  stopPolling() {
    this.isPolling = false;
    console.log('⏹️ POLLING: Stopped polling');
  }
}

// Create singleton instance with error handling
let googleSheetsSyncManager: GoogleSheetsSyncManager | null = null;

function getGoogleSheetsSyncManager(): GoogleSheetsSyncManager {
  if (!googleSheetsSyncManager) {
    try {
      googleSheetsSyncManager = new GoogleSheetsSyncManager();
      console.log('✅ GoogleSheetsSyncManager initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize GoogleSheetsSyncManager:', error);
      // Return a mock instance that returns safe defaults
      const mockInstance = {
        getSyncStatus: () => ({
          pollingActive: false,
          scheduledActive: false,
          lastSyncTimestamps: {},
          syncInProgress: [],
          cronAvailable: false
        }),
        triggerManualSync: async () => ({
          success: false,
          message: 'Sync manager not available due to initialization error'
        }),
        startScheduledSync: () => console.log('Scheduled sync not available'),
        stopScheduledSync: () => console.log('Scheduled sync not available'),
        startPolling: () => console.log('Polling sync not available'),
        stopPolling: () => console.log('Polling sync not available')
      } as unknown as GoogleSheetsSyncManager;
      googleSheetsSyncManager = mockInstance;
    }
  }
  return googleSheetsSyncManager as GoogleSheetsSyncManager;
}

// Function to auto-sync client to Google Sheets after create/update
async function autoSyncClientToGoogleSheets(clientId: number) {
  console.log(`🚀 AUTO-SYNC: Initiating single client sync for ID ${clientId}`);
  const success = await autoSyncSingleClientToGoogleSheets(clientId);
  if (!success) {
    console.error(`❌ AUTO-SYNC: Wrapper function failed for client ${clientId}`);
  } else {
    console.log(`✅ AUTO-SYNC: Wrapper function completed successfully for client ${clientId}`);
  }
}

export default router; 