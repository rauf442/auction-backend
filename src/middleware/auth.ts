// backend/src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../utils/supabase';

// Simple in-memory cache for user profiles (5 minute TTL)
interface CachedUser {
  profile: any;
  timestamp: number;
}

const userCache = new Map<string, CachedUser>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100; // Maximum number of cached users

// Periodic cleanup function
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of userCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      userCache.delete(key);
    }
  }
}, 60000); // Clean up every minute

interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    console.log('🔒 Auth middleware - Request:', {
      url: req.url,
      method: req.method,
      hasAuthHeader: !!authHeader,
      authHeaderLength: authHeader?.length,
      authHeaderStart: authHeader?.substring(0, 20) + '...'
    });
    
    // TEMPORARY FIX: Allow bypass for development/testing
    if (process.env.NODE_ENV === 'development' && (!authHeader || !authHeader.startsWith('Bearer ') || authHeader === 'Bearer null' || authHeader === 'Bearer undefined')) {
      console.log('⚠️ DEV MODE: Bypassing auth for development');
      req.user = {
        id: 'dev-user',
        email: 'dev@msaber.com',
        role: 'super_admin'
      } as any;
      return next();
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('❌ Auth failed: No Bearer token');
      return res.status(401).json({ 
        error: 'Access denied. No token provided.',
        code: 'NO_TOKEN'
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    if (!token) {
      console.log('❌ Auth failed: Empty token');
      return res.status(401).json({ 
        error: 'Access denied. No token provided.',
        code: 'EMPTY_TOKEN'
      });
    }

    // Verify JWT token
    const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    
    let decoded: any;
    try {
      decoded = jwt.verify(token, jwtSecret);
      console.log('✅ JWT token verified for user:', decoded.userId);
    } catch (jwtError: any) {
      console.log('❌ JWT verification failed:', jwtError.message);
      
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          error: 'Invalid token.',
          code: 'INVALID_TOKEN'
        });
      }
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          error: 'Token expired. Please login again.',
          code: 'TOKEN_EXPIRED'
        });
      }
      throw jwtError;
    }
    
    if (!decoded.userId) {
      console.log('❌ Invalid token format: missing userId');
      return res.status(401).json({ 
        error: 'Invalid token format.',
        code: 'INVALID_FORMAT'
      });
    }

    // Get user profile from cache or database
    const now = Date.now();
    const cacheKey = decoded.userId;
    let profile = null;

    // Check cache first
    const cached = userCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < CACHE_TTL) {
      profile = cached.profile;
      console.log('✅ Auth successful (cached) for user:', profile.email);
    } else {
      // Cache miss or expired, fetch from database
      console.log('🔍 Looking up user profile for ID:', decoded.userId);
      const { data: profileData, error } = await supabaseAdmin
        .from('profiles')
        .select('id, email, role, is_active, first_name, last_name')
        .eq('id', decoded.userId)
        .single();

      if (error) {
        console.error('❌ Database error during auth:', error);
        return res.status(401).json({
          error: 'Authentication failed.',
          code: 'DB_ERROR'
        });
      }

      if (!profileData) {
        console.log('❌ User profile not found for ID:', decoded.userId);
        return res.status(401).json({
          error: 'User not found.',
          code: 'USER_NOT_FOUND'
        });
      }

      if (!profileData.is_active) {
        console.log('❌ User account is inactive:', decoded.userId);
        return res.status(401).json({
          error: 'Account is inactive.',
          code: 'ACCOUNT_INACTIVE'
        });
      }

      // Cache the profile
      profile = profileData;

      // Manage cache size - remove oldest entries if cache is full
      if (userCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = userCache.keys().next().value;
        if (oldestKey) {
          userCache.delete(oldestKey);
        }
      }

      userCache.set(cacheKey, { profile, timestamp: now });
      console.log('✅ Auth successful for user:', profile.email);
    }

    // Add user info to request object
    req.user = {
      id: profile.id,
      email: profile.email,
      role: profile.role || 'user' // Use role from database, default to 'user'
    } as any;

    next();
  } catch (error: any) {
    console.error('❌ Auth middleware error:', error);
    return res.status(500).json({ 
      error: 'Internal server error during authentication.',
      code: 'INTERNAL_ERROR'
    });
  }
};

// Optional: Role-based access control middleware
export const requireRole = (requiredRole: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Authentication required.',
        code: 'AUTH_REQUIRED'
      });
    }

    if (req.user.role !== requiredRole && req.user.role !== 'admin') {
      return res.status(403).json({ 
        error: 'Insufficient permissions.',
        code: 'INSUFFICIENT_PERMISSIONS'
      });
    }

    next();
  };
}; 