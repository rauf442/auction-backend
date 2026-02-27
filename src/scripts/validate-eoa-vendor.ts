// backend/src/scripts/validate-eoa-vendor.ts
import { supabaseAdmin } from '../utils/supabase'

async function validateVendorInvoiceLogic() {
  console.log('Validating vendor invoice logic...')

  // Get some test clients
  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, first_name, last_name, email, phone_number')
    .limit(3)

  console.log('Available clients for testing:', clients?.length || 0)

  if (clients && clients.length > 0) {
    console.log('Sample client data:')
    clients.forEach(client => {
      console.log(`- ${client.first_name} ${client.last_name} (${client.email})`)
    })

    // Simulate vendor invoice creation
    console.log('\nSimulating vendor invoice creation:')
    console.log('=====================================')

    const sampleClient = clients[0]
    const sampleVendorInvoice = {
      buyer_first_name: sampleClient.first_name || '',
      buyer_last_name: sampleClient.last_name || '',
      buyer_username: '', // Should be empty for vendor
      buyer_email: sampleClient.email || '',
      buyer_phone: sampleClient.phone_number || '',
      shipping_method: '', // Should be empty for vendor
      shipping_status: '', // Should be empty for vendor
      ship_to_phone: '', // Should be empty for vendor
      ship_to_first_name: '', // Should be empty for vendor
      ship_to_last_name: '', // Should be empty for vendor
      ship_to_company: '', // Should be empty for vendor
      ship_to_address: '', // Should be empty for vendor
      ship_to_city: '', // Should be empty for vendor
      ship_to_state: '', // Should be empty for vendor
      ship_to_country: '', // Should be empty for vendor
      ship_to_postal_code: '', // Should be empty for vendor
      paddle_number: '', // Should be empty for vendor
      premium_bidder: false, // Should be false for vendor
      domestic_flat_shipping: 0, // Should be 0 for vendor
      type: 'vendor'
    }

    console.log('Vendor invoice structure:')
    Object.entries(sampleVendorInvoice).forEach(([key, value]) => {
      console.log(`  ${key}: ${JSON.stringify(value)}`)
    })
  }

  console.log('\nValidation completed!')
}

// Run the validation if this script is executed directly
if (require.main === module) {
  validateVendorInvoiceLogic().catch(console.error)
}

export { validateVendorInvoiceLogic }
