// backend/src/routes/campaigns.ts
import express, { Request, Response } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabaseAdmin } from '../utils/supabase'

// Lazy import to avoid requiring during test if not installed yet
let nodemailer: any
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  nodemailer = require('nodemailer')
} catch {}

interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string }
}

type Audience = 'buyers' | 'sellers' | 'all'

const router = express.Router()
router.use(authMiddleware)

async function resolveBrandId(brandCode?: string): Promise<string | undefined> {
  if (!brandCode) return undefined
  const { data, error } = await supabaseAdmin
    .from('brands')
    .select('id')
    .eq('code', brandCode.toUpperCase())
    .single()
  if (error || !data) return undefined
  return data.id
}

async function getPlatformCredential(brandId: string, platform: string) {
  const { data, error } = await supabaseAdmin
    .from('platform_credentials')
    .select('*')
    .eq('brand_id', brandId)
    .eq('platform', platform)
    .single()
  if (error) return null
  return data
}

function extractInstagramUsername(instagramUrl?: string): string | undefined {
  if (!instagramUrl) return undefined
  try {
    const url = new URL(instagramUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    return parts[0]
  } catch {
    // fallback if raw username
    return instagramUrl.replace(/^@/, '')
  }
}

// POST /api/campaigns/email
// body: { brand_code, audience: 'buyers'|'sellers'|'all', auction_id?, auction_link?, subject, html?, text? }
router.post('/email', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const { brand_code, audience, auction_id, auction_link, subject, html, text } = req.body as {
      brand_code?: string
      audience: Audience
      auction_id?: string
      auction_link?: string
      subject: string
      html?: string
      text?: string
    }

    if (!subject) return res.status(400).json({ error: 'subject is required' })
    const brandId = (await resolveBrandId(brand_code)) as string | undefined

    // Load SMTP credentials
    if (!nodemailer) {
      return res.status(500).json({ error: 'Email service not available: nodemailer not installed' })
    }

    if (!brandId) return res.status(400).json({ error: 'Invalid brand_code' })
    const smtpCred = await getPlatformCredential(brandId, 'email_smtp')
    if (!smtpCred?.additional || !smtpCred?.key_id || !smtpCred?.secret_value) {
      return res.status(400).json({ error: 'SMTP credentials not configured for brand' })
    }
    const smtpCfg = smtpCred.additional || {}
    const transporter = nodemailer.createTransport({
      host: smtpCfg.host,
      port: smtpCfg.port || 587,
      secure: !!smtpCfg.secure,
      auth: { user: smtpCred.key_id, pass: smtpCred.secret_value }
    })

    // Audience filter
    let clientFilter = supabaseAdmin.from('clients').select('*').eq('status', 'active')
    if (audience === 'buyers') clientFilter = clientFilter.or('client_type.eq.buyer,client_type.eq.buyer_vendor')
    if (audience === 'sellers') clientFilter = clientFilter.or('client_type.eq.vendor,client_type.eq.buyer_vendor')
    const { data: clients, error: clientsErr } = await clientFilter
    if (clientsErr) return res.status(500).json({ error: 'Failed to load clients' })

    const frontendBase = process.env.FRONTEND_BASE_URL || 'http://localhost:3000'
    const auctionUrl = auction_link || (auction_id ? `${frontendBase}/preview/${auction_id}` : `${frontendBase}/auctions`)

    let sent = 0
    let failed = 0
    for (const client of clients || []) {
      if (!client.email) continue
      const mailOptions = {
        from: smtpCfg.from || smtpCred.key_id,
        to: client.email,
        subject,
        text: text || `We invite you to our auction. View here: ${auctionUrl}`,
        html:
          html ||
          `<p>Hello ${client.first_name || ''},</p><p>We invite you to our auction.</p><p><a href="${auctionUrl}">View Auction</a></p>`
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await transporter.sendMail(mailOptions)
        sent++
      } catch (err) {
        failed++
      }
    }

    // Log campaign
    await supabaseAdmin.from('campaign_logs').insert([
      {
        brand_id: brandId,
        type: 'email',
        auction_ref: auction_id || null,
        recipient_group: audience,
        payload: { subject, auctionUrl },
        stats: { sent, failed },
      }
    ])

    res.json({ success: true, sent, failed })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

// POST /api/campaigns/email/test - send a single test email
router.post('/email/test', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const { brand_code, to, subject = '[Test] Msaber Email', html, text } = req.body as {
      brand_code: string
      to: string
      subject?: string
      html?: string
      text?: string
    }
    if (!to) return res.status(400).json({ error: 'to is required' })
    const brandId = (await resolveBrandId(brand_code)) as string | undefined
    if (!brandId) return res.status(400).json({ error: 'Invalid brand_code' })
    if (!nodemailer) return res.status(500).json({ error: 'Email service not available' })
    const smtpCred = await getPlatformCredential(brandId, 'email_smtp')
    if (!smtpCred?.additional || !smtpCred?.key_id || !smtpCred?.secret_value) {
      return res.status(400).json({ error: 'SMTP credentials not configured for brand' })
    }
    const smtpCfg = smtpCred.additional || {}
    const transporter = nodemailer.createTransport({ host: smtpCfg.host, port: smtpCfg.port || 587, secure: !!smtpCfg.secure, auth: { user: smtpCred.key_id, pass: smtpCred.secret_value } })
    await transporter.sendMail({ from: smtpCfg.from || smtpCred.key_id, to, subject, text: text || 'Test email', html })
    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

// POST /api/campaigns/instagram/feed/preview - return candidate image URLs (no publish)
router.post('/instagram/feed/preview', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const { brand_code, auction_id, num_images = 10 } = req.body as { brand_code: string; auction_id?: string; num_images?: number }
    const brandId = await resolveBrandId(brand_code)
    if (!brandId) return res.status(400).json({ error: 'Invalid brand_code' })
    let itemsQuery = supabaseAdmin.from('items').select('*').eq('status', 'active')
    if (auction_id) itemsQuery = itemsQuery.eq('auction_id', auction_id)
    const { data: items, error: itemsErr } = await itemsQuery.limit(200)
    if (itemsErr) return res.status(500).json({ error: 'Failed to load items' })
    const imageUrls: string[] = []
    for (const item of items || []) {
      // Check for new images array format
      if (item.images && Array.isArray(item.images)) {
        imageUrls.push(...item.images.filter((url: string) => url && url.trim()))
      } else {
        // Fallback to old image_file format
        for (let i = 1; i <= 10; i++) {
          const url = (item as any)[`image_file_${i}`]
          if (url) imageUrls.push(url)
        }
      }
    }
    imageUrls.sort(() => 0.5 - Math.random())
    const selected = imageUrls.slice(0, Math.min(num_images, 10))
    res.json({ success: true, images: selected })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

// POST /api/campaigns/instagram/feed
// body: { brand_code, auction_id?, caption?, num_images? }
router.post('/instagram/feed', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const { brand_code, auction_id, caption, num_images = 10 } = req.body as {
      brand_code: string
      auction_id?: string
      caption?: string
      num_images?: number
    }

    const brandId = await resolveBrandId(brand_code)
    if (!brandId) return res.status(400).json({ error: 'Invalid brand_code' })
    const igCred = await getPlatformCredential(brandId, 'instagram')
    if (!igCred?.key_id || !igCred?.secret_value) {
      return res.status(400).json({ error: 'Instagram credentials not configured for brand' })
    }
    const igUserId = igCred.key_id // store ig_user_id in key_id
    const accessToken = igCred.secret_value // long-lived token

    // Fetch candidate images
    let itemsQuery = supabaseAdmin.from('items').select('*').eq('status', 'active')
    if (auction_id) itemsQuery = itemsQuery.eq('auction_id', auction_id)
    const { data: items, error: itemsErr } = await itemsQuery.limit(200)
    if (itemsErr) return res.status(500).json({ error: 'Failed to load items' })

    const imageUrls: string[] = []
    for (const item of items || []) {
      // Check for new images array format
      if (item.images && Array.isArray(item.images)) {
        imageUrls.push(...item.images.filter((url: string) => url && url.trim()))
      } else {
        // Fallback to old image_file format
        for (let i = 1; i <= 10; i++) {
          const url = item[`image_file_${i}`]
          if (url) imageUrls.push(url)
        }
      }
    }
    if (imageUrls.length === 0) return res.status(400).json({ error: 'No images available' })

    // Shuffle and pick
    imageUrls.sort(() => 0.5 - Math.random())
    const selected = imageUrls.slice(0, Math.min(num_images, 10))

    // Create children containers
    const childrenIds: string[] = []
    for (const url of selected) {
      const params = new URLSearchParams()
      params.append('image_url', url)
      params.append('is_carousel_item', 'true')
      // eslint-disable-next-line no-await-in-loop
      const resp = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      })
      // eslint-disable-next-line no-await-in-loop
      const json: any = await resp.json()
      if (!resp.ok || !json.id) {
        return res.status(400).json({ error: 'Failed to create media', details: json })
      }
      childrenIds.push(json.id)
    }

    // Create carousel
    const parentParams = new URLSearchParams()
    parentParams.append('media_type', 'CAROUSEL')
    parentParams.append('children', JSON.stringify(childrenIds))
    if (caption) parentParams.append('caption', caption)
    const parentResp = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: parentParams
    })
    const parentJson: any = await parentResp.json()
    if (!parentResp.ok || !parentJson.id) {
      return res.status(400).json({ error: 'Failed to create carousel container', details: parentJson })
    }

    // Publish
    const publishParams = new URLSearchParams()
    publishParams.append('creation_id', parentJson.id)
    const publishResp = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media_publish?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: publishParams
    })
    const publishJson: any = await publishResp.json()
    if (!publishResp.ok) {
      return res.status(400).json({ error: 'Failed to publish carousel', details: publishJson })
    }

    // Log
    await supabaseAdmin.from('campaign_logs').insert([
      {
        brand_id: brandId,
        type: 'instagram_feed',
        auction_ref: auction_id || null,
        recipient_group: null,
        payload: { caption, images: selected },
        stats: { published: true },
      }
    ])

    res.json({ success: true, media_id: publishJson.id })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

// POST /api/campaigns/instagram/dm/queue
// body: { brand_code, audience: 'buyers'|'sellers'|'all', auction_id, message_template }
router.post('/instagram/dm/queue', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const { brand_code, audience, auction_id, message_template } = req.body as {
      brand_code: string
      audience: Audience
      auction_id?: string
      message_template: string
    }
    const brandId = await resolveBrandId(brand_code)
    if (!brandId) return res.status(400).json({ error: 'Invalid brand_code' })

    // Target clients by audience and with instagram_url
    let clientQ = supabaseAdmin.from('clients').select('*').not('instagram_url', 'is', null).neq('instagram_url', '')
    if (audience === 'buyers') clientQ = clientQ.or('client_type.eq.buyer,client_type.eq.buyer_vendor')
    if (audience === 'sellers') clientQ = clientQ.or('client_type.eq.vendor,client_type.eq.buyer_vendor')
    const { data: clients, error: clientsErr } = await clientQ
    if (clientsErr) return res.status(500).json({ error: 'Failed to load clients' })

    const frontendBase = process.env.FRONTEND_BASE_URL || 'http://localhost:3000'
    const auctionUrl = auction_id ? `${frontendBase}/preview/${auction_id}` : `${frontendBase}/auctions`

    const rows = (clients || []).map((c: any) => ({
      brand_id: brandId,
      auction_ref: auction_id || null,
      client_id: c.id,
      instagram_username: extractInstagramUsername(c.instagram_url),
      message: (message_template || '').split('{first_name}').join(c.first_name || '').split('{auction_link}').join(auctionUrl)
    }))

    const { error: insErr } = await supabaseAdmin.from('instagram_message_queue').insert(rows)
    if (insErr) return res.status(500).json({ error: 'Failed to enqueue messages' })

    await supabaseAdmin.from('campaign_logs').insert([
      { brand_id: brandId, type: 'instagram_dm', auction_ref: auction_id || null, payload: { audience, count: rows.length } }
    ])

    res.json({ success: true, queued: rows.length })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

// POST /api/campaigns/instagram/dm/send
// body: { brand_code, batch_size? }
router.post('/instagram/dm/send', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const { brand_code, batch_size = 50 } = req.body as { brand_code: string; batch_size?: number }
    const brandId = await resolveBrandId(brand_code)
    if (!brandId) return res.status(400).json({ error: 'Invalid brand_code' })

    const igCred = await getPlatformCredential(brandId, 'instagram')
    if (!igCred?.key_id || !igCred?.secret_value) {
      return res.status(400).json({ error: 'Instagram credentials not configured for brand' })
    }
    const igUserId = igCred.key_id
    const accessToken = igCred.secret_value

    const { data: queued, error: qErr } = await supabaseAdmin
      .from('instagram_message_queue')
      .select('*')
      .eq('brand_id', brandId)
      .eq('status', 'queued')
      .not('instagram_user_id', 'is', null)
      .limit(batch_size)

    if (qErr) return res.status(500).json({ error: 'Failed to load queue' })

    let sent = 0
    let failed = 0
    for (const msg of queued || []) {
      const body = {
        recipient: { id: msg.instagram_user_id },
        message: { text: msg.message }
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const resp = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/messages?access_token=${encodeURIComponent(accessToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        // eslint-disable-next-line no-await-in-loop
        const j: any = await resp.json()
        if (resp.ok) {
          // eslint-disable-next-line no-await-in-loop
          await supabaseAdmin
            .from('instagram_message_queue')
            .update({ status: 'sent', sent_at: new Date().toISOString() })
            .eq('id', msg.id)
          sent++
        } else {
          // eslint-disable-next-line no-await-in-loop
          await supabaseAdmin
            .from('instagram_message_queue')
            .update({ status: 'failed', error: JSON.stringify(j) })
            .eq('id', msg.id)
          failed++
        }
      } catch (err: any) {
        // eslint-disable-next-line no-await-in-loop
        await supabaseAdmin
          .from('instagram_message_queue')
          .update({ status: 'failed', error: err?.message || 'unknown' })
          .eq('id', msg.id)
        failed++
      }
    }

    await supabaseAdmin.from('campaign_logs').insert([
      { brand_id: brandId, type: 'instagram_dm', payload: { processed: (queued || []).length, sent, failed }, }
    ])

    res.json({ success: true, processed: (queued || []).length, sent, failed })
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error', details: e.message })
  }
})

export default router


