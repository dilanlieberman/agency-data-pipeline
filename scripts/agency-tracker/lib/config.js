const fs = require('fs');
const path = require('path');

// Team location mapping
const SETTERS = {
  dilan: {
    locationIds: ['QOb4tW3N9V0i97IHdaol', 'IpuSv4jgeeoI0hS1Ib7e'],
    name: 'dilan sub acc 1 + 2',
  },
  cesar: {
    locationId: 'waStZftBf5D40prioYoj',
    name: 'cesar sub acc 1',
  },
  cole: {
    locationId: 'o35tMRm72poYzDndLy87',
    name: 'coleton sub acc 1',
  },
  sofie: {
    locationId: '3iyaLi4IT7AqbT2b1VZN',
    name: 'tony sub acc 2',
  },
};

const CLOSER = {
  tony: {
    paidAdsLocationId: 'IpuSv4jgeeoI0hS1Ib7e',
    builderLocationId: 'bA26aysHNm0ItD2Dieuo',
    name: 'Tony Salada',
  },
};

// Setter compensation per action
const SETTER_COMP = {
  ppa_close: 250,
  trial_close: 250,
  second_week_close: 250,
  retainer_upgrade: 250,
  mrr_per_retainer: 75,
};

// Closer compensation per action
const CLOSER_COMP = {
  retainer_close: 750,
  trial_close: 250,
  builder_close: 750,
  builder_downsell: 500,
  retainer_upgrade: 750,
};

// Alert thresholds
const ALERT_THRESHOLDS = {
  zero_appts_days: 3,
  setter_low_close_pct: 20,
  setter_low_close_weeks: 2,
  closer_low_close_pct: 30,
  lead_bank_runway_days: 60,
  reply_rate_drop_pct: 30,
};

// GHL tag names
const GHL_TAGS = {
  qualified_appt: 'qualified_appt',
  website_live: 'website_live',
  seo_active: 'seo_active',
  retainer_upgrade: 'retainer_upgrade',
  builder_foundations: 'builder_foundations',
  ach_active: 'ach_active',
};

// GHL API constants
const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';
const PPA_RATE = 100;

// Main pipeline stages (SMS → Churned)
const PIPELINE_STAGES = [
  'SMS sent',
  'Reply received',
  'Call booked',
  'Call showed',
  'Closed trial',
  'Closed PPA',
  'Week 2 extension',
  'Retainer upgrade',
  'Website live',
  'Churned',
];

// Builder pipeline stages
const BUILDER_STAGES = [
  'inquiry',
  'discovery',
  'plot_review',
  'proposal',
  'contract',
  'foundations',
  'paid',
];

// Load tokens from file
let cachedTokens = null;

function loadTokens() {
  if (cachedTokens) {
    return cachedTokens;
  }

  const tokensPath = path.join(__dirname, '../../../data/sub-account-tokens.json');
  const tokensContent = fs.readFileSync(tokensPath, 'utf8');
  cachedTokens = JSON.parse(tokensContent);
  return cachedTokens;
}

// Get token string for a given location ID
function getToken(locationId) {
  const tokens = loadTokens();
  if (!tokens[locationId]) {
    throw new Error(`Token for location ID "${locationId}" not found in sub-account-tokens.json`);
  }
  return tokens[locationId].token;
}

module.exports = {
  SETTERS,
  CLOSER,
  SETTER_COMP,
  CLOSER_COMP,
  ALERT_THRESHOLDS,
  GHL_TAGS,
  GHL_BASE,
  GHL_VERSION,
  PPA_RATE,
  PIPELINE_STAGES,
  BUILDER_STAGES,
  loadTokens,
  getToken,
};
