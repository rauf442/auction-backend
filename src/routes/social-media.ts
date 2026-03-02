// backend/src/routes/social-media.ts
import express, { Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';
import { EmailCore } from '../utils/email-core';

const router = express.Router();
router.use(authMiddleware);

interface AuthRequest extends express.Request {
  user?: { id: string; email: string; role: string };
}

// Get all email campaigns
router.get('/email-campaigns', async (req: AuthRequest, res: Response) => {
  try {
    // First get campaigns
    const { data: campaigns, error: campaignsError } = await supabaseAdmin
      .from('email_campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (campaignsError) throw campaignsError;

    // Get unique brand IDs
    const brandIds = [...new Set(campaigns?.map(c => c.brand_id).filter(Boolean))];
    
    // Fetch brands separately
    let brandsMap = new Map();
    if (brandIds.length > 0) {
      const { data: brands, error: brandsError } = await supabaseAdmin
        .from('brands')
        .select('id, name, brand_code')
        .in('id', brandIds);
      
      if (!brandsError && brands) {
        brands.forEach(b => brandsMap.set(b.id, b));
      }
    }

    // Get recipient counts
    const campaignIds = campaigns?.map(c => c.id) || [];
    let recipientCounts = new Map();
    
    if (campaignIds.length > 0) {
      const { data: counts, error: countsError } = await supabaseAdmin
        .from('email_campaign_recipients')
        .select('campaign_id', { count: 'exact' })
        .in('campaign_id', campaignIds);
      
      // Note: This is simplified, you might need to adjust based on your exact needs
    }

    // Merge campaigns with brands
    const campaignsWithBrands = campaigns?.map(campaign => ({
      ...campaign,
      brand: brandsMap.get(campaign.brand_id) || null
    }));

    res.json(campaignsWithBrands || []);
  } catch (error: any) {
    console.error('Error fetching email campaigns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single email campaign with recipients
router.get('/email-campaigns/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from('email_campaigns')
      .select(`
        *,
        brand:brands(id, name, brand_code)
      `)
      .eq('id', id)
      .single();

    if (campaignError) throw campaignError;
    
    const { data: recipients, error: recipientsError } = await supabaseAdmin
      .from('email_campaign_recipients')
      .select('*')
      .eq('campaign_id', id)
      .order('created_at', { ascending: false });

    if (recipientsError) throw recipientsError;

    res.json({ ...campaign, recipients });
  } catch (error: any) {
    console.error('Error fetching email campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create email campaign
router.post('/email-campaigns', async (req: AuthRequest, res: Response) => {
  try {
    const { 
      brand_id, 
      name, 
      subject, 
      html_content, 
      audience_type,
      audience_filter 
    } = req.body;

    if (!name || !subject || !html_content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { data, error } = await supabaseAdmin
      .from('email_campaigns')
      .insert({
        brand_id,
        name,
        subject,
        html_content,
        audience_type: audience_type || 'all',
        audience_filter,
        status: 'draft',
        created_by: req.user?.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error creating email campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update email campaign
router.put('/email-campaigns/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    delete updateData.id;
    delete updateData.created_at;
    delete updateData.created_by;
    
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('email_campaigns')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error updating email campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete email campaign
router.delete('/email-campaigns/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabaseAdmin
      .from('email_campaigns')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting email campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// Preview campaign - get recipient count
router.post('/email-campaigns/preview', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_id, audience_type, audience_filter } = req.body;

    let query = supabaseAdmin
      .from('clients')
      .select('id, first_name, last_name, email, client_type', { count: 'exact' })
      .eq('status', 'active')
      .not('email', 'is', null);

    if (brand_id) {
      query = query.eq('brand_id', brand_id);
    }

    if (audience_type === 'buyers') {
      query = query.or('client_type.eq.buyer,client_type.eq.buyer_vendor');
    } else if (audience_type === 'sellers') {
      query = query.or('client_type.eq.vendor,client_type.eq.buyer_vendor');
    }

    const { data, count, error } = await query.limit(100);

    if (error) throw error;

    res.json({ 
      total_count: count,
      preview_recipients: data,
      message: count && count > 100 ? `Showing first 100 of ${count} recipients` : ''
    });
  } catch (error: any) {
    console.error('Error previewing campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send email campaign
router.post('/email-campaigns/:id/send', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { test_email } = req.body;

    // Get campaign details
    const { data: campaign, error: campaignError } = await supabaseAdmin
      .from('email_campaigns')
      .select('*, brand:brands(*)')
      .eq('id', id)
      .single();

    if (campaignError) throw campaignError;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // If test email, send only to that address
    if (test_email) {
      const success = await EmailCore.sendEmail({
        to: test_email,
        subject: `[TEST] ${campaign.subject}`,
        html: campaign.html_content,
        from: process.env.DEFAULT_FROM_EMAIL || undefined,
      });

      return res.json({ 
        success,
        message: success ? 'Test email sent successfully' : 'Failed to send test email'
      });
    }

    // Get recipients based on audience
    let recipientsQuery = supabaseAdmin
      .from('clients')
      .select('id, first_name, last_name, email')
      .eq('status', 'active')
      .not('email', 'is', null);

    if (campaign.brand_id) {
      recipientsQuery = recipientsQuery.eq('brand_id', campaign.brand_id);
    }

    if (campaign.audience_type === 'buyers') {
      recipientsQuery = recipientsQuery.or('client_type.eq.buyer,client_type.eq.buyer_vendor');
    } else if (campaign.audience_type === 'sellers') {
      recipientsQuery = recipientsQuery.or('client_type.eq.vendor,client_type.eq.buyer_vendor');
    }

    const { data: recipients, error: recipientsError } = await recipientsQuery;
    if (recipientsError) throw recipientsError;

    // Create recipient records
    const recipientRecords = recipients.map((client: any) => ({
      campaign_id: parseInt(id),
      client_id: client.id,
      recipient_email: client.email,
      recipient_name: `${client.first_name || ''} ${client.last_name || ''}`.trim(),
      status: 'pending',
    }));

    const { error: insertError } = await supabaseAdmin
      .from('email_campaign_recipients')
      .insert(recipientRecords);

    if (insertError) throw insertError;

    // Update campaign status
    await supabaseAdmin
      .from('email_campaigns')
      .update({ 
        status: 'sending',
        total_recipients: recipients.length,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    // Send emails asynchronously (in background)
    setImmediate(async () => {
      let successCount = 0;
      let failureCount = 0;

      for (const recipient of recipients) {
        try {
          const success = await EmailCore.sendEmail({
            to: recipient.email,
            subject: campaign.subject,
            html: campaign.html_content,
            from: process.env.DEFAULT_FROM_EMAIL || undefined,
          });

          if (success) {
            successCount++;
            await supabaseAdmin
              .from('email_campaign_recipients')
              .update({ status: 'sent', sent_at: new Date().toISOString() })
              .eq('campaign_id', id)
              .eq('recipient_email', recipient.email);
          } else {
            failureCount++;
            await supabaseAdmin
              .from('email_campaign_recipients')
              .update({ status: 'failed', error_message: 'Failed to send' })
              .eq('campaign_id', id)
              .eq('recipient_email', recipient.email);
          }
        } catch (error: any) {
          failureCount++;
          await supabaseAdmin
            .from('email_campaign_recipients')
            .update({ status: 'failed', error_message: error.message })
            .eq('campaign_id', id)
            .eq('recipient_email', recipient.email);
        }
      }

      // Update campaign with final results
      await supabaseAdmin
        .from('email_campaigns')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          successful_sends: successCount,
          failed_sends: failureCount,
          updated_at: new Date().toISOString()
        })
        .eq('id', id);
    });

    res.json({ 
      success: true,
      message: `Campaign is being sent to ${recipients.length} recipients`,
      total_recipients: recipients.length
    });
  } catch (error: any) {
    console.error('Error sending email campaign:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Instagram Management ====================

// Get all Instagram posts
router.get('/instagram/posts', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_id } = req.query;
    
    let query = supabaseAdmin
      .from('instagram_posts')
      .select(`*`)
      .order('created_at', { ascending: false });

    if (brand_id) {
      query = query.eq('brand_id', brand_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    console.error('Error fetching Instagram posts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single Instagram post
router.get('/instagram/posts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabaseAdmin
      .from('instagram_posts')
      .select(`
        *,
        brand:brands(id, name, brand_code)
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching Instagram post:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create Instagram post
router.post('/instagram/posts', async (req: AuthRequest, res: Response) => {
  try {
    const {
      brand_id,
      media_type,
      media_url,
      caption,
      scheduled_at
    } = req.body;

    if (!media_url || !caption) {
      return res.status(400).json({ error: 'Media URL and caption are required' });
    }

    const { data, error } = await supabaseAdmin
      .from('instagram_posts')
      .insert({
        brand_id,
        media_type: media_type || 'IMAGE',
        media_url,
        caption,
        status: scheduled_at ? 'scheduled' : 'draft',
        scheduled_at,
        created_by: req.user?.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error creating Instagram post:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update Instagram post
router.put('/instagram/posts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    delete updateData.id;
    delete updateData.created_at;
    delete updateData.created_by;
    
    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('instagram_posts')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error updating Instagram post:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete Instagram post
router.delete('/instagram/posts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabaseAdmin
      .from('instagram_posts')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting Instagram post:', error);
    res.status(500).json({ error: error.message });
  }
});

// Publish Instagram post
router.post('/instagram/posts/:id/publish', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { data: post, error: postError } = await supabaseAdmin
      .from('instagram_posts')
      .select('*, brand:brands(*)')
      .eq('id', id)
      .single();

    if (postError) throw postError;
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const { data: credentials, error: credError } = await supabaseAdmin
      .from('instagram_credentials')
      .select('*')
      .eq('brand_id', post.brand_id)
      .single();

    if (credError || !credentials) {
      return res.status(400).json({ 
        error: 'Instagram credentials not configured for this brand' 
      });
    }

    if (credentials.token_expires_at && new Date(credentials.token_expires_at) < new Date()) {
      return res.status(400).json({ 
        error: 'Instagram access token has expired. Please reconnect your account.' 
      });
    }

    try {
      let containerResponse;
      
      if (post.media_type === 'VIDEO') {
        containerResponse = await fetch(
          `https://graph.facebook.com/v18.0/${credentials.instagram_business_account_id}/media`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              media_type: 'VIDEO',
              video_url: post.media_url,
              caption: post.caption,
              access_token: credentials.access_token,
            }),
          }
        );
      } else {
        containerResponse = await fetch(
          `https://graph.facebook.com/v18.0/${credentials.instagram_business_account_id}/media`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image_url: post.media_url,
              caption: post.caption,
              access_token: credentials.access_token,
            }),
          }
        );
      }

      const containerData = await containerResponse.json() as any;
      
      if (!containerResponse.ok || containerData.error) {
        throw new Error(containerData.error?.message || 'Failed to create media container');
      }

      const creationId = containerData.id;

      if (post.media_type === 'VIDEO') {
        let isReady = false;
        let attempts = 0;
        const maxAttempts = 60;

        while (!isReady && attempts < maxAttempts) {
          const statusResponse = await fetch(
            `https://graph.facebook.com/v18.0/${creationId}?fields=status_code&access_token=${credentials.access_token}`
          );
          const statusData = await statusResponse.json() as any;
          
          if (statusData.status_code === 'FINISHED') {
            isReady = true;
          } else if (statusData.status_code === 'ERROR') {
            throw new Error('Video processing failed');
          }
          
          if (!isReady) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
          }
        }

        if (!isReady) {
          throw new Error('Video processing timeout');
        }
      }

      const publishResponse = await fetch(
        `https://graph.facebook.com/v18.0/${credentials.instagram_business_account_id}/media_publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creation_id: creationId,
            access_token: credentials.access_token,
          }),
        }
      );

      const publishData = await publishResponse.json() as any;
      
      if (!publishResponse.ok || publishData.error) {
        throw new Error(publishData.error?.message || 'Failed to publish post');
      }

      const { data: updatedPost, error: updateError } = await supabaseAdmin
        .from('instagram_posts')
        .update({
          status: 'published',
          instagram_post_id: publishData.id,
          published_at: new Date().toISOString(),
          error_message: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;

      res.json({ success: true, post: updatedPost });
    } catch (apiError: any) {
      await supabaseAdmin
        .from('instagram_posts')
        .update({
          status: 'failed',
          error_message: apiError.message,
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      throw apiError;
    }
  } catch (error: any) {
    console.error('Error publishing Instagram post:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Instagram DMs
router.get('/instagram/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_id } = req.query;
    
    let query = supabaseAdmin
      .from('instagram_message_queue')
      .select(`
        *,
        brand:brands(id, name, brand_code),
        client:clients(id, first_name, last_name, email)
      `)
      .order('created_at', { ascending: false });

    if (brand_id) {
      query = query.eq('brand_id', brand_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    console.error('Error fetching Instagram messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send Instagram DM (legacy queue endpoint)
router.post('/instagram/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_id, instagram_username, message } = req.body;

    if (!brand_id || !instagram_username || !message) {
      return res.status(400).json({ 
        error: 'Brand ID, Instagram username, and message are required' 
      });
    }

    const { data: credentials, error: credError } = await supabaseAdmin
      .from('instagram_credentials')
      .select('*')
      .eq('brand_id', brand_id)
      .single();

    if (credError || !credentials) {
      return res.status(400).json({ 
        error: 'Instagram credentials not configured for this brand' 
      });
    }

    const { data, error } = await supabaseAdmin
      .from('instagram_message_queue')
      .insert({
        brand_id,
        instagram_username,
        message,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      success: true,
      data,
      message: 'Message queued. Instagram DM API requires special permissions.'
    });
  } catch (error: any) {
    console.error('Error sending Instagram message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Instagram credentials
router.get('/instagram/credentials/:brand_id', async (req: AuthRequest, res: Response) => {
  try {
    const { brand_id } = req.params;
    
    const { data, error } = await supabaseAdmin
      .from('instagram_credentials')
      .select('id, brand_id, instagram_business_account_id, instagram_username, token_expires_at, created_at, updated_at')
      .eq('brand_id', brand_id)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    res.json(data || null);
  } catch (error: any) {
    console.error('Error fetching Instagram credentials:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save Instagram credentials
router.post('/instagram/credentials', async (req: AuthRequest, res: Response) => {
  try {
    const { 
      brand_id, 
      instagram_business_account_id, 
      instagram_username,
      access_token,
      token_expires_at
    } = req.body;

    if (!brand_id || !instagram_business_account_id || !access_token) {
      return res.status(400).json({ 
        error: 'Brand ID, Instagram business account ID, and access token are required' 
      });
    }

    const { data, error } = await supabaseAdmin
      .from('instagram_credentials')
      .upsert({
        brand_id,
        instagram_business_account_id,
        instagram_username,
        access_token,
        token_expires_at,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'brand_id'
      })
      .select('id, brand_id, instagram_business_account_id, instagram_username, token_expires_at, created_at, updated_at')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('Error saving Instagram credentials:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Instagram Share Auction ====================
// These routes power the "Share Auction" button in the Instagram Posts tab.
// They use the same instagram_credentials already stored per brand.
//
// Endpoints:
//   POST /api/social-media/instagram/share-auction
//   GET  /api/social-media/instagram/share-auction/conversations

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Helper: build auction message text
async function buildAuctionMessage(auction: any, accessToken: string): Promise<string> {
  // Fetch first artwork image
  let imageUrl = auction.title_image_url || null;
  
  if (!imageUrl && auction.artwork_ids?.length > 0) {
    const { data: artwork } = await supabaseAdmin
      .from('artworks')
      .select('images, image_file_1')
      .eq('id', auction.artwork_ids[0])
      .single();
    
    if (artwork) {
      imageUrl = artwork.images?.[0] || artwork.image_file_1 || null;
    }
  }

  // Get auction URL
  const auctionUrl = auction.liveauctioneers_url || 
                     auction.easy_live_url || 
                     auction.invaluable_url || 
                     auction.the_saleroom_url || null;

  const fmt = (n?: number) =>
    n ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n) : null;
  const fmtDate = (d?: string) =>
    d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

  const lotCount = auction.artwork_ids?.length ?? 0;

  const lines = [
    `🔨 ${auction.short_name}`,
    auction.long_name !== auction.short_name ? `📋 ${auction.long_name}` : null,
    ``,
    auction.description ? `${auction.description}` : null,
    ``,
    lotCount > 0 ? `📦 ${lotCount} lots available` : null,
    fmtDate(auction.catalogue_launch_date) ? `📅 Catalogue Launch: ${fmtDate(auction.catalogue_launch_date)}` : null,
    fmtDate(auction.settlement_date) ? `⏰ Settlement: ${fmtDate(auction.settlement_date)}` : null,
    (auction.total_estimate_low || auction.total_estimate_high)
      ? `💰 Estimate: ${fmt(auction.total_estimate_low) || '?'} – ${fmt(auction.total_estimate_high) || '?'}`
      : null,
    ``,
    auctionUrl ? `🔗 View Auction: ${auctionUrl}` : null,
    imageUrl ? `🖼 Featured Lot: ${imageUrl}` : null,
    ``,
    `#auction #art #bidding #${auction.type || 'auction'}`,
  ];

  return lines.filter((l) => l !== null).join('\n');
}

// Helper: resolve username to IGSID by searching existing conversations
// NOTE: The recipient MUST have previously messaged your IG business account.
async function resolveUsernameToIGSID(
  username: string,
  igAccountId: string,
  accessToken: string
): Promise<{ igsid: string | null; error: string | null }> {
  const cleanUsername = username.replace(/^@/, '').trim();
  console.log(`[ShareAuction] Resolving username "${cleanUsername}" for account ${igAccountId}`);

  const url = `${GRAPH_BASE}/${igAccountId}/conversations?platform=instagram&fields=participants,id&access_token=${accessToken}`;

  const resp = await fetch(url);
  const json = await resp.json() as any;

  if (!resp.ok || json.error) {
    const errMsg = json.error?.message || `HTTP ${resp.status}`;
    const errCode = json.error?.code;
    console.error(`[ShareAuction] Conversations fetch failed. Code: ${errCode}, Msg: ${errMsg}`);

    // Decode common error codes for clear frontend messages
    if (errCode === 10 || errCode === 200) {
      return { igsid: null, error: `Missing instagram_manage_messages permission. Your Meta app needs Advanced Access approval to send DMs. In development mode, add test users at developers.facebook.com → Your App → Roles.` };
    }
    if (errCode === 190) {
      return { igsid: null, error: `Access token expired. Please go to Configure Credentials and re-enter your Instagram access token.` };
    }
    return { igsid: null, error: `Could not fetch conversations: ${errMsg}` };
  }

  const conversations: any[] = json.data || [];
  console.log(`[ShareAuction] Found ${conversations.length} conversations to search through`);

  for (const convo of conversations) {
    const participants: any[] = convo.participants?.data || [];
    for (const p of participants) {
      if (p.username?.toLowerCase() === cleanUsername.toLowerCase()) {
        console.log(`[ShareAuction] ✅ Matched "${cleanUsername}" → IGSID: ${p.id}`);
        return { igsid: p.id, error: null };
      }
    }
  }

  console.warn(`[ShareAuction] ❌ Username "${cleanUsername}" not found in any conversation`);
  return {
    igsid: null,
    error: `User "@${cleanUsername}" has not messaged your Instagram business account yet. They must send your account a message first before you can DM them (Instagram API rule).`
  };
}

// Helper: extract username from profile URL then resolve
async function resolveProfileUrlToIGSID(
  profileUrl: string,
  igAccountId: string,
  accessToken: string
): Promise<{ igsid: string | null; error: string | null }> {
  const match = profileUrl.match(/instagram\.com\/([^/?#]+)/i);
  if (!match) {
    return { igsid: null, error: 'Invalid Instagram profile URL. Expected format: https://instagram.com/username' };
  }
  const username = match[1];
  console.log(`[ShareAuction] Extracted username "${username}" from URL`);
  return resolveUsernameToIGSID(username, igAccountId, accessToken);
}

// Helper: send the actual DM via Graph API
async function sendInstagramDM(
  igAccountId: string,
  accessToken: string,
  recipientIGSID: string,
  message: string
): Promise<{ messageId: string | null; error: string | null }> {
  console.log(`[ShareAuction] Sending DM to IGSID ${recipientIGSID}`);

  const resp = await fetch(`${GRAPH_BASE}/${igAccountId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientIGSID },
      message: { text: message },
    }),
  });

  const json = await resp.json() as any;
  console.log(`[ShareAuction] Graph API DM response (${resp.status}):`, JSON.stringify(json));

  if (!resp.ok || json.error) {
    const errCode = json.error?.code;
    const errMsg = json.error?.message || `HTTP ${resp.status}`;
    console.error(`[ShareAuction] DM send failed. Code: ${errCode}, Msg: ${errMsg}`);

    let friendlyError = errMsg;
    if (errCode === 10 || errCode === 200) {
      friendlyError = 'Missing instagram_manage_messages permission. Needs Meta App Review for production use.';
    } else if (errCode === 190) {
      friendlyError = 'Access token expired. Please reconfigure credentials.';
    } else if (errCode === 100) {
      friendlyError = 'Invalid recipient. The user IGSID may be wrong or the user cannot receive messages.';
    } else if (errCode === 551) {
      friendlyError = 'This user cannot receive messages from your account. They may be outside the 24-hour messaging window — they need to message your account again.';
    }

    return { messageId: null, error: friendlyError };
  }

  const messageId = json.message_id || json.id;
  console.log(`[ShareAuction] ✅ DM sent. Message ID: ${messageId}`);
  return { messageId, error: null };
}

// POST /api/social-media/instagram/share-auction
// Sends an auction as an Instagram DM to a recipient
router.post('/instagram/share-auction', async (req: AuthRequest, res: Response) => {
  const { auction_id, recipient, recipient_type, brand_id } = req.body;

  console.log(`[ShareAuction] ===== REQUEST =====`);
  console.log(`[ShareAuction] auction_id=${auction_id} recipient=${recipient} type=${recipient_type} brand_id=${brand_id}`);

  if (!auction_id || !recipient || !recipient_type || !brand_id) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: auction_id, recipient, recipient_type, brand_id',
    });
  }

  if (!['username', 'url'].includes(recipient_type)) {
    return res.status(400).json({ success: false, error: 'recipient_type must be "username" or "url"' });
  }

  try {
    // Step 1: Fetch auction
    console.log(`[ShareAuction] Step 1: Fetching auction ${auction_id}`);
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
     .select('id, short_name, long_name, type, description, settlement_date, catalogue_launch_date, total_estimate_low, total_estimate_high, artwork_ids, title_image_url, liveauctioneers_url, easy_live_url, invaluable_url, the_saleroom_url')
      .eq('id', auction_id)
      .single();

    if (auctionError || !auction) {
      console.error(`[ShareAuction] Auction not found:`, auctionError?.message);
      return res.status(404).json({ success: false, error: 'Auction not found' });
    }
    console.log(`[ShareAuction] ✅ Auction: "${auction.short_name}"`);

    // Step 2: Load credentials — uses instagram_business_account_id (matching your DB column name)
    console.log(`[ShareAuction] Step 2: Loading credentials for brand ${brand_id}`);
    const { data: credentials, error: credError } = await supabaseAdmin
      .from('instagram_credentials')
      .select('instagram_business_account_id, access_token, token_expires_at')
      .eq('brand_id', brand_id)
      .single();

    if (credError || !credentials) {
      console.error(`[ShareAuction] No credentials found:`, credError?.message);
      return res.status(400).json({
        success: false,
        error: 'Instagram credentials not configured for this brand. Go to "Configure Credentials" first.',
      });
    }

    const igAccountId: string = credentials.instagram_business_account_id;
    const accessToken: string = credentials.access_token;

    if (!igAccountId || !accessToken) {
      console.error(`[ShareAuction] Credentials incomplete: account_id=${igAccountId} has_token=${!!accessToken}`);
      return res.status(400).json({
        success: false,
        error: 'Incomplete credentials. Please reconfigure in "Configure Credentials".',
      });
    }

    // Check token expiry
    if (credentials.token_expires_at && new Date(credentials.token_expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Instagram access token has expired. Please go to "Configure Credentials" and update the token.',
      });
    }

    console.log(`[ShareAuction] ✅ Credentials loaded for IG account: ${igAccountId}`);

    // Step 3: Resolve recipient to IGSID
    console.log(`[ShareAuction] Step 3: Resolving recipient "${recipient}" (${recipient_type})`);
    let resolveResult: { igsid: string | null; error: string | null };

    if (recipient_type === 'username') {
      resolveResult = await resolveUsernameToIGSID(recipient, igAccountId, accessToken);
    } else {
      resolveResult = await resolveProfileUrlToIGSID(recipient, igAccountId, accessToken);
    }

    if (!resolveResult.igsid) {
      console.error(`[ShareAuction] Recipient resolve failed:`, resolveResult.error);
      return res.status(400).json({
        success: false,
        error: resolveResult.error,
        hint: 'The recipient must have previously sent a message to your Instagram business account.',
      });
    }

    // Step 4: Build and send DM
   const message = await buildAuctionMessage(auction, accessToken);
    console.log(`[ShareAuction] Step 4: Sending DM. Message length: ${message.length} chars`);

    const sendResult = await sendInstagramDM(igAccountId, accessToken, resolveResult.igsid, message);

    if (!sendResult.messageId) {
      return res.status(502).json({ success: false, error: sendResult.error });
    }

    // Step 5: Log to DB (non-fatal if table doesn't exist yet)
    try {
      await supabaseAdmin.from('instagram_share_logs').insert([{
        auction_id: Number(auction_id),
        brand_id: Number(brand_id),
        recipient,
        recipient_igsid: resolveResult.igsid,
        message_id: sendResult.messageId,
        shared_by: req.user?.id,
        created_at: new Date().toISOString(),
      }]);
      console.log(`[ShareAuction] ✅ Share logged to DB`);
    } catch (logErr) {
      console.warn(`[ShareAuction] Could not log share (instagram_share_logs table may not exist yet):`, logErr);
    }

    console.log(`[ShareAuction] ===== SUCCESS =====`);
    return res.json({
      success: true,
      message_id: sendResult.messageId,
      recipient,
      auction: auction.short_name,
    });

  } catch (err: any) {
    console.error(`[ShareAuction] Unexpected error:`, err);
    return res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
  }
});

// GET /api/social-media/instagram/share-auction/conversations
// Returns list of users who have messaged your IG account — these are valid DM targets
router.get('/instagram/share-auction/conversations', async (req: AuthRequest, res: Response) => {
  const { brand_id } = req.query;
  console.log(`[ShareAuction] Fetching conversations for brand ${brand_id}`);

  if (!brand_id) {
    return res.status(400).json({ success: false, error: 'brand_id is required' });
  }

  try {
    const { data: credentials, error: credError } = await supabaseAdmin
      .from('instagram_credentials')
      .select('instagram_business_account_id, access_token, token_expires_at')
      .eq('brand_id', brand_id)
      .single();

    if (credError || !credentials) {
      return res.status(400).json({
        success: false,
        error: 'Instagram credentials not configured for this brand. Go to "Configure Credentials" first.',
      });
    }

    const igAccountId: string = credentials.instagram_business_account_id;
    const accessToken: string = credentials.access_token;

    if (!igAccountId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Incomplete credentials. Please reconfigure.',
      });
    }

    // Check token expiry
    if (credentials.token_expires_at && new Date(credentials.token_expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Access token expired. Please update credentials.',
      });
    }

    const url = `${GRAPH_BASE}/${igAccountId}/conversations?platform=instagram&fields=participants,updated_time,id&access_token=${accessToken}`;
    console.log(`[ShareAuction] Calling Graph API conversations for account ${igAccountId}`);

    const resp = await fetch(url);
    const json = await resp.json() as any;

    if (!resp.ok || json.error) {
      const errCode = json.error?.code;
      const errMsg = json.error?.message || `HTTP ${resp.status}`;
      console.error(`[ShareAuction] Conversations API error. Code: ${errCode}, Msg: ${errMsg}`);

      let friendlyError = errMsg;
      if (errCode === 10 || errCode === 200) {
        friendlyError = 'Missing instagram_manage_messages permission. In development mode, add test users at developers.facebook.com → Your App → Roles → Test Users.';
      } else if (errCode === 190) {
        friendlyError = 'Access token expired. Please update in Configure Credentials.';
      }

      return res.status(502).json({ success: false, error: friendlyError, code: errCode });
    }

    // Filter out your own account from participant list
    const conversations = (json.data || []).map((convo: any) => ({
      conversation_id: convo.id,
      updated_time: convo.updated_time,
      participants: (convo.participants?.data || []).filter((p: any) => p.id !== igAccountId),
    }));

    console.log(`[ShareAuction] ✅ Returned ${conversations.length} conversations`);
    return res.json({ success: true, conversations, total: conversations.length });

  } catch (err: any) {
    console.error(`[ShareAuction] Error fetching conversations:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;