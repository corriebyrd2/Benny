const { test, expect } = require('@playwright/test');
const {
  resetAll,
  loginAdmin,
  createPublicBooking,
  simulateStripeWebhook
} = require('./utils');

test.describe('dashboard + services + photos (admin)', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('dashboard stats reflect current state', async ({ request }) => {
    const b1 = await createPublicBooking(request, { email: 'stat1@test.local' });
    const b2 = await createPublicBooking(request, { email: 'stat2@test.local' });
    await createPublicBooking(request, { email: 'stat3@test.local' });

    const token = await loginAdmin(request);

    await request.post(`/api/bookings/${b1.id}/approve`, {
      headers: { authorization: `Bearer ${token}` }
    });
    await simulateStripeWebhook(request, {
      type: 'checkout.session.completed',
      booking_id: b2.id,
      payment_id: 'pi_stats'
    });

    const res = await request.get('/api/dashboard/stats', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(200);
    const stats = await res.json();

    expect(stats.totalBookings).toBe(3);
    expect(stats.pendingBookings).toBe(1);
    expect(stats.confirmedBookings).toBe(2); // b1 approved, b2 confirmed via webhook
    expect(stats.paidBookings).toBe(1);
    expect(stats.activeServices).toBeGreaterThanOrEqual(4);
    expect(stats.recentBookings).toHaveLength(3);
    expect(stats.totalRevenue).toBe(b2.amount_cents);
  });

  test('services: admin CRUD', async ({ request }) => {
    const token = await loginAdmin(request);

    const list1 = await request.get('/api/services');
    const initial = (await list1.json()).length;

    const create = await request.post('/api/services', {
      headers: { authorization: `Bearer ${token}` },
      data: {
        name: 'Test Service',
        description: 'Only in tests',
        price_cents: 9999,
        price_label: '$99.99',
        perks: ['perk one', 'perk two'],
        is_featured: true,
        display_order: 99
      }
    });
    expect(create.status()).toBe(201);
    const { id } = await create.json();

    const list2 = await request.get('/api/services');
    const newList = await list2.json();
    expect(newList.length).toBe(initial + 1);
    const created = newList.find(s => s.id === id);
    expect(created.is_featured).toBe(true);
    expect(created.perks).toEqual(['perk one', 'perk two']);

    const update = await request.put(`/api/services/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { price_label: '$88/session', active: false }
    });
    expect(update.status()).toBe(200);

    const publicList = await request.get('/api/services');
    // Inactive services shouldn't appear on public list
    expect((await publicList.json()).find(s => s.id === id)).toBeFalsy();

    const del = await request.delete(`/api/services/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.status()).toBe(200);
  });

  test('photos: admin upload rejects non-images', async ({ request }) => {
    const token = await loginAdmin(request);
    const res = await request.post('/api/photos', {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        photo: {
          name: 'not-an-image.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('this is not an image')
        }
      }
    });
    // multer throws; central error handler returns 500 with the error message.
    expect([400, 500]).toContain(res.status());
  });

  test('photos: admin upload accepts PNG and lists it', async ({ request }) => {
    const token = await loginAdmin(request);
    // 1x1 transparent PNG
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082',
      'hex'
    );
    const up = await request.post('/api/photos', {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        photo: { name: 'pixel.png', mimeType: 'image/png', buffer: png },
        caption: 'unit test',
        layout: 'normal'
      }
    });
    expect(up.status()).toBe(201);
    const body = await up.json();

    const list = await request.get('/api/photos');
    expect(list.status()).toBe(200);
    const items = await list.json();
    expect(items.find(p => p.id === body.id)).toBeTruthy();
  });
});
