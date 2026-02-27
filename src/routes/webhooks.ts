// backend/src/routes/webhooks.ts
import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import {
  verifyWebhookSignature,
  createWebhookVerificationMiddleware,
  createWebhookRateLimit,
  logWebhookRequest,
  validateWebhookPayload
} from '../utils/webhook-security';

const router = express.Router();

// Interface for Google Sheets webhook payload
interface GoogleSheetsWebhookPayload {
  sheetName: string;
  record: Record<string, any>;
  rowNumber: number;
  changeType: 'update' | 'sync' | 'delete';
  timestamp: string;
}

// Create middleware instances
const webhookVerification = createWebhookVerificationMiddleware();
const webhookRateLimit = createWebhookRateLimit(60000, 100); // 100 requests per minute

// Reusable webhook processor interface
interface WebhookProcessor {
  processRecord: (payload: GoogleSheetsWebhookPayload) => Promise<void>;
  validateRecord: (record: Record<string, any>) => { isValid: boolean; errors: string[] };
  transformRecord: (record: Record<string, any>) => Record<string, any>;
}

// Client-specific webhook processor
class ClientWebhookProcessor implements WebhookProcessor {
  async processRecord(payload: GoogleSheetsWebhookPayload): Promise<void> {
    const { record, changeType } = payload;

    // Transform record for client processing
    const transformedRecord = this.transformRecord(record);

    try {
      if (changeType === 'delete' || !transformedRecord.first_name || !transformedRecord.last_name) {
        // Handle deletion or invalid records
        if (transformedRecord.id) {
          await supabaseAdmin
            .from('clients')
            .update({ status: 'deleted' })
            .eq('id', transformedRecord.id);
        }
        return;
      }

      // Upsert the client record
      const { data, error } = await supabaseAdmin
        .from('clients')
        .upsert(transformedRecord, {
          onConflict: 'id',
          ignoreDuplicates: false
        })
        .select()
        .single();

      if (error) {
        console.error('Error upserting client:', error);
        throw error;
      }

      console.log(`Successfully processed client ${data?.id || 'new'}`);
    } catch (error) {
      console.error('Error processing client record:', error);
      throw error;
    }
  }

  validateRecord(record: Record<string, any>): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Required fields validation
    if (!record['Full Name'] && !record['first_name']) {
      errors.push('Full Name or first_name is required');
    }

    // Email validation
    if (record['email'] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record['email'])) {
      errors.push('Invalid email format');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  transformRecord(record: Record<string, any>): Record<string, any> {
    // Handle full name splitting
    let firstName = record['first_name'] || '';
    let lastName = record['last_name'] || '';

    if (record['Full Name'] && !firstName && !lastName) {
      const parts = String(record['Full Name']).trim().split(/\s+/).filter(Boolean);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    // Phone number sanitization
    const sanitizePhone = (phone: any): string | null => {
      if (!phone) return null;
      const digits = String(phone).replace(/\D+/g, '');
      return digits.length > 0 ? digits : null;
    };

    // Transform the record to match database schema
    const transformed: any = {
      first_name: firstName,
      last_name: lastName,
      email: record['email'] || null,
      phone_number: sanitizePhone(record['phone_number'] || record['Phone Number']),
      company_name: record['company_name'] || record['Company Name'] || null,
      instagram_url: record['instagram_url'] || record['Instagram URL'] || null,
      vat_number: record['vat_number'] || record['VAT Number'] || null,
      tags: record['tags'] || record['Tags'] || null,
      client_type: this.normalizeClientType(record['client_type'] || record['Client Type'] || 'buyer'),
      status: record['status'] || record['Status'] || 'active',
      role: record['role'] || record['Role'] || 'BUYER',
      preferred_language: record['preferred_language'] || record['Preferred Language'] || 'English',
      time_zone: record['time_zone'] || record['Time Zone'] || 'UTC',
      shipping_same_as_billing: this.parseBoolean(record['shipping_same_as_billing'] || record['Shipping Same As Billing']),
      identity_cert: record['identity_cert'] || record['Identity Cert'] || 'Uncertified',

      // Address fields
      billing_address1: record['billing_address1'] || record['Billing Address1'] || null,
      billing_address2: record['billing_address2'] || record['Billing Address2'] || null,
      billing_city: record['billing_city'] || record['Billing City'] || null,
      billing_post_code: record['billing_post_code'] || record['Billing Post Code'] || null,
      billing_country: record['billing_country'] || record['Billing Country'] || null,
      billing_region: record['billing_region'] || record['Billing Region'] || null,

      // Platform and brand
      platform: this.normalizePlatform(record['platform'] || record['Platform'] || 'Private'),
      paddle_no: record['paddle_no'] || record['Paddle No'] || null,

      // Financial fields
      buyer_premium: this.parseFloat(record['buyer_premium'] || record['Buyer Premium']),
      vendor_premium: this.parseFloat(record['vendor_premium'] || record['Vendor Premium']),

      // Analytics fields
      card_on_file: this.parseBoolean(record['card_on_file'] || record['Card on File']),
      auctions_attended: this.parseInt(record['auctions_attended'] || record['Auctions Attended']),
      bids_placed: this.parseInt(record['bids_placed'] || record['Bids Placed']),
      items_won: this.parseInt(record['items_won'] || record['Items Won']),
      tax_exemption: this.parseBoolean(record['tax_exemption'] || record['Tax Exemption']),
      payment_rate: this.parseFloat(record['payment_rate'] || record['Payment Rate %']),
      avg_hammer_price_low: this.parseFloat(record['avg_hammer_price_low'] || record['Avg Hammer Price Low']),
      avg_hammer_price_high: this.parseFloat(record['avg_hammer_price_high'] || record['Avg Hammer Price High']),
      disputes_open: this.parseInt(record['disputes_open'] || record['Disputes Open']),
      disputes_closed: this.parseInt(record['disputes_closed'] || record['Disputes Closed']),
      bidder_notes: record['bidder_notes'] || record['Bidder Notes'] || null,
    };

    // Handle ID if provided
    if (record['id'] || record['ID']) {
      const id = parseInt(record['id'] || record['ID']);
      if (!isNaN(id)) {
        transformed.id = id;
      }
    }

    // Handle brand resolution
    if (record['brand'] || record['Brand']) {
      // This will be resolved later in the processing
      transformed._raw_brand = record['brand'] || record['Brand'];
    }

    return transformed;
  }

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
}

// Registry of webhook processors
const webhookProcessors: Record<string, WebhookProcessor> = {
  'clients': new ClientWebhookProcessor(),
  'sheet1': new ClientWebhookProcessor(), // Alias for clients
};

// Main webhook endpoint with enhanced security
router.post('/google-sheets',
  webhookRateLimit,
  webhookVerification,
  async (req: Request, res: Response) => {
    let processingResult: { success: boolean; error?: string } = { success: false };

    try {
      const payload: GoogleSheetsWebhookPayload = req.body;

      // Validate payload structure using security utility
      const payloadValidation = validateWebhookPayload(payload);
      if (!payloadValidation.isValid) {
        processingResult = {
          success: false,
          error: `Invalid payload: ${payloadValidation.errors.join(', ')}`
        };
        logWebhookRequest(req, processingResult);
        return res.status(400).json({
          error: 'Invalid payload structure',
          details: payloadValidation.errors
        });
      }

      // Get the appropriate processor
      const processor = webhookProcessors[payload.sheetName.toLowerCase()];
      if (!processor) {
        processingResult = {
          success: false,
          error: `No processor found for sheet: ${payload.sheetName}`
        };
        logWebhookRequest(req, processingResult);
        return res.status(400).json({
          error: `No processor found for sheet: ${payload.sheetName}`
        });
      }

      // Validate the record using processor
      const recordValidation = processor.validateRecord(payload.record);
      if (!recordValidation.isValid) {
        console.warn('Record validation failed:', recordValidation.errors);
        // Log warning but continue processing
      }

      // Process the record
      await processor.processRecord(payload);

      processingResult = {
        success: true,
        error: recordValidation.errors.length > 0 ? recordValidation.errors.join(', ') : undefined
      };

      // Log successful processing
      logWebhookRequest(req, processingResult);

      res.json({
        success: true,
        message: 'Webhook processed successfully',
        processed: {
          sheet: payload.sheetName,
          changeType: payload.changeType,
          timestamp: payload.timestamp,
          rowNumber: payload.rowNumber,
          warnings: recordValidation.errors.length > 0 ? recordValidation.errors : undefined
        }
      });

    } catch (error: any) {
      processingResult = {
        success: false,
        error: error.message
      };

      console.error('Error processing webhook:', error);
      logWebhookRequest(req, processingResult);

      res.status(500).json({
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : 'Webhook processing failed'
      });
    }
  }
);

// Health check endpoint
router.get('/google-sheets/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    processors: Object.keys(webhookProcessors),
    debug: {
      envVarPresent: !!process.env.GOOGLE_SHEETS_WEBHOOK_SECRET,
      usingFallback: !process.env.GOOGLE_SHEETS_WEBHOOK_SECRET
    }
  });
});

// Debug endpoint for signature testing
router.post('/google-sheets/debug', (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const payloadString = JSON.stringify(payload);

    console.log('🔧 Debug endpoint called with payload:', payloadString);

    // Use the same method as the main webhook endpoint
    const { verifyWebhookSignature } = require('../utils/webhook-security');

    // Generate signature by testing against empty signature (this will show us what signature is expected)
    const testVerification = verifyWebhookSignature(payloadString, '', undefined);
    console.log('Debug test verification:', testVerification);

    // The expected signature is what would make verification pass
    // We'll create it using the same logic as verifyWebhookSignature
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', process.env.GOOGLE_SHEETS_WEBHOOK_SECRET || '7a1a539bdb88ec2ddc0e8eea20b927ddeff65569fb38cd191274ad45ed34c72b')
      .update(payloadString)
      .digest('hex');

    res.json({
      success: true,
      debug: {
        payload: payloadString,
        expectedSignature,
        timestamp: new Date().toISOString(),
        usingEnvVar: !!process.env.GOOGLE_SHEETS_WEBHOOK_SECRET
      }
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Debug endpoint failed',
      details: error.message
    });
  }
});

// Function to register new webhook processors (for extensibility)
export const registerWebhookProcessor = (sheetName: string, processor: WebhookProcessor) => {
  webhookProcessors[sheetName.toLowerCase()] = processor;
};

export default router;
