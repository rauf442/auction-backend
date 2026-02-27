// backend/src/utils/google-sheets.ts
import { google } from 'googleapis';
import { supabaseAdmin } from './supabase';

// Google Sheets API configuration
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

interface GoogleSheetsConfig {
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

interface SheetData {
  spreadsheetId: string;
  range: string;
  data: any[][];
}

interface SyncResult {
  success: boolean;
  updated: number;
  errors: string[];
}

export class GoogleSheetsService {
  private sheets: any;
  private auth: any;

  constructor(config?: GoogleSheetsConfig) {
    if (config) {
      this.initializeWithConfig(config);
    } else {
      this.initializeWithEnv();
    }
  }

  private initializeWithConfig(config: GoogleSheetsConfig) {
    this.auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: config.projectId,
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: config.privateKey.replace(/\\n/g, '\n'),
        client_email: config.clientEmail,
        client_id: process.env.GOOGLE_CLIENT_ID
      },
      scopes: SCOPES,
    });

    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }

  private initializeWithEnv() {
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      throw new Error('Google Sheets credentials not found in environment variables');
    }

    this.auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        project_id: process.env.GOOGLE_PROJECT_ID || 'msaber-project',
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID
      },
      scopes: SCOPES,
    });

    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }

  /**
   * Extract spreadsheet ID from Google Sheets URL
   */
  static extractSpreadsheetId(url: string): string | null {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  }

  /**
   * Read data from a Google Sheet
   */
  async readSheet(spreadsheetId: string, range: string = 'Sheet1'): Promise<any[][]> {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      return response.data.values || [];
    } catch (error) {
      console.error('Error reading sheet:', error);
      throw error;
    }
  }

  /**
   * Write data to a Google Sheet
   */
  async writeSheet(spreadsheetId: string, range: string, data: any[][]): Promise<void> {
    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: {
          values: data,
        },
      });
    } catch (error) {
      console.error('Error writing to sheet:', error);
      throw error;
    }
  }

  /**
   * Clear data from a range in Google Sheet
   */
  async clearSheet(spreadsheetId: string, range: string = 'Sheet1'): Promise<void> {
    try {
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId,
        range,
      });
    } catch (error) {
      console.error('Error clearing sheet:', error);
      throw error;
    }
  }

  /**
   * Append data to a Google Sheet
   */
  async appendToSheet(spreadsheetId: string, range: string, data: any[][]): Promise<void> {
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: {
          values: data,
        },
      });
    } catch (error) {
      console.error('Error appending to sheet:', error);
      throw error;
    }
  }

  /**
   * Get sheet metadata
   */
  async getSheetMetadata(spreadsheetId: string): Promise<any> {
    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId,
      });
      return response.data;
    } catch (error) {
      console.error('Error getting sheet metadata:', error);
      throw error;
    }
  }

  /**
   * Create a new sheet within a spreadsheet
   */
  async createSheet(spreadsheetId: string, sheetName: string): Promise<void> {
    try {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: sheetName,
              },
            },
          }],
        },
      });
    } catch (error) {
      console.error('Error creating sheet:', error);
      throw error;
    }
  }
}

// Reusable data transformer interface
export interface DataTransformer<T> {
  transformForSheet: (record: T) => Record<string, any>;
  transformForDatabase: (rowData: Record<string, any>) => Partial<T>;
  getSheetHeaders: () => string[];
}

// Base class for sheet synchronization
export abstract class SheetSynchronizer<T> {
  protected sheetsService: GoogleSheetsService;
  protected transformer: DataTransformer<T>;

  constructor(transformer: DataTransformer<T>, config?: GoogleSheetsConfig) {
    this.sheetsService = new GoogleSheetsService(config);
    this.transformer = transformer;
  }

  /**
   * Sync from database to Google Sheets
   */
  async syncToSheets(spreadsheetId: string, tableName: string, sheetName: string = 'Sheet1'): Promise<SyncResult> {
    try {
      // Fetch data from database
      const { data, error } = await supabaseAdmin
        .from(tableName)
        .select('*')
        .order('id', { ascending: true });

      if (error) throw error;

      // Transform data for sheets
      const headers = this.transformer.getSheetHeaders();
      const rows = (data || []).map(record => {
        const transformed = this.transformer.transformForSheet(record);
        return headers.map(header => transformed[header] || '');
      });

      const sheetData = [headers, ...rows];

      // Clear and write to sheet
      await this.sheetsService.clearSheet(spreadsheetId, sheetName);
      await this.sheetsService.writeSheet(spreadsheetId, `${sheetName}!A1`, sheetData);

      return {
        success: true,
        updated: (data || []).length,
        errors: []
      };

    } catch (error: any) {
      console.error('Error syncing to sheets:', error);
      return {
        success: false,
        updated: 0,
        errors: [error.message]
      };
    }
  }

  /**
   * Sync from Google Sheets to database
   */
  async syncFromSheets(spreadsheetId: string, tableName: string, sheetName: string = 'Sheet1'): Promise<SyncResult> {
    try {
      // Read data from sheet
      const sheetData = await this.sheetsService.readSheet(spreadsheetId, sheetName);

      if (sheetData.length < 2) { // Need at least headers + one data row
        return {
          success: true,
          updated: 0,
          errors: []
        };
      }

      const headers = sheetData[0];
      const dataRows = sheetData.slice(1);
      let updatedCount = 0;
      const errors: string[] = [];

      // Process each row
      for (let i = 0; i < dataRows.length; i++) {
        try {
          const row = dataRows[i];
          if (row.every(cell => !cell)) continue; // Skip empty rows

          // Create object from headers and row data
          const rowData: Record<string, any> = {};
          headers.forEach((header, index) => {
            rowData[header] = row[index];
          });

          // Transform for database
          const transformed = this.transformer.transformForDatabase(rowData);

          // Upsert to database
          const { error } = await supabaseAdmin
            .from(tableName)
            .upsert(transformed, {
              onConflict: 'id',
              ignoreDuplicates: false
            });

          if (error) {
            errors.push(`Row ${i + 2}: ${error.message}`);
          } else {
            updatedCount++;
          }

        } catch (error: any) {
          errors.push(`Row ${i + 2}: ${error.message}`);
        }
      }

      return {
        success: errors.length === 0,
        updated: updatedCount,
        errors
      };

    } catch (error: any) {
      console.error('Error syncing from sheets:', error);
      return {
        success: false,
        updated: 0,
        errors: [error.message]
      };
    }
  }
}

// Client data transformer
export class ClientDataTransformer implements DataTransformer<any> {
  getSheetHeaders(): string[] {
    return [
      'ID', 'Full Name', 'Brand', 'Platform', 'Email', 'Phone Number', 'Company Name',
      'Instagram URL', 'Role', 'Client Type', 'VAT Number', 'Tags', 'Billing Country',
      'Billing City', 'Identity Cert', 'Title', 'Salutation', 'Birth Date',
      'Preferred Language', 'Time Zone', 'Has No Email', 'VAT Applicable',
      'Secondary Email', 'Secondary Phone Number', 'Default VAT Scheme', 'Default LDL',
      'Default Consignment Charges', 'Billing Address1', 'Billing Address2',
      'Billing Address3', 'Billing Post Code', 'Billing Region', 'Bank Account Details',
      'Bank Address', 'Buyer Premium', 'Vendor Premium', 'Shipping Same As Billing',
      'Shipping Address1', 'Shipping Address2', 'Shipping Address3', 'Shipping City',
      'Shipping Post Code', 'Shipping Country', 'Shipping Region', 'Paddle No',
      'Card on File', 'Auctions Attended', 'Bids Placed', 'Items Won',
      'Tax Exemption', 'Payment Rate %', 'Avg Hammer Price Low', 'Avg Hammer Price High',
      'Disputes Open', 'Disputes Closed', 'Bidder Notes'
    ];
  }

  transformForSheet(record: any): Record<string, any> {
    return {
      'ID': record.id || '',
      'Full Name': `${record.first_name || ''} ${record.last_name || ''}`.trim(),
      'Brand': record.brand_name || '',
      'Platform': record.platform || '',
      'Email': record.email || '',
      'Phone Number': record.phone_number || '',
      'Company Name': record.company_name || '',
      'Instagram URL': record.instagram_url || '',
      'Role': record.role || '',
      'Client Type': record.client_type || '',
      'VAT Number': record.vat_number || '',
      'Tags': record.tags || '',
      'Billing Country': record.billing_country || '',
      'Billing City': record.billing_city || '',
      'Identity Cert': record.identity_cert || '',
      'Title': record.title || '',
      'Salutation': record.salutation || '',
      'Birth Date': record.birth_date || '',
      'Preferred Language': record.preferred_language || '',
      'Time Zone': record.time_zone || '',
      'Has No Email': record.has_no_email ? 'Yes' : 'No',
      'VAT Applicable': record.vat_applicable ? 'Yes' : 'No',
      'Secondary Email': record.secondary_email || '',
      'Secondary Phone Number': record.secondary_phone_number || '',
      'Default VAT Scheme': record.default_vat_scheme || '',
      'Default LDL': record.default_ldl || '',
      'Default Consignment Charges': record.default_consignment_charges || '',
      'Billing Address1': record.billing_address1 || '',
      'Billing Address2': record.billing_address2 || '',
      'Billing Address3': record.billing_address3 || '',
      'Billing Post Code': record.billing_post_code || '',
      'Billing Region': record.billing_region || '',
      'Bank Account Details': record.bank_account_details || '',
      'Bank Address': record.bank_address || '',
      'Buyer Premium': record.buyer_premium || '',
      'Vendor Premium': record.vendor_premium || '',
      'Shipping Same As Billing': record.shipping_same_as_billing ? 'Yes' : 'No',
      'Shipping Address1': record.shipping_address1 || '',
      'Shipping Address2': record.shipping_address2 || '',
      'Shipping Address3': record.shipping_address3 || '',
      'Shipping City': record.shipping_city || '',
      'Shipping Post Code': record.shipping_post_code || '',
      'Shipping Country': record.shipping_country || '',
      'Shipping Region': record.shipping_region || '',
      'Paddle No': record.paddle_no || '',
      'Card on File': record.card_on_file ? 'Yes' : 'No',
      'Auctions Attended': record.auctions_attended || 0,
      'Bids Placed': record.bids_placed || 0,
      'Items Won': record.items_won || 0,
      'Tax Exemption': record.tax_exemption ? 'Yes' : 'No',
      'Payment Rate %': record.payment_rate || 0,
      'Avg Hammer Price Low': record.avg_hammer_price_low || 0,
      'Avg Hammer Price High': record.avg_hammer_price_high || 0,
      'Disputes Open': record.disputes_open || 0,
      'Disputes Closed': record.disputes_closed || 0,
      'Bidder Notes': record.bidder_notes || ''
    };
  }

  transformForDatabase(rowData: Record<string, any>): Partial<any> {
    // This is handled in the webhook processor for consistency
    return rowData;
  }
}

// Factory function to create sheet synchronizers
export function createSheetSynchronizer<T>(
  tableName: string,
  transformer: DataTransformer<T>,
  config?: GoogleSheetsConfig
): SheetSynchronizer<T> {
  return new (class extends SheetSynchronizer<T> {
    constructor() {
      super(transformer, config);
    }

    // Override if needed for specific table logic
  })();
}

// Utility function to get Google Sheets URL from app settings
export async function getGoogleSheetsUrlForModule(moduleName: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', `google_sheet_url_${moduleName}`)
      .single();

    return data?.value || null;
  } catch (error) {
    console.error(`Error getting Google Sheets URL for ${moduleName}:`, error);
    return null;
  }
}

// Utility function to update Google Sheets URL in app settings
export async function updateGoogleSheetsUrl(moduleName: string, url: string): Promise<void> {
  try {
    await supabaseAdmin
      .from('app_settings')
      .upsert({
        key: `google_sheet_url_${moduleName}`,
        value: url,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'key'
      });
  } catch (error) {
    console.error(`Error updating Google Sheets URL for ${moduleName}:`, error);
    throw error;
  }
}
