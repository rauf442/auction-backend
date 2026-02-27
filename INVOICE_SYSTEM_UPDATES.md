# Invoice System Updates - Implementation Summary

## Overview
This document summarizes the major updates made to the invoice system to support brand-specific invoice numbering, array-based pricing, and direct premium storage.

## Changes Implemented

### 1. Brand-Specific Invoice Numbers ✅
**Status**: Completed

Invoice numbers are now brand-specific and sequential per brand:
- **Format**: `BRANDCODE-INV-N` for buyer invoices, `BRANDCODE-CN-N` for vendor invoices
- **Examples**: 
  - AURUM-INV-1, AURUM-INV-2, AURUM-CN-1
  - METSAB-INV-1, METSAB-INV-2, METSAB-CN-1

**Files Modified**:
- `backend/src/routes/auctions.ts`: Updated invoice number generation logic for both new and existing invoices

### 2. Database Schema Changes ✅
**Status**: SQL script created (needs to be executed)

**Removed Fields** (deprecated in favor of arrays):
- `title` - No longer needed, individual items have titles
- `hammer_price` - Replaced by `sale_prices` array
- `buyers_premium` - Replaced by `buyer_premium_prices` array
- `commission_rate` - Not needed
- `commission_amount` - Not needed
- `processing_fee` - Not needed
- `sales_tax` - Not needed
- `net_to_pay_listing_agent` - Not needed
- `domestic_flat_shipping` - Not needed

**To Execute**:
```bash
# Run this SQL script in Supabase SQL Editor
backend/scripts/remove-unused-invoice-fields.sql
```

### 3. Buyer/Vendor Premium Calculation ✅
**Status**: Completed

Premium prices are now **calculated at save time** using client rates instead of EOA data:

**Buyer Invoices**:
- `buyer_premium_prices[i] = sale_prices[i] * (client.buyer_premium / 100)`
- VAT is added later during total calculation if brand has VAT number

**Vendor Invoices**:
- `buyer_premium_prices[i] = sale_prices[i] * (client.vendor_premium / 100)`
- VAT is added later during total calculation if brand has VAT number

**Files Modified**:
- `backend/src/routes/auctions.ts`: Updated EOA import to calculate premiums from client rates

### 4. Invoice Calculations Updated ✅
**Status**: Completed

All calculation functions now work with arrays:

**Changes**:
- `InvoiceData` interface updated to use `sale_prices[]` and `buyer_premium_prices[]`
- `calculateBuyerTotal()` sums array values instead of using single fields
- `calculateVendorTotal()` sums array values instead of using single fields
- `calculateBuyerOrVendorPremium()` sums premium array directly
- New function: `calculateVendorPremium()` replaces `calculateVendorCommissionAmount()`
- Validation updated to check array integrity

**Files Modified**:
- `backend/src/utils/invoice-calculations.ts`: Complete rewrite to support array-based pricing

### 5. PDF Generator Updates ✅
**Status**: Completed

PDF generation now uses direct database values:

**Changes**:
- Premium amounts are summed directly from `buyer_premium_prices` array (no recalculation)
- Sale prices come from `sale_prices[index]` for each item
- Removed all references to deprecated fields
- Comments added to clarify that VAT is already included in stored premiums

**Files Modified**:
- `backend/src/utils/invoice-pdf-generator.ts`: Updated both buyer and vendor PDF generators

### 6. Invoice Routes Cleanup ✅
**Status**: Completed

Removed all references to deprecated fields:

**Changes**:
- Removed `calculateBuyerOrVendorPremium()` import
- Updated export CSV to use array values
- Removed calculation of `buyers_premium` in responses
- Updated to use array-based pricing throughout

**Files Modified**:
- `backend/src/routes/invoices.ts`: Cleaned up deprecated field usage

## Migration Guide

### Step 1: Execute SQL Script
Run the SQL script to remove deprecated columns:
```sql
-- Execute in Supabase SQL Editor
-- File: backend/scripts/remove-unused-invoice-fields.sql
```

### Step 2: Verify Existing Data
Check that all existing invoices have:
- `sale_prices` array populated
- `buyer_premium_prices` array populated
- Arrays are of equal length
- `total_shipping_amount` is set if shipping applies

### Step 3: Test Invoice Generation
1. Import EOA CSV file
2. Verify invoice numbers follow pattern: `BRANDCODE-INV-N`
3. Verify premium calculations use client rates
4. Generate PDF and verify all values are correct

### Step 4: Update Frontend (If Needed)
Ensure frontend code no longer references:
- `invoice.hammer_price`
- `invoice.buyers_premium`
- `invoice.title`
- Other deprecated fields

Instead use:
- `invoice.sale_prices` (array)
- `invoice.buyer_premium_prices` (array)
- Calculate totals: `sale_prices.reduce((sum, p) => sum + p, 0)`

## Key Benefits

1. **Brand Isolation**: Each brand has independent invoice numbering
2. **Data Accuracy**: Premiums calculated from client rates, not EOA data
3. **Flexibility**: Array-based pricing supports multiple items per invoice
4. **Performance**: No recalculation needed - values stored at save time
5. **Cleaner Schema**: Removed redundant fields

## Testing Checklist

- [ ] Execute SQL migration script
- [ ] Import EOA CSV for AURUM brand
- [ ] Verify invoice number: AURUM-INV-1
- [ ] Import EOA CSV for METSAB brand
- [ ] Verify invoice number: METSAB-INV-1
- [ ] Check buyer premium calculation uses client.buyer_premium rate
- [ ] Check vendor premium calculation uses client.vendor_premium rate
- [ ] Generate buyer invoice PDF
- [ ] Generate vendor invoice PDF
- [ ] Verify totals match expected calculations
- [ ] Run `npm run build` to ensure no TypeScript errors

## Notes

- **VAT Handling**: VAT is added during total calculation, NOT during save
- **Shipping**: `total_shipping_amount` is separate from sale/premium arrays
- **Invoice Numbers**: Sequential per brand AND type (buyer vs vendor separately)
- **Backward Compatibility**: Old invoices may need data migration if they don't have arrays populated

## Files Changed Summary

1. `backend/scripts/remove-unused-invoice-fields.sql` - NEW: SQL migration script
2. `backend/src/routes/auctions.ts` - Updated invoice number generation and premium calculation
3. `backend/src/utils/invoice-calculations.ts` - Rewritten for array-based pricing
4. `backend/src/utils/invoice-pdf-generator.ts` - Updated to use direct database values
5. `backend/src/routes/invoices.ts` - Cleaned up deprecated field references
6. `backend/INVOICE_SYSTEM_UPDATES.md` - NEW: This documentation file

---

**Build Status**: ✅ All changes compile successfully (`npm run build` passes)
**Date**: September 30, 2025
