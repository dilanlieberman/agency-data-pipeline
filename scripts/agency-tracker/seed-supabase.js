require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS setter_daily (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  setter_name TEXT NOT NULL,
  location_id TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  sms_sent INT DEFAULT 0,
  replies INT DEFAULT 0,
  calls_booked INT DEFAULT 0,
  calls_showed INT DEFAULT 0,
  closed_trial INT DEFAULT 0,
  closed_ppa INT DEFAULT 0,
  week2_extensions INT DEFAULT 0,
  retainer_upgrades INT DEFAULT 0,
  close_rate NUMERIC(5,2) DEFAULT 0,
  commission_owed NUMERIC(10,2) DEFAULT 0,
  mrr_slice NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(setter_name, date)
);

CREATE TABLE IF NOT EXISTS closer_daily (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  retainer_closes INT DEFAULT 0,
  trial_closes INT DEFAULT 0,
  builder_closes INT DEFAULT 0,
  builder_downsell_closes INT DEFAULT 0,
  retainer_upgrades INT DEFAULT 0,
  close_rate NUMERIC(5,2) DEFAULT 0,
  commission_owed NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date)
);

CREATE TABLE IF NOT EXISTS ppa_client_daily (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_name TEXT NOT NULL,
  location_id TEXT NOT NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  appts_booked INT DEFAULT 0,
  appts_showed INT DEFAULT 0,
  appts_qualified INT DEFAULT 0,
  amount_owed NUMERIC(10,2) DEFAULT 0,
  ach_status TEXT DEFAULT 'pending',
  days_since_launch INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_name, date)
);

CREATE TABLE IF NOT EXISTS retainer_client (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_name TEXT NOT NULL,
  location_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  monthly_rate NUMERIC(10,2) DEFAULT 2500,
  website_live BOOLEAN DEFAULT FALSE,
  seo_active BOOLEAN DEFAULT FALSE,
  revshare_balance NUMERIC(10,2) DEFAULT 0,
  revshare_cap NUMERIC(10,2) DEFAULT 3000,
  months_active INT DEFAULT 0,
  setter_attributed TEXT,
  status TEXT DEFAULT 'active',
  start_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_name)
);

CREATE TABLE IF NOT EXISTS builder_pipeline (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  builder_name TEXT NOT NULL,
  location_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  entry_fee_paid NUMERIC(10,2) DEFAULT 0,
  contract_value NUMERIC(12,2) DEFAULT 0,
  revshare_projected NUMERIC(10,2) DEFAULT 0,
  days_in_stage INT DEFAULT 0,
  projected_payout_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(builder_name)
);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agency_daily (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_sms_sent INT DEFAULT 0,
  total_replies INT DEFAULT 0,
  total_closes INT DEFAULT 0,
  total_ppa_revenue NUMERIC(10,2) DEFAULT 0,
  total_retainer_mrr NUMERIC(10,2) DEFAULT 0,
  total_commission_owed NUMERIC(10,2) DEFAULT 0,
  lead_bank_remaining INT DEFAULT 0,
  lead_bank_daily_burn INT DEFAULT 0,
  lead_bank_runway_days INT DEFAULT 0,
  builder_pipeline_value NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date)
);
`;

async function seed() {
  console.log('Creating Supabase tables...');
  const { error } = await supabase.rpc('exec_sql', { sql: TABLES_SQL });
  if (error) {
    console.log('RPC not available — run the SQL manually in Supabase SQL Editor:');
    console.log(TABLES_SQL);
    console.log('\nCopy the SQL above into https://supabase.com/dashboard → SQL Editor → Run');
    return;
  }
  console.log('Tables created successfully.');
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
