// backend/src/utils/image-processing.ts
import crypto from 'crypto';
import fetch from 'node-fetch';
import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';

interface ImageHashResult {
  hash: string;
  success: boolean;
  error?: string;
  size?: number;
  format?: string;
}

interface ImageSimilarityResult {
  similarity: number;
  isSimilar: boolean;
  hash1: string;
  hash2: string;
}

/**
 * Detects if a URL is a Google Drive/Docs link
 */
function isDriveUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  return url.includes('drive.google.com') || url.includes('docs.google.com') || url.includes('googleusercontent.com');
}

/**
 * Extract Google Drive file id from various URL formats
 */
function extractDriveFileId(url: string): string | null {
  if (!url) return null;
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,        // /file/d/FILE_ID
    /\/open\?id=([a-zA-Z0-9_-]+)/,        // /open?id=FILE_ID
    /\/uc\?export=view&id=([a-zA-Z0-9_-]+)/, // /uc?export=view&id=FILE_ID
    /[?&#]id=([a-zA-Z0-9_-]+)/             // id=FILE_ID (fallback)
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Normalize image URL to a directly fetchable form
 * - Converts Google Drive URLs to lh3 direct image URLs (same as frontend MediaRenderer)
 */
function normalizeImageUrl(url: string): string {
  if (!url || typeof url !== 'string') return '';
  if (isDriveUrl(url)) {
    const fileId = extractDriveFileId(url);
    if (fileId) return `https://lh3.googleusercontent.com/d/${fileId}`;
  }
  return url;
}

/**
 * Downloads an image from URL and returns its buffer
 */
async function downloadImage(imageUrl: string, timeout: number = 30000): Promise<Buffer> {
  try {
    const normalizedUrl = normalizeImageUrl(imageUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ImageDuplicateDetector/1.0)'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error(`Invalid content type: ${contentType}`);
    }

    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Timeout downloading image from ${imageUrl} after ${timeout}ms`);
    }
    throw new Error(`Failed to download image from ${imageUrl}: ${error.message}`);
  }
}

/**
 * Calculates MD5 hash of image buffer
 */
function calculateImageHash(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Gets perceptual hash (dhash) for image similarity comparison
 */
async function calculatePerceptualHash(buffer: Buffer): Promise<string> {
  try {
    // Resize to 9x8 for dhash (8x8 difference hash)
    const resized = await sharp(buffer)
      .resize(9, 8, { withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer();

    let hash = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const current = resized[y * 9 + x];
        const next = resized[y * 9 + x + 1];
        hash += current > next ? '1' : '0';
      }
    }

    return hash;
  } catch (error: any) {
    console.warn(`Failed to calculate perceptual hash: ${error.message}`);
    return '';
  }
}

/**
 * Downloads and calculates hash for a single image URL
 */
export async function getImageHash(imageUrl: string): Promise<ImageHashResult> {
  try {
    const buffer = await downloadImage(imageUrl);

    if (buffer.length === 0) {
      return {
        hash: '',
        success: false,
        error: 'Empty image buffer'
      };
    }

    const hash = calculateImageHash(buffer);

    // Get image metadata
    let size: number | undefined;
    let format: string | undefined;

    try {
      const metadata = await sharp(buffer).metadata();
      size = metadata.size;
      format = metadata.format;
    } catch (error) {
      // Ignore metadata errors
    }

    return {
      hash,
      success: true,
      size,
      format
    };
  } catch (error: any) {
    return {
      hash: '',
      success: false,
      error: error.message
    };
  }
}

/**
 * Downloads and calculates perceptual hash for image similarity
 */
export async function getImagePerceptualHash(imageUrl: string): Promise<{ hash: string; success: boolean; error?: string }> {
  try {
    const buffer = await downloadImage(imageUrl);

    if (buffer.length === 0) {
      return {
        hash: '',
        success: false,
        error: 'Empty image buffer'
      };
    }

    const hash = await calculatePerceptualHash(buffer);

    return {
      hash,
      success: true
    };
  } catch (error: any) {
    return {
      hash: '',
      success: false,
      error: error.message
    };
  }
}

/**
 * Calculates Hamming distance between two binary strings (perceptual hashes)
 */
function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) {
    return Math.max(hash1.length, hash2.length);
  }

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) {
      distance++;
    }
  }

  return distance;
}

/**
 * Compares two perceptual hashes for similarity
 */
export function comparePerceptualHashes(hash1: string, hash2: string): ImageSimilarityResult {
  const distance = hammingDistance(hash1, hash2);
  const maxDistance = Math.max(hash1.length, hash2.length);
  const similarity = 1 - (distance / maxDistance);

  return {
    similarity,
    isSimilar: similarity >= 0.85, // 85% similarity threshold
    hash1,
    hash2
  };
}

/**
 * Batch processes multiple image URLs to get their hashes
 */
export async function getBatchImageHashes(imageUrls: string[], concurrency: number = 5): Promise<Map<string, ImageHashResult>> {
  const results = new Map<string, ImageHashResult>();
  const semaphore = new Semaphore(concurrency);

  console.log(`🔄 Processing ${imageUrls.length} images with concurrency ${concurrency}...`);

  const promises = imageUrls.map(async (url) => {
    await semaphore.acquire();

    try {
      const result = await getImageHash(url);
      results.set(url, result);

      if (results.size % 10 === 0) {
        console.log(`📊 Processed ${results.size}/${imageUrls.length} images`);
      }
    } finally {
      semaphore.release();
    }
  });

  await Promise.all(promises);
  console.log(`✅ Completed processing ${results.size} images`);

  return results;
}

/**
 * Simple semaphore for controlling concurrency
 */
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      this.permits--;
      resolve();
    }
  }
}

/**
 * Validates if a URL is a valid image URL
 */
export function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;

  try {
    const normalized = normalizeImageUrl(url);
    const parsedUrl = new URL(normalized);
    const pathname = parsedUrl.pathname.toLowerCase();

    // Check for common image extensions
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg'];
    if (imageExtensions.some(ext => pathname.endsWith(ext))) return true;

    // Accept Google Drive / lh3 direct endpoints even without file extension
    if (parsedUrl.hostname.includes('googleusercontent.com')) return true;
    if (parsedUrl.hostname.includes('drive.google.com') || parsedUrl.hostname.includes('docs.google.com')) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Gets all valid image URLs from an item's images array
 */
export function getValidImageUrls(images: any): string[] {
  if (!Array.isArray(images)) return [];

  const seen = new Set<string>();
  const urls: string[] = [];

  for (const raw of images) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizeImageUrl(trimmed);
    if (!isValidImageUrl(normalized)) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }

  return urls;
}
