/* ============================================
   Benny and the Pets — homepage behaviour
   ============================================

   The homepage is rendered on the server (see server/routes/pages.js), so this
   file adds behaviour to markup that already exists rather than constructing
   content. Nothing here invents copy, and nothing here is required for the page
   to be readable, navigable or bookable — if this script fails to load, every
   link and form still works.

   Accessibility rules this file must keep:
     * Anything clickable is a real <button> or <a>. No click handlers on divs.
     * Any state change a sighted user notices is announced to assistive tech
       through a live region.
     * Motion respects prefers-reduced-motion.
*/

(function () {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  // ---------------------------------------------------------------------
  // Decorative paw prints. Purely ornamental, so they are skipped entirely
  // when the visitor has asked for reduced motion — and the interval is
  // cleared when the tab is hidden so a background tab isn't burning frames.
  // ---------------------------------------------------------------------
  function initPawPrints() {
    const container = document.getElementById('pawPrints');
    if (!container || prefersReducedMotion.matches) return;

    let timer = null;
    function spawn() {
      const paw = document.createElement('span');
      paw.className = 'paw-print';
      paw.textContent = '\u{1F43E}';
      paw.style.left = Math.random() * 100 + '%';
      paw.style.fontSize = (16 + Math.random() * 20) + 'px';
      paw.style.animationDuration = (6 + Math.random() * 6) + 's';
      container.appendChild(paw);
      setTimeout(() => paw.remove(), 14000);
    }
    function start() { if (!timer) timer = setInterval(spawn, 3000); }
    function stop() { clearInterval(timer); timer = null; }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop(); else start();
    });
    prefersReducedMotion.addEventListener('change', e => (e.matches ? stop() : start()));
    start();
  }

  // ---------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------
  function initNav() {
    const navbar = document.getElementById('navbar');
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');
    if (!navbar || !toggle || !links) return;

    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        navbar.classList.toggle('scrolled', window.scrollY > 50);
        ticking = false;
      });
    }, { passive: true });

    function setOpen(open) {
      links.classList.toggle('active', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.classList.toggle('is-open', open);
    }

    toggle.addEventListener('click', () => {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    links.addEventListener('click', e => {
      if (e.target.closest('a')) setOpen(false);
    });

    // Escape closes the menu and returns focus to the control that opened it,
    // which is what a keyboard user expects from a disclosure.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Scroll reveal. Elements start visible in CSS and are only hidden once
  // this script confirms it can reveal them again — a failed script must
  // never leave content invisible.
  // ---------------------------------------------------------------------
  function initReveal() {
    if (prefersReducedMotion.matches || !('IntersectionObserver' in window)) return;
    const els = document.querySelectorAll('.service-card, .info-card, .gallery-item, .section-header, .steps li');
    if (!els.length) return;

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    els.forEach(el => { el.classList.add('reveal'); observer.observe(el); });
  }

  // ---------------------------------------------------------------------
  // Card tilt. Pointer-only flourish; disabled for reduced motion and for
  // coarse pointers where it just fights with scrolling.
  // ---------------------------------------------------------------------
  function initTilt() {
    if (prefersReducedMotion.matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    document.querySelectorAll('[data-tilt]').forEach(card => {
      card.addEventListener('mousemove', e => {
        const rect = card.getBoundingClientRect();
        const rotateX = (e.clientY - rect.top - rect.height / 2) / 20;
        const rotateY = (rect.width / 2 - (e.clientX - rect.left)) / 20;
        card.style.transform =
          `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-8px)`;
      });
      card.addEventListener('mouseleave', () => { card.style.transform = ''; });
    });
  }

  // ---------------------------------------------------------------------
  // Reviews carousel.
  //
  // Rebuilt for keyboard and screen-reader use: the dots are a real tablist,
  // arrow keys move between them, slide changes are announced through a live
  // region, and autoplay stops on any interaction (and never starts at all
  // under prefers-reduced-motion, which is a WCAG 2.2 pause requirement).
  // ---------------------------------------------------------------------
  function initCarousel() {
    const track = document.getElementById('testimonialTrack');
    const prevBtn = document.getElementById('carouselPrev');
    const nextBtn = document.getElementById('carouselNext');
    const dots = document.getElementById('carouselDots');
    const status = document.getElementById('carouselStatus');
    if (!track || !prevBtn || !nextBtn || !dots) return;

    const slides = Array.from(track.querySelectorAll('.testimonial-card'));
    if (slides.length === 0) return;

    let current = 0;
    let autoplay = null;

    if (slides.length < 2) {
      prevBtn.hidden = true;
      nextBtn.hidden = true;
      dots.hidden = true;
      return;
    }

    slides.forEach((slide, i) => {
      slide.id = slide.id || `testimonial-slide-${i}`;
    });

    const buttons = slides.map((slide, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'carousel-dot';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-controls', slide.id);
      dot.innerHTML = `<span class="visually-hidden">Review ${i + 1} of ${slides.length}</span>`;
      dot.addEventListener('click', () => { goTo(i); stopAutoplay(); });
      dots.appendChild(dot);
      return dot;
    });

    dots.addEventListener('keydown', e => {
      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = (current + delta + slides.length) % slides.length;
      goTo(next);
      buttons[next].focus();
      stopAutoplay();
    });

    function goTo(index) {
      current = index;
      track.style.transform = `translateX(-${index * 100}%)`;
      buttons.forEach((b, i) => {
        b.classList.toggle('active', i === index);
        b.setAttribute('aria-selected', i === index ? 'true' : 'false');
        b.tabIndex = i === index ? 0 : -1;
      });
      // Slides scrolled out of view must also be out of the tab order, or
      // keyboard focus lands on content nobody can see.
      slides.forEach((s, i) => {
        s.setAttribute('aria-hidden', i === index ? 'false' : 'true');
        s.querySelectorAll('a, button').forEach(el => { el.tabIndex = i === index ? 0 : -1; });
      });
      if (status) status.textContent = `Review ${index + 1} of ${slides.length}`;
    }

    function step(delta) {
      goTo((current + delta + slides.length) % slides.length);
    }

    nextBtn.addEventListener('click', () => { step(1); stopAutoplay(); });
    prevBtn.addEventListener('click', () => { step(-1); stopAutoplay(); });

    function stopAutoplay() { clearInterval(autoplay); autoplay = null; }
    function startAutoplay() {
      if (prefersReducedMotion.matches) return;
      stopAutoplay();
      autoplay = setInterval(() => step(1), 7000);
    }

    // Any hover or keyboard focus inside the carousel pauses it, so nobody is
    // reading a review when it slides away.
    const region = document.getElementById('testimonialsCarousel');
    if (region) {
      region.addEventListener('mouseenter', stopAutoplay);
      region.addEventListener('focusin', stopAutoplay);
      region.addEventListener('mouseleave', startAutoplay);
    }

    let touchStartX = 0;
    track.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
    track.addEventListener('touchend', e => {
      const diff = touchStartX - e.changedTouches[0].screenX;
      if (Math.abs(diff) > 50) { step(diff > 0 ? 1 : -1); stopAutoplay(); }
    }, { passive: true });

    goTo(0);
    startAutoplay();
  }

  // ---------------------------------------------------------------------
  // Boop game. Now a real <button>, so it is reachable by keyboard and
  // announced as a control rather than being an unlabelled div.
  // ---------------------------------------------------------------------
  function initBoop() {
    const button = document.getElementById('boopDog');
    const count = document.getElementById('boopCount');
    const reaction = document.getElementById('boopReaction');
    const milestones = document.getElementById('boopMilestones');
    if (!button || !count) return;

    const reactions = ['❤️', '\u{1F496}', '\u{1F495}', '\u{1F49B}', '\u{1F499}',
      '\u{1F31F}', '✨', '\u{1F60D}', '\u{1F970}', '\u{1F929}'];
    const messages = {
      5: 'Good start!',
      10: 'You are a natural.',
      25: 'Boop master in training.',
      50: 'The dog is delighted.',
      100: 'Ultimate boop champion.',
      200: 'Your booping finger must be tired.',
      500: 'Legendary booper status achieved.'
    };

    let boops = 0;
    button.addEventListener('click', () => {
      boops += 1;
      count.textContent = String(boops);

      if (!prefersReducedMotion.matches) {
        button.classList.remove('booped');
        void button.offsetWidth;
        button.classList.add('booped');
        if (reaction) {
          reaction.textContent = reactions[Math.floor(Math.random() * reactions.length)];
          reaction.classList.remove('show');
          void reaction.offsetWidth;
          reaction.classList.add('show');
        }
      }

      if (milestones && messages[boops]) milestones.textContent = messages[boops];
    });
  }

  // ---------------------------------------------------------------------
  // Forms
  // ---------------------------------------------------------------------

  // Shared submit wrapper: disables the control for the duration of the
  // request (duplicate-submit protection), reports the outcome into a live
  // region, and always re-enables — including on a network failure, which the
  // previous implementation left the button stuck through.
  async function submitForm({ form, button, message, run, busyLabel }) {
    if (button.disabled) return;
    const originalLabel = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) button.textContent = busyLabel;
    message.className = 'form-msg';
    message.textContent = '';

    try {
      const text = await run();
      message.classList.add('success');
      message.textContent = text;
      form.reset();
      return true;
    } catch (err) {
      message.classList.add('error');
      message.textContent = err && err.message
        ? err.message
        : 'Something went wrong. Please check your connection and try again.';
      return false;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = originalLabel;
    }
  }

  async function postJson(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error('We could not reach the server. Please check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status}). Please try again.`);
    }
    return data;
  }

  function initReviewForm() {
    const form = document.getElementById('reviewForm');
    if (!form) return;
    const message = document.getElementById('reviewFormMsg');
    const button = form.querySelector('button[type="submit"]');
    const stars = Array.from(form.querySelectorAll('.review-star'));
    let rating = 5;

    function paint() {
      stars.forEach(star => {
        const value = parseInt(star.dataset.rating, 10);
        star.classList.toggle('active', value <= rating);
        star.setAttribute('aria-checked', value === rating ? 'true' : 'false');
        star.tabIndex = value === rating ? 0 : -1;
      });
    }

    stars.forEach(star => {
      star.addEventListener('click', () => {
        rating = parseInt(star.dataset.rating, 10);
        paint();
      });
      // A radiogroup must be operable with arrow keys, not just clicks.
      star.addEventListener('keydown', e => {
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        rating = Math.min(5, Math.max(1, rating + delta));
        paint();
        stars[rating - 1].focus();
      });
    });
    paint();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = form.querySelector('#reviewName');
      const text = form.querySelector('#reviewText');
      if (!name.value.trim()) { name.focus(); message.className = 'form-msg error'; message.textContent = 'Please add your name.'; return; }
      if (!text.value.trim()) { text.focus(); message.className = 'form-msg error'; message.textContent = 'Please write your review.'; return; }

      await submitForm({
        form, button, message, busyLabel: 'Submitting…',
        run: async () => {
          await postJson('/api/reviews', {
            reviewer_name: name.value.trim(),
            pet_name: form.querySelector('#reviewPetName').value.trim(),
            rating,
            review_text: text.value.trim()
          });
          return 'Thank you. Your review will appear here once it has been approved.';
        }
      });
      rating = 5;
      paint();
    });
  }

  function initNewsletterForm() {
    const form = document.getElementById('newsletterForm');
    if (!form) return;
    const message = document.getElementById('newsletterMsg');
    const button = form.querySelector('button[type="submit"]');
    const email = form.querySelector('#newsletterEmail');
    const consent = form.querySelector('#newsletterConsent');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!email.value.trim()) {
        email.focus();
        message.className = 'form-msg error';
        message.textContent = 'Please enter your email address.';
        return;
      }
      // Marketing consent is a separate, unticked box. Refusing to submit
      // without it is the point: silent opt-in is not consent.
      if (!consent.checked) {
        consent.focus();
        message.className = 'form-msg error';
        message.textContent = 'Please tick the box to confirm you want marketing email.';
        return;
      }

      await submitForm({
        form, button, message, busyLabel: 'Subscribing…',
        run: async () => {
          await postJson('/api/subscribe', {
            email: email.value.trim(),
            source: 'homepage',
            marketing_consent: true
          });
          return 'Subscribed. You can unsubscribe from any email we send.';
        }
      });
    });
  }

  function initInquiryForm() {
    const form = document.getElementById('inquiryForm');
    if (!form) return;
    const message = document.getElementById('inquiryMsg');
    const button = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = form.querySelector('#inquiryName');
      const email = form.querySelector('#inquiryEmail');
      const body = form.querySelector('#inquiryMessage');

      // Validate in the order the fields appear and move focus to the first
      // problem, so a keyboard user is taken to what needs fixing.
      for (const [field, problem] of [
        [name, !name.value.trim() && 'Please tell us your name.'],
        [email, !email.value.trim() && 'Please give us an email address so we can reply.'],
        [body, body.value.trim().length < 10 && 'Please tell us a little more about what you need.']
      ]) {
        if (!problem) continue;
        field.focus();
        message.className = 'form-msg error';
        message.textContent = problem;
        return;
      }

      await submitForm({
        form, button, message, busyLabel: 'Sending…',
        run: async () => {
          const serviceId = form.querySelector('#inquiryService').value;
          const data = await postJson('/api/inquiries', {
            name: name.value.trim(),
            email: email.value.trim(),
            phone: form.querySelector('#inquiryPhone').value.trim(),
            message: body.value.trim(),
            service_id: serviceId ? Number(serviceId) : undefined,
            website: form.querySelector('#inquiryWebsite').value
          });
          return data.message || 'Thanks — we have your message and will reply by email.';
        }
      });
    });
  }

  onReady(() => {
    initPawPrints();
    initNav();
    initReveal();
    initTilt();
    initCarousel();
    initBoop();
    initReviewForm();
    initNewsletterForm();
    initInquiryForm();
  });
})();
