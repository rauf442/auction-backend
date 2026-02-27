// backend/src/utils/pdf-catalog-generator.ts

/**
 * PDF catalog generation utilities using PDFKit (similar to invoice-pdf-generator.ts)
 */

import * as fs from 'fs';
import * as path from 'path';

// Dynamic import for PDFKit to handle dependency issues
const PDFDocument = (() => {
  try {
    return require('pdfkit');
  } catch (error) {
    console.error('Error loading PDFKit:', error);
    // Fallback: return a mock PDFDocument for development
    return class MockPDFDocument {
      constructor() {
        throw new Error('PDFKit not available. Please install dependencies: npm install pdfkit @types/pdfkit tslib');
      }
    };
  }
})();

// Import PDFKit types
import PDFKit = require('pdfkit');

export interface BrandData {
  id?: number;
  name?: string;
  code?: string;
  company_registration?: string;
  contact_email?: string;
  contact_phone?: string;
  vat_number?: string;
  brand_address?: string;
  logo_url?: string;
  terms_and_conditions?: string;
  vendor_terms_and_conditions?: string;
}

export interface CatalogOptions {
  includeTitle: boolean;
  includeImages: boolean;
  includeDescription: boolean;
  includeArtist: boolean;
  includeArtistBiography: boolean;
  includeArtistDescription: boolean;
  includeArtistExtraInfo: boolean;
  includeDimensions: boolean;
  includeCondition: boolean;
  includeMaterials: boolean;
  includeProvenance: boolean;
  includeEstimates: boolean;
  includeConsigner: boolean;
  includeLotNumbers: boolean;
  includeCategory: boolean;
  includePeriodAge: boolean;
  includeWeight: boolean;
  includeImageCaptions: boolean;

  // Layout options
  layoutType: 'cards' | 'table' | 'detailed';
  itemsPerPage: number;
  showPageNumbers: boolean;
  catalogTitle: string;
  catalogSubtitle: string;
  includeHeader: boolean;
  includeFooter: boolean;
  logoUrl: string;
  showBrandLogos: boolean;
  imagesPerItem: number;
  imageSize: 'small' | 'medium' | 'large';
  showImageBorder: boolean;
}

export interface ArtworkPreviewData {
  id?: string;
  title: string;
  description?: string;
  artist_maker?: string;
  artist_name?: string;
  materials?: string;
  period_age?: string;
  condition?: string;
  low_est?: number;
  high_est?: number;
  start_price?: number;
  dimensions?: string;
  weight?: string;
  category?: string;
  provenance?: string;
  images?: string[]; // Unlimited images array
  brand_id?: number; // Brand association
}

// Constants
const TEXT_SIZE = 8;
const TITLE_SIZE = 16;
const HEADER_SIZE = 14;
const ESTIMATE_SIZE = 18;
const DESCRIPTION_SIZE = 10;
const PAGE_WIDTH = 595; // A4 width in points
const PAGE_HEIGHT = 842; // A4 height in points
const MARGIN = 40;

// Font helpers
const setNormal = (doc: PDFKit.PDFDocument, size = TEXT_SIZE) =>
  doc.font("Helvetica").fontSize(size);

const setBold = (doc: PDFKit.PDFDocument, size = TEXT_SIZE) =>
  doc.font("Helvetica-Bold").fontSize(size);

const setTitle = (doc: PDFKit.PDFDocument, size = TITLE_SIZE) =>
  doc.font("Helvetica-Bold").fontSize(size);

// Helper functions
const textOrEmpty = (v?: string) => (v ? String(v) : '');

const formatCurrency = (amount: number): string => {
  return `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

// Process description with <br> tags and convert to newlines
const processDescription = (description?: string): string => {
  if (!description) return '';
  return description.replace(/<br\s*\/?>/gi, '\n');
};

// Helper function to convert Google Drive URLs to Google Photos format
function convertGoogleDriveUrl(url: string): string {
  if (!url) return url;

  // Handle different Google Drive URL formats
  if (url.startsWith('https://drive.google.com/u') || url.startsWith('https://drive.google.com/uc')) {
    // Extract file ID from various Google Drive URL formats
    const driveMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
                      url.match(/\/open\?id=([a-zA-Z0-9_-]+)/) ||
                      url.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
                      url.match(/\/uc\?export=view&id=([a-zA-Z0-9_-]+)/);

    if (driveMatch && driveMatch[1]) {
      const fileId = driveMatch[1];
      // Convert to Google Photos format (this is the format that works for PDFs)
      return `https://lh3.googleusercontent.com/d/${fileId}`;
    }
  }

  return url;
}

// Load image from URL with proper error handling
async function loadImageFromUrl(url: string): Promise<Buffer | null> {
  try {
    // ✅ FIX: Handle base64 data URLs directly — these are edited images saved from ImageEditModal.
    // The backend cannot HTTP-fetch a base64 string, so we decode it here instead.
    if (url.startsWith('data:')) {
      const commaIndex = url.indexOf(',');
      if (commaIndex !== -1) {
        const base64Data = url.substring(commaIndex + 1);
        return Buffer.from(base64Data, 'base64');
      }
      return null;
    }

    const https = require('https');
    const http = require('http');

    // Convert Google Drive URLs to Google Photos format
    const processedUrl = convertGoogleDriveUrl(url);
    console.log(url);
    console.log(processedUrl);

    return new Promise((resolve, reject) => {
      const protocol = processedUrl.startsWith('https://') ? https : http;

      protocol.get(processedUrl, (response: any) => {
        if (response.statusCode !== 200) {
          console.warn(`HTTP ${response.statusCode} for ${processedUrl}`);
          resolve(null);
          return;
        }

        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    });
  } catch (error) {
    console.warn(`Failed to load image from ${url}:`, error);
    return null;
  }
}

export async function generatePDFCatalog(
  artworks: ArtworkPreviewData[],
  options: CatalogOptions,
  brands: BrandData[] = []
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      // Create PDF document
      const doc = new PDFDocument({
        size: 'A4',
        margin: MARGIN,
        bufferPages: true
      });

      const buffers: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      let currentY = MARGIN;
      let pageNumber = 1;

      // Helper function to add new page
      const addNewPage = () => {
        doc.addPage();
        currentY = MARGIN;
      };

      // Page numbers removed as per requirements

      // Helper function to check if we need a page break
      const checkPageBreak = (requiredHeight: number) => {
        if (currentY + requiredHeight > PAGE_HEIGHT - MARGIN * 2) {
          addNewPage();
          return true;
        }
        return false;
      };


      // Process artworks - one per page layout
      await generateSinglePageLayout(doc, artworks, options, brands);

      // Finalize the PDF
      doc.end();

    } catch (error) {
      reject(error);
    }
  });
}

async function generateSinglePageLayout(
  doc: PDFKit.PDFDocument,
  artworks: ArtworkPreviewData[],
  options: CatalogOptions,
  brands: BrandData[] = []
): Promise<void> {
  console.log(`Processing ${artworks.length} artworks for PDF catalog`);

  for (let i = 0; i < artworks.length; i++) {
    const artwork = artworks[i];
    console.log(`Processing artwork ${i + 1}/${artworks.length}: ID ${artwork.id}, Title: ${artwork.title}`);
    // Start new page for each artwork (skip first artwork as it uses the initial page)
    if (i > 0) {
      doc.addPage();
    }

    const pageHeight = PAGE_HEIGHT - MARGIN * 2;
    let currentY = MARGIN;

    // Brand Header Section (10% of page height) - Logo center, brand info right
    const brandHeaderHeight = pageHeight * 0.1;
    const artworkBrand = brands.find(brand => brand.id === artwork.brand_id) || (artwork as any).brands;
    currentY = await renderBrandHeader(doc, artwork, currentY, brandHeaderHeight, options, brands);

    // Main Image Section (45% of page height)
    const mainImageHeight = pageHeight * 0.45;
    currentY = await renderMainImage(doc, artwork, currentY, mainImageHeight, options);

    // Secondary Images Section (20% of page height)
    const secondaryImageHeight = pageHeight * 0.2;
    currentY = await renderSecondaryImages(doc, artwork, currentY, secondaryImageHeight, options);

    // Content Section (20% of page height)
    const contentHeight = pageHeight * 0.2;
    await renderContentSection(doc, artwork, currentY, contentHeight, options);

    // Footer Section (5% of page height) - Company registration and brand address
    const footerHeight = pageHeight * 0.05;
    await renderBrandFooter(doc, artworkBrand, footerHeight);
  }
}

// Helper function to render brand header (logo center, brand info right, or "Private Sale" title)
async function renderBrandHeader(
  doc: PDFKit.PDFDocument,
  artwork: ArtworkPreviewData,
  startY: number,
  sectionHeight: number,
  options: CatalogOptions,
  brands: BrandData[] = []
): Promise<number> {
  if (!options.showBrandLogos) {
    // Show "Private Sale" title when brand logos are disabled
    setTitle(doc, 18);
    doc.fillColor('#1F2937');
    const centerX = PAGE_WIDTH / 2;
    const titleText = 'Private Sale';
    const titleWidth = doc.widthOfString(titleText);
    const titleX = centerX - titleWidth / 2;
    doc.text(titleText, titleX, startY + sectionHeight / 2 - 10);
    return startY + sectionHeight;
  }

  // Try to find brand for this artwork
  const artworkBrand = brands.find(brand => brand.id === (artwork as any).brand_id) || (artwork as any).brands;
  if (!artworkBrand) {
    return startY + sectionHeight;
  }

  const logoHeight = sectionHeight - 10; // Logo takes most of the 10% height
  const logoWidth = 50; // Reasonable logo width
  const centerX = PAGE_WIDTH / 2;

  // Brand logo (centered)
  if (artworkBrand.logo_url) {
    try {
      const logoBuffer = await loadImageFromUrl(artworkBrand.logo_url);
      if (logoBuffer) {
        const logoX = centerX - logoWidth / 2;
        const logoY = startY + 5;
        doc.image(logoBuffer, logoX, logoY, {
          width: logoWidth,
          height: logoHeight,
          fit: [logoWidth, logoHeight]
        });
      }
    } catch (error) {
      console.warn(`Failed to load brand logo:`, error);
    }
  }

  // Brand info on the right side - properly aligned
  const rightSectionWidth = 200; // Width allocated for right side content
  const rightX = PAGE_WIDTH - MARGIN - rightSectionWidth; // Right aligned area
  const brandInfoY = startY + 5;

  // Brand name - right aligned within the allocated space
  setBold(doc, 12);
  doc.fillColor('#1F2937');
  doc.text(artworkBrand.name || '', rightX, brandInfoY, {
    width: rightSectionWidth,
    align: 'right'
  });

  let currentInfoY = brandInfoY + 15;
  setNormal(doc, 10);
  doc.fillColor('#666666');

  // Email - right aligned
  if (artworkBrand.contact_email) {
    doc.text(`Email: ${artworkBrand.contact_email}`, rightX, currentInfoY, {
      width: rightSectionWidth,
      align: 'right'
    });
    currentInfoY += 12;
  }

  // Phone - right aligned
  if (artworkBrand.contact_phone) {
    doc.text(`Phone: ${artworkBrand.contact_phone}`, rightX, currentInfoY, {
      width: rightSectionWidth,
      align: 'right'
    });
  }

  return startY + sectionHeight;
}

// Helper function to render brand footer (company registration and brand address only)
async function renderBrandFooter(
  doc: PDFKit.PDFDocument,
  brand?: BrandData,
  sectionHeight?: number
): Promise<void> {
  if (!brand || !sectionHeight) return;

  const footerY = PAGE_HEIGHT - 60; // Give more space at bottom like consignment-pdf-generator.ts

  doc.fontSize(8).font('Helvetica').fillColor('#666666');

  // Company Registration and Office (single centered line)
  const registrationText = `Company Registration No: ${brand?.company_registration || ''}. Registered Office: ${brand?.brand_address ? String(brand?.brand_address).replace(/\n/g, ', ') : ''}`;
  const registrationWidth = doc.widthOfString(registrationText);
  const registrationCenterX = (PAGE_WIDTH - registrationWidth) / 2;
  doc.text(registrationText, registrationCenterX, footerY, { align: 'center', lineGap: 2 });

  doc.fillColor('black');
}

// Helper function to render main image
async function renderMainImage(
  doc: PDFKit.PDFDocument,
  artwork: ArtworkPreviewData,
  startY: number,
  sectionHeight: number,
  options: CatalogOptions
): Promise<number> {
  if (!options.includeImages) {
    return startY + sectionHeight;
  }

  const imageWidth = PAGE_WIDTH - MARGIN * 2;
  const imageHeight = sectionHeight - 20; // Leave some margin

  // Try to load the first available image from images array
  const images = artwork.images || [];
  const imageUrl = images.length > 0 ? images[0] : null;

  if (imageUrl) {
    try {
      const imageBuffer = await loadImageFromUrl(imageUrl);
      if (imageBuffer) {
        // Add main image with border
        doc.image(imageBuffer, MARGIN, startY + 5, {
          width: imageWidth,
          height: imageHeight,
          fit: [imageWidth, imageHeight]
        });

        // Add elegant border
        doc.strokeColor('#E5E5E5');
        doc.lineWidth(1);
        doc.rect(MARGIN, startY + 5, imageWidth, imageHeight).stroke();
      }
    } catch (error) {
      console.warn(`Failed to add main image for artwork ${artwork.title}:`, error);
      
      // Fallback: elegant placeholder
      doc.fillColor('#F8FAFC');
      doc.rect(MARGIN, startY + 5, imageWidth, imageHeight).fill();
      doc.strokeColor('#C8C8C8');
      doc.lineWidth(1);
      doc.rect(MARGIN, startY + 5, imageWidth, imageHeight).stroke();
      
      setNormal(doc, 14);
      doc.fillColor('#969696');
      doc.text('NO IMAGE AVAILABLE', PAGE_WIDTH / 2, startY + sectionHeight / 2, { align: 'center' });
    }
  }

  return startY + sectionHeight;
}

// Helper function to render secondary images
async function renderSecondaryImages(
  doc: PDFKit.PDFDocument,
  artwork: ArtworkPreviewData,
  startY: number,
  sectionHeight: number,
  options: CatalogOptions
): Promise<number> {
  if (!options.includeImages || options.imagesPerItem < 2) {
    return startY + sectionHeight;
  }

  const images = artwork.images || [];
  const secondaryImages = images.slice(1); // Skip first image (main image)
  const imageCount = Math.min(secondaryImages.length, options.imagesPerItem - 1); // Up to remaining images

  if (imageCount === 0) {
    return startY + sectionHeight;
  }

  // Layout: 2 images per row for secondary images
  const imagesPerRow = 2;
  const gap = 20;
  const availableWidth = PAGE_WIDTH - MARGIN * 2;
  const imageWidth = (availableWidth - gap) / imagesPerRow;
  const imageHeight = sectionHeight - 20;

  const imagePromises: Promise<void>[] = [];

  for (let i = 0; i < imageCount; i++) {
    const imageUrl = secondaryImages[i];
    const row = Math.floor(i / imagesPerRow);
    const col = i % imagesPerRow;
    const imageX = MARGIN + col * (imageWidth + gap);
    const imageY = startY + 10 + row * (imageHeight + 10); // Add vertical spacing between rows

    if (imageUrl) {
      imagePromises.push(
        loadImageFromUrl(imageUrl).then(imageBuffer => {
          if (imageBuffer) {
            try {
              // Add image
              doc.image(imageBuffer, imageX, imageY, {
                width: imageWidth,
                height: imageHeight,
                fit: [imageWidth, imageHeight]
              });

              // Add border
              doc.strokeColor('#F0F0F0');
              doc.lineWidth(0.5);
              doc.rect(imageX, imageY, imageWidth, imageHeight).stroke();
            } catch (error) {
              console.warn(`Failed to add secondary image ${i + 2} for artwork ${artwork.title}:`, error);

              // Fallback placeholder
              doc.fillColor('#FAFAFA');
              doc.rect(imageX, imageY, imageWidth, imageHeight).fill();
              doc.strokeColor('#DCDCDC');
              doc.lineWidth(0.5);
              doc.rect(imageX, imageY, imageWidth, imageHeight).stroke();
            }
          }
        }).catch(() => {})
      );
    } else {
      // Empty placeholder
      doc.fillColor('#FAFAFA');
      doc.rect(imageX, imageY, imageWidth, imageHeight).fill();
      doc.strokeColor('#E6E6E6');
      doc.lineWidth(0.5);
      doc.rect(imageX, imageY, imageWidth, imageHeight).stroke();
    }
  }

  await Promise.allSettled(imagePromises);
  return startY + sectionHeight;
}

// Helper function to render content section
async function renderContentSection(
  doc: PDFKit.PDFDocument,
  artwork: ArtworkPreviewData,
  startY: number,
  sectionHeight: number,
  options: CatalogOptions
): Promise<void> {
  let currentY = startY + 10;
  const contentWidth = PAGE_WIDTH - MARGIN * 2;

  // Add elegant separator line
  doc.strokeColor('#D1D5DB');
  doc.lineWidth(0.8);
  doc.moveTo(MARGIN, currentY + 2).lineTo(PAGE_WIDTH - MARGIN, currentY + 2).stroke();
  currentY += 12;

  // Title (prominent and larger) - Full width first
  if (options.includeTitle && artwork.title) {
    setTitle(doc, TITLE_SIZE);
    doc.fillColor('#1F2937');
    doc.text(artwork.title, MARGIN, currentY, { width: contentWidth });
    const titleHeight = doc.heightOfString(artwork.title, { width: contentWidth });
    currentY += titleHeight + 8;
  }

  // Calculate available space for content
  const contentStartY = currentY;
  const availableHeight = startY + sectionHeight - contentStartY - 10;
  
  // Split into two columns
  const leftColWidth = contentWidth * 0.68; // 68% for details
  const rightColWidth = contentWidth * 0.30; // 30% for estimate
  const gap = contentWidth * 0.02; // 2% gap
  const leftColX = MARGIN;
  const rightColX = MARGIN + leftColWidth + gap;

  // LEFT COLUMN: Description, Artist, Materials, Dimensions, etc.
  let leftColY = contentStartY;
  const maxLeftColHeight = availableHeight;

  // Description
  if (options.includeDescription && artwork.description) {
    setNormal(doc, DESCRIPTION_SIZE);
    doc.fillColor('#374151');
    const processedDescription = processDescription(artwork.description);
    
    // Calculate max lines for description based on remaining space
    const descMaxHeight = maxLeftColHeight - (leftColY - contentStartY) - 60; // Reserve 60pt for other fields
    const lineHeight = 12;
    const maxLines = Math.max(3, Math.floor(descMaxHeight / lineHeight));
    const maxChars = maxLines * 48; // ~48 chars per line at this width
    
    let displayDesc = processedDescription;
    if (processedDescription.length > maxChars) {
      displayDesc = processedDescription.substring(0, maxChars - 3) + '...';
    }

    doc.text(displayDesc, leftColX, leftColY, {
      width: leftColWidth,
      lineGap: 2
    });
    
    leftColY += doc.heightOfString(displayDesc, { width: leftColWidth, lineGap: 2 }) + 8;
  }

  // Artist
  if (options.includeArtist && (artwork.artist_name || artwork.artist_maker) && leftColY < contentStartY + maxLeftColHeight - 40) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Artist:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Artist: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    const artist = artwork.artist_name || artwork.artist_maker || '';
    doc.text(artist, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
    
    leftColY += 12;
  }

  // Materials
  if (options.includeMaterials && artwork.materials && leftColY < contentStartY + maxLeftColHeight - 25) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Materials:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Materials: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    doc.text(artwork.materials, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
    
    leftColY += 12;
  }

  // Dimensions
  if (options.includeDimensions && artwork.dimensions && leftColY < contentStartY + maxLeftColHeight - 15) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Dimensions:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Dimensions: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    doc.text(artwork.dimensions, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
    
    leftColY += 12;
  }

  // Category
  if (options.includeCategory && artwork.category && leftColY < contentStartY + maxLeftColHeight - 15) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Category:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Category: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    doc.text(artwork.category, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
    
    leftColY += 12;
  }

  // Period/Age
  if (options.includePeriodAge && artwork.period_age && leftColY < contentStartY + maxLeftColHeight - 15) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Period:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Period: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    doc.text(artwork.period_age, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
    
    leftColY += 12;
  }

  // Condition
  if (options.includeCondition && artwork.condition && leftColY < contentStartY + maxLeftColHeight - 15) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Condition:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Condition: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    doc.text(artwork.condition, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
    
    leftColY += 12;
  }

  // Provenance
  if (options.includeProvenance && artwork.provenance && leftColY < contentStartY + maxLeftColHeight - 15) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Provenance:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Provenance: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    doc.text(artwork.provenance, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
    
    leftColY += 12;
  }

  // Weight
  if (options.includeWeight && artwork.weight && leftColY < contentStartY + maxLeftColHeight - 15) {
    setBold(doc, 9);
    doc.fillColor('#374151');
    doc.text('Weight:', leftColX, leftColY);
    
    const labelWidth = doc.widthOfString('Weight: ');
    setNormal(doc, 9);
    doc.fillColor('#1F2937');
    doc.text(artwork.weight, leftColX + labelWidth, leftColY, { width: leftColWidth - labelWidth });
  }

  // RIGHT COLUMN: Estimate (vertically centered in the available space)
  if (options.includeEstimates && (artwork.low_est || artwork.high_est)) {
    const estimates = [];
    if (artwork.low_est) estimates.push(formatCurrency(artwork.low_est));
    if (artwork.high_est) estimates.push(formatCurrency(artwork.high_est));

    // Format estimate text - if both exist, show on separate lines to prevent overflow
    const estimateText = estimates.join(' - ');

    setBold(doc, 13); // Slightly reduced from 18
    doc.fillColor('#D97706');
    
    // Calculate vertical center of the content area
    const estimateHeight = doc.heightOfString(estimateText, { 
      width: rightColWidth,
      lineGap: 4
    });
    const contentCenterY = contentStartY + (availableHeight / 2);
    const estimateY = contentCenterY - (estimateHeight / 2);

    // Draw estimate centered vertically in right column
    doc.text(estimateText, rightColX, estimateY, { 
      width: rightColWidth,
      align: 'center',
      lineGap: 4
    });
  }
}