// backend/src/utils/export-formats.ts
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import archiver from 'archiver';

export type PlatformId = 'database' | 'liveauctioneers' | 'easy_live' | 'invaluable' | 'the_saleroom';

// Platform-specific image naming configurations
export const IMAGE_NAMING_CONFIGS = {
  liveauctioneers: {
    format: (lotNumber: number, imageIndex: number) => `${lotNumber}_${imageIndex}.jpg`,
    description: 'Format: 1_1.jpg, 1_2.jpg, 1_3.jpg, 1_4.jpg'
  },
  easy_live: {
    format: (lotNumber: number, imageIndex: number) => {
      if (imageIndex === 1) {
        return `${lotNumber}.jpg`;
      }
      return `${lotNumber}-${imageIndex}.jpg`;
    },
    description: 'Format: 1.jpg, 1-2.jpg, 1-3.jpg, 2.jpg, 2-2.jpg, 2-3.jpg'
  },
  the_saleroom: {
    format: (lotNumber: number, imageIndex: number) => {
      if (imageIndex === 1) {
        return `${lotNumber}.jpg`;
      }
      return `${lotNumber}-${imageIndex}.jpg`;
    },
    description: 'Format: 1.jpg, 1-2.jpg, 1-3.jpg, 1-4.jpg, 1-5.jpg'
  },
  invaluable: {
    format: (lotNumber: number, imageIndex: number) => `${lotNumber}_${imageIndex}.jpg`,
    description: 'Format: 1_1.jpg, 1_2.jpg, 1_3.jpg (similar to Live Auctioneers)'
  },
  database: {
    format: (lotNumber: number, imageIndex: number) => `lot_${lotNumber}_img_${imageIndex}.jpg`,
    description: 'Database format: lot_1_img_1.jpg, lot_1_img_2.jpg'
  }
};

// CSV export configurations for different platforms
export const CSV_EXPORT_CONFIGS = {
  liveauctioneers: {
    headers: [
      'Lot Number',
      'Title',
      'Description',
      'Low Estimate',
      'High Estimate',
      'Starting Bid',
      'Artist',
      'Medium',
      'Dimensions',
      'Year',
      'Condition',
      'Provenance'
    ],
    mapFields: (item: any, lotNumber: number) => [
      lotNumber,
      item.title || '',
      item.description || '',
      item.low_est || 0,
      item.high_est || 0,
      item.start_price || Math.round((item.low_est || 0) * 0.5),
      item.artist_maker || '',
      item.materials || '',
      item.dimensions || '',
      item.period_age || '',
      item.condition || '',
      item.provenance || ''
    ]
  },
  easy_live: {
    headers: [
      'LotNo',
      'Description',
      'Condition Report',
      'LowEst',
      'HighEst',
      'Category'
    ],
    mapFields: (item: any, lotNumber: number) => [
      lotNumber,
      (item.description || '').replace(/<br>/g, '\n'),
      item.condition || '',
      item.low_est || 0,
      item.high_est || 0,
      item.category || ''
    ]
  },
  the_saleroom: {
    headers: [
      'Lot Number',
      'Title',
      'Artist/Maker',
      'Description',
      'Low Estimate',
      'High Estimate',
      'Dimensions',
      'Medium',
      'Date',
      'Condition',
      'Provenance'
    ],
    mapFields: (item: any, lotNumber: number) => [
      lotNumber,
      item.title || '',
      item.artist_maker || '',
      item.description || '',
      item.low_est || 0,
      item.high_est || 0,
      item.dimensions || '',
      item.materials || '',
      item.period_age || '',
      item.condition || '',
      item.provenance || ''
    ]
  },
  invaluable: {
    headers: [
      'Lot',
      'Title',
      'Artist',
      'Description',
      'Low Est',
      'High Est',
      'Starting Bid',
      'Medium',
      'Dimensions',
      'Year',
      'Condition'
    ],
    mapFields: (item: any, lotNumber: number) => [
      lotNumber,
      item.title || '',
      item.artist_maker || '',
      item.description || '',
      item.low_est || 0,
      item.high_est || 0,
      item.start_price || Math.round((item.low_est || 0) * 0.5),
      item.materials || '',
      item.dimensions || '',
      item.period_age || '',
      item.condition || ''
    ]
  },
  database: {
    headers: [
      'ID',
      'Title',
      'Description',
      'Low Estimate',
      'High Estimate',
      'Artist',
      'Category',
      'Status',
      'Created Date'
    ],
    mapFields: (item: any, lotNumber: number) => [
      item.id,
      item.title || '',
      item.description || '',
      item.low_est || 0,
      item.high_est || 0,
      item.artist_maker || '',
      item.category || '',
      item.status || 'active',
      item.created_at || ''
    ]
  }
};

// Helper function to generate image filename based on platform
export function generateImageFilename(
  platform: PlatformId,
  lotNumber: number,
  imageIndex: number,
  originalExtension: string = '.jpg'
): string {
  const config = IMAGE_NAMING_CONFIGS[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const baseName = config.format(lotNumber, imageIndex);
  return originalExtension ? baseName.replace('.jpg', originalExtension) : baseName;
}

// Helper function to get image URLs from item
export function getItemImageUrls(item: any): string[] {
  const imageUrls: string[] = [];

  // Check for new images array format (unlimited images)
  if (item.images && Array.isArray(item.images)) {
    item.images.forEach((imageUrl: string) => {
      if (imageUrl && imageUrl.trim()) {
        imageUrls.push(imageUrl.trim());
      }
    });
  } else {
    // Fallback: Check for old image_file_1 through image_file_10 format
    for (let i = 1; i <= 10; i++) {
      const imageUrl = item[`image_file_${i}`];
      if (imageUrl && imageUrl.trim()) {
        imageUrls.push(imageUrl.trim());
      }
    }
  }

  return imageUrls;
}

// Generate CSV content for a platform
export function generateCSVContent(
  platform: PlatformId,
  items: any[],
  lotNumberOffset: number = 1
): string {
  const config = CSV_EXPORT_CONFIGS[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const rows = items.map((item, index) => {
    const lotNumber = lotNumberOffset + index;
    return config.mapFields(item, lotNumber);
  });

  // Create CSV content
  const csvRows = [
    config.headers,
    ...rows
  ];

  return csvRows.map(row =>
    row.map(field => `"${String(field || '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
}

// Create images zip file with platform-specific naming
export async function createImagesZip(
  platform: PlatformId,
  items: any[],
  lotNumberOffset: number = 1,
  tempDir: string = 'temp_exports'
): Promise<string> {
  const fs = require('fs');
  const fsPromises = require('fs').promises;
  const path = require('path');
  const archiver = require('archiver');

  // Ensure temp directory exists
  const exportDir = path.join(process.cwd(), tempDir);
  const imagesDir = path.join(exportDir, 'images');
  const zipPath = path.join(exportDir, `images_${platform}_${Date.now()}.zip`);

  try {
    await fsPromises.mkdir(imagesDir, { recursive: true });
  } catch (error) {
    console.error('Error creating temp directories:', error);
    throw new Error(`Failed to create temp directories: ${error}`);
  }

  // Create a map to store downloaded images temporarily
  const imageMap = new Map<string, string>();
  let totalImagesAttempted = 0;
  let totalImagesDownloaded = 0;

  // Process each item's images
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const lotNumber = lotNumberOffset + itemIndex;
    const imageUrls = getItemImageUrls(item);

    console.log(`Processing item ${item.id} (lot ${lotNumber}) with ${imageUrls.length} images`);

    for (let imageIndex = 0; imageIndex < imageUrls.length; imageIndex++) {
      const imageUrl = imageUrls[imageIndex];
      if (!imageUrl) continue;

      totalImagesAttempted++;
      console.log(`Downloading image ${imageIndex + 1}/${imageUrls.length} for lot ${lotNumber}: ${imageUrl.substring(0, 100)}...`);

      try {
        const imageBuffer = await downloadImage(imageUrl);
        if (!imageBuffer) {
          console.error(`Failed to download image: ${imageUrl}`);
          continue;
        }

        totalImagesDownloaded++;

        // Generate platform-specific filename
        const extension = path.extname(imageUrl) || '.jpg';
        const newFilename = generateImageFilename(platform, lotNumber, imageIndex + 1, extension);
        const tempImagePath = path.join(imagesDir, newFilename);

        // Save image with new name
        await fsPromises.writeFile(tempImagePath, imageBuffer);
        imageMap.set(tempImagePath, newFilename);

        console.log(`✅ Saved image as: ${newFilename} (${imageBuffer.length} bytes)`);

      } catch (error) {
        console.error(`Error processing image ${imageUrl}:`, error);
      }
    }
  }

  console.log(`Export summary: ${totalImagesDownloaded}/${totalImagesAttempted} images downloaded successfully`);

  // Check if we actually downloaded any images
  if (imageMap.size === 0) {
    const errorMsg = `No images could be downloaded. Attempted ${totalImagesAttempted} images, but all failed. This may be due to network restrictions, expired Google Drive links, or firewall blocking access to image URLs.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Create zip file
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      console.log(`Created zip file: ${zipPath} (${archive.pointer()} bytes) with ${imageMap.size} images`);
      resolve(zipPath);
    });

    archive.on('error', (err: Error) => {
      console.error('Archive error:', err);
      reject(err);
    });

    archive.pipe(output);

    // Add all renamed images to zip
    for (const [tempPath, filename] of imageMap) {
      archive.file(tempPath, { name: filename });
    }

    archive.finalize();
  });
}

// Helper function to download image with support for Google Drive URLs
async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const https = require('https');
    const http = require('http');

    // Handle Google Drive URLs with multiple fallback strategies
    let downloadUrls = [url];
    if (url.includes('drive.google.com')) {
      // Extract file ID from various Google Drive URL formats
      const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
                         url.match(/id=([a-zA-Z0-9_-]+)/) ||
                         url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);

      if (fileIdMatch && fileIdMatch[1]) {
        const fileId = fileIdMatch[1];
        // Try multiple URL formats in order of preference
        downloadUrls = [
          `https://lh3.googleusercontent.com/d/${fileId}`, // Most reliable for images
          `https://drive.google.com/uc?export=download&id=${fileId}`, // Direct download
          `https://drive.google.com/uc?id=${fileId}&export=download`, // Alternative format
          url // Original URL as last resort
        ];
      }
    }

    // Try each URL format until one works
    for (const downloadUrl of downloadUrls) {
      console.log(`Attempting to download image from: ${downloadUrl}`);

      try {
        const result = await downloadFromUrl(downloadUrl);
        if (result) {
          console.log(`✅ Successfully downloaded image from: ${downloadUrl} (${result.length} bytes)`);
          return result;
        } else {
          console.log(`❌ Failed to download from: ${downloadUrl}`);
        }
      } catch (error) {
        console.log(`❌ Error downloading from ${downloadUrl}:`, error instanceof Error ? error.message : String(error));
      }
    }

    console.error(`❌ All download attempts failed for original URL: ${url}`);
    return null;

  } catch (error) {
    console.error('Error downloading image:', error);
    return null;
  }
}

// Helper function to download from a single URL
async function downloadFromUrl(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https:') ? https : http;
    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      timeout: 15000 // 15 second timeout
    }, (response: any) => {
      console.log(`Response status for ${url}: ${response.statusCode}`);

      if (response.statusCode !== 200) {
        resolve(null);
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          console.log(`Empty buffer received for ${url}`);
          resolve(null);
        } else {
          resolve(buffer);
        }
      });
      response.on('error', (error: Error) => {
        console.log(`Response error for ${url}:`, error.message);
        resolve(null);
      });
    });

    request.on('error', (error: Error) => {
      console.log(`Request error for ${url}:`, error.message);
      resolve(null);
    });

    request.on('timeout', () => {
      console.log(`Timeout for ${url}`);
      request.destroy();
      resolve(null);
    });
  });
}

// Clean up temporary files
export async function cleanupTempFiles(tempDir: string = 'temp_exports'): Promise<void> {
  const fs = require('fs').promises;
  const path = require('path');

  try {
    const exportDir = path.join(process.cwd(), tempDir);
    await fs.rm(exportDir, { recursive: true, force: true });
    console.log('Cleaned up temporary export files');
  } catch (error) {
    console.error('Error cleaning up temp files:', error);
  }
}
