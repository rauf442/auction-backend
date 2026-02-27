// backend/src/utils/invoice-calculations.ts

/**
 * Invoice calculation utilities for different invoice types and scenarios
 */

const VAT_RATE = 0.20; // 20% VAT

export interface InvoiceData {
  id?: number;
  sale_prices?: number[]; // Array of sale prices for each item
  buyer_premium_prices?: number[]; // Array of buyer/vendor premium prices for each item
  total_shipping_amount?: number;
  paid_amount?: number;
  type?: 'buyer' | 'vendor';
  status?: 'paid' | 'unpaid' | 'cancelled';

  // Client and buyer information
  client_id?: number;
  paddle_number?: string;
  client?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    company_name?: string;
    email?: string;
    phone_number?: string;
    billing_address1?: string;
    billing_address2?: string;
    billing_address3?: string;
    billing_city?: string;
    billing_country?: string;
    billing_post_code?: string;
    billing_region?: string;
    buyer_premium?: number;
    vendor_premium?: number;
    client_type?: string;
    bank_account_details?: string;
    bank_address?: string;
  };

  // Shipping address fields
  ship_to_address?: string;
  ship_to_city?: string;
  ship_to_state?: string;
  ship_to_postal_code?: string;
  ship_to_country?: string;

  // Buyer information (fallback)
  buyer_first_name?: string;
  buyer_last_name?: string;
  buyer_email?: string;
  buyer_phone?: string;

  // Invoice metadata
  invoice_date?: string;
  invoice_number?: string;
  platform?: string;
  auction?: {
    id?: number;
    long_name?: string;
    short_name?: string;
    settlement_date?: string;
    subtype?: 'actual' | 'post_sale_platform' | 'post_sale_private' | 'free_timed';
  };

  // Item and lot information
  lot_ids?: string[];
  item_ids?: number[];

  // Additional fields
  payment_link?: string;
  tracking_number?: string;
}

export interface BrandData {
  vat_number?: string;
}

export type InvoiceFormat = 'internal' | 'final';
export type InvoiceStatus = 'paid' | 'unpaid' | 'cancelled';

/**
 * Get the appropriate status based on payment information
 */
export function determineInvoiceStatus(
  isPaid: boolean,
  isCancelled: boolean = false
): InvoiceStatus {
  if (isCancelled) return 'cancelled';
  if (isPaid) return 'paid';
  return 'unpaid'; // Default status for unpaid invoices
}

/**
 * Check if an invoice status represents a completed transaction
 */
export function isInvoiceCompleted(status: InvoiceStatus): boolean {
  return status === 'paid' || status === 'cancelled';
}

/**
 * Check if an invoice is in a pending state
 */
export function isInvoicePending(status: InvoiceStatus): boolean {
  return status === 'unpaid';
}



export function calculateBuyerOrVendorPremium(
  invoice: InvoiceData,
  brand: BrandData
): number {
  const invoiceType = invoice.type || 'buyer';

  // Sum up all buyer/vendor premium prices from the array
  const premiumPrices = invoice.buyer_premium_prices || [];
  const totalPremium = premiumPrices.reduce((sum, price) => sum + price, 0);

  if (invoiceType === 'buyer') {
    return calculateBuyerPremium(totalPremium, brand);
  } else {
    return calculateVendorPremium(totalPremium, brand);
  }
}

/**
 * Calculate buyer premium with VAT if applicable
 */
export function calculateBuyerPremium(
  originalPremium: number,
  brand: BrandData
): number {
  if (!brand.vat_number) {
    return originalPremium;
  }

  // Add 20% VAT to the buyer's premium
  const vatAmount = originalPremium * VAT_RATE;
  return originalPremium + vatAmount;
}

/**
 * Calculate vendor commission/premium amount with VAT if applicable
 * For vendor invoices, the premium is already calculated and stored in buyer_premium_prices array
 */
export function calculateVendorPremium(premiumAmount: number, brand?: BrandData): number {
  // If brand has VAT, add 20% VAT to the vendor premium
  if (brand?.vat_number) {
    const vatAmount = premiumAmount * VAT_RATE; // 20% VAT
    return premiumAmount + vatAmount;
  }

  return premiumAmount;
}

/**
 * Calculate total amount for buyer invoices
 */
export function calculateBuyerTotal(
  invoice: InvoiceData,
  format: InvoiceFormat,
  deductPaidAmount: boolean = false
): number {
  // Sum up all sale prices
  const salePrices = invoice.sale_prices || [];
  const totalSalePrice = salePrices.reduce((sum, price) => sum + price, 0);
  
  // Sum up all buyer premium prices
  const buyerPremiumPrices = invoice.buyer_premium_prices || [];
  const totalBuyerPremium = buyerPremiumPrices.reduce((sum, price) => sum + price, 0);
  
  const shippingAmount = invoice.total_shipping_amount || 0;
  const paidAmount = deductPaidAmount ? (invoice.paid_amount || 0) : 0;

  if (format === 'internal') {
    return totalSalePrice + totalBuyerPremium - paidAmount;
  } else {
    // Final invoice: sale_price + buyer_premium + total_shipping_amount - paid_amount (if requested)
    return totalSalePrice + totalBuyerPremium + shippingAmount - paidAmount;
  }
}

/**
 * Calculate total amount for vendor invoices
 */
export function calculateVendorTotal(
  invoice: InvoiceData,
  format: InvoiceFormat,
  deductPaidAmount: boolean = false,
  brand?: BrandData
): number {
  // Sum up all sale prices
  const salePrices = invoice.sale_prices || [];
  const totalSalePrice = salePrices.reduce((sum, price) => sum + price, 0);
  
  // Sum up all vendor premium prices
  const vendorPremiumPrices = invoice.buyer_premium_prices || [];
  const totalVendorPremium = vendorPremiumPrices.reduce((sum, price) => sum + price, 0);
  
  // Calculate vendor commission with VAT if applicable
  const vendorCommissionAmount = calculateVendorPremium(totalVendorPremium, brand);
  const paidAmount = deductPaidAmount ? (invoice.paid_amount || 0) : 0;

  if (format === 'internal') {
    // For vendor internal: sale_price - vendor_commission
    return totalSalePrice - vendorCommissionAmount - paidAmount;
  } else {
    // Final invoice: sale_price - vendor_commission - paid_amount (if requested)
    return totalSalePrice - vendorCommissionAmount - paidAmount;
  }
}

/**
 * Calculate total amount for any invoice based on type (without deducting paid_amount)
 */
export function calculateTotalAmount(
  invoice: InvoiceData,
  format: InvoiceFormat,
  brand?: BrandData
): number {
  const invoiceType = invoice.type || 'buyer';

  if (invoiceType === 'buyer') {
    return calculateBuyerTotal(invoice, format, false);
  } else {
    return calculateVendorTotal(invoice, format, false, brand);
  }
}

/**
 * Calculate due amount for any invoice based on type (with deducting paid_amount)
 */
export function calculateDueAmount(
  invoice: InvoiceData,
  format: InvoiceFormat,
  brand?: BrandData
): number {
  const invoiceType = invoice.type || 'buyer';

  if (invoiceType === 'buyer') {
    return calculateBuyerTotal(invoice, format, true);
  } else {
    return calculateVendorTotal(invoice, format, true, brand);
  }
}

/**
 * Get VAT breakdown for buyer premium if applicable
 */
export function getBuyerPremiumVATBreakdown(
  originalPremium: number,
  brand: BrandData
) {
  if (!brand.vat_number) {
    return {
      original: originalPremium,
      vat: 0,
      total: originalPremium
    };
  }

  const vatAmount = originalPremium * 0.20;
  return {
    original: originalPremium,
    vat: vatAmount,
    total: originalPremium + vatAmount
  };
}

/**
 * Check if invoice is fully paid
 */
export function isInvoicePaid(
  invoice: InvoiceData,
  format: InvoiceFormat = 'final'
): boolean {
  const totalAmount = calculateTotalAmount(invoice, format);
  const paidAmount = invoice.paid_amount || 0;

  return paidAmount >= totalAmount;
}

/**
 * Get remaining balance for invoice
 */
export function getRemainingBalance(
  invoice: InvoiceData,
  format: InvoiceFormat = 'final'
): number {
  const totalAmount = calculateTotalAmount(invoice, format);
  const paidAmount = invoice.paid_amount || 0;

  return Math.max(0, totalAmount - paidAmount);
}

/**
 * Format currency amount
 */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2
  }).format(amount);
}

/**
 * Validate invoice data for calculations
 */
export function validateInvoiceForCalculation(invoice: InvoiceData): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!invoice.sale_prices || !Array.isArray(invoice.sale_prices)) {
    errors.push('Sale prices must be an array');
  } else if (invoice.sale_prices.some(price => price < 0)) {
    errors.push('All sale prices must be non-negative numbers');
  }

  if (!invoice.buyer_premium_prices || !Array.isArray(invoice.buyer_premium_prices)) {
    errors.push('Buyer premium prices must be an array');
  } else if (invoice.buyer_premium_prices.some(price => price < 0)) {
    errors.push('All buyer premium prices must be non-negative numbers');
  }

  if (invoice.sale_prices && invoice.buyer_premium_prices && 
      invoice.sale_prices.length !== invoice.buyer_premium_prices.length) {
    errors.push('Sale prices and buyer premium prices arrays must have the same length');
  }

  if (invoice.paid_amount !== undefined && invoice.paid_amount < 0) {
    errors.push('Paid amount cannot be negative');
  }

  if (invoice.total_shipping_amount !== undefined && invoice.total_shipping_amount < 0) {
    errors.push('Shipping amount cannot be negative');
  }

  if (invoice.type && !['buyer', 'vendor'].includes(invoice.type)) {
    errors.push('Invoice type must be either "buyer" or "vendor"');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}
