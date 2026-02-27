// backend/src/routes/public-inventory.ts

import express from 'express'
import multer from 'multer'
import sharp from 'sharp'
import crypto from 'crypto'
import { supabaseAdmin } from '../utils/supabase'
import { GoogleGenerativeAI } from '@google/generative-ai'

const router = express.Router()
const STORAGE_BUCKET = 'artwork-images'
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')

// ─── Multer ───────────────────────────────────────────────────────────────────
const uploadAny = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,   // 10MB per file
    files: 150,
    fieldSize: 100 * 1024 * 1024, // ✅ FIX 1: 100MB field limit (items_json contains base64 images)
  },
  fileFilter: (_req, file, cb) => {
    console.log(`[MULTER] fileFilter called: fieldname="${file.fieldname}" mimetype="${file.mimetype}" originalname="${file.originalname}"`)
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
})

const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
})

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeNumber(n: any, fallback: number | null = null): number | null {
  const v = Number(n)
  return Number.isFinite(v) ? v : fallback
}

function generateSubmissionToken(): string {
  return crypto.randomBytes(24).toString('hex')
}

async function uploadImageBuffer(
  buffer: Buffer,
  submissionToken: string,
  itemIndex: number,
  imageIndex: number
): Promise<{ path: string; publicUrl: string }> {
  const optimized = await sharp(buffer)
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer()

  const filename = `pending/${submissionToken}/item_${itemIndex + 1}/image_${imageIndex + 1}_${Date.now()}.jpg`

  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(filename, optimized, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false })

  if (error) throw new Error(`Upload failed: ${error.message}`)

  const { data: urlData } = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(data.path)
  return { path: data.path, publicUrl: urlData.publicUrl }
}

// ✅ FIX 2: Helper to convert a base64 data URL to a Buffer
function base64ToBuffer(dataUrl: string): Buffer | null {
  try {
    const matches = dataUrl.match(/^data:image\/\w+;base64,(.+)$/)
    if (!matches) return null
    return Buffer.from(matches[1], 'base64')
  } catch {
    return null
  }
}

function parseDimensions(dimensionsStr: string) {
  const result = {
    height_inches: '', width_inches: '', height_cm: '', width_cm: '',
    height_with_frame_inches: '', width_with_frame_inches: '',
    height_with_frame_cm: '', width_with_frame_cm: '',
  }
  if (!dimensionsStr) return result
  const cleanDims = dimensionsStr.toLowerCase().trim()
  const match = cleanDims.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/)
  if (!match) return result
  const isCm = cleanDims.includes('cm') || cleanDims.includes('centimeter')
  const d1 = parseFloat(match[1]), d2 = parseFloat(match[2])
  let widthInches: number, heightInches: number
  if (isCm) {
    result.width_cm = d1.toString(); result.height_cm = d2.toString()
    widthInches = Math.round((d1 / 2.54) * 100) / 100
    heightInches = Math.round((d2 / 2.54) * 100) / 100
    result.width_inches = widthInches.toString(); result.height_inches = heightInches.toString()
  } else {
    result.width_inches = d1.toString(); result.height_inches = d2.toString()
    widthInches = d1; heightInches = d2
    result.width_cm = Math.round(d1 * 2.54 * 100 / 100).toString()
    result.height_cm = Math.round(d2 * 2.54 * 100 / 100).toString()
  }
  result.width_with_frame_inches = (widthInches + 2).toFixed(1)
  result.height_with_frame_inches = (heightInches + 2).toFixed(1)
  result.width_with_frame_cm = ((widthInches + 2) * 2.54).toFixed(1)
  result.height_with_frame_cm = ((heightInches + 2) * 2.54).toFixed(1)
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/public/inventory/ai-analyze
// ─────────────────────────────────────────────────────────────────────────────
router.post('/ai-analyze', uploadSingle.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No image file provided' })
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ success: false, error: 'AI service not configured' })

    const optimizedImage = await sharp(req.file.buffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer()

    const base64Image = optimizedImage.toString('base64')
    const prompt = `Analyze this artwork image and provide detailed information in JSON format.
IMPORTANT: Respond ONLY with a valid JSON object. No text before or after. No markdown code blocks.
Required JSON format:
{
  "title": "string",
  "artist_name": "string or null",
  "materials": "string",
  "dimensions": "string (e.g. 24x36 inches or 60x90 cm)",
  "period_age": "string",
  "condition": "string",
  "category": "string",
  "description": "string",
  "artwork_subject": "string",
  "low_est": number,
  "high_est": number
}`

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    const result = await model.generateContent([prompt, { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }])
    const text = result.response.text()

    let analysisResult: any
    try { analysisResult = JSON.parse(text.trim()) }
    catch {
      const first = text.indexOf('{'), last = text.lastIndexOf('}')
      if (first !== -1 && last !== -1 && last > first) {
        try { analysisResult = JSON.parse(text.substring(first, last + 1)) }
        catch { return res.status(500).json({ success: false, error: 'AI returned an unparseable response.' }) }
      } else {
        return res.status(500).json({ success: false, error: 'AI returned an unexpected response format.' })
      }
    }

    const dims = parseDimensions(analysisResult.dimensions || '')
    const lowEst = Number(analysisResult.low_est) || 0
    const highEst = Number(analysisResult.high_est) || 0
    const startPrice = Math.round(lowEst * 0.5)

    let formattedTitle = analysisResult.title || ''
    if (analysisResult.artist_name) formattedTitle = `${analysisResult.artist_name} | ${formattedTitle}`
    if (analysisResult.period_age) {
      const yearMatch = analysisResult.period_age.match(/\b(1[0-9]{3}|20[0-9]{2})\b/)
      formattedTitle += ` | ${yearMatch ? yearMatch[0] : analysisResult.period_age}`
    }
    if (analysisResult.materials) formattedTitle += ` | ${analysisResult.materials}`

    return res.json({
      success: true,
      result: {
        title: formattedTitle || analysisResult.title || '',
        description: analysisResult.description || analysisResult.title || '',
        category: analysisResult.category || '', materials: analysisResult.materials || '',
        medium: analysisResult.materials || '', period_age: analysisResult.period_age || '',
        condition: analysisResult.condition || '', artwork_subject: analysisResult.artwork_subject || '',
        low_est: lowEst, high_est: highEst, start_price: startPrice, reserve: startPrice,
        ...dims,
      },
    })
  } catch (err: any) {
    console.error('[AI Analyze] Error:', err)
    return res.status(500).json({ success: false, error: err.message || 'AI analysis failed' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/public/inventory/submit
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit', (req, res, next) => {
  console.log('═══════════════════════════════════════════════')
  console.log('[SUBMIT] RAW REQUEST HIT')
  console.log('[SUBMIT] Content-Type:', req.headers['content-type'])
  console.log('[SUBMIT] Content-Length:', req.headers['content-length'])
  console.log('═══════════════════════════════════════════════')
  next()
}, uploadAny.any(), async (req, res) => {
  try {
    const allFiles = (req.files as Express.Multer.File[]) || []

    console.log('─────────────────────────────────────────────')
    console.log('[SUBMIT] After multer parsing:')
    console.log('[SUBMIT] req.body keys:', Object.keys(req.body))
    console.log('[SUBMIT] req.body.client_id:', req.body.client_id)
    console.log('[SUBMIT] req.body.client_info:', req.body.client_info)
    console.log('[SUBMIT] req.body.items_json present:', !!req.body.items_json)
    console.log('[SUBMIT] req.body.items_json length:', req.body.items_json?.length)
    console.log('[SUBMIT] Total files received:', allFiles.length)
    console.log('─────────────────────────────────────────────')

    const submitterIp = (
      req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || ''
    ).toString()

    // ── Parse client fields ───────────────────────────────────────────────────
    const clientId = req.body.client_id ? String(req.body.client_id).trim() : undefined
    let clientInfo: any = undefined
    if (req.body.client_info) {
      try { clientInfo = JSON.parse(req.body.client_info) } catch (e) {
        console.warn('[SUBMIT] Failed to parse client_info JSON:', e)
      }
    }

    // ── Parse items_json ──────────────────────────────────────────────────────
    if (!req.body.items_json) {
      console.error('[SUBMIT] ❌ items_json missing from body')
      return res.status(400).json({ error: 'items_json is required' })
    }

    let items: any[]
    try {
      items = JSON.parse(req.body.items_json)
      if (!Array.isArray(items) || items.length === 0) throw new Error('must be a non-empty array')
      console.log(`[SUBMIT] Parsed ${items.length} item(s) from items_json`)
    } catch (e: any) {
      console.error('[SUBMIT] ❌ Failed to parse items_json:', e.message)
      return res.status(400).json({ error: 'Invalid items_json', details: e.message })
    }

    // ── Validate client ───────────────────────────────────────────────────────
    const hasClientId = !!(clientId && /\d+/.test(clientId))
    const hasClientInfo = !!(clientInfo?.first_name && clientInfo?.last_name && clientInfo?.email)
    console.log(`[SUBMIT] hasClientId=${hasClientId} hasClientInfo=${hasClientInfo}`)
    if (!hasClientId && !hasClientInfo) {
      return res.status(400).json({ error: 'Provide either client_id or complete client_info (first_name, last_name, email)' })
    }

    // ── Index multer files by fieldname (for any actual file uploads) ─────────
    const filesByField: Record<string, Express.Multer.File> = {}
    for (const file of allFiles) {
      filesByField[file.fieldname] = file
    }

    const submissionToken = generateSubmissionToken()
    const tempPaths: string[] = []
    const tempUrlsByItem: Record<string, string[]> = {}
    const sanitizedItems: any[] = []

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx] || {}
      const imageUrls: string[] = []
      const rawImages: string[] = Array.isArray(it.images) ? it.images : []

      console.log(`[SUBMIT] Processing item ${idx}: "${it.title}" — ${rawImages.length} image slot(s)`)

      for (let imgIdx = 0; imgIdx < rawImages.length; imgIdx++) {
        const imageValue = rawImages[imgIdx]
        if (!imageValue) continue

        // ✅ FIX 2: Handle base64 data URLs sent directly in items_json
        if (imageValue.startsWith('data:image/')) {
          console.log(`[SUBMIT] 🖼️  base64 image found at item ${idx} slot ${imgIdx}, uploading...`)
          const buffer = base64ToBuffer(imageValue)
          if (buffer) {
            try {
              const { path, publicUrl } = await uploadImageBuffer(buffer, submissionToken, idx, imgIdx)
              tempPaths.push(path)
              imageUrls.push(publicUrl)
              console.log(`[SUBMIT] ✅ Uploaded base64 image → ${publicUrl}`)
            } catch (err: any) {
              console.error(`[SUBMIT] ❌ base64 upload failed for item ${idx} slot ${imgIdx}:`, err.message)
            }
          } else {
            console.warn(`[SUBMIT] ⚠️  Could not decode base64 for item ${idx} slot ${imgIdx}`)
          }

        // Handle already-uploaded https:// URLs (pass through)
        } else if (/^https?:\/\//i.test(imageValue)) {
          imageUrls.push(imageValue)
          console.log(`[SUBMIT] 🔗 Existing URL kept for item ${idx} slot ${imgIdx}`)

        // Handle multer file fields (artwork_N_image_M or item_N_image_M)
        } else {
          // Check both naming conventions just in case
          const artworkKey = `artwork_${idx}_image_${imgIdx}`
          const itemKey = `item_${idx}_image_${imgIdx}`
          const file = filesByField[artworkKey] || filesByField[itemKey]
          if (file) {
            try {
              const { path, publicUrl } = await uploadImageBuffer(file.buffer, submissionToken, idx, imgIdx)
              tempPaths.push(path)
              imageUrls.push(publicUrl)
              console.log(`[SUBMIT] ✅ Uploaded file field → ${publicUrl}`)
            } catch (err: any) {
              console.error(`[SUBMIT] ❌ File upload failed for item ${idx} slot ${imgIdx}:`, err.message)
            }
          }
        }
      }

      console.log(`[SUBMIT] Item ${idx} final image count: ${imageUrls.length}`)
      tempUrlsByItem[String(idx + 1)] = imageUrls

      sanitizedItems.push({
        title:       it.title       || null,
        description: it.description || null,
        low_est:     safeNumber(it.low_est),
        high_est:    safeNumber(it.high_est),
        start_price: safeNumber(it.start_price) ?? (it.low_est ? Math.round(Number(it.low_est) * 0.5) : null),
        reserve:     safeNumber(it.reserve)     ?? (it.low_est ? Math.round(Number(it.low_est) * 0.5) : null),
        category:    it.category    || null,
        subcategory: it.subcategory || null,
        materials:   it.materials   || null,
        medium:      it.medium      || null,
        period_age:  it.period_age  || null,
        condition:   it.condition   || null,
        condition_report:    it.condition_report    || null,
        provenance:          it.provenance          || null,
        artwork_subject:     it.artwork_subject     || null,
        signature_placement: it.signature_placement || null,
        weight:              it.weight              || null,
        height_inches:            it.height_inches            || null,
        width_inches:             it.width_inches             || null,
        height_cm:                it.height_cm                || null,
        width_cm:                 it.width_cm                 || null,
        height_with_frame_inches: it.height_with_frame_inches || null,
        width_with_frame_inches:  it.width_with_frame_inches  || null,
        height_with_frame_cm:     it.height_with_frame_cm     || null,
        width_with_frame_cm:      it.width_with_frame_cm      || null,
        artist_id:  it.artist_id  || null,
        school_id:  it.school_id  || null,
        include_artist_description:        it.include_artist_description        ?? true,
        include_artist_key_description:    it.include_artist_key_description    ?? true,
        include_artist_biography:          it.include_artist_biography          ?? false,
        include_artist_notable_works:      it.include_artist_notable_works      ?? false,
        include_artist_major_exhibitions:  it.include_artist_major_exhibitions  ?? false,
        include_artist_awards_honors:      it.include_artist_awards_honors      ?? false,
        include_artist_market_value_range: it.include_artist_market_value_range ?? false,
        include_artist_signature_style:    it.include_artist_signature_style    ?? false,
        gallery_certification:             it.gallery_certification             ?? false,
        gallery_certification_file:        it.gallery_certification_file        || null,
        gallery_id:                        it.gallery_id                        || null,
        artist_certification:              it.artist_certification              ?? false,
        artist_certification_file:         it.artist_certification_file         || null,
        certified_artist_id:               it.certified_artist_id               || null,
        artist_family_certification:       it.artist_family_certification       ?? false,
        artist_family_certification_file:  it.artist_family_certification_file  || null,
        restoration_done:                  it.restoration_done                  ?? false,
        restoration_done_file:             it.restoration_done_file             || null,
        restoration_by:                    it.restoration_by                    || null,
        images: imageUrls,
      })
    }

    // ── Resolve numeric client_id ─────────────────────────────────────────────
    let numericClientId: number | null = null
    if (hasClientId && clientId) {
      const m = clientId.match(/(\d+)/)
      if (m) numericClientId = Number(m[1])
    }

    const record = {
      status:             'submitted',
      client_id:          numericClientId,
      client_info:        clientInfo || null,
      brand_code:         null,
      items:              sanitizedItems,
      temp_storage_paths: tempPaths,
      temp_public_urls:   tempUrlsByItem,
      submission_token:   submissionToken,
      submitter_ip:       submitterIp,
      created_at:         new Date().toISOString(),
    }

    const { data, error } = await supabaseAdmin
      .from('pending_items')
      .insert(record as any)
      .select('id')
      .single()

    if (error) {
      console.error('[SUBMIT] ❌ DB insert error:', error)
      return res.status(500).json({ error: 'Failed to save submission', details: error.message })
    }

    const totalImages = sanitizedItems.reduce((s, it) => s + (it.images?.length ?? 0), 0)
    console.log(`[SUBMIT] ✅ Saved submission ${data?.id} | Items: ${sanitizedItems.length} | Images: ${totalImages}`)

    res.json({ success: true, submission_id: data?.id, submission_token: submissionToken })
  } catch (e: any) {
    console.error('[SUBMIT] ❌ Unexpected error:', e)
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

export default router