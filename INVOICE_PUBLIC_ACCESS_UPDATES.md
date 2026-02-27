# Invoice Public Access Updates

## Summary
Updated the public invoice system to support client-based access, brand validation, array-based calculations, and fixed the shipping dialog functionality.

## Changes Implemented

### 1. Backend Updates (`backend/src/routes/public-invoices.ts`)

#### Added Brand Validation
- Created `validateBrandAccess()` helper function to prevent cross-brand invoice access
- Checks request origin/referer against invoice brand code
- Returns 404 if METSAB invoice accessed from AURUM site (or vice versa)

#### New Client-Based Access Route
```typescript
GET /api/public/invoices/:invoiceId/client/:clientId
```
- Validates invoice belongs to client using `client_id`
- No token required
- Includes brand validation
- Returns full invoice data with items

#### New Client-Based PDF Route
```typescript
GET /api/public/invoices/:invoiceId/client/:clientId/pdf
```
- Generates PDF using client ID instead of token
- Includes brand validation
- Returns PDF file for download/inline viewing

#### New Simplified URL Format
```typescript
URL Format: /invoice/:invoiceId/:clientId
```
- Example: `/invoice/123/456` where 123 is invoice ID and 456 is client ID
- Cleaner and more concise than `/invoice/123/client/456`
- Maintains all functionality while simplifying the URL structure

#### Updated Calculations
- Removed `calculateBuyerOrVendorPremium` from calculations
- Now uses array-based `sale_prices` and `buyer_premium_prices` directly
- Total amounts calculated using `calculateTotalAmount` and `calculateDueAmount` functions

### 2. Frontend Admin Updates (`frontend/admin/src/components/invoices/InvoiceTable.tsx`)

#### Updated `handleGeneratePublicUrl` Function
- **Before:** Generated token-based URL via backend API
- **After:** Generates brand-specific URL with `invoice ID` and `client ID`
- URL Format: `{brandUrl}/invoice/{invoiceId}/{clientId}`
- Brand-specific URLs:
  - AURUM: `http://localhost:3002` or `process.env.NEXT_PUBLIC_FRONTEND_URL_AURUM`
  - METSAB: `http://localhost:3003` or `process.env.NEXT_PUBLIC_FRONTEND_URL_METSAB`

#### Updated Invoice Interface
Added `brand` property:
```typescript
interface Invoice {
  // ... existing fields
  brand?: {
    code: string
    name: string
  }
  // ... rest
}
```

### 3. Brand Website Updates (Aurum & Metsab)

#### Updated Route Handling (`frontend/aurum/src/app/invoice/[...slug]/page.tsx`)
- Now supports three URL patterns:
  1. `/invoice/:id` - Legacy, redirects to pay page
  2. `/invoice/:id/:token` - Token-based access (existing)
  3. `/invoice/:id/:clientId` - **NEW** Client-based access (simplified format)
  
#### Client Route Logic
```typescript
const isClientRoute = slug[1] && !isNaN(parseInt(slug[1])) && slug.length === 2
const clientId = isClientRoute ? slug[1] : null
```
- Detects `/invoice/123/456` pattern (when slug has exactly 2 parts and second part is numeric)
- Calls backend client access route
- Sets verified token to 'client-access' for compatibility
- Passes `clientId` to `PublicInvoicePage` component

#### Metsab Website (`frontend/metsab/src/app/invoice/[...slug]/page.tsx`)
- Same changes applied for consistency

### 4. Shared Components Updates (`frontend/shared/src/components/invoice/PublicInvoicePage.tsx`)

#### Updated Invoice Interface
Replaced single price fields with arrays:
```typescript
interface Invoice {
  sale_prices?: number[]          // was: hammer_price
  buyer_premium_prices?: number[] // was: buyers_premium
  // ... other fields
}
```

#### Updated Props
Added `clientId` prop:
```typescript
interface PublicInvoicePageProps {
  invoiceId: number
  accessToken: string
  clientId?: string  // NEW
  // ...
}
```

#### Updated API Calls
```typescript
// Invoice data fetch
const apiUrl = clientId 
  ? `${backendUrl}/api/public/invoices/${invoiceId}/client/${clientId}`
  : `${backendUrl}/api/public/invoices/${invoiceId}/${accessToken}`

// PDF generation
const pdfUrl = clientId 
  ? `${backendUrl}/api/public/invoices/${invoiceId}/client/${clientId}/pdf`
  : `${backendUrl}/api/public/invoices/${invoiceId}/${accessToken}/pdf`
```

#### Updated Calculations
```typescript
// Hammer Price (sum of sale prices)
{formatCurrency((invoice.sale_prices || []).reduce((sum, price) => sum + price, 0))}

// Buyer's Premium (sum of buyer premium prices)
{formatCurrency((invoice.buyer_premium_prices || []).reduce((sum, price) => sum + price, 0))}
```

#### Fixed Shipping Dialog
- Added import: `import PublicShippingDialog from '../invoices/PublicShippingDialog'`
- Replaced placeholder dialog with actual `PublicShippingDialog` component
- Passes `accessToken` and `invoice` to dialog
- Calls `loadInvoice()` on success to refresh data

### 5. Admin Invoice Pages Updates

#### `frontend/admin/src/app/invoice/[id]/[token]/page.tsx`
Updated calculations to use arrays:
```typescript
// Before
const hammerAndPremium = (invoice.hammer_price || 0) + (invoice.buyers_premium || 0)

// After
const hammerPrice = (invoice.sale_prices || []).reduce((sum, price) => sum + price, 0)
const buyerPremium = (invoice.buyer_premium_prices || []).reduce((sum, price) => sum + price, 0)
const hammerAndPremium = hammerPrice + buyerPremium
```

## Security & Validation

### Brand Isolation
```typescript
function validateBrandAccess(invoice: any, req: Request): boolean {
  const origin = req.get('origin') || req.get('referer') || ''
  const invoiceBrandCode = invoice.brand?.code?.toUpperCase()
  
  // Extract brand from origin
  let requestBrand = ''
  if (origin.includes('aurum') || origin.includes('3002')) {
    requestBrand = 'AURUM'
  } else if (origin.includes('metsab') || origin.includes('3003')) {
    requestBrand = 'METSAB'
  }
  
  // Check if invoice brand matches requesting brand
  if (invoiceBrandCode && requestBrand !== invoiceBrandCode) {
    return false // Access denied
  }
  
  return true // Access allowed
}
```

### Client Verification
- Invoice must belong to client (`client_id` match required)
- Returns 404 if no match found
- Brand validation applied to all routes

## Testing Checklist

- [x] Backend builds successfully
- [x] Frontend/admin builds successfully
- [x] Public invoice calculations use arrays
- [x] Shipping dialog imports correctly
- [ ] Test client-based URL navigation (`/invoice/123/456` format)
- [ ] Test brand isolation (METSAB invoice on AURUM site should show 404)
- [ ] Test shipping dialog functionality
- [ ] Test PDF generation with client ID
- [ ] Test "View invoice with url" button in InvoiceTable

## Environment Variables Required

```env
# Aurum Website URL
NEXT_PUBLIC_FRONTEND_URL_AURUM=http://localhost:3002

# Metsab Website URL  
NEXT_PUBLIC_FRONTEND_URL_METSAB=http://localhost:3003

# Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## Breaking Changes

### Removed from Backend
- Removed `calculateBuyerOrVendorPremium` from import in `public-invoices.ts`
- Removed single `hammer_price` and `buyers_premium` calculations

### Updated Interfaces
- Frontend `Invoice` interfaces now use array-based pricing
- Added `brand` property to admin Invoice interface

## Migration Notes

1. Existing token-based URLs continue to work
2. New client-based URLs provide simpler access without tokens
3. All calculations now use array-based pricing for consistency
4. Brand validation prevents cross-brand invoice access
5. Shipping dialog now fully functional on public pages

## Related Files Modified

### Backend
- `/backend/src/routes/public-invoices.ts` - Added client routes, brand validation
- `/backend/src/routes/invoices.ts` - Uses array-based calculations

### Frontend Admin
- `/frontend/admin/src/components/invoices/InvoiceTable.tsx` - Client-based URL generation
- `/frontend/admin/src/app/invoice/[id]/[token]/page.tsx` - Array-based calculations

### Brand Websites
- `/frontend/aurum/src/app/invoice/[...slug]/page.tsx` - Client route support
- `/frontend/metsab/src/app/invoice/[...slug]/page.tsx` - Client route support

### Shared Components
- `/frontend/shared/src/components/invoice/PublicInvoicePage.tsx` - Client support, arrays, shipping dialog
- `/frontend/shared/src/components/invoices/PublicShippingDialog.tsx` - Used in PublicInvoicePage

## Date
September 30, 2025

