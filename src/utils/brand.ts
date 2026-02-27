// backend/src/utils/brand.ts
// Purpose: Brand helpers and membership checks for per-brand authorization

import { supabaseAdmin } from './supabase'

export interface BrandRecord {
  id: number
  code: string
  name: string
}

export type BrandMembershipRole = 'admin' | 'accountant' | 'user'

export async function getBrandByCode(code?: string): Promise<BrandRecord | undefined> {
  if (!code) return undefined
  const { data, error } = await supabaseAdmin
    .from('brands')
    .select('id, code, name')
    .eq('code', code.toUpperCase())
    .single()
  if (error || !data) return undefined
  return data as unknown as BrandRecord
}

export async function getMembership(userId: number | string, brandId: number | string) {
  const { data } = await supabaseAdmin
    .from('brand_memberships')
    .select('id, role')
    .eq('user_id', userId as any)
    .eq('brand_id', brandId as any)
    .maybeSingle()
  return data as { id: string; role: BrandMembershipRole } | null
}

export async function isMemberOfBrand(params: { userId: number | string; brandId?: string; brandCode?: string; userRole?: string }) {
  const { userId, brandId, brandCode, userRole } = params
  if (userRole === 'super_admin') return { ok: true, role: 'admin' as BrandMembershipRole }
  const brand = brandId ? { id: brandId } as any : await getBrandByCode(brandCode)
  if (!brand?.id) return { ok: false as const, reason: 'BRAND_NOT_FOUND' as const }
  const membership = await getMembership(userId, brand.id)
  if (!membership) return { ok: false as const, reason: 'NOT_MEMBER' as const }
  return { ok: true as const, role: membership.role }
}

export async function listUserBrands(userId: number | string, userRole?: string) {
  if (userRole === 'super_admin') {
    const { data } = await supabaseAdmin.from('brands').select('id, code, name').eq('is_active', true)
    return data || []
  }
  const { data } = await supabaseAdmin
    .from('brand_memberships')
    .select('brands!inner(id, code, name)')
    .eq('user_id', userId as any)
  const result = (data || []).map((r: any) => r.brands)
  return result
}



