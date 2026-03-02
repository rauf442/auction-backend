// backend/src/utils/email-core.ts
/**
 * Core email sending functionality using Brevo API
 * Handles low-level API integration, test mode, and attachments
 */

// ⚠️ TEST EMAIL OVERRIDE - For testing purposes only
// Set this to a test email address to override all email recipients
// Set to null or empty string to disable override and send to actual recipients
// const TEST_EMAIL_OVERRIDE = 'info@metsabauctions.com' // Change to null to disable
const TEST_EMAIL_OVERRIDE = null // Change to null to disable
// const TEST_EMAIL_OVERRIDE = 'kabboandreigns@gmail.com' // Change to null to disable
// const TEST_EMAIL_OVERRIDE = 'info@metsabauctions.com' // Change to null to disable
console.log('🔧 Email Test Mode:', TEST_EMAIL_OVERRIDE ? `ENABLED - All emails will be sent to ${TEST_EMAIL_OVERRIDE}` : 'DISABLED - Emails will be sent to actual recipients')

export interface EmailAttachment {
  content: string  // Base64 encoded file content
  name: string     // Filename with extension (e.g., 'invoice-12345.pdf')
}

export interface EmailOptions {
  to: string
  subject: string
  html: string
  from?: string
  replyTo?: string
  attachments?: EmailAttachment[]
}

interface BrevoEmailPayload {
  sender: {
    name: string
    email: string
  }
  to: Array<{
    email: string
    name?: string
  }>
  subject: string
  htmlContent: string
  replyTo?: {
    email: string
    name?: string
  }
  attachment?: Array<{
    content: string
    name: string
  }>
}

export class EmailCore {
  private static readonly BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email'
  private static readonly DEFAULT_FROM_EMAIL = process.env.DEFAULT_FROM_EMAIL || 'atharvachougaleismyname@gmail.com'
  private static readonly DEFAULT_FROM_NAME = process.env.DEFAULT_FROM_NAME || 'Aurum Auctions'

  /**
   * Send an email via Brevo API with optional attachments
   */
  static async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      const apiKey = process.env.BREVO_API_KEY
      
      // Apply test email override if configured
      const actualRecipient = TEST_EMAIL_OVERRIDE || options.to
        const isTestMode = !!TEST_EMAIL_OVERRIDE && TEST_EMAIL_OVERRIDE !== options.to
        
        if (isTestMode) {
          console.log(`🔧 TEST MODE: Redirecting email from ${options.to} to ${actualRecipient}`)
        }

        if (!apiKey) {
          console.warn('⚠️ Brevo API key not configured, simulating email send')
          return this.simulateEmailSend({ ...options, to: actualRecipient })
        }

      console.log('📧 Brevo Email Service - Sending email:', {
        to: actualRecipient,
        originalRecipient: isTestMode ? options.to : undefined,
        subject: options.subject,
        from:  this.DEFAULT_FROM_EMAIL,
        timestamp: new Date().toISOString(),
        testMode: isTestMode,
        hasAttachments: !!(options.attachments && options.attachments.length > 0),
        attachmentCount: options.attachments?.length || 0
      })

      // Prepare Brevo API payload
      const payload: BrevoEmailPayload = {
        sender: {
          name: this.DEFAULT_FROM_NAME,
          email: process.env.DEFAULT_FROM_EMAIL!
        },
        to: [{
          email: actualRecipient
        }],
        subject: isTestMode ? `[TEST - Original: ${options.to}] ${options.subject}` : options.subject,
        htmlContent: options.html
      }

      // Add reply-to if specified
      if (options.replyTo) {
        payload.replyTo = {
          email: options.replyTo
        }
      }

      // Add attachments if provided
      if (options.attachments && options.attachments.length > 0) {
        payload.attachment = options.attachments.map(att => ({
          content: att.content,
          name: att.name
        }))
        console.log('📎 Attaching files:', options.attachments.map(a => a.name).join(', '))
      }

      // Send email via Brevo API
      const response = await fetch(this.BREVO_API_URL, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('❌ Brevo API Error Details:', {
          status: response.status,
          statusText: response.statusText,
          errorData,
          payload: JSON.stringify(payload, null, 2)
        })
        throw new Error(`Brevo API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`)
      }

      const result = await response.json() as { messageId: string }
      console.log('✅ Brevo Email sent successfully:', result.messageId)

      return true
    } catch (error) {
      console.error('❌ Brevo Email Service Error:', error)
      return false
    }
  }

  /**
   * Fallback simulation for development/testing when API key is not configured
   */
  private static async simulateEmailSend(options: EmailOptions): Promise<boolean> {
    const isTestMode = !!TEST_EMAIL_OVERRIDE
    
    console.log('📧 [SIMULATION] Brevo Email Service - Would send email:', {
      to: options.to,
      subject: options.subject,
      from: options.from || this.DEFAULT_FROM_EMAIL,
      timestamp: new Date().toISOString(),
      testMode: isTestMode,
      hasAttachments: !!(options.attachments && options.attachments.length > 0),
      attachmentCount: options.attachments?.length || 0
    })

    // Log email content for debugging (in development)
    if (process.env.NODE_ENV === 'development') {
      console.log('📧 [SIMULATION] Email Content Preview:')
      console.log('Subject:', options.subject)
      console.log('To:', options.to)
      console.log('HTML Length:', options.html.length, 'characters')
      if (options.attachments && options.attachments.length > 0) {
        console.log('📎 [SIMULATION] Attachments:', options.attachments.map(a => a.name).join(', '))
      }
      if (isTestMode) {
        console.log('🔧 Test Mode: Email would be redirected to', TEST_EMAIL_OVERRIDE)
      }
    }

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500))

    return true
  }
}

export default EmailCore

