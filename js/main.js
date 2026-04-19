/* ============================================
   Benny and the Pets - Main JavaScript
   Fun & Interactive Features
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {

  // --- Dynamic Content Functions (called after observer is created) ---
  async function loadDynamicServices() {
    try {
      const res = await fetch('/api/services');
      if (!res.ok) return; // Fall back to static content
      const services = await res.json();
      if (services.length === 0) return;

      const grid = document.querySelector('.services-grid');
      if (!grid) return;

      // Also update the booking form select options
      const serviceSelect = document.getElementById('service');

      grid.innerHTML = services.map(s => {
        const perks = Array.isArray(s.perks) ? s.perks : [];
        return `
          <div class="service-card ${s.is_featured ? 'featured' : ''}" data-tilt>
            ${s.is_featured ? '<div class="featured-badge">Most Popular</div>' : ''}
            <div class="service-icon">${s.icon}</div>
            <h3>${s.name}</h3>
            <p>${s.description}</p>
            <ul class="service-perks">
              ${perks.map(p => `<li>${p}</li>`).join('')}
            </ul>
            <span class="service-price">${s.price_label}</span>
          </div>
        `;
      }).join('');

      if (serviceSelect) {
        serviceSelect.innerHTML = '<option value="">Choose a service...</option>' +
          services.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
      }

      // Re-init tilt effect on new cards
      grid.querySelectorAll('[data-tilt]').forEach(card => {
        card.addEventListener('mousemove', (e) => {
          const rect = card.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const centerX = rect.width / 2;
          const centerY = rect.height / 2;
          const rotateX = (y - centerY) / 20;
          const rotateY = (centerX - x) / 20;
          card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-8px)`;
        });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; });
      });

      // Re-add reveal classes
      grid.querySelectorAll('.service-card').forEach(el => {
        el.classList.add('reveal');
        observer.observe(el);
      });
    } catch (e) {
      // API not available, keep static content
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function setContactField(id, value) {
    const el = document.getElementById(id);
    if (!el || !value) return;
    el.innerHTML = value.split(/\r?\n/).map(escapeHtml).join('<br>');
  }

  async function loadDynamicSettings() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const s = await res.json();

      setContactField('contactAddress', s.contact_address);
      setContactField('contactPhone', s.contact_phone);
      setContactField('contactEmail', s.contact_email);
      setContactField('contactHours', s.contact_hours);

      const socialMap = {
        facebook: s.social_facebook_url,
        instagram: s.social_instagram_url,
        tiktok: s.social_tiktok_url
      };
      document.querySelectorAll('[data-social]').forEach(link => {
        const url = socialMap[link.getAttribute('data-social')];
        if (url && url.trim()) {
          link.href = url.trim();
          link.style.display = '';
        } else {
          link.style.display = 'none';
        }
      });
    } catch (e) {
      // API not available, keep static content
    }
  }

  async function loadDynamicGallery() {
    try {
      const res = await fetch('/api/photos');
      if (!res.ok) return;
      const photos = await res.json();
      if (photos.length === 0) return;

      // Backward-compat: treat photos missing a section as 'gallery'.
      const bySection = (name) => photos.filter(p => (p.section || 'gallery') === name);

      renderGallery(bySection('gallery'));
      renderSingleSectionPhoto('heroVisual', bySection('hero')[0]);
      renderSingleSectionPhoto('aboutImage', bySection('about')[0]);
    } catch (e) {
      // API not available, keep static content
    }
  }

  function renderGallery(photos) {
    const grid = document.querySelector('.gallery-grid');
    if (!grid || photos.length === 0) return;

    grid.innerHTML = photos.map(p => {
      const layoutClass = p.layout === 'large' ? ' large' : (p.layout === 'tall' ? ' tall' : '');
      return `
        <div class="gallery-item${layoutClass}">
          <img src="/uploads/${encodeURIComponent(p.filename)}" alt="${p.caption || ''}"
            style="width:100%;height:100%;object-fit:cover;"
            onerror="this.parentElement.innerHTML='<div class=\\'gallery-placeholder\\' style=\\'--hue:30;\\'><span>&#128054;</span><p>${p.caption || ''}</p></div>';">
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.gallery-item').forEach(el => {
      el.classList.add('reveal');
      observer.observe(el);
    });
  }

  function renderSingleSectionPhoto(containerId, photo) {
    if (!photo) return;
    const container = document.getElementById(containerId);
    if (!container) return;

    // Hero keeps its container free-sized; about-image uses the same 4/5 aspect
    // ratio the placeholder already enforces so the surrounding grid stays stable.
    const styles = containerId === 'aboutImage'
      ? 'width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:16px;display:block;box-shadow:0 10px 30px rgba(0,0,0,0.12);'
      : 'max-width:100%;max-height:500px;object-fit:contain;display:block;border-radius:16px;';

    container.innerHTML = `
      <img src="/uploads/${encodeURIComponent(photo.filename)}" alt="${photo.caption || ''}" style="${styles}">
    `;
  }

  // --- Floating Paw Prints ---
  const pawContainer = document.getElementById('pawPrints');
  const pawEmojis = ['\u{1F43E}'];

  function createPawPrint() {
    const paw = document.createElement('span');
    paw.classList.add('paw-print');
    paw.textContent = pawEmojis[0];
    paw.style.left = Math.random() * 100 + '%';
    paw.style.fontSize = (16 + Math.random() * 20) + 'px';
    paw.style.animationDuration = (6 + Math.random() * 6) + 's';
    paw.style.animationDelay = Math.random() * 2 + 's';
    pawContainer.appendChild(paw);
    setTimeout(() => paw.remove(), 14000);
  }

  setInterval(createPawPrint, 3000);

  // --- Navbar Scroll Effect ---
  const navbar = document.getElementById('navbar');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const currentScroll = window.scrollY;
    navbar.classList.toggle('scrolled', currentScroll > 50);
    lastScroll = currentScroll;
  });

  // --- Mobile Nav Toggle ---
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('active');
    const spans = navToggle.querySelectorAll('span');
    if (navLinks.classList.contains('active')) {
      spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
      spans[1].style.opacity = '0';
      spans[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
    } else {
      spans.forEach(s => { s.style.transform = ''; s.style.opacity = ''; });
    }
  });

  // Close nav on link click
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('active');
      const spans = navToggle.querySelectorAll('span');
      spans.forEach(s => { s.style.transform = ''; s.style.opacity = ''; });
    });
  });

  // --- Animated Counter ---
  const counters = document.querySelectorAll('.stat-number');
  let counterStarted = false;

  function animateCounters() {
    counters.forEach(counter => {
      const target = +counter.getAttribute('data-target');
      const duration = 2000;
      const startTime = performance.now();

      function updateCounter(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        counter.textContent = Math.floor(target * eased);

        if (progress < 1) {
          requestAnimationFrame(updateCounter);
        } else {
          counter.textContent = target;
        }
      }

      requestAnimationFrame(updateCounter);
    });
  }

  // --- Scroll Reveal ---
  const revealElements = document.querySelectorAll(
    '.service-card, .about-feature, .info-card, .gallery-item, .section-header'
  );

  revealElements.forEach(el => el.classList.add('reveal'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

  revealElements.forEach(el => observer.observe(el));

  // --- Load Dynamic Content from API ---
  loadDynamicServices();
  loadDynamicGallery();
  loadDynamicSettings();

  // Counter observer
  const statSection = document.querySelector('.hero-stats');
  if (statSection) {
    const counterObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !counterStarted) {
        counterStarted = true;
        animateCounters();
      }
    }, { threshold: 0.5 });
    counterObserver.observe(statSection);
  }

  // --- Boop the Snoot Game ---
  const boopDog = document.getElementById('boopDog');
  const boopCount = document.getElementById('boopCount');
  const boopReaction = document.getElementById('boopReaction');
  const boopMilestones = document.getElementById('boopMilestones');
  let boops = 0;

  const reactions = [
    '\u2764\uFE0F', '\u{1F496}', '\u{1F495}', '\u{1F49B}', '\u{1F499}',
    '\u{1F31F}', '\u2728', '\u{1F60D}', '\u{1F970}', '\u{1F929}'
  ];

  const milestoneMessages = {
    5: 'Good start! The pup likes you!',
    10: 'Wow, you\'re a natural booper!',
    25: 'BOOP MASTER in training!',
    50: 'The pup is in HEAVEN!',
    100: 'You are the ULTIMATE BOOP CHAMPION! \u{1F3C6}',
    200: 'Your booping finger must be tired! \u{1F4AA}',
    500: 'LEGENDARY BOOPER STATUS ACHIEVED! \u{1F451}'
  };

  boopDog.addEventListener('click', () => {
    boops++;
    boopCount.textContent = boops;

    // Bounce animation
    boopDog.classList.remove('booped');
    void boopDog.offsetWidth; // trigger reflow
    boopDog.classList.add('booped');

    // Floating reaction
    boopReaction.textContent = reactions[Math.floor(Math.random() * reactions.length)];
    boopReaction.classList.remove('show');
    void boopReaction.offsetWidth;
    boopReaction.classList.add('show');

    // Milestones
    if (milestoneMessages[boops]) {
      boopMilestones.textContent = milestoneMessages[boops];
      boopMilestones.style.animation = 'none';
      void boopMilestones.offsetWidth;
      boopMilestones.style.animation = 'fadeInOut 3s ease';
    }

    // Scale count animation
    boopCount.style.transform = 'scale(1.3)';
    setTimeout(() => { boopCount.style.transform = 'scale(1)'; }, 150);
  });

  // --- Testimonials Carousel ---
  const track = document.getElementById('testimonialTrack');
  const cards = track.querySelectorAll('.testimonial-card');
  const prevBtn = document.getElementById('carouselPrev');
  const nextBtn = document.getElementById('carouselNext');
  const dotsContainer = document.getElementById('carouselDots');
  let currentSlide = 0;
  const totalSlides = cards.length;
  let autoPlayInterval;

  // Create dots
  cards.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.classList.add('carousel-dot');
    dot.setAttribute('aria-label', `Go to testimonial ${i + 1}`);
    if (i === 0) dot.classList.add('active');
    dot.addEventListener('click', () => goToSlide(i));
    dotsContainer.appendChild(dot);
  });

  function goToSlide(index) {
    currentSlide = index;
    track.style.transform = `translateX(-${currentSlide * 100}%)`;
    document.querySelectorAll('.carousel-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === currentSlide);
    });
  }

  function nextSlide() {
    goToSlide((currentSlide + 1) % totalSlides);
  }

  function prevSlide() {
    goToSlide((currentSlide - 1 + totalSlides) % totalSlides);
  }

  nextBtn.addEventListener('click', () => { nextSlide(); resetAutoPlay(); });
  prevBtn.addEventListener('click', () => { prevSlide(); resetAutoPlay(); });

  // Auto-play
  function startAutoPlay() {
    autoPlayInterval = setInterval(nextSlide, 5000);
  }

  function resetAutoPlay() {
    clearInterval(autoPlayInterval);
    startAutoPlay();
  }

  startAutoPlay();

  // Swipe support for mobile
  let touchStartX = 0;
  let touchEndX = 0;

  track.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  track.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 50) {
      if (diff > 0) nextSlide();
      else prevSlide();
      resetAutoPlay();
    }
  }, { passive: true });


  // --- Newsletter Form ---
  const newsletterForm = document.getElementById('newsletterForm');

  newsletterForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = newsletterForm.querySelector('input[type="email"]');
    const btn = newsletterForm.querySelector('button');
    const originalText = btn.textContent;
    const email = (input?.value || '').trim();
    if (!email) return;

    btn.disabled = true;
    btn.textContent = 'Subscribing...';

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'homepage' })
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Subscription failed');
      }

      btn.textContent = 'Subscribed! \u{1F389}';
      btn.style.background = 'var(--secondary)';
      newsletterForm.reset();
    } catch (err) {
      btn.textContent = 'Try again';
      btn.style.background = '';
      console.error('[newsletter]', err);
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
        btn.style.background = '';
      }, 3000);
    }
  });

  // --- Service Card Tilt Effect ---
  document.querySelectorAll('[data-tilt]').forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = (y - centerY) / 20;
      const rotateY = (centerX - x) / 20;
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-8px)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });

  // --- Smooth active nav highlighting ---
  const sections = document.querySelectorAll('section[id]');

  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY + 100;

    sections.forEach(section => {
      const top = section.offsetTop;
      const height = section.offsetHeight;
      const id = section.getAttribute('id');

      if (scrollY >= top && scrollY < top + height) {
        document.querySelectorAll('.nav-links a').forEach(link => {
          link.classList.remove('active');
          if (link.getAttribute('href') === `#${id}`) {
            link.classList.add('active');
          }
        });
      }
    });
  });

  // --- Easter Egg: Konami Code ---
  const konamiCode = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
                      'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
                      'b', 'a'];
  let konamiIndex = 0;

  document.addEventListener('keydown', (e) => {
    if (e.key === konamiCode[konamiIndex]) {
      konamiIndex++;
      if (konamiIndex === konamiCode.length) {
        konamiIndex = 0;
        activateEasterEgg();
      }
    } else {
      konamiIndex = 0;
    }
  });

  function activateEasterEgg() {
    document.body.style.transition = 'filter 0.5s';
    document.body.style.filter = 'hue-rotate(180deg)';

    // Rain dogs!
    for (let i = 0; i < 30; i++) {
      setTimeout(() => {
        const dog = document.createElement('div');
        dog.textContent = ['\u{1F436}', '\u{1F415}', '\u{1F43E}', '\u{1F9AE}'][Math.floor(Math.random() * 4)];
        dog.style.cssText = `
          position: fixed;
          top: -50px;
          left: ${Math.random() * 100}%;
          font-size: ${30 + Math.random() * 40}px;
          z-index: 10000;
          pointer-events: none;
          animation: dogRain ${2 + Math.random() * 3}s linear forwards;
        `;
        document.body.appendChild(dog);
        setTimeout(() => dog.remove(), 5000);
      }, i * 100);
    }

    // Add the animation
    if (!document.getElementById('easterEggStyles')) {
      const style = document.createElement('style');
      style.id = 'easterEggStyles';
      style.textContent = `
        @keyframes dogRain {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    setTimeout(() => {
      document.body.style.filter = '';
    }, 5000);
  }

});
