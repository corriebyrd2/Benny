// Authoritative business-profile configuration.
//
// Every public claim about who this business is — name, address or service
// area, phone, email, hours, emergency contact, social profiles, licensing —
// resolves through this module. Two rules make it trustworthy:
//
//   1. NOTHING IS INVENTED. There are no default/placeholder values. A field
//      the owner has not supplied is absent, and every public surface that
//      would have rendered it hides itself instead. The site previously
//      shipped "123 Pawsome Lane, Dogtown, CA 90210" and "(555) BENNY-PET"
//      as seeded defaults, which are indistinguishable from real data to a
//      visitor and to Google.
//
//   2. MISSING REQUIRED FIELDS BLOCK LAUNCH. `launchCheck()` reports exactly
//      which fields are absent and why they matter. `npm run check:launch`
//      exits non-zero on failure so a deploy pipeline can gate on it, and the
//      server logs the same report at boot.
//
// Values live in the site_settings table (editable by the admin) with an
// environment-variable fallback so a deployment can be configured before
// anyone logs into the admin panel.

const { query } = require('./database');

// Known placeholder values that shipped as seed data. Treated as absent
// wherever they still exist, so a stale database cannot publish them.
const PLACEHOLDERS = new Set([
  '123 pawsome lane',
  'dogtown, ca 90210',
  '(555) benny-pet',
  '(555) 236-6973',
  'woof@bennyandthepets.com',
  '123 pawsome lane\ndogtown, ca 90210',
  '(555) benny-pet\n(555) 236-6973'
]);

function isPlaceholder(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return true;
  if (PLACEHOLDERS.has(v)) return true;
  // Any US "555" directory-reserved number, and any obviously fictional
  // vanity spelling of one.
  if (/^\(?555\)?[\s.-]/.test(v)) return true;
  return false;
}

/**
 * Field catalogue.
 *
 * required: 'launch'  — the site must not be publicly launched without it
 *           'public'  — needed only by the component that renders it
 * env:      environment variable consulted when the setting row is empty
 */
const FIELDS = [
  { key: 'business_name', label: 'Public trading name', required: 'launch', env: 'BUSINESS_NAME' },
  { key: 'legal_business_name', label: 'Registered legal entity name', required: 'launch', env: 'BUSINESS_LEGAL_NAME' },
  { key: 'contact_email', label: 'Domain-based support email', required: 'launch', env: 'BUSINESS_EMAIL', type: 'email' },
  { key: 'contact_phone_display', label: 'Verified phone number', required: 'launch', env: 'BUSINESS_PHONE', type: 'phone' },
  { key: 'contact_phone_secondary', label: 'Secondary phone number', required: 'public', type: 'phone' },
  { key: 'service_area', label: 'Service-area statement', required: 'launch', env: 'BUSINESS_SERVICE_AREA' },
  { key: 'contact_address_line1', label: 'Street address', required: 'public' },
  { key: 'contact_address_line2', label: 'City, state, postal code', required: 'public' },
  { key: 'address_locality', label: 'City (structured data)', required: 'public' },
  { key: 'address_region', label: 'State/region (structured data)', required: 'public' },
  { key: 'address_postal_code', label: 'Postal code (structured data)', required: 'public' },
  { key: 'address_country', label: 'Country code (structured data)', required: 'public' },
  { key: 'hours_weekday', label: 'Weekday operating hours', required: 'launch', env: 'BUSINESS_HOURS_WEEKDAY' },
  { key: 'hours_weekend', label: 'Weekend operating hours', required: 'public' },
  { key: 'emergency_contact', label: 'Emergency / after-hours instructions', required: 'launch', env: 'BUSINESS_EMERGENCY_CONTACT' },
  { key: 'footer_tagline', label: 'Footer tagline', required: 'public' },
  { key: 'facebook_url', label: 'Facebook profile URL', required: 'public', type: 'url' },
  { key: 'instagram_url', label: 'Instagram profile URL', required: 'public', type: 'url' },
  { key: 'tiktok_url', label: 'TikTok profile URL', required: 'public', type: 'url' },
  { key: 'google_business_url', label: 'Google Business Profile URL', required: 'public', type: 'url' },
  { key: 'license_number', label: 'Boarding/kennel licence number', required: 'public' },
  { key: 'license_authority', label: 'Licensing authority', required: 'public' },
  { key: 'insurance_statement', label: 'Insurance statement', required: 'public' },
  { key: 'years_in_operation', label: 'Year the business started trading', required: 'public', type: 'year' }
];

const FIELD_KEYS = FIELDS.map(f => f.key);
const FIELDS_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));
const LAUNCH_REQUIRED = FIELDS.filter(f => f.required === 'launch').map(f => f.key);

// Per-type sanity checks. These reject values that are structurally wrong; they
// cannot verify that a real phone number belongs to this business — only the
// owner can do that.
function validateValue(field, value) {
  const v = String(value || '').trim();
  if (!v) return 'empty';
  if (isPlaceholder(v)) return 'placeholder';
  switch (field.type) {
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'not a valid email address';
      return null;
    case 'url':
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:') return 'must be an https URL';
        return null;
      } catch {
        return 'not a valid URL';
      }
    case 'phone': {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 7) return 'not enough digits to be a real phone number';
      return null;
    }
    case 'year': {
      const year = parseInt(v, 10);
      const now = new Date().getUTCFullYear();
      if (!Number.isInteger(year) || year < 1900 || year > now) return 'must be a past four-digit year';
      return null;
    }
    default:
      return null;
  }
}

async function readSettings() {
  const { rows } = await query('SELECT key, value FROM site_settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * Resolve the profile. Returns only fields that are present AND structurally
 * valid; anything else is reported in `missing` and never published.
 */
async function getBusinessProfile() {
  const settings = await readSettings();
  const values = {};
  const missing = [];

  for (const field of FIELDS) {
    const raw = settings[field.key] || (field.env ? process.env[field.env] : '') || '';
    const problem = validateValue(field, raw);
    if (problem) {
      missing.push({ key: field.key, label: field.label, required: field.required, reason: problem });
    } else {
      values[field.key] = String(raw).trim();
    }
  }

  return {
    values,
    missing,
    // Convenience predicates for templates: only render a component when the
    // data behind it exists.
    has: key => Object.prototype.hasOwnProperty.call(values, key),
    hasAddress: !!(values.contact_address_line1 && values.contact_address_line2),
    hasServiceArea: !!values.service_area,
    socialLinks: ['facebook_url', 'instagram_url', 'tiktok_url', 'google_business_url']
      .filter(k => values[k])
      .map(k => ({ key: k, url: values[k], name: SOCIAL_NAMES[k] }))
  };
}

const SOCIAL_NAMES = {
  facebook_url: 'Facebook',
  instagram_url: 'Instagram',
  tiktok_url: 'TikTok',
  google_business_url: 'Google Business Profile'
};

/**
 * Launch gate. `ok: false` means the site is not fit to be publicly launched
 * because it cannot truthfully tell a visitor who it is or how to reach it.
 */
async function launchCheck() {
  const profile = await getBusinessProfile();
  const blocking = profile.missing.filter(m => m.required === 'launch');
  return {
    ok: blocking.length === 0,
    blocking,
    advisory: profile.missing.filter(m => m.required !== 'launch'),
    checked_at: new Date().toISOString()
  };
}

function formatLaunchReport(result) {
  if (result.ok) return 'Business profile complete — all launch-required fields are configured.';
  const lines = [
    'LAUNCH BLOCKED — required business information is missing or is still placeholder data.',
    'The affected public components are hidden until an administrator supplies real values',
    'in Admin -> Settings (or the matching environment variable).',
    ''
  ];
  for (const m of result.blocking) {
    const field = FIELDS_BY_KEY.get(m.key);
    const env = field && field.env ? `  (env: ${field.env})` : '';
    lines.push(`  - ${m.key}: ${m.label} — ${m.reason}${env}`);
  }
  return lines.join('\n');
}

module.exports = {
  FIELDS,
  FIELD_KEYS,
  LAUNCH_REQUIRED,
  SOCIAL_NAMES,
  formatLaunchReport,
  getBusinessProfile,
  isPlaceholder,
  launchCheck,
  validateValue
};
