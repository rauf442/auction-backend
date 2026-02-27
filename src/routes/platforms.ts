// backend/src/routes/platforms.ts
import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

const router = express.Router();
router.use(authMiddleware);

// Platform configurations - moved from frontend
const PLATFORM_CONFIGS = {
  database: {
    label: 'Our Database',
    description: 'Full format with all available fields including brand and return information',
    csvHeaders: [
      'id', 'title', 'description', 'low_est', 'high_est', 'start_price', 'reserve', 'condition', 'consignment_id',
      'status', 'category', 'subcategory', 'height_inches', 'width_inches', 'height_cm', 'width_cm',
      'height_with_frame_inches', 'width_with_frame_inches', 'height_with_frame_cm', 'width_with_frame_cm',
      'weight', 'materials', 'artist_maker', 'period_age', 'provenance',
      'artist_id', 'school_id', 'condition_report', 'gallery_certification', 'gallery_certification_file', 'gallery_id', 'artist_certification', 'artist_certification_file', 'certified_artist_id', 'artist_family_certification', 'artist_family_certification_file',
      'restoration_done', 'restoration_done_file', 'restoration_by', 'images',
      'include_artist_description', 'include_artist_key_description', 'include_artist_biography', 'include_artist_notable_works',
      'include_artist_major_exhibitions', 'include_artist_awards_honors', 'include_artist_market_value_range', 'include_artist_signature_style',
      'brand_id',
      'return_date', 'return_location', 'return_reason', 'returned_by_user_id', 'returned_by_user_name',
      'date_sold', 'created_at', 'updated_at'
    ],
    requiredFields: ['title', 'description'],
    supportsAllFields: true
  },
  liveauctioneers: {
    label: 'LiveAuctioneers',
    description: 'Compatible with LiveAuctioneers CSV format',
    csvHeaders: ['Lot', 'Lot ID', 'Title', 'Description', 'Condition', 'LowEst', 'HighEst', 'Start Price', 'Reserve Price', 'Height', 'Width', 'Depth', 'Dimension Unit', 'Weight', 'Weight Unit', 'Domestic Flat Shipping Price', 'Quantity', 'Shipping Height', 'Shipping Width', 'Shipping Depth', 'Shipping Dimension Unit', 'Shipping Weight', 'Shipping Weight Unit', 'Shipping Quantity', 'Consigner', 'Reference Number', 'Bids', 'Pending Bids', 'Hits', 'Image Count', 'Live', 'Edited'],
    requiredFields: ['Title'],
    sampleData: ['1', '209274727', 'MAQBOOL FIDA HUSAIN (1915-2011) WATERCOLOUR ON PAPER SIGNED LOWER RIGHT', 'MAQBOOL FIDA HUSAIN (1915-2011) WATERCOLOUR ON PAPER<br><br>THESE WORKS ARE HIGHLY SOUGHT AFTER, MUCH LIKE THOSE BY RENOWNED ARTISTS SUCH AS M.F. HUSAIN, S.H. RAZA, AKBAR PADAMSEE, HEMENDRANATH MAZUMDAR, RAM KUMAR, JAMINI ROY, B. PRABHA, TYEB MEHTA, AND MANY OTHERS. THEY ARE OFTEN SOLD BY AUCTIONEERS TO COLLECTORS AROUND THE GLOBE<BR><BR>30 X 22 INCHES', '', '&pound;4,000', '&pound;6,000', '&pound;800', '&pound;800', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
  },
  easy_live: {
    label: 'Easy Live Auction',
    description: 'Compatible with Easy Live Auction CSV format',
    csvHeaders: ['LotNo', 'Description', 'Condition Report', 'LowEst', 'HighEst', 'Category'],
    requiredFields: ['LotNo', 'Description', 'LowEst', 'HighEst'],
    sampleData: ['1', 'Example Lot 1', 'Condition Report 1', '10', '10', 'Furniture']
  },
  the_saleroom: {
    label: 'The Saleroom',
    description: 'Compatible with The Saleroom CSV format',
    csvHeaders: ['Number', 'Title', 'Description', 'Hammer', 'Reserve', 'StartPrice', 'Increment', 'Quantity', 'LowEstimate', 'HighEstimate', 'CategoryCode', 'Sales Tax/VAT', 'BuyersPremiumRate', 'BuyersPremiumCeiling', 'InternetSurchargeRate', 'InternetSurchargeCeiling', 'BuyersPremiumVatRate', 'InternetSurchargeVatRate', 'End Date', 'End Time', 'Lot Link', 'Main Image', 'ExtraImages', 'BuyItNowPrice', 'IsBulk', 'Artist\'s Resale Right Applies', 'Address1', 'Address2', 'Address3', 'Address4', 'Postcode', 'TownCity', 'CountyState', 'CountryCode', 'ShippingInfo'],
    requiredFields: ['Number', 'Title', 'Description', 'LowEstimate', 'HighEstimate'],
    sampleData: ['1', 'Pierre Jeanneret (1896-1967) Desk designed for the Administrative buildings, Chandigarh, North ...', '<p><strong>Pierre Jeanneret (1896-1967)&nbsp;</strong><br><br>Desk designed for the Administrative buildings, Chandigarh, North India, circa 1957&nbsp;<br>Teak, leather inset top&nbsp;<br>71.5cm high, 121.5cm wide, 84cm deep&nbsp;<br><br><strong>Literature&nbsp;</strong><br>Patrick Seguin, \'Le Corbusier, Pierre Jeanneret, Chandigarh India\', Galerie Patrick Seguin, Paris, 2014, p.288&nbsp;</p> <p><strong>Provenance&nbsp;</strong><br>Vigo Gallery, London&nbsp;</p> Condition Report:  <p>Professional restoration towards bottom of front right support, overall general surface wear to include scratches, scuffs and marks commensurate with age and use.</p>', '2000.00', '2000.00', '1400.00', '', '1', '2000.00', '2500.00', 'FUR', '', '', '', '', '', '', '', '13/08/2025', '10:00', 'en-gb/auction-catalogues/metsab/catalogue-id-metsab10000/lot-a81ba4c4-f7fb-462a-9520-b33800c32b65', 'https://cdn.globalauctionplatform.com/54b11a1b-bf41-4c81-b480-b33800c14324/78df6eb5-4bde-440b-9f50-b33800c41734/original.jpg', 'https://cdn.globalauctionplatform.com/54b11a1b-bf41-4c81-b480-b33800c14324/6a526f16-4f89-4239-bf90-b33800c41895/original.jpg', '', 'False', 'False', '', '', '', '', '', '', '', '']
  },
  invaluable: {
    label: 'Invaluable',
    description: 'Compatible with Invaluable CSV format',
    csvHeaders: ['id', 'title', 'description', 'low_est', 'high_est', 'start_price', 'condition', 'category', 'dimensions'],
    requiredFields: ['id', 'title', 'description', 'low_est', 'high_est']
  }
};

// GET /api/platforms - Return available platforms
router.get('/', async (req: Request, res: Response) => {
  try {
    const platforms = Object.entries(PLATFORM_CONFIGS).map(([key, config]) => ({
      id: key,
      label: config.label,
      description: config.description,
      requiredFields: config.requiredFields,
      csvHeaders: config.csvHeaders,
      supportsAllFields: 'supportsAllFields' in config ? config.supportsAllFields : false,
      sampleData: 'sampleData' in config ? config.sampleData : undefined
    }));

    res.json({
      success: true,
      data: platforms
    });
  } catch (err: any) {
    console.error('Error fetching platforms:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

// GET /api/platforms/:platform - Get specific platform configuration
router.get('/:platform', async (req: Request, res: Response) => {
  try {
    const { platform } = req.params;
    const config = PLATFORM_CONFIGS[platform as keyof typeof PLATFORM_CONFIGS];

    if (!config) {
      return res.status(404).json({ error: 'Platform not found' });
    }

    res.json({
      success: true,
      data: {
        id: platform,
        label: config.label,
        description: config.description,
        requiredFields: config.requiredFields,
        csvHeaders: config.csvHeaders,
        supportsAllFields: 'supportsAllFields' in config ? config.supportsAllFields : false,
        sampleData: 'sampleData' in config ? config.sampleData : undefined
      }
    });
  } catch (err: any) {
    console.error('Error fetching platform:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: err.message
    });
  }
});

export default router;
