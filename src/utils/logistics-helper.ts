// backend/src/utils/logistics-helper.ts

/**
 * Helper functions for logistics data management
 */

import { supabaseAdmin } from './supabase'

export interface ItemLogisticsInfo {
  id: number
  title: string
  width: number | null
  height: number | null
  length: number | null
  weight: number | null
  lot_num: string
  actualWeight: number
  billableWeight: number
  logistics_width: number
  logistics_height: number
  logistics_length: number
  volumetricWeight: number
}

/**
 * Pre-fill logistics information from item IDs
 * Fetches item data and creates logistics info structure
 */
export async function prefillLogisticsData(
  itemIds: number[],
  lotIds: string[],
  shippingAddress?: {
    country?: string
    postal_code?: string
  }
): Promise<{
  items_info: ItemLogisticsInfo[]
  l_method: string
  l_status: string
  l_postal_code?: string
  l_destination?: string
  l_country?: string
}> {
  try {
    // Fetch items from database
    const { data: items, error } = await supabaseAdmin
      .from('items')
      .select('id, title, width_cm, height_cm, weight')
      .in('id', itemIds)

    if (error) {
      console.error('Error fetching items for logistics:', error)
      return {
        items_info: [],
        l_method: 'metsab_courier',
        l_status: 'pending'
      }
    }

    // Create items_info array with logistics calculations
    const itemsInfo: ItemLogisticsInfo[] = (items || []).map((item, index) => {
      // Parse dimensions from strings to numbers, defaulting to 0 if invalid
      const width = parseFloat(item.width_cm || '0') || 0
      const height = parseFloat(item.height_cm || '0') || 0
      // No length field in database, assume minimal depth of 1cm for volumetric calculation
      const length = 1
      const weight = parseFloat(item.weight || '0') || 0

      // Use logistics dimensions if available, otherwise use item dimensions
      const logisticsWidth = width || 0
      const logisticsHeight = height || 0
      const logisticsLength = length || 0

      // Calculate volumetric weight (L x W x H / 5000 for international shipping)
      const volumetricWeight = (logisticsLength * logisticsWidth * logisticsHeight) / 5000

      // Actual weight is the weight from database
      const actualWeight = weight

      // Billable weight is the greater of actual weight and volumetric weight
      const billableWeight = Math.max(actualWeight, volumetricWeight)

      return {
        id: item.id,
        title: item.title || '',
        width: width,
        height: height,
        length: length,
        weight: weight,
        lot_num: lotIds[index] || `${index + 1}`,
        actualWeight,
        billableWeight,
        logistics_width: logisticsWidth,
        logistics_height: logisticsHeight,
        logistics_length: logisticsLength,
        volumetricWeight
      }
    })

    // Determine destination based on shipping country
    const country = shippingAddress?.country || ''
    const isUK = country.toLowerCase().includes('uk') || country.toLowerCase().includes('united kingdom')
    const destination = isUK ? 'domestic' : 'international'

    return {
      items_info: itemsInfo,
      l_method: 'metsab_courier',
      l_status: 'pending',
      l_postal_code: shippingAddress?.postal_code,
      l_destination: destination,
      l_country: country
    }
  } catch (error) {
    console.error('Error in prefillLogisticsData:', error)
    return {
      items_info: [],
      l_method: 'metsab_courier',
      l_status: 'pending'
    }
  }
}

/**
 * Update logistics status
 */
export async function updateLogisticsStatus(
  invoiceId: number,
  status: string
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('invoices')
      .update({
        l_status: status,
        updated_at: new Date().toISOString()
      })
      .eq('id', invoiceId)

    if (error) {
      console.error('Error updating logistics status:', error)
      return false
    }

    return true
  } catch (error) {
    console.error('Error in updateLogisticsStatus:', error)
    return false
  }
}

/**
 * Calculate total logistics cost based on items
 */
export function calculateLogisticsCost(
  itemsInfo: ItemLogisticsInfo[],
  destination: string,
  method: string
): {
  shipping_cost: number
  insurance_cost: number
  total_cost: number
} {
  if (method === 'customer_collection' || method === 'customer_courier') {
    return {
      shipping_cost: 0,
      insurance_cost: 0,
      total_cost: 0
    }
  }

  // Calculate total billable weight
  const totalBillableWeight = itemsInfo.reduce((sum, item) => sum + item.billableWeight, 0)

  // Base shipping rates (these should ideally come from a config or database)
  const domesticRatePerKg = 5 // £5 per kg
  const internationalRatePerKg = 15 // £15 per kg

  const ratePerKg = destination === 'international' ? internationalRatePerKg : domesticRatePerKg
  const shippingCost = Math.max(totalBillableWeight * ratePerKg, 10) // Minimum £10

  // Insurance cost (2% of estimated value, minimum £5)
  const insuranceCost = Math.max(itemsInfo.length * 10, 5)

  return {
    shipping_cost: Math.round(shippingCost * 100) / 100,
    insurance_cost: Math.round(insuranceCost * 100) / 100,
    total_cost: Math.round((shippingCost + insuranceCost) * 100) / 100
  }
}

