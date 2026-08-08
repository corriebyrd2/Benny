// Daily capacity.
//
// The availability endpoint reported a capacity of 10 and nothing enforced it:
// booking creation never consulted it, so a full day could be booked
// arbitrarily many times. It also counted BOOKINGS rather than DOGS, so a
// booking for four dogs registered as one place taken.

const { test, expect } = require('@playwright/test');
const { resetAll, registerCustomer, firstServiceId, safeBody } = require('./utils');

const DATE = '2026-09-01';

async function book(request, { start = DATE, end = DATE, dogs = 1, email }) {
  const serviceId = await firstServiceId(request);
  return request.post('/api/bookings', {
    data: {
      owner_name: 'Capacity Tester',
      email: email || `cap-${Math.random().toString(36).slice(2, 8)}@test.local`,
      dog_name: 'Rex',
      service_id: serviceId,
      start_date: start,
      end_date: end,
      dog_count: dogs
    }
  });
}

test.describe('availability reporting', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('counts dog places, not bookings', async ({ request }) => {
    const before = await (await request.get(`/api/bookings/availability?date=${DATE}`)).json();
    expect(before.count).toBe(0);
    expect(before.remaining).toBe(before.capacity);

    // One booking, four dogs — four places, not one.
    expect((await book(request, { dogs: 4 })).status()).toBe(201);

    const after = await (await request.get(`/api/bookings/availability?date=${DATE}`)).json();
    expect(after.count).toBe(4);
    expect(after.remaining).toBe(after.capacity - 4);
  });

  test('a cancelled booking releases its places', async ({ request }) => {
    const { loginAdmin } = require('./utils');
    const created = await book(request, { dogs: 3 });
    const bookingId = (await created.json()).id;

    const token = await loginAdmin(request);
    await request.post(`/api/bookings/${bookingId}/cancel`, {
      headers: { authorization: `Bearer ${token}` },
      data: { reason: 'test' }
    });

    const after = await (await request.get(`/api/bookings/availability?date=${DATE}`)).json();
    expect(after.count).toBe(0);
  });

  test('occupancy is counted across every night of a stay', async ({ request }) => {
    expect((await book(request, { start: '2026-09-10', end: '2026-09-13', dogs: 2 })).status()).toBe(201);

    for (const date of ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']) {
      const day = await (await request.get(`/api/bookings/availability?date=${date}`)).json();
      expect(day.count, `${date} should be occupied`).toBe(2);
    }
    const before = await (await request.get('/api/bookings/availability?date=2026-09-09')).json();
    expect(before.count).toBe(0);
    const after = await (await request.get('/api/bookings/availability?date=2026-09-14')).json();
    expect(after.count).toBe(0);
  });
});

test.describe('capacity is enforced, not merely reported', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a booking that would exceed capacity is refused', async ({ request }) => {
    const capacity = (await (await request.get(`/api/bookings/availability?date=${DATE}`)).json()).capacity;

    // Fill the day exactly.
    const fill = await book(request, { dogs: capacity });
    expect(fill.status(), await safeBody(fill)).toBe(201);

    const overflow = await book(request, { dogs: 1 });
    expect(overflow.status()).toBe(409);
    const body = await overflow.json();
    expect(body.error).toMatch(/fully booked/i);
    expect(body.conflict.date).toBe(DATE);
    expect(body.conflict.capacity).toBe(capacity);
  });

  test('a partial overflow says how much room is left', async ({ request }) => {
    const capacity = (await (await request.get(`/api/bookings/availability?date=${DATE}`)).json()).capacity;
    expect((await book(request, { dogs: capacity - 2 })).status()).toBe(201);

    const tooMany = await book(request, { dogs: 3 });
    expect(tooMany.status()).toBe(409);
    expect((await tooMany.json()).error).toMatch(/room for 2 more dogs/i);

    // Exactly the remaining places still fits.
    expect((await book(request, { dogs: 2 })).status()).toBe(201);
  });

  test('a multi-night stay is refused if ANY night is full', async ({ request }) => {
    const capacity = (await (await request.get('/api/bookings/availability?date=2026-10-02')).json()).capacity;
    // Fill only the middle night.
    expect((await book(request, { start: '2026-10-02', end: '2026-10-02', dogs: capacity })).status()).toBe(201);

    const spanning = await book(request, { start: '2026-10-01', end: '2026-10-03', dogs: 1 });
    expect(spanning.status()).toBe(409);
    expect((await spanning.json()).conflict.date).toBe('2026-10-02');

    // And nothing was written for the nights that WERE free.
    const firstNight = await (await request.get('/api/bookings/availability?date=2026-10-01')).json();
    expect(firstNight.count).toBe(0);
  });

  test('the customer portal path enforces the same limit', async ({ request }) => {
    const capacity = (await (await request.get(`/api/bookings/availability?date=${DATE}`)).json()).capacity;
    expect((await book(request, { dogs: capacity })).status()).toBe(201);

    const { token } = await registerCustomer(request, { dog_name: 'Portal' });
    const serviceId = await firstServiceId(request);
    const res = await request.post('/api/bookings/customer-book', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        dog_names: ['Portal'], service_id: serviceId,
        start_date: DATE, end_date: DATE
      }
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/fully booked/i);
  });

  test('a request with no dates is not blocked by capacity', async ({ request }) => {
    // "Preferred dates" free-text bookings carry no start_date, so there is no
    // day to charge against. They must still be accepted for the owner to
    // triage rather than rejected outright.
    const serviceId = await firstServiceId(request);
    const res = await request.post('/api/bookings', {
      data: {
        owner_name: 'Flexible', email: 'flexible@test.local', dog_name: 'Rex',
        service_id: serviceId, preferred_dates: 'sometime in October'
      }
    });
    expect(res.status(), await safeBody(res)).toBe(201);
  });

  test('simultaneous bookings cannot both take the last place', async ({ request }) => {
    const capacity = (await (await request.get(`/api/bookings/availability?date=${DATE}`)).json()).capacity;
    expect((await book(request, { dogs: capacity - 1 })).status()).toBe(201);

    // Fire both at once. Check-then-insert as two statements would let both
    // through; the advisory lock plus a single transaction must not.
    const [a, b] = await Promise.all([
      book(request, { dogs: 1, email: 'race-a@test.local' }),
      book(request, { dogs: 1, email: 'race-b@test.local' })
    ]);

    const statuses = [a.status(), b.status()].sort();
    expect(statuses).toEqual([201, 409]);

    const after = await (await request.get(`/api/bookings/availability?date=${DATE}`)).json();
    expect(after.count).toBe(capacity);
  });

  // From the Codex review of PR #75. The lock was keyed on the FIRST date of
  // the stay, so two overlapping stays that begin on different days took
  // different locks: both read the capacity for the shared night before either
  // inserted, and both took the last place. The test above could not catch it
  // because both of its bookings start on the same date.
  //
  // Race tests are timing-dependent by nature. Against the single-date lock,
  // the long-stay case below reproduces reliably — its five capacity checks
  // hold the window open — while this two-night case sometimes serialises by
  // luck. Both assert the correct outcome; the long-stay one is the one that
  // actually failed before the fix.
  test('overlapping stays that start on different days still serialise', async ({ request }) => {
    const day1 = '2026-09-10';
    const day2 = '2026-09-11';
    const day3 = '2026-09-12';

    const capacity = (await (await request.get(`/api/bookings/availability?date=${day2}`)).json()).capacity;
    // Fill day2 to one short, without touching day1 or day3.
    expect((await book(request, { start: day2, end: day2, dogs: capacity - 1 })).status()).toBe(201);

    // Sep 10-11 and Sep 11-12 share only Sep 11, and each starts on a
    // different day.
    const [a, b] = await Promise.all([
      book(request, { start: day1, end: day2, dogs: 1, email: 'overlap-a@test.local' }),
      book(request, { start: day2, end: day3, dogs: 1, email: 'overlap-b@test.local' })
    ]);

    const statuses = [a.status(), b.status()].sort();
    expect(statuses, `${await safeBody(a)} / ${await safeBody(b)}`).toEqual([201, 409]);

    const after = await (await request.get(`/api/bookings/availability?date=${day2}`)).json();
    expect(after.count).toBe(capacity);
  });

  test('a long stay locks every night it occupies', async ({ request }) => {
    const start = '2026-09-20';
    const middle = '2026-09-22';
    const capacity = (await (await request.get(`/api/bookings/availability?date=${middle}`)).json()).capacity;
    expect((await book(request, { start: middle, end: middle, dogs: capacity - 1 })).status()).toBe(201);

    // A five-night stay overlapping the full night in the middle, raced
    // against a single-night booking for that same night.
    const [long, short] = await Promise.all([
      book(request, { start, end: '2026-09-24', dogs: 1, email: 'long@test.local' }),
      book(request, { start: middle, end: middle, dogs: 1, email: 'short@test.local' })
    ]);

    expect([long.status(), short.status()].sort()).toEqual([201, 409]);
    const after = await (await request.get(`/api/bookings/availability?date=${middle}`)).json();
    expect(after.count).toBe(capacity);
  });
});
