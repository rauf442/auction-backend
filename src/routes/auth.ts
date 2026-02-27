import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { supabaseAdmin, AuthResponse, UserProfile } from '../utils/supabase';


async function logProfilesOnInit() {
  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('*');

    if (error) {
      console.error('Error fetching profiles on init:', error);
      return;
    }

    console.log('Profiles table on init:', profiles);
  } catch (err) {
    console.error('Unexpected error fetching profiles on init:', err);
  }
}


logProfilesOnInit();

const router = express.Router();
// Request a password reset email
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const { data, error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo: (process.env.FRONTEND_URL || 'http://localhost:3000') + '/auth/reset-password'
    });
    if (error) return res.status(400).json({ error: error.message });
    return res.json({ success: true, message: 'Password reset email sent' });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// Complete password reset with access token from email link
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { access_token, new_password } = req.body as { access_token?: string; new_password?: string };
    if (!access_token || !new_password) return res.status(400).json({ error: 'access_token and new_password are required' });

    // Exchange the access_token for user to get user id
    const { data: userData, error: getUserErr } = await supabaseAdmin.auth.getUser(access_token);
    if (getUserErr || !userData?.user?.id) return res.status(400).json({ error: 'Invalid or expired token' });

    const userId = userData.user.id;
    const { data: updated, error: updErr } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: new_password });
    if (updErr) return res.status(400).json({ error: updErr.message });
    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// Login endpoint using Supabase Auth
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, remember } = req.body;

    // Validate input
    if (!email || !password) {
      res.status(400).json({
        error: 'Email and password are required'
      });
      return;
    }

    // Authenticate with Supabase Auth using regular client
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (authError || !authData.user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Get user profile from profiles table
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('auth_user_id', authData.user.id) // Fixed: use auth_user_id instead of id
      .eq('is_active', true)
      .limit(1);

    if (profileError || !profiles || profiles.length === 0) {
      console.error('Profile fetch error:', profileError);
      res.status(401).json({
        error: 'User profile not found or inactive'
      });
      return;
    }

    const userProfile = profiles[0] as UserProfile;

    // Generate custom JWT token for our app (optional - you could also use Supabase's token)
    const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    const tokenExpiry = remember ? '30d' : '1d';
    
    const customToken = jwt.sign(
      { 
        userId: userProfile.id,
        email: userProfile.email,
        role: userProfile.role,
        supabaseToken: authData.session?.access_token
      },
      jwtSecret,
      { expiresIn: tokenExpiry }
    );

    // Return successful response
    const authResponse: AuthResponse = {
      user: userProfile,
      token: customToken,
      error: null
    };

    res.json(authResponse);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// Change password endpoint
router.post('/change-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const { newPassword } = req.body as { newPassword?: string };

    // Validate input
    if (!newPassword) {
      res.status(400).json({
        error: 'New password is required'
      });
      return;
    }

    // Validate password strength
    if (newPassword.length < 8) {
      res.status(400).json({
        error: 'New password must be at least 8 characters long'
      });
      return;
    }

    // Get auth token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'No valid token provided'
      });
      return;
    }

    const token = authHeader.substring(7);

    // Verify the token and get user info
    const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    const decoded = jwt.verify(token, jwtSecret) as any;

    if (!decoded?.userId) {
      res.status(401).json({
        error: 'Invalid token'
      });
      return;
    }

    // Get the user's auth_user_id from the profiles table
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('auth_user_id')
      .eq('id', decoded.userId)
      .single();

    if (profileError || !profile) {
      console.error('Profile lookup error:', profileError);
      res.status(401).json({
        error: 'User profile not found'
      });
      return;
    }

    // Use Supabase's updateUser method to change password
    const { data: userData, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      profile.auth_user_id,
      { password: newPassword }
    );

    if (updateError) {
      console.error('Password update error:', updateError);
      res.status(400).json({
        error: 'Failed to update password',
        details: updateError.message
      });
      return;
    }

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error: any) {
    console.error('Password change error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Logout endpoint
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  try {
    // For JWT-based auth, logout is primarily client-side
    // We could also call Supabase signOut if needed
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// Verify token endpoint
router.get('/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'No valid token provided'
      });
      return;
    }

    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET || 'your-secret-key';

    const decoded = jwt.verify(token, jwtSecret) as any;
    
    // Verify user still exists and is active in profiles table
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, role, is_active')
      .eq('id', decoded.userId)
      .eq('is_active', true)
      .limit(1);
    
    if (error || !profiles || profiles.length === 0) {
      res.status(401).json({
        error: 'Invalid token'
      });
      return;
    }

    res.json({
      valid: true,
      user: {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role
      }
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({
      error: 'Invalid token'
    });
  }
});

// Sign up endpoint (requires service role key)
router.post('/signup', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, firstName, lastName } = req.body;

    // Validate input
    if (!email || !password) {
      res.status(400).json({
        error: 'Email and password are required'
      });
      return;
    }

    // Check if we have admin access first
    try {
      const { data: testData, error: testError } = await supabaseAdmin.auth.admin.listUsers();
      if (testError) {
        res.status(500).json({
          error: 'Service role key required for user creation. Please use Supabase dashboard to create users.'
        });
        return;
      }
    } catch (err) {
      res.status(500).json({
        error: 'Service role key required for user creation. Please use Supabase dashboard to create users.'
      });
      return;
    }

    // Create user with Supabase Auth (requires service role)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name: lastName
      }
    });

    if (authError || !authData.user) {
      res.status(400).json({
        error: authError?.message || 'Failed to create user'
      });
      return;
    }

    res.json({
      message: 'User created successfully',
      user: {
        id: authData.user.id,
        email: authData.user.email
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

export default router; 