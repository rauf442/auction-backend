// backend/src/utils/webhook-security.ts
import crypto from 'crypto';

// Webhook security configuration
const WEBHOOK_SECRET = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET || '7a1a539bdb88ec2ddc0e8eea20b927ddeff65569fb38cd191274ad45ed34c72b';
const WEBHOOK_TOLERANCE = parseInt(process.env.WEBHOOK_TOLERANCE_MINUTES || '5'); // 5 minutes tolerance

// Interface for webhook verification result
interface WebhookVerificationResult {
  isValid: boolean;
  error?: string;
  timestamp?: Date;
}

/**
 * Verify webhook signature from Google Sheets
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp?: string
): WebhookVerificationResult {
  try {
    console.log('🔐 Verifying webhook signature...');

    // Check if signature is provided
    if (!signature) {
      return { isValid: false, error: 'Missing webhook signature' };
    }

    // Check timestamp if provided (prevent replay attacks)
    if (timestamp) {
      const payloadTime = new Date(timestamp);
      const now = new Date();
      const diffMinutes = (now.getTime() - payloadTime.getTime()) / (1000 * 60);

      if (diffMinutes > WEBHOOK_TOLERANCE) {
        return { isValid: false, error: 'Webhook timestamp too old' };
      }

      if (diffMinutes < -WEBHOOK_TOLERANCE) {
        return { isValid: false, error: 'Webhook timestamp too far in future' };
      }
    }

    // Create expected signature using the same secret
    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    console.log('   - Expected signature:', expectedSignature);
    console.log('   - Provided signature:', signature);
    console.log('   - Match:', signature === expectedSignature);

    // Use timing-safe comparison
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (signatureBuffer.length !== expectedBuffer.length) {
      return { isValid: false, error: 'Invalid signature length' };
    }

    const isValid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
    console.log('   - ✅ Final result:', isValid ? 'VALID' : 'INVALID');

    return {
      isValid,
      error: isValid ? undefined : 'Invalid signature',
      timestamp: timestamp ? new Date(timestamp) : undefined
    };

  } catch (error: any) {
    console.error('Error verifying webhook signature:', error);
    return { isValid: false, error: 'Signature verification failed' };
  }
}

/**
 * Generate webhook signature for testing
 */
export function generateWebhookSignature(payload: string): string {
  return crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
}

/**
 * Middleware to verify webhook requests
 */
export function createWebhookVerificationMiddleware() {
  return (req: any, res: any, next: Function) => {
    const signature = req.headers['x-webhook-secret'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;
    const payload = JSON.stringify(req.body);

    const verification = verifyWebhookSignature(payload, signature, timestamp);

    if (!verification.isValid) {
      console.warn('Webhook verification failed:', verification.error);
      return res.status(401).json({
        error: 'Webhook verification failed',
        details: verification.error
      });
    }

    // Add verification info to request for logging
    req.webhookVerification = verification;
    next();
  };
}

/**
 * Rate limiting for webhook endpoints
 */
const webhookRequests = new Map<string, { count: number; resetTime: number }>();

export function createWebhookRateLimit(windowMs: number = 60000, maxRequests: number = 100) {
  return (req: any, res: any, next: Function) => {
    const clientId = req.headers['x-webhook-secret'] || req.ip || 'unknown';
    const now = Date.now();
    const windowKey = clientId;

    const current = webhookRequests.get(windowKey);

    if (!current || now > current.resetTime) {
      webhookRequests.set(windowKey, {
        count: 1,
        resetTime: now + windowMs
      });
      return next();
    }

    if (current.count >= maxRequests) {
      return res.status(429).json({
        error: 'Too many webhook requests',
        retryAfter: Math.ceil((current.resetTime - now) / 1000)
      });
    }

    current.count++;
    next();
  };
}

/**
 * Log webhook requests for monitoring
 */
export function logWebhookRequest(req: any, result: { success: boolean; error?: string }) {
  const logData = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    userAgent: req.headers['user-agent'],
    verification: req.webhookVerification,
    success: result.success,
    error: result.error,
    ip: req.ip,
    bodySize: JSON.stringify(req.body || {}).length
  };

  console.log('Webhook Request:', JSON.stringify(logData, null, 2));

  // In production, you might want to store this in a database or monitoring service
}

/**
 * Validate webhook payload structure
 */
export function validateWebhookPayload(payload: any): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!payload) {
    errors.push('Payload is required');
    return { isValid: false, errors };
  }

  if (!payload.sheetName || typeof payload.sheetName !== 'string') {
    errors.push('Valid sheetName is required');
  }

  if (!payload.record || typeof payload.record !== 'object') {
    errors.push('Valid record object is required');
  }

  if (!payload.changeType || !['update', 'sync', 'delete'].includes(payload.changeType)) {
    errors.push('Valid changeType is required (update, sync, or delete)');
  }

  if (!payload.timestamp || isNaN(Date.parse(payload.timestamp))) {
    errors.push('Valid timestamp is required');
  }

  if (payload.rowNumber && (typeof payload.rowNumber !== 'number' || payload.rowNumber < 1)) {
    errors.push('Row number must be a positive integer');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Create a secure webhook URL with signature
 */
export function createSecureWebhookUrl(baseUrl: string, payload: any): string {
  const payloadString = JSON.stringify(payload);
  const signature = generateWebhookSignature(payloadString);

  const params = new URLSearchParams({
    signature,
    timestamp: new Date().toISOString()
  });

  return `${baseUrl}?${params.toString()}`;
}

/**
 * Verify secure webhook URL parameters
 */
export function verifySecureWebhookUrl(url: string): { isValid: boolean; error?: string; payload?: any } {
  try {
    const urlObj = new URL(url);
    const signature = urlObj.searchParams.get('signature');
    const timestamp = urlObj.searchParams.get('timestamp');

    if (!signature || !timestamp) {
      return { isValid: false, error: 'Missing signature or timestamp in URL' };
    }

    // In practice, you'd extract the payload from the URL or request body
    const payload = {}; // This would be the actual payload

    const verification = verifyWebhookSignature(
      JSON.stringify(payload),
      signature,
      timestamp
    );

    return {
      isValid: verification.isValid,
      error: verification.error,
      payload
    };

  } catch (error: any) {
    return { isValid: false, error: 'Invalid URL format' };
  }
}
