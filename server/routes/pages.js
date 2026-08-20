// Server-rendered public pages: homepage, per-service detail pages, the policy
// library, robots.txt, sitemap.xml and the web manifest.
//
// Rendering these on the server (rather than shipping a static file that a
// script rewrites) is what makes three of the original defects fixable:
//
//   * The homepage advertised four services while the API served two, because
//     the four were hardcoded in the HTML and only *replaced* if the fetch
//     succeeded. Here the catalog is the only source — there is no fallback
//     copy to drift.
//   * Placeholder contact details were baked into the markup. Here a component
//     is emitted only when the underlying business fact is configured.
//   * Every URL shared one title and had no canonical. Each page now carries
//     its own title, description, canonical, Open Graph data and structured
//     data.

const express = require('express');
const { query } = require('../database');
const cache = require('../cache');
const { renderPage, baseUrlFor, escapeHtml } = require('../render');
const { getBusinessProfile } = require('../businessProfile');
const { listPolicies, getPolicy } = require('../legal');
const services = require('./services');
const photos = require('./photos');
const assets = require('../assets');
const { priceLabelLong } = require('../pricing');

const router = express.Router();

const APPROVAL_TIMELINE =
  'We aim to respond to booking requests within one business day.';

// ---------------------------------------------------------------------------
// Shared view data
// ---------------------------------------------------------------------------

async function commonData(req) {
  const profile = await getBusinessProfile();
  const brand = profile.values.business_name || 'Benny and the Pets';
  return {
    profile,
    brand,
    legal_name: profile.values.legal_business_name || brand,
    footer_tagline: profile.values.footer_tagline || '',
    year: new Date().getUTCFullYear(),
    approval_timeline: APPROVAL_TIMELINE,
    asset_css: assets.url('/css/style.css'),
    asset_js: assets.url('/js/main.js'),
    baseUrl: baseUrlFor(req)
  };
}

function policyLinks(exceptSlug) {
  return listPolicies()
    .filter(p => p.slug !== exceptSlug)
    .map(p => `<li><a href="/legal/${p.slug}">${escapeHtml(p.title)}</a></li>`)
    .join('\n');
}

function footerLegalHtml() {
  // The policies a visitor most needs are linked directly; the rest are one
  // click away through the index, so the footer stays scannable.
  const primary = ['privacy', 'terms', 'cancellation-policy', 'boarding-agreement', 'accessibility'];
  const items = primary
    .map(slug => getPolicy(slug))
    .filter(Boolean)
    .map(p => `<li><a href="/legal/${p.slug}">${escapeHtml(p.title)}</a></li>`);
  items.push('<li><a href="/legal">All policies</a></li>');
  return items.join('\n');
}

// ---------------------------------------------------------------------------
// Business-profile driven components. Each returns '' when the underlying fact
// has not been supplied and verified, so nothing invented is ever published.
// ---------------------------------------------------------------------------

function contactHtml(profile) {
  const v = profile.values;
  const cards = [];

  if (profile.hasAddress) {
    const mapQuery = encodeURIComponent(`${v.contact_address_line1}, ${v.contact_address_line2}`);
    cards.push(`
      <div class="info-card">
        <span class="info-icon" aria-hidden="true">&#128205;</span>
        <h3>Visit us</h3>
        <address>${escapeHtml(v.contact_address_line1)}<br>${escapeHtml(v.contact_address_line2)}</address>
        <a href="https://www.google.com/maps/search/?api=1&amp;query=${mapQuery}" rel="noopener">
          Open in Google Maps<span class="visually-hidden"> (opens Google Maps)</span>
        </a>
      </div>`);
  } else if (v.service_area) {
    cards.push(`
      <div class="info-card">
        <span class="info-icon" aria-hidden="true">&#128205;</span>
        <h3>Where we are</h3>
        <p>${escapeHtml(v.service_area)}</p>
      </div>`);
  }

  if (v.contact_phone_display) {
    const tel = v.contact_phone_display.replace(/[^\d+]/g, '');
    const secondary = v.contact_phone_secondary
      ? `<br><a href="tel:${escapeHtml(v.contact_phone_secondary.replace(/[^\d+]/g, ''))}">${escapeHtml(v.contact_phone_secondary)}</a>`
      : '';
    cards.push(`
      <div class="info-card">
        <span class="info-icon" aria-hidden="true">&#128222;</span>
        <h3>Call us</h3>
        <p><a href="tel:${escapeHtml(tel)}">${escapeHtml(v.contact_phone_display)}</a>${secondary}</p>
      </div>`);
  }

  if (v.contact_email) {
    cards.push(`
      <div class="info-card">
        <span class="info-icon" aria-hidden="true">&#128231;</span>
        <h3>Email us</h3>
        <p><a href="mailto:${escapeHtml(v.contact_email)}">${escapeHtml(v.contact_email)}</a></p>
      </div>`);
  }

  if (v.hours_weekday) {
    const weekend = v.hours_weekend ? `<br>${escapeHtml(v.hours_weekend)}` : '';
    cards.push(`
      <div class="info-card">
        <span class="info-icon" aria-hidden="true">&#128336;</span>
        <h3>Opening hours</h3>
        <p>${escapeHtml(v.hours_weekday)}${weekend}</p>
      </div>`);
  }

  if (v.emergency_contact) {
    cards.push(`
      <div class="info-card info-card-emergency">
        <span class="info-icon" aria-hidden="true">&#9888;&#65039;</span>
        <h3>Out of hours</h3>
        <p>${escapeHtml(v.emergency_contact)}</p>
      </div>`);
  }

  if (cards.length === 0) {
    // Nothing verified to publish. Say so plainly rather than printing an
    // invented address — and still give the visitor a working route in.
    return `
      <div class="contact-info">
        <div class="info-card">
          <h3>Contact details</h3>
          <p>Our published contact details are being confirmed. In the meantime,
             send a booking request or question from
             <a href="/my-bookings">your account</a> and we'll reply by email.</p>
        </div>
      </div>`;
  }

  return `<div class="contact-info">${cards.join('\n')}</div>`;
}

function socialHtml(profile) {
  if (profile.socialLinks.length === 0) return '';
  const links = profile.socialLinks.map(l => `
    <a href="${escapeHtml(l.url)}" class="social-link" target="_blank" rel="noopener">
      <span aria-hidden="true">${escapeHtml(l.name.slice(0, 2).toUpperCase())}</span>
      <span class="visually-hidden">${escapeHtml(l.name)} (opens in a new tab)</span>
    </a>`).join('\n');
  return `<div class="social-links">${links}</div>`;
}

// Credentials are published ONLY when the owner has supplied them. The original
// site claimed "12+ Years Experience", "500+ Happy Dogs" and "100% Tail Wags"
// with nothing behind them, and the deployed build rendered them as "0+" and
// "5%" because the counter animation never completed.
function credentialsHtml(profile) {
  const v = profile.values;
  const items = [];
  if (v.years_in_operation) {
    const years = new Date().getUTCFullYear() - parseInt(v.years_in_operation, 10);
    if (years >= 1) {
      items.push(`<li><strong>Trading since ${escapeHtml(v.years_in_operation)}</strong><span>${years} year${years === 1 ? '' : 's'} in operation</span></li>`);
    }
  }
  if (v.license_number) {
    const authority = v.license_authority ? ` &mdash; ${escapeHtml(v.license_authority)}` : '';
    items.push(`<li><strong>Licence ${escapeHtml(v.license_number)}</strong><span>Registered boarding licence${authority}</span></li>`);
  }
  if (v.insurance_statement) {
    items.push(`<li><strong>Insured</strong><span>${escapeHtml(v.insurance_statement)}</span></li>`);
  }
  if (items.length === 0) return '';
  return `
    <h4 class="credentials-heading">Verified details</h4>
    <ul class="about-credentials">${items.join('\n')}</ul>`;
}

// ---------------------------------------------------------------------------
// Catalog components
// ---------------------------------------------------------------------------

function serviceCardHtml(service) {
  const perks = service.perks.map(p => `<li>${escapeHtml(p)}</li>`).join('');
  const featured = service.is_featured ? ' featured' : '';
  const badge = service.is_featured ? '<p class="featured-badge">Most popular</p>' : '';

  let statusNote = '';
  let cta = `<a class="btn btn-primary service-cta" href="/my-bookings?service=${service.id}">Request ${escapeHtml(service.name)}</a>`;

  if (service.booking_mode === 'inquiry') {
    statusNote = '<p class="service-status service-status-inquiry">Enquiry only &mdash; not yet bookable online</p>';
    cta = `<a class="btn btn-secondary service-cta" href="/#contact">Ask about ${escapeHtml(service.name)}</a>`;
  } else if (service.booking_mode === 'unavailable') {
    statusNote = '<p class="service-status service-status-unavailable">Temporarily unavailable</p>';
    cta = `<a class="btn btn-secondary service-cta" href="/#contact">Contact us about availability</a>`;
  }

  return `
    <article class="service-card${featured}" data-tilt>
      ${badge}
      <p class="service-icon" aria-hidden="true">${escapeHtml(service.icon)}</p>
      <h3><a href="/services/${service.slug}">${escapeHtml(service.name)}</a></h3>
      <p>${escapeHtml(service.description)}</p>
      <ul class="service-perks">${perks}</ul>
      <p class="service-price">
        <span aria-hidden="true">${escapeHtml(service.price_label)}</span>
        <span class="visually-hidden">${escapeHtml(service.price_label_long)}</span>
      </p>
      ${statusNote}
      ${cta}
    </article>`;
}

function servicesNoteHtml(list) {
  const bookable = list.filter(s => s.bookable).length;
  if (list.length === 0) {
    return `<p class="empty-state">Our service list is being updated. <a href="/#contact">Contact us</a> and we'll tell you what's available.</p>`;
  }
  if (bookable === list.length) return '';
  return `<p class="services-note">Services marked "enquiry only" aren't bookable online yet &mdash;
          <a href="/#contact">ask us</a> and we'll tell you what's possible.</p>`;
}

// ---------------------------------------------------------------------------
// Photos and reviews — real data only. Where there is none, an honest empty
// state replaces the invented "Max playing fetch" / "Sarah M." placeholders.
// ---------------------------------------------------------------------------

// The cached read is the query alone. The fallback below stays OUTSIDE it so a
// transient database failure degrades this one render to an empty gallery
// rather than pinning an empty gallery in the cache for the whole TTL.
const readHomepagePhotos = cache.register('photos:homepage', ['photos'], async () => {
  const { rows } = await query(
    `SELECT id, filename, caption, layout, section FROM photos
     WHERE show_on_homepage = TRUE ORDER BY display_order ASC, id ASC LIMIT 60`
  );
  // photos.js owns how a stored filename becomes a URL (R2 streaming route
  // vs local uploads dir); reuse it rather than duplicating the rule here.
  return rows.map(photos.withUrl);
});

async function loadPhotos() {
  try {
    return await readHomepagePhotos();
  } catch (err) {
    console.error('[home] could not load photos:', err.message);
    return [];
  }
}

function galleryHtml(photos) {
  const gallery = photos.filter(p => (p.section || 'gallery') === 'gallery');
  if (gallery.length === 0) return '';
  const items = gallery.map((p, i) => {
    const layout = p.layout === 'large' ? ' large' : (p.layout === 'tall' ? ' tall' : '');
    const caption = escapeHtml(p.caption || '');
    // A photo with a caption is a figure: the caption is its accessible name,
    // so the alt attribute must not repeat it.
    return `
      <figure class="gallery-item${layout}">
        <img src="${escapeHtml(p.url)}" alt="${caption ? '' : 'Dog staying with us'}"
             loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async" width="600" height="600">
        ${caption ? `<figcaption>${caption}</figcaption>` : ''}
      </figure>`;
  }).join('\n');
  return `
    <section class="gallery" id="gallery" aria-labelledby="gallery-heading">
      <div class="container">
        <div class="section-header">
          <p class="section-tag">Our guests</p>
          <h2 id="gallery-heading">Dogs who've stayed with us</h2>
        </div>
        <div class="gallery-grid">${items}</div>
      </div>
    </section>`;
}

function sectionPhotoHtml(photos, section, { aspect }) {
  const photo = photos.find(p => p.section === section);
  if (!photo) return '';
  const cls = aspect === 'about' ? 'about-photo' : 'hero-photo';
  return `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.caption || '')}"
           class="${cls}" width="800" height="1000" decoding="async">`;
}

// Cached; the fallback stays outside it, for the reason given above loadPhotos.
const readApprovedReviews = cache.register('reviews:approved', ['reviews'], async () => {
  const { rows } = await query(
    `SELECT id, reviewer_name, pet_name, rating, review_text, created_at
     FROM reviews WHERE status = 'approved'
     ORDER BY reviewed_at ASC, id ASC LIMIT 24`
  );
  return rows;
});

async function loadApprovedReviews() {
  try {
    return await readApprovedReviews();
  } catch (err) {
    console.error('[home] could not load reviews:', err.message);
    return [];
  }
}

function reviewsHtml(reviews) {
  if (reviews.length === 0) {
    return `
      <p class="empty-state" id="reviewsEmpty">
        No reviews have been published yet. If you've stayed with us, yours would
        be the first &mdash; the form below goes straight to moderation.
      </p>`;
  }
  const cards = reviews.map((r, i) => {
    const rating = Math.min(5, Math.max(1, parseInt(r.rating, 10) || 5));
    const subtitle = r.pet_name ? `${r.pet_name}'s human` : 'Verified customer';
    return `
      <li class="testimonial-card" id="testimonial-${r.id}" role="group"
          aria-roledescription="review" aria-label="Review ${i + 1} of ${reviews.length}">
        <p class="testimonial-stars">
          <span aria-hidden="true">${'⭐'.repeat(rating)}</span>
          <span class="visually-hidden">${rating} out of 5 stars</span>
        </p>
        <blockquote><p>${escapeHtml(r.review_text)}</p></blockquote>
        <div class="testimonial-author">
          <span class="author-avatar" aria-hidden="true">&#128062;</span>
          <p><strong>${escapeHtml(r.reviewer_name)}</strong><span>${escapeHtml(subtitle)}</span></p>
        </div>
      </li>`;
  }).join('\n');

  return `
    <div class="testimonials-carousel" id="testimonialsCarousel">
      <ul class="testimonial-track" id="testimonialTrack">${cards}</ul>
      <div class="carousel-controls">
        <button type="button" class="carousel-btn prev" id="carouselPrev">
          <span aria-hidden="true">&#8592;</span><span class="visually-hidden">Previous review</span>
        </button>
        <div class="carousel-dots" id="carouselDots" role="tablist" aria-label="Choose a review"></div>
        <button type="button" class="carousel-btn next" id="carouselNext">
          <span aria-hidden="true">&#8594;</span><span class="visually-hidden">Next review</span>
        </button>
      </div>
      <p class="visually-hidden" id="carouselStatus" role="status" aria-live="polite"></p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Structured data. Only fields backed by configured, verified values are
// emitted — schema.org markup asserting a fake address is worse than none.
// ---------------------------------------------------------------------------

function localBusinessJsonLd(profile, baseUrl, serviceList) {
  const v = profile.values;
  const node = {
    '@context': 'https://schema.org',
    '@type': 'AnimalBoardingFacility',
    '@id': `${baseUrl}/#business`,
    name: v.business_name || 'Benny and the Pets',
    url: `${baseUrl}/`,
    image: `${baseUrl}/images/og-card.png`
  };
  if (v.legal_business_name) node.legalName = v.legal_business_name;
  if (v.contact_email) node.email = v.contact_email;
  if (v.contact_phone_display) node.telephone = v.contact_phone_display;
  if (v.contact_address_line1 && v.contact_address_line2) {
    node.address = {
      '@type': 'PostalAddress',
      streetAddress: v.contact_address_line1,
      addressLocality: v.address_locality || undefined,
      addressRegion: v.address_region || undefined,
      postalCode: v.address_postal_code || undefined,
      addressCountry: v.address_country || undefined
    };
  }
  if (v.service_area) node.areaServed = v.service_area;
  const sameAs = profile.socialLinks.map(l => l.url);
  if (sameAs.length) node.sameAs = sameAs;

  const offers = serviceList.filter(s => s.bookable).map(s => ({
    '@type': 'Offer',
    name: s.name,
    url: `${baseUrl}/services/${s.slug}`,
    price: (s.price_cents / 100).toFixed(2),
    priceCurrency: s.currency.toUpperCase(),
    availability: 'https://schema.org/InStock'
  }));
  if (offers.length) {
    node.makesOffer = offers;
  }
  return node;
}

function serviceJsonLd(service, profile, baseUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: service.name,
    description: service.description,
    url: `${baseUrl}/services/${service.slug}`,
    serviceType: service.name,
    provider: { '@id': `${baseUrl}/#business` },
    ...(service.bookable ? {
      offers: {
        '@type': 'Offer',
        price: (service.price_cents / 100).toFixed(2),
        priceCurrency: service.currency.toUpperCase(),
        availability: 'https://schema.org/InStock',
        url: `${baseUrl}/services/${service.slug}`
      }
    } : {})
  };
}

function breadcrumbJsonLd(baseUrl, trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${baseUrl}${item.path}`
    }))
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const common = await commonData(req);
    const [list, photos, reviews] = await Promise.all([
      services.listPublicServices(),
      loadPhotos(),
      loadApprovedReviews()
    ]);

    const profile = common.profile;
    const heroEyebrow = profile.values.service_area
      ? `Dog boarding & daycare — ${profile.values.service_area}`
      : 'Dog boarding & daycare';

    const description = profile.values.service_area
      ? `Overnight dog boarding and daycare in ${profile.values.service_area}, run by Ben. Request dates online, get approved, then pay securely. Vaccination records required.`
      : 'Overnight dog boarding and daycare run by Ben. Request your dates online, get approved, then pay securely. Vaccination records required for every dog.';

    const html = renderPage({
      view: 'home',
      nonce: res.locals.cspNonce,
      baseUrl: common.baseUrl,
      meta: {
        title: `${common.brand} | Dog Boarding & Daycare`,
        description,
        canonicalPath: '/',
        ogImage: '/images/og-card.png',
        ogImageAlt: `${common.brand} logo`,
        jsonLd: [
          localBusinessJsonLd(profile, common.baseUrl, list),
          {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: common.brand,
            url: `${common.baseUrl}/`
          }
        ]
      },
      data: {
        ...common,
        hero_eyebrow: heroEyebrow,
        services_html: list.map(serviceCardHtml).join('\n'),
        services_note_html: servicesNoteHtml(list),
        footer_services_html: list
          .map(s => `<li><a href="/services/${s.slug}">${escapeHtml(s.name)}</a></li>`)
          .join('\n'),
        footer_legal_html: footerLegalHtml(),
        contact_html: contactHtml(profile),
        // Drives the "what's it about?" selector on the enquiry form. Every
        // service is offered, including the enquiry-only ones — asking about
        // grooming is exactly what that form is for.
        inquiry_service_options: list
          .map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
          .join('\n'),
        social_html: socialHtml(profile),
        credentials_html: credentialsHtml(profile),
        gallery_html: galleryHtml(photos),
        hero_visual_html: sectionPhotoHtml(photos, 'hero', { aspect: 'hero' }),
        about_image_html: sectionPhotoHtml(photos, 'about', { aspect: 'about' }),
        reviews_html: reviewsHtml(reviews),
        footer_bottom_extra: '<a href="/legal">Policies</a> &middot; <a href="/legal/accessibility">Accessibility</a>'
      }
    });

    res.type('html').set('Cache-Control', 'public, max-age=0, must-revalidate').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/services/:slug', async (req, res, next) => {
  try {
    const common = await commonData(req);
    const list = await services.listPublicServices();
    const service = list.find(s => s.slug === req.params.slug);
    if (!service) return next();

    const siblings = list.filter(s => s.slug !== service.slug);
    const explainer = {
      night: 'Charged per night, per dog. A three-night stay for two dogs is three nights x two dogs at the rate above.',
      day: 'Charged per day, per dog. A same-day drop-off and collection counts as one day.',
      session: 'A flat rate per session, per dog, regardless of how long the booking spans.'
    }[service.billing_unit];

    let statusHtml = '';
    let ctaHtml = `<p class="service-detail-cta"><a class="btn btn-primary" href="/my-bookings?service=${service.id}">Request this service</a></p>`;
    if (service.booking_mode === 'inquiry') {
      statusHtml = `<p class="service-status service-status-inquiry">This service isn't bookable online yet. The rate shown is indicative and will be confirmed before you're charged.</p>`;
      ctaHtml = `<p class="service-detail-cta"><a class="btn btn-primary" href="/#contact">Ask about ${escapeHtml(service.name)}</a></p>`;
    } else if (service.booking_mode === 'unavailable') {
      statusHtml = `<p class="service-status service-status-unavailable">This service is temporarily unavailable.</p>`;
      ctaHtml = `<p class="service-detail-cta"><a class="btn btn-primary" href="/#contact">Contact us about availability</a></p>`;
    }

    const html = renderPage({
      view: 'service',
      nonce: res.locals.cspNonce,
      baseUrl: common.baseUrl,
      meta: {
        title: `${service.name} | ${common.brand}`,
        description: `${service.description} ${priceLabelLong(service)}.`.slice(0, 300),
        canonicalPath: `/services/${service.slug}`,
        ogImage: '/images/og-card.png',
        ogImageAlt: `${common.brand} logo`,
        jsonLd: [
          serviceJsonLd(service, common.profile, common.baseUrl),
          breadcrumbJsonLd(common.baseUrl, [
            { name: 'Home', path: '/' },
            { name: 'Services', path: '/#services' },
            { name: service.name, path: `/services/${service.slug}` }
          ])
        ]
      },
      data: {
        ...common,
        service,
        pricing_explainer: explainer,
        status_html: statusHtml,
        cta_html: ctaHtml,
        perks_html: service.perks.map(p => `<li>${escapeHtml(p)}</li>`).join('\n'),
        siblings_html: siblings
          .map(s => `<li><a href="/services/${s.slug}">${escapeHtml(s.name)}</a> &mdash; ${escapeHtml(s.price_label)}</li>`)
          .join('\n')
      }
    });

    res.type('html').set('Cache-Control', 'public, max-age=0, must-revalidate').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/legal', async (req, res, next) => {
  try {
    const common = await commonData(req);
    const index = listPolicies().map(p => `
      <li>
        <a href="/legal/${p.slug}"><strong>${escapeHtml(p.title)}</strong></a>
        <span class="doc-index-summary">${escapeHtml(p.summary)}</span>
        <span class="doc-index-meta">Version ${escapeHtml(p.version)} &middot; effective ${escapeHtml(p.effective)}${p.draft ? ' &middot; draft, pending legal review' : ''}</span>
      </li>`).join('\n');

    const html = renderPage({
      view: 'legal-index',
      nonce: res.locals.cspNonce,
      baseUrl: common.baseUrl,
      meta: {
        title: `Policies and agreements | ${common.brand}`,
        description: `Privacy policy, terms of service, boarding agreement, cancellation and refund policy and other documents for ${common.brand}.`,
        canonicalPath: '/legal',
        jsonLd: breadcrumbJsonLd(common.baseUrl, [
          { name: 'Home', path: '/' },
          { name: 'Policies', path: '/legal' }
        ])
      },
      data: { ...common, index_html: index }
    });
    res.type('html').set('Cache-Control', 'public, max-age=0, must-revalidate').send(html);
  } catch (err) {
    next(err);
  }
});

router.get('/legal/:slug', async (req, res, next) => {
  try {
    const policy = getPolicy(req.params.slug);
    if (!policy) return next();
    const common = await commonData(req);

    const sections = policy.sections.map(([heading, body], i) => `
      <section aria-labelledby="sec-${i}">
        <h2 id="sec-${i}">${escapeHtml(heading)}</h2>
        <p>${escapeHtml(body)}</p>
      </section>`).join('\n');

    // The draft banner is deliberately prominent and machine-detectable: the
    // test suite asserts it is present for every policy still marked draft, so
    // unreviewed language cannot quietly start looking authoritative.
    const draftBanner = policy.draft ? `
      <div class="doc-draft-notice" role="note" data-draft="true">
        <h2>Draft &mdash; pending review by qualified counsel</h2>
        <p>
          This document is a structurally complete draft written by the
          development team so the acceptance and versioning machinery could be
          built and tested. It has <strong>not</strong> been reviewed by a
          lawyer and must not be relied on as legal advice. Passages marked
          [OWNER: &hellip;] or [COUNSEL: &hellip;] require a decision before
          publication.
        </p>
      </div>` : '';

    const html = renderPage({
      view: 'legal',
      nonce: res.locals.cspNonce,
      baseUrl: common.baseUrl,
      meta: {
        title: `${policy.title} | ${common.brand}`,
        description: policy.summary,
        canonicalPath: `/legal/${policy.slug}`,
        jsonLd: breadcrumbJsonLd(common.baseUrl, [
          { name: 'Home', path: '/' },
          { name: 'Policies', path: '/legal' },
          { name: policy.title, path: `/legal/${policy.slug}` }
        ])
      },
      data: {
        ...common,
        policy,
        sections_html: sections,
        draft_banner_html: draftBanner,
        siblings_html: policyLinks(policy.slug)
      }
    });
    res.type('html').set('Cache-Control', 'public, max-age=0, must-revalidate').send(html);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Crawler surfaces
// ---------------------------------------------------------------------------

router.get('/robots.txt', (req, res) => {
  const baseUrl = baseUrlFor(req);
  // Account, admin and API paths carry no indexable content and would leak
  // parameterised URLs into the index.
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /my-bookings',
    'Disallow: /api/',
    'Disallow: /uploads/',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    ''
  ].join('\n');
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(body);
});

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const baseUrl = baseUrlFor(req);
    const list = await services.listPublicServices();
    const urls = [
      { loc: '/', priority: '1.0', changefreq: 'weekly' },
      { loc: '/legal', priority: '0.4', changefreq: 'yearly' },
      ...list.map(s => ({ loc: `/services/${s.slug}`, priority: '0.8', changefreq: 'monthly' })),
      ...listPolicies().map(p => ({
        loc: `/legal/${p.slug}`, priority: '0.3', changefreq: 'yearly', lastmod: p.effective
      }))
    ];
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${baseUrl}${u.loc}</loc>${u.lastmod ? `
    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(body);
  } catch (err) {
    next(err);
  }
});

router.get('/site.webmanifest', async (req, res, next) => {
  try {
    const profile = await getBusinessProfile();
    const name = profile.values.business_name || 'Benny and the Pets';
    res.type('application/manifest+json').set('Cache-Control', 'public, max-age=86400').json({
      name,
      short_name: name.split(' ')[0],
      start_url: '/',
      display: 'standalone',
      background_color: '#fff8f0',
      theme_color: '#ff8c42',
      icons: [
        { src: '/images/logo/logo-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/images/logo/logo-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
