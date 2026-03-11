/* ============================================
   Benny and the Pets - Main JavaScript
   Fun & Interactive Features
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {

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

  // --- Contact Form ---
  const contactForm = document.getElementById('contactForm');
  const successModal = document.getElementById('successModal');
  const modalClose = document.getElementById('modalClose');

  contactForm.addEventListener('submit', (e) => {
    e.preventDefault();

    // Fun confetti-like effect on the button
    const btn = contactForm.querySelector('button[type="submit"]');
    btn.textContent = 'Sending... \u{1F43E}';
    btn.disabled = true;

    // Simulate submission delay
    setTimeout(() => {
      successModal.classList.add('active');
      btn.textContent = 'Send Booking Request \u{1F43E}';
      btn.disabled = false;
      contactForm.reset();
    }, 1500);
  });

  modalClose.addEventListener('click', () => {
    successModal.classList.remove('active');
  });

  successModal.addEventListener('click', (e) => {
    if (e.target === successModal) {
      successModal.classList.remove('active');
    }
  });

  // --- Newsletter Form ---
  const newsletterForm = document.getElementById('newsletterForm');

  newsletterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = newsletterForm.querySelector('button');
    const originalText = btn.textContent;
    btn.textContent = 'Subscribed! \u{1F389}';
    btn.style.background = 'var(--secondary)';
    newsletterForm.reset();
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '';
    }, 3000);
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
