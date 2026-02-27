
console.log("🔥 pending-items route LOADED")

// backend/src/routes/pending-items.ts
// Purpose: Admin endpoints to manage pending items: list, approve (create clients/consignments + items), reject.

import express from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabaseAdmin } from '../utils/supabase'

const router = express.Router()
router.use(authMiddleware)

const STORAGE_BUCKET = 'artwork-images'

// GET /api/pending-items
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('pending_items')
      .select('*')
      .eq('status', 'submitted')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true, data })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

// POST /api/pending-items/:id/approve
// Body: { brand_code?: string }
router.post('/:id/approve', async (req, res) => {
  console.log('🔥 APPROVE ROUTE HIT');
  try {
    const { id } = req.params
    const { brand_code } = req.body || {}
    const { data: pending, error } = await supabaseAdmin
      .from('pending_items')
      .select('*')
      .eq('id', id)
      .single()
    if (error || !pending) return res.status(404).json({ error: 'Pending submission not found' })

    const submissionToken = pending.submission_token
    const items: any[] = Array.isArray(pending.items) ? pending.items : []
    const clientInfo = pending.client_info || {}

    let clientId = pending.client_id
    let consignmentId: number | null = null

    // Create client if needed (when client_info is provided and no existing client_id)
    if (!clientId && clientInfo.first_name && clientInfo.last_name && clientInfo.email) {
      const clientData = {
        first_name: clientInfo.first_name,
        last_name: clientInfo.last_name,
        email: clientInfo.email,
        phone_number: clientInfo.phone || null,
        company_name: clientInfo.company_name || null,
        status: 'active',
        created_at: new Date().toISOString(),
      }

      const { data: newClient, error: clientError } = await supabaseAdmin
        .from('clients')
        .insert(clientData)
        .select('id')
        .single()

      if (clientError) {
        console.error('Failed to create client:', clientError)
        return res.status(500).json({ error: 'Failed to create client', details: clientError.message })
      }

      clientId = newClient.id
    }

    // Create consignment if we have a client
    console.log('CLIENT ID BEFORE CONSIGNMENT:', clientId)
    if (clientId) {
      console.log('🚀 Attempting to create consignment')
      const consignmentData = {
        client_id: clientId,
        status: 'active',
        is_signed: false,
        items_count: items.length,
        created_at: new Date().toISOString(),
      }
      

      const { data: newConsignment, error: consignmentError } = await supabaseAdmin
        .from('consignments')
        .insert(consignmentData)
        .select('id')
        .single()
      console.log('CONSIGNMENT RESULT:', newConsignment)
      console.log('CONSIGNMENT ERROR:', consignmentError)
      if (consignmentError) {
        console.error('Failed to create consignment:', consignmentError)
        return res.status(500).json({ error: 'Failed to create consignment', details: consignmentError.message })
      }

      consignmentId = newConsignment.id
    }

    // For each item: create item in items table (status=draft)
    const createdItemIds: number[] = []
    console.log('🧾 Items to insert:', items.length);
    console.log('🧾 Items payload:', items);
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const images: string[] = Array.isArray(it.images) ? it.images : []

      const record: any = {
        title: it.title || 'Untitled',
        description: it.description || '',
        low_est: it.low_est || null,
        high_est: it.high_est || null,
        start_price: it.start_price || null,
        reserve: it.reserve || null,
        category: it.category || null,
        subcategory: it.subcategory || null,
        materials: it.materials || null,
        height_inches: it.height_inches || null,
        width_inches: it.width_inches || null,
        height_cm: it.height_cm || null,
        width_cm: it.width_cm || null,
        height_with_frame_inches: it.height_with_frame_inches || null,
        width_with_frame_inches: it.width_with_frame_inches || null,
        height_with_frame_cm: it.height_with_frame_cm || null,
        width_with_frame_cm: it.width_with_frame_cm || null,
        weight: it.weight || null,
        artist_id: it.artist_id || null,
        school_id: it.school_id || null,
        period_age: it.period_age || null,
        condition: it.condition || null,
        provenance: it.provenance || null,
        artwork_subject: it.artwork_subject || null,
        signature_placement: it.signature_placement || null,
        medium: it.medium || null,
        include_artist_description: it.include_artist_description ?? true,
        include_artist_key_description: it.include_artist_key_description ?? true,
        include_artist_biography: it.include_artist_biography ?? false,
        include_artist_notable_works: it.include_artist_notable_works ?? false,
        include_artist_major_exhibitions: it.include_artist_major_exhibitions ?? false,
        include_artist_awards_honors: it.include_artist_awards_honors ?? false,
        include_artist_market_value_range: it.include_artist_market_value_range ?? false,
        include_artist_signature_style: it.include_artist_signature_style ?? false,
        condition_report: it.condition_report || null,
        gallery_certification: it.gallery_certification ?? false,
        gallery_certification_file: it.gallery_certification_file || null,
        gallery_id: it.gallery_id || null,
        artist_certification: it.artist_certification ?? false,
        artist_certification_file: it.artist_certification_file || null,
        certified_artist_id: it.certified_artist_id || null,
        artist_family_certification: it.artist_family_certification ?? false,
        artist_family_certification_file: it.artist_family_certification_file || null,
        restoration_done: it.restoration_done ?? false,
        restoration_done_file: it.restoration_done_file || null,
        restoration_by: it.restoration_by || null,
        status: 'active',
        images: images, // Keep images in Supabase storage
      }

      if (brand_code) {
        // Resolve brand id
        const { data: b } = await supabaseAdmin.from('brands').select('id').eq('code', String(brand_code).toUpperCase()).single()
        if (b?.id) record.brand_id = b.id
      }

      if (clientId) {
        record.vendor_id = clientId
      }

      if (consignmentId) {
        record.consignment_id = consignmentId
      }

      const { data: created, error: insertErr } = await supabaseAdmin
  .from('items')
  .insert(record)
  .select('id')
  .single()

if (insertErr) {
  console.error('ITEM INSERT FAILED:', insertErr, record)
  continue
}

console.log('ITEM INSERTED:', created?.id)
createdItemIds.push(created.id)
    }

    // Note: Keep temp files in storage as they're now permanent artwork images
    // No need to delete them from storage

    // Update pending record status
    const { error: updateError } = await supabaseAdmin
      .from('pending_items')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', id)
    if (updateError) {
      console.error("Pending update failed:", updateError)
    }
    res.json({
      success: true,
      created_count: createdItemIds.length,
      item_ids: createdItemIds,
      client_id: clientId,
      consignment_id: consignmentId
    })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

// POST /api/pending-items/:id/reject
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params
    const { data: pending, error } = await supabaseAdmin
      .from('pending_items')
      .select('*')
      .eq('id', id)
      .single()

      console.log('📦 Pending fetch result:', pending)
      console.log('❌ Pending fetch error:', error)
    if (error || !pending) return res.status(404).json({ error: 'Pending submission not found' })

    // Clean up temp files from storage when rejecting
    const tempPaths: string[] = Array.isArray(pending.temp_storage_paths) ? pending.temp_storage_paths : []
    if (tempPaths.length > 0) {
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove(tempPaths)
    }

    await supabaseAdmin
      .from('pending_items')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', id)

    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

export default router

