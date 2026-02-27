# Email Sending System - Implementation Guide

## Overview

A complete email preview and sending system has been implemented for invoices, allowing administrators to preview and send branded emails to clients using Brevo email service.

## Features Implemented

### 1. **Email Types**

#### For Buyer Invoices (3 email types):
- **Winning Bid Email**: Congratulations email when buyer wins an auction
- **Payment Confirmation**: Confirmation after invoice payment
- **Shipping Confirmation**: Request for shipping details

#### For Vendor Invoices (2 email types):
- **Sale Notification**: Notification when vendor's item is sold
- **Payment Confirmation**: Confirmation of payment to vendor

### 2. **Smart Invoice Generation**

- **Shipping Info Validation**: "Generate Invoice (With Shipping)" is automatically disabled when shipping information is not available for buyer invoices
- **Visual Feedback**: Disabled buttons show gray styling and helpful tooltips
- **Data Integrity**: Prevents generation of incomplete shipping invoices

### 3. **Email Preview Dialog**

- Preview email subject, sender, recipient before sending
- View full HTML email template with brand styling
- Approve and send with single click
- Error handling with retry capability

### 4. **Brand-Specific Templates**

Email templates are fetched from the `brands` table with the following fields:
- `winning_bid_email_subject`
- `winning_bid_email_body`
- `payment_confirmation_email_subject`
- `payment_confirmation_email_body`
- `shipping_confirmation_email_subject`
- `shipping_confirmation_email_body`

### 5. **Variable Replacement**

Templates support the following placeholders:
- `[CLIENT_NAME]` - Client full name
- `[INVOICE_NUMBER]` - Invoice reference number
- `[INVOICE_ID]` - Invoice database ID
- `[BRAND_NAME]` - Brand name
- `[PURCHASE_AMOUNT]` - Formatted total amount (£X.XX)
- `[PAYMENT_DATE]` - Current date formatted
- `[BASE_URL]` - Frontend URL
- `[CONTACT_EMAIL]` - Brand contact email
- `[CONTACT_PHONE]` - Brand contact phone
- `[ITEM_TITLE]` - Item/lot title
- `[LOT_NUMBER]` - Lot ID
- `[HAMMER_PRICE]` - Winning bid amount
- `[AUCTION_NAME]` - Auction name

All placeholders are case-insensitive (works with both `[CLIENT_NAME]` and `[client_name]`).

## Implementation Details

### Backend Components

#### 1. **API Routes** (`/backend/src/routes/invoice-emails.ts`)

**GET** `/api/invoices/:invoiceId/email-preview?type=<emailType>`
- Fetches invoice data with brand templates
- Replaces template variables
- Returns preview object with subject, body, sender, recipient

**POST** `/api/invoices/:invoiceId/send-email`
- Sends actual email via Brevo API
- Uses brand contact email as sender
- Logs email to `email_logs` table
- Returns confirmation with recipient email

#### 2. **Email Service** (`/backend/src/utils/email-service.ts`)

Updated methods:
- Made template getters public: `getDefaultWinningBidTemplate()`, `getDefaultPaymentConfirmationTemplate()`, `getDefaultShippingConfirmationTemplate()`
- `sendEmail()` - Handles Brevo API integration
- `replaceEmailVariables()` - Template variable replacement

#### 3. **Database Migration** (`/backend/scripts/create-email-logs-table.sql`)

Creates `email_logs` table to track:
- Invoice ID
- Email type
- Recipient emails (both actual client and debug email)
- Subject, status, timestamps
- Error messages if failed

### Frontend Components

#### 1. **EmailPreviewDialog** (`/frontend/admin/src/components/invoices/EmailPreviewDialog.tsx`)

- Modal dialog component for email preview
- Loads preview via API
- Shows email metadata (From, To, Subject)
- Renders HTML email body
- Send button with loading state
- Error handling and retry

#### 2. **InvoiceTable** (`/frontend/admin/src/components/invoices/InvoiceTable.tsx`)

Updated action menu with:
- **Buyer invoices**: 4 email options in blue theme
- **Vendor invoices**: 2 email options in purple theme
- Opens EmailPreviewDialog on click
- Handles email sending via API

## Configuration

### Environment Variables

#### Backend (.env)
```bash
# Brevo API Configuration
BREVO_API_KEY=your_brevo_api_key_here

# Email Sender Configuration
DEFAULT_FROM_EMAIL=info@aurumauctions.com
DEFAULT_FROM_NAME=Aurum Auctions

# Debug Email (for testing)
DEBUG_EMAIL=test@example.com

# Frontend URLs (for email links)
NEXT_PUBLIC_FRONTEND_URL=http://localhost:3000
```

#### Brand Database Configuration

Each brand in the `brands` table should have:
- `contact_email` - Used as sender email
- `contact_phone` - Included in email footer
- `business_whatsapp_number` - Optional contact method
- Email template fields (see above)

## Testing

### Development Mode

In development (NODE_ENV !== 'production'), emails are sent to `DEBUG_EMAIL` instead of actual client emails. This allows safe testing without sending emails to real clients.

### Testing Workflow

1. Navigate to Invoices page
2. Click action menu (•••) on any invoice
3. Select an email type from "Email Actions" section
4. Review preview in dialog
5. Click "Send Email"
6. Check console/logs for confirmation
7. Verify email received at debug address

### Production Mode

In production, emails are sent to actual client emails. Make sure:
- `BREVO_API_KEY` is configured
- `contact_email` is set for each brand
- Templates are properly configured in database

## Email Templates

### Creating Custom Templates

1. Go to Settings → Brands
2. Select a brand
3. Add custom email templates with HTML styling
4. Use placeholders for dynamic content
5. Test using the email preview feature

### Default Templates

If no custom template is found, the system uses beautiful default templates with:
- Gradient headers
- Responsive design
- Professional styling
- Call-to-action buttons
- Brand footer

## Email Logging

All sent emails are logged to the `email_logs` table:

```sql
SELECT 
  invoice_id,
  email_type,
  recipient_email,
  sent_to_email,
  subject,
  status,
  sent_at
FROM email_logs
ORDER BY sent_at DESC;
```

This allows tracking:
- Which emails were sent for each invoice
- When emails were sent
- Any errors that occurred
- Email delivery status

## Usage in InvoiceTable

### Action Menu Structure

```
Invoice Actions
├── Edit Logistics Info (buyer only)
├── Generate Invoice (Without Shipping) (buyer only)
├── Generate Invoice (With Shipping) *disabled if no shipping info*
├── Generate Invoice (with URL)
├── ─────────────────────────
├── Email Actions
│   ├── Send Winning Bid Email (buyer/vendor)
│   ├── Send Payment Confirmation (buyer/vendor)
│   ├── Send Shipping Confirmation (buyer only)
├── ─────────────────────────
├── Set Paid Amount
└── Delete Invoice
```

### Color Coding

- **Blue** (#2563eb): Buyer email actions
- **Purple** (#9333ea): Vendor email actions
- **Red** (#dc2626): Delete action
- **Gray**: Standard actions

### Shipping Information Check

The "Generate Invoice (With Shipping)" option is disabled for buyer invoices when shipping information is not available. Shipping info is considered available when any of these fields exist and are not empty:

- `shipping_method` - How the item will be shipped
- `shipping_status` - Current shipping status
- `shipping_charge` - Shipping cost (must be > 0)
- `ship_to_first_name` - Recipient first name
- `ship_to_last_name` - Recipient last name
- `ship_to_address` - Shipping address
- `ship_to_city` - Shipping city

When disabled, the button shows:
- Grayed out text and icon
- "Shipping information required" tooltip on hover
- Non-clickable state (cursor: not-allowed)

## Troubleshooting

### Email Not Sending

1. **Check Brevo API Key**: Ensure `BREVO_API_KEY` is set and valid
2. **Check Email Service Logs**: Look for error messages in backend console
3. **Verify Brand Configuration**: Ensure brand has `contact_email` set
4. **Check Rate Limits**: Brevo has daily sending limits on free tier

### Preview Not Loading

1. **Check API Connection**: Verify backend is running
2. **Check Invoice Data**: Ensure invoice has valid client data
3. **Check Brand Templates**: Verify brand templates exist or fall back to defaults
4. **Check Browser Console**: Look for API errors

### Variables Not Replacing

1. **Check Template Syntax**: Placeholders should be `[VARIABLE_NAME]`
2. **Case Insensitive**: Works with both uppercase and lowercase
3. **Check Variable Names**: Must match exactly (e.g., `CLIENT_NAME` not `CLIENTNAME`)

## Security Considerations

1. **Email Validation**: Client emails are validated before sending
2. **Authentication Required**: All endpoints require auth token
3. **Rate Limiting**: Consider implementing rate limiting for production
4. **Email Logging**: All emails are logged for audit trail
5. **Debug Mode**: Test emails go to debug address in development

## Future Enhancements

1. **Email Templates Management UI**: Visual template editor in admin panel
2. **Email Scheduling**: Schedule emails to be sent at specific times
3. **Email Analytics**: Track open rates, click rates
4. **Bulk Email Sending**: Send to multiple invoices at once
5. **Email Attachments**: Attach PDFs automatically
6. **Email Preview in Inbox**: Show how email looks in different clients

## API Documentation

### Preview Email

```http
GET /api/invoices/:invoiceId/email-preview?type=<emailType>
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "preview": {
    "to": "client@example.com",
    "from": "info@aurumauctions.com",
    "subject": "Payment Confirmed - INV-001 | Aurum Auctions",
    "body": "<html>...</html>"
  }
}
```

### Send Email

```http
POST /api/invoices/:invoiceId/send-email
Authorization: Bearer <token>
Content-Type: application/json

{
  "type": "payment_confirmation"
}
```

**Response:**
```json
{
  "success": true,
  "message": "payment_confirmation email sent successfully to test@example.com",
  "sentTo": "test@example.com"
}
```

## Deployment Checklist

- [ ] Set `BREVO_API_KEY` in production environment
- [ ] Configure `DEFAULT_FROM_EMAIL` with verified sender
- [ ] Set proper `DEBUG_EMAIL` for testing
- [ ] Update frontend URLs in environment
- [ ] Run database migration to create `email_logs` table
- [ ] Configure email templates for each brand
- [ ] Test email sending in staging environment
- [ ] Monitor email logs after deployment
- [ ] Set up email sending alerts for errors

## Support

For issues or questions:
1. Check backend logs for error messages
2. Verify Brevo dashboard for delivery status
3. Review `email_logs` table for sent emails
4. Test with debug email first

---

**Status**: ✅ Fully Implemented and Tested
**Last Updated**: October 1, 2025
**Version**: 1.0.0

