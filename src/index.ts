import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import RealtimeChatService from './services/realtime-chat';

// Import route handlers
import authRoutes from './routes/auth';
import clientsRoutes from './routes/clients';
import webhooksRoutes from './routes/webhooks';
import itemsRoutes from './routes/items';
import auctionsRoutes from './routes/auctions';
import artistsRoutes from './routes/artists';
import schoolsRoutes from './routes/schools';
import galleriesRoutes from './routes/galleries';
import { consignmentsRouter, consignmentsPublicRouter } from './routes/consignments';
import usersRoutes from './routes/users';
import bankingRoutes from './routes/banking';
import refundsRoutes from './routes/refunds';
import reimbursementsRoutes from './routes/reimbursements';
import invoicesRoutes from './routes/invoices'
import invoiceEmailsRoutes from './routes/invoice-emails'
import publicInvoicesRoutes from './routes/public-invoices';
import internalCommunicationRoutes from './routes/internal-communication';
import xeroRoutes from './routes/xero';
import xeroPaymentsRoutes from './routes/xero-payments';
import stripePaymentsRoutes from './routes/stripe-payments';
import dashboardRoutes from './routes/dashboard';
import brandsRoutes from './routes/brands';
import brandLogosRoutes from './routes/brand-logos';
import platformCredentialsRoutes from './routes/platform-credentials';
import platformsRoutes from './routes/platforms';
import campaignsRoutes from './routes/campaigns';
import imagesRoutes from './routes/images';
import publicInventoryRoutes from './routes/public-inventory';
import publicAuctionsRoutes from './routes/public-auctions';
import publicBrandsRoutes from './routes/public-brands';
import publicPendingItemsRoutes from './routes/public-pending-items';
import pendingItemsRoutes from './routes/pending-items';
import appSettingsRoutes from './routes/app-settings';
import socialMediaRoutes from './routes/social-media';
import articlesRoutes from './routes/articles';
import { supabaseAdmin } from './utils/supabase';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const httpServer = createServer(app);

// Initialize realtime chat service
let realtimeChatService: RealtimeChatService;

// Middleware
const corsOptions = {
  origin: function (origin: any, callback: any) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      'http://localhost:3004',
      'https://admin.aurumauctions.com',
      'https://admin.metsabauctions.com',
      'https://metsab-auctions.vercel.app',
      'https://aurum-auctions.vercel.app',
      'https://aurum-auctions.vercel.app/',
      // Add specific Vercel deployment origins
      'https://auction-frontend-bice.vercel.app',
      'https://auction-frontend-git-main-nafiskabbos-projects.vercel.app',
      'https://auction-frontend-*.vercel.app',
      'https://msaber-*.vercel.app',
      // New URLs
  'https://auction-frontend-six-beta.vercel.app',
  'https://metsab-auctions-delta.vercel.app',
  'https://aurum-auctions-one.vercel.app',
    ];

    // Check if origin matches any allowed pattern (supporting wildcards)
    const isAllowed = allowedOrigins.some(allowedOrigin => {
      if (allowedOrigin.includes('*')) {
        // Simple wildcard matching for Vercel domains
        const pattern = allowedOrigin.replace(/\*/g, '.*');
        const regex = new RegExp(`^${pattern}$`);
        return regex.test(origin);
      }
      return allowedOrigin === origin;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin, 'Allowed origins:', allowedOrigins);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'Cache-Control',
    'X-Access-Token'
  ],
  optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

app.use(cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Msaber Backend API', 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/items', itemsRoutes);
app.use('/api/auctions', auctionsRoutes);
app.use('/api/artists', artistsRoutes);
app.use('/api/schools', schoolsRoutes);
app.use('/api/galleries', galleriesRoutes);
app.use('/api/consignments', consignmentsRouter);
app.use('/api/public/consignments', consignmentsPublicRouter);
app.use('/api/users', usersRoutes);
app.use('/api/banking', bankingRoutes);
app.use('/api/refunds', refundsRoutes);
app.use('/api/reimbursements', reimbursementsRoutes);
app.use('/api/invoices', invoiceEmailsRoutes)
app.use('/api/invoices', invoicesRoutes)
app.use('/api/public/invoices', publicInvoicesRoutes);
app.use('/api/internal-communication', internalCommunicationRoutes);
app.use('/api/xero', xeroRoutes);
app.use('/api/xero-payments', xeroPaymentsRoutes);
app.use('/api/stripe-payments', stripePaymentsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/brands', brandsRoutes);
app.use('/api/brand-logos', brandLogosRoutes);
app.use('/api/platform-credentials', platformCredentialsRoutes);
app.use('/api/platforms', platformsRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api/app-settings', appSettingsRoutes);
app.use('/api/social-media', socialMediaRoutes);
app.use('/api/articles', articlesRoutes);
// Public routes (no auth)
app.use('/api/public/inventory', publicInventoryRoutes);
app.use('/api/public/auctions', publicAuctionsRoutes);
app.use('/api/public/brands', publicBrandsRoutes);
app.use('/api/public/pending-items', publicPendingItemsRoutes);
// Admin pending-items routes
app.use('/api/pending-items', pendingItemsRoutes);



// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`🔑 Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`🔑 Using key: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.substring(0, 20)}...`);
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 API available at: http://localhost:${PORT}`);
  console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log(`👥 Authentication system ready - using database roles`);
  
  // Initialize realtime chat service
  try {
    realtimeChatService = new RealtimeChatService(httpServer);
    console.log(`💬 Realtime chat service initialized`);
  } catch (error) {
    console.error('❌ Failed to initialize realtime chat service:', error);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  realtimeChatService?.destroy();
  httpServer.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  realtimeChatService?.destroy();
  httpServer.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
}); 