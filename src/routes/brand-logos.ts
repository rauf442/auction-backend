// backend/src/routes/brand-logos.ts
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { supabaseAdmin as supabase } from '../utils/supabase';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
      fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

// GET /api/brand-logos/:brandId - Get brand logo info
router.get('/:brandId', async (req, res) => {
  try {
    const { brandId } = req.params;

    const { data: brand, error } = await supabase
      .from('brands')
      .select('id, code, name, logo_url, logo_file_name, logo_file_size, logo_mime_type, logo_uploaded_at')
      .eq('id', brandId)
      .single();

    if (error) {
      console.error('Brand lookup error:', error);
      return res.status(404).json({ 
        error: 'Brand not found',
        details: error.message 
      });
    }

    // Always return success, even if no logo is set
    res.json({
      success: true,
      data: {
        ...brand,
        has_logo: !!brand.logo_url,
        logo_status: brand.logo_url ? 'uploaded' : 'no_logo'
      }
    });
  } catch (err: any) {
    console.error('Error fetching brand logo:', err);
    res.status(500).json({ 
      error: 'Failed to fetch brand logo',
      details: err.message 
    });
  }
});

// POST /api/brand-logos/:brandId/upload - Upload brand logo
router.post('/:brandId/upload', upload.single('logo'), async (req, res) => {
  try {
    const { brandId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No logo file provided' 
      });
    }

    // Check if brand exists
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .select('id, code, name')
      .eq('id', brandId)
      .single();

    if (brandError) {
      return res.status(404).json({ 
        error: 'Brand not found' 
      });
    }

    // Generate unique filename
    const fileExtension = path.extname(req.file.originalname);
    const fileName = `brand_${brand.code}_logo_${Date.now()}${fileExtension}`;
    const filePath = `brand-logos/${fileName}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('brands')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: true
      });

    if (uploadError) {
      console.error('Supabase storage error:', uploadError);
      return res.status(500).json({ 
        error: 'Failed to upload logo to storage',
        details: uploadError.message 
      });
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('brands')
      .getPublicUrl(filePath);

    const logoUrl = urlData.publicUrl;

    // Update brand record with logo information
    const { data: updatedBrand, error: updateError } = await supabase
      .from('brands')
      .update({
        logo_url: logoUrl,
        logo_file_name: req.file.originalname,
        logo_file_size: req.file.size,
        logo_mime_type: req.file.mimetype,
        logo_uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', brandId)
      .select()
      .single();

    if (updateError) {
      console.error('Database update error:', updateError);
      return res.status(500).json({ 
        error: 'Failed to update brand logo information',
        details: updateError.message 
      });
    }

    res.json({
      success: true,
      message: 'Brand logo uploaded successfully',
      data: {
        id: updatedBrand.id,
        logo_url: updatedBrand.logo_url,
        logo_file_name: updatedBrand.logo_file_name,
        logo_file_size: updatedBrand.logo_file_size,
        logo_uploaded_at: updatedBrand.logo_uploaded_at
      }
    });

  } catch (err: any) {
    console.error('Error uploading brand logo:', err);
    res.status(500).json({ 
      error: 'Failed to upload brand logo',
      details: err.message 
    });
  }
});

// DELETE /api/brand-logos/:brandId - Delete brand logo
router.delete('/:brandId', async (req, res) => {
  try {
    const { brandId } = req.params;

    // Get current brand data
    const { data: brand, error: brandError } = await supabase
      .from('brands')
      .select('id, code, logo_url, logo_file_name')
      .eq('id', brandId)
      .single();

    if (brandError) {
      return res.status(404).json({ 
        error: 'Brand not found' 
      });
    }

    // Delete from storage if logo exists
    if (brand.logo_url) {
      // Extract file path from URL
      const urlParts = brand.logo_url.split('/');
      const fileName = urlParts[urlParts.length - 1];
      const filePath = `brand-logos/${fileName}`;

      const { error: deleteError } = await supabase.storage
        .from('brands')
        .remove([filePath]);

      if (deleteError) {
        console.warn('Failed to delete logo from storage:', deleteError);
        // Continue with database update even if storage deletion fails
      }
    }

    // Update brand record to remove logo information
    const { data: updatedBrand, error: updateError } = await supabase
      .from('brands')
      .update({
        logo_url: null,
        logo_file_name: null,
        logo_file_size: null,
        logo_mime_type: null,
        logo_uploaded_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', brandId)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ 
        error: 'Failed to remove brand logo information',
        details: updateError.message 
      });
    }

    res.json({
      success: true,
      message: 'Brand logo deleted successfully',
      data: updatedBrand
    });

  } catch (err: any) {
    console.error('Error deleting brand logo:', err);
    res.status(500).json({ 
      error: 'Failed to delete brand logo',
      details: err.message 
    });
  }
});

// GET /api/brand-logos - Get all brands with logo status
router.get('/', async (req, res) => {
  try {
    const { data: brands, error } = await supabase
      .from('brands')
      .select('id, code, name, logo_url, logo_file_name, logo_uploaded_at, is_active')
      .eq('is_active', true)
      .order('name');

    if (error) {
      return res.status(500).json({ 
        error: 'Failed to fetch brands',
        details: error.message 
      });
    }

    // Add logo status to each brand
    const brandsWithStatus = brands.map((brand: any) => ({
      ...brand,
      has_logo: !!brand.logo_url,
      logo_status: brand.logo_url ? 'uploaded' : 'no_logo'
    }));

    res.json({
      success: true,
      data: brandsWithStatus
    });

  } catch (err: any) {
    console.error('Error fetching brands:', err);
    res.status(500).json({ 
      error: 'Failed to fetch brands',
      details: err.message 
    });
  }
});

export default router;
