# Environment Variables Configuration

This document lists all environment variables used by the MSABER backend application.

## Required Environment Variables

### Core Application
- `NODE_ENV`: Set to 'production' for production deployments
- `PORT`: Port number for the server (default: 3001, Render uses 10000)

### Supabase Configuration
- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key for admin operations

### Authentication
- `JWT_SECRET`: Secret key for JWT token signing

### Frontend Configuration
- `FRONTEND_URL`: URL of your admin frontend application (e.g., https://admin.your-domain.com)
- `NEXT_PUBLIC_FRONTEND_URL_AURUM`: URL of your Aurum brand public frontend (e.g., https://aurum.your-domain.com) - must be prefixed with NEXT_PUBLIC_ for frontend access
- `NEXT_PUBLIC_FRONTEND_URL_METSAB`: URL of your Metsab brand public frontend (e.g., https://metsab.your-domain.com) - must be prefixed with NEXT_PUBLIC_ for frontend access

## Optional Environment Variables



### AI Integration
- `GEMINI_API_KEY`: Google Gemini API key for AI features
- `AI_MODEL`: AI model to use (optional, defaults to gemini-pro)

### Google Services
- `GOOGLE_PROJECT_ID`: Google Cloud project ID
- `GOOGLE_PRIVATE_KEY_ID`: Google service account private key ID
- `GOOGLE_PRIVATE_KEY`: Google service account private key (with \n replaced)
- `GOOGLE_CLIENT_EMAIL`: Google service account client email
- `GOOGLE_CLIENT_ID`: Google service account client ID
- `GOOGLE_API_KEY`: Google API key for general Google services
- `GOOGLE_MAPS_API_KEY`: Google Maps API key

### URLs
- `BACKEND_URL`: Full URL of your backend (used for OAuth callbacks)
- `FRONTEND_BASE_URL`: Alternative frontend URL (if different from FRONTEND_URL)


### Email Configuration (Brevo)
- `BREVO_API_KEY`: Brevo (formerly Sendinblue) API key for sending automated emails
- `DEFAULT_FROM_EMAIL`: Default sender email address (e.g., noreply@yourdomain.com)
- `DEFAULT_FROM_NAME`: Default sender name (e.g., "Your Company Name")

### Legacy Email Configuration (Deprecated)
- `EMAIL_USER`: Email address for sending emails (deprecated, use Brevo)
- `EMAIL_PASS`: Email password or app password (deprecated, use Brevo)

## Render.com Deployment Setup

1. In your Render dashboard, go to your service's Environment tab
2. Add all the required environment variables listed above
3. Set the following values for Render:
   - `NODE_ENV`: production
   - `PORT`: 10000 (this is set automatically by Render)
   - `FRONTEND_URL`: Your frontend's URL
   - `BACKEND_URL`: https://your-backend-name.onrender.com

## Local Development

Create a `.env` file in the backend directory with the appropriate values for local development.

Example `.env` file:
```
NODE_ENV=development
PORT=3001
SUPABASE_URL=your-supabase-url
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JWT_SECRET=your-jwt-secret
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_FRONTEND_URL_AURUM=http://localhost:3003
NEXT_PUBLIC_FRONTEND_URL_METSAB=http://localhost:3002
GEMINI_API_KEY=your-gemini-api-key
```
