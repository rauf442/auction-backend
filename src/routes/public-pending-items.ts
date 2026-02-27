// backend/src/routes/public-pending-items.ts
// Purpose: Public, unauthenticated submission of artworks to pending items queue

import express from 'express'
import multer from 'multer'
import sharp from 'sharp'
import crypto from 'crypto'
import { supabaseAdmin } from '../utils/supabase'
import { z } from 'zod'

const ClientInfoSchema = z.object({
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().email().max(200),
  phone: z.string().trim().max(50).optional(),
  company_name: z.string().trim().max(200).optional(),
}).strict()

const ArtworkSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1),
  low_est: z.number().positive(),
  high_est: z.number().positive(),
  start_price: z.number().positive().optional(),
  condition: z.string().trim().max(200).optional(),
  reserve: z.number().positive().optional(),
  category: z.string().trim().max(200).optional(),
  subcategory: z.string().trim().max(200).optional(),
  height_inches: z.string().trim().max(50).optional(),
  width_inches: z.string().trim().max(50).optional(),
  height_cm: z.string().trim().max(50).optional(),
  width_cm: z.string().trim().max(50).optional(),
  height_with_frame_inches: z.string().trim().max(50).optional(),
  width_with_frame_inches: z.string().trim().max(50).optional(),
  height_with_frame_cm: z.string().trim().max(50).optional(),
  width_with_frame_cm: z.string().trim().max(50).optional(),
  weight: z.string().trim().max(50).optional(),
  materials: z.string().trim().max(300).optional(),
  artist_id: z.number().positive().optional(),
  school_id: z.string().trim().max(50).optional(),
  period_age: z.string().trim().max(200).optional(),
  provenance: z.string().trim().optional(),
  artwork_subject: z.string().trim().max(200).optional(),
  signature_placement: z.string().trim().max(200).optional(),
  medium: z.string().trim().max(200).optional(),
  include_artist_description: z.boolean().default(true),
  include_artist_key_description: z.boolean().default(true),
  include_artist_biography: z.boolean().default(false),
  include_artist_notable_works: z.boolean().default(false),
  include_artist_major_exhibitions: z.boolean().default(false),
  include_artist_awards_honors: z.boolean().default(false),
  include_artist_market_value_range: z.boolean().default(false),
  include_artist_signature_style: z.boolean().default(false),
  condition_report: z.string().trim().optional(),
  gallery_certification: z.boolean().default(false),
  gallery_certification_file: z.string().trim().optional(),
  gallery_id: z.string().trim().max(200).optional(),
  artist_certification: z.boolean().default(false),
  artist_certification_file: z.string().trim().optional(),
  certified_artist_id: z.string().trim().max(200).optional(),
  artist_family_certification: z.boolean().default(false),
  artist_family_certification_file: z.string().trim().optional(),
  restoration_done: z.boolean().default(false),
  restoration_done_file: z.string().trim().optional(),
  restoration_by: z.string().trim().max(200).optional(),
  images: z.array(z.string()).min(1, 'At least one image is required'),
}).strict()

const SubmissionSchema = z.object({
  client_id: z.string().trim().optional(),
  client_info: ClientInfoSchema.optional(),
  items: z.array(ArtworkSchema).min(1, 'At least one artwork is required'),
}).strict().refine(
  (data) => data.client_id || data.client_info,
  { message: "Either client_id or client_info is required" }
)

const router = express.Router()

// Multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
})

const STORAGE_BUCKET = 'artwork-images'

function generateSubmissionToken(): string {
  return crypto.randomBytes(24).toString('hex')
}

// Helper: upload a single image buffer to Supabase temp path
async function uploadTempImage(
  buffer: Buffer, 
  originalName: string, 
  submissionToken: string, 
  artworkIndex: number, 
  imageIndex: number
) {
  const optimized = await sharp(buffer)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()

  const ext = (originalName.split('.').pop() || 'jpg').toLowerCase()
  const filename = `pending/${submissionToken}/artwork_${artworkIndex + 1}/image_${imageIndex + 1}_${Date.now()}.${ext}`

  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(filename, optimized, { 
      contentType: 'image/jpeg', 
      cacheControl: '3600', 
      upsert: false 
    })
  
  if (error) throw new Error(`Temp upload failed: ${error.message}`)

  const { data: urlData } = supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(data.path)

  return { path: data.path, publicUrl: urlData.publicUrl }
}

// POST /api/public/pending-items/submit
router.post('/submit', upload.none(), async (req, res) => {
  try {
    const submitterIp = (req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || '').toString()
    
    // Validate submission
    const parsed = SubmissionSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ 
        error: 'Invalid submission', 
        details: parsed.error.flatten().fieldErrors 
      })
    }

    const { client_id, client_info, items } = parsed.data
    const submissionToken = generateSubmissionToken()

    const tempPaths: string[] = []
    const tempUrlsByArtwork: Record<string, string[]> = {}
    const processedItems: any[] = []

    // Process each artwork
    for (let artworkIdx = 0; artworkIdx < items.length; artworkIdx++) {
      const artwork = items[artworkIdx]
      const imageUrls: string[] = []

      // Process images
      for (let imgIdx = 0; imgIdx < Math.min(artwork.images.length, 10); imgIdx++) {
        const img = artwork.images[imgIdx]
        if (typeof img !== 'string' || img.length === 0) continue

        if (img.startsWith('data:image/')) {
          // Base64 data URL - upload to Supabase
          const match = img.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
          if (!match) continue

          const b64 = match[2]
          const buf = Buffer.from(b64, 'base64')
          const uploaded = await uploadTempImage(buf, `image_${imgIdx + 1}.jpg`, submissionToken, artworkIdx, imgIdx)
          
          imageUrls.push(uploaded.publicUrl)
          tempPaths.push(uploaded.path)
        } else if (/^https?:\/\//i.test(img)) {
          // External URL - store as-is
          imageUrls.push(img)
        }
      }

      if (imageUrls.length === 0) {
        return res.status(400).json({ 
          error: `Artwork ${artworkIdx + 1}: at least one valid image is required` 
        })
      }

      tempUrlsByArtwork[`artwork_${artworkIdx + 1}`] = imageUrls

      // Process the artwork data
      processedItems.push({
        title: artwork.title,
        description: artwork.description,
        low_est: artwork.low_est,
        high_est: artwork.high_est,
        start_price: artwork.start_price || Math.round(artwork.low_est * 0.5),
        reserve: artwork.reserve || Math.round(artwork.low_est * 0.5),
        condition: artwork.condition || null,
        category: artwork.category || null,
        subcategory: artwork.subcategory || null,
        height_inches: artwork.height_inches || null,
        width_inches: artwork.width_inches || null,
        height_cm: artwork.height_cm || null,
        width_cm: artwork.width_cm || null,
        height_with_frame_inches: artwork.height_with_frame_inches || null,
        width_with_frame_inches: artwork.width_with_frame_inches || null,
        height_with_frame_cm: artwork.height_with_frame_cm || null,
        width_with_frame_cm: artwork.width_with_frame_cm || null,
        weight: artwork.weight || null,
        materials: artwork.materials || null,
        artist_id: artwork.artist_id || null,
        school_id: artwork.school_id || null,
        period_age: artwork.period_age || null,
        provenance: artwork.provenance || null,
        artwork_subject: artwork.artwork_subject || null,
        signature_placement: artwork.signature_placement || null,
        medium: artwork.medium || null,
        include_artist_description: artwork.include_artist_description,
        include_artist_key_description: artwork.include_artist_key_description,
        include_artist_biography: artwork.include_artist_biography,
        include_artist_notable_works: artwork.include_artist_notable_works,
        include_artist_major_exhibitions: artwork.include_artist_major_exhibitions,
        include_artist_awards_honors: artwork.include_artist_awards_honors,
        include_artist_market_value_range: artwork.include_artist_market_value_range,
        include_artist_signature_style: artwork.include_artist_signature_style,
        condition_report: artwork.condition_report || null,
        gallery_certification: artwork.gallery_certification,
        gallery_certification_file: artwork.gallery_certification_file || null,
        gallery_id: artwork.gallery_id || null,
        artist_certification: artwork.artist_certification,
        artist_certification_file: artwork.artist_certification_file || null,
        certified_artist_id: artwork.certified_artist_id || null,
        artist_family_certification: artwork.artist_family_certification,
        artist_family_certification_file: artwork.artist_family_certification_file || null,
        restoration_done: artwork.restoration_done,
        restoration_done_file: artwork.restoration_done_file || null,
        restoration_by: artwork.restoration_by || null,
        images: imageUrls,
      })
    }

    // Create pending items record
    const record = {
      status: 'submitted',
      client_id: client_id ? parseInt(client_id) : null,
      client_info: client_info || null,
      items: processedItems,
      temp_storage_paths: tempPaths,
      temp_public_urls: tempUrlsByArtwork,
      submission_token: submissionToken,
      submitter_ip: submitterIp,
      created_at: new Date().toISOString(),
    }

    const { data, error } = await supabaseAdmin
      .from('pending_items')
      .insert(record)
      .select('id')
      .single()

    if (error) {
      return res.status(500).json({ 
        error: 'Failed to save submission', 
        details: error.message 
      })
    }

    res.json({ 
      success: true, 
      submission_id: data?.id, 
      submission_token: submissionToken,
      artworks_count: items.length
    })

  } catch (e: any) {
    console.error('Public pending items submission error:', e)
    res.status(500).json({ 
      error: 'Internal server error', 
      details: e.message 
    })
  }
})

export default router
