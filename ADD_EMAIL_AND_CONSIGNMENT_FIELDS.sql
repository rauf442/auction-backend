-- Migration: Add email tracking and consignment date fields
-- Run this SQL in your Supabase SQL Editor

-- Add email tracking columns to invoices table
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS email_winning_bid_sent_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS email_payment_confirmation_sent_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS email_shipping_confirmation_sent_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS email_vendor_sale_notification_sent_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS email_vendor_payment_confirmation_sent_at TIMESTAMP WITH TIME ZONE;

-- Add consignment date columns to consignments table
ALTER TABLE public.consignments
ADD COLUMN IF NOT EXISTS consignment_receipt_date TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS pre_sale_date TIMESTAMP WITH TIME ZONE;

-- Add comments for documentation
COMMENT ON COLUMN public.invoices.email_winning_bid_sent_at IS 'Timestamp when winning bid email was sent';
COMMENT ON COLUMN public.invoices.email_payment_confirmation_sent_at IS 'Timestamp when payment confirmation email was sent';
COMMENT ON COLUMN public.invoices.email_shipping_confirmation_sent_at IS 'Timestamp when shipping confirmation email was sent';
COMMENT ON COLUMN public.invoices.email_vendor_sale_notification_sent_at IS 'Timestamp when vendor sale notification email was sent';
COMMENT ON COLUMN public.invoices.email_vendor_payment_confirmation_sent_at IS 'Timestamp when vendor payment confirmation email was sent';
COMMENT ON COLUMN public.consignments.consignment_receipt_date IS 'Date for consignment receipt (1 month back from auction start)';
COMMENT ON COLUMN public.consignments.pre_sale_date IS 'Date for pre-sale (15 days back from auction start)';

