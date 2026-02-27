// backend/src/utils/consignment-pdf-generator.ts

/**
 * PDF generation utilities for consignment documents using PDFKit
 * Replaces frontend react-pdf components with backend generation
 */

import * as fs from 'fs';
import * as path from 'path';

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

// Types and interfaces
export type BrandCode = 'MSABER' | 'FINEART' | 'MODERN' | string;

export interface ConsignmentItem {
    id: string;
    lot_number?: string;
    title: string;
    description: string;
    artist_name?: string;
    school_name?: string;
    dimensions?: string;
    condition?: string;
    low_est?: number;
    high_est?: number;
    reserve?: number;
    vendor_commission?: number;
    goods_received?: boolean;
}

export interface AuctionItem extends ConsignmentItem {
    auction_date?: string;
    sale_name?: string;
}

export interface ReturnedItem extends ConsignmentItem {
    return_reason?: string;
    return_date: string;
    location?: string;
}

export interface Client {
    id: number;
    first_name: string;
    last_name: string;
    company_name?: string;
    email?: string;
    phone_number?: string;
    billing_address1?: string;
    billing_address2?: string;
    billing_address3?: string;
    billing_city?: string;
    billing_post_code?: string;
    billing_region?: string;
    billing_country?: string;
    vendor_premium?: number;
}

export interface Consignment {
    id: string;
    consignment_number: string;
    receipt_no?: string;
    created_at: string;
    signing_date?: string;
    specialist_name?: string;
    reference?: string; // New field
    reference_commission?: number; // New field
    items_count?: number;
    total_estimated_value?: number;
    released_by_staff?: string;
    consignment_receipt_date?: string | null; // Calculated date (1 month back from auction)
    pre_sale_date?: string | null; // Calculated date (15 days back from auction)
    consignor_signature?: string;
received_by_signature?: string;

}

export interface SaleDetails {
    sale_name: string;
    sale_date: string;
    sale_location: string;
    viewing_dates?: string[];
}

export interface BrandData {
    id?: number;
    name?: string;
    code?: string;
    company_registration?: string;
    contact_email?: string;
    contact_phone?: string;
    vat_number?: string;
    brand_address?: string;
    logo_url?: string;
    terms_and_conditions?: string;
    vendor_terms_and_conditions?: string;
}

export interface PDFCustomization {
    includeHeader: boolean;
    includeFooter: boolean;
    includeLogo: boolean;
    includeClientDetails: boolean;
    includeItemDetails: boolean;
    includeSpecialistInfo: boolean;
    includeSignatures: boolean;
    includeTermsConditions: boolean;
    headerText: string;
    footerText: string;
    documentTitle: string;
    customNotes: string;
    fontSize: 'small' | 'medium' | 'large';
    orientation: 'portrait' | 'landscape';
    paperSize: 'A4' | 'A3' | 'Letter';
    margin: 'small' | 'medium' | 'large';
    branding: 'minimal' | 'standard' | 'full';
}

// Constants
const TEXT_SIZE = 8;
const HEADER_SIZE = 14;
const TITLE_SIZE = 20;
const PAGE_WIDTH = 500;
const COL_WIDTH = PAGE_WIDTH / 3 - 10;
const MARGIN = 50;

// Font helpers
const setNormal = (doc: PDFKit.PDFDocument, size = TEXT_SIZE) =>
    doc.font("Helvetica").fontSize(size);

const setBold = (doc: PDFKit.PDFDocument, size = TEXT_SIZE) =>
    doc.font("Helvetica-Bold").fontSize(size);

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

// Utility functions
const formatDate = (dateString: string): string => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
};

const safeDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    return date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
};

const formatCurrency = (amount: number | null | undefined): string => {
    if (amount === null || amount === undefined || isNaN(amount)) {
        return '£0';
    }
    return `£${amount.toLocaleString()}`;
};

const textOrEmpty = (v?: string) => (v ? String(v) : '');

// Page layout helpers
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

// Common header layout function for consignment documents (matching invoice layout)
async function addConsignmentHeader(
    doc: PDFKit.PDFDocument,
    brand: BrandData,
    title: string,
    client: Client,
    consignment: Consignment,
    middleColumnLabels: {
        dateLabel: string;
        numberLabel: string;
        dateValue?: string;
        numberValue?: string;
        additionalInfo?: string;
    }
): Promise<number> {

    // Attempt to embed brand logo in top-right corner
    if (brand?.logo_url) {
        try {
            const resp = await fetch(brand?.logo_url);
            if (resp.ok) {
                const arr = await resp.arrayBuffer();
                const buf = Buffer.from(arr);
                // Place top-right with max 70x70 (matching invoice layout)
                doc.image(buf, 500, 40, { fit: [70, 70], align: 'right' });
            }
        } catch (e) {
            console.log('Could not load brand logo from URL:', e);
        }
    }

    // --- Title ---
    doc.fillColor('black').fontSize(20).text(title, 50, 40);

    // === 3 Column Layout (matching invoice layout) ===
    const startY = 120;

    // --- Left Column: Client Info ---
    const brandPrefix = (brand?.code || '').slice(0, 3).toUpperCase();
    const clientNumber = client.id
        ? `${brandPrefix}-${String(client.id).padStart(3, '0')}`
        : '';

    let clientText = '';

    // Client name (prioritize company name if available for vendors)
    if (client.company_name) {
        clientText += `${client.company_name}\n`;
        clientText += `${client.first_name || ''} ${client.last_name || ''}\n`;
    } else {
        clientText += `${client.first_name || ''} ${client.last_name || ''}\n`;
    }

    // Add client address
    if (client.billing_address1) clientText += client.billing_address1 + '\n';
    if (client.billing_address2) clientText += client.billing_address2 + '\n';
    if (client.billing_address3) clientText += client.billing_address3 + '\n';
    if (client.billing_city) clientText += client.billing_city + '\n';
    if (client.billing_region) clientText += client.billing_region + '\n';
    if (client.billing_country) clientText += client.billing_country + '\n';
    if (client.billing_post_code) clientText += client.billing_post_code + '\n';

    // Add client number
    if (clientNumber) clientText += `\nClient Number: ${clientNumber}\n`;

    // Add contact details
    if (client.email) {
        clientText += `Email: ${client.email}\n`;
    }
    if (client.phone_number) {
        clientText += `Phone: ${client.phone_number}`;
    }

    doc.fontSize(TEXT_SIZE).text(clientText, 50, startY, { width: COL_WIDTH, lineGap: 2 });
    const col1Bottom = doc.y;

    // --- Middle Column: Document Info ---
    doc.fontSize(TEXT_SIZE)
        .font("Helvetica-Bold").text(middleColumnLabels.dateLabel, 210, startY, { width: COL_WIDTH, lineGap: 2 })
        .font("Helvetica").text(middleColumnLabels.dateValue || safeDate(consignment.created_at), { width: COL_WIDTH, lineGap: 2 })
        .moveDown(0.5)

        .font("Helvetica-Bold").text(middleColumnLabels.numberLabel, { width: COL_WIDTH, lineGap: 2 })
        .font("Helvetica").text(middleColumnLabels.numberValue || textOrEmpty(consignment.consignment_number), { width: COL_WIDTH, lineGap: 2 })
        .moveDown(0.5);

    // Additional info if provided
    if (middleColumnLabels.additionalInfo) {
        doc.font("Helvetica-Bold").text("Reference", { width: COL_WIDTH, lineGap: 2 })
            .font("Helvetica").text(middleColumnLabels.additionalInfo, { width: COL_WIDTH, lineGap: 2 })
            .moveDown(0.5);
    }

    // Specialist info
    if (consignment.specialist_name) {
        doc.font("Helvetica-Bold").text("Specialist", { width: COL_WIDTH, lineGap: 2 })
            .font("Helvetica").text(textOrEmpty(consignment.specialist_name), { width: COL_WIDTH, lineGap: 2 })
            .moveDown(0.5);
    }

    // VAT Number if available
    if (brand?.vat_number) {
        doc.font("Helvetica-Bold").text("VAT Number", { width: COL_WIDTH, lineGap: 2 })
            .font("Helvetica").text(textOrEmpty(brand?.vat_number), { width: COL_WIDTH, lineGap: 2 })
            .moveDown(0.5);
    }

    // Company Registration Number if available
    if (brand?.company_registration) {
        doc.font("Helvetica-Bold").text("Reg No", { width: COL_WIDTH, lineGap: 2 })
            .font("Helvetica").text(textOrEmpty(brand?.company_registration), { width: COL_WIDTH, lineGap: 2 })
            .moveDown(0.5);
    }

    const col2Bottom = doc.y;

    // --- Right Column: Brand Info ---
    let brandText = `${brand?.name || ''}\n`;
    const brandAddress = brand?.brand_address ? String(brand?.brand_address).split('\n') : [];
    brandAddress.forEach(line => (brandText += line.trim() + '\n'));
    if (brand?.contact_email) brandText += `\nEmail: ${brand.contact_email}\n`;
    if (brand?.contact_phone) brandText += `Phone: ${brand.contact_phone}\n`;
    doc.text(brandText, 370, startY, { width: COL_WIDTH, lineGap: 2 });
    const col3Bottom = doc.y;

    // Return the bottom Y position for table start
    return Math.max(col1Bottom, col2Bottom, col3Bottom);
}


// Items table for consignment documents
function addItemsTable(
    doc: PDFKit.PDFDocument,
    items: ConsignmentItem[],
    type: 'receipt' | 'presale' | 'collection',
    y: number,
    clientCommissionRate?: number,
    referenceCommissionRate?: number,
    hasReference?: boolean
): number {
    let currentY = y;

    // Calculate column widths based on table width (500px from x=50 to x=550)
    const tableWidth = 500;
    const colWidths = hasReference ? {
        itemId: tableWidth * 0.08,     // 8%
        description: tableWidth * 0.35, // 35%
        auctionComm: tableWidth * 0.12, // 12%
        refComm: tableWidth * 0.125,    // 12.5%
        reserve: tableWidth * 0.125,    // 12.5%
        estimate: tableWidth * 0.20     // 20%
    } : {
        itemId: tableWidth * 0.08,     // 8%
        description: tableWidth * 0.35, // 45%
        auctionComm: tableWidth * 0.12, // 12%
        reserve: tableWidth * 0.125,    // 12.5%
        estimate: tableWidth * 0.225    // 22.5% (remaining)
    };

    // Calculate column positions
    const colPositions = {
        itemId: 50,
        description: 50 + colWidths.itemId,
        auctionComm: 50 + colWidths.itemId + colWidths.description,
        refComm: hasReference ? 50 + colWidths.itemId + colWidths.description + colWidths.auctionComm : 0,
        reserve: hasReference ?
            50 + colWidths.itemId + colWidths.description + colWidths.auctionComm + (colWidths as any).refComm :
            50 + colWidths.itemId + colWidths.description + colWidths.auctionComm,
        estimate: hasReference ?
            50 + colWidths.itemId + colWidths.description + colWidths.auctionComm + (colWidths as any).refComm + colWidths.reserve :
            50 + colWidths.itemId + colWidths.description + colWidths.auctionComm + colWidths.reserve
    };

    // Calculate header height for multi-line text
    const headerHeight = hasReference ? 30 : 20; // Extra height for multi-line headers

    // Table header with gray background
    doc.rect(50, currentY, tableWidth, headerHeight).fillColor('#f0f0f0').fill();
    doc.fillColor('black');

    setBold(doc, 8).fillColor('#444444');

    if (type === 'receipt') {
        if (hasReference) {
            // Layout with Reference Commission column (multi-line headers)
            // Item ID: 8%, Description: 35%, Effective Commission: 12%, Reference Commission: 12.5%, Reserve: 12.5%, Estimate: 20%
            doc.text('ID', colPositions.itemId, currentY + 6, { width: colWidths.itemId, align: 'center' });
            doc.text('Description', colPositions.description, currentY + 6, { width: colWidths.description, align: 'left' });

            // Multi-line effective commission header
            doc.text('Auction', colPositions.auctionComm, currentY + 3, { width: colWidths.auctionComm, align: 'right' });
            doc.text('Commission %', colPositions.auctionComm, currentY + 13, { width: colWidths.auctionComm, align: 'right' });

            // Multi-line reference commission header
            doc.text('Reference', colPositions.refComm, currentY + 3, { width: (colWidths as any).refComm, align: 'right' });
            doc.text('Commission %', colPositions.refComm, currentY + 13, { width: (colWidths as any).refComm, align: 'right' });

            doc.text('Reserve', colPositions.reserve, currentY + 6, { width: colWidths.reserve, align: 'right' });
            doc.text('Estimate', colPositions.estimate, currentY + 6, { width: colWidths.estimate, align: 'right' });
        } else {
            // Original layout without Reference Commission
            doc.text('ID', colPositions.itemId, currentY + 6, { width: colWidths.itemId, align: 'center' });
            doc.text('Description', colPositions.description, currentY + 6, { width: colWidths.description, align: 'left' });
            doc.text('Commission %', colPositions.auctionComm, currentY + 6, { width: colWidths.auctionComm, align: 'right' });
            doc.text('Reserve', colPositions.reserve, currentY + 6, { width: colWidths.reserve, align: 'right' });
            doc.text('Estimate', colPositions.estimate, currentY + 6, { width: colWidths.estimate, align: 'right' });
        }
    } else if (type === 'presale') {
        if (hasReference) {
            // Layout with Reference Commission column (multi-line headers)
            // Item ID: 8%, Description: 35%, Effective Commission: 12%, Reference Commission: 12.5%, Reserve: 12.5%, Estimate: 20%
            doc.text('ID', colPositions.itemId, currentY + 6, { width: colWidths.itemId, align: 'center' });
            doc.text('Description', colPositions.description, currentY + 6, { width: colWidths.description, align: 'left' });

            // Multi-line effective commission header
            doc.text('Auction', colPositions.auctionComm, currentY + 3, { width: colWidths.auctionComm, align: 'right' });
            doc.text('Commission %', colPositions.auctionComm, currentY + 13, { width: colWidths.auctionComm, align: 'right' });

            // Multi-line reference commission header
            doc.text('Reference', colPositions.refComm, currentY + 3, { width: (colWidths as any).refComm, align: 'right' });
            doc.text('Commission %', colPositions.refComm, currentY + 13, { width: (colWidths as any).refComm, align: 'right' });

            doc.text('Reserve', colPositions.reserve, currentY + 6, { width: colWidths.reserve, align: 'right' });
            doc.text('Estimates', colPositions.estimate, currentY + 6, { width: colWidths.estimate, align: 'right' });
        } else {
            // Original layout without Reference Commission
            doc.text('ID', colPositions.itemId, currentY + 6, { width: colWidths.itemId, align: 'center' });
            doc.text('Description', colPositions.description, currentY + 6, { width: colWidths.description, align: 'left' });
            doc.text('Vendor Comm %', colPositions.auctionComm, currentY + 6, { width: colWidths.auctionComm, align: 'right' });
            doc.text('Reserve', colPositions.reserve, currentY + 6, { width: colWidths.reserve, align: 'right' });
            doc.text('Estimates', colPositions.estimate, currentY + 6, { width: colWidths.estimate, align: 'right' });
        }
    } else if (type === 'collection') {
        doc.text('Unique ID', 55, currentY + 6, { width: 80, align: 'right' });
        doc.text('Return Date', 140, currentY + 6, { width: 80, align: 'right' });
        doc.text('Return Reason', 225, currentY + 6, { width: 60, align: 'right' });
        doc.text('Description', 290, currentY + 6, { width: 220, align: 'left' });
    }

    doc.fillColor('black');
    currentY += headerHeight;

    // Bottom border of header
    doc.moveTo(50, currentY).lineTo(550, currentY).strokeColor('#cccccc').stroke();
    doc.strokeColor('black');
    currentY += 5;

    // Items
    items.forEach((item, index) => {
        const itemStartY = currentY;
        let maxRowHeight = 0;

        setNormal(doc, 8);

        if (type === 'receipt' || type === 'presale') {
            // Calculate the height needed for description text
            const descriptionText = item.title || item.description || '';
            const descriptionHeight = doc.heightOfString(descriptionText, {
                width: colWidths.description - 5, // Small padding
                lineGap: 2
            });

            // Calculate minimum row height (at least 25px for readability)
            const minRowHeight = 25;
            const calculatedRowHeight = Math.max(minRowHeight, descriptionHeight + 10); // 10px padding
            maxRowHeight = calculatedRowHeight;

            if (hasReference) {
                // Item ID
                doc.text(item.id || '-', colPositions.itemId, currentY, {
                    width: colWidths.itemId,
                    align: 'center'
                });

                // Description (multi-line capable)
                setBold(doc, 8).text(descriptionText, colPositions.description, currentY, {
                    width: colWidths.description - 5, // Small padding to prevent edge overlap
                    lineGap: 2
                });

                // Commission %
                const effectiveCommission = hasReference
                    ? (clientCommissionRate || 0) - (referenceCommissionRate || 0)
                    : (clientCommissionRate || 0);
                setNormal(doc, 8).text(`${effectiveCommission}%`, colPositions.auctionComm, currentY, {
                    width: colWidths.auctionComm,
                    align: 'right'
                });

                // Reference Commission %
                doc.text(`${referenceCommissionRate || 0}%`, colPositions.refComm, currentY, {
                    width: (colWidths as any).refComm,
                    align: 'right'
                });

                // Reserve
                doc.text(item.reserve ? formatCurrency(item.reserve) : '-', colPositions.reserve, currentY, {
                    width: colWidths.reserve,
                    align: 'right'
                });

                // Estimate
                if (item.low_est && item.high_est) {
                    doc.text(`${formatCurrency(item.low_est)} - ${formatCurrency(item.high_est)}`, colPositions.estimate, currentY, {
                        width: colWidths.estimate,
                        align: 'right'
                    });
                }
            } else {
                // Original layout without Reference Commission
                // Item ID
                doc.text(item.id || '-', colPositions.itemId, currentY, {
                    width: colWidths.itemId,
                    align: 'center'
                });

                // Description (multi-line capable)
                setBold(doc, 8).text(descriptionText, colPositions.description, currentY, {
                    width: colWidths.description - 5, // Small padding to prevent edge overlap
                    lineGap: 2
                });

                // Commission %
                const effectiveCommission = hasReference
                    ? (clientCommissionRate || 0) - (referenceCommissionRate || 0)
                    : (clientCommissionRate || 0);
                setNormal(doc, 8).text(`${effectiveCommission}%`, colPositions.auctionComm, currentY, {
                    width: colWidths.auctionComm,
                    align: 'right'
                });

                // Reserve
                doc.text(item.reserve ? formatCurrency(item.reserve) : '-', colPositions.reserve, currentY, {
                    width: colWidths.reserve,
                    align: 'right'
                });

                // Estimate
                if (item.low_est && item.high_est) {
                    doc.text(`${formatCurrency(item.low_est)} - ${formatCurrency(item.high_est)}`, colPositions.estimate, currentY, {
                        width: colWidths.estimate,
                        align: 'right'
                    });
                }
            }

            // Use calculated row height
            currentY += maxRowHeight;
        } else if (type === 'collection') {
            // Collection receipt item display
            const descriptionText = item.title || item.description || '-';
            const descriptionHeight = doc.heightOfString(descriptionText, {
                width: 220,
                lineGap: 2
            });

            const minRowHeight = 25;
            const calculatedRowHeight = Math.max(minRowHeight, descriptionHeight + 10);
            maxRowHeight = calculatedRowHeight;

            doc.text(item.id || '-', 55, currentY, { width: 80 });

            // Return Date only
            const returnDate = (item as any).return_date ? formatDate((item as any).return_date) : '-';
            doc.text(returnDate, 140, currentY, { width: 80 });

            // Return Reason
            const returnReason = (item as any).return_reason || '-';
            doc.text(returnReason, 225, currentY, { width: 60 });

            // Description (multi-line capable)
            setBold(doc, 8).text(descriptionText, 290, currentY, {
                width: 220,
                lineGap: 2
            });
            setNormal(doc, 8);

            currentY += maxRowHeight;
        } else {
            // For other types, use default height
            maxRowHeight = 35;
            currentY += maxRowHeight;
        }

        // Row border with proper spacing
        doc.moveTo(50, currentY).lineTo(550, currentY).strokeColor('#e0e0e0').stroke();
        doc.strokeColor('black');
        currentY += 5;
    });

    return currentY;
}

// Footer function
function addConsignmentFooter(doc: PDFKit.PDFDocument, brand: BrandData, y?: number, currentPage?: number, totalPages?: number, customText?: string) {
    const footerY = (doc.page.height - 100) // Give more space at bottom
    const pageWidth = doc.page.width

    doc.fontSize(7).font('Helvetica')

    // Company Registration and Office (single centered line)
    const registrationText = `Company Registration No: ${brand?.company_registration || ''}. Registered Office: ${brand?.brand_address ? String(brand?.brand_address).replace(/\n/g, ', ') : ''}`
    const registrationWidth = doc.widthOfString(registrationText)
    const registrationHeight = doc.heightOfString(registrationText, { lineGap: 2 })
    const registrationCenterX = (pageWidth - registrationWidth) / 2
    doc.text(registrationText, registrationCenterX, footerY)

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

    doc.fillColor('black');
}

// Main PDF generation functions

/**
 * Generate Consignment Receipt PDF
 */
export function generateConsignmentReceiptPDF(
    consignment: Consignment,
    client: Client,
    items: ConsignmentItem[],
    brand: BrandData
): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Header with 3-column layout
            const headerBottom = await addConsignmentHeader(
                doc,
                brand,
                'CONSIGNMENT RECEIPT',
                client,
                consignment,
                {
                    dateLabel: 'Receipt Date',
                    numberLabel: 'Receipt No',
                    dateValue: formatDate(consignment.consignment_receipt_date || consignment.created_at),
                    numberValue: consignment.id?.toString(),
                    additionalInfo: consignment.consignment_number
                }
            );

            // Reference section
            let currentY = headerBottom + 20;
            doc.rect(50, currentY, 500, 40).fillColor('#f8f9fa').fill();
            doc.strokeColor('#e0e0e0').rect(50, currentY, 500, 40).stroke();
            doc.fillColor('black').strokeColor('black');

            setBold(doc, 9).text('REFERENCE:', 60, currentY + 8);
            setNormal(doc, 9).text(consignment.reference || '', 160, currentY + 8);

            setBold(doc, 9).text('COMMISSION:', 60, currentY + 20);
            if (consignment.reference && consignment.reference_commission) {
                setNormal(doc, 9).text(`${consignment.reference_commission}% of hammer price`, 160, currentY + 20);
            } else {
                setNormal(doc, 9).text('', 160, currentY + 20);
            }

            currentY += 50;

            // Items table
            const hasReference = !!(consignment.reference && consignment.reference.trim());
            const tableBottom = addItemsTable(
                doc,
                items,
                'receipt',
                currentY,
                client.vendor_premium,
                consignment.reference_commission,
                hasReference
            );

            // Summary
            currentY = tableBottom + 20;
            const totalEstimate = items.reduce((sum, item) => {
                const lowEst = item.low_est || 0;
                const highEst = item.high_est || 0;
                return sum + ((lowEst + highEst) / 2);
            }, 0);
            const totalReserve = items.reduce((sum, item) => sum + (item.reserve || 0), 0);

            doc.moveTo(50, currentY).lineTo(550, currentY).strokeColor('#cccccc').stroke();
            doc.strokeColor('black');
            currentY += 15;

            setBold(doc, 10);
            doc.text(`Total Number of lines: ${items.length}`, 50, currentY);
            doc.text(`Total Estimate: ${formatCurrency(totalEstimate)}`, 350, currentY, { align: 'right', width: 200 });

            if (totalReserve > 0) {
                currentY += 15;
                doc.text('', 50, currentY);
                doc.text(`Total Reserve: ${formatCurrency(totalReserve)}`, 350, currentY, { align: 'right', width: 200 });
            }

// Signature section
currentY += 40;
const sigBoxWidth = 220;
const sigBoxHeight = 80;

// Left signature box - Consignor
doc.rect(50, currentY, sigBoxWidth, sigBoxHeight).strokeColor('#cccccc').stroke();
setBold(doc, 9).text('Consigned by', 60, currentY + 8);

if (consignment.consignor_signature) {
    try {
        const base64Data = consignment.consignor_signature.replace(/^data:image\/\w+;base64,/, '');
        const sigBuffer = Buffer.from(base64Data, 'base64');
        doc.image(sigBuffer, 60, currentY + 18, { width: 160, height: 40 });
    } catch (e) {
        console.error('Sig render error:', e);
        setNormal(doc, 8).text('_________________', 60, currentY + 35);
    }
} else {
    setNormal(doc, 8).text('_________________', 60, currentY + 35);
}

setNormal(doc, 8).text(`${client.first_name} ${client.last_name}`, 60, currentY + 65);

// Right signature box - Received by
doc.rect(330, currentY, sigBoxWidth, sigBoxHeight).strokeColor('#cccccc').stroke();
setBold(doc, 9).text('Received by', 340, currentY + 8);
setNormal(doc, 8).text('_________________', 340, currentY + 35);
setNormal(doc, 8).text(`${consignment.specialist_name || 'Staff Member'}`, 340, currentY + 65);
setNormal(doc, 8).text(`for & on behalf of ${brand?.name || ''}`, 340, currentY + 75, { width: 200 });

            // Footer
            addConsignmentFooter(doc, brand, undefined, 1, 1);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Generate Pre-Sale Invoice PDF
 */
export function generatePreSaleInvoicePDF(
    consignment: Consignment,
    client: Client,
    auctionItems: AuctionItem[],
    saleDetails: SaleDetails,
    brand: BrandData
): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Header with 3-column layout
            const headerBottom = await addConsignmentHeader(
                doc,
                brand,
                'PRE-SALES ADVICE',
                client,
                consignment,
                {
                    dateLabel: 'Statement Date',
                    numberLabel: 'Statement No',
                    dateValue: formatDate(consignment.pre_sale_date || consignment.created_at),
                    numberValue: consignment.id?.toString(),
                    additionalInfo: 'Page 1 of 1'
                }
            );

            // Auction information section - simplified
            let currentY = headerBottom + 20;
            doc.rect(50, currentY, 500, 40).fillColor('#f8f9fa').fill();
            doc.strokeColor('#e0e0e0').rect(50, currentY, 500, 40).stroke();
            doc.fillColor('black').strokeColor('black');

            setBold(doc, 14).text(saleDetails.sale_name, 60, currentY + 10);

            // Show auction date range if available, otherwise just the date
            const auctionDateText = saleDetails.sale_date ? formatDate(saleDetails.sale_date) : 'Date TBD';
            setNormal(doc, 10).text(`Auction: ${auctionDateText}`, 60, currentY + 25);

            currentY += 60;

            // Items table
            const hasReference = !!(consignment.reference && consignment.reference.trim());
            const tableBottom = addItemsTable(
                doc,
                auctionItems,
                'presale',
                currentY + 20,
                client.vendor_premium,
                consignment.reference_commission,
                hasReference
            );

            // Summary
            currentY = tableBottom + 20;
            const totalEstimate = auctionItems.reduce((sum, item) => {
                const lowEst = item.low_est || 0;
                const highEst = item.high_est || 0;
                return sum + ((lowEst + highEst) / 2);
            }, 0);
            const totalReserve = auctionItems.reduce((sum, item) => sum + (item.reserve || 0), 0);

            doc.moveTo(50, currentY).lineTo(550, currentY).strokeColor('#cccccc').stroke();
            currentY += 15;

            setBold(doc, 10);
            doc.text(`Total Lots: ${auctionItems.length}`, 50, currentY);
            doc.text(`Total Estimate: ${formatCurrency(totalEstimate)}`, 350, currentY, { align: 'right', width: 200 });

            if (totalReserve > 0) {
                currentY += 15;
                doc.text('', 50, currentY);
                doc.text(`Total Reserve: ${formatCurrency(totalReserve)}`, 350, currentY, { align: 'right', width: 200 });
            }

            // Terms and Conditions section - simplified like vendor invoice
            currentY += 40;

            const vendorTermsUrl = brand?.vendor_terms_and_conditions || brand?.terms_and_conditions || '';

            const termsText = 'All transactions are in accordance with our terms and conditions at';
            doc.fontSize(TEXT_SIZE).font('Helvetica').text(termsText, 50, currentY, { lineGap: 3 });

            // Add clickable URL after the text
            if (vendorTermsUrl && vendorTermsUrl.trim() !== '') {
                const textWidth = doc.widthOfString(termsText);
                const urlX = 50 + textWidth + 5; // Add small gap
                addHyperlink(doc, vendorTermsUrl, vendorTermsUrl, urlX, currentY, { lineGap: 3 });
            }

            // Footer
            addConsignmentFooter(doc, brand, undefined, 1, 1);

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Generate Collection Receipt PDF
 */
export function generateCollectionReceiptPDF(
    consignment: Consignment,
    client: Client,
    returnedItems: ReturnedItem[],
    brand: BrandData,
    collectionDate?: string,
    collectedBy?: string,
    releasedBy?: string
): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const today = new Date().toLocaleDateString('en-GB', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            });

            // Header with 3-column layout
            const headerBottom = await addConsignmentHeader(
                doc,
                brand,
                'COLLECTION RECEIPT',
                client,
                consignment,
                {
                    dateLabel: 'Collection Date',
                    numberLabel: 'Collection No',
                    dateValue: collectionDate || today,
                    numberValue: `CL${consignment.consignment_number}`,
                    additionalInfo: consignment.consignment_number
                }
            );

            // Items table for collection (reference info now in header)
            let currentY = headerBottom + 20;
            const hasReference = !!(consignment.reference && consignment.reference.trim());
            const tableBottom = addItemsTable(
                doc,
                returnedItems,
                'collection',
                currentY,
                client.vendor_premium,
                consignment.reference_commission,
                hasReference
            );

            // Summary
            currentY = tableBottom + 20;
            doc.moveTo(50, currentY).lineTo(550, currentY).strokeColor('#cccccc').stroke();
            currentY += 15;

            setBold(doc, 10).text(`Total Number of returned items: ${returnedItems.length}`, 250, currentY, { align: 'center', width: 300 });

            // Signature section
            currentY += 40;
            const sigBoxWidth = 220;
            const sigBoxHeight = 80;

            // Left signature box
            doc.rect(50, currentY, sigBoxWidth, sigBoxHeight).strokeColor('#cccccc').stroke();
            setBold(doc, 9).text('Consigned by', 60, currentY + 10);
            setNormal(doc, 8).text('Date:', 60, currentY + 25);
            setNormal(doc, 8).text(`${client.first_name} ${client.last_name}`, 60, currentY + 40);

            // Right signature box
            doc.rect(330, currentY, sigBoxWidth, sigBoxHeight).strokeColor('#cccccc').stroke();
            setBold(doc, 9).text('Received by', 340, currentY + 10);
            doc.moveTo(340, currentY + 50).lineTo(540, currentY + 50).strokeColor('#cccccc').stroke(); // Signature line
            setNormal(doc, 8).text(
                `${consignment.specialist_name || 'Specialist'}\nfor & on behalf of ${brand?.name || ''}`,
                340, currentY + 55, { width: 200 }
            );

            // Footer
            addConsignmentFooter(doc, brand, undefined, 1, 1, 'Collection receipt for items returned from consignment');

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Generate Custom Consignment Report PDF
 */
export function generateCustomConsignmentReportPDF(
    consignments: any[],
    customization: PDFCustomization,
    brand: BrandData,
    template: 'summary' | 'detailed' | 'financial' | 'custom' = 'summary'
): Promise<Buffer> {
    return new Promise<Buffer>(async (resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: MARGIN });
            const chunks: Buffer[] = [];

            doc.on('data', (chunk: Buffer) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            let currentY = 50;

            // Header
            if (customization.includeHeader) {
                if (customization.includeLogo && brand?.logo_url) {
                    try {
                        const resp = await fetch(brand?.logo_url);
                        if (resp.ok) {
                            const arr = await resp.arrayBuffer();
                            const buf = Buffer.from(arr);
                            doc.image(buf, 50, currentY, { fit: [60, 60] });
                        }
                    } catch (e) {
                        console.log('Could not load brand logo from URL:', e);
                    }
                }

                setBold(doc, TITLE_SIZE).text(customization.documentTitle, customization.includeLogo ? 130 : 50, currentY);
                currentY += 40;

                if (customization.headerText) {
                    setNormal(doc, 12).text(customization.headerText, 50, currentY);
                    currentY += 20;
                }
            }

            // Report content based on template
            if (template === 'summary') {
                setBold(doc, 12).text('Consignment Summary Report', 50, currentY);
                currentY += 20;

                setNormal(doc, 10).text(`Total Consignments: ${consignments.length}`, 50, currentY);
                currentY += 15;

                const totalItems = consignments.reduce((sum, c) => sum + (c.items?.length || 0), 0);
                doc.text(`Total Items: ${totalItems}`, 50, currentY);
                currentY += 15;

                const totalValue = consignments.reduce((sum, c) => sum + (c.total_estimated_value || 0), 0);
                doc.text(`Total Estimated Value: ${formatCurrency(totalValue)}`, 50, currentY);
                currentY += 30;

            } else if (template === 'detailed') {
                setBold(doc, 12).text('Detailed Consignment Report', 50, currentY);
                currentY += 30;

                consignments.forEach((consignment, index) => {
                    setBold(doc, 10).text(`Consignment ${index + 1}: ${consignment.consignment_number}`, 50, currentY);
                    currentY += 15;

                    setNormal(doc, 9);
                    doc.text(`Created: ${formatDate(consignment.created_at)}`, 70, currentY);
                    currentY += 12;
                    doc.text(`Specialist: ${consignment.specialist_name || 'N/A'}`, 70, currentY);
                    currentY += 12;
                    doc.text(`Items: ${consignment.items?.length || 0}`, 70, currentY);
                    currentY += 12;
                    doc.text(`Est. Value: ${formatCurrency(consignment.total_estimated_value || 0)}`, 70, currentY);
                    currentY += 20;
                });

            } else if (template === 'financial') {
                setBold(doc, 12).text('Financial Consignment Report', 50, currentY);
                currentY += 30;

                // Financial summary table
                const totalEstValue = consignments.reduce((sum, c) => sum + (c.total_estimated_value || 0), 0);
                const avgValue = totalEstValue / (consignments.length || 1);

                setNormal(doc, 10);
                doc.text(`Total Portfolio Value: ${formatCurrency(totalEstValue)}`, 50, currentY);
                currentY += 15;
                doc.text(`Average Consignment Value: ${formatCurrency(avgValue)}`, 50, currentY);
                currentY += 15;
                doc.text(`Commission Rate: 15% (average)`, 50, currentY);
                currentY += 15;
                doc.text(`Projected Commission: ${formatCurrency(totalEstValue * 0.15)}`, 50, currentY);
                currentY += 30;
            }

            // Custom notes
            if (customization.customNotes) {
                setBold(doc, 10).text('Additional Notes:', 50, currentY);
                currentY += 15;
                setNormal(doc, 9).text(customization.customNotes, 50, currentY, { width: 500 });
                currentY += 30;
            }

            // Footer
            if (customization.includeFooter) {
                addConsignmentFooter(doc, brand, undefined, 1, 1, customization.footerText);
            }

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}
