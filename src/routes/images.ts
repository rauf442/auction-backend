// backend/src/routes/images.ts
import express, { Request, Response } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import sharp from 'sharp';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Configure multer for image upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// Storage bucket name
const STORAGE_BUCKET = 'artwork-images';

// Generate image path
const generateImagePath = (itemId: string, imageIndex: number, originalName: string): string => {
  const timestamp = Date.now();
  const extension = originalName.split('.').pop()?.toLowerCase() || 'jpg';
  return `items/${itemId}/image_${imageIndex}_${timestamp}.${extension}`;
};

// POST /api/images/upload - Upload single image
router.post('/upload', upload.single('image'), async (req: Request, res: Response) => {
  try {
    console.log('📤 Single image upload request received');
    console.log('Request body:', req.body);
    console.log('Request file:', req.file ? `${req.file.fieldname} - ${req.file.originalname}` : 'No file');
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const { itemId, imageIndex } = req.body;
    
    if (!itemId || !imageIndex) {
      return res.status(400).json({ error: 'itemId and imageIndex are required' });
    }

    console.log(`📤 Processing image upload: ${req.file.originalname} (${req.file.size} bytes) for item ${itemId}`);

    // Check if the bucket exists first
    const { data: buckets, error: bucketError } = await supabaseAdmin.storage.listBuckets();
    if (bucketError) {
      console.error('❌ Failed to list buckets:', bucketError);
      return res.status(500).json({ 
        error: 'Storage service unavailable', 
        details: bucketError.message 
      });
    }

    const bucketExists = buckets?.some(bucket => bucket.name === STORAGE_BUCKET);
    if (!bucketExists) {
      console.error(`❌ Storage bucket "${STORAGE_BUCKET}" does not exist. Available buckets:`, buckets?.map(b => b.name));
      return res.status(500).json({ 
        error: 'Storage bucket not configured', 
        details: `The storage bucket "${STORAGE_BUCKET}" does not exist. Please create it in Supabase.` 
      });
    }

    // Optimize image using Sharp
    console.log('🖼️ Processing image with Sharp...');
    const optimizedImage = await sharp(req.file.buffer)
      .resize(1200, 1200, { 
        fit: 'inside',
        withoutEnlargement: true 
      })
      .jpeg({ quality: 85 })
      .toBuffer();

    console.log(`✅ Image optimized: ${optimizedImage.length} bytes`);

    // Generate path for storage
    const imagePath = generateImagePath(itemId, parseInt(imageIndex), req.file.originalname);
    console.log(`📁 Upload path: ${imagePath}`);

    // Upload to Supabase storage
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(imagePath, optimizedImage, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      console.error('❌ Supabase upload error:', error);
      return res.status(500).json({ 
        error: 'Upload failed', 
        details: error.message 
      });
    }

    console.log('✅ Upload successful:', data.path);

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(data.path);

    console.log('🔗 Generated public URL:', urlData.publicUrl);

    res.json({
      success: true,
      url: urlData.publicUrl,
      path: data.path
    });

  } catch (error: any) {
    console.error('❌ Error uploading image:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

// POST /api/images/upload-multiple - Upload multiple images for an item
router.post('/upload-multiple', upload.array('images', 10), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];
    
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No image files provided' });
    }

    const { itemId } = req.body;
    
    if (!itemId) {
      return res.status(400).json({ error: 'itemId is required' });
    }

    const uploadResults = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const imageIndex = i + 1;

      try {
        // Optimize image
        const optimizedImage = await sharp(file.buffer)
          .resize(1200, 1200, { 
            fit: 'inside',
            withoutEnlargement: true 
          })
          .jpeg({ quality: 85 })
          .toBuffer();

        // Generate path
        const imagePath = generateImagePath(itemId, imageIndex, file.originalname);

        // Upload to Supabase
        const { data, error } = await supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .upload(imagePath, optimizedImage, {
            contentType: 'image/jpeg',
            cacheControl: '3600',
            upsert: false
          });

        if (error) {
          errors.push(`Image ${imageIndex}: ${error.message}`);
          continue;
        }

        // Get public URL
        const { data: urlData } = supabaseAdmin.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(data.path);

        uploadResults.push({
          index: imageIndex,
          url: urlData.publicUrl,
          path: data.path
        });

      } catch (err: any) {
        errors.push(`Image ${imageIndex}: ${err.message}`);
      }
    }

    res.json({
      success: uploadResults.length > 0,
      uploads: uploadResults,
      errors: errors
    });

  } catch (error: any) {
    console.error('Error uploading multiple images:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

// DELETE /api/images/:path - Delete an image
router.delete('/:itemId/:filename', async (req: Request, res: Response) => {
  try {
    const { itemId, filename } = req.params;
    const imagePath = `items/${itemId}/${filename}`;

    const { error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .remove([imagePath]);

    if (error) {
      console.error('Supabase delete error:', error);
      return res.status(500).json({ 
        error: 'Delete failed', 
        details: error.message 
      });
    }

    res.json({
      success: true,
      message: 'Image deleted successfully'
    });

  } catch (error: any) {
    console.error('Error deleting image:', error);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

// POST /api/images/process-item-images - Process images when saving an item
router.post('/process-item-images', (req: Request, res: Response) => {
  // Use dynamic multer middleware to handle any field names
  const dynamicUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB limit
      files: 10 // Max 10 files
    },
    fileFilter: (req, file, cb) => {
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    },
  }).any(); // Accept any field names

  dynamicUpload(req, res, async (err) => {
    if (err) {
      console.error('❌ Multer error:', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ error: 'Too many files. Maximum is 10 files.' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message });
    }

    try {
      const files = req.files as Express.Multer.File[];
      const { itemId, existingImages } = req.body;
      
      if (!itemId) {
        return res.status(400).json({ error: 'itemId is required' });
      }

      console.log(`📤 Processing ${files?.length || 0} images for item ${itemId}`);
      console.log('Request body keys:', Object.keys(req.body));
      console.log('File field names:', files?.map(f => f.fieldname) || []);

      // Check if the bucket exists first
      const { data: buckets, error: bucketError } = await supabaseAdmin.storage.listBuckets();
      if (bucketError) {
        console.error('❌ Failed to list buckets:', bucketError);
        return res.status(500).json({ 
          error: 'Storage service unavailable', 
          details: bucketError.message 
        });
      }

      const bucketExists = buckets?.some(bucket => bucket.name === STORAGE_BUCKET);
      if (!bucketExists) {
        console.error(`❌ Storage bucket "${STORAGE_BUCKET}" does not exist. Available buckets:`, buckets?.map(b => b.name));
        return res.status(500).json({ 
          error: 'Storage bucket not configured', 
          details: `The storage bucket "${STORAGE_BUCKET}" does not exist. Please create it in Supabase.` 
        });
      }

      let processedImages: Record<string, string> = {};
      
      // Parse existing images if provided
      let existing: Record<string, string> = {};
      if (existingImages) {
        try {
          existing = JSON.parse(existingImages);
          console.log('Existing images:', existing);
        } catch (parseError) {
          console.warn('Failed to parse existing images:', parseError);
        }
      }

      // Start with existing images
      processedImages = { ...existing };

      // Process new uploaded files
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fieldName = file.fieldname; // Could be 'image_file_1', 'image_file_2', etc. or 'images'

          console.log(`🖼️ Processing ${fieldName}: ${file.originalname} (${file.size} bytes)`);

          let imageIndex: number;

          // Handle both old format (image_file_1, image_file_2, etc.) and new format (images array)
          const match = fieldName.match(/image_file_(\d+)/);
          if (match) {
            // Old format: image_file_1, image_file_2, etc.
            imageIndex = parseInt(match[1]);
          } else if (fieldName === 'images') {
            // New format: images array - assign sequential indices
            imageIndex = i + 1;
          } else {
            console.log(`⚠️ Skipping file with invalid field name: ${fieldName}`);
            continue;
          }

          try {
            // Optimize image
            const optimizedImage = await sharp(file.buffer)
              .resize(1200, 1200, { 
                fit: 'inside',
                withoutEnlargement: true 
              })
              .jpeg({ quality: 85 })
              .toBuffer();

            console.log(`✅ Image optimized: ${optimizedImage.length} bytes`);

            // Generate path
            const imagePath = generateImagePath(itemId, imageIndex, file.originalname);

            // Upload to Supabase
            const { data, error } = await supabaseAdmin.storage
              .from(STORAGE_BUCKET)
              .upload(imagePath, optimizedImage, {
                contentType: 'image/jpeg',
                cacheControl: '3600',
                upsert: false
              });

            if (error) {
              console.error(`❌ Upload error for image ${imageIndex}:`, error);
              continue;
            }

            console.log(`✅ Upload successful for ${fieldName}: ${data.path}`);

            // Get public URL
            const { data: urlData } = supabaseAdmin.storage
              .from(STORAGE_BUCKET)
              .getPublicUrl(data.path);

            processedImages[fieldName] = urlData.publicUrl;

          } catch (err: any) {
            console.error(`❌ Processing error for image ${imageIndex}:`, err);
          }
        }
      }

      console.log(`✅ Processed ${Object.keys(processedImages).length} images for item ${itemId}`);

      res.json({
        success: true,
        images: processedImages
      });

    } catch (error: any) {
      console.error('❌ Error processing item images:', error);
      res.status(500).json({ 
        error: 'Internal server error', 
        details: error.message 
      });
    }
  });
});

// GET /api/images/proxy - Proxy image downloads to bypass CORS
router.get('/proxy', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Validate URL format
    let imageUrl: URL;
    try {
      imageUrl = new URL(url);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Only allow http/https protocols
    if (!['http:', 'https:'].includes(imageUrl.protocol)) {
      return res.status(400).json({ error: 'Only HTTP/HTTPS URLs are allowed' });
    }

    // Download the image with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ImageProxy/1.0)',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `Failed to fetch image: ${response.statusText}` 
      });
    }

    // Check if it's actually an image
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'URL does not point to an image' });
    }

    // Get the image buffer
    const buffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(buffer);

    // Set appropriate headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', imageBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

    // Send the image
    res.send(imageBuffer);

  } catch (error: any) {
    console.error('Error proxying image:', error);
    
    // Handle abort/timeout errors
    if (error.name === 'AbortError' || error.message?.includes('aborted')) {
      return res.status(504).json({ 
        error: 'Request timeout', 
        details: 'Image download took too long' 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to proxy image', 
      details: error.message 
    });
  }
});

export default router;
