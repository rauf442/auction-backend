// backend/src/routes/items.ts
import express, { Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import ftp from "basic-ftp";
import { Readable } from "stream";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { google } from "googleapis";
import { supabaseAdmin } from "../utils/supabase";
import {
  listFilesInFolder,
  extractDriveFolderId,
  buildDriveDirectViewUrl,
  deriveItemIdKeyFromFilename,
} from "../utils/google-drive";
import { authMiddleware } from "../middleware/auth";
import {
  CSV_EXPORT_CONFIGS,
  generateCSVContent,
} from "../utils/export-formats";

// Interface for authenticated requests with user info
interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    email: string;
  };
}

const router = express.Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// Common CSV generation utility with proper multiline support
function generateCSVContentFromHeadersAndRows(
  headers: string[],
  rows: any[][],
): string {
  const allData = [headers, ...rows];

  return allData
    .map((row) =>
      row
        .map((cell) => {
          const stringCell = String(cell || "");

          // Check if cell needs quoting (contains comma, newline, or quote)
          const needsQuoting =
            stringCell.includes(",") ||
            stringCell.includes("\n") ||
            stringCell.includes("\r") ||
            stringCell.includes('"');

          if (needsQuoting) {
            // Escape quotes by doubling them, then wrap in quotes
            return `"${stringCell.replace(/"/g, '""')}"`;
          }

          return stringCell;
        })
        .join(","),
    )
    .join("\n");
}

// Convert CSV content to 2D array for Google Sheets API
function csvContentToSheetsData(csvContent: string): string[][] {
  const csvLines = csvContent.split("\n");
  return csvLines.map((line) => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && i < line.length - 1 && line[i + 1] === '"') {
          // Escaped quote inside quoted field
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current); // Add the last field
    return result;
  });
}

// Helper function to write data to Google Sheets
async function writeToGoogleSheets(
  sheetUrl: string | { url: string },
  data: string[][],
  apiKey: string,
  append: boolean = false,
): Promise<boolean> {
  try {
    // Handle both string and object formats for sheetUrl
    const actualSheetUrl =
      typeof sheetUrl === "string" ? sheetUrl : sheetUrl.url;
    console.log("sheeturl", actualSheetUrl);

    // Extract sheet ID from URL
    const sheetIdMatch = actualSheetUrl.match(
      /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
    );
    if (!sheetIdMatch) {
      throw new Error("Invalid Google Sheets URL format");
    }

    const spreadsheetId = sheetIdMatch[1];

    // Initialize Google Sheets API with service account
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: "service_account",
        project_id: process.env.GOOGLE_PROJECT_ID || "msaber-project",
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
      } as any,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    let result;
    if (append) {
      // Append data to existing sheet
      result = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1", // Append to Sheet1
        valueInputOption: "RAW",
        requestBody: {
          values: data,
        },
      });
    } else {
      // Clear existing data first (optional)
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: "Sheet1", // Default sheet name
      });

      // Write new data
      result = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "Sheet1!A1", // Start from A1
        valueInputOption: "RAW",
        requestBody: {
          values: data,
        },
      });
    }

    console.log(
      "Successfully wrote to Google Sheets:",
      append ? "appended" : "updated",
      result.data,
    );
    return true;
  } catch (error: any) {
    console.error("Error writing to Google Sheets:", error.message);

    // Fallback: If service account fails, try with API key (read-only operations won't work for writing)
    if (
      error.message.includes("credentials") ||
      error.message.includes("authentication")
    ) {
      console.log(
        "Service account auth failed, Google Sheets API requires proper service account credentials for writing",
      );
      console.log(
        "Please configure GOOGLE_PRIVATE_KEY, GOOGLE_CLIENT_EMAIL etc. environment variables",
      );
    }

    return false;
  }
}

// Initialize Google Gemini AI
const apiKey =
  process.env.GEMINI_API_KEY || "AIzaSyD5kSMyozQcOV7JmmwEXEqGOXhMMGGV1yg";
// 'AIzaSyAODqjK_-6R6yuBq9pWs4JWQvHOavMw2Fg';
const aiModel = process.env.AI_MODEL || "";
const genAI = new GoogleGenerativeAI(apiKey);
// Configure multer for image upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Item interface matching the database schema and LiveAuctioneers requirements
interface Item {
  id?: string;
  title: string; // Required: Title (max 49 chars)
  description: string; // Required: Description (unlimited)
  low_est: number; // Required: Low Estimate
  high_est: number; // Required: High Estimate
  start_price?: number; // Optional: Start Price (defaults to 50% of low_est)
  condition?: string; // Optional: Condition
  reserve?: number; // Optional: Reserve price (internal use)
  vendor_id?: number; // Optional: Vendor ID (foreign key to clients)
  buyer_id?: number; // Optional: Buyer ID (foreign key to clients)

  // Additional auction management fields
  status?: "draft" | "active" | "sold" | "withdrawn" | "passed" | "returned";
  category?: string;
  subcategory?: string;
  dimensions?: string;
  weight?: string;
  materials?: string;
  artist_maker?: string;
  artist_id?: number; // Reference to artist in database
  period_age?: string;
  provenance?: string;

  // Images array (unlimited images)
  images?: string[]; // Array of image URLs

  // Artist information inclusion flags for export descriptions
  include_artist_description?: boolean;
  include_artist_key_description?: boolean;
  include_artist_biography?: boolean;
  include_artist_notable_works?: boolean;
  include_artist_major_exhibitions?: boolean;
  include_artist_awards_honors?: boolean;
  include_artist_market_value_range?: boolean;
  include_artist_signature_style?: boolean;

  // Certification attachment fields
  artist_certification_file?: string;
  artist_family_certification_file?: string;
  gallery_certification_file?: string;
  restoration_done_file?: string;

  // Return fields
  return_date?: string;
  return_location?: string;
  return_reason?: string;
  returned_by_user_id?: string;
  returned_by_user_name?: string;

  // Audit fields
  created_at?: string;
  updated_at?: string;
}

// Platform identifiers supported for CSV import/export
type PlatformId =
  | "database"
  | "liveauctioneers"
  | "easy_live"
  | "invaluable"
  | "the_saleroom";

// Helper function to extract numeric ID from formatted strings like "INV-0002", "ITEM-123", "6", "0006", etc.
function extractNumericId(idString: string): number | null {
  if (!idString || typeof idString !== "string") return null;

  // Clean the string first
  const cleanId = idString.trim();

  // If it's already a plain number, return it
  if (!isNaN(Number(cleanId))) {
    const num = parseInt(cleanId, 10);
    return isNaN(num) ? null : num;
  }

  // Try to extract the numeric part using regex (handles INV-0006, ITEM-123, etc.)
  const match = cleanId.match(/(\d+)/);
  if (match && match[1]) {
    const num = parseInt(match[1], 10);
    return isNaN(num) ? null : num;
  }

  return null;
}

// Common function to extract numeric ID for image mapping from import data
function extractNumericIdForImageMapping(value: string): string | null {
  if (!value || typeof value !== "string") return null;

  // Extract numeric ID for image mapping purposes
  const numericId = extractNumericId(value);
  if (numericId !== null) {
    return numericId.toString();
  }

  // If it's already a plain number string, use it
  if (!isNaN(Number(value))) {
    return value;
  }

  return null;
}

// Common function to handle drive folder image mapping for both CSV and Google Sheets imports
async function mapImagesFromDriveFolder(
  drive_folder_url: string,
  items: any[],
  importType: "csv" | "google_sheets",
): Promise<{ itemsWithImages: number; errors: string[] }> {
  const errors: string[] = [];

  try {
    console.log(
      `[${importType.toUpperCase()}] Starting drive folder image mapping...`,
    );
    const files = await listFilesInFolder(drive_folder_url);
    console.log(
      `[${importType.toUpperCase()}] Found ${files.length} files in Google Drive folder`,
    );

    // Build id->files map
    const lookup = new Map<string, { name: string; url: string }[]>();
    let mappedFiles = 0;
    let unmappedFiles = 0;

    for (const f of files) {
      const originalName = f.name || "";
      const base = originalName.toLowerCase();
      const url = buildDriveDirectViewUrl(f.id);
      const idKey = deriveItemIdKeyFromFilename(base);

      if (idKey) {
        console.log(
          `[${importType.toUpperCase()}] Mapped file "${originalName}" to item ID: ${idKey}`,
        );
        const arr = lookup.get(idKey) || [];
        arr.push({ name: originalName, url });
        lookup.set(idKey, arr);
        mappedFiles++;
      } else {
        console.log(
          `[${importType.toUpperCase()}] Could not extract ID from filename: "${originalName}"`,
        );
        unmappedFiles++;
      }
    }

    console.log(
      `[${importType.toUpperCase()}] Image mapping summary: ${mappedFiles} mapped, ${unmappedFiles} unmapped`,
    );

    let itemsWithImages = 0;

    // Assign images to items with proper sorting
    for (const item of items) {
      // Use the extracted ID for image lookup
      const extractedId = item._extractedImageMappingId;
      const key = extractedId ? String(extractedId) : "";

      if (!key) {
        console.log(
          `[${importType.toUpperCase()}] Item has no extracted ID for image mapping:`,
          {
            title: item.title,
            id: item.id,
          },
        );
        continue;
      }

      const entries = lookup.get(key);
      if (entries && entries.length > 0) {
        console.log(
          `[${importType.toUpperCase()}] Assigning ${entries.length} images to item (extracted ID: ${key}, DB ID: ${item.id})`,
        );

        // Sort files using common function
        const sorted = sortDriveFilesByItemId(entries);

        // Update the database item with images (using images array)
        const imageUrls = sorted.map((img) => img.url);
        const imageUpdates: any = {
          images: imageUrls,
        };
        console.log(
          `[${importType.toUpperCase()}]   Images array: ${imageUrls.length} images`,
        );

        // Update the database item with images
        const { error: updateError } = await supabaseAdmin
          .from("items")
          .update(imageUpdates)
          .eq("id", item.id);

        if (updateError) {
          console.error(
            `[${importType.toUpperCase()}] Failed to update images for item ID ${item.id}:`,
            updateError,
          );
          errors.push(
            `Failed to update images for item ${item.title}: ${updateError.message}`,
          );
        } else {
          itemsWithImages++;
        }
      } else {
        console.log(
          `[${importType.toUpperCase()}] No images found for extracted ID: ${key}`,
        );
      }
    }

    console.log(
      `[${importType.toUpperCase()}] Items with images assigned: ${itemsWithImages}/${items.length}`,
    );
    return { itemsWithImages, errors };
  } catch (error: any) {
    console.error(`[${importType.toUpperCase()}] Drive mapping error:`, error);
    errors.push(`Drive mapping error: ${error.message}`);
    return { itemsWithImages: 0, errors };
  }
}

// Common function to sync full database to Google Sheets
async function syncDatabaseToGoogleSheets(
  sheetUrl: string,
  brandId?: number,
  importType: "csv" | "google_sheets" | "auto_sync" = "csv",
): Promise<{ success: boolean; message: string; synced_count?: number }> {
  try {
    console.log(
      `[${importType.toUpperCase()}] Starting sync to Google Sheets: ${sheetUrl}`,
    );

    // Get all items from database using a simple approach that works with Supabase
    let query = supabaseAdmin
      .from("items")
      .select(
        `
        *,
        brands (
          id,
          name,
          code
        )
      `,
      )
      .order("id", { ascending: true });

    // Brand filtering disabled for now

    // Use a very large limit to try to get all items
    // Supabase might still limit this, but let's see what happens
    const { data: allItems, error } = await query.limit(50000);

    if (error) {
      console.error(
        `[${importType.toUpperCase()}] Error fetching items:`,
        error,
      );
      return {
        success: false,
        message: `Failed to fetch items: ${error?.message || "Unknown error"}`,
      };
    }

    console.log(
      `[${importType.toUpperCase()}] Fetched ${allItems.length} items`,
    );

    if (!allItems || allItems.length === 0) {
      console.log(`[${importType.toUpperCase()}] No items found for sync`);
      return {
        success: true,
        message: "No items to sync",
        synced_count: 0,
      };
    }

    console.log(
      `[${importType.toUpperCase()}] Syncing ${allItems.length} items to Google Sheets`,
    );

    // For large datasets, process in batches to avoid memory issues
    const BATCH_SIZE = 5000; // Process in batches of 5000 items
    let writeSuccess = true;

    if (allItems.length <= BATCH_SIZE) {
      // Process all at once for smaller datasets
      const csvHeaders = PLATFORM_EXPORT_HEADERS.database;
      const csvRows = generateDatabaseCsvRows(allItems);
      const csvContent = generateCSVContentFromHeadersAndRows(
        csvHeaders,
        csvRows,
      );

      // Convert CSV to 2D array for Google Sheets API
      const sheetsData = csvContentToSheetsData(csvContent);

      // Write to Google Sheets
      const googleApiKey =
        process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
        process.env.GOOGLE_MAPS_API_KEY ||
        "";
      writeSuccess = await writeToGoogleSheets(
        sheetUrl,
        sheetsData,
        googleApiKey,
      );
    } else {
      // Process in batches for large datasets
      console.log(
        `[${importType.toUpperCase()}] Large dataset detected (${allItems.length} items). Processing in batches of ${BATCH_SIZE}...`,
      );

      const csvHeaders = PLATFORM_EXPORT_HEADERS.database;
      const googleApiKey =
        process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
        process.env.GOOGLE_MAPS_API_KEY ||
        "";

      for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
        const batch = allItems.slice(i, i + BATCH_SIZE);
        const csvRows = generateDatabaseCsvRows(batch);
        const csvContent = generateCSVContentFromHeadersAndRows(
          csvHeaders,
          csvRows,
        );
        const sheetsData = csvContentToSheetsData(csvContent);

        // For batches after the first, append to the sheet instead of overwriting

        try {
          // For subsequent batches, we need to append rather than overwrite
          if (i > 0) {
            // Use append for subsequent batches (skip header row)
            const result = await writeToGoogleSheets(
              sheetUrl,
              sheetsData.slice(1),
              googleApiKey,
              true,
            );
            if (!result) {
              writeSuccess = false;
              console.error(
                `[${importType.toUpperCase()}] Failed to write batch ${Math.floor(i / BATCH_SIZE) + 1}`,
              );
              break;
            }
          } else {
            // First batch overwrites (include headers)
            const result = await writeToGoogleSheets(
              sheetUrl,
              sheetsData,
              googleApiKey,
              false,
            );
            if (!result) {
              writeSuccess = false;
              console.error(
                `[${importType.toUpperCase()}] Failed to write first batch`,
              );
              break;
            }
          }

          console.log(
            `[${importType.toUpperCase()}] Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allItems.length / BATCH_SIZE)} (${batch.length} items)`,
          );
        } catch (batchError) {
          console.error(
            `[${importType.toUpperCase()}] Error processing batch ${Math.floor(i / BATCH_SIZE) + 1}:`,
            batchError,
          );
          writeSuccess = false;
          break;
        }
      }
    }

    if (writeSuccess) {
      console.log(
        `[${importType.toUpperCase()}] ✅ Successfully synced ${allItems.length} items to Google Sheets`,
      );
      return {
        success: true,
        message: `Successfully synced ${allItems.length} items to Google Sheets`,
        synced_count: allItems.length,
      };
    } else {
      console.error(
        `[${importType.toUpperCase()}] ❌ Failed to write to Google Sheets`,
      );
      return {
        success: false,
        message:
          "Failed to write to Google Sheets. Please check your service account credentials.",
        synced_count: 0,
      };
    }
  } catch (error: any) {
    console.error(
      `[${importType.toUpperCase()}] Error syncing to Google Sheets:`,
      error,
    );
    return {
      success: false,
      message: `Sync failed: ${error.message}`,
    };
  }
}

// Common function to generate CSV rows for database export
function generateDatabaseCsvRows(items: any[]): any[][] {
  return items.map((item) => [
    item.id || "",
    item.title || "",
    item.description || "",
    item.low_est || "",
    item.high_est || "",
    item.start_price || "",
    item.reserve || "",
    item.condition || "",
    item.consignment_id || "",
    item.status || "",
    item.category || "",
    item.subcategory || "",
    (item as any).height_inches || "",
    (item as any).width_inches || "",
    (item as any).height_cm || "",
    (item as any).width_cm || "",
    (item as any).height_with_frame_inches || "",
    (item as any).width_with_frame_inches || "",
    (item as any).height_with_frame_cm || "",
    (item as any).width_with_frame_cm || "",
    item.weight || "",
    item.materials || "",
    item.artist_maker || "",
    item.period_age || "",
    item.provenance || "",
    item.artist_id || "",
    item.school_id || "",
    (item as any).condition_report || "",
    (item as any).gallery_certification === null ||
    (item as any).gallery_certification === false
      ? ""
      : (item as any).gallery_certification,
    (item as any).gallery_certification_file || "",
    (item as any).gallery_id || "",
    (item as any).artist_certification === null ||
    (item as any).artist_certification === false
      ? ""
      : (item as any).artist_certification,
    (item as any).artist_certification_file || "",
    (item as any).certified_artist_id || "",
    (item as any).artist_family_certification === null ||
    (item as any).artist_family_certification === false
      ? ""
      : (item as any).artist_family_certification,
    (item as any).artist_family_certification_file || "",
    (item as any).restoration_done === null ||
    (item as any).restoration_done === false
      ? ""
      : (item as any).restoration_done,
    (item as any).restoration_done_file || "",
    (item as any).restoration_by || "",
    // Handle images array - export as JSON string for unlimited images support
    item.images && Array.isArray(item.images) && item.images.length > 0
      ? JSON.stringify(item.images.filter((url: string) => url && url.trim()))
      : "",
    (item as any).include_artist_description === null ||
    (item as any).include_artist_description === false
      ? ""
      : (item as any).include_artist_description,
    (item as any).include_artist_key_description === null ||
    (item as any).include_artist_key_description === false
      ? ""
      : (item as any).include_artist_key_description,
    (item as any).include_artist_biography === null ||
    (item as any).include_artist_biography === false
      ? ""
      : (item as any).include_artist_biography,
    (item as any).include_artist_notable_works === null ||
    (item as any).include_artist_notable_works === false
      ? ""
      : (item as any).include_artist_notable_works,
    (item as any).include_artist_major_exhibitions === null ||
    (item as any).include_artist_major_exhibitions === false
      ? ""
      : (item as any).include_artist_major_exhibitions,
    (item as any).include_artist_awards_honors === null ||
    (item as any).include_artist_awards_honors === false
      ? ""
      : (item as any).include_artist_awards_honors,
    (item as any).include_artist_market_value_range === null ||
    (item as any).include_artist_market_value_range === false
      ? ""
      : (item as any).include_artist_market_value_range,
    (item as any).include_artist_signature_style === null ||
    (item as any).include_artist_signature_style === false
      ? ""
      : (item as any).include_artist_signature_style,
    // Brand field (export brand_code only for readability)
    (item as any).brands?.code || (item as any).brand_code || "",
    // Return fields
    (item as any).return_date || "",
    (item as any).return_location || "",
    (item as any).return_reason || "",
    (item as any).returned_by_user_id || null,
    (item as any).returned_by_user_name || "",
    (item as any).date_sold === null ? "" : (item as any).date_sold,
    item.created_at || "",
    item.updated_at || "",
  ]);
}

// CSV headers per platform for EXPORT - these are used for exporting data
const PLATFORM_EXPORT_HEADERS: Record<PlatformId, string[]> = {
  database: [
    "id",
    "title",
    "description",
    "low_est",
    "high_est",
    "start_price",
    "reserve",
    "condition",
    "consignment_id",
    "status",
    "category",
    "subcategory",
    "height_inches",
    "width_inches",
    "height_cm",
    "width_cm",
    "height_with_frame_inches",
    "width_with_frame_inches",
    "height_with_frame_cm",
    "width_with_frame_cm",
    "weight",
    "materials",
    "artist_maker",
    "period_age",
    "provenance",
    "artist_id",
    "school_id",
    "condition_report",
    "gallery_certification",
    "gallery_certification_file",
    "gallery_id",
    "artist_certification",
    "artist_certification_file",
    "certified_artist_id",
    "artist_family_certification",
    "artist_family_certification_file",
    "restoration_done",
    "restoration_done_file",
    "restoration_by",
    "images",
    "include_artist_description",
    "include_artist_key_description",
    "include_artist_biography",
    "include_artist_notable_works",
    "include_artist_major_exhibitions",
    "include_artist_awards_honors",
    "include_artist_market_value_range",
    "include_artist_signature_style",
    "brand_code",
    "return_date",
    "return_location",
    "return_reason",
    "returned_by_user_id",
    "returned_by_user_name",
    "date_sold",
    "created_at",
    "updated_at",
  ],
  liveauctioneers: [
    "LotNum",
    "Title",
    "Description",
    "LowEst",
    "HighEst",
    "StartPrice",
    "ReservePrice",
    "Buy Now Price",
    "Exclude From Buy Now",
    "Condition",
    "Category",
    "Origin",
    "Style & Period",
    "Creator",
    "Materials & Techniques",
    "Reserve Price",
    "Domestic Flat Shipping Price",
    "Height",
    "Width",
    "Depth",
    "Dimension Unit",
    "Weight",
    "Weight Unit",
    "Quantity",
  ],
  easy_live: [
    "LotNo",
    "Description",
    "Condition Report",
    "LowEst",
    "HighEst",
    "Category",
  ],
  invaluable: [
    "id",
    "title",
    "description",
    "low_est",
    "high_est",
    "start_price",
    "condition",
    "category",
    "dimensions",
  ],
  the_saleroom: [
    "Number",
    "Title",
    "Description",
    "Hammer",
    "Reserve",
    "StartPrice",
    "Increment",
    "Quantity",
    "LowEstimate",
    "HighEstimate",
    "CategoryCode",
    "Sales Tax/VAT",
    "BuyersPremiumRate",
    "BuyersPremiumCeiling",
    "InternetSurchargeRate",
    "InternetSurchargeCeiling",
    "BuyersPremiumVatRate",
    "InternetSurchargeVatRate",
    "End Date",
    "End Time",
    "Lot Link",
    "Main Image",
    "ExtraImages",
    "BuyItNowPrice",
    "IsBulk",
    "Artist's Resale Right Applies",
    "Address1",
    "Address2",
    "Address3",
    "Address4",
    "Postcode",
    "TownCity",
    "CountyState",
    "CountryCode",
    "ShippingInfo",
  ],
};

// CSV headers per platform for IMPORT - these define what columns we expect when importing
const PLATFORM_IMPORT_HEADERS: Record<PlatformId, string[]> = {
  database: [
    "id",
    "title",
    "description",
    "low_est",
    "high_est",
    "start_price",
    "reserve",
    "condition",
    "consignment_id",
    "status",
    "category",
    "subcategory",
    "height_inches",
    "width_inches",
    "height_cm",
    "width_cm",
    "height_with_frame_inches",
    "width_with_frame_inches",
    "height_with_frame_cm",
    "width_with_frame_cm",
    "weight",
    "materials",
    "artist_maker",
    "period_age",
    "provenance",
    "artist_id",
    "school_id",
    "condition_report",
    "gallery_certification",
    "gallery_certification_file",
    "gallery_id",
    "artist_certification",
    "artist_certification_file",
    "certified_artist_id",
    "artist_family_certification",
    "artist_family_certification_file",
    "restoration_done",
    "restoration_done_file",
    "restoration_by",
    "images",
    "include_artist_description",
    "include_artist_key_description",
    "include_artist_biography",
    "include_artist_notable_works",
    "include_artist_major_exhibitions",
    "include_artist_awards_honors",
    "include_artist_market_value_range",
    "include_artist_signature_style",
    "brand_id",
    "return_date",
    "return_location",
    "return_reason",
    "returned_by_user_id",
    "returned_by_user_name",
    "date_sold",
    "created_at",
    "updated_at",
  ],
  liveauctioneers: [
    "Lot",
    "Lot ID",
    "Title",
    "Description",
    "Condition",
    "LowEst",
    "HighEst",
    "Start Price",
    "Reserve Price",
    "Height",
    "Width",
    "Depth",
    "Dimension Unit",
    "Weight",
    "Weight Unit",
    "Domestic Flat Shipping Price",
    "Quantity",
    "Shipping Height",
    "Shipping Width",
    "Shipping Depth",
    "Shipping Dimension Unit",
    "Shipping Weight",
    "Shipping Weight Unit",
    "Shipping Quantity",
    "Consigner",
    "Reference Number",
    "Bids",
    "Pending Bids",
    "Hits",
    "Image Count",
    "Live",
    "Edited",
  ],
  easy_live: [
    "LotNo",
    "Description",
    "Condition Report",
    "LowEst",
    "HighEst",
    "Category",
  ],
  invaluable: [
    "id",
    "title",
    "description",
    "low_est",
    "high_est",
    "start_price",
    "condition",
    "category",
    "dimensions",
  ],
  the_saleroom: [
    "Number",
    "Title",
    "Description",
    "Hammer",
    "Reserve",
    "StartPrice",
    "Increment",
    "Quantity",
    "LowEstimate",
    "HighEstimate",
    "CategoryCode",
    "Sales Tax/VAT",
    "BuyersPremiumRate",
    "BuyersPremiumCeiling",
    "InternetSurchargeRate",
    "InternetSurchargeCeiling",
    "BuyersPremiumVatRate",
    "InternetSurchargeVatRate",
    "End Date",
    "End Time",
    "Lot Link",
    "Main Image",
    "ExtraImages",
    "BuyItNowPrice",
    "IsBulk",
    "Artist's Resale Right Applies",
    "Address1",
    "Address2",
    "Address3",
    "Address4",
    "Postcode",
    "TownCity",
    "CountyState",
    "CountryCode",
    "ShippingInfo",
  ],
};

// Map a platform header to an internal field name for parsing imports
const PLATFORM_IMPORT_FIELD_MAP: Record<PlatformId, Record<string, string>> = {
  database: {
    id: "id",
    title: "title",
    description: "description",
    low_est: "low_est",
    high_est: "high_est",
    start_price: "start_price",
    condition: "condition",
    reserve: "reserve",
    consignment_id: "consignment_id",
    status: "status",
    category: "category",
    subcategory: "subcategory",
    dimensions: "dimensions",
    weight: "weight",
    materials: "materials",
    artist_maker: "artist_maker",
    period_age: "period_age",
    provenance: "provenance",
    artist_id: "artist_id",
    school_id: "school_id",
    height_inches: "height_inches",
    width_inches: "width_inches",
    height_cm: "height_cm",
    width_cm: "width_cm",
    height_with_frame_inches: "height_with_frame_inches",
    width_with_frame_inches: "width_with_frame_inches",
    height_with_frame_cm: "height_with_frame_cm",
    width_with_frame_cm: "width_with_frame_cm",
    condition_report: "condition_report",
    gallery_certification: "gallery_certification",
    gallery_certification_file: "gallery_certification_file",
    gallery_id: "gallery_id",
    artist_certification: "artist_certification",
    artist_certification_file: "artist_certification_file",
    certified_artist_id: "certified_artist_id",
    artist_family_certification: "artist_family_certification",
    artist_family_certification_file: "artist_family_certification_file",
    restoration_done: "restoration_done",
    restoration_done_file: "restoration_done_file",
    restoration_by: "restoration_by",
    images: "images",
    include_artist_description: "include_artist_description",
    include_artist_key_description: "include_artist_key_description",
    include_artist_biography: "include_artist_biography",
    include_artist_notable_works: "include_artist_notable_works",
    include_artist_major_exhibitions: "include_artist_major_exhibitions",
    include_artist_awards_honors: "include_artist_awards_honors",
    include_artist_market_value_range: "include_artist_market_value_range",
    include_artist_signature_style: "include_artist_signature_style",
    // Brand field (import brand_id directly)
    brand_id: "brand_id",
    // Return fields
    return_date: "return_date",
    return_location: "return_location",
    return_reason: "return_reason",
    returned_by_user_id: "returned_by_user_id",
    returned_by_user_name: "returned_by_user_name",
    date_sold: "date_sold",
    created_at: "created_at",
    updated_at: "updated_at",
  },
  liveauctioneers: {
    Lot: "lot", // Will be ignored - we use our own item IDs
    "Lot ID": "lot_id", // Will be ignored - we use our own item IDs
    Title: "title",
    Description: "description",
    Condition: "condition",
    LowEst: "low_est",
    HighEst: "high_est",
    "Start Price": "start_price",
    "Reserve Price": "reserve",
    // Height and Width will be handled separately for dimension conversion
    // Depth: 'depth', // Not in database
    // 'Dimension Unit': 'dimension_unit', // Not in database
    Weight: "weight",
    "Weight Unit": "weight_unit",
    "Domestic Flat Shipping Price": "shipping_price",
    Quantity: "quantity",
    "Shipping Height": "shipping_height",
    "Shipping Width": "shipping_width",
    "Shipping Depth": "shipping_depth",
    "Shipping Dimension Unit": "shipping_dimension_unit",
    "Shipping Weight": "shipping_weight",
    "Shipping Weight Unit": "shipping_weight_unit",
    "Shipping Quantity": "shipping_quantity",
    Consigner: "consignment_id",
    "Reference Number": "reference_number",
    Bids: "bids",
    "Pending Bids": "pending_bids",
    Hits: "hits",
    "Image Count": "image_count",
    Live: "live",
    Edited: "edited",
  },
  easy_live: {
    LotNo: "id",
    Description: "description",
    "Condition Report": "condition",
    LowEst: "low_est",
    HighEst: "high_est",
    Category: "category",
  },
  invaluable: {
    id: "id",
    title: "title",
    description: "description",
    low_est: "low_est",
    high_est: "high_est",
    start_price: "start_price",
    condition: "condition",
    category: "category",
    dimensions: "dimensions",
  },
  the_saleroom: {
    Number: "id",
    Title: "title",
    Description: "description",
    Hammer: "hammer_price",
    Reserve: "reserve",
    StartPrice: "start_price",
    Increment: "increment",
    Quantity: "quantity",
    LowEstimate: "low_est",
    HighEstimate: "high_est",
    CategoryCode: "category",
    "Sales Tax/VAT": "vat_rate",
    BuyersPremiumRate: "buyers_premium_rate",
    BuyersPremiumCeiling: "buyers_premium_ceiling",
    InternetSurchargeRate: "internet_surcharge_rate",
    InternetSurchargeCeiling: "internet_surcharge_ceiling",
    BuyersPremiumVatRate: "buyers_premium_vat_rate",
    InternetSurchargeVatRate: "internet_surcharge_vat_rate",
    "End Date": "end_date",
    "End Time": "end_time",
    "Lot Link": "lot_link",
    "Main Image": "images",
    ExtraImages: "extra_images",
    BuyItNowPrice: "buy_it_now_price",
    IsBulk: "is_bulk",
    "Artist's Resale Right Applies": "artist_resale_right",
    Address1: "address1",
    Address2: "address2",
    Address3: "address3",
    Address4: "address4",
    Postcode: "postcode",
    TownCity: "town_city",
    CountyState: "county_state",
    CountryCode: "country_code",
    ShippingInfo: "shipping_info",
  },
};

// Required minimal fields per platform
const PLATFORM_REQUIRED_FIELDS: Record<PlatformId, string[]> = {
  database: ["id", "title"],
  liveauctioneers: ["Title"],
  easy_live: ["LotNo"],
  invaluable: ["id", "title"],
  the_saleroom: ["Number", "Title"],
};

function normalizePlatform(platform?: string): PlatformId {
  const value = (platform || "database").toLowerCase();
  switch (value) {
    case "database":
      return "database";
    case "liveauctioneers":
      return "liveauctioneers";
    case "easy live":
    case "easy_live":
    case "easylive":
      return "easy_live";
    case "invaluable":
      return "invaluable";
    case "the saleroom":
    case "the_saleroom":
    case "saleroom":
      return "the_saleroom";
    default:
      return "database";
  }
}

function getUrlBasename(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop() || "";
    return base || "image.jpg";
  } catch {
    // not a URL, might already be a filename
    return url || "image.jpg";
  }
}

function ensureImageExtension(name: string, fallbackExt = ".jpg"): string {
  const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(name);
  return hasExt ? name : name + fallbackExt;
}

// Helper function to parse a single CSV line with proper quote handling
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (!inQuotes) {
        // Start of quoted field
        inQuotes = true;
      } else if (i < line.length - 1 && line[i + 1] === '"') {
        // Escaped quote inside quoted field (double quote)
        current += '"';
        i++; // Skip next quote
      } else {
        // End of quoted field
        inQuotes = false;
      }
    } else if (char === "," && !inQuotes) {
      // Field separator (only when not inside quotes)
      values.push(current);
      current = "";
    } else {
      // Regular character
      current += char;
    }
  }

  // Add the last field
  values.push(current);

  return values;
}

// Helper function to parse currency values with symbols like &pound;
function parseCurrencyValue(value: string): number {
  if (!value || typeof value !== "string") return NaN;

  // Handle HTML entity &pound; and other currency symbols
  let cleanValue = value
    .replace(/&pound;/g, "") // Remove pound sterling HTML entity
    .replace(/£/g, "") // Remove pound sterling symbol
    .replace(/\$/g, "") // Remove dollar symbol
    .replace(/€/g, "") // Remove euro symbol
    .replace(/,/g, "") // Remove commas
    .trim();

  // Parse the numeric value
  const num = parseFloat(cleanValue);
  return isNaN(num) ? NaN : num;
}

function derivedImageFilename(
  source: string,
  lotNum: string,
  index: number,
): string {
  const base = getUrlBasename(source).replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = base.includes(".")
    ? base.substring(base.lastIndexOf("."))
    : ".jpg";
  // Prefer original filename if present; otherwise derive from lot
  const original = base && base.length > 0 ? base : `${lotNum}_${index}${ext}`;
  return ensureImageExtension(original);
}

// Common function to sort Google Drive files by item ID and alphabetical suffix
function sortDriveFilesByItemId(
  files: { name: string; url: string; fileId?: string }[],
): { name: string; url: string; fileId: string }[] {
  return files
    .sort((a, b) => {
      const stripExt = (filename: string) => filename.replace(/\.[^.]+$/, ""); // remove extension
      const baseA = stripExt(a.name);
      const baseB = stripExt(b.name);

      const numA = parseInt(baseA.match(/(\d+)/)?.[1] || "0");
      const numB = parseInt(baseB.match(/(\d+)/)?.[1] || "0");

      if (numA !== numB) {
        return numA - numB;
      }

      // Detect suffix
      const suffixRegex = /^(\d+)[-_ ]?([a-zA-Z])$/;
      const matchA = baseA.match(suffixRegex);
      const matchB = baseB.match(suffixRegex);

      const hasSuffixA = !!matchA;
      const hasSuffixB = !!matchB;

      if (!hasSuffixA && hasSuffixB) return -1; // base first
      if (hasSuffixA && !hasSuffixB) return 1;

      if (hasSuffixA && hasSuffixB) {
        return matchA![2].localeCompare(matchB![2]);
      }

      return baseA.localeCompare(baseB, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    })
    .map((f) => ({
      name: f.name,
      url: f.url,
      fileId: f.fileId || "", // Provide default empty string for undefined fileId
    }));
}

// POST /api/items/ai-analyze - Analyze image and generate item details
router.post("/ai-analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Gemini API key not configured" });
    }

    // Optimize image for AI analysis
    const optimizedImage = await sharp(req.file.buffer)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Convert to base64 for Gemini API
    const base64Image = optimizedImage.toString("base64");

    // Prepare the prompt for Gemini
    const prompt = `
      Analyze this artwork image and provide detailed information in JSON format.

      IMPORTANT: Respond ONLY with a valid JSON object. Do not include any text before or after the JSON. Do not wrap in markdown code blocks.

      Required JSON format:
      {
        "title": "string (required - create descriptive title if none visible)",
        "artist_name": "string or null (artist name if identifiable, null if unknown)",
        "materials": "string (required - medium/materials used)",
        "dimensions": "string (required - approximate dimensions)",
        "period_age": "string (required - artistic period/age)",
        "condition": "string (required - condition assessment)",
        "category": "string (required - category like Fine Art, Sculpture, Print)",
        "description": "string (optional - detailed auction catalog description, defaults to title if empty)",
        "low_est": number (required - conservative low estimate in GBP),
        "high_est": number (required - realistic high estimate in GBP)
      }

      Please identify:
      1. Title (create descriptive if none visible)
      2. Artist name (null if unknown)
      3. Medium/materials used
      4. Approximate dimensions
      5. Artistic period/age
      6. Condition assessment
      7. Category
      8. Detailed description
      9. Estimated value range in GBP

      Be conservative with estimates and accurate with artist identification.
    `;

    // Call Gemini API
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    // const model = genAI.getGenerativeModel({ model: aiModel });

    console.log("Sending image to Gemini AI for analysis...");

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
    ]);

    const response = await result.response;
    const text = response.text();

    console.log("Gemini AI response received, length:", text.length);
    console.log(
      "Response preview:",
      text.substring(0, 300) + (text.length > 300 ? "..." : ""),
    );

    // Parse the JSON response with improved error handling
    let analysisResult;
    try {
      // First try to parse the entire response as JSON
      analysisResult = JSON.parse(text.trim());
    } catch (parseError) {
      try {
        // If that fails, try to extract JSON from the response
        console.log(
          "Direct JSON parse failed, attempting extraction from text...",
        );

        // Clean the text and look for JSON patterns
        const cleanText = text.trim();

        // Try multiple extraction methods
        let jsonString = null;

        // Method 1: Look for JSON between first { and last }
        const firstBrace = cleanText.indexOf("{");
        const lastBrace = cleanText.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          jsonString = cleanText.substring(firstBrace, lastBrace + 1);
        }

        // Method 2: Look for code blocks (```json ... ```)
        if (!jsonString) {
          const codeBlockMatch = cleanText.match(
            /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i,
          );
          if (codeBlockMatch) {
            jsonString = codeBlockMatch[1];
          }
        }

        // Method 3: Look for JSON-like content
        if (!jsonString) {
          const jsonMatch = cleanText.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
          if (jsonMatch) {
            jsonString = jsonMatch[0];
          }
        }

        if (!jsonString) {
          throw new Error("No JSON structure found in response");
        }

        // Clean up the extracted JSON string
        jsonString = jsonString
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") // Remove control characters
          .replace(/,(\s*[}\]])/g, "$1") // Remove trailing commas
          .replace(/([{,]\s*)(\w+):/g, '$1"$2":') // Add quotes to unquoted keys
          .replace(/:\s*([^",{\[\s][^,}\]]*[^",}\]\s])\s*([,}\]])/g, ': "$1"$2') // Add quotes to unquoted string values
          .replace(/:\s*null\s*([,}\]])/g, ": null$1") // Handle null values
          .replace(/:\s*true\s*([,}\]])/g, ": true$1") // Handle boolean true
          .replace(/:\s*false\s*([,}\]])/g, ": false$1") // Handle boolean false
          .trim();

        console.log("Extracted JSON string:", jsonString);

        analysisResult = JSON.parse(jsonString);
      } catch (extractionError) {
        console.error(
          "Failed to parse Gemini response after extraction attempts",
        );
        console.error("Original response:", text);
        console.error(
          "Extraction error:",
          extractionError instanceof Error
            ? extractionError.message
            : String(extractionError),
        );

        return res.status(500).json({
          error: "Failed to parse AI response",
          details: "The AI response was not in the expected JSON format",
          debug_info: {
            response_length: text.length,
            response_preview:
              text.substring(0, 500) + (text.length > 500 ? "..." : ""),
          },
        });
      }
    }

    // Validate the parsed JSON structure
    if (!analysisResult || typeof analysisResult !== "object") {
      console.error("Invalid JSON structure:", analysisResult);
      return res.status(500).json({
        error: "Invalid AI response structure",
        details: "The AI response does not contain valid JSON data",
      });
    }

    // Ensure required fields are present and valid
    const requiredFields = ["title", "description", "low_est", "high_est"];
    const missingFields = requiredFields.filter((field) => {
      if (field === "low_est" || field === "high_est") {
        return (
          typeof analysisResult[field] !== "number" ||
          analysisResult[field] <= 0
        );
      }
      return (
        !analysisResult[field] || typeof analysisResult[field] !== "string"
      );
    });

    if (missingFields.length > 0) {
      console.error("Missing or invalid required fields:", missingFields);
      return res.status(500).json({
        error: "Incomplete AI analysis",
        details: `Missing or invalid fields: ${missingFields.join(", ")}`,
        received_data: {
          title: analysisResult.title,
          description: analysisResult.description?.substring(0, 100) + "...",
          low_est: analysisResult.low_est,
          high_est: analysisResult.high_est,
        },
      });
    }

    // Check if artist exists in database or create new one
    let artistId = null;

    if (analysisResult.artist_name) {
      // Search for existing artist by exact name match
      const { data: existingArtists } = await supabaseAdmin
        .from("artists")
        .select("id, name")
        .eq("name", analysisResult.artist_name)
        .limit(1);

      if (existingArtists && existingArtists.length > 0) {
        artistId = existingArtists[0].id;
        console.log(
          `Found existing artist: ${analysisResult.artist_name} (ID: ${artistId})`,
        );
      } else {
        // Create new artist with minimal data
        const newArtist = {
          name: analysisResult.artist_name,
          description: `Artist identified through AI image analysis`,
          status: "active",
        };

        try {
          const { data: createdArtistData, error: artistError } =
            await supabaseAdmin
              .from("artists")
              .insert(newArtist)
              .select("id")
              .single();

          if (artistError) {
            console.warn(
              "Failed to create artist (continuing without artist link):",
              artistError.message,
            );
            // Don't fail the entire operation, just continue without artist linkage
          } else {
            artistId = createdArtistData.id;
            console.log(
              `Created new artist: ${analysisResult.artist_name} (ID: ${artistId})`,
            );
          }
        } catch (artistCreationError: any) {
          console.warn(
            "Artist creation failed (continuing without artist link):",
            artistCreationError.message,
          );
          // Continue without failing the artwork creation
        }
      }
    }

    // Generate formatted title: "Artist Name | Art name | Year | Materials"
    let formattedTitle = "";

    // Artist name
    if (analysisResult.artist_name) {
      formattedTitle = analysisResult.artist_name;
    }

    // Art name (use title from AI, or "Untitled" if empty)
    const artName = analysisResult.title?.trim() || "Untitled";
    if (formattedTitle) {
      formattedTitle += ` | ${artName}`;
    } else {
      formattedTitle = artName;
    }

    // Add creation year from period_age or extract year
    let creationYear = "";
    if (analysisResult.period_age) {
      // Try to extract a year from period_age (e.g., "1969", "20th Century", "c. 1950")
      const yearMatch = analysisResult.period_age.match(
        /\b(1[0-9]{3}|20[0-9]{2})\b/,
      );
      if (yearMatch) {
        creationYear = yearMatch[0];
      } else {
        // Use the period as is (e.g., "20th Century", "Contemporary")
        creationYear = analysisResult.period_age;
      }
    }

    if (creationYear) {
      formattedTitle += ` | ${creationYear}`;
    }

    // Add materials
    if (analysisResult.materials) {
      formattedTitle += ` | ${analysisResult.materials}`;
    }

    // AI generates full title without character limits - users can edit if needed

    // Helper function to parse dimensions string into structured fields
    const parseDimensions = (dimensionsStr: string) => {
      if (!dimensionsStr)
        return {
          height_inches: "",
          width_inches: "",
          height_cm: "",
          width_cm: "",
          height_with_frame_inches: "",
          width_with_frame_inches: "",
          height_with_frame_cm: "",
          width_with_frame_cm: "",
        };

      const result = {
        height_inches: "",
        width_inches: "",
        height_cm: "",
        width_cm: "",
        height_with_frame_inches: "",
        width_with_frame_inches: "",
        height_with_frame_cm: "",
        width_with_frame_cm: "",
      };

      // Clean the dimensions string
      const cleanDims = dimensionsStr.toLowerCase().trim();

      // Check if it's in inches or cm
      if (cleanDims.includes("cm") || cleanDims.includes("centimeter")) {
        // It's in cm, parse and convert to inches
        const cmMatch = cleanDims.match(
          /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/,
        );
        if (cmMatch) {
          const widthCm = parseFloat(cmMatch[1]);
          const heightCm = parseFloat(cmMatch[2]);
          const widthInches = Math.round((widthCm / 2.54) * 100) / 100;
          const heightInches = Math.round((heightCm / 2.54) * 100) / 100;

          result.width_cm = widthCm.toString();
          result.height_cm = heightCm.toString();
          result.width_inches = widthInches.toString();
          result.height_inches = heightInches.toString();

          // Calculate with-frame dimensions (+2 inches)
          result.width_with_frame_inches = (widthInches + 2).toFixed(1);
          result.height_with_frame_inches = (heightInches + 2).toFixed(1);
          result.width_with_frame_cm = ((widthInches + 2) * 2.54).toFixed(1);
          result.height_with_frame_cm = ((heightInches + 2) * 2.54).toFixed(1);
        }
      } else {
        // It's in inches (or no unit specified), parse and convert to cm
        const inchMatch = cleanDims.match(
          /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/,
        );
        if (inchMatch) {
          const widthInches = parseFloat(inchMatch[1]);
          const heightInches = parseFloat(inchMatch[2]);
          const widthCm = Math.round(widthInches * 2.54 * 100) / 100;
          const heightCm = Math.round(heightInches * 2.54 * 100) / 100;

          result.width_inches = widthInches.toString();
          result.height_inches = heightInches.toString();
          result.width_cm = widthCm.toString();
          result.height_cm = heightCm.toString();

          // Calculate with-frame dimensions (+2 inches)
          result.width_with_frame_inches = (widthInches + 2).toFixed(1);
          result.height_with_frame_inches = (heightInches + 2).toFixed(1);
          result.width_with_frame_cm = ((widthInches + 2) * 2.54).toFixed(1);
          result.height_with_frame_cm = ((heightInches + 2) * 2.54).toFixed(1);
        }
      }

      return result;
    };

    // Parse dimensions into specific fields
    const parsedDimensions = parseDimensions(analysisResult.dimensions);

    // Prepare the final result
    // Generate start price (50% of low estimate)
    const startPrice = Math.round(analysisResult.low_est * 0.5);

    const finalResult = {
      title: formattedTitle,
      description: analysisResult.description,
      category: analysisResult.category,
      materials: analysisResult.materials,
      period_age: analysisResult.period_age,
      condition: analysisResult.condition,
      low_est: analysisResult.low_est,
      high_est: analysisResult.high_est,
      start_price: startPrice,
      reserve: startPrice, // Set reserve price same as start price initially
      artist_id: artistId,
      // New structured dimension fields populated from AI analysis
      height_inches: parsedDimensions.height_inches,
      width_inches: parsedDimensions.width_inches,
      height_cm: parsedDimensions.height_cm,
      width_cm: parsedDimensions.width_cm,
      height_with_frame_inches: parsedDimensions.height_with_frame_inches,
      width_with_frame_inches: parsedDimensions.width_with_frame_inches,
      height_with_frame_cm: parsedDimensions.height_with_frame_cm,
      width_with_frame_cm: parsedDimensions.width_with_frame_cm,
      // Artist information inclusion flags (defaults for AI-generated items)
      include_artist_description: true, // Default on for AI items
      include_artist_key_description: true, // Default on for AI items
      include_artist_biography: false,
      include_artist_notable_works: false,
      include_artist_major_exhibitions: false,
      include_artist_awards_honors: false,
      include_artist_market_value_range: false,
      include_artist_signature_style: false,
    };

    res.json({
      success: true,
      result: finalResult,
    });
  } catch (error: any) {
    console.error("Error in AI analysis:", error);
    res.status(500).json({
      error: "Failed to analyze image",
      details: error.message,
    });
  }
});

// POST /api/items/ai-analyze-url - Analyze image by URL and generate item details (for edit mode)
router.post("/ai-analyze-url", async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        error: "Image URL is required",
      });
    }

    // Validate URL format
    try {
      new URL(imageUrl);
    } catch (urlError) {
      return res.status(400).json({
        success: false,
        error: "Invalid image URL format",
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Gemini API key not configured",
      });
    }

    // Fetch the image from URL
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      return res.status(400).json({
        success: false,
        error: `Unable to fetch image from URL: ${imageResponse.status} ${imageResponse.statusText}`,
      });
    }

    // Get content type and validate it's an image
    const contentType = imageResponse.headers.get("content-type");
    if (!contentType || !contentType.startsWith("image/")) {
      return res.status(400).json({
        success: false,
        error: "URL does not point to a valid image",
      });
    }

    // Convert to buffer
    const imageBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(imageBuffer);

    // Optimize image for AI analysis (same as file upload version)
    const optimizedImage = await sharp(buffer)
      .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Convert to base64 for Gemini API
    const base64Image = optimizedImage.toString("base64");

    // Use the same prompt as the file upload version
    const prompt = `
      Analyze this artwork image and provide detailed information in JSON format.

      IMPORTANT: Respond ONLY with a valid JSON object. Do not include any text before or after the JSON. Do not wrap in markdown code blocks.

      Required JSON format:
      {
        "title": "string (required - create descriptive title if none visible)",
        "artist_name": "string or null (artist name if identifiable, null if unknown)",
        "materials": "string (required - medium/materials used)",
        "dimensions": "string (required - approximate dimensions)",
        "period_age": "string (required - artistic period/age)",
        "condition": "string (required - condition assessment)",
        "category": "string (required - category like Fine Art, Sculpture, Print)",
        "description": "string (optional - detailed auction catalog description, defaults to title if empty)",
        "low_est": number (required - conservative low estimate in GBP),
        "high_est": number (required - realistic high estimate in GBP)
      }

      Please identify:
      1. Title (create descriptive if none visible)
      2. Artist name (null if unknown)
      3. Medium/materials used
      4. Approximate dimensions
      5. Artistic period/age
      6. Condition assessment
      7. Category
      8. Detailed description
      9. Estimated value range in GBP

      Be conservative with estimates and accurate with artist identification.
    `;

    // Call Gemini API
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    console.log("Sending image from URL to Gemini AI for analysis...");

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
    ]);

    const response = await result.response;
    const text = response.text();

    console.log("Gemini AI response received, length:", text.length);

    // Parse the JSON response (same logic as file upload version)
    let analysisResult;
    try {
      analysisResult = JSON.parse(text.trim());
    } catch (parseError) {
      try {
        // Extract JSON from the response
        const cleanText = text.trim();
        const firstBrace = cleanText.indexOf("{");
        const lastBrace = cleanText.lastIndexOf("}");

        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const jsonString = cleanText.substring(firstBrace, lastBrace + 1);
          analysisResult = JSON.parse(jsonString);
        } else {
          throw new Error("No valid JSON structure found in response");
        }
      } catch (secondParseError) {
        console.error("Failed to parse AI response:", text);
        return res.status(500).json({
          success: false,
          error: "Invalid response format from AI service",
        });
      }
    }

    // Validate required fields
    const requiredFields = [
      "title",
      "materials",
      "period_age",
      "condition",
      "category",
      "low_est",
      "high_est",
    ];
    for (const field of requiredFields) {
      if (!analysisResult[field]) {
        return res.status(500).json({
          success: false,
          error: `AI analysis missing required field: ${field}`,
        });
      }
    }

    // Check if artist exists in database (same as file upload version)
    let artistId = null;
    if (analysisResult.artist_name) {
      const { data: existingArtists } = await supabaseAdmin
        .from("artists")
        .select("id, name")
        .eq("name", analysisResult.artist_name)
        .limit(1);

      if (existingArtists && existingArtists.length > 0) {
        artistId = existingArtists[0].id;
        console.log(
          `Found existing artist: ${analysisResult.artist_name} (ID: ${artistId})`,
        );
      }
    }

    // Parse dimensions (same logic as file upload version)
    const parseDimensions = (dimensionsStr: string) => {
      const result = {
        height_inches: "",
        width_inches: "",
        height_cm: "",
        width_cm: "",
        height_with_frame_inches: "",
        width_with_frame_inches: "",
        height_with_frame_cm: "",
        width_with_frame_cm: "",
      };

      const cleanDims = dimensionsStr.toLowerCase().trim();

      if (cleanDims.includes("cm") || cleanDims.includes("centimeter")) {
        const cmMatch = cleanDims.match(
          /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/,
        );
        if (cmMatch) {
          const widthCm = parseFloat(cmMatch[1]);
          const heightCm = parseFloat(cmMatch[2]);
          const widthInches = Math.round((widthCm / 2.54) * 100) / 100;
          const heightInches = Math.round((heightCm / 2.54) * 100) / 100;

          result.width_cm = widthCm.toString();
          result.height_cm = heightCm.toString();
          result.width_inches = widthInches.toString();
          result.height_inches = heightInches.toString();
          result.width_with_frame_inches = (widthInches + 2).toFixed(1);
          result.height_with_frame_inches = (heightInches + 2).toFixed(1);
          result.width_with_frame_cm = ((widthInches + 2) * 2.54).toFixed(1);
          result.height_with_frame_cm = ((heightInches + 2) * 2.54).toFixed(1);
        }
      } else {
        const inchMatch = cleanDims.match(
          /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/,
        );
        if (inchMatch) {
          const widthInches = parseFloat(inchMatch[1]);
          const heightInches = parseFloat(inchMatch[2]);
          const widthCm = Math.round(widthInches * 2.54 * 100) / 100;
          const heightCm = Math.round(heightInches * 2.54 * 100) / 100;

          result.width_inches = widthInches.toString();
          result.height_inches = heightInches.toString();
          result.width_cm = widthCm.toString();
          result.height_cm = heightCm.toString();
          result.width_with_frame_inches = (widthInches + 2).toFixed(1);
          result.height_with_frame_inches = (heightInches + 2).toFixed(1);
          result.width_with_frame_cm = ((widthInches + 2) * 2.54).toFixed(1);
          result.height_with_frame_cm = ((heightInches + 2) * 2.54).toFixed(1);
        }
      }

      return result;
    };

    const parsedDimensions = parseDimensions(analysisResult.dimensions);

    // Generate start price (50% of low estimate)
    const startPrice = Math.round(analysisResult.low_est * 0.5);

    // Format title with artist if available
    let formattedTitle = analysisResult.title;
    if (analysisResult.artist_name) {
      formattedTitle = `${analysisResult.artist_name} - ${analysisResult.title}`;
    }

    const finalResult = {
      title: formattedTitle,
      description: analysisResult.description || analysisResult.title,
      category: analysisResult.category,
      materials: analysisResult.materials,
      period_age: analysisResult.period_age,
      condition: analysisResult.condition,
      low_est: analysisResult.low_est,
      high_est: analysisResult.high_est,
      start_price: startPrice,
      reserve: startPrice,
      artist_id: artistId,
      // Dimension fields
      height_inches: parsedDimensions.height_inches,
      width_inches: parsedDimensions.width_inches,
      height_cm: parsedDimensions.height_cm,
      width_cm: parsedDimensions.width_cm,
      height_with_frame_inches: parsedDimensions.height_with_frame_inches,
      width_with_frame_inches: parsedDimensions.width_with_frame_inches,
      height_with_frame_cm: parsedDimensions.height_with_frame_cm,
      width_with_frame_cm: parsedDimensions.width_with_frame_cm,
      // Artist information inclusion flags
      include_artist_description: true,
      include_artist_key_description: true,
      include_artist_biography: false,
      include_artist_notable_works: false,
      include_artist_major_exhibitions: false,
      include_artist_awards_honors: false,
      include_artist_market_value_range: false,
      include_artist_signature_style: false,
    };

    res.json({
      success: true,
      result: finalResult,
    });
  } catch (error: any) {
    console.error("Error in AI URL analysis:", error);
    res.status(500).json({
      success: false,
      error: "Failed to analyze image from URL",
      details: error.message,
    });
  }
});

// Add this function somewhere before the /inventory/ai-analyze route in items.ts

async function analyzeArtworkImage(file: Express.Multer.File): Promise<any> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("Gemini API key not configured");
  }

  // Optimize image for AI analysis

  const optimizedImage = await sharp(file.buffer)
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })

    .jpeg({ quality: 85 })

    .toBuffer();

  const base64Image = optimizedImage.toString("base64");

  const prompt = `

    Analyze this artwork image and provide detailed information in JSON format.



    IMPORTANT: Respond ONLY with a valid JSON object. Do not include any text before or after the JSON. Do not wrap in markdown code blocks.



    Required JSON format:

    {

      "title": "string (required - create descriptive title if none visible)",

      "artist_name": "string or null (artist name if identifiable, null if unknown)",

      "materials": "string (required - medium/materials used)",

      "dimensions": "string (required - approximate dimensions)",

      "period_age": "string (required - artistic period/age)",

      "condition": "string (required - condition assessment)",

      "category": "string (required - category like Fine Art, Sculpture, Print)",

      "description": "string (optional - detailed auction catalog description, defaults to title if empty)",

      "low_est": number (required - conservative low estimate in GBP),

      "high_est": number (required - realistic high estimate in GBP)

    }



    Be conservative with estimates and accurate with artist identification.

  `;

  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const result = await model.generateContent([
    prompt,

    { inlineData: { data: base64Image, mimeType: "image/jpeg" } },
  ]);

  const response = await result.response;

  const text = response.text();

  let analysisResult: any;

  try {
    analysisResult = JSON.parse(text.trim());
  } catch {
    const firstBrace = text.indexOf("{");

    const lastBrace = text.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      analysisResult = JSON.parse(text.substring(firstBrace, lastBrace + 1));
    } else {
      throw new Error("AI response could not be parsed as JSON");
    }
  }

  // Calculate start price

  const startPrice = Math.round((analysisResult.low_est || 0) * 0.5);

  return {
    title: analysisResult.title || "",

    description: analysisResult.description || analysisResult.title || "",

    category: analysisResult.category || "",

    materials: analysisResult.materials || "",

    period_age: analysisResult.period_age || "",

    condition: analysisResult.condition || "",

    low_est: analysisResult.low_est || 0,

    high_est: analysisResult.high_est || 0,

    start_price: startPrice,

    reserve: startPrice,
  };
}

// POST /api/public/inventory/ai-analyze

router.post(
  "/inventory/ai-analyze",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "No image provided" });
      }

      // Reuse the same AI analysis logic as the admin route

      // Copy whatever your /api/items/ai-analyze handler does here

      const result = await analyzeArtworkImage(req.file);

      return res.json({ success: true, result });
    } catch (error: any) {
      return res
        .status(500)
        .json({ success: false, error: error.message || "AI analysis failed" });
    }
  },
);
// GET /api/items - Get all items with optional filtering
router.get("/", async (req, res) => {
  try {
    const {
      status,
      category,
      item_ids,
      consignment_id,
      brand_code,
      search,
      page,
      limit,
      sort_field = "created_at",
      sort_direction = "desc",
      // New filter parameters
      item_id,
      low_est_min,
      low_est_max,
      high_est_min,
      high_est_max,
      start_price_min,
      start_price_max,
      condition,
      period_age,
      materials,
      artist_id,
      school_id,
      buyer_id,
      vendor_id,
    } = req.query;

    // Determine if pagination should be applied
    // If page/limit are not provided, return all items (no pagination)
    const hasPagination = page !== undefined || limit !== undefined;
    const limitNum = hasPagination
      ? Math.min(parseInt(limit as string) || 25, 1000)
      : null; // Supabase has a 1000 row limit per query
    const pageNum = hasPagination
      ? Math.max(parseInt(page as string) || 1, 1)
      : null; // Min page 1

    let query = supabaseAdmin.from("items").select(`
        *,
        brands (
          id,
          name,
          code
        )
      `);

    // Apply filters
    if (item_ids) {
      // Filter by specific item IDs (comma-separated string)
      const idsArray = item_ids
        .toString()
        .split(",")
        .map((id) => parseInt(id.trim()))
        .filter((id) => !isNaN(id))
        .sort((a, b) => a - b); // Sort by ID ascending
      if (idsArray.length > 0) {
        query = query.in("id", idsArray);
      }
    }

    if (status && status !== "all" && status !== "") {
      query = query.eq("status", status);
    }

    if (category) {
      query = query.eq("category", category);
    }

    if (consignment_id) {
      query = query.eq("consignment_id", consignment_id);
    }

    // Apply item_id filter (single item ID)
    if (item_id && item_id !== "") {
      const itemIdNum = parseInt(item_id as string);
      if (!isNaN(itemIdNum)) {
        query = query.eq("id", itemIdNum);
      }
    }

    // Apply price range filters
    if (low_est_min && low_est_min !== "") {
      const minValue = parseFloat(low_est_min as string);
      if (!isNaN(minValue)) {
        query = query.gte("low_est", minValue);
      }
    }

    if (low_est_max && low_est_max !== "") {
      const maxValue = parseFloat(low_est_max as string);
      if (!isNaN(maxValue)) {
        query = query.lte("low_est", maxValue);
      }
    }

    if (high_est_min && high_est_min !== "") {
      const minValue = parseFloat(high_est_min as string);
      if (!isNaN(minValue)) {
        query = query.gte("high_est", minValue);
      }
    }

    if (high_est_max && high_est_max !== "") {
      const maxValue = parseFloat(high_est_max as string);
      if (!isNaN(maxValue)) {
        query = query.lte("high_est", maxValue);
      }
    }

    if (start_price_min && start_price_min !== "") {
      const minValue = parseFloat(start_price_min as string);
      if (!isNaN(minValue)) {
        query = query.gte("start_price", minValue);
      }
    }

    if (start_price_max && start_price_max !== "") {
      const maxValue = parseFloat(start_price_max as string);
      if (!isNaN(maxValue)) {
        query = query.lte("start_price", maxValue);
      }
    }

    // Apply condition filter
    if (condition && condition !== "") {
      query = query.ilike("condition", `%${condition}%`);
    }

    // Apply period_age filter
    if (period_age && period_age !== "") {
      query = query.ilike("period_age", `%${period_age}%`);
    }

    // Apply materials filter
    if (materials && materials !== "") {
      query = query.ilike("materials", `%${materials}%`);
    }

    // Apply artist_id filter
    if (artist_id && artist_id !== "") {
      const artistIdNum = parseInt(artist_id as string);
      if (!isNaN(artistIdNum)) {
        query = query.eq("artist_id", artistIdNum);
      }
    }

    // Apply school_id filter
    if (school_id && school_id !== "") {
      query = query.eq("school_id", school_id);
    }

    // Apply buyer_id filter
    if (buyer_id && buyer_id !== "") {
      const buyerIdNum = parseInt(buyer_id as string);
      if (!isNaN(buyerIdNum)) {
        query = query.eq("buyer_id", buyerIdNum);
      }
    }

    // Apply vendor_id filter
    if (vendor_id && vendor_id !== "") {
      const vendorIdNum = parseInt(vendor_id as string);
      if (!isNaN(vendorIdNum)) {
        query = query.eq("vendor_id", vendorIdNum);
      }
    }

    if (search) {
      const searchStr = String(search);
      const searchNum = parseInt(searchStr) || 0;

      // Enhanced search with variations handling using optional space patterns
      const searchTerms = preprocessSearchTerms(searchStr);

      // Build OR conditions for all search terms and variations
      const searchConditions: string[] = [];

      searchTerms.forEach((term) => {
        // Use ilike for each search term
        searchConditions.push(
          `title.ilike.%${term}%`,
          `description.ilike.%${term}%`,
          `artist_maker.ilike.%${term}%`,
          `materials.ilike.%${term}%`,
          `period_age.ilike.%${term}%`,
          `condition.ilike.%${term}%`,
          `category.ilike.%${term}%`,
          `subcategory.ilike.%${term}%`,
          `provenance.ilike.%${term}%`,
          `school_id.ilike.%${term}%`,
        );
      });

      // Add numeric search for IDs
      searchConditions.push(`id.eq.${searchNum}`, `artist_id.eq.${searchNum}`);

      query = query.or(searchConditions.join(","));

      console.log(
        `[SEARCH] Original term: "${searchStr}", Generated variations:`,
        searchTerms,
      );
    }

    // Apply brand filtering
    if (brand_code) {
      // First get the brand ID from the code
      const brandCodeStr = String(brand_code).toUpperCase();
      const { data: brandData } = await supabaseAdmin
        .from("brands")
        .select("id")
        .eq("code", brandCodeStr)
        .single();

      if (brandData?.id) {
        query = query.eq("brand_id", brandData.id);
      }
    }

    // Apply sorting
    query = query.order(sort_field as string, {
      ascending: sort_direction === "asc",
    });

    // Apply pagination only if pagination parameters are provided
    if (hasPagination && limitNum && pageNum) {
      const offset = (pageNum - 1) * limitNum;
      // Apply pagination - Supabase has a 1000 row limit per query
      query = query.range(offset, offset + limitNum - 1);
    }

    const { data: items, error, count } = await query;

    if (error) {
      console.error("Error fetching items:", error);
      return res.status(500).json({
        error: "Failed to fetch items",
        details: error.message,
      });
    }

    // Build count query with same filters as main query
    let countQuery = supabaseAdmin
      .from("items")
      .select("*", { count: "exact", head: true });

    // Apply same filtering to count query as main query
    if (item_ids) {
      const idsArray = item_ids
        .toString()
        .split(",")
        .map((id) => parseInt(id.trim()))
        .filter((id) => !isNaN(id));
      if (idsArray.length > 0) {
        countQuery = countQuery.in("id", idsArray);
      }
    }

    // Apply item_id filter to count query
    if (item_id && item_id !== "") {
      const itemIdNum = parseInt(item_id as string);
      if (!isNaN(itemIdNum)) {
        countQuery = countQuery.eq("id", itemIdNum);
      }
    }

    if (status && status !== "all" && status !== "") {
      countQuery = countQuery.eq("status", status);
    }

    if (category) {
      countQuery = countQuery.eq("category", category);
    }

    if (consignment_id) {
      countQuery = countQuery.eq("consignment_id", consignment_id);
    }

    // Apply price range filters to count query
    if (low_est_min && low_est_min !== "") {
      const minValue = parseFloat(low_est_min as string);
      if (!isNaN(minValue)) {
        countQuery = countQuery.gte("low_est", minValue);
      }
    }

    if (low_est_max && low_est_max !== "") {
      const maxValue = parseFloat(low_est_max as string);
      if (!isNaN(maxValue)) {
        countQuery = countQuery.lte("low_est", maxValue);
      }
    }

    if (high_est_min && high_est_min !== "") {
      const minValue = parseFloat(high_est_min as string);
      if (!isNaN(minValue)) {
        countQuery = countQuery.gte("high_est", minValue);
      }
    }

    if (high_est_max && high_est_max !== "") {
      const maxValue = parseFloat(high_est_max as string);
      if (!isNaN(maxValue)) {
        countQuery = countQuery.lte("high_est", maxValue);
      }
    }

    if (start_price_min && start_price_min !== "") {
      const minValue = parseFloat(start_price_min as string);
      if (!isNaN(minValue)) {
        countQuery = countQuery.gte("start_price", minValue);
      }
    }

    if (start_price_max && start_price_max !== "") {
      const maxValue = parseFloat(start_price_max as string);
      if (!isNaN(maxValue)) {
        countQuery = countQuery.lte("start_price", maxValue);
      }
    }

    // Apply condition filter to count query
    if (condition && condition !== "") {
      countQuery = countQuery.ilike("condition", `%${condition}%`);
    }

    // Apply period_age filter to count query
    if (period_age && period_age !== "") {
      countQuery = countQuery.ilike("period_age", `%${period_age}%`);
    }

    // Apply materials filter to count query
    if (materials && materials !== "") {
      countQuery = countQuery.ilike("materials", `%${materials}%`);
    }

    // Apply artist_id filter to count query
    if (artist_id && artist_id !== "") {
      const artistIdNum = parseInt(artist_id as string);
      if (!isNaN(artistIdNum)) {
        countQuery = countQuery.eq("artist_id", artistIdNum);
      }
    }

    // Apply school_id filter to count query
    if (school_id && school_id !== "") {
      countQuery = countQuery.eq("school_id", school_id);
    }

    // Apply buyer_id filter to count query
    if (buyer_id && buyer_id !== "") {
      const buyerIdNum = parseInt(buyer_id as string);
      if (!isNaN(buyerIdNum)) {
        countQuery = countQuery.eq("buyer_id", buyerIdNum);
      }
    }

    // Apply vendor_id filter to count query
    if (vendor_id && vendor_id !== "") {
      const vendorIdNum = parseInt(vendor_id as string);
      if (!isNaN(vendorIdNum)) {
        countQuery = countQuery.eq("vendor_id", vendorIdNum);
      }
    }

    if (search) {
      const searchStr = String(search);
      const searchNum = parseInt(searchStr) || 0;

      // Enhanced search with variations handling for count query
      const searchTerms = preprocessSearchTerms(searchStr);

      // Build OR conditions for all search terms and variations
      const searchConditions: string[] = [];

      searchTerms.forEach((term) => {
        searchConditions.push(
          `title.ilike.%${term}%`,
          `description.ilike.%${term}%`,
          `artist_maker.ilike.%${term}%`,
          `materials.ilike.%${term}%`,
          `period_age.ilike.%${term}%`,
          `condition.ilike.%${term}%`,
          `category.ilike.%${term}%`,
          `subcategory.ilike.%${term}%`,
          `provenance.ilike.%${term}%`,
          `school_id.ilike.%${term}%`,
        );
      });

      // Add numeric search for IDs
      searchConditions.push(`id.eq.${searchNum}`, `artist_id.eq.${searchNum}`);

      countQuery = countQuery.or(searchConditions.join(","));
    }

    // Apply brand filtering to count query
    let brandData: { id: number } | null = null;
    if (brand_code) {
      // First get the brand ID from the code
      const brandCodeStr = String(brand_code).toUpperCase();
      const { data: brandResult } = await supabaseAdmin
        .from("brands")
        .select("id")
        .eq("code", brandCodeStr)
        .single();

      brandData = brandResult;

      if (brandData?.id) {
        countQuery = countQuery.eq("brand_id", brandData.id);
      }
    }

    // Get total count for pagination
    const { count: totalCount } = await countQuery;

    // Calculate status counts by querying each status separately to avoid Supabase limits
    const statusTypes = [
      "draft",
      "active",
      "sold",
      "withdrawn",
      "passed",
      "returned",
    ];
    const statusCountsPromises = statusTypes.map(async (statusType) => {
      let statusQuery = supabaseAdmin
        .from("items")
        .select("*", { count: "exact", head: true })
        .eq("status", statusType);

      // Apply same filters
      if (item_ids) {
        const idsArray = item_ids
          .toString()
          .split(",")
          .map((id) => parseInt(id.trim()))
          .filter((id) => !isNaN(id));
        if (idsArray.length > 0) {
          statusQuery = statusQuery.in("id", idsArray);
        }
      }

      // Apply item_id filter to status count query
      if (item_id && item_id !== "") {
        const itemIdNum = parseInt(item_id as string);
        if (!isNaN(itemIdNum)) {
          statusQuery = statusQuery.eq("id", itemIdNum);
        }
      }

      if (category) {
        statusQuery = statusQuery.eq("category", category);
      }

      if (consignment_id) {
        statusQuery = statusQuery.eq("consignment_id", consignment_id);
      }

      // Apply price range filters to status count query
      if (low_est_min && low_est_min !== "") {
        const minValue = parseFloat(low_est_min as string);
        if (!isNaN(minValue)) {
          statusQuery = statusQuery.gte("low_est", minValue);
        }
      }

      if (low_est_max && low_est_max !== "") {
        const maxValue = parseFloat(low_est_max as string);
        if (!isNaN(maxValue)) {
          statusQuery = statusQuery.lte("low_est", maxValue);
        }
      }

      if (high_est_min && high_est_min !== "") {
        const minValue = parseFloat(high_est_min as string);
        if (!isNaN(minValue)) {
          statusQuery = statusQuery.gte("high_est", minValue);
        }
      }

      if (high_est_max && high_est_max !== "") {
        const maxValue = parseFloat(high_est_max as string);
        if (!isNaN(maxValue)) {
          statusQuery = statusQuery.lte("high_est", maxValue);
        }
      }

      if (start_price_min && start_price_min !== "") {
        const minValue = parseFloat(start_price_min as string);
        if (!isNaN(minValue)) {
          statusQuery = statusQuery.gte("start_price", minValue);
        }
      }

      if (start_price_max && start_price_max !== "") {
        const maxValue = parseFloat(start_price_max as string);
        if (!isNaN(maxValue)) {
          statusQuery = statusQuery.lte("start_price", maxValue);
        }
      }

      // Apply condition filter to status count query
      if (condition && condition !== "") {
        statusQuery = statusQuery.ilike("condition", `%${condition}%`);
      }

      // Apply period_age filter to status count query
      if (period_age && period_age !== "") {
        statusQuery = statusQuery.ilike("period_age", `%${period_age}%`);
      }

      // Apply materials filter to status count query
      if (materials && materials !== "") {
        statusQuery = statusQuery.ilike("materials", `%${materials}%`);
      }

      // Apply artist_id filter to status count query
      if (artist_id && artist_id !== "") {
        const artistIdNum = parseInt(artist_id as string);
        if (!isNaN(artistIdNum)) {
          statusQuery = statusQuery.eq("artist_id", artistIdNum);
        }
      }

      // Apply school_id filter to status count query
      if (school_id && school_id !== "") {
        statusQuery = statusQuery.eq("school_id", school_id);
      }

      // Apply buyer_id filter to status count query
      if (buyer_id && buyer_id !== "") {
        const buyerIdNum = parseInt(buyer_id as string);
        if (!isNaN(buyerIdNum)) {
          statusQuery = statusQuery.eq("buyer_id", buyerIdNum);
        }
      }

      // Apply vendor_id filter to status count query
      if (vendor_id && vendor_id !== "") {
        const vendorIdNum = parseInt(vendor_id as string);
        if (!isNaN(vendorIdNum)) {
          statusQuery = statusQuery.eq("vendor_id", vendorIdNum);
        }
      }

      if (search) {
        const searchStr = String(search);
        const searchNum = parseInt(searchStr) || 0;

        // Enhanced search with variations handling for status count queries
        const searchTerms = preprocessSearchTerms(searchStr);

        // Build OR conditions for all search terms and variations
        const searchConditions: string[] = [];

        searchTerms.forEach((term) => {
          searchConditions.push(
            `title.ilike.%${term}%`,
            `description.ilike.%${term}%`,
            `artist_maker.ilike.%${term}%`,
            `materials.ilike.%${term}%`,
            `period_age.ilike.%${term}%`,
            `condition.ilike.%${term}%`,
            `category.ilike.%${term}%`,
            `subcategory.ilike.%${term}%`,
            `provenance.ilike.%${term}%`,
            `school_id.ilike.%${term}%`,
          );
        });

        // Add numeric search for IDs
        searchConditions.push(
          `id.eq.${searchNum}`,
          `artist_id.eq.${searchNum}`,
        );

        statusQuery = statusQuery.or(searchConditions.join(","));
      }

      if (brandData?.id) {
        statusQuery = statusQuery.eq("brand_id", brandData.id);
      }

      const { count } = await statusQuery;
      return { status: statusType, count: count || 0 };
    });

    const statusCountsResults = await Promise.all(statusCountsPromises);

    const counts = {
      draft: 0,
      active: 0,
      sold: 0,
      withdrawn: 0,
      passed: 0,
      returned: 0,
    };

    // Process the status count results
    statusCountsResults.forEach((result) => {
      counts[result.status as keyof typeof counts] = result.count;
    });

    const responseData = {
      success: true,
      data: items,
      ...(hasPagination
        ? {
            pagination: {
              page: pageNum,
              limit: limitNum,
              total: totalCount || 0,
              pages: Math.ceil((totalCount || 0) / (limitNum || 1)),
            },
          }
        : {}),
      counts,
    };

    res.json(responseData);
  } catch (error: any) {
    console.error("Error in GET /items:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// GET /api/items/:id/auctions - List auctions that include this item (via auctions.artwork_ids)
router.get("/:id/auctions", async (req, res) => {
  try {
    const { id } = req.params;
    const itemIdNum = parseInt(id, 10);
    if (Number.isNaN(itemIdNum) || itemIdNum <= 0) {
      return res.status(400).json({ success: false, error: "Invalid item id" });
    }

    const { data: auctions, error } = await supabaseAdmin
      .from("auctions")
      .select(
        `
        id,
        short_name,
        long_name,
        settlement_date,
        brand:brand_id(id, code, name)
      `,
      )
      .contains("artwork_ids", [itemIdNum])
      .order("settlement_date", { ascending: false });

    if (error) {
      console.error("Error fetching auctions for item:", error);
      return res
        .status(500)
        .json({
          success: false,
          error: "Failed to fetch auctions for item",
          details: error.message,
        });
    }

    return res.json({ success: true, auctions: auctions || [] });
  } catch (error: any) {
    console.error("Error in GET /items/:id/auctions:", error);
    return res
      .status(500)
      .json({
        success: false,
        error: "Internal server error",
        details: error.message,
      });
  }
});

// GET /api/items/:id - Get specific item
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: item, error } = await supabaseAdmin
      .from("items")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "Item not found" });
      }
      console.error("Error fetching item:", error);
      return res.status(500).json({
        error: "Failed to fetch item",
        details: error.message,
      });
    }

    res.json({
      success: true,
      data: item,
    });
  } catch (error: any) {
    console.error("Error in GET /items/:id:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/items - Create new item
router.post("/", async (req, res) => {
  try {
    const itemData: Item = req.body;
    const userId = (req as any).user?.id;

    // Validate required fields
    if (!itemData.title || !itemData.description) {
      return res.status(400).json({
        error: "Title and description are required",
      });
    }

    if (!itemData.low_est || !itemData.high_est) {
      return res.status(400).json({
        error: "Low estimate and high estimate are required",
      });
    }

    // Validate estimates
    if (itemData.low_est >= itemData.high_est) {
      return res.status(400).json({
        error: "High estimate must be greater than low estimate",
      });
    }

    if (itemData.start_price && itemData.start_price > itemData.low_est) {
      return res.status(400).json({
        error: "Start price cannot be greater than low estimate",
      });
    }

    // Set default start price if not provided (50% of low estimate)
    if (!itemData.start_price) {
      itemData.start_price = Math.round(itemData.low_est * 0.5);
    }

    // Add audit fields
    const newItem = {
      ...itemData,
      status: itemData.status || "draft",
    };

    const { data: item, error } = await supabaseAdmin
      .from("items")
      .insert([newItem])
      .select()
      .single();

    if (error) {
      console.error("Error creating item:", error);
      return res.status(500).json({
        error: "Failed to create item",
        details: error.message,
      });
    }

    // Auto-sync to Google Sheets if configured
    if (item?.id) {
      // Auto-sync disabled for now
    }

    res.status(201).json({
      success: true,
      data: item,
      message: "Item created successfully",
    });
  } catch (error: any) {
    console.error("Error in POST /items:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// PUT /api/items/:id - Update item
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const itemData: Partial<Item> = req.body;
    const userId = (req as any).user?.id;

    // Check if item exists
    const { data: existingItem, error: fetchError } = await supabaseAdmin
      .from("items")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError || !existingItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    // Validate estimates if provided
    const low_est = itemData.low_est ?? existingItem.low_est;
    const high_est = itemData.high_est ?? existingItem.high_est;
    const start_price = itemData.start_price ?? existingItem.start_price;

    if (low_est >= high_est) {
      return res.status(400).json({
        error: "High estimate must be greater than low estimate",
      });
    }

    if (start_price && start_price > low_est) {
      return res.status(400).json({
        error: "Start price cannot be greater than low estimate",
      });
    }

    // Apply update data
    const updateData = {
      ...itemData,
    };

    const { data: item, error } = await supabaseAdmin
      .from("items")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Error updating item:", error);
      return res.status(500).json({
        error: "Failed to update item",
        details: error.message,
      });
    }

    // Auto-sync to Google Sheets if configured
    if (item?.id) {
      // Auto-sync disabled for now
    }

    res.json({
      success: true,
      data: item,
      message: "Item updated successfully",
    });
  } catch (error: any) {
    console.error("Error in PUT /items/:id:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// DELETE /api/items/:id - Delete item (soft delete)
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { hard_delete = false } = req.query;
    const userId = (req as any).user?.id;

    if (hard_delete === "true") {
      // Hard delete - permanently remove from database
      const { error } = await supabaseAdmin.from("items").delete().eq("id", id);

      if (error) {
        console.error("Error hard deleting item:", error);
        return res.status(500).json({
          error: "Failed to delete item",
          details: error.message,
        });
      }

      res.json({
        success: true,
        message: "Item permanently deleted",
      });
    } else {
      // Soft delete - update status to withdrawn
      const { data: item, error } = await supabaseAdmin
        .from("items")
        .update({
          status: "withdrawn",
        })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        console.error("Error soft deleting item:", error);
        return res.status(500).json({
          error: "Failed to delete item",
          details: error.message,
        });
      }

      res.json({
        success: true,
        data: item,
        message: "Item marked as withdrawn",
      });
    }
  } catch (error: any) {
    console.error("Error in DELETE /items/:id:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/items/bulk-action - Bulk operations
router.post("/bulk-action", async (req, res) => {
  try {
    const { action, item_ids, data } = req.body;
    const userId = (req as any).user?.id;

    if (!item_ids || !Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({ error: "Item IDs are required" });
    }

    // Sort item IDs by ascending order to ensure consistent processing
    const sortedItemIds = item_ids
      .map((id) => parseInt(id.toString()))
      .filter((id) => !isNaN(id))
      .sort((a, b) => a - b);

    let result;
    let message = "";

    switch (action) {
      case "delete":
        result = await supabaseAdmin
          .from("items")
          .update({
            status: "withdrawn",
          })
          .in("id", sortedItemIds);
        message = `${sortedItemIds.length} items marked as withdrawn`;
        break;

      case "update_status":
        if (!data?.status) {
          return res
            .status(400)
            .json({ error: "Status is required for update_status action" });
        }
        result = await supabaseAdmin
          .from("items")
          .update({
            status: data.status,
          })
          .in("id", sortedItemIds);
        message = `${sortedItemIds.length} items updated to ${data.status} status`;
        break;

      default:
        return res.status(400).json({ error: "Invalid action" });
    }

    if (result.error) {
      console.error("Error in bulk action:", result.error);
      return res.status(500).json({
        error: "Failed to perform bulk action",
        details: result.error.message,
      });
    }

    res.json({
      success: true,
      message,
      affected_count: sortedItemIds.length,
    });
  } catch (error: any) {
    console.error("Error in POST /items/bulk-action:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/items/detect-duplicates - Detect duplicate images among items
router.post("/detect-duplicates", async (req, res) => {
  try {
    const {
      brand_code,
      similarity_threshold = 0.8,
      status_filter = ["draft", "active"],
      search,
      // New filter parameters for duplicate detection
      item_id,
      item_id_filter, // Support for ranges like "1-10" or "1,5,12"
      category,
      low_est_min,
      low_est_max,
      high_est_min,
      high_est_max,
      start_price_min,
      start_price_max,
      condition,
      period_age,
      materials,
      artist_id,
      school_id,
      buyer_id,
      vendor_id,
    } = req.body;

    console.log("Duplicate detection request:", {
      brand_code,
      similarity_threshold,
      status_filter,
    });

    // Import image processing utilities
    const {
      getBatchImageHashes,
      getValidImageUrls,
      getImagePerceptualHash,
      comparePerceptualHashes,
    } = await import("../utils/image-processing");

    // Resolve brand filter if provided
    let brandIdForFilter: number | null = null;
    if (brand_code) {
      const brandCodeStr = String(brand_code).toUpperCase();
      const { data: brandData } = await supabaseAdmin
        .from("brands")
        .select("id")
        .eq("code", brandCodeStr)
        .single();
      if (brandData?.id) brandIdForFilter = brandData.id;
    }

    // Only include items with images - fetch all items using batching to work around Supabase's 1000-row limit
    const baseQuery = supabaseAdmin
      .from("items")
      .select("id, title, images, status, created_at, brand_id")
      .not("images", "is", null)
      .neq("images", "{}");

    // Apply all the same filters to the base query
    if (
      status_filter &&
      Array.isArray(status_filter) &&
      status_filter.length > 0
    ) {
      baseQuery.in("status", status_filter);
    }

    // Apply item_id filter
    if (item_id && item_id !== "") {
      const itemIdNum = parseInt(item_id as string);
      if (!isNaN(itemIdNum)) {
        baseQuery.eq("id", itemIdNum);
      }
    }

    // Apply item_id_filter for ranges like "1-10" or "1,5,12"
    if (item_id_filter && item_id_filter.trim() !== "") {
      const filterStr = item_id_filter.trim();
      const itemIds: number[] = [];

      // Handle comma-separated values
      const parts = filterStr.split(",").map((part: string) => part.trim());

      parts.forEach((part: string) => {
        if (part.includes("-")) {
          // Handle ranges like "1-10"
          const [start, end] = part
            .split("-")
            .map((s: string) => parseInt(s.trim()));
          if (!isNaN(start) && !isNaN(end) && start <= end) {
            for (let i = start; i <= end; i++) {
              itemIds.push(i);
            }
          }
        } else {
          // Handle single values
          const singleId = parseInt(part);
          if (!isNaN(singleId)) {
            itemIds.push(singleId);
          }
        }
      });

      if (itemIds.length > 0) {
        baseQuery.in("id", itemIds);
      }
    }

    // Apply category filter
    if (category && category !== "") {
      baseQuery.ilike("category", `%${category}%`);
    }

    // Apply price filters
    if (low_est_min && low_est_min !== "") {
      const minValue = parseFloat(low_est_min as string);
      if (!isNaN(minValue)) {
        baseQuery.gte("low_est", minValue);
      }
    }

    if (low_est_max && low_est_max !== "") {
      const maxValue = parseFloat(low_est_max as string);
      if (!isNaN(maxValue)) {
        baseQuery.lte("low_est", maxValue);
      }
    }

    if (high_est_min && high_est_min !== "") {
      const minValue = parseFloat(high_est_min as string);
      if (!isNaN(minValue)) {
        baseQuery.gte("high_est", minValue);
      }
    }

    if (high_est_max && high_est_max !== "") {
      const maxValue = parseFloat(high_est_max as string);
      if (!isNaN(maxValue)) {
        baseQuery.lte("high_est", maxValue);
      }
    }

    if (start_price_min && start_price_min !== "") {
      const minValue = parseFloat(start_price_min as string);
      if (!isNaN(minValue)) {
        baseQuery.gte("start_price", minValue);
      }
    }

    if (start_price_max && start_price_max !== "") {
      const maxValue = parseFloat(start_price_max as string);
      if (!isNaN(maxValue)) {
        baseQuery.lte("start_price", maxValue);
      }
    }

    // Apply condition, period_age, materials filters
    if (condition && condition !== "") {
      baseQuery.ilike("condition", `%${condition}%`);
    }

    if (period_age && period_age !== "") {
      baseQuery.ilike("period_age", `%${period_age}%`);
    }

    if (materials && materials !== "") {
      baseQuery.ilike("materials", `%${materials}%`);
    }

    // Apply artist and school filters
    if (artist_id && artist_id !== "") {
      const artistIdNum = parseInt(artist_id as string);
      if (!isNaN(artistIdNum)) {
        baseQuery.eq("artist_id", artistIdNum);
      }
    }

    if (school_id && school_id !== "") {
      baseQuery.eq("school_id", school_id);
    }

    // Apply buyer_id filter
    if (buyer_id && buyer_id !== "") {
      const buyerIdNum = parseInt(buyer_id as string);
      if (!isNaN(buyerIdNum)) {
        baseQuery.eq("buyer_id", buyerIdNum);
      }
    }

    // Apply vendor_id filter
    if (vendor_id && vendor_id !== "") {
      const vendorIdNum = parseInt(vendor_id as string);
      if (!isNaN(vendorIdNum)) {
        baseQuery.eq("vendor_id", vendorIdNum);
      }
    }

    // Apply search filter for duplicate detection
    if (search) {
      const searchStr = String(search);
      const searchNum = parseInt(searchStr) || 0;

      // Enhanced search with variations handling for duplicate detection
      const searchTerms = preprocessSearchTerms(searchStr);

      // Build OR conditions for all search terms and variations
      const searchConditions: string[] = [];

      searchTerms.forEach((term) => {
        searchConditions.push(
          `title.ilike.%${term}%`,
          `description.ilike.%${term}%`,
          `artist_maker.ilike.%${term}%`,
          `materials.ilike.%${term}%`,
          `period_age.ilike.%${term}%`,
          `condition.ilike.%${term}%`,
          `category.ilike.%${term}%`,
          `subcategory.ilike.%${term}%`,
          `provenance.ilike.%${term}%`,
          `school_id.ilike.%${term}%`,
        );
      });

      // Add numeric search for IDs
      searchConditions.push(`id.eq.${searchNum}`, `artist_id.eq.${searchNum}`);

      baseQuery.or(searchConditions.join(","), { foreignTable: undefined });
    }

    // Apply brand filter last (if provided)
    if (brandIdForFilter) {
      baseQuery.eq("brand_id", brandIdForFilter);
    }

    // First, get the total count
    const { count: totalCount, error: countError } = await supabaseAdmin
      .from("items")
      .select("id", { count: "exact", head: true })
      .not("images", "is", null)
      .neq("images", "{}");

    if (countError) {
      console.error("Count query error:", countError);
    }

    console.log(`Total items with images: ${totalCount || "unknown"}`);

    // Fetch all items using batching
    const BATCH_SIZE = 1000;
    let allItems: any[] = [];
    let offset = 0;

    console.log("Fetching items in batches...");

    while (true) {
      const { data: batch, error: batchError } = await baseQuery
        .range(offset, offset + BATCH_SIZE - 1)
        .select("id, title, images, status, created_at, brand_id");

      if (batchError) {
        console.error("Batch query error:", batchError);
        return res.status(500).json({
          success: false,
          error: "Failed to fetch items batch for duplicate detection",
          details: batchError.message,
        });
      }

      if (!batch || batch.length === 0) {
        break;
      }

      allItems = allItems.concat(batch);
      console.log(
        `Fetched batch ${Math.floor(offset / BATCH_SIZE) + 1}: ${batch.length} items (total: ${allItems.length})`,
      );

      offset += BATCH_SIZE;

      // Safety break if we somehow get stuck
      if (offset > 10000) {
        console.warn("⚠️  Safety break: fetched more than 10,000 items");
        break;
      }
    }

    console.log(
      `✅ Total items fetched for duplicate detection: ${allItems.length}`,
    );

    const items = allItems;

    if (!items || items.length === 0) {
      return res.json({
        success: true,
        duplicates: [],
        total_groups: 0,
        total_items_checked: 0,
      });
    }

    // Enhanced duplicate detection logic with actual image byte comparison
    console.log(
      "🔍 Starting enhanced duplicate detection with image byte comparison...",
    );

    // Step 1: Group items by title first (efficient text matching)
    console.log(
      "📝 Step 1: Grouping items by title for efficient processing...",
    );
    const titleGroups = new Map<string, any[]>();
    const itemToFirstImageUrl = new Map<string, string>();

    for (const item of items) {
      const validImageUrls = getValidImageUrls(item.images);
      if (validImageUrls.length > 0) {
        const title = (item.title || "").trim().toLowerCase();
        const firstImageUrl = validImageUrls[0];
        itemToFirstImageUrl.set(item.id, firstImageUrl);

        // Group by title, but also include items without titles in a special "no_title" group
        const groupKey = title || "__no_title__";
        if (!titleGroups.has(groupKey)) {
          titleGroups.set(groupKey, []);
        }
        titleGroups.get(groupKey)!.push(item);
      }
    }

    console.log(
      `📊 Found ${titleGroups.size} unique titles from ${items.length} items`,
    );

    // Step 2: Process each title group separately
    const allDuplicateGroups: any[] = [];
    const processedItems = new Set<string>();
    let totalImageComparisons = 0;

    for (const [title, titleItems] of titleGroups.entries()) {
      if (titleItems.length < 2) continue; // Skip titles with only one item

      const displayTitle =
        title === "__no_title__" ? "[No Title]" : `"${title}"`;
      console.log(
        `🔍 Processing title group: ${displayTitle} (${titleItems.length} items)`,
      );

      // Collect first image URLs within this title group
      const imageUrlToItems = new Map<string, any[]>();
      for (const item of titleItems) {
        const firstImageUrl = itemToFirstImageUrl.get(item.id);
        if (firstImageUrl) {
          if (!imageUrlToItems.has(firstImageUrl)) {
            imageUrlToItems.set(firstImageUrl, []);
          }
          imageUrlToItems.get(firstImageUrl)!.push(item);
        }
      }

      const titleImageUrls = Array.from(imageUrlToItems.keys());
      console.log(
        `🖼️ Found ${titleImageUrls.length} unique first images in title group: "${title}"`,
      );

      // Step 3: Download and hash images for this title group only
      console.log(
        `🔄 Downloading and hashing ${titleImageUrls.length} images for title: "${title}"...`,
      );
      const imageHashes = await getBatchImageHashes(titleImageUrls, 3);

      // Step 4: Group items by image hash (exact duplicates within this title group)
      console.log(`🔍 Grouping items by image hash for title: "${title}"...`);
      const hashToItems = new Map<string, any[]>();
      const urlToHash = new Map<string, string>();

      for (const [url, hashResult] of imageHashes.entries()) {
        if (hashResult.success && hashResult.hash) {
          urlToHash.set(url, hashResult.hash);

          const itemsWithThisImage = imageUrlToItems.get(url) || [];
          for (const item of itemsWithThisImage) {
            if (!hashToItems.has(hashResult.hash)) {
              hashToItems.set(hashResult.hash, []);
            }

            // Only add item if not already in this hash group
            if (
              !hashToItems
                .get(hashResult.hash)!
                .find((existing) => existing.id === item.id)
            ) {
              hashToItems.get(hashResult.hash)!.push(item);
            }
          }
        }

        // Step 5: Create exact duplicate groups based on hash within this title group
        console.log(
          `✅ Creating exact duplicate groups for title: "${title}"...`,
        );
        const titleExactGroups: any[] = [];

        for (const [hash, itemsWithSameHash] of hashToItems.entries()) {
          if (itemsWithSameHash.length > 1) {
            // Sort by priority: sold/returned first, then by creation date
            const sortedItems = itemsWithSameHash.sort((a, b) => {
              const priorityOrder = {
                sold: 1,
                returned: 2,
                withdrawn: 3,
                passed: 4,
                active: 5,
                draft: 6,
              };
              const aPriority =
                priorityOrder[a.status as keyof typeof priorityOrder] || 99;
              const bPriority =
                priorityOrder[b.status as keyof typeof priorityOrder] || 99;

              if (aPriority !== bPriority) {
                return aPriority - bPriority; // Lower number = higher priority
              }
              // If same status, prefer older items (created first)
              return (
                new Date(a.created_at || 0).getTime() -
                new Date(b.created_at || 0).getTime()
              );
            });

            const groupItems = sortedItems.filter((item) => {
              if (processedItems.has(item.id)) return false;
              processedItems.add(item.id);
              return true;
            });

            if (groupItems.length > 1) {
              const safeTitle =
                title === "__no_title__"
                  ? "no_title"
                  : title.replace(/\s+/g, "_");
              titleExactGroups.push({
                group_id: `title_${safeTitle}_exact_hash_${titleExactGroups.length + 1}`,
                type: "exact_image",
                match_value: `Title: ${title === "__no_title__" ? "[No Title]" : `"${title}"`} + Hash: ${hash.substring(0, 8)}...`,
                similarity_score: 1.0,
                items: groupItems.map((item) => ({
                  id: item.id,
                  title: item.title,
                  lot_num: item.lot_num,
                  image_url: itemToFirstImageUrl.get(item.id) || "",
                  status: item.status,
                  created_at: item.created_at,
                  image_hash: hash,
                })),
              });
            }
          }
        }

        // Step 6: Find similar images using perceptual hashing within this title group
        console.log(
          `🔍 Finding similar images using perceptual hashing for title: "${title}"...`,
        );

        // Get perceptual hashes for remaining unprocessed images in this title group
        const remainingUrls = titleImageUrls.filter((url) => {
          const itemsWithUrl = imageUrlToItems.get(url) || [];
          return itemsWithUrl.some((item) => !processedItems.has(item.id));
        });

        if (remainingUrls.length < 2) {
          // Add exact groups from this title and continue to next title
          allDuplicateGroups.push(...titleExactGroups);
          continue;
        }

        console.log(
          `🎨 Processing ${remainingUrls.length} remaining images for perceptual hashing in title: "${title}"...`,
        );

        // Process perceptual hashes in smaller batches to avoid memory issues
        const perceptualHashes = new Map<string, string>();
        const batchSize = 10;

        for (let i = 0; i < remainingUrls.length; i += batchSize) {
          const batch = remainingUrls.slice(i, i + batchSize);
          console.log(
            `🔄 Processing perceptual hash batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(remainingUrls.length / batchSize)} for title: "${title}"`,
          );

          const batchPromises = batch.map(async (url) => {
            try {
              const result = await getImagePerceptualHash(url);
              if (result.success && result.hash) {
                perceptualHashes.set(url, result.hash);
              }
            } catch (error) {
              console.warn(`Failed to get perceptual hash for ${url}:`, error);
            }
          });

          await Promise.all(batchPromises);
        }

        // Step 7: Find similar images based on perceptual hash within this title group
        const processedUrls = new Set<string>();
        const titleSimilarGroups: any[] = [];
        let lastSimilarityComparison: any = null; // Store the last comparison for group creation

        for (let i = 0; i < remainingUrls.length; i++) {
          const url1 = remainingUrls[i];
          if (processedUrls.has(url1)) continue;

          const hash1 = perceptualHashes.get(url1);
          if (!hash1) continue;

          const items1 = imageUrlToItems.get(url1) || [];
          const unprocessedItems1 = items1.filter(
            (item) => !processedItems.has(item.id),
          );

          if (unprocessedItems1.length === 0) continue;

          const similarItems = [...unprocessedItems1];

          // Compare with remaining URLs
          for (let j = i + 1; j < remainingUrls.length; j++) {
            const url2 = remainingUrls[j];
            if (processedUrls.has(url2)) continue;

            const hash2 = perceptualHashes.get(url2);
            if (!hash2) continue;

            const items2 = imageUrlToItems.get(url2) || [];
            const unprocessedItems2 = items2.filter(
              (item) => !processedItems.has(item.id),
            );

            if (unprocessedItems2.length === 0) continue;

            // Compare perceptual hashes
            const similarityComparison = comparePerceptualHashes(hash1, hash2);
            lastSimilarityComparison = similarityComparison; // Store for later use

            if (similarityComparison.similarity >= similarity_threshold) {
              similarItems.push(...unprocessedItems2);
              processedUrls.add(url2);

              // Mark items as processed
              unprocessedItems2.forEach((item) => processedItems.add(item.id));
            }
          }

          // Create similar group if we have multiple items
          if (similarItems.length > 1) {
            // Remove duplicates from similarItems
            const uniqueItems = similarItems.filter(
              (item, index, self) =>
                index === self.findIndex((i) => i.id === item.id),
            );

            if (uniqueItems.length > 1) {
              const safeTitle =
                title === "__no_title__"
                  ? "no_title"
                  : title.replace(/\s+/g, "_");
              titleSimilarGroups.push({
                group_id: `title_${safeTitle}_similar_${titleSimilarGroups.length + 1}`,
                type: "similar",
                match_value: `Title: ${title === "__no_title__" ? "[No Title]" : `"${title}"`} + Perceptual similarity: ${Math.round((lastSimilarityComparison?.similarity || 0) * 100)}%`,
                similarity_score: lastSimilarityComparison?.similarity || 0,
                items: uniqueItems.map((item) => ({
                  id: item.id,
                  title: item.title,
                  lot_num: item.lot_num,
                  image_url: itemToFirstImageUrl.get(item.id) || "",
                  status: item.status,
                  created_at: item.created_at,
                  perceptual_hash: hash1,
                })),
              });
            }
          }

          processedUrls.add(url1);
          unprocessedItems1.forEach((item) => processedItems.add(item.id));
        }

        // Add groups from this title
        allDuplicateGroups.push(...titleExactGroups, ...titleSimilarGroups);
        totalImageComparisons += perceptualHashes.size; // Count perceptual hash operations
      }
    }

    // Step 3: Cross-title duplicate detection - find exact duplicates across different titles
    console.log("🔍 Step 3: Finding cross-title exact duplicates...");
    const crossTitleDuplicates: any[] = [];

    // Group all items by their image hash, regardless of title
    const globalHashToItems = new Map<string, any[]>();
    const unprocessedGlobalItems = items.filter(
      (item) => !processedItems.has(item.id),
    );

    console.log(
      `📸 Processing ${unprocessedGlobalItems.length} remaining items for cross-title duplicates...`,
    );

    if (unprocessedGlobalItems.length > 0) {
      // Get all first image URLs from unprocessed items
      const allRemainingUrls = unprocessedGlobalItems
        .map((item) => itemToFirstImageUrl.get(item.id))
        .filter((url) => url) as string[];

      console.log(
        `🖼️ Downloading and hashing ${allRemainingUrls.length} images for cross-title comparison...`,
      );

      // Batch process all remaining images
      const globalImageHashes = await getBatchImageHashes(allRemainingUrls, 3);

      // Group by hash across all titles
      for (const [url, hashResult] of globalImageHashes.entries()) {
        if (hashResult.success && hashResult.hash) {
          if (!globalHashToItems.has(hashResult.hash)) {
            globalHashToItems.set(hashResult.hash, []);
          }

          // Find items that have this URL as their first image
          const itemsWithThisUrl = unprocessedGlobalItems.filter(
            (item) => itemToFirstImageUrl.get(item.id) === url,
          );

          globalHashToItems.get(hashResult.hash)!.push(...itemsWithThisUrl);
        }
      }

      // Create cross-title duplicate groups
      for (const [hash, itemsWithSameHash] of globalHashToItems.entries()) {
        if (itemsWithSameHash.length > 1) {
          // Mark all items in this group as processed
          itemsWithSameHash.forEach((item) => processedItems.add(item.id));

          // Sort by priority: sold/returned first, then by creation date
          const sortedItems = itemsWithSameHash.sort((a, b) => {
            const priorityOrder = {
              sold: 1,
              returned: 2,
              withdrawn: 3,
              passed: 4,
              active: 5,
              draft: 6,
            };
            const aPriority =
              priorityOrder[a.status as keyof typeof priorityOrder] || 99;
            const bPriority =
              priorityOrder[b.status as keyof typeof priorityOrder] || 99;

            if (aPriority !== bPriority) {
              return aPriority - bPriority; // Lower number = higher priority
            }
            // If same status, prefer older items (created first)
            return (
              new Date(a.created_at || 0).getTime() -
              new Date(b.created_at || 0).getTime()
            );
          });

          crossTitleDuplicates.push({
            group_id: `cross_title_exact_hash_${crossTitleDuplicates.length + 1}`,
            type: "exact_image",
            match_value: `Cross-title exact match + Hash: ${hash.substring(0, 8)}...`,
            similarity_score: 1.0,
            items: sortedItems.map((item) => ({
              id: item.id,
              title: item.title,
              lot_num: item.lot_num,
              image_url: itemToFirstImageUrl.get(item.id) || "",
              status: item.status,
              created_at: item.created_at,
              image_hash: hash,
            })),
          });
        }
      }

      console.log(
        `🔗 Found ${crossTitleDuplicates.length} cross-title duplicate groups`,
      );
    }

    // Add cross-title duplicates to all groups
    allDuplicateGroups.push(...crossTitleDuplicates);

    console.log(`✅ Completed efficient duplicate detection:`);
    console.log(`   - ${totalImageComparisons} image processing operations`);
    console.log(
      `   - ${allDuplicateGroups.length} total duplicate groups found (${crossTitleDuplicates.length} cross-title)`,
    );

    // Count exact and similar groups
    const exactGroups = allDuplicateGroups.filter(
      (g) => g.type === "exact_image",
    );
    const similarGroups = allDuplicateGroups.filter(
      (g) => g.type === "similar",
    );

    return res.json({
      success: true,
      duplicates: allDuplicateGroups,
      total_groups: allDuplicateGroups.length,
      total_items_checked: items.length,
      exact_groups: exactGroups.length,
      similar_groups: similarGroups.length,
    });
  } catch (error: any) {
    console.error("Error in POST /items/detect-duplicates:", error);
    res.status(500).json({
      success: false,
      error: "Failed to detect duplicates",
      details: error.message,
    });
  }
});

// Enhanced search preprocessing with optional space patterns
function preprocessSearchTerms(searchString: string): string[] {
  const terms: Set<string> = new Set();
  const originalTerm = searchString.trim().toLowerCase();

  if (!originalTerm) return [];

  // Add the original term
  terms.add(originalTerm);

  // Handle space variations using optional space patterns
  const words = originalTerm.split(/\s+/);

  if (words.length > 1) {
    // If multiple words, also add as one word (e.g., "water color" -> "watercolor")
    terms.add(words.join(""));
  } else if (words.length === 1) {
    // If single word, try to match compound word patterns with optional spaces
    const singleWord = words[0];

    // Common art/material compound word patterns with optional spaces
    const compoundPatterns = [
      // Color compounds - match both "watercolor" and "water color"
      {
        pattern: /^water\s*(color|colour)s?$/i,
        replacement: "water ?(color|colour)s?",
      },
      {
        pattern: /^oil\s*(paint|painting)s?$/i,
        replacement: "oil ?(paint|painting)s?",
      },
      {
        pattern: /^acrylic\s*(paint|painting)s?$/i,
        replacement: "acrylic ?(paint|painting)s?",
      },
      { pattern: /^mixed\s*media$/i, replacement: "mixed ?media" },
      { pattern: /^fine\s*art$/i, replacement: "fine ?art" },
      {
        pattern: /^hand\s*(made|painted|carved)$/i,
        replacement: "hand ?(made|painted|carved)",
      },
      {
        pattern: /^antique\s*(furniture|art)$/i,
        replacement: "antique ?(furniture|art)",
      },
      // Material compounds
      { pattern: /^hard\s*stone$/i, replacement: "hard ?stone" },
      { pattern: /^jade\s*ite$/i, replacement: "jade ?ite" },
      { pattern: /^mixed\s*metal$/i, replacement: "mixed ?metal" },
      { pattern: /^brass\s*bronze$/i, replacement: "brass ?bronze" },
      // Period compounds
      {
        pattern: /^early\s*(20th|twentieth)\s*century$/i,
        replacement: "early ?(20th|twentieth) ?century",
      },
      {
        pattern: /^mid\s*(20th|twentieth)\s*century$/i,
        replacement: "mid ?(20th|twentieth) ?century",
      },
      {
        pattern: /^late\s*(20th|twentieth)\s*century$/i,
        replacement: "late ?(20th|twentieth) ?century",
      },
    ];

    for (const { pattern, replacement } of compoundPatterns) {
      if (pattern.test(singleWord)) {
        // Add the spaced version
        const spacedVersion = singleWord.replace(
          pattern,
          (match, ...groups) => {
            return replacement
              .replace(/\?(\w+)/g, (match2, word) => ` ${word}`)
              .trim();
          },
        );
        if (spacedVersion !== singleWord) {
          terms.add(spacedVersion);
        }
        break;
      }
    }

    // Generic approach: try common splitting points with optional spaces
    const commonSplitPoints = [
      "color",
      "paint",
      "work",
      "art",
      "ware",
      "stone",
      "wood",
      "metal",
      "century",
    ];
    for (const splitPoint of commonSplitPoints) {
      if (singleWord.includes(splitPoint) && singleWord !== splitPoint) {
        const index = singleWord.indexOf(splitPoint);
        if (index > 0) {
          const firstPart = singleWord.substring(0, index);
          const secondPart = singleWord.substring(index);
          if (firstPart.length > 1 && secondPart.length > 1) {
            terms.add(`${firstPart} ${secondPart}`);
          }
        }
      }
    }
  }

  // Handle common spelling variations
  const variations = new Map([
    ["colour", "color"],
    ["color", "colour"],
    ["grey", "gray"],
    ["gray", "grey"],
    ["centre", "center"],
    ["center", "centre"],
  ]);

  Array.from(terms).forEach((term) => {
    variations.forEach((replacement, original) => {
      if (term.includes(original)) {
        terms.add(term.replace(new RegExp(original, "g"), replacement));
      }
    });
  });

  return Array.from(terms);
}

// Generate regex patterns for optional space matching
function generateSearchPatterns(searchString: string): string[] {
  const patterns: string[] = [];
  const originalTerm = searchString.trim().toLowerCase();

  if (!originalTerm) return [originalTerm];

  // Add exact match
  patterns.push(originalTerm);

  // Handle compound words with optional spaces
  const compoundPatterns = [
    // Convert "watercolor" to match "water color" or "watercolor"
    { regex: /^water(color|colour)s?$/i, pattern: "water ?$1s?" },
    { regex: /^oil(paint|painting)s?$/i, pattern: "oil ?$1s?" },
    { regex: /^acrylic(paint|painting)s?$/i, pattern: "acrylic ?$1s?" },
    { regex: /^mixedmedia$/i, pattern: "mixed ?media" },
    { regex: /^fineart$/i, pattern: "fine ?art" },
    { regex: /^hand(made|painted|carved)$/i, pattern: "hand ?$1" },
    { regex: /^antique(furniture|art)$/i, pattern: "antique ?$1" },
    { regex: /^hardstone$/i, pattern: "hard ?stone" },
    { regex: /^mixedmetal$/i, pattern: "mixed ?metal" },
    // Handle multi-word to compound conversion
    { regex: /^water\s*(color|colour)s?$/i, pattern: "water$1s?" },
    { regex: /^oil\s*(paint|painting)s?$/i, pattern: "oil$1s?" },
    { regex: /^acrylic\s*(paint|painting)s?$/i, pattern: "acrylic$1s?" },
    { regex: /^mixed\s*media$/i, pattern: "mixedmedia" },
    { regex: /^fine\s*art$/i, pattern: "fineart" },
    { regex: /^hand\s*(made|painted|carved)$/i, pattern: "hand$1" },
    { regex: /^antique\s*(furniture|art)$/i, pattern: "antique$1" },
    { regex: /^hard\s*stone$/i, pattern: "hardstone" },
    { regex: /^mixed\s*metal$/i, pattern: "mixedmetal" },
  ];

  for (const { regex, pattern } of compoundPatterns) {
    if (regex.test(originalTerm)) {
      const convertedPattern = originalTerm.replace(regex, pattern);
      if (convertedPattern !== originalTerm) {
        patterns.push(convertedPattern);
      }
      break;
    }
  }

  // Handle spelling variations
  const spellingVariations = [
    { from: "colour", to: "color" },
    { from: "color", to: "colour" },
    { from: "grey", to: "gray" },
    { from: "gray", to: "grey" },
  ];

  spellingVariations.forEach(({ from, to }) => {
    if (originalTerm.includes(from)) {
      patterns.push(originalTerm.replace(new RegExp(from, "g"), to));
    }
  });

  return [...new Set(patterns)]; // Remove duplicates
}

// Simple Levenshtein distance function
function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1)
    .fill(null)
    .map(() => Array(str1.length + 1).fill(null));

  for (let i = 0; i <= str1.length; i++) {
    matrix[0][i] = i;
  }

  for (let j = 0; j <= str2.length; j++) {
    matrix[j][0] = j;
  }

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + indicator, // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
}

// GET /api/items/export/csv - Export items to CSV (Import-compatible format)
router.get("/export/csv", async (req, res) => {
  try {
    const {
      status,
      category,
      platform: platformQuery,
      item_ids,
      brand_code,
      include_all_fields,
    } = req.query as Record<string, string | undefined>;
    const platform = normalizePlatform(platformQuery);

    let items: any[] = [];

    // Apply filters and fetch items in batches for large exports
    if (item_ids) {
      // If specific item IDs are provided, filter by those
      const idsArray = item_ids
        .split(",")
        .filter((id) => id.trim())
        .map((id) => parseInt(id.trim())) // Convert to numbers
        .filter((id) => !isNaN(id)) // Filter out invalid IDs
        .sort((a, b) => a - b); // Sort by ID ascending

      if (idsArray.length > 0) {
        // For specific IDs, fetch all at once since the list is limited
        let query = supabaseAdmin
          .from("items")
          .select(
            `
          *,
          brands (
            id,
            name,
            code
          )
        `,
          )
          .in("id", idsArray);
        const { data: fetchedItems, error } = await query.order("id", {
          ascending: true,
        });

        if (error) {
          console.error("Error fetching items by IDs for export:", error);
          return res.status(500).json({
            error: "Failed to fetch items",
            details: error.message,
          });
        }
        items = fetchedItems || [];
      }
    } else {
      // For general queries, try to get all items with a large limit
      let query = supabaseAdmin
        .from("items")
        .select(
          `
          *,
          brands (
            id,
            name,
            code
          )
        `,
        )
        .order("id", { ascending: true });

      // Apply other filters
      if (status && status !== "all") {
        query = query.eq("status", status);
      }
      if (category) {
        query = query.eq("category", category);
      }

      // Apply brand filtering
      if (brand_code) {
        // First get the brand ID from the code
        const brandCodeStr = String(brand_code).toUpperCase();
        const { data: brandData } = await supabaseAdmin
          .from("brands")
          .select("id")
          .eq("code", brandCodeStr)
          .single();

        if (brandData?.id) {
          query = query.eq("brand_id", brandData.id);
        }
      }

      // Use a very large limit to try to get all items
      const { data: fetchedItems, error } = await query.limit(50000);

      if (error) {
        console.error("Error fetching items for export:", error);
        return res.status(500).json({
          error: "Failed to fetch items for export",
          details: error.message,
        });
      }

      items = fetchedItems || [];
      console.log(`Export fetched ${items.length} items`);
    }

    // Ensure items are sorted by ID even when specific IDs are provided
    if (items && items.length > 0) {
      items.sort((a, b) => {
        const idA = typeof a.id === "string" ? parseInt(a.id) : a.id || 0;
        const idB = typeof b.id === "string" ? parseInt(b.id) : b.id || 0;
        return idA - idB;
      });
    }

    const csvHeaders = PLATFORM_EXPORT_HEADERS[platform];

    const csvRows = (items || []).map((item, index) => {
      const lotNumber = index + 1; // Use index + 1 as lot number for all platforms
      if (platform === "database") {
        return [
          item.id || "",
          item.title || "",
          (item.description || "").replace(/<br>/g, "\n"),
          item.low_est || "",
          item.high_est || "",
          item.start_price || "",
          item.reserve || "",
          item.condition || "",
          item.consignment_id || "",
          item.status || "",
          item.category || "",
          item.subcategory || "",
          (item as any).height_inches || "",
          (item as any).width_inches || "",
          (item as any).height_cm || "",
          (item as any).width_cm || "",
          (item as any).height_with_frame_inches || "",
          (item as any).width_with_frame_inches || "",
          (item as any).height_with_frame_cm || "",
          (item as any).width_with_frame_cm || "",
          item.weight || "",
          item.materials || "",
          item.artist_maker || "",
          item.period_age || "",
          item.provenance || "",
          item.artist_id || "",
          item.school_id || "",
          (item as any).condition_report || "",
          (item as any).gallery_certification === null
            ? ""
            : (item as any).gallery_certification,
          (item as any).gallery_certification_file || "",
          (item as any).gallery_id || "",
          (item as any).artist_certification === null
            ? ""
            : (item as any).artist_certification,
          (item as any).artist_certification_file || "",
          (item as any).certified_artist_id || "",
          (item as any).artist_family_certification === null
            ? ""
            : (item as any).artist_family_certification,
          (item as any).artist_family_certification_file || "",
          (item as any).restoration_done === null
            ? ""
            : (item as any).restoration_done,
          (item as any).restoration_done_file || "",
          (item as any).restoration_by || "",
          item.images && Array.isArray(item.images) && item.images.length > 0
            ? JSON.stringify(
                item.images.filter((url: string) => url && url.trim()),
              )
            : "",
          item.include_artist_description === null
            ? ""
            : item.include_artist_description,
          item.include_artist_key_description === null
            ? ""
            : item.include_artist_key_description,
          item.include_artist_biography === null
            ? ""
            : item.include_artist_biography,
          item.include_artist_notable_works === null
            ? ""
            : item.include_artist_notable_works,
          item.include_artist_major_exhibitions === null
            ? ""
            : item.include_artist_major_exhibitions,
          item.include_artist_awards_honors === null
            ? ""
            : item.include_artist_awards_honors,
          item.include_artist_market_value_range === null
            ? ""
            : item.include_artist_market_value_range,
          item.include_artist_signature_style === null
            ? ""
            : item.include_artist_signature_style,
          (item as any).date_sold === null ? "" : (item as any).date_sold,
          item.created_at || "",
          item.updated_at || "",
        ];
      } else if (platform === "liveauctioneers") {
        return [
          lotNumber,
          item.title || "",
          (item.description || "").replace(/<br>/g, "\n"),
          item.low_est || "",
          item.high_est || "",
          item.start_price || "",
          item.reserve || "", // ReservePrice
          "", // Buy Now Price
          "", // Exclude From Buy Now
          item.condition || "",
          item.category || "",
          "", // Origin
          item.period_age || "", // Style & Period
          item.artist_maker || "", // Creator
          item.materials || "", // Materials & Techniques
          item.reserve || "", // Reserve Price (duplicate field)
          "", // Domestic Flat Shipping Price
          "", // Height
          "", // Width
          "", // Depth
          "", // Dimension Unit
          item.weight || "", // Weight
          "", // Weight Unit
          "1", // Quantity
        ];
      }

      switch (platform) {
        case "easy_live":
          return [
            lotNumber, // LotNo
            (item.description || "").replace(/<br>/g, "\n"), // Description
            item.condition || "", // Condition Report
            item.low_est || "", // LowEst
            item.high_est || "", // HighEst
            item.category || "", // Category
          ];
        case "invaluable":
          return [
            item.id || "", // id
            item.title || "", // title
            (item.description || "").replace(/<br>/g, "\n"), // description
            item.low_est || "", // low_est
            item.high_est || "", // high_est
            item.start_price || "", // start_price
            item.condition || "", // condition
            item.category || "", // category
            item.dimensions || "", // dimensions
          ];
        case "the_saleroom":
          return [
            lotNumber, // Number
            item.title || "", // Title
            (item.description || "").replace(/<br>/g, "\n"), // Description
            "", // Hammer
            item.reserve || "", // Reserve
            item.start_price || "", // StartPrice
            "", // Increment
            "1", // Quantity
            item.low_est || "", // LowEstimate
            item.high_est || "", // HighEstimate
            item.category || "", // CategoryCode
            "", // Sales Tax/VAT
            "", // BuyersPremiumRate
            "", // BuyersPremiumCeiling
            "", // InternetSurchargeRate
            "", // InternetSurchargeCeiling
            "", // BuyersPremiumVatRate
            "", // InternetSurchargeVatRate
            "", // End Date
            "", // End Time
            "", // Lot Link
            item.images && Array.isArray(item.images) && item.images.length > 0
              ? item.images[0]
              : "", // Main Image
            "", // ExtraImages
            "", // BuyItNowPrice
            "False", // IsBulk
            "False", // Artist's Resale Right Applies
            "", // Address1
            "", // Address2
            "", // Address3
            "", // Address4
            "", // Postcode
            "", // TownCity
            "", // CountyState
            "", // CountryCode
            "", // ShippingInfo
          ];
        default:
          return [];
      }
    });

    // Create CSV content with proper multiline handling
    const csvContent = generateCSVContentFromHeadersAndRows(
      csvHeaders,
      csvRows,
    );

    // Set headers for CSV download
    const timestamp = new Date().toISOString().split("T")[0];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="items-${platform}-export-${timestamp}.csv"`,
    );

    res.send(csvContent);
  } catch (error: any) {
    console.error("Error in GET /items/export/csv:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/items/test-filename-parsing - Test filename parsing (debug endpoint)
router.post("/test-filename-parsing", async (req, res) => {
  try {
    const { filenames } = req.body as { filenames: string[] };

    if (!filenames || !Array.isArray(filenames)) {
      return res.status(400).json({ error: "filenames array is required" });
    }

    const { deriveItemIdKeyFromFilename } =
      await import("../utils/google-drive");

    const results = filenames.map((filename) => ({
      filename,
      extractedId: deriveItemIdKeyFromFilename(filename),
      baseName: filename
        .toLowerCase()
        .replace(/\.(jpg|jpeg|png|webp|tiff|gif|bmp|svg)$/i, ""),
    }));

    res.json({
      success: true,
      results,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Test failed", details: error.message });
  }
});

// POST /api/items/test-search-preprocessing - Test search preprocessing (debug endpoint)
router.post("/test-search-preprocessing", async (req, res) => {
  try {
    const { searchTerm } = req.body as { searchTerm?: string };

    if (!searchTerm) {
      return res.status(400).json({ error: "searchTerm is required" });
    }

    const searchTerms = preprocessSearchTerms(searchTerm);
    const searchPatterns = generateSearchPatterns(searchTerm);

    res.json({
      success: true,
      original_term: searchTerm,
      preprocessed_terms: searchTerms,
      search_patterns: searchPatterns,
      example_queries: searchTerms.map((term) => `%${term}%`),
    });
  } catch (error: any) {
    res
      .status(500)
      .json({
        error: "Search preprocessing test failed",
        details: error.message,
      });
  }
});

// POST /api/items/test-csv-parsing - Test CSV parsing (debug endpoint)
router.post("/test-csv-parsing", async (req, res) => {
  try {
    const { csvData } = req.body as { csvData?: string };

    if (!csvData) {
      return res.status(400).json({ error: "csvData is required" });
    }

    // Parse CSV data with proper multiline support (same logic as upload)
    const lines = csvData.trim().split("\n");
    if (lines.length < 2) {
      return res
        .status(400)
        .json({
          error: "CSV must contain at least a header row and one data row",
        });
    }

    // Parse headers with proper quote handling
    const headers = parseCSVLine(lines[0]).map((h: string) =>
      h.trim().replace(/"/g, ""),
    );
    const dataRows = [];

    // Parse data rows with multiline support
    let currentRow = "";
    let quoteCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      currentRow += (currentRow ? "\n" : "") + line;

      // Count quotes to determine if we're in a multiline field
      let lineQuoteCount = 0;
      let inQuotes = false;

      for (let j = 0; j < line.length; j++) {
        if (line[j] === '"') {
          if (!inQuotes) {
            inQuotes = true;
            lineQuoteCount++;
          } else if (j < line.length - 1 && line[j + 1] === '"') {
            // Escaped quote, skip next character
            j++;
          } else {
            inQuotes = false;
          }
        }
      }

      quoteCount += lineQuoteCount;

      // If we have an odd number of quotes, we're in a multiline field
      if (quoteCount % 2 !== 0) {
        continue;
      }

      // We have a complete row
      if (currentRow.trim()) {
        dataRows.push(currentRow);
      }

      // Reset for next row
      currentRow = "";
      quoteCount = 0;
    }

    // Handle any remaining incomplete row
    if (currentRow.trim()) {
      dataRows.push(currentRow);
    }

    // Parse first few rows to show results
    const parsedRows = dataRows.slice(0, 3).map((row) => parseCSVLine(row));

    res.json({
      success: true,
      headers,
      totalRows: dataRows.length,
      sampleRows: parsedRows,
      rawDataPreview: dataRows
        .slice(0, 2)
        .map((row) => row.substring(0, 200) + (row.length > 200 ? "..." : "")),
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ error: "CSV parsing test failed", details: error.message });
  }
});

// POST /api/items/preview/drive-mapping - Preview drive folder mapping without importing
router.post("/preview/drive-mapping", async (req, res) => {
  try {
    const { drive_folder_url } = req.body as { drive_folder_url?: string };

    if (!drive_folder_url) {
      return res.status(400).json({ error: "drive_folder_url is required" });
    }

    // Get files from drive folder
    const files = await listFilesInFolder(drive_folder_url);
    const lookup = new Map<
      string,
      { name: string; url: string; fileId: string }[]
    >();

    // Build id->files map
    for (const f of files) {
      const originalName = f.name || "";
      const base = originalName.toLowerCase();
      const url = buildDriveDirectViewUrl(f.id);
      const idKey = deriveItemIdKeyFromFilename(base);
      if (!idKey) continue;
      const arr = lookup.get(idKey) || [];
      arr.push({ name: originalName, url, fileId: f.id });
      lookup.set(idKey, arr);
    }

    // Convert lookup to preview format with proper sorting
    const mappingPreview: Record<
      string,
      {
        images: { filename: string; url: string; fileId: string }[];
        count: number;
      }
    > = {};
    for (const [idKey, files] of lookup.entries()) {
      const sortedFiles = sortDriveFilesByItemId(files);

      mappingPreview[idKey] = {
        images: sortedFiles.map((f) => ({
          filename: f.name,
          url: f.url,
          fileId: f.fileId,
        })),
        count: sortedFiles.length,
      };
    }

    res.json({
      success: true,
      mapping_preview: mappingPreview,
      total_files: files.length,
      mapped_ids: Object.keys(mappingPreview).length,
    });
  } catch (error: any) {
    console.error("Error in drive mapping preview:", error);
    res.status(500).json({
      error: "Failed to preview drive mapping",
      details: error.message,
    });
  }
});

// POST /api/items/upload/csv - Upload items from CSV (LiveAuctioneers compatible)
router.post("/upload/csv", async (req, res) => {
  try {
    const {
      csvData,
      validateOnly = false,
      platform: platformBody,
      drive_folder_url,
      sync_back = false,
      brand_code,
      include_all_fields = false,
      auction_id,
    } = req.body as {
      csvData?: string;
      validateOnly?: boolean;
      platform?: string;
      drive_folder_url?: string;
      sync_back?: boolean;
      brand_code?: string;
      include_all_fields?: boolean;
      auction_id?: number;
    };
    const platform = normalizePlatform(platformBody);
    const userId = (req as any).user?.id;

    if (!csvData) {
      return res.status(400).json({ error: "CSV data is required" });
    }

    // Use Papa Parse for better CSV parsing with proper quote handling
    const Papa = require("papaparse");
    const parseResult = Papa.parse(csvData, {
      header: false,
      skipEmptyLines: true,
      transform: (value: string) => value.trim(),
    });

    if (parseResult.errors && parseResult.errors.length > 0) {
      console.error("Papa Parse errors:", parseResult.errors);
      return res.status(400).json({
        error: "CSV parsing failed",
        details: parseResult.errors.map((e: any) => e.message).join(", "),
      });
    }

    const rows = parseResult.data;
    if (rows.length < 2) {
      return res
        .status(400)
        .json({
          error: "CSV must contain at least a header row and one data row",
        });
    }

    // Parse headers with proper quote handling
    const headers = rows[0].map((h: string) => h.trim().replace(/"/g, ""));
    const dataRows = rows.slice(1);

    // Validate headers per platform
    const requiredFields = PLATFORM_REQUIRED_FIELDS[platform];
    const missingFields = requiredFields.filter(
      (field) => !headers.includes(field),
    );

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: "Missing required CSV columns",
        missing_fields: missingFields,
        found_headers: headers,
      });
    }

    // Brand handling - resolve brand_code to brand_id if provided
    let defaultBrandId: number | null = null;
    if (brand_code) {
      const { data: brandData } = await supabaseAdmin
        .from("brands")
        .select("id")
        .eq("code", brand_code.toUpperCase())
        .single();

      if (brandData?.id) {
        defaultBrandId = brandData.id;
        console.log(
          `[CSV Import] Using brand: ${brand_code} (ID: ${defaultBrandId})`,
        );
      } else {
        console.warn(
          `[CSV Import] Brand code '${brand_code}' not found, proceeding without brand assignment`,
        );
      }
    }

    // Parse and validate data
    const items: any[] = [];
    const errors: string[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rowNum = i + 2; // +2 because we start from 1 and skip header
      const values = dataRows[i] as string[];

      // Ensure we have the expected number of columns (pad with empty strings if needed)
      while (values.length < headers.length) {
        values.push("");
      }

      // Trim whitespace from all values
      for (let k = 0; k < values.length; k++) {
        values[k] = values[k].trim();
      }

      // Log column count issues but don't fail if we're close to expected count
      if (values.length !== headers.length) {
        const difference = Math.abs(values.length - headers.length);
        console.log(`Row ${rowNum} parsing details:`, {
          expected: headers.length,
          got: values.length,
          difference: difference,
          headers: headers,
          values: values.slice(0, 10), // First 10 values for debugging
          rawValues:
            values.join(",").substring(0, 100) +
            (values.join(",").length > 100 ? "..." : ""),
        });

        // Only fail if the difference is too large (more than 10 columns)
        if (difference > 10) {
          errors.push(
            `Row ${rowNum}: Column count mismatch (expected ${headers.length}, got ${values.length})`,
          );
          continue;
        } else {
          console.log(
            `Row ${rowNum}: Column count difference (${difference}) within tolerance, proceeding with import`,
          );
        }
      }

      // Validate required fields are present
      const requiredFields = PLATFORM_REQUIRED_FIELDS[platform];
      let missingRequiredFields: string[] = [];

      requiredFields.forEach((requiredField) => {
        const headerIndex = headers.indexOf(requiredField);
        if (headerIndex === -1 || !values[headerIndex]?.trim()) {
          missingRequiredFields.push(requiredField);
        }
      });

      if (missingRequiredFields.length > 0) {
        console.log(`Row ${rowNum} missing required fields:`, {
          missingFields: missingRequiredFields,
          headers: headers,
          values: values.slice(0, 10),
          requiredFields: requiredFields,
        });
        errors.push(
          `Row ${rowNum}: Missing required fields: ${missingRequiredFields.join(", ")}`,
        );
        continue;
      }

      // Build a clean item object matching our database schema
      // Only set fields that exist in CSV and are valid - no cleanup needed
      const item: any = {
        // Status is always set
        status: "active",
      };
      const fieldMap = PLATFORM_IMPORT_FIELD_MAP[platform];

      // Track extracted ID for image mapping (separate from database ID)
      let extractedImageMappingId: string | null = null;

      // Track which key numeric fields we've seen (for defaults)
      const seenNumericFields: Set<string> = new Set();

      // Process each CSV column
      headers.forEach((header: string, index: number) => {
        const value = values[index] || "";
        const trimmedValue = value.trim();

        const internalField = fieldMap[header];

        // Skip fields that don't map to our schema or are platform-specific non-database fields
        if (!internalField) {
          // Handle LiveAuctioneers ImageFile.* columns (special case)
          if (
            platform === "liveauctioneers" &&
            header.startsWith("ImageFile.")
          ) {
            if (!item.images) {
              item.images = [];
            }
            if (trimmedValue) {
              item.images.push(trimmedValue);
            }
          }
          // Skip Lot/Lot ID fields - we use our own IDs
          if (
            platform === "liveauctioneers" &&
            (header === "Lot" || header === "Lot ID")
          ) {
            // Extract ID for image mapping purposes only
            if (trimmedValue) {
              extractedImageMappingId =
                extractNumericIdForImageMapping(trimmedValue);
            }
          }
          return; // Skip unmapped fields
        }

        // Skip platform-specific fields that don't exist in our database
        // Height/Width will be handled separately for dimension conversion
        if (
          platform === "liveauctioneers" &&
          [
            "lot",
            "lot_id",
            "bids",
            "pending_bids",
            "hits",
            "image_count",
            "live",
            "edited",
            "depth",
            "dimension_unit",
            "weight_unit",
            "shipping_price",
            "shipping_height",
            "shipping_width",
            "shipping_depth",
            "shipping_dimension_unit",
            "shipping_weight",
            "shipping_weight_unit",
            "shipping_quantity",
            "height",
            "width",
          ].includes(internalField)
        ) {
          // Extract ID from lot field for image mapping
          if (internalField === "lot" && trimmedValue) {
            extractedImageMappingId =
              extractNumericIdForImageMapping(trimmedValue);
          }
          return; // Skip these fields - height/width will be handled after header processing
        }

        // Process fields based on their type and validation rules
        if (internalField === "title") {
          if (!trimmedValue) {
            errors.push(`Row ${rowNum}: Title is required`);
            return;
          }
          if (platform === "liveauctioneers" && trimmedValue.length > 200) {
            errors.push(`Row ${rowNum}: Title must be 200 characters or less`);
            return;
          }
          item.title = trimmedValue;
        } else if (internalField === "description") {
          if (trimmedValue) {
            item.description = trimmedValue.replace(/\n/g, "<br>");
          }
        } else if (
          ["low_est", "high_est", "start_price", "reserve"].includes(
            internalField,
          )
        ) {
          seenNumericFields.add(internalField);
          if (trimmedValue) {
            const num = parseCurrencyValue(trimmedValue);
            if (isNaN(num) || num < 0) {
              errors.push(
                `Row ${rowNum}: ${header} must be a valid positive number`,
              );
            } else {
              item[internalField] = num;
            }
          }
        } else if (["final_price", "sale_price"].includes(internalField)) {
          if (trimmedValue) {
            const num = parseCurrencyValue(trimmedValue);
            if (!isNaN(num) && num >= 0) {
              item[internalField] = num;
            }
          }
        } else if (internalField === "images") {
          if (trimmedValue) {
            try {
              const parsedImages = JSON.parse(trimmedValue);
              if (Array.isArray(parsedImages)) {
                item.images = parsedImages.filter(
                  (url) => url && typeof url === "string" && url.trim(),
                );
              } else if (typeof parsedImages === "string") {
                item.images = [parsedImages];
              } else {
                item.images = trimmedValue
                  .split(",")
                  .map((url: string) => url.trim())
                  .filter((url: string) => url);
              }
            } catch (e) {
              item.images = trimmedValue
                .split(",")
                .map((url: string) => url.trim())
                .filter((url: string) => url);
            }
          }
        } else if (
          [
            "artist_id",
            "consignment_id",
            "vendor_id",
            "buyer_id",
            "brand_id",
          ].includes(internalField)
        ) {
          if (trimmedValue && !isNaN(Number(trimmedValue))) {
            item[internalField] = parseInt(trimmedValue);
          }
        } else if (
          ["school_id", "gallery_id", "certified_artist_id"].includes(
            internalField,
          )
        ) {
          if (trimmedValue) {
            item[internalField] = trimmedValue;
          }
        } else if (internalField === "id") {
          // Extract ID for image mapping but don't set item.id (let DB auto-generate)
          if (trimmedValue) {
            extractedImageMappingId =
              extractNumericIdForImageMapping(trimmedValue);
          }
        } else if (
          ["date_sold", "created_at", "updated_at"].includes(internalField)
        ) {
          if (trimmedValue) {
            const parsedDate = new Date(trimmedValue);
            if (!isNaN(parsedDate.getTime())) {
              item[internalField] = parsedDate.toISOString();
            }
          }
        } else if (internalField === "returned_by_user_id") {
          if (trimmedValue) {
            item.returned_by_user_id = trimmedValue;
          }
        } else if (
          [
            "gallery_certification",
            "artist_certification",
            "artist_family_certification",
            "restoration_done",
            "include_artist_description",
            "include_artist_key_description",
            "include_artist_biography",
            "include_artist_notable_works",
            "include_artist_major_exhibitions",
            "include_artist_awards_honors",
            "include_artist_market_value_range",
            "include_artist_signature_style",
          ].includes(internalField)
        ) {
          if (trimmedValue) {
            item[internalField] =
              trimmedValue.toLowerCase() === "true" || trimmedValue === "1";
          }
        } else {
          // Default: set string fields if they have a value
          if (trimmedValue) {
            item[internalField] = trimmedValue;
          }
        }
      });

      // Handle LiveAuctioneers dimension conversion
      // LiveAuctioneers provides Height/Width in inches, convert to both inches and cm
      if (platform === "liveauctioneers") {
        const heightIndex = headers.indexOf("Height");
        const widthIndex = headers.indexOf("Width");

        if (heightIndex !== -1) {
          const heightValue = values[heightIndex]?.trim();
          if (heightValue && !isNaN(Number(heightValue))) {
            const heightNum = parseFloat(heightValue);
            item.height_inches = heightNum.toString();
            item.height_cm = (heightNum * 2.54).toFixed(2); // Convert inches to cm
          }
        }

        if (widthIndex !== -1) {
          const widthValue = values[widthIndex]?.trim();
          if (widthValue && !isNaN(Number(widthValue))) {
            const widthNum = parseFloat(widthValue);
            item.width_inches = widthNum.toString();
            item.width_cm = (widthNum * 2.54).toFixed(2); // Convert inches to cm
          }
        }
      }

      // Apply defaults for key numeric fields that weren't provided
      if (!seenNumericFields.has("low_est")) {
        item.low_est = 200;
      }
      if (!seenNumericFields.has("high_est")) {
        item.high_est = 400;
      }
      if (!seenNumericFields.has("reserve")) {
        item.reserve = 100;
      }

      // Handle start_price: use calculation if we have low_est, otherwise use default
      if (!seenNumericFields.has("start_price")) {
        if (item.low_est) {
          item.start_price = Math.round(item.low_est * 0.5);
        } else {
          item.start_price = 100;
        }
      }

      // Set default description if missing
      if (!item.description && item.title) {
        item.description = item.title;
      }

      // Additional validation
      if (item.low_est && item.high_est && item.low_est > item.high_est) {
        errors.push(
          `Row ${rowNum}: Low estimate cannot be greater than high estimate`,
        );
      }

      if (errors.length === 0 || validateOnly) {
        // Store the item with extracted ID for image mapping
        items.push({
          ...item,
          _extractedImageMappingId: extractedImageMappingId, // Track for image mapping
        });
      }
    }

    if (validateOnly) {
      return res.json({
        success: true,
        validation_result: {
          total_rows: dataRows.length,
          valid_rows: items.length,
          errors: errors,
          sample_items: items.slice(0, 5), // Show first 5 items as preview
        },
      });
    }

    if (errors.length > 0) {
      console.log("CSV validation errors:", errors);
      return res.status(400).json({
        error: "CSV validation failed",
        errors: errors,
        valid_items_count: items.length,
        total_rows: dataRows.length,
      });
    }

    // Note: Duplicate checking is handled by database constraints on ID field

    // Insert items in batch (without extracted IDs - let Supabase handle ID generation)
    // Items are already clean - we only built fields that exist in our schema
    const itemsForInsert = items.map((item) => {
      const { _extractedImageMappingId, ...itemWithoutExtractedId } = item;

      // Apply default brand_id if not already set from CSV
      if (defaultBrandId && !itemWithoutExtractedId.brand_id) {
        itemWithoutExtractedId.brand_id = defaultBrandId;
      }

      return itemWithoutExtractedId;
    });

    const { data: insertedItems, error: insertError } = await supabaseAdmin
      .from("items")
      .insert(itemsForInsert)
      .select("id, title");

    if (insertError) {
      console.error("Error inserting items:", insertError);
      return res.status(500).json({
        error: "Failed to insert items",
        details: insertError.message,
      });
    }

    // If drive folder provided, map images using common function
    if (drive_folder_url) {
      // Create a mapping from extracted ID to actual database item
      const extractedIdToDbItem = new Map<string, any>();
      if (insertedItems) {
        for (let i = 0; i < insertedItems.length; i++) {
          const dbItem = insertedItems[i];
          const originalItem = items[i];
          if (originalItem._extractedImageMappingId) {
            extractedIdToDbItem.set(
              originalItem._extractedImageMappingId,
              dbItem,
            );
          }
        }
      }

      // Update items array with database IDs for image mapping
      const itemsForImageMapping = items.map((originalItem, index) => {
        const dbItem = insertedItems?.[index];
        return {
          ...originalItem,
          id: dbItem?.id || originalItem.id,
        };
      });

      const imageMappingResult = await mapImagesFromDriveFolder(
        drive_folder_url,
        itemsForImageMapping,
        "csv",
      );

      // Add any image mapping errors to the main errors array
      if (imageMappingResult.errors.length > 0) {
        errors.push(...imageMappingResult.errors);
      }
    }

    // If sync_back is requested, sync the full database back to Google Sheets
    let syncBackResult = null;
    if (sync_back && insertedItems && insertedItems.length > 0) {
      // For CSV import, we need a sheet URL. Check if there's a configured global sheet URL
      const { data: settingData } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", "google_sheet_url_artworks")
        .single();

      if (settingData?.value) {
        syncBackResult = await syncDatabaseToGoogleSheets(
          settingData.value,
          undefined,
          "csv",
        );
      } else {
        console.log(
          "[CSV Import] No Google Sheets URL configured for sync-back",
        );
        syncBackResult = {
          success: false,
          message:
            "No Google Sheets URL configured for sync-back. Please configure google_sheet_url_artworks in app settings.",
          synced_count: 0,
        };
      }
    }

    // Auto-sync to Google Sheets after successful import
    let autoSyncResult = null;
    if (insertedItems && insertedItems.length > 0) {
      try {
        // Get configured Google Sheets URL for auto-sync
        const { data: settingData } = await supabaseAdmin
          .from("app_settings")
          .select("value")
          .eq("key", "google_sheet_url_artworks")
          .single();

        if (settingData?.value) {
          console.log(
            `[CSV] Starting auto-sync to Google Sheets after CSV import`,
          );
          autoSyncResult = await syncDatabaseToGoogleSheets(
            settingData.value,
            undefined,
            "auto_sync",
          );
        } else {
          console.log("[CSV] No Google Sheets URL configured for auto-sync");
          autoSyncResult = {
            success: false,
            message:
              "No Google Sheets URL configured for auto-sync. Please configure google_sheet_url_artworks in app settings.",
            synced_count: 0,
          };
        }

        if (autoSyncResult.success) {
          console.log(
            `✅ Auto-synced ${autoSyncResult.synced_count} items to Google Sheets after CSV import`,
          );
        } else {
          console.error(
            `❌ Failed to auto-sync to Google Sheets after CSV import: ${autoSyncResult.message}`,
          );
        }
      } catch (autoSyncError: any) {
        console.error(
          "Error during auto-sync after CSV import:",
          autoSyncError,
        );
        autoSyncResult = {
          success: false,
          message: `Auto-sync failed: ${autoSyncError.message}`,
          synced_count: 0,
        };
      }
    }

    // If auction_id is provided, add the imported items to the auction
    let auctionUpdateResult = null;
    if (auction_id && insertedItems && insertedItems.length > 0) {
      try {
        // Get current auction artwork_ids
        const { data: auctionData, error: auctionError } = await supabaseAdmin
          .from("auctions")
          .select("artwork_ids")
          .eq("id", auction_id)
          .single();

        if (auctionError) {
          console.error("Error fetching auction for update:", auctionError);
          auctionUpdateResult = {
            success: false,
            message: `Failed to fetch auction: ${auctionError.message}`,
          };
        } else {
          // Add new item IDs to existing artwork_ids array
          const currentArtworkIds = auctionData.artwork_ids || [];
          const newItemIds = insertedItems.map((item) => item.id);
          const updatedArtworkIds = [
            ...new Set([...currentArtworkIds, ...newItemIds]),
          ]; // Remove duplicates

          // Update the auction with new artwork_ids
          const { error: updateError } = await supabaseAdmin
            .from("auctions")
            .update({ artwork_ids: updatedArtworkIds })
            .eq("id", auction_id);

          if (updateError) {
            console.error(
              "Error updating auction with new items:",
              updateError,
            );
            auctionUpdateResult = {
              success: false,
              message: `Failed to add items to auction: ${updateError.message}`,
            };
          } else {
            console.log(
              `✅ Added ${newItemIds.length} items to auction ${auction_id}`,
            );
            auctionUpdateResult = {
              success: true,
              message: `Added ${newItemIds.length} items to auction`,
              added_count: newItemIds.length,
            };
          }
        }
      } catch (auctionUpdateError: any) {
        console.error("Error during auction update:", auctionUpdateError);
        auctionUpdateResult = {
          success: false,
          message: `Auction update failed: ${auctionUpdateError.message}`,
        };
      }
    }

    res.json({
      success: true,
      message: `Successfully imported ${insertedItems?.length || 0} items`,
      imported_count: insertedItems?.length || 0,
      items: insertedItems,
      sync_back: syncBackResult,
      auto_sync: autoSyncResult,
      auction_update: auctionUpdateResult,
    });
  } catch (error: any) {
    console.error("Error in POST /items/upload/csv:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// GET /api/items/export/template - Return a CSV header row for EXPORT templates
router.get("/export/template", async (req, res) => {
  try {
    const { platform: platformQuery } = req.query as Record<
      string,
      string | undefined
    >;
    const platform = normalizePlatform(platformQuery);
    const headers = PLATFORM_EXPORT_HEADERS[platform];
    const csvContent = headers.join(",") + "\n";

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="items-${platform}-export-template.csv"`,
    );
    res.send(csvContent);
  } catch (error: any) {
    res
      .status(500)
      .json({
        error: "Failed to generate export template",
        details: error.message,
      });
  }
});

// GET /api/items/import/template - Return a CSV header row for IMPORT templates
router.get("/import/template", async (req, res) => {
  try {
    const { platform: platformQuery } = req.query as Record<
      string,
      string | undefined
    >;
    const platform = normalizePlatform(platformQuery);
    const headers = PLATFORM_IMPORT_HEADERS[platform];
    const csvContent = headers.join(",") + "\n";

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="items-${platform}-import-template.csv"`,
    );
    res.send(csvContent);
  } catch (error: any) {
    res
      .status(500)
      .json({
        error: "Failed to generate import template",
        details: error.message,
      });
  }
});

// POST /api/items/sync-to-google-sheet - Sync artworks TO Google Sheets
router.post("/sync-to-google-sheet", async (req, res) => {
  try {
    const { sheet_url, artworks, brand } = req.body as {
      sheet_url: string;
      artworks: any[];
      brand?: string;
    };

    if (!sheet_url) {
      return res.status(400).json({ error: "sheet_url is required" });
    }

    if (!artworks || !Array.isArray(artworks) || artworks.length === 0) {
      return res
        .status(400)
        .json({ error: "artworks array is required and must not be empty" });
    }

    // Sort artworks by ID ascending before processing
    artworks.sort((a, b) => {
      const idA = typeof a.id === "string" ? parseInt(a.id) : a.id || 0;
      const idB = typeof b.id === "string" ? parseInt(b.id) : b.id || 0;
      return idA - idB;
    });

    // Use the same database format as CSV export
    const csvHeaders = PLATFORM_EXPORT_HEADERS.database;

    const csvRows = artworks.map((artwork) => [
      artwork.id || "",
      artwork.title || "",
      artwork.description || "", // Keep <br> tags for Google Sheets
      artwork.low_est || "",
      artwork.high_est || "",
      artwork.start_price || "",
      artwork.reserve || "",
      artwork.condition || "",
      artwork.consignment_id || "",
      artwork.status || "",
      artwork.category || "",
      artwork.subcategory || "",
      (artwork as any).height_inches || "",
      (artwork as any).width_inches || "",
      (artwork as any).height_cm || "",
      (artwork as any).width_cm || "",
      (artwork as any).height_with_frame_inches || "",
      (artwork as any).width_with_frame_inches || "",
      (artwork as any).height_with_frame_cm || "",
      (artwork as any).width_with_frame_cm || "",
      artwork.weight || "",
      artwork.materials || "",
      artwork.artist_maker || "",
      artwork.period_age || "",
      artwork.provenance || "",
      artwork.artist_id || "",
      artwork.school_id || "",
      (artwork as any).condition_report || "",
      (artwork as any).gallery_certification === null ||
      (artwork as any).gallery_certification === false
        ? ""
        : (artwork as any).gallery_certification,
      (artwork as any).gallery_certification_file || "",
      (artwork as any).gallery_id || "",
      (artwork as any).artist_certification === null ||
      (artwork as any).artist_certification === false
        ? ""
        : (artwork as any).artist_certification,
      (artwork as any).artist_certification_file || "",
      (artwork as any).certified_artist_id || "",
      (artwork as any).artist_family_certification === null ||
      (artwork as any).artist_family_certification === false
        ? ""
        : (artwork as any).artist_family_certification,
      (artwork as any).artist_family_certification_file || "",
      (artwork as any).restoration_done === null ||
      (artwork as any).restoration_done === false
        ? ""
        : (artwork as any).restoration_done,
      (artwork as any).restoration_done_file || "",
      (artwork as any).restoration_by || "",
      // Handle images array - export as JSON string for unlimited images support
      artwork.images &&
      Array.isArray(artwork.images) &&
      artwork.images.length > 0
        ? JSON.stringify(
            artwork.images.filter((url: string) => url && url.trim()),
          )
        : "",
      (artwork as any).include_artist_description === null ||
      (artwork as any).include_artist_description === false
        ? ""
        : (artwork as any).include_artist_description,
      (artwork as any).include_artist_key_description === null ||
      (artwork as any).include_artist_key_description === false
        ? ""
        : (artwork as any).include_artist_key_description,
      (artwork as any).include_artist_biography === null ||
      (artwork as any).include_artist_biography === false
        ? ""
        : (artwork as any).include_artist_biography,
      (artwork as any).include_artist_notable_works === null ||
      (artwork as any).include_artist_notable_works === false
        ? ""
        : (artwork as any).include_artist_notable_works,
      (artwork as any).include_artist_major_exhibitions === null ||
      (artwork as any).include_artist_major_exhibitions === false
        ? ""
        : (artwork as any).include_artist_major_exhibitions,
      (artwork as any).include_artist_awards_honors === null ||
      (artwork as any).include_artist_awards_honors === false
        ? ""
        : (artwork as any).include_artist_awards_honors,
      (artwork as any).include_artist_market_value_range === null ||
      (artwork as any).include_artist_market_value_range === false
        ? ""
        : (artwork as any).include_artist_market_value_range,
      (artwork as any).include_artist_signature_style === null ||
      (artwork as any).include_artist_signature_style === false
        ? ""
        : (artwork as any).include_artist_signature_style,
      // Brand field (export brand_code only for readability)
      (artwork as any).brands?.code || (artwork as any).brand_code || "",
      // Return fields
      (artwork as any).return_date || "",
      (artwork as any).return_location || "",
      (artwork as any).return_reason || "",
      (artwork as any).returned_by_user_id || null,
      (artwork as any).returned_by_user_name || "",
      (artwork as any).date_sold === null ? "" : (artwork as any).date_sold,
      artwork.created_at || "",
      artwork.updated_at || "",
    ]);

    // Generate CSV content with proper multiline support
    const csvContent = generateCSVContentFromHeadersAndRows(
      csvHeaders,
      csvRows,
    );

    console.log("Syncing artworks to Google Sheets:", {
      sheet_url,
      artworks_count: artworks.length,
      brand,
    });

    // Convert CSV to 2D array for Google Sheets API
    const sheetsData = csvContentToSheetsData(csvContent);

    // Try to write to Google Sheets using API
    const googleApiKey =
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY;
    const writeSuccess = await writeToGoogleSheets(
      sheet_url,
      sheetsData,
      googleApiKey || "",
    );

    if (writeSuccess) {
      res.json({
        success: true,
        message: `Successfully synced ${artworks.length} artworks to Google Sheets`,
        synced_count: artworks.length,
        sheet_url: sheet_url,
        written_rows: sheetsData.length,
        written_columns: sheetsData[0]?.length || 0,
      });
    } else {
      // Fallback response if writing failed
      res.json({
        success: false,
        message: `Failed to write to Google Sheets. Please check your service account credentials.`,
        synced_count: 0,
        csv_preview: csvContent.split("\n").slice(0, 3).join("\n") + "...",
        error:
          "Google Sheets API write failed - check service account configuration",
      });
    }
  } catch (error: any) {
    console.error("Error in sync-to-google-sheet endpoint:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
});

// POST /api/items/sync-google-sheet - Import/sync artworks from a Google Sheet CSV URL
router.post("/sync-google-sheet", async (req, res) => {
  try {
    const {
      sheet_url,
      default_brand,
      platform = "database",
      drive_folder_url,
      sync_back = false,
      brand_code,
      auction_id,
    } = req.body as {
      sheet_url?: string;
      default_brand?: string;
      platform?: string;
      drive_folder_url?: string;
      sync_back?: boolean; // If true, sync database data back to Google Sheets after import
      brand_code?: string;
      auction_id?: number;
    };
    console.log("Original sheet_url:", sheet_url);
    console.log("Default brand for empty fields:", default_brand);
    console.log("Target platform:", platform);
    console.log("Sync back to sheets:", sync_back);

    if (!sheet_url) {
      return res.status(400).json({ error: "sheet_url is required" });
    }

    // Convert to proper CSV export URL
    const csvUrl = convertToGoogleSheetsCSVUrl(sheet_url);
    console.log("Converted CSV URL:", csvUrl);

    // Fetch CSV with proper headers
    const response = await fetch(csvUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });

    if (!response.ok) {
      console.error("Fetch failed:", response.status, response.statusText);
      return res.status(400).json({
        error: `Failed to fetch sheet: ${response.statusText}`,
        details: `Status: ${response.status}, URL: ${csvUrl}`,
      });
    }

    const csvText = await response.text();
    console.log("CSV Text Length:", csvText.length);
    console.log("CSV Text Preview:", csvText.substring(0, 500));

    // Use Papa Parse for better CSV parsing
    const Papa = require("papaparse");
    const parseResult = Papa.parse(csvText, {
      header: false,
      skipEmptyLines: true,
      transform: (value: string) => value.trim(),
    });

    if (parseResult.errors && parseResult.errors.length > 0) {
      console.error("Papa Parse errors:", parseResult.errors);
      return res.status(400).json({
        error: "CSV parsing failed",
        details: parseResult.errors.map((e: any) => e.message).join(", "),
      });
    }

    const rows = parseResult.data;
    if (rows.length < 2) {
      return res.status(400).json({
        error: "Invalid CSV format",
        details: "CSV must have at least a header row and one data row",
      });
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);
    console.log("Headers:", headers);
    console.log("Data rows count:", dataRows.length);

    const errors: string[] = [];
    const upserts: any[] = [];

    // Brand handling - support both brand_code and default_brand for backward compatibility
    let defaultBrandId: number | null = null;
    const targetBrandCode = brand_code || default_brand;

    if (targetBrandCode) {
      const { data: brandData } = await supabaseAdmin
        .from("brands")
        .select("id")
        .eq("code", targetBrandCode.toUpperCase())
        .single();

      if (brandData?.id) {
        defaultBrandId = brandData.id;
        console.log(
          `[Google Sheets Import] Using brand: ${targetBrandCode} (ID: ${defaultBrandId})`,
        );
      } else {
        console.warn(
          `[Google Sheets Import] Brand code '${targetBrandCode}' not found, proceeding without brand assignment`,
        );
      }
    }

    // Process each row
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];

      try {
        const item: any = {
          updated_at: new Date().toISOString(),
        };

        // Track extracted ID for image mapping (separate from database ID)
        let extractedImageMappingId: string | null = null;

        // Map headers to database fields using the same logic as CSV import
        headers.forEach((header: string, index: number) => {
          const value = row[index]?.trim();
          if (!value) return;

          const lowerHeader = header.toLowerCase().replace(/[^a-z0-9]/g, "_");

          // Use the same field mapping as CSV import for consistency
          const fieldMap = PLATFORM_IMPORT_FIELD_MAP.database;
          const internalField = fieldMap[header];

          if (internalField) {
            // Handle numeric fields
            if (
              ["low_est", "high_est", "start_price", "reserve"].includes(
                internalField,
              )
            ) {
              if (value) {
                const num = parseCurrencyValue(value);
                if (!isNaN(num) && num >= 0) {
                  item[internalField] = num;
                }
              }
            }
            // Handle images field (unlimited images array)
            else if (internalField === "images") {
              if (value) {
                try {
                  // Try to parse as JSON array
                  const parsedImages = JSON.parse(value);
                  if (Array.isArray(parsedImages)) {
                    item[internalField] = parsedImages.filter(
                      (url) => url && typeof url === "string" && url.trim(),
                    );
                  } else if (typeof parsedImages === "string") {
                    // Handle single image URL
                    item[internalField] = [parsedImages];
                  } else {
                    // Fallback: treat as comma-separated string
                    item[internalField] = value
                      .split(",")
                      .map((url: string) => url.trim())
                      .filter((url: string) => url);
                  }
                } catch (e) {
                  // If JSON parsing fails, treat as comma-separated string
                  item[internalField] = value
                    .split(",")
                    .map((url: string) => url.trim())
                    .filter((url: string) => url);
                }
              }
            }
            // Handle ID fields
            else if (
              [
                "id",
                "artist_id",
                "school_id",
                "gallery_id",
                "certified_artist_id",
                "consignment_id",
              ].includes(internalField)
            ) {
              // Set null for empty values
              if (value === "" || value === null || value === undefined) {
                item[internalField] = null;
              } else {
                // Special handling for main 'id'
                if (internalField === "id") {
                  // Extract numeric ID for image mapping
                  extractedImageMappingId =
                    extractNumericIdForImageMapping(value);

                  if (extractedImageMappingId) {
                    console.log(
                      `[Google Sheets] Extracted numeric ID ${extractedImageMappingId} from "${value}" for image mapping`,
                    );

                    // If value itself is numeric, allow updating item.id
                    if (!isNaN(Number(value))) {
                      const numericId = parseInt(value);
                      item.id = numericId; // ✅ allow update when valid number
                    }
                  } else {
                    console.warn(
                      `[Google Sheets] Could not extract numeric ID from "${value}"`,
                    );
                  }

                  // If value is non-numeric and extraction fails,
                  // Supabase will auto-generate ID (since we don't force set it)
                } else {
                  // Other ID fields

                  // Try numeric first
                  if (!isNaN(Number(value))) {
                    item[internalField] = parseInt(value);
                  } else {
                    // Fallback to string (if external system sends string IDs)
                    item[internalField] = value;
                  }
                }
              }
            }
            // Handle timestamp fields
            else if (
              ["date_sold", "created_at", "updated_at"].includes(internalField)
            ) {
              // Handle timestamp fields - set null for empty values
              if (value === "" || value === null || value === undefined) {
                item[internalField] = null;
              } else {
                // Try to parse as ISO date string, otherwise keep as string
                const parsedDate = new Date(value);
                if (!isNaN(parsedDate.getTime())) {
                  item[internalField] = parsedDate.toISOString();
                } else {
                  item[internalField] = value;
                }
              }
            }
            // Handle boolean fields with proper defaults matching database schema
            else if (
              [
                "gallery_certification",
                "artist_certification",
                "artist_family_certification",
                "restoration_done",
                "include_artist_description",
                "include_artist_key_description",
                "include_artist_biography",
                "include_artist_notable_works",
                "include_artist_major_exhibitions",
                "include_artist_awards_honors",
                "include_artist_market_value_range",
                "include_artist_signature_style",
              ].includes(internalField)
            ) {
              if (!value || value.trim() === "") {
                // Set appropriate default values matching database schema
                if (
                  [
                    "include_artist_description",
                    "include_artist_key_description",
                  ].includes(internalField)
                ) {
                  item[internalField] = true; // These default to true in schema
                } else {
                  item[internalField] = false; // Others default to false in schema
                }
              } else {
                item[internalField] =
                  value.toLowerCase() === "true" || value === "1";
              }
            }
            // Handle status field with validation
            else if (internalField === "status") {
              if (
                [
                  "draft",
                  "active",
                  "sold",
                  "withdrawn",
                  "passed",
                  "returned",
                ].includes(value.toLowerCase())
              ) {
                item.status = value.toLowerCase();
              }
            }
            // Handle brand field (brand_id directly)
            else if (internalField === "brand_id") {
              if (value && !isNaN(Number(value))) {
                item.brand_id = parseInt(value);
              }
            }
            // Handle return fields
            else if (internalField === "return_date") {
              if (value) {
                const parsedDate = new Date(value);
                if (!isNaN(parsedDate.getTime())) {
                  item.return_date = parsedDate.toISOString();
                } else {
                  item.return_date = value;
                }
              }
            } else if (internalField === "return_location") {
              if (value) {
                item.return_location = value;
              }
            } else if (internalField === "return_reason") {
              if (value) {
                item.return_reason = value;
              }
            } else if (internalField === "returned_by_user_id") {
              if (value && value.trim()) {
                item.returned_by_user_id = value.trim();
              } else {
                item.returned_by_user_id = null;
              }
            } else if (internalField === "returned_by_user_name") {
              if (value) {
                item.returned_by_user_name = value;
              }
            }
            // Handle regular string fields
            else if (internalField === "description") {
              // Replace newlines with <br> tags for storage
              item[internalField] = value.replace(/\n/g, "<br>");
            }
            // Skip boolean fields as they're handled above
            else if (
              ![
                "gallery_certification",
                "artist_certification",
                "artist_family_certification",
                "restoration_done",
                "include_artist_description",
                "include_artist_key_description",
                "include_artist_biography",
                "include_artist_notable_works",
                "include_artist_major_exhibitions",
                "include_artist_awards_honors",
                "include_artist_market_value_range",
                "include_artist_signature_style",
              ].includes(internalField)
            ) {
              item[internalField] = value;
            }
          }
          // Handle legacy field names for backward compatibility
          else {
            switch (lowerHeader) {
              case "lot_number":
              case "lot_num":
                // Legacy support: lot numbers are now represented by ID
                // For imports, we treat lot_num as an external reference but use our auto-generated IDs
                break;
              case "low_estimate":
              case "high_estimate":
                // Already handled above in field mapping
                break;
              case "dimensions":
                // Legacy dimension field - keep for backward compatibility
                item.dimensions = value;
                break;
              case "weight":
                // Weight field
                item.weight = value;
                break;
              case "artist":
              case "maker":
                // Map to artist_maker
                item.artist_maker = value;
                break;
              case "period":
              case "age":
                // Map to period_age
                item.period_age = value;
                break;
              // Legacy image fields removed - use images array instead
              default:
                // Store unmapped fields in a metadata column if it exists
                break;
            }
          }
        });

        // Assign brand if provided (only use brand_id directly)
        if (defaultBrandId && !item.brand_id) {
          item.brand_id = defaultBrandId;
        }

        // Set default values for fields that are not present in Google Sheet
        const booleanFields = [
          "gallery_certification",
          "artist_certification",
          "artist_family_certification",
          "restoration_done",
          "include_artist_description",
          "include_artist_key_description",
          "include_artist_biography",
          "include_artist_notable_works",
          "include_artist_major_exhibitions",
          "include_artist_awards_honors",
          "include_artist_market_value_range",
          "include_artist_signature_style",
        ];
        const integerFields = [
          "artist_id",
          "consignment_id",
          "vendor_id",
          "buyer_id",
        ];
        const timestampFields = ["date_sold", "created_at", "updated_at"];
        const numericFieldsWithDefaults = [
          "low_est",
          "high_est",
          "start_price",
          "reserve",
        ];

        booleanFields.forEach((fieldName) => {
          if (!(fieldName in item)) {
            // Field not present in sheet, set appropriate default
            if (
              [
                "include_artist_description",
                "include_artist_key_description",
              ].includes(fieldName)
            ) {
              item[fieldName] = true; // These default to true in schema
            } else {
              item[fieldName] = false; // Others default to false in schema
            }
          }
        });

        integerFields.forEach((fieldName) => {
          if (!(fieldName in item)) {
            // Field not present in sheet, set to null
            item[fieldName] = null;
          }
          // also check if the field is empty string and set to null
          if (item[fieldName] === "") {
            item[fieldName] = null;
          }
        });

        timestampFields.forEach((fieldName) => {
          if (!(fieldName in item)) {
            // Field not present in sheet, set to null
            item[fieldName] = null;
          }
          // also check if the field is empty string and set to null
          if (item[fieldName] === "") {
            item[fieldName] = null;
          }
        });

        // Set default values for numeric fields (low_est, high_est, start_price, reserve)
        numericFieldsWithDefaults.forEach((fieldName) => {
          if (
            !(fieldName in item) ||
            item[fieldName] === "" ||
            item[fieldName] === null ||
            item[fieldName] === undefined
          ) {
            // Set default values for missing or empty fields
            switch (fieldName) {
              case "low_est":
                item[fieldName] = 200;
                break;
              case "high_est":
                item[fieldName] = 400;
                break;
              case "start_price":
                item[fieldName] = 100;
                break;
              case "reserve":
                item[fieldName] = 100;
                break;
            }
          }
        });

        // Set required fields with defaults if missing
        if (!item.title) {
          errors.push(`Row ${i + 2}: Title is required`);
          continue;
        }
        if (!item.description) {
          item.description = item.title; // Use title as description if missing
        }

        // Log item processing for debugging
        console.log(`[Google Sheets] Processing item ${i + 2}:`, {
          id: item.id,
          title: item.title?.substring(0, 50),
          hasImages: !!(
            item.images &&
            Array.isArray(item.images) &&
            item.images.length > 0
          ),
        });
        // ID will be auto-generated by database if not provided

        // Both Google Sheets and CSV imports now allow optional estimates with default values

        if (!item.status) {
          item.status = "active";
        }

        // Store the item with extracted ID for image mapping
        upserts.push({
          ...item,
          _extractedImageMappingId: extractedImageMappingId, // Track for image mapping
        });
      } catch (error: any) {
        errors.push(`Row ${i + 2}: ${error.message}`);
      }
    }

    console.log("Processed items:", upserts.length);
    console.log("Errors:", errors.length);
    //show 10 errors
    console.log("Errors:", errors.slice(0, 10));

    if (upserts.length === 0) {
      return res.json({
        success: false,
        error: "No valid items to import",
        errors: errors.slice(0, 10),
        processed: 0,
        upserted: 0,
      });
    }

    // Batch upsert to database (without extracted IDs)
    const batchSize = 50;
    let totalUpserted = 0;
    const batchErrors: string[] = [];
    const upsertedItems: any[] = []; // Track items with their database IDs

    for (let i = 0; i < upserts.length; i += batchSize) {
      const batch = upserts.slice(i, i + batchSize);

      try {
        // Remove extracted ID from items before upserting (let Supabase handle ID generation)
        const itemsForUpsert = batch.map((item) => {
          const { _extractedImageMappingId, ...itemWithoutExtractedId } = item;
          return itemWithoutExtractedId;
        });

        const { data, error } = await supabaseAdmin
          .from("items")
          .upsert(itemsForUpsert, { onConflict: "id" })
          .select("id, title");

        if (error) {
          const errorMsg = `Batch ${Math.floor(i / batchSize) + 1}: Database error - ${error.message}`;
          console.error("Supabase upsert error:", error);
          batchErrors.push(errorMsg);
          continue;
        }

        // Track upserted items with their extracted IDs for image mapping
        if (data) {
          for (let j = 0; j < data.length; j++) {
            const dbItem = data[j];
            const originalItem = batch[j];
            upsertedItems.push({
              ...dbItem,
              _extractedImageMappingId: originalItem._extractedImageMappingId,
            });
          }
        }

        totalUpserted += data?.length || 0;
      } catch (error: any) {
        const errorMsg = `Batch ${Math.floor(i / batchSize) + 1}: Processing error - ${error.message}`;
        console.error("Batch processing error:", error);
        batchErrors.push(errorMsg);
      }
    }

    const allErrors = [...errors, ...batchErrors];

    console.log("Sync complete:", {
      totalProcessed: upserts.length,
      totalUpserted,
      totalErrors: allErrors.length,
    });

    // If drive folder provided, map images using common function
    if (drive_folder_url) {
      const imageMappingResult = await mapImagesFromDriveFolder(
        drive_folder_url,
        upsertedItems,
        "google_sheets",
      );

      // Add any image mapping errors to the main errors array
      if (imageMappingResult.errors.length > 0) {
        allErrors.push(...imageMappingResult.errors);
      }
    }

    // Sync back functionality disabled for now
    let syncBackResult = null;

    // If auction_id is provided, add the imported items to the auction
    let auctionUpdateResult = null;
    if (auction_id && upsertedItems && upsertedItems.length > 0) {
      try {
        // Get current auction artwork_ids
        const { data: auctionData, error: auctionError } = await supabaseAdmin
          .from("auctions")
          .select("artwork_ids")
          .eq("id", auction_id)
          .single();

        if (auctionError) {
          console.error("Error fetching auction for update:", auctionError);
          auctionUpdateResult = {
            success: false,
            message: `Failed to fetch auction: ${auctionError.message}`,
          };
        } else {
          // Add new item IDs to existing artwork_ids array
          const currentArtworkIds = auctionData.artwork_ids || [];
          const newItemIds = upsertedItems
            .map((item) => item.id)
            .filter((id): id is number => typeof id === "number");
          const updatedArtworkIds = [
            ...new Set([...currentArtworkIds, ...newItemIds]),
          ]; // Remove duplicates

          // Update the auction with new artwork_ids
          const { error: updateError } = await supabaseAdmin
            .from("auctions")
            .update({ artwork_ids: updatedArtworkIds })
            .eq("id", auction_id);

          if (updateError) {
            console.error(
              "Error updating auction with new items:",
              updateError,
            );
            auctionUpdateResult = {
              success: false,
              message: `Failed to add items to auction: ${updateError.message}`,
            };
          } else {
            console.log(
              `✅ Added ${newItemIds.length} items to auction ${auction_id}`,
            );
            auctionUpdateResult = {
              success: true,
              message: `Added ${newItemIds.length} items to auction`,
              added_count: newItemIds.length,
            };
          }
        }
      } catch (auctionUpdateError: any) {
        console.error("Error during auction update:", auctionUpdateError);
        auctionUpdateResult = {
          success: false,
          message: `Auction update failed: ${auctionUpdateError.message}`,
        };
      }
    }

    res.json({
      success: true,
      upserted: totalUpserted,
      processed: upserts.length,
      errors: allErrors.slice(0, 50), // Limit errors to prevent overwhelming response
      summary: {
        csvUrl,
        rowsInCsv: dataRows.length,
        rowsProcessed: upserts.length,
        rowsUpserted: totalUpserted,
        errorCount: allErrors.length,
      },
      sync_back: syncBackResult,
      auction_update: auctionUpdateResult,
    });
  } catch (error: any) {
    console.error("Error in POST /items/sync-google-sheet:", error);
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

// Helper function to convert Google Sheets URL to CSV export URL
function convertToGoogleSheetsCSVUrl(url: string): string {
  try {
    // Extract spreadsheet ID from various Google Sheets URL formats
    const spreadsheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!spreadsheetIdMatch) {
      throw new Error("Invalid Google Sheets URL format");
    }

    const spreadsheetId = spreadsheetIdMatch[1];

    // Extract gid (sheet ID) if present
    const gidMatch = url.match(/[#&]gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : "0";

    // Return CSV export URL
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  } catch (error) {
    console.error("Error converting Google Sheets URL:", error);
    throw error;
  }
}

// POST /api/items/generate-pdf-catalog - Generate PDF catalog using backend PDFKit
router.post("/generate-pdf-catalog", async (req, res) => {
  try {
    const { item_ids, options, brand_code } = req.body as {
      item_ids?: string[];
      options?: any;
      brand_code?: string;
    };

    if (!item_ids || !Array.isArray(item_ids) || item_ids.length === 0) {
      return res
        .status(400)
        .json({ error: "item_ids array is required and must not be empty" });
    }

    console.log(
      "Generating PDF catalog for items:",
      item_ids.length,
      "IDs:",
      item_ids,
    );

    // Parse and filter valid item IDs
    const parsedIds = item_ids
      .map((id) => parseInt(id.toString()))
      .filter((id) => !isNaN(id));
    console.log(
      "Parsed IDs:",
      parsedIds,
      "Filtered out:",
      item_ids.length - parsedIds.length,
    );

    // Fetch artworks by IDs
    let query = supabaseAdmin
      .from("items")
      .select(
        `
        *,
        brands (
          id,
          name,
          code,
          brand_address,
          contact_email,
          contact_phone,
          business_whatsapp_number,
          bank_accounts,
          logo_url,
          company_registration,
          vat_number,
          eori_number,
          terms_and_conditions,
          buyer_terms_and_conditions,
          vendor_terms_and_conditions
        )
      `,
      )
      .in("id", parsedIds);

    const { data: artworks, error } = await query;

    if (error) {
      console.error("Error fetching artworks for PDF catalog:", error);
      return res.status(500).json({
        error: "Failed to fetch artworks",
        details: error.message,
      });
    }

    console.log("Fetched artworks:", artworks?.length || 0, "from database");

    if (!artworks || artworks.length === 0) {
      return res
        .status(404)
        .json({ error: "No artworks found for the provided IDs" });
    }

    if (artworks.length !== parsedIds.length) {
      console.warn(
        `Mismatch: requested ${parsedIds.length} items but got ${artworks.length}`,
      );
    }

    // Get unique brands with complete data for PDF generation
    const brands = artworks
      .map((artwork) => artwork.brands)
      .filter((brand) => brand)
      .filter(
        (brand, index, arr) =>
          arr.findIndex((b) => b.id === brand.id) === index,
      );

    // If no brands found or brand_code is provided, fetch the specified brand or default
    if (brands.length === 0 || brand_code) {
      const targetBrandCode = brand_code || "MSABER";
      const { data: defaultBrand, error: brandError } = await supabaseAdmin
        .from("brands")
        .select("*")
        .eq("code", targetBrandCode)
        .single();

      if (!brandError && defaultBrand) {
        // Replace or add the default brand
        const existingIndex = brands.findIndex(
          (b) => b.code === targetBrandCode,
        );
        if (existingIndex >= 0) {
          brands[existingIndex] = defaultBrand;
        } else {
          brands.push(defaultBrand);
        }
      }
    }

    // Set default options if not provided
    const defaultOptions = {
      includeTitle: true,
      includeImages: true,
      includeDescription: true,
      includeArtist: true,
      includeArtistBiography: false,
      includeArtistDescription: false,
      includeArtistExtraInfo: false,
      includeDimensions: true,
      includeCondition: false,
      includeMaterials: false,
      includeProvenance: false,
      includeEstimates: true,
      includeConsigner: false,
      includeLotNumbers: true,
      includeCategory: false,
      includePeriodAge: false,
      includeWeight: false,
      includeImageCaptions: false,
      layoutType: "cards",
      itemsPerPage: 4,
      showPageNumbers: true,
      catalogTitle: "Auction Catalog",
      catalogSubtitle: "",
      includeHeader: true,
      includeFooter: true,
      logoUrl: "",
      showBrandLogos: true,
      imagesPerItem: 2,
      imageSize: "medium",
      showImageBorder: true,
      ...options,
    };

    console.log("Generating PDF with options:", defaultOptions);

    // Generate PDF using the backend PDF generator
    const { generatePDFCatalog } =
      await import("../utils/pdf-catalog-generator");
    const pdfBuffer = await generatePDFCatalog(
      artworks,
      defaultOptions,
      brands,
    );

    // Set response headers for PDF download
    const timestamp = new Date().toISOString().split("T")[0];

    // Sanitize filename for Windows/Outlook compatibility
    const sanitizeFilename = (title: string): string => {
      // Replace invalid Windows filename characters with underscores
      let sanitized = title.replace(/[<>:"|?*\\]/g, "_");
      // Remove or replace other problematic characters, keep alphanumeric and common punctuation
      // Replace spaces with underscores for better email attachment compatibility
      sanitized = sanitized.replace(/[^a-zA-Z0-9\-_.]/g, "_");
      // Replace multiple consecutive underscores with single underscore
      sanitized = sanitized.replace(/_+/g, "_");
      // Remove leading/trailing underscores
      sanitized = sanitized.replace(/^_+|_+$/g, "");
      // Ensure we have a valid filename, fallback to 'catalog' if empty
      return sanitized || "catalog";
    };

    const sanitizedTitle = sanitizeFilename(defaultOptions.catalogTitle);
    const filename = `catalog_${sanitizedTitle.toLowerCase()}_${timestamp}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);

    // Send the PDF buffer
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error("Error generating PDF catalog:", error);
    res.status(500).json({
      error: "Failed to generate PDF catalog",
      details: error.message,
    });
  }
});

// Helper function to generate vendor invoices for assigned items
async function generateVendorInvoicesForAssignedItems(
  itemIds: number[],
  vendorId: number,
  consignmentId: number,
  brandId: number,
) {
  try {
    // Get item details with auction information
    const { data: items, error: itemsError } = await supabaseAdmin
      .from("items")
      .select(
        `
        id,
        sale_price,
        final_price,
        auctions!inner(id, short_name, long_name, settlement_date)
      `,
      )
      .in("id", itemIds)
      .not("sale_price", "is", null);

    if (itemsError) {
      console.error(
        "Error fetching items for vendor invoice generation:",
        itemsError,
      );
      return;
    }

    if (!items || items.length === 0) {
      console.log("No sold items found for vendor invoice generation");
      return;
    }

    // Group items by auction
    const auctionGroups = new Map<number, any[]>();
    items.forEach((item) => {
      if (
        item.auctions &&
        Array.isArray(item.auctions) &&
        item.auctions.length > 0
      ) {
        const auction = item.auctions[0]; // Get first auction since items can only be in one auction
        const auctionId = auction.id;
        if (!auctionGroups.has(auctionId)) {
          auctionGroups.set(auctionId, []);
        }
        auctionGroups.get(auctionId)!.push(item);
      }
    });

    // Get vendor details
    const { data: vendor, error: vendorError } = await supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name, email, phone_number, vendor_premium")
      .eq("id", vendorId)
      .single();

    if (vendorError || !vendor) {
      console.error(
        "Error fetching vendor for invoice generation:",
        vendorError,
      );
      return;
    }

    // Generate invoice for each auction
    for (const [auctionId, auctionItems] of auctionGroups.entries()) {
      const item_ids: number[] = [];
      const lot_ids: string[] = [];
      const sale_prices: number[] = [];
      const buyer_premium_prices: number[] = [];

      // Get lot numbers from auction artwork_ids mapping
      const { data: auction, error: auctionError } = await supabaseAdmin
        .from("auctions")
        .select("artwork_ids")
        .eq("id", auctionId)
        .single();

      if (auctionError || !auction) {
        console.error("Error fetching auction for lot mapping:", auctionError);
        continue;
      }

      auctionItems.forEach((item) => {
        item_ids.push(item.id);
        sale_prices.push(item.sale_price || 0);

        // Calculate vendor premium from sale price and client's vendor_premium rate
        const vendorPremium =
          (item.sale_price || 0) * ((vendor.vendor_premium || 0) / 100);
        buyer_premium_prices.push(vendorPremium);

        // Find lot number from auction artwork_ids
        if (auction.artwork_ids && Array.isArray(auction.artwork_ids)) {
          const itemIndex = auction.artwork_ids.indexOf(item.id);
          if (itemIndex >= 0) {
            lot_ids.push((itemIndex + 1).toString());
          } else {
            lot_ids.push("Unknown");
          }
        } else {
          lot_ids.push("Unknown");
        }
      });

      // Check if vendor invoice already exists for this auction and vendor
      const { data: existingInvoice, error: checkError } = await supabaseAdmin
        .from("invoices")
        .select("id")
        .eq("auction_id", auctionId)
        .eq("client_id", vendorId)
        .eq("type", "vendor")
        .single();

      let invoiceData = {
        auction_id: auctionId,
        brand_id: brandId,
        platform: "manual_assignment",
        lot_ids,
        item_ids,
        sale_prices,
        buyer_premium_prices,
        buyer_first_name: vendor.first_name || "",
        buyer_last_name: vendor.last_name || "",
        buyer_email: vendor.email || "",
        buyer_phone: vendor.phone_number || "",
        status: "unpaid",
        client_id: vendorId,
        type: "vendor",
        paid_amount: 0,
        invoice_number: `VN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      };

      if (existingInvoice) {
        // Update existing vendor invoice
        const { error: updateError } = await supabaseAdmin
          .from("invoices")
          .update(invoiceData)
          .eq("id", existingInvoice.id);

        if (updateError) {
          console.error("Error updating vendor invoice:", updateError);
        } else {
          console.log(
            `Updated vendor invoice for auction ${auctionId}, vendor ${vendorId}`,
          );
        }
      } else {
        // Create new vendor invoice
        const { error: insertError } = await supabaseAdmin
          .from("invoices")
          .insert(invoiceData);

        if (insertError) {
          console.error("Error creating vendor invoice:", insertError);
        } else {
          console.log(
            `Created vendor invoice for auction ${auctionId}, vendor ${vendorId}`,
          );
        }
      }
    }
  } catch (error) {
    console.error("Error generating vendor invoices:", error);
  }
}

// POST /api/items/assign-vendor - Assign vendor to items and optionally create consignment
router.post("/assign-vendor", async (req, res) => {
  try {
    const { item_ids, vendor_id, consignment_id, assignments } = req.body;

    // Support both single assignment format and batch assignment format
    let assignmentsToProcess = [];

    if (assignments && Array.isArray(assignments)) {
      // Batch assignment format: [{ item_ids: [], vendor_id: number, consignment_id?: number }]
      assignmentsToProcess = assignments;
    } else if (item_ids && vendor_id) {
      // Single assignment format: { item_ids: [], vendor_id: number, consignment_id?: number }
      assignmentsToProcess = [
        {
          item_ids,
          vendor_id,
          consignment_id,
        },
      ];
    } else {
      return res.status(400).json({
        success: false,
        message: "Either provide assignments array or item_ids with vendor_id",
      });
    }

    const results = [];

    // Process each assignment
    for (const assignment of assignmentsToProcess) {
      const {
        item_ids: assignmentItemIds,
        vendor_id: assignmentVendorId,
        consignment_id: assignmentConsignmentId,
      } = assignment;

      if (
        !assignmentItemIds ||
        !Array.isArray(assignmentItemIds) ||
        assignmentItemIds.length === 0
      ) {
        results.push({
          success: false,
          message: "item_ids array is required for each assignment",
        });
        continue;
      }

      if (!assignmentVendorId) {
        results.push({
          success: false,
          message: "vendor_id is required for each assignment",
        });
        continue;
      }

      // Validate vendor exists
      const { data: vendor, error: vendorError } = await supabaseAdmin
        .from("clients")
        .select("id, first_name, last_name, brand_id")
        .eq("id", assignmentVendorId)
        .single();

      if (vendorError || !vendor) {
        results.push({
          success: false,
          message: "Vendor not found",
        });
        continue;
      }

      let finalConsignmentId = assignmentConsignmentId;

      // If no consignment_id provided, create a new consignment
      if (!finalConsignmentId) {
        const { data: newConsignment, error: consignmentError } =
          await supabaseAdmin
            .from("consignments")
            .insert([
              {
                client_id: assignmentVendorId,
                status: "active",
                created_at: new Date().toISOString(),
              },
            ])
            .select("id")
            .single();

        if (consignmentError) {
          results.push({
            success: false,
            message: "Failed to create consignment",
            error: consignmentError.message,
          });
          continue;
        }

        finalConsignmentId = newConsignment.id;
      } else {
        // Validate that the provided consignment exists and belongs to the vendor
        const { data: existingConsignment, error: consignmentCheckError } =
          await supabaseAdmin
            .from("consignments")
            .select("id, client_id")
            .eq("id", assignmentConsignmentId)
            .single();

        if (consignmentCheckError || !existingConsignment) {
          results.push({
            success: false,
            message: "Consignment not found",
          });
          continue;
        }

        if (existingConsignment.client_id !== assignmentVendorId) {
          results.push({
            success: false,
            message: "Consignment does not belong to the specified vendor",
          });
          continue;
        }

        // Note: Items are linked to consignments via the consignment_id foreign key in items table
        // No need to update consignment record itself
      }

      // Update items with vendor_id and consignment_id
      const { error: updateError } = await supabaseAdmin
        .from("items")
        .update({
          vendor_id: assignmentVendorId,
          consignment_id: finalConsignmentId,
        })
        .in("id", assignmentItemIds);

      if (updateError) {
        results.push({
          success: false,
          message: "Failed to assign vendor to items",
          error: updateError.message,
        });
        continue;
      }

      // Generate vendor invoices for the assigned items
      await generateVendorInvoicesForAssignedItems(
        assignmentItemIds,
        assignmentVendorId,
        finalConsignmentId,
        vendor.brand_id,
      );

      results.push({
        success: true,
        message: `Successfully assigned vendor to ${assignmentItemIds.length} item(s) and generated vendor invoices`,
        data: {
          vendor_id: assignmentVendorId,
          consignment_id: finalConsignmentId,
          item_ids: assignmentItemIds,
        },
      });
    }

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.length - successCount;

    res.json({
      success: failureCount === 0,
      message: `Processed ${results.length} assignments: ${successCount} successful, ${failureCount} failed`,
      results,
    });
  } catch (error: any) {
    console.error("Error in POST /items/assign-vendor:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Items Google Sheets Sync Manager Endpoints
router.post(
  "/sync-manager/manual",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const result =
        await getItemsGoogleSheetsSyncManager().triggerManualSync();
      res.json(result);
    } catch (error: any) {
      console.error("Error in POST /items/sync-manager/manual:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error during manual sync",
      });
    }
  },
);

router.post(
  "/sync-manager/start-scheduled",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      getItemsGoogleSheetsSyncManager().startScheduledSync();
      res.json({
        success: true,
        message: "Scheduled sync started (runs every 15 minutes)",
      });
    } catch (error: any) {
      console.error(
        "Error in POST /items/sync-manager/start-scheduled:",
        error,
      );
      res.status(500).json({
        success: false,
        message: "Internal server error starting scheduled sync",
      });
    }
  },
);

router.post(
  "/sync-manager/stop-scheduled",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      getItemsGoogleSheetsSyncManager().stopScheduledSync();
      res.json({
        success: true,
        message: "Scheduled sync stopped",
      });
    } catch (error: any) {
      console.error("Error in POST /items/sync-manager/stop-scheduled:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error stopping scheduled sync",
      });
    }
  },
);

router.post(
  "/sync-manager/start-polling",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const { interval_minutes = 15 } = req.body;
      getItemsGoogleSheetsSyncManager().startPolling(interval_minutes);

      res.json({
        success: true,
        message: `Polling sync started (every ${interval_minutes} minutes)`,
      });
    } catch (error: any) {
      console.error("Error in POST /items/sync-manager/start-polling:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error starting polling sync",
      });
    }
  },
);

router.post(
  "/sync-manager/stop-polling",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      getItemsGoogleSheetsSyncManager().stopPolling();
      res.json({
        success: true,
        message: "Polling sync stopped",
      });
    } catch (error: any) {
      console.error("Error in POST /items/sync-manager/stop-polling:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error stopping polling sync",
      });
    }
  },
);

router.get(
  "/sync-manager/status",
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const status = getItemsGoogleSheetsSyncManager().getSyncStatus();
      res.json({
        success: true,
        status,
      });
    } catch (error: any) {
      console.error("Error in GET /items/sync-manager/status:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error getting sync status",
      });
    }
  },
);

export default router;

// POST /api/items/images/upload/ftp - Upload a zip of images to FTP (e.g., LiveAuctioneers bulk image upload)
// Purpose: Allow admins to push a prepared set of image files to the platform's FTP. Images should be named per platform rules.
router.post("/images/upload/ftp", async (req, res) => {
  try {
    const {
      host,
      port,
      user,
      password,
      secure = false,
      base_dir = "/",
      files,
    } = req.body as {
      host: string;
      port?: number;
      user: string;
      password: string;
      secure?: boolean;
      base_dir?: string;
      files: { path: string; content: string; encoding?: "base64" | "utf8" }[];
    };
    if (
      !host ||
      !user ||
      !password ||
      !Array.isArray(files) ||
      files.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "host, user, password and files[] are required" });
    }
    const client = new ftp.Client(30_000);
    client.ftp.verbose = false;
    try {
      await client.access({ host, port: port || 21, user, password, secure });
      if (base_dir && base_dir !== "/") {
        await client.ensureDir(base_dir);
        await client.cd(base_dir);
      }
      let uploaded = 0;
      for (const f of files) {
        const buf =
          f.encoding === "base64"
            ? Buffer.from(f.content, "base64")
            : Buffer.from(f.content, "utf8");
        await client.uploadFrom(Readable.from(buf), f.path);
        uploaded++;
      }
      await client.close();
      return res.json({ success: true, uploaded });
    } catch (e: any) {
      try {
        await client.close();
      } catch {}
      return res
        .status(500)
        .json({ error: "FTP upload failed", details: e.message });
    }
  } catch (error: any) {
    return res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

// POST /api/items/images/upload/ftp/from-items - Automatically fetch item images and upload to FTP (LiveAuctioneers)
router.post("/images/upload/ftp/from-items", async (req, res) => {
  try {
    const {
      brand_code,
      platform = "liveauctioneers",
      item_ids,
      base_dir = "/",
      host,
      secure,
    } = (req.body || {}) as {
      brand_code: string;
      platform?: string;
      item_ids?: string[];
      base_dir?: string;
      host?: string;
      secure?: boolean;
    };

    if (!brand_code)
      return res.status(400).json({ error: "brand_code is required" });
    const normalized = normalizePlatform(platform);
    if (normalized !== "liveauctioneers")
      return res
        .status(400)
        .json({
          error:
            "Only LiveAuctioneers is supported for automatic FTP upload at this time",
        });

    // Resolve brand id
    // Brand credential lookup disabled for now - get any available LiveAuctioneers credentials
    const { data: cred, error: ce } = await supabaseAdmin
      .from("platform_credentials")
      .select("*")
      .eq("platform", "LIVE_AUCTIONEERS")
      .single();
    if (ce || !cred)
      return res
        .status(400)
        .json({ error: "LiveAuctioneers FTP credentials not configured" });

    // Fetch items by ids
    let query = supabaseAdmin.from("items").select("*");
    if (item_ids && item_ids.length > 0) {
      // Sort item_ids by ID ascending to ensure proper ordering
      const sortedItemIds = item_ids
        .map((id) => parseInt(id.toString()))
        .filter((id) => !isNaN(id))
        .sort((a, b) => a - b);
      query = query.in("id", sortedItemIds);
    }
    const { data: items, error: ie } = await query.order("id", {
      ascending: true,
    });

    // Filter out items without images array or with empty images array
    const itemsWithImages =
      items?.filter(
        (item) =>
          item.images && Array.isArray(item.images) && item.images.length > 0,
      ) || [];

    // Ensure items are sorted by ID
    if (items && items.length > 0) {
      items.sort((a, b) => {
        const idA = typeof a.id === "string" ? parseInt(a.id) : a.id || 0;
        const idB = typeof b.id === "string" ? parseInt(b.id) : b.id || 0;
        return idA - idB;
      });
    }
    if (ie)
      return res
        .status(500)
        .json({ error: "Failed to load items", details: ie.message });
    if (!itemsWithImages || itemsWithImages.length === 0)
      return res
        .status(400)
        .json({ error: "No items with images found for the provided filter" });

    // Connect to FTP
    const client = new ftp.Client(60_000);
    client.ftp.verbose = false;
    const ftpHost = host || cred.additional?.host || "ftp.liveauctioneers.com";
    const ftpSecure =
      typeof secure === "boolean" ? secure : !!cred.additional?.secure;
    try {
      await client.access({
        host: ftpHost,
        port: 21,
        user: cred.key_id,
        password: cred.secret_value,
        secure: ftpSecure,
      });
      if (base_dir && base_dir !== "/") {
        await client.ensureDir(base_dir);
        await client.cd(base_dir);
      }
      let uploaded = 0;
      const errors: string[] = [];

      for (const it of itemsWithImages) {
        const lot = String((it as any).id || "");
        // Process images from the images array
        if (it.images && Array.isArray(it.images)) {
          for (let i = 0; i < it.images.length; i++) {
            const url = it.images[i];
            if (!url) continue;
            try {
              const resp = await fetch(url);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const ab = await resp.arrayBuffer();
              const buf = Buffer.from(ab);
              const filename = derivedImageFilename(String(url), lot, i + 1);
              await client.uploadFrom(Readable.from(buf), filename);
              uploaded++;
            } catch (e: any) {
              errors.push(
                `Lot ${lot} img#${i + 1}: ${e.message || "download/upload error"}`,
              );
            }
          }
        }
      }

      try {
        await client.close();
      } catch {}
      return res.json({ success: true, uploaded, errors });
    } catch (e: any) {
      try {
        await client.close();
      } catch {}
      return res
        .status(500)
        .json({ error: "FTP upload failed", details: e.message });
    }
  } catch (error: any) {
    return res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

// Function to auto-sync artworks to Google Sheets after create/update
async function autoSyncArtworkToGoogleSheets(
  artworkId: number,
  brandId?: number,
) {
  console.log(`🚀 AUTO-SYNC: Initiating single item sync for ID ${artworkId}`);
  const success = await autoSyncSingleItemToGoogleSheets(artworkId);
  if (!success) {
    console.error(
      `❌ AUTO-SYNC: Wrapper function failed for item ${artworkId}`,
    );
  } else {
    console.log(
      `✅ AUTO-SYNC: Wrapper function completed successfully for item ${artworkId}`,
    );
  }
}

// Enhanced Google Sheets Sync Manager for Items
class ItemsGoogleSheetsSyncManager {
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
      const cron = require("node-cron");

      // Run every 15 minutes as requested
      this.cronJob = cron.schedule(
        "*/15 * * * *",
        async () => {
          console.log(
            "⏰ ITEMS SCHEDULED SYNC: Starting 15-minute interval sync",
          );
          await this.performScheduledSync();
        },
        {
          scheduled: false, // Don't start automatically
        },
      );

      console.log(
        "✅ ItemsGoogleSheetsSyncManager cron job initialized successfully",
      );
    } catch (error) {
      console.error("❌ Failed to initialize items cron job:", error);
      // Set to null so other methods can handle gracefully
      this.cronJob = null as any;
    }
  }

  // Start scheduled sync
  startScheduledSync() {
    if (this.cronJob) {
      this.cronJob.start();
      console.log("✅ ITEMS SCHEDULED SYNC: Started 15-minute interval sync");
    } else {
      console.log("⚠️ ITEMS SCHEDULED SYNC: Cron job not available");
    }
  }

  // Stop scheduled sync
  stopScheduledSync() {
    if (this.cronJob) {
      this.cronJob.stop();
      console.log("⏹️ ITEMS SCHEDULED SYNC: Stopped 15-minute interval sync");
    } else {
      console.log("⚠️ ITEMS SCHEDULED SYNC: Cron job not available");
    }
  }

  // Get sync status
  getSyncStatus() {
    return {
      pollingActive: this.isPolling,
      scheduledActive: this.cronJob ? !this.cronJob.destroyed : false,
      lastSyncTimestamps: Object.fromEntries(this.lastSyncTimestamps),
      syncInProgress: Array.from(this.syncInProgress),
      cronAvailable: !!this.cronJob,
    };
  }

  // Perform scheduled sync
  private async performScheduledSync() {
    const configKey = "google_sheet_url_artworks";
    try {
      if (this.syncInProgress.has(configKey)) {
        console.log(
          "⚠️ ITEMS SCHEDULED SYNC: Sync already in progress, skipping",
        );
        return;
      }

      this.syncInProgress.add(configKey);
      console.log(
        "🔄 ITEMS SCHEDULED SYNC: Checking for Google Sheets changes",
      );

      const changes = await this.pollGoogleSheetsForChanges();
      if (changes && changes.length > 0) {
        console.log(
          `📊 ITEMS SCHEDULED SYNC: Found ${changes.length} changes, processing...`,
        );
        await this.processGoogleSheetsChanges(changes);
        this.lastSyncTimestamps.set(configKey, new Date());
      } else {
        console.log("📊 ITEMS SCHEDULED SYNC: No changes detected");
      }
    } catch (error: any) {
      console.error("❌ ITEMS SCHEDULED SYNC: Error during sync:", error);
    } finally {
      this.syncInProgress.delete(configKey);
    }
  }

  // Poll Google Sheets for changes
  private async pollGoogleSheetsForChanges(): Promise<any[] | null> {
    try {
      const { google } = require("googleapis");

      // Get Google Sheets URL from app settings
      const { data: settingData } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", "google_sheet_url_artworks")
        .single();

      if (!settingData?.value) {
        console.log("❌ ITEMS POLLING: No Google Sheets URL configured");
        return null;
      }

      // Extract URL
      let actualSheetUrl = "";
      if (typeof settingData.value === "string") {
        try {
          const parsed = JSON.parse(settingData.value);
          actualSheetUrl =
            typeof parsed === "object" && parsed !== null ? parsed.url : parsed;
        } catch {
          actualSheetUrl = settingData.value;
        }
      } else if (
        typeof settingData.value === "object" &&
        settingData.value !== null
      ) {
        actualSheetUrl = settingData.value.url || "";
      }

      if (!actualSheetUrl) {
        console.log("❌ ITEMS POLLING: Google Sheets URL is empty");
        return null;
      }

      // Extract spreadsheet ID
      const sheetIdMatch = actualSheetUrl.match(
        /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
      );
      if (!sheetIdMatch) {
        console.log("❌ ITEMS POLLING: Invalid Google Sheets URL format");
        return null;
      }

      const spreadsheetId = sheetIdMatch[1];

      // Initialize Google Sheets API
      const auth = new google.auth.GoogleAuth({
        credentials: {
          type: "service_account",
          project_id: process.env.GOOGLE_PROJECT_ID || "msaber-project",
          private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
          private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
          client_email: process.env.GOOGLE_CLIENT_EMAIL,
          client_id: process.env.GOOGLE_CLIENT_ID,
        } as any,
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      });

      const sheets = google.sheets({ version: "v4", auth });

      // Get current sheet data
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Sheet1",
      });

      const rows = response.data.values || [];
      if (rows.length < 2) {
        console.log("❌ ITEMS POLLING: Sheet has no data rows");
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
          obj[header] = values[index] || "";
        });

        // Skip empty rows
        if (!obj.title && !obj.id) continue;

        // Check if this row has been modified since last sync
        const rowLastModified = new Date(); // In a real implementation, you'd get this from sheet metadata

        changes.push({
          rowIndex: i + 2, // +2 because we skip header and 0-index
          record: obj,
          lastModified: rowLastModified,
          changeType: "update",
        });
      }

      // Store the current timestamp as last sync time
      const lastSyncKey = `google_sheet_items_last_modified`;
      await supabaseAdmin.from("app_settings").upsert({
        key: lastSyncKey,
        value: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      console.log(
        `✅ ITEMS POLLING: Detected ${changes.length} potential changes`,
      );
      return changes;
    } catch (error) {
      console.error("❌ ITEMS POLLING: Error polling Google Sheets:", error);
      return null;
    }
  }

  // Process Google Sheets changes
  private async processGoogleSheetsChanges(changes: any[]) {
    try {
      console.log(
        `🔄 ITEMS PROCESSING: Processing ${changes.length} Google Sheets changes`,
      );

      for (const change of changes) {
        try {
          const transformedRecord = this.transformGoogleSheetsRecord(
            change.record,
          );

          // 🔍 LOG the transformed record before sending to Supabase
          console.log(
            "📥 Transformed record:",
            JSON.stringify(transformedRecord, null, 2),
          );

          // Find matching item by ID or title
          const matchResult = await this.findMatchingItem(transformedRecord);

          if (matchResult.shouldUpdate && matchResult.itemId) {
            console.log(
              `🔄 ITEMS POLLING: Updating existing item ID ${matchResult.itemId}`,
            );

            const { error } = await supabaseAdmin
              .from("items")
              .update(transformedRecord)
              .eq("id", matchResult.itemId);

            if (error) {
              console.error(
                `❌ ITEMS POLLING: Error updating item ${matchResult.itemId}:`,
                error,
              );
            } else {
              console.log(
                `✅ ITEMS POLLING: Successfully updated item ${matchResult.itemId}`,
              );
            }
          } else {
            console.log(
              `➕ ITEMS POLLING: Creating new item from Google Sheets`,
            );

            const { data: newItem, error } = await supabaseAdmin
              .from("items")
              .insert([transformedRecord])
              .select()
              .single();

            if (error) {
              console.error(
                "❌ ITEMS POLLING: Error creating new item:",
                error,
              );
            } else {
              console.log(
                `✅ ITEMS POLLING: Successfully created new item ID ${newItem?.id}`,
              );
            }
          }
        } catch (error: any) {
          console.error("❌ ITEMS POLLING: Error processing change:", error);
        }
      }

      console.log(
        `✅ ITEMS POLLING: Completed processing ${changes.length} changes`,
      );
    } catch (error: any) {
      console.error("❌ ITEMS POLLING: Error processing changes:", error);
    }
  }

  // Transform Google Sheets record to match database schema
  private transformGoogleSheetsRecord(
    record: Record<string, any>,
  ): Record<string, any> {
    const transformed: any = {
      title: record.title || "",
      description: record.description || "",
      low_est: parseFloat(record.low_est || record["low est"]) || 0,
      high_est: parseFloat(record.high_est || record["high est"]) || 0,
      start_price:
        parseFloat(record.start_price || record["start price"]) || null,
      reserve: parseFloat(record.reserve) || null,
      condition: record.condition || "",
      status: record.status || "draft",
      category: record.category || "",
      subcategory: record.subcategory || "",
      artist_maker: record.artist_maker || record["artist maker"] || "",
      period_age: record.period_age || record["period age"] || "",
      provenance: record.provenance || "",
      materials: record.materials || "",
      dimensions: record.dimensions || "",
      weight: record.weight || "",
    };

    // Handle ID if provided
    if (record.id) {
      const id = parseInt(record.id);
      if (!isNaN(id)) {
        transformed.id = id;
      }
    }

    // Handle numeric fields
    if (record.vendor_id) {
      const vendorId = parseInt(record.vendor_id);
      if (!isNaN(vendorId)) {
        transformed.vendor_id = vendorId;
      }
    }

    if (record.buyer_id) {
      const buyerId = parseInt(record.buyer_id);
      if (!isNaN(buyerId)) {
        transformed.buyer_id = buyerId;
      }
    }

    if (record.artist_id) {
      const artistId = parseInt(record.artist_id);
      if (!isNaN(artistId)) {
        transformed.artist_id = artistId;
      }
    }

    // Handle boolean fields
    if (record.include_artist_description !== undefined) {
      transformed.include_artist_description = this.parseBoolean(
        record.include_artist_description,
      );
    }

    if (record.include_artist_key_description !== undefined) {
      transformed.include_artist_key_description = this.parseBoolean(
        record.include_artist_key_description,
      );
    }

    if (record.include_artist_biography !== undefined) {
      transformed.include_artist_biography = this.parseBoolean(
        record.include_artist_biography,
      );
    }

    if (record.include_artist_notable_works !== undefined) {
      transformed.include_artist_notable_works = this.parseBoolean(
        record.include_artist_notable_works,
      );
    }

    if (record.include_artist_major_exhibitions !== undefined) {
      transformed.include_artist_major_exhibitions = this.parseBoolean(
        record.include_artist_major_exhibitions,
      );
    }

    if (record.include_artist_awards_honors !== undefined) {
      transformed.include_artist_awards_honors = this.parseBoolean(
        record.include_artist_awards_honors,
      );
    }

    if (record.include_artist_market_value_range !== undefined) {
      transformed.include_artist_market_value_range = this.parseBoolean(
        record.include_artist_market_value_range,
      );
    }

    if (record.include_artist_signature_style !== undefined) {
      transformed.include_artist_signature_style = this.parseBoolean(
        record.include_artist_signature_style,
      );
    }

    return transformed;
  }

  // Find matching item by ID or title
  private async findMatchingItem(
    record: any,
  ): Promise<{ shouldUpdate: boolean; itemId: number | null }> {
    // If ID is provided, try to find exact match
    if (record.id) {
      const { data: existingItem } = await supabaseAdmin
        .from("items")
        .select("id")
        .eq("id", record.id)
        .single();

      if (existingItem) {
        return { shouldUpdate: true, itemId: existingItem.id };
      }
    }

    // If no ID match, try to find by title (exact match)
    if (record.title && record.title.trim()) {
      const { data: existingItems } = await supabaseAdmin
        .from("items")
        .select("id")
        .eq("title", record.title.trim())
        .limit(1);

      if (existingItems && existingItems.length > 0) {
        return { shouldUpdate: true, itemId: existingItems[0].id };
      }
    }

    // No match found, should create new
    return { shouldUpdate: false, itemId: null };
  }

  // Helper methods for data transformation
  private parseBoolean(value: any): boolean {
    if (typeof value === "boolean") return value;
    const str = String(value).toLowerCase();
    return str === "true" || str === "yes" || str === "1";
  }

  // Manual trigger for sync
  async triggerManualSync(): Promise<{
    success: boolean;
    message: string;
    changesProcessed?: number;
  }> {
    try {
      console.log("🔄 ITEMS MANUAL SYNC: Starting manual Google Sheets sync");

      const changes = await this.pollGoogleSheetsForChanges();
      if (changes && changes.length > 0) {
        await this.processGoogleSheetsChanges(changes);
        console.log(
          `✅ ITEMS MANUAL SYNC: Successfully processed ${changes.length} changes`,
        );
        return {
          success: true,
          message: `Successfully synced ${changes.length} changes from Google Sheets`,
          changesProcessed: changes.length,
        };
      } else {
        console.log("📊 ITEMS MANUAL SYNC: No changes detected");
        return {
          success: true,
          message: "No changes detected in Google Sheets",
        };
      }
    } catch (error) {
      console.error("❌ ITEMS MANUAL SYNC: Error during manual sync:", error);
      return {
        success: false,
        message: `Manual sync failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Start polling mode
  startPolling(intervalMinutes: number = 15) {
    if (this.isPolling) {
      console.log("⚠️ ITEMS POLLING: Already polling, stopping first");
      this.stopPolling();
    }

    this.isPolling = true;
    console.log(
      `✅ ITEMS POLLING: Started polling every ${intervalMinutes} minutes`,
    );

    const poll = async () => {
      if (!this.isPolling) return;

      await this.performScheduledSync();

      if (this.isPolling) {
        setTimeout(poll, intervalMinutes * 60 * 1000);
      }
    };

    // Start first poll immediately
    setTimeout(poll, 1000);
  }

  // Stop polling mode
  stopPolling() {
    this.isPolling = false;
    console.log("⏹️ ITEMS POLLING: Stopped polling");
  }
}

// Create singleton instance with error handling
let itemsGoogleSheetsSyncManager: ItemsGoogleSheetsSyncManager | null = null;

function getItemsGoogleSheetsSyncManager(): ItemsGoogleSheetsSyncManager {
  if (!itemsGoogleSheetsSyncManager) {
    try {
      itemsGoogleSheetsSyncManager = new ItemsGoogleSheetsSyncManager();
      console.log("✅ ItemsGoogleSheetsSyncManager initialized successfully");
    } catch (error) {
      console.error(
        "❌ Failed to initialize ItemsGoogleSheetsSyncManager:",
        error,
      );
      // Return a mock instance that returns safe defaults
      const mockInstance = {
        getSyncStatus: () => ({
          pollingActive: false,
          scheduledActive: false,
          lastSyncTimestamps: {},
          syncInProgress: [],
          cronAvailable: false,
        }),
        triggerManualSync: async () => ({
          success: false,
          message:
            "Items sync manager not available due to initialization error",
        }),
        startScheduledSync: () =>
          console.log("Items scheduled sync not available"),
        stopScheduledSync: () =>
          console.log("Items scheduled sync not available"),
        startPolling: () => console.log("Items polling sync not available"),
        stopPolling: () => console.log("Items polling sync not available"),
      } as unknown as ItemsGoogleSheetsSyncManager;
      itemsGoogleSheetsSyncManager = mockInstance;
    }
  }
  return itemsGoogleSheetsSyncManager as ItemsGoogleSheetsSyncManager;
}

// Function to auto-sync a single item to Google Sheets (only updates that specific row)
async function autoSyncSingleItemToGoogleSheets(
  itemId: number,
): Promise<boolean> {
  try {
    console.log(
      `🔄 ITEMS AUTO-SYNC: Starting single item sync for item ID ${itemId}`,
    );

    const { google } = require("googleapis");

    // Get Google Sheets URL from app settings
    const { data: settingData } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "google_sheet_url_artworks")
      .single();

    if (!settingData?.value) {
      console.log(
        "❌ ITEMS AUTO-SYNC: No Google Sheets URL configured for items auto-sync",
      );
      return false;
    }

    // Get the item data
    const { data: item, error } = await supabaseAdmin
      .from("items")
      .select(
        `
        *,
        brands (
          id,
          name,
          code
        )
      `,
      )
      .eq("id", itemId)
      .single();

    if (error || !item) {
      console.error(
        "❌ ITEMS AUTO-SYNC: Error fetching item for auto-sync:",
        error,
      );
      return false;
    }

    console.log(
      `📊 ITEMS AUTO-SYNC: Processing item "${item.title}" (ID: ${itemId})`,
    );

    // Extract URL from setting value (could be string or object with url property)
    let actualSheetUrl = "";
    if (typeof settingData.value === "string") {
      try {
        const parsed = JSON.parse(settingData.value);
        actualSheetUrl =
          typeof parsed === "object" && parsed !== null ? parsed.url : parsed;
      } catch {
        actualSheetUrl = settingData.value;
      }
    } else if (
      typeof settingData.value === "object" &&
      settingData.value !== null
    ) {
      actualSheetUrl = settingData.value.url || "";
    } else {
      actualSheetUrl = settingData.value || "";
    }

    if (!actualSheetUrl || actualSheetUrl.trim() === "") {
      console.log("❌ ITEMS AUTO-SYNC: Google Sheets URL is empty or invalid");
      return false;
    }

    const sheetIdMatch = actualSheetUrl.match(
      /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
    );
    if (!sheetIdMatch) {
      console.log(
        "❌ ITEMS AUTO-SYNC: Invalid Google Sheets URL format:",
        actualSheetUrl,
      );
      return false;
    }

    const spreadsheetId = sheetIdMatch[1];

    // Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: "service_account",
        project_id: process.env.GOOGLE_PROJECT_ID || "msaber-project",
        private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        client_id: process.env.GOOGLE_CLIENT_ID,
      } as any,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    // First, get only column A (IDs) to efficiently find the target row
    const idResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:A",
    });

    const idColumn = idResponse.data.values || [];
    if (idColumn.length < 1) {
      console.log("Sheet is empty, will add header and first item");
    }

    // Find the row index for this item (ID is in column A, index 0)
    let targetRowIndex = -1;
    let lastPopulatedRow = 0;

    console.log(
      `🔍 ITEMS AUTO-SYNC: Scanning ${idColumn.length - 1} rows for item ID ${itemId}`,
    );

    for (let i = 1; i < idColumn.length; i++) {
      // Start from row 1 (skip header)
      const cellValue = idColumn[i] ? idColumn[i][0] : "";
      const numericId = parseInt(cellValue);

      if (!isNaN(numericId) && numericId === itemId) {
        targetRowIndex = i; // Row index in the sheet (0-based, but we'll add 1 for 1-based)
        console.log(
          `🎯 ITEMS AUTO-SYNC: Found existing row for item ID ${itemId} at row ${i + 1}`,
        );
        break;
      }

      // Track the last populated row
      if (cellValue && cellValue.trim()) {
        lastPopulatedRow = i;
      }
    }

    // Generate the CSV row data for this item
    const csvRows = generateDatabaseCsvRows([item]);
    const itemRowData = csvRows[0];

    if (targetRowIndex >= 0) {
      // Update existing row
      const range = `Sheet1!A${targetRowIndex + 1}:ZZ${targetRowIndex + 1}`; // +1 because sheets are 1-indexed

      console.log(
        `🔄 ITEMS AUTO-SYNC: Updating row ${targetRowIndex + 1} for item ID ${itemId}`,
      );

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: {
          values: [itemRowData],
        },
      });

      console.log(
        `✅ ITEMS AUTO-SYNC: Successfully updated item ${itemId} in Google Sheets`,
      );
    } else {
      // Add new row at the end
      const nextRow = lastPopulatedRow + 2; // +2 because sheets are 1-indexed and we want the next empty row
      const range = `Sheet1!A${nextRow}:ZZ${nextRow}`;

      console.log(
        `➕ ITEMS AUTO-SYNC: Adding new row at ${nextRow} for item ID ${itemId}`,
      );

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: {
          values: [itemRowData],
        },
      });

      console.log(
        `✅ ITEMS AUTO-SYNC: Successfully added new item ${itemId} to Google Sheets`,
      );
    }

    return true;
  } catch (error: any) {
    console.error("❌ ITEMS AUTO-SYNC: Error in single item sync:", error);
    return false;
  }
}
