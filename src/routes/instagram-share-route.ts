// backend/src/routes/instagram-share.ts
// Add these routes to your existing social-media/instagram router

import express, { Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import { authMiddleware } from '../middleware/auth';

interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string };
}

const router = express.Router();
router.use(authMiddleware);

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ─── Helper: get stored credentials for a brand ──────────────────────────────
async function getInstagramCredentials(brandId: number) {
  const { data, error } = await supabaseAdmin
    .from('instagram_credentials')
    .select('*')
    .eq('brand_id', brandId)
    .single();

  if (error || !data) {
    console.error(`[InstagramShare] No credentials found for brand ${brandId}:`, error?.message);
    return null;
  }
  return data;
}

// ─── Helper: resolve a username to an IGSID ──────────────────────────────────
// This only works if the user has ALREADY messaged your IG business account.
// Instagram Graph API does NOT allow looking up arbitrary users by username.
async function resolveUsernameToIGSID(
  username: string,
  igAccountId: string,
  accessToken: string
): Promise<{ igsid: string | null; error: string | null }> {
  const cleanUsername = username.replace(/^@/, '').trim();
  console.log(`[InstagramShare] Attempting to resolve username "${cleanUsername}" to IGSID for account ${igAccountId}`);

  // Search existing conversations for this username
  const url = `${GRAPH_BASE}/${igAccountId}/conversations?platform=instagram&fields=participants,id&access_token=${accessToken}`;
  console.log(`[InstagramShare] Fetching conversations from: ${GRAPH_BASE}/${igAccountId}/conversations`);

  const resp = await fetch(url);
  const json = await resp.json() as any;

  if (!resp.ok || json.error) {
    const errMsg = json.error?.message || `HTTP ${resp.status}`;
    console.error(`[InstagramShare] Failed to fetch conversations:`, json.error || resp.statusText);
    return { igsid: null, error: `Could not fetch conversations: ${errMsg}` };
  }

  const conversations: any[] = json.data || [];
  console.log(`[InstagramShare] Found ${conversations.length} existing conversations`);

  for (const convo of conversations) {
    const participants: any[] = convo.participants?.data || [];
    for (const p of participants) {
      if (p.username?.toLowerCase() === cleanUsername.toLowerCase()) {
        console.log(`[InstagramShare] ✅ Matched username "${cleanUsername}" → IGSID: ${p.id}`);
        return { igsid: p.id, error: null };
      }
    }
  }

  console.warn(`[InstagramShare] ❌ Username "${cleanUsername}" not found in any existing conversation.`);
  return {
    igsid: null,
    error: `User "@${cleanUsername}" has not messaged your Instagram account yet. Instagram API only allows messaging users who have previously contacted your business.`
  };
}

// ─── Helper: extract IGSID from a profile URL ────────────────────────────────
async function resolveProfileUrlToIGSID(
  profileUrl: string,
  igAccountId: string,
  accessToken: string
): Promise<{ igsid: string | null; error: string | null }> {
  // Extract username from URL like https://instagram.com/johndoe
  const match = profileUrl.match(/instagram\.com\/([^/?#]+)/i);
  if (!match) {
    return { igsid: null, error: 'Invalid Instagram profile URL format. Expected: https://instagram.com/username' };
  }
  const username = match[1];
  console.log(`[InstagramShare] Extracted username "${username}" from URL: ${profileUrl}`);
  return resolveUsernameToIGSID(username, igAccountId, accessToken);
}

// ─── Helper: send DM via Graph API ───────────────────────────────────────────
async function sendInstagramDM(
  igAccountId: string,
  accessToken: string,
  recipientIGSID: string,
  message: string
): Promise<{ messageId: string | null; error: string | null }> {
  const endpoint = `${GRAPH_BASE}/${igAccountId}/messages`;
  console.log(`[InstagramShare] Sending DM to IGSID ${recipientIGSID} via ${endpoint}`);

  const payload = {
    recipient: { id: recipientIGSID },
    message: { text: message },
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await resp.json() as any;
  console.log(`[InstagramShare] Graph API response (${resp.status}):`, JSON.stringify(json));

  if (!resp.ok || json.error) {
    const errMsg = json.error?.message || `HTTP ${resp.status}`;
    const errCode = json.error?.code;
    console.error(`[InstagramShare] ❌ DM send failed. Code: ${errCode}, Message: ${errMsg}`);

    // Decode common error codes
    let friendlyError = errMsg;
    if (errCode === 10 || errCode === 200) {
      friendlyError = 'Your app does not have the instagram_manage_messages permission. This requires Advanced Access approval from Meta.';
    } else if (errCode === 190) {
      friendlyError = 'Access token has expired. Please reconnect your Instagram account in Configure Credentials.';
    } else if (errCode === 100) {
      friendlyError = 'Invalid recipient ID or the user cannot be messaged.';
    } else if (errCode === 551) {
      friendlyError = 'This user cannot receive messages from your account (they may have restricted messaging).';
    }

    return { messageId: null, error: friendlyError };
  }

  const messageId = json.message_id || json.id;
  console.log(`[InstagramShare] ✅ DM sent successfully. Message ID: ${messageId}`);
  return { messageId, error: null };
}

// ─── Build auction message text ──────────────────────────────────────────────
function buildAuctionMessage(auction: any): string {
  const lotCount = auction.artwork_ids?.length ?? 0;
  const fmt = (n?: number) =>
    n ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n) : null;
  const fmtDate = (d?: string) =>
    d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;

  const lines = [
    `🔨 ${auction.short_name}`,
    ``,
    auction.long_name !== auction.short_name ? auction.long_name : null,
    lotCount > 0 ? `📦 ${lotCount} lots available` : null,
    fmtDate(auction.settlement_date) ? `📅 Settlement: ${fmtDate(auction.settlement_date)}` : null,
    (auction.total_estimate_low || auction.total_estimate_high)
      ? `💰 Estimate: ${fmt(auction.total_estimate_low) || '?'} – ${fmt(auction.total_estimate_high) || '?'}`
      : null,
    ``,
    `#auction #art #bidding #${auction.type || 'auction'}`,
  ];

  return lines.filter((l) => l !== null).join('\n');
}

// ─── POST /api/social-media/instagram/share-auction ──────────────────────────
router.post('/share-auction', async (req: AuthRequest, res: Response) => {
  const { auction_id, recipient, recipient_type, brand_id } = req.body;

  console.log(`[InstagramShare] ========== SHARE AUCTION REQUEST ==========`);
  console.log(`[InstagramShare] auction_id: ${auction_id}, recipient: ${recipient}, type: ${recipient_type}, brand_id: ${brand_id}`);

  // ── Validate inputs
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
    // ── 1. Fetch auction
    console.log(`[InstagramShare] Step 1: Fetching auction ${auction_id}`);
    const { data: auction, error: auctionError } = await supabaseAdmin
      .from('auctions')
      .select('id, short_name, long_name, type, settlement_date, total_estimate_low, total_estimate_high, artwork_ids, title_image_url')
      .eq('id', auction_id)
      .single();

    if (auctionError || !auction) {
      console.error(`[InstagramShare] Auction not found:`, auctionError?.message);
      return res.status(404).json({ success: false, error: 'Auction not found' });
    }
    console.log(`[InstagramShare] ✅ Auction found: "${auction.short_name}"`);

    // ── 2. Get Instagram credentials
    console.log(`[InstagramShare] Step 2: Loading credentials for brand ${brand_id}`);
    const creds = await getInstagramCredentials(Number(brand_id));
    if (!creds) {
      return res.status(400).json({
        success: false,
        error: 'Instagram credentials not configured for this brand. Go to Configure Credentials first.',
      });
    }

    const igAccountId: string = creds.instagram_account_id || creds.page_id;
    const accessToken: string = creds.access_token;

    if (!igAccountId || !accessToken) {
      console.error(`[InstagramShare] Credentials incomplete: account_id=${igAccountId}, has_token=${!!accessToken}`);
      return res.status(400).json({
        success: false,
        error: 'Incomplete Instagram credentials. Please reconfigure.',
      });
    }
    console.log(`[InstagramShare] ✅ Credentials loaded for IG account: ${igAccountId}`);

    // ── 3. Resolve recipient to IGSID
    console.log(`[InstagramShare] Step 3: Resolving recipient "${recipient}" (type: ${recipient_type})`);
    let resolveResult: { igsid: string | null; error: string | null };

    if (recipient_type === 'username') {
      resolveResult = await resolveUsernameToIGSID(recipient, igAccountId, accessToken);
    } else {
      resolveResult = await resolveProfileUrlToIGSID(recipient, igAccountId, accessToken);
    }

    if (resolveResult.error || !resolveResult.igsid) {
      console.error(`[InstagramShare] Failed to resolve recipient:`, resolveResult.error);
      return res.status(400).json({
        success: false,
        error: resolveResult.error,
        hint: 'The recipient must have previously sent a message to your Instagram business account within the last 24 hours.',
      });
    }

    // ── 4. Build and send the message
    const message = buildAuctionMessage(auction);
    console.log(`[InstagramShare] Step 4: Sending DM to IGSID ${resolveResult.igsid}`);
    console.log(`[InstagramShare] Message preview:\n${message}`);

    const sendResult = await sendInstagramDM(igAccountId, accessToken, resolveResult.igsid, message);

    if (sendResult.error || !sendResult.messageId) {
      console.error(`[InstagramShare] Send failed:`, sendResult.error);
      return res.status(502).json({
        success: false,
        error: sendResult.error,
      });
    }

    // ── 5. Log to DB (optional audit trail)
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
      console.log(`[InstagramShare] ✅ Share logged to DB`);
    } catch (logError) {
      // Non-fatal: log but don't fail the request
      console.warn(`[InstagramShare] Could not write to instagram_share_logs (table may not exist yet):`, logError);
    }

    console.log(`[InstagramShare] ========== SHARE SUCCESS ==========`);
    return res.json({
      success: true,
      message_id: sendResult.messageId,
      recipient,
      auction: auction.short_name,
    });

  } catch (err: any) {
    console.error(`[InstagramShare] Unexpected error:`, err);
    return res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
  }
});

// ─── GET /api/social-media/instagram/share-auction/conversations ─────────────
// Returns list of users who have messaged your IG account (valid DM targets)
router.get('/share-auction/conversations', async (req: AuthRequest, res: Response) => {
  const { brand_id } = req.query;
  console.log(`[InstagramShare] Fetching conversations for brand ${brand_id}`);

  if (!brand_id) {
    return res.status(400).json({ success: false, error: 'brand_id is required' });
  }

  try {
    const creds = await getInstagramCredentials(Number(brand_id));
    if (!creds) {
      return res.status(400).json({ success: false, error: 'Instagram credentials not configured' });
    }

    const igAccountId: string = creds.instagram_account_id || creds.page_id;
    const accessToken: string = creds.access_token;

    const url = `${GRAPH_BASE}/${igAccountId}/conversations?platform=instagram&fields=participants,updated_time,id&access_token=${accessToken}`;
    console.log(`[InstagramShare] Fetching: ${GRAPH_BASE}/${igAccountId}/conversations`);

    const resp = await fetch(url);
    const json = await resp.json() as any;

    if (!resp.ok || json.error) {
      console.error(`[InstagramShare] Conversations fetch error:`, json.error);
      return res.status(502).json({
        success: false,
        error: json.error?.message || 'Failed to fetch conversations from Instagram',
        code: json.error?.code,
      });
    }

    // Extract participants (excluding your own account)
    const conversations = (json.data || []).map((convo: any) => {
      const participants = (convo.participants?.data || []).filter(
        (p: any) => p.id !== igAccountId
      );
      return {
        conversation_id: convo.id,
        updated_time: convo.updated_time,
        participants,
      };
    });

    console.log(`[InstagramShare] ✅ Found ${conversations.length} conversations`);
    return res.json({ success: true, conversations, total: conversations.length });

  } catch (err: any) {
    console.error(`[InstagramShare] Error fetching conversations:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;