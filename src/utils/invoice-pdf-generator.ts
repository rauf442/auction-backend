// backend/src/utils/invoice-pdf-generator.ts

/**
 * PDF generation utilities for buyer and vendor invoices
 */

import * as fs from 'fs';
import * as path from 'path';
import { calculateTotalAmount, calculateDueAmount, getBuyerPremiumVATBreakdown, InvoiceData, calculateBuyerOrVendorPremium } from './invoice-calculations';

// Dynamic import for PDFKit to handle dependency issues
const PDFDocument = (() => {
    try {
        return require('pdfkit');
    } catch (error) {
        console.error('Error loading PDFKit:', error);
        // Fallback: return a mock PDFDocument for development
        return class MockPDFDocument {
            constructor() {
                throw new Error('PDFKit not available. Please install dependencies: npm install pdfkit @types/pdfkit tslib');
            }
        };
    }
})();

// Import PDFKit types
import PDFKit = require('pdfkit');

export interface BankAccount {
    account_name: string;
    uk_info?: {
        sort_code: string;
        account_number: string;
    };
    international_info?: {
        iban: string;
        bic: string;
        intermediary_bic: string;
    };
}

export interface BrandData {
    id?: number;
    name?: string;
    code?: string;
    brand_address?: string;
    contact_email?: string;
    contact_phone?: string;
    business_whatsapp_number?: string;
    bank_accounts?: BankAccount[];
    logo_url?: string;
    company_registration?: string;
    vat_number?: string;
    eori_number?: string;
    terms_and_conditions?: string;
    buyer_terms_and_conditions?: string;
    vendor_terms_and_conditions?: string;
}

export type InvoiceFormat = 'internal' | 'final';

// Global variables for reusability
const TEXT_SIZE = 8;
const PAGE_WIDTH = 500;
const COL_WIDTH = PAGE_WIDTH / 3 - 10;

// Font helpers
const setNormal = (doc: PDFKit.PDFDocument, size = TEXT_SIZE) =>
    doc.font("Helvetica").fontSize(size);

const setBold = (doc: PDFKit.PDFDocument, size = TEXT_SIZE) =>
    doc.font("Helvetica-Bold").fontSize(size);

// Global helper functions
const safeDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
};

const textOrEmpty = (v?: string) => (v ? String(v) : '');

// Helper function to format auction name based on subtype or platform
const formatAuctionName = (auction: any, invoice?: any) => {
    // Check if this is a private sale invoice first
    if (invoice && invoice.platform === 'private_sale') {
        return 'Private Sale';
    }
    
    if (!auction) return '';

    const baseName = auction.long_name || auction.short_name || '';
    const subtype = auction.subtype;

    switch (subtype) {
        case 'post_sale_private':
            return 'Private';
        case 'post_sale_platform':
        case 'free_timed':
            return `${baseName} - Post Sale`;
        case 'actual':
        default:
            return baseName;
    }
};

// Common hyperlink helper function for PDF documents
const addHyperlink = (doc: PDFKit.PDFDocument, text: string, url: string, x: number, y: number, options: any = {}) => {
    // Validate inputs to prevent NaN errors
    if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y) || x < 0 || y < 0) {
        console.warn('Invalid coordinates for hyperlink:', { x, y, text, url });
        return;
    }

    // Ensure URL is valid
    if (!url || typeof url !== 'string' || url.trim() === '') {
        console.warn('Invalid URL for hyperlink:', { text, url });
        return;
    }

    // Ensure text is valid
    const validText = text || url || 'Link';
    const validUrl = url.trim();

    try {
        const linkOptions = {
            ...options,
            link: validUrl,
            underline: true
        };
        doc.fillColor('blue').text(validText, x, y, linkOptions);
        doc.fillColor('black'); // Reset to black
    } catch (error) {
        console.error('Error creating hyperlink:', { text, url, x, y, error: error instanceof Error ? error.message : String(error) });
    }
};

// Common page layout helpers
const createPageBottom = (doc: PDFKit.PDFDocument) => () => doc.page.height - 50;

const createEnsureSpace = (doc: PDFKit.PDFDocument, currentY: number) => {
    const pageBottom = createPageBottom(doc);
    return (required: number) => {
        if (currentY + required > pageBottom()) {
            doc.addPage();
            return true; // Return true if page break occurred
        }
        return false; // Return false if no page break needed
    };
};

// Common payment logo helper function
const addPaymentLogo = (doc: PDFKit.PDFDocument, logoType: string, x: number, y: number) => {
    try {
        const baseName = path.parse(logoType).name;

        // Try different formats in order of preference (skip SVG due to PDFKit limitations)
        const formats = [
            { path: path.join(process.cwd(), 'assets', 'payment-logos', `${baseName}.png`), type: 'PNG' },
            { path: path.join(process.cwd(), 'assets', 'payment-logos', `${baseName}.jpg`), type: 'JPG' },
            { path: path.join(process.cwd(), 'assets', 'payment-logos', `${baseName}.jpeg`), type: 'JPEG' },
            { path: path.join(process.cwd(), 'assets', 'payment-logos', `${baseName}.svg`), type: 'SVG' }
        ];

        let logoLoaded = false;

        for (const format of formats) {
            if (fs.existsSync(format.path)) {
                try {
                    if (format.type === 'SVG') {
                        console.warn(`SVG format not fully supported by PDFKit, skipping: ${format.path}`);
                        continue; // Skip SVG for now due to PDFKit limitations
                    }

                    doc.image(format.path, x, y, { fit: [48, 20] });
                    logoLoaded = true;
                    break;
                } catch (imageError) {
                    console.warn(`Failed to load ${format.type} image:`, format.path, imageError instanceof Error ? imageError.message : String(imageError));
                    continue;
                }
            }
        }

        if (!logoLoaded) {
            // Fallback to text if no image files exist or all failed to load
            doc.save();
            doc.fontSize(TEXT_SIZE).font("Helvetica-Bold").text(`[${baseName.toUpperCase()}]`, x, y);
            doc.restore();
        }
    } catch (error) {
        console.warn('Error adding payment logo:', { logoType, error: error instanceof Error ? error.message : String(error) });
        // Fallback to text
        const baseName = path.parse(logoType).name;
        doc.fontSize(TEXT_SIZE).font("Helvetica-Bold").text(`[${baseName.toUpperCase()}]`, x, y);
    }
};

// Common header layout function for both buyer and vendor invoices
async function addHeaderLayout(
    doc: PDFKit.PDFDocument,
    invoice: InvoiceData,
    brand: BrandData,
    title: string,
    leftColumnType: 'client' | 'vendor',
    middleColumnLabels: {
        dateLabel: string;
        numberLabel: string;
        dateValue?: string;
        numberValue?: string;
    },
    logoUrl?: string
): Promise<number> {

    // Attempt to embed brand logo
    if (logoUrl) {
        try {
            const resp = await fetch(logoUrl);
            if (resp.ok) {
                const arr = await resp.arrayBuffer();
                const buf = Buffer.from(arr);
                // Place top-right with max 70x70
                doc.image(buf, 500, 40, { fit: [70, 70], align: 'right' });
            }
        } catch (e) {
            console.log('Could not load brand logo from URL:', e);
        }
    }

    // --- Title ---
    doc.fillColor('black').fontSize(20).text(title, 50, 40);

    // === 3 Column Layout ===
    const startY = 120;

    // --- Left Column: Client/Vendor Info ---
    let clientId = invoice.client_id || invoice.paddle_number;
    const brandPrefix = (brand?.code || '').slice(0, 3).toUpperCase();
    const clientNumber = clientId
        ? `${brandPrefix}-${String(clientId).padStart(3, '0')}`
        : '';

    let clientText = '';
    const isClientInfo = invoice.client || (invoice.buyer_first_name || invoice.buyer_last_name || invoice.buyer_email);

    if (isClientInfo) {
        if (invoice.client) {
            // For vendor invoices, prioritize company name if available
            if (leftColumnType === 'vendor' && invoice.client.company_name) {
                clientText += `${invoice.client.company_name}\n`;
            } else {
                clientText += `${invoice.client.first_name || ''} ${invoice.client.last_name || ''}\n`;
            }
        } else {
            clientText += `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}\n`;
        }

        // Add address - prefer client's billing address, then fall back to invoice shipping address
        let addressAdded = false;

        // First try client's billing address from database
        if (invoice.client && (invoice.client.billing_address1 || invoice.client.billing_address2 || invoice.client.billing_address3 || invoice.client.billing_city || invoice.client.billing_region || invoice.client.billing_country || invoice.client.billing_post_code)) {
            // Process all billing address fields in proper order
            // Address line 1
            if (invoice.client.billing_address1) {
                console.log('Processing billing_address1:', JSON.stringify(invoice.client.billing_address1));
                const addressLines = String(invoice.client.billing_address1).split('\n');
                console.log('Split into lines:', addressLines);
                addressLines.forEach(line => {
                    if (line.trim()) clientText += line.trim() + '\n';
                });
            }

            // Address line 2
            if (invoice.client.billing_address2) {
                const addressLines = String(invoice.client.billing_address2).split('\n');
                addressLines.forEach(line => {
                    if (line.trim()) clientText += line.trim() + '\n';
                });
            }

            // Address line 3
            if (invoice.client.billing_address3) {
                const addressLines = String(invoice.client.billing_address3).split('\n');
                addressLines.forEach(line => {
                    if (line.trim()) clientText += line.trim() + '\n';
                });
            }

            // City and region (can be on same line if both exist)
            const cityRegionParts = [];
            if (invoice.client.billing_city) cityRegionParts.push(invoice.client.billing_city);
            if (invoice.client.billing_region) cityRegionParts.push(invoice.client.billing_region);

            if (cityRegionParts.length > 0) {
                clientText += cityRegionParts.join(', ') + '\n';
            }

            // Post code and country (post code first, then country)
            if (invoice.client.billing_post_code) {
                clientText += invoice.client.billing_post_code + '\n';
            }
            if (invoice.client.billing_country) {
                clientText += invoice.client.billing_country + '\n';
            }

            addressAdded = true;
        }
        // Fall back to invoice shipping address if client billing address not available
        else if (invoice.ship_to_address || invoice.ship_to_city || invoice.ship_to_state || invoice.ship_to_postal_code || invoice.ship_to_country) {
            // Process ship_to_address which might contain newlines
            if (invoice.ship_to_address) {
                console.log('Processing ship_to_address:', JSON.stringify(invoice.ship_to_address));
                const addressLines = String(invoice.ship_to_address).split('\n');
                console.log('Split into lines:', addressLines);
                addressLines.forEach(line => {
                    if (line.trim()) clientText += line.trim() + '\n';
                });
            }

            // City and state (can be on same line if both exist)
            const cityStateParts = [];
            if (invoice.ship_to_city) cityStateParts.push(invoice.ship_to_city);
            if (invoice.ship_to_state) cityStateParts.push(invoice.ship_to_state);

            if (cityStateParts.length > 0) {
                clientText += cityStateParts.join(', ') + '\n';
            }

            // Post code and country (post code first, then country)
            if (invoice.ship_to_postal_code) {
                clientText += invoice.ship_to_postal_code + '\n';
            }
            if (invoice.ship_to_country) {
                clientText += invoice.ship_to_country + '\n';
            }

            addressAdded = true;
        }
    }

    if (clientNumber) clientText += `\nClient Number: ${clientNumber}\n`;

    if (invoice.client?.email || invoice.buyer_email) {
        clientText += `Email: ${invoice.client?.email || invoice.buyer_email}\n`;
    }
    if (invoice.client?.phone_number || invoice.buyer_phone) {
        clientText += `Phone: +${invoice.client?.phone_number || invoice.buyer_phone}`;
    }

    console.log('Final clientText for PDF:', JSON.stringify(clientText));
    doc.fontSize(TEXT_SIZE).text(clientText, 50, startY, { width: COL_WIDTH, lineGap: 2 });
    const col1Bottom = doc.y;

    // --- Middle Column: Auction Info ---
    doc.fontSize(TEXT_SIZE)
        .font("Helvetica-Bold").text(middleColumnLabels.dateLabel, 210, startY, { width: COL_WIDTH, lineGap: 2 })
        .font("Helvetica").text(middleColumnLabels.dateValue || safeDate(invoice.invoice_date), { width: COL_WIDTH, lineGap: 2 })
        .moveDown(0.5)

        .font("Helvetica-Bold").text(middleColumnLabels.numberLabel, { width: COL_WIDTH, lineGap: 2 })
        .font("Helvetica").text(middleColumnLabels.numberValue || textOrEmpty(invoice.invoice_number), { width: COL_WIDTH, lineGap: 2 })
        .moveDown(0.5)

        .font("Helvetica-Bold").text("Auction", { width: COL_WIDTH, lineGap: 2 })
        .font("Helvetica").text(`${formatAuctionName(invoice.auction, invoice)}${invoice.platform === 'private_sale' ? '' : (invoice.auction?.settlement_date ? ` (${safeDate(invoice.auction.settlement_date)})` : '')}`, { width: COL_WIDTH, lineGap: 2 })
        .moveDown(0.5);

    if (brand?.vat_number) {
        doc.font("Helvetica-Bold").text("VAT Number", { width: COL_WIDTH, lineGap: 2 })
            .font("Helvetica").text(textOrEmpty(brand?.vat_number), { width: COL_WIDTH, lineGap: 2 })
            .moveDown(0.5);
    }
    if (brand?.eori_number) {
        doc.font("Helvetica-Bold").text("EORI Number", { width: COL_WIDTH, lineGap: 2 })
            .font("Helvetica").text(textOrEmpty(brand?.eori_number), { width: COL_WIDTH, lineGap: 2 });
    }

    const col2Bottom = doc.y;

    // --- Right Column: Brand Info ---
    let brandText = `${brand?.name || ''}\n`;
    const brandAddress = brand?.brand_address ? String(brand.brand_address).split('\n') : [];
    brandAddress.forEach(line => (brandText += line.trim() + '\n'));
    if (brand?.contact_email) brandText += `\nEmail: ${brand.contact_email}\n`;
    if (brand?.contact_phone) brandText += `Phone: ${brand.contact_phone}\n`;
    doc.text(brandText, 370, startY, { width: COL_WIDTH, lineGap: 2 });
    const col3Bottom = doc.y;

    // Return the bottom Y position for table start
    return Math.max(col1Bottom, col2Bottom, col3Bottom);
}

// PDF generation function for buyer invoices
export function generateBuyerInvoicePDF(
    invoice: InvoiceData,
    brand: BrandData,
    type: InvoiceFormat,
    items: any[] = [],
    accessToken?: string
): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const chunks: Buffer[] = [];
            let pageNum = 1;
            let totalPages = 1;



            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Calculate amounts
            const totalAmount = calculateTotalAmount(invoice, type, brand);
            // Sum buyer premium prices directly from database (already includes VAT if applicable)
            const premiumPrices = invoice.buyer_premium_prices || [];
            const premiumAmount = premiumPrices.reduce((sum, price) => sum + price, 0);
            const dueAmount = calculateDueAmount(invoice, type, brand);

            // Use common header layout function (includes logo handling)
            const headerBottom = await addHeaderLayout(
                doc,
                invoice,
                brand,
                'INVOICE',
                'client',
                {
                    dateLabel: 'Invoice Date',
                    numberLabel: 'Invoice No'
                },
                brand.logo_url
            );

            // --- Dynamic Table Start ---
            const tableStartY = headerBottom + 30;

            // Table header - 50% Description, 5% gap, 20% VAT, 5% gap, 20% Amount
            doc.font("Helvetica-Bold").fontSize(8)
                .text("Description", 50, tableStartY + 5, { width: 250 })
            doc.text("VAT", 324, tableStartY + 5, { width: 100, align: "right" })
            doc.text("Amount GBP", 448, tableStartY + 5, { width: 100, align: "right" })

            // underline header
            doc.moveTo(50, tableStartY + 18).lineTo(550, tableStartY + 18).stroke()

            let currentY = tableStartY + 30


            // --- Items ---
            if (items && items.length > 0) {
                items.forEach((item: any, index: number) => {
                    const lotNumber = (invoice.lot_ids && invoice.lot_ids[index]) ? invoice.lot_ids[index] : (index + 1)
                    const blockText = item?.title ? `Lot ${lotNumber} - ${item.title}` : `Lot ${lotNumber}`

                    const blockHeight = doc.heightOfString(blockText, { width: 350, align: "left" })
                    const validBlockHeight = isNaN(blockHeight) ? 20 : blockHeight
                    if (createEnsureSpace(doc, currentY)(validBlockHeight + 20)) {
                        currentY = 50
                    }

                    const itemHammerPrice = invoice.sale_prices && invoice.sale_prices[index]
                        ? invoice.sale_prices[index]
                        : 0

                    // Validate itemHammerPrice to prevent NaN
                    const validItemHammerPrice = isNaN(itemHammerPrice) || !isFinite(itemHammerPrice) ? 0 : itemHammerPrice

                    // Calculate max height for all columns in this row (50% desc, 20% VAT, 20% amount)
                    const descriptionHeight = doc.heightOfString(blockText, { width: 250 })
                    const vatText = brand?.vat_number ? "M - Hammer (Buyer) 0% VAT" : "No VAT"
                    const vatHeight = doc.heightOfString(vatText, { width: 100 })
                    const priceHeight = doc.heightOfString(formatCurrency(validItemHammerPrice), { width: 100 })
                    const maxRowHeight = Math.max(descriptionHeight, vatHeight, priceHeight)

                    // Item description - normal font (50% width)
                    setNormal(doc, 8).text(blockText, 50, currentY, { width: 250 })
                    // VAT rate for items (20% width, positioned after 5% gap)
                    setNormal(doc, 8).text(vatText, 324, currentY, { width: 100, align: "right" })
                    // Item price - normal font (20% width, positioned after 5% gap)
                    setNormal(doc, 8).text(`${formatCurrency(validItemHammerPrice)}`, 448, currentY, { width: 100, align: "right" })

                    // add line after row (using max height)
                    currentY += maxRowHeight + 5
                    doc.moveTo(50, currentY).lineTo(550, currentY).stroke()
                    currentY += 5
                })
            } else {
                const singleText = `Lot ${textOrEmpty(invoice.lot_ids?.[0] || 'N/A')} Lot ID ${invoice.item_ids?.[0] || 'N/A'}`.trim()
                const blockHeight = doc.heightOfString(singleText, { width: 350 })
                const validSingleBlockHeight = isNaN(blockHeight) ? 10 : blockHeight
                if (createEnsureSpace(doc, currentY)(validSingleBlockHeight + 10)) {
                    currentY = 50
                }

                // Calculate max height for single item row (50% desc, 20% VAT, 20% amount)
                const singleDescriptionHeight = doc.heightOfString(singleText, { width: 250 })
                const singleVatText = brand?.vat_number ? "M - Hammer (Buyer) 0% VAT" : "No VAT"
                const singleVatHeight = doc.heightOfString(singleVatText, { width: 100 })
                const singleItemPrice = invoice.sale_prices && invoice.sale_prices[0]
                        ? invoice.sale_prices[0]
                        : 0
                const validSingleItemPrice = isNaN(singleItemPrice) || !isFinite(singleItemPrice) ? 0 : singleItemPrice
                const singlePriceHeight = doc.heightOfString(formatCurrency(validSingleItemPrice), { width: 100 })
                const singleMaxRowHeight = Math.max(singleDescriptionHeight, singleVatHeight, singlePriceHeight)

                // Single item description - normal font (50% width)
                setNormal(doc, 8).text(singleText, 50, currentY, { width: 250 })
                // VAT rate for single item (20% width, positioned after 5% gap)
                setNormal(doc, 8).text(singleVatText, 324, currentY, { width: 100, align: "right" })
                // Single item price - normal font (20% width, positioned after 5% gap)
                setNormal(doc, 8).text(`${formatCurrency(validSingleItemPrice)}`, 448, currentY, { width: 100, align: "right" })

                // line under single row (using max height)
                currentY += singleMaxRowHeight + 5
                doc.moveTo(50, currentY).lineTo(550, currentY).stroke()
                currentY += 5
            }

            // --- Buyer's Premium ---
            if (createEnsureSpace(doc, currentY)(40)) {
                currentY = 50
            }

            const buyerPremiumRate = invoice.client?.buyer_premium || 0
            const buyerPremiumText = `Buyer's Premium @ ${buyerPremiumRate}%`

            doc.fontSize(8)
                .font("Helvetica").text(buyerPremiumText, 50, currentY, { width: 250 })

            // Calculate max height for buyer's premium row (50% desc, 20% VAT, 20% amount)
            const bpDescriptionHeight = doc.heightOfString(buyerPremiumText, { width: 250 })

            // Show VAT breakdown
            const bpVatText = brand?.vat_number
                ? `M - Buyer's Premium VAT Inclusive`
                : "No VAT"
            const bpVatHeight = doc.heightOfString(bpVatText, { width: 100 })

            const bpPrice = formatCurrency(premiumAmount)
            const bpPriceHeight = doc.heightOfString(bpPrice, { width: 100 })
            const bpMaxRowHeight = Math.max(bpDescriptionHeight, bpVatHeight, bpPriceHeight)

            doc.text(bpVatText, 324, currentY, { width: 100, align: "right" })
            doc.text(bpPrice, 448, currentY, { width: 100, align: 'right' })

            // line under buyer's premium (using max height)
            currentY += bpMaxRowHeight + 5
            doc.moveTo(50, currentY).lineTo(550, currentY).stroke()
            currentY += 5

            // --- Delivery & Insurance ---
            if (type === 'final') {
                // Get logistics method from invoice (use new l_method field, fallback to old logistics_method)
                const logisticsMethod = (invoice as any).l_method || (invoice as any).logistics_method || 'metsab_courier'
                const baseShippingCost = Number(invoice.total_shipping_amount || 0)

                // Determine shipping cost and text based on logistics method
                let shippingCost = baseShippingCost
                let shippingText = 'Delivery and Freight Insurance [Refer to Collection & Shipping Notes below]'

                if (logisticsMethod === 'customer_collection') {
                    shippingCost = 0
                    shippingText = 'Customer Collection from Office'
                } else if (logisticsMethod === 'customer_courier') {
                    shippingCost = 0
                    shippingText = 'Customer Courier'
                } else {
                    // metsab_courier - use calculated shipping cost
                    shippingCost = baseShippingCost
                }

                // Calculate max height for shipping row (50% desc, 20% VAT, 20% amount)
                const shippingDescriptionHeight = doc.heightOfString(shippingText, { width: 250 })
                const shippingVatHeight = 0 // No VAT for shipping
                const shippingPriceHeight = doc.heightOfString(formatCurrency(shippingCost), { width: 100 })
                const shippingMaxRowHeight = Math.max(shippingDescriptionHeight, shippingVatHeight, shippingPriceHeight)

                doc.font("Helvetica").text(shippingText, 50, currentY, { width: 250 })
                doc.text("", 324, currentY, { width: 100, align: "right" })
                doc.text(`${formatCurrency(shippingCost)}`, 448, currentY, { width: 100, align: 'right' })

                // line under shipping/insurance row (using max height)
                currentY += shippingMaxRowHeight + 5
                doc.moveTo(50, currentY).lineTo(550, currentY).stroke()
                currentY += 5
            }

            // --- Invoice Total ---
            // Total amount is already calculated dynamically above using calculateTotalAmount function

            // top border line (half only, right side)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            doc.fontSize(8).font("Helvetica")
                .text('Invoice Total GBP', 350, currentY)
                .font("Helvetica").text(`${formatCurrency(totalAmount)}`, 450, currentY, { align: 'right' })
            currentY += 15
            // mid line (half only)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            doc.font("Helvetica")
                .text('Total Net Payments GBP', 350, currentY)
                .font("Helvetica").text(`${formatCurrency(invoice.paid_amount || 0)}`, 450, currentY, { align: 'right' })
            currentY += 15

            // mid line (half only)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            doc.font("Helvetica-Bold")
                .text('Amount Due GBP', 350, currentY)
                .font("Helvetica-Bold").text(`${formatCurrency(dueAmount)}`, 450, currentY, { align: 'right' })
            currentY += 15

            // final bottom border (half only)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            // Payment instructions
            if (createEnsureSpace(doc, currentY)(180)) {
                currentY = 50
            }
            currentY += 25
            const dueDateText = invoice.invoice_date ? (() => {
                const invoiceDate = new Date(invoice.invoice_date);
                const dueDate = new Date(invoiceDate);
                dueDate.setDate(dueDate.getDate() + 15);
                return `Due Date: ${safeDate(dueDate.toISOString())}`;
            })() : ''
            setBold(doc, TEXT_SIZE)
            doc.text(dueDateText, 50, currentY)
            currentY += 20
            setBold(doc, TEXT_SIZE)
            doc.text('INVOICE PAYMENT:', 50, currentY)
            currentY += 15
            setNormal(doc, TEXT_SIZE)
            doc.text('Payments must be made in GBP using one of the 2 options below, and quoting your invoice number above as your payment reference:', 50, currentY, { width: 500, align: 'justify' })
            currentY += 25

            // Online payment section with card logos
            // Helper function to add payment card logos


            // (1) Online payment section
            doc.font("Helvetica").text('(1) Online payment', 50, currentY)
            currentY += 15

            // Payment card logos (function will try PNG, JPG, JPEG formats)
            addPaymentLogo(doc, 'visa.png', 50, currentY)
            addPaymentLogo(doc, 'mastercard.jpg', 90, currentY)
            addPaymentLogo(doc, 'american-express.png', 130, currentY)
            currentY += 30 // Space for logos

            // Payment link - clickable blue underlined text (only if payment URL exists)
            const paymentUrl = invoice?.payment_link || ''
            if (paymentUrl && !isNaN(currentY) && isFinite(currentY)) {
                addHyperlink(doc, 'View and pay online now', paymentUrl, 50, currentY, { lineGap: 3 })
                currentY += 15
            }

            // Add public invoice link for client access
            const invoiceId = invoice.id

            if (!invoiceId) {
                console.error('No invoice ID available for public URL generation:', invoice)
            } else if (!accessToken) {
                console.error('No access token available for public URL generation:', invoice)
            } else {
                // Generate brand-specific URL with access token
                const publicInvoiceUrl = generateBrandSpecificUrl(brand, invoiceId, accessToken)
                console.log('Generated public invoice URL:', publicInvoiceUrl)

                if (publicInvoiceUrl && !isNaN(currentY) && isFinite(currentY)) {
                    const linkText = 'View invoice status and select shipping method'
                    addHyperlink(doc, linkText, publicInvoiceUrl, 50, currentY, { lineGap: 3 })
                    currentY += 15
                }
            }

            // Bank transfer section - dynamic bank accounts
            const bankAccounts = brand?.bank_accounts || []

            if (bankAccounts.length > 0) {
                bankAccounts.forEach((bank: BankAccount, index: number) => {
                    if (index === 0) {
                        doc.font("Helvetica").text(`(${index + 2}) Direct bank transfer to - Account name: ${bank.account_name}:`, 50, currentY, { width: 500, align: 'justify' })
                    } else {
                        doc.font("Helvetica").text(`(${index + 2}) Additional bank account - ${bank.account_name}:`, 50, currentY, { width: 500, align: 'justify' })
                    }
                    currentY += 15

                    // UK account information
                    if (bank.uk_info) {
                        doc.font("Helvetica").text(`(a) From a UK account - Bank: Revolut Business | Sort Code: ${bank.uk_info.sort_code} | Account Number: ${bank.uk_info.account_number}`, 70, currentY, { width: 450, align: 'justify' })
                        currentY += 15
                    }

                    // International payments information
                    if (bank.international_info) {
                        doc.font("Helvetica").text(`(a) International payments - IBAN: ${bank.international_info.iban} | BIC: ${bank.international_info.bic} | Intermediary BIC: ${bank.international_info.intermediary_bic}`, 70, currentY, { width: 450, align: 'justify' })
                        currentY += 15
                    }

                    currentY += 5 // Small gap between bank accounts
                })
            }

            // Add tracking link if tracking number exists
            const trackingNumber = invoice?.tracking_number || ''
            if (trackingNumber && trackingNumber.trim() !== '') {
                const trackingUrl = `https://parcelcompare.com/courierservices/searchtracking/${trackingNumber.trim()}`
                doc.font("Helvetica").text('(3) Track Your Order: ', 50, currentY, { lineGap: 3 })
                const textWidth = doc.widthOfString('(3) Track Your Order: ')
                addHyperlink(doc, trackingNumber.trim(), trackingUrl, 50 + textWidth, currentY, { lineGap: 3 })
                currentY += 15
            }

            // Footer
            const footerHeight = 20 // Approximate height needed for footer
            if (createEnsureSpace(doc, currentY)(footerHeight + 10)) {
                currentY = 50
            }
            currentY += 10

            // draw footer at current Y position
            totalPages = 2 // We know there will be 2 pages total
            addFooter(doc, brand, currentY, pageNum, totalPages)

            // Terms page
            doc.addPage()
            pageNum++

            // Render terms text with proper formatting and hyperlinks
            let termsY = 50

            // Validate termsY to prevent NaN errors
            if (isNaN(termsY) || !isFinite(termsY)) {
                termsY = 50
            }

            // Terms and Conditions - properly formatted in 3 lines
            const brandName = textOrEmpty(brand?.name) || ''
            const termsUrl = brand?.buyer_terms_and_conditions || brand?.terms_and_conditions || ''

            // Line 1: First part of the main text
            const line1 = `Buyer Premiums and all related charges for services made in connection with the sale are applied in accordance with applicable`
            doc.fontSize(TEXT_SIZE).font('Helvetica').text(line1, 50, termsY, {
                width: 500,
                lineGap: 3
            })
            termsY += doc.heightOfString(line1, { width: 500, lineGap: 3 }) + 3

            // Line 2: Second part with brand name and Terms and Conditions
            const line2 = `UK regulations, and per ${brandName || ''} Terms and Conditions which you were made aware before bidding for the above`
            doc.text(line2, 50, termsY, {
                width: 500,
                lineGap: 3
            })
            termsY += doc.heightOfString(line2, { width: 500, lineGap: 3 }) + 3

            // Line 3: Final part with awareness text
            const line3 = 'item(s).'
            doc.text(line3, 50, termsY, {
                width: 500,
                lineGap: 3
            })

            // Add URL after the text if available
            if (termsUrl && termsUrl.trim() !== '') {
                const line3Width = doc.widthOfString(line3)
                const urlX = 50 + (isNaN(line3Width) ? 0 : line3Width) + 5 // Add small gap
                addHyperlink(doc, termsUrl, termsUrl, urlX, termsY, { lineGap: 3 })
            }

            termsY += doc.heightOfString(line3, { width: 500, lineGap: 3 }) + 15

            // COLLECTION & SHIPPING section - bold heading
            setBold(doc, TEXT_SIZE)
            doc.text('COLLECTION & SHIPPING:', 50, termsY)
            termsY += 12

            // Collection & shipping content - normal font
            setNormal(doc, TEXT_SIZE)
            const collectionText = 'To let us know if you prefer to arrange your own shipping. We will remove the shipping and insurance costs from your order and coordinate with accordingly.'
            doc.text(collectionText, 50, termsY, {
                width: 500,
                lineGap: 3,
                align: 'justify'
            })
            termsY += doc.heightOfString(collectionText, { width: 500, lineGap: 3 }) + 10

            // Contact information with hyperlinks - only show available methods
            const email = textOrEmpty(brand?.contact_email) || ''
            const phoneNumber = textOrEmpty(brand?.contact_phone) || ''
            const whatsappNumber = textOrEmpty(brand?.business_whatsapp_number) || ''

            let contactMethods = []
            if (email) contactMethods.push({ type: 'email', value: email, url: `mailto:${email}` })
            if (phoneNumber) contactMethods.push({ type: 'phone', value: phoneNumber, url: `tel:${phoneNumber}` })
            if (whatsappNumber) contactMethods.push({ type: 'whatsapp', value: whatsappNumber, url: `https://wa.me/${whatsappNumber.replace(/\D/g, '')}` })

            if (contactMethods.length > 0) {
                let contactParts: string[] = []

                contactMethods.forEach((method, index) => {
                    let prefix = ''
                    if (method.type === 'email') {
                        prefix = index === 0 ? 'Please contact us on ' : ', or contact us on '
                    } else if (method.type === 'phone') {
                        prefix = index === 0 ? 'Please call us: ' : ', or call us: '
                    } else if (method.type === 'whatsapp') {
                        prefix = index === 0 ? 'Please message us on Business WhatsApp: ' : ', or message us on Business WhatsApp: '
                    }

                    contactParts.push(prefix)
                    contactParts.push(method.value)
                })

                // Join all parts and create the full contact line
                const fullContactLine = contactParts.join('')
                doc.text(fullContactLine, 50, termsY, { lineGap: 3 })

                // Add hyperlinks for each contact method
                let currentX = 50
                contactMethods.forEach((method, index) => {
                    let prefix = ''
                    if (method.type === 'email') {
                        prefix = index === 0 ? 'Please contact us on ' : ', or contact us on '
                    } else if (method.type === 'phone') {
                        prefix = index === 0 ? 'Please call us: ' : ', or call us: '
                    } else if (method.type === 'whatsapp') {
                        prefix = index === 0 ? 'Please message us on Business WhatsApp: ' : ', or message us on Business WhatsApp: '
                    }

                    const prefixWidth = doc.widthOfString(prefix)
                    currentX += prefixWidth

                    const methodWidth = doc.widthOfString(method.value)
                    addHyperlink(doc, method.value, method.url, currentX, termsY, { lineGap: 3 })
                    currentX += methodWidth
                })

                termsY += doc.heightOfString(fullContactLine, { width: 500, lineGap: 3 }) + 15
            }

            // Legal notice paragraph - justified alignment
            const legalNotice = `Note that as per clause 9.3 of our terms and conditions: " Buyers who intend to export the purchased lot must make their own arrangements to export in accordance with the applicable laws of the UK and the destination country". All international customs documentation costs are the responsibility of the buyer.`
            doc.text(legalNotice, 50, termsY, {
                width: 500,
                lineGap: 3,
                align: 'justify'
            })
            termsY += doc.heightOfString(legalNotice, { width: 500, lineGap: 3 }) + 15

            // Shipping details paragraph - justified alignment
            const shippingDetails = `Shipping by ${textOrEmpty(brand?.name) || ''} (at its sole discretion) will incur an additional cost (plus VAT at the Margin Scheme), depending on the shipping location and size/weight of the Item(s), plus Insurance (if requested by the buyer) as quoted by the shipping courier. In the event that ${textOrEmpty(brand?.name) || ''} arranges shipping for lot(s) to the buyer, ${textOrEmpty(brand?.name) || ''} assumes no responsibility (and any liability arising therefrom) for items damaged, lost, stolen or otherwise not in the advertised condition upon reaching its destination.`
            doc.text(shippingDetails, 50, termsY, {
                width: 500,
                lineGap: 3,
                align: 'justify'
            })
            termsY += doc.heightOfString(shippingDetails, { width: 500, lineGap: 3 }) + 15

            // Final notice paragraph - justified alignment
            const finalNotice = `Should this invoice include the standard shipping and related insurance costs, and you decide to arrange your own shipping as per clause 9.3 above, please contact us and we will remove this cost and re-issue a revised invoice for you.`
            doc.text(finalNotice, 50, termsY, {
                width: 500,
                lineGap: 3,
                align: 'justify'
            })

            // Add footer at bottom of terms page
            addFooter(doc, brand, undefined, pageNum, totalPages)

            doc.end()
        } catch (error) {
            reject(error)
        }
    })
}

// PDF generation function for vendor invoices
export function generateVendorInvoicePDF(
    invoice: InvoiceData,
    brand: BrandData,
    type: InvoiceFormat,
    items: any[] = [],
    accessToken?: string
): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 })
            const chunks: Buffer[] = []
            const PAGE_WIDTH = 500
            const COL_WIDTH = PAGE_WIDTH / 3 - 10
            const TEXT_SIZE = 8
            let pageNum = 1
            let totalPages = 1



            doc.on('data', (chunk: Buffer) => chunks.push(chunk))
            doc.on('end', () => resolve(Buffer.concat(chunks)))
            doc.on('error', reject)

            // Calculate amounts
            const totalAmount = calculateTotalAmount(invoice, type, brand)
            // Sum vendor premium prices directly from database (already includes VAT if applicable)
            const premiumPrices = invoice.buyer_premium_prices || []
            const premiumAmount = premiumPrices.reduce((sum, price) => sum + price, 0)
            const dueAmount = calculateDueAmount(invoice, type, brand)

            // Use common header layout function (includes logo handling)
            const headerBottom = await addHeaderLayout(
                doc,
                invoice,
                brand,
                'SELLER STATEMENT & REMITTANCE',
                'vendor',
                {
                    dateLabel: 'Statement Date',
                    numberLabel: 'Statement Number'
                },
                brand.logo_url
            )

            // --- Dynamic Table Start ---
            const tableStartY = headerBottom + 30

            // Table header - 50% Description, 5% gap, 20% VAT, 5% gap, 20% Amount
            doc.font("Helvetica-Bold").fontSize(8)
                .text("Description", 50, tableStartY + 5, { width: 250 })
            doc.text("VAT", 324, tableStartY + 5, { width: 100, align: "right" })
            doc.text("Amount GBP", 448, tableStartY + 5, { width: 100, align: "right" })

            // underline header
            doc.moveTo(50, tableStartY + 18).lineTo(550, tableStartY + 18).stroke()

            let currentY = tableStartY + 30


            // --- Items ---
            if (items && items.length > 0) {
                items.forEach((item: any, index: number) => {
                    const lotNumber = (invoice.lot_ids && invoice.lot_ids[index]) ? invoice.lot_ids[index] : (index + 1)
                    const lines: string[] = []
                    const title = item?.title ? `Lot ${lotNumber} - ${item.title}` : `Lot ${lotNumber}`
                    lines.push(title)

                    const blockText = lines.join("\n")
                    const blockHeight = doc.heightOfString(blockText, { width: 350, align: "left" })
                    const validBlockHeight = isNaN(blockHeight) ? 20 : blockHeight
                    if (createEnsureSpace(doc, currentY)(validBlockHeight + 20)) {
                        currentY = 50
                    }

                    const itemHammerPrice = invoice.sale_prices && invoice.sale_prices[index]
                        ? invoice.sale_prices[index]
                        : 0

                    // Validate itemHammerPrice to prevent NaN
                    const validItemHammerPrice = isNaN(itemHammerPrice) || !isFinite(itemHammerPrice) ? 0 : itemHammerPrice

                    // Calculate max height for all columns in this row (50% desc, 20% VAT, 20% amount)
                    const descriptionHeight = doc.heightOfString(blockText, { width: 250 })
                    const vatText = brand?.vat_number ? "M - Hammer (Vendor) 0% VAT" : "No VAT"
                    const vatHeight = doc.heightOfString(vatText, { width: 100 })
                    const priceHeight = doc.heightOfString(formatCurrency(validItemHammerPrice), { width: 100 })
                    const maxRowHeight = Math.max(descriptionHeight, vatHeight, priceHeight)

                    // Item description - normal font (50% width)
                    setNormal(doc, 8).text(blockText, 50, currentY, { width: 250 })
                    // VAT rate for items (20% width, positioned after 5% gap)
                    setNormal(doc, 8).text(vatText, 324, currentY, { width: 100, align: "right" })
                    // Item price - normal font (20% width, positioned after 5% gap)
                    setNormal(doc, 8).text(`${formatCurrency(validItemHammerPrice)}`, 448, currentY, { width: 100, align: "right" })

                    // add line after row (using max height)
                    currentY += maxRowHeight + 5
                    doc.moveTo(50, currentY).lineTo(550, currentY).stroke()
                    currentY += 5
                })
            } else {
                const singleText = `Lot ${textOrEmpty(invoice.lot_ids?.[0] || 'N/A')} Lot ID ${invoice.item_ids?.[0] || 'N/A'}`.trim()
                const blockHeight = doc.heightOfString(singleText, { width: 350 })
                const validSingleBlockHeight = isNaN(blockHeight) ? 10 : blockHeight
                if (createEnsureSpace(doc, currentY)(validSingleBlockHeight + 10)) {
                    currentY = 50
                }

                // Calculate max height for single item row (50% desc, 20% VAT, 20% amount)
                const singleDescriptionHeight = doc.heightOfString(singleText, { width: 250 })
                const singleVatText = brand?.vat_number ? "M - Hammer (Vendor) 0% VAT" : "No VAT"
                const singleVatHeight = doc.heightOfString(singleVatText, { width: 100 })
                const singleItemPrice = invoice.sale_prices && invoice.sale_prices[0]
                        ? invoice.sale_prices[0]
                        : 0
                const validSingleItemPrice = isNaN(singleItemPrice) || !isFinite(singleItemPrice) ? 0 : singleItemPrice
                const singlePriceHeight = doc.heightOfString(formatCurrency(validSingleItemPrice), { width: 100 })
                const singleMaxRowHeight = Math.max(singleDescriptionHeight, singleVatHeight, singlePriceHeight)

                // Single item description - normal font (50% width)
                setNormal(doc, TEXT_SIZE).text(singleText, 50, currentY, { width: 250 })
                // VAT rate for single item (20% width, positioned after 5% gap)
                setNormal(doc, TEXT_SIZE).text(singleVatText, 324, currentY, { width: 100, align: "right" })
                // Single item price - normal font (20% width, positioned after 5% gap)
                setNormal(doc, TEXT_SIZE).text(`${formatCurrency(validSingleItemPrice)}`, 448, currentY, { width: 100, align: "right" })

                // line under single row (using max height)
                currentY += singleMaxRowHeight + 5
                doc.moveTo(50, currentY).lineTo(550, currentY).stroke()
                currentY += 5
            }

            // --- Seller's Premium (for vendor invoices, this is what the auction house takes) ---
            if (createEnsureSpace(doc, currentY)(40)) {
                currentY = 50
            }

            const vendorPremiumRate = invoice.client?.vendor_premium || 0
            const premiumText = `Vendor's Premium @ ${vendorPremiumRate}%`

            doc.fontSize(8)
                .font("Helvetica").text(premiumText, 50, currentY, { width: 250 })

            // Calculate max height for vendor's premium row (50% desc, 20% VAT, 20% amount)
            const scDescriptionHeight = doc.heightOfString(premiumText, { width: 250 })

            // Show VAT breakdown
            const scVatText = brand?.vat_number
                ? `M - Vendor's Premium VAT Inclusive`
                : "No VAT"
            const scVatHeight = doc.heightOfString(scVatText, { width: 100 })

            const scPrice = formatCurrency(premiumAmount)
            const scPriceHeight = doc.heightOfString(scPrice, { width: 100 })
            const scMaxRowHeight = Math.max(scDescriptionHeight, scVatHeight, scPriceHeight)

            doc.text(scVatText, 324, currentY, { width: 100, align: "right" })
            doc.text(scPrice, 448, currentY, { width: 100, align: 'right' })

            // line under vendor's premium (using max height)
            currentY += scMaxRowHeight + 5
            doc.moveTo(50, currentY).lineTo(550, currentY).stroke()
            currentY += 5

            // --- Invoice Total ---
            // Total amount is already calculated dynamically above using calculateTotalAmount function

            // top border line (half only, right side)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            doc.fontSize(8).font("Helvetica")
                .text('Statement Total GBP', 350, currentY)
                .font("Helvetica").text(`${formatCurrency(totalAmount)}`, 450, currentY, { align: 'right' })
            currentY += 15
            // mid line (half only)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            doc.font("Helvetica")
                .text('Total Net Payments GBP', 350, currentY)
                .font("Helvetica").text(`${formatCurrency(invoice.paid_amount || 0)}`, 450, currentY, { align: 'right' })
            currentY += 15

            // mid line (half only)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            // Get client name for "Amount Payable to"
            // For vendor invoices, prioritize company name if available
            let clientName = ''
            if (invoice.client) {
                if (invoice.client.company_name) {
                    clientName = invoice.client.company_name
                } else {
                    clientName = `${invoice.client.first_name || ''} ${invoice.client.last_name || ''}`.trim()
                }
            } else {
                clientName = `${invoice.buyer_first_name || ''} ${invoice.buyer_last_name || ''}`.trim()
            }

            // Amount Payable to section starting from same position as Total Net Payments (x=350) with multi-line support
            const payableToText = `Amount Payable to ${clientName} GBP`
            const payableToHeight = doc.heightOfString(payableToText, { width: 140 })
            const amountTextHeight = doc.heightOfString(formatCurrency(dueAmount), { width: 100 })
            const maxPayableToHeight = Math.max(payableToHeight, amountTextHeight)

            doc.font("Helvetica-Bold")
                .text(payableToText, 350, currentY, { width: 140 })
                .font("Helvetica-Bold").text(`${formatCurrency(dueAmount)}`, 450, currentY, { align: 'right' })

            currentY += maxPayableToHeight + 5

            // final bottom border (half only)
            doc.moveTo(300, currentY).lineTo(550, currentY).stroke()
            currentY += 10

            // Payment instructions
            if (createEnsureSpace(doc, currentY)(100)) {
                currentY = 50
            }
            currentY += 25
            const dueDateText = invoice.invoice_date ? `Due Date: ${safeDate(invoice.invoice_date)}` : ''
            // Simple one-line terms statement
            currentY += 20
            const vendorTermsUrl = brand?.vendor_terms_and_conditions || brand?.terms_and_conditions || ''

            const termsText = 'All transactions are in accordance with our terms and conditions at'
            doc.fontSize(TEXT_SIZE).font('Helvetica').text(termsText, 50, currentY, { lineGap: 3 })

            // Add clickable URL after the text
            if (vendorTermsUrl && vendorTermsUrl.trim() !== '') {
                const textWidth = doc.widthOfString(termsText)
                const urlX = 50 + textWidth + 5 // Add small gap
                addHyperlink(doc, vendorTermsUrl, vendorTermsUrl, urlX, currentY, { lineGap: 3 })
            }

            // Add client banking information section for auction house use only
            if (createEnsureSpace(doc, currentY)(80)) {
                currentY = 50
            }
            currentY += 30

            // "For auction house use only" section
            setBold(doc, TEXT_SIZE)
            doc.text('FOR AUCTION HOUSE USE ONLY:', 50, currentY)
            currentY += 15

            setNormal(doc, TEXT_SIZE)

            // Add client bank account details if available
            let bankInfoAdded = false
            if (invoice.client?.bank_account_details) {
                doc.text(`(a) Bank Account Details: ${invoice.client.bank_account_details}`, 50, currentY, {
                    width: 450,
                    lineGap: 3,
                    align: 'justify'
                })
                const bankDetailsHeight = doc.heightOfString(invoice.client.bank_account_details, { width: 450, lineGap: 3 })
                currentY += bankDetailsHeight + 10
                bankInfoAdded = true
            }

            // Add client bank address if available
            if (invoice.client?.bank_address) {
                doc.text(`(b) Bank Address: ${invoice.client.bank_address}`, 50, currentY, {
                    width: 450,
                    lineGap: 3,
                    align: 'justify'
                })
                const bankAddressHeight = doc.heightOfString(invoice.client.bank_address, { width: 450, lineGap: 3 })
                currentY += bankAddressHeight + 10
                bankInfoAdded = true
            }

            // If no bank information available, show a note
            if (!bankInfoAdded) {
                doc.text('No client banking information available in records.', 50, currentY, {
                    width: 450,
                    lineGap: 3,
                    align: 'justify'
                })
                currentY += 20
            }

            // Footer
            const footerHeight = 40 // Space for banking info and footer
            currentY += 20

            // draw footer at current Y position
            totalPages = 1 // Vendor statements are single page
            addFooter(doc, brand, currentY, pageNum, totalPages)

            doc.end()
        } catch (error) {
            reject(error)
        }
    })
}

// Footer function
function addFooter(doc: PDFKit.PDFDocument, brand: BrandData, y?: number, currentPage?: number, totalPages?: number) {
    const footerY = (doc.page.height - 100) // Give more space at bottom
    const pageWidth = doc.page.width

    doc.fontSize(7.5).font('Helvetica')

    // Company Registration and Office (single centered line)
    const registrationText = `Company Registration No: ${brand?.company_registration || ''}. Registered Office: ${brand?.brand_address ? String(brand.brand_address).replace(/\n/g, ', ') : ''}`
    const registrationWidth = doc.widthOfString(registrationText)
    const registrationHeight = doc.heightOfString(registrationText, { width: registrationWidth, lineGap: 2 })
    const registrationCenterX = (pageWidth - registrationWidth) / 2
    doc.text(registrationText, registrationCenterX, footerY, { align: 'center', lineGap: 2 })

    // Line 2 - Page X of Y (right aligned, positioned after registration text height)
    const displayPageNum = currentPage || 1
    const displayTotalPages = totalPages || 1
    const pageY = footerY + registrationHeight // 4px padding after registration text

    // Calculate positions for bold numbers
    const prefixText = 'Page '
    const ofText = ' of '
    const prefixWidth = doc.widthOfString(prefixText)
    const ofWidth = doc.widthOfString(ofText)

    // Right align the entire "Page X of Y" text
    const totalPageTextWidth = prefixWidth + doc.widthOfString(displayPageNum.toString()) + ofWidth + doc.widthOfString(displayTotalPages.toString())
    const pageRightX = pageWidth - 50 - totalPageTextWidth

    // Draw prefix
    doc.text(prefixText, pageRightX, pageY, { lineGap: 2 })

    // Draw page number in bold
    const pageNumX = pageRightX + prefixWidth
    doc.font('Helvetica-Bold').text(displayPageNum.toString(), pageNumX, pageY)
    doc.font('Helvetica') // Reset to normal

    // Draw "of"
    const ofX = pageNumX + doc.widthOfString(displayPageNum.toString())
    doc.text(ofText, ofX, pageY)

    // Draw total pages in bold
    const totalPagesX = ofX + ofWidth
    doc.font('Helvetica-Bold').text(displayTotalPages.toString(), totalPagesX, pageY)
    doc.font('Helvetica') // Reset to normal
}

// Helper function to generate secure brand-specific public URLs
function generateBrandSpecificUrl(brand: BrandData | undefined, invoiceId: number, accessToken: string): string {
    const defaultUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:3000'

    if (!brand?.code) {
        console.log('No brand code found, using default URL:', defaultUrl)
        return `${defaultUrl}/invoice/${invoiceId}/${accessToken}`
    }

    const brandCode = brand.code.toUpperCase()

    // Generate brand-specific URLs
    let brandUrl: string
    switch (brandCode) {
        case 'AURUM':
            brandUrl = process.env.PUBLIC_FRONTEND_URL_AURUM || 'http://localhost:3002'
            break
        case 'METSAB':
            brandUrl = process.env.PUBLIC_FRONTEND_URL_METSAB || 'http://localhost:3003'
            break
        default:
            console.log('Unknown brand code, using default URL:', brandCode)
            brandUrl = defaultUrl
    }

    const finalUrl = `${brandUrl}/invoice/${invoiceId}/${accessToken}`
    console.log('Generated secure public URL:', finalUrl, 'for brand:', brandCode)
    return finalUrl
}

// Helper function to format currency
function formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
        minimumFractionDigits: 2
    }).format(amount)
}
