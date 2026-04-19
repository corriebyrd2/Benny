const { test, expect } = require('@playwright/test');
const { resetAll, registerCustomer } = require('./utils');

test.describe('dogs (customer profiles)', () => {
  test.beforeEach(async ({ request }) => {
    await resetAll(request);
  });

  test('customer lists dog seeded from registration', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'SeedDog' });
    const res = await request.get('/api/dogs', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(200);
    const dogs = await res.json();
    expect(dogs).toHaveLength(1);
    expect(dogs[0].name).toBe('SeedDog');
  });

  test('customer can add, update, and delete dogs', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'First' });

    const add = await request.post('/api/dogs', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: 'Second', breed: 'Lab', weight: '60lb', age: '3', notes: 'fetch' }
    });
    expect(add.status()).toBe(201);
    const { id } = await add.json();

    const list1 = await request.get('/api/dogs', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect((await list1.json()).length).toBe(2);

    const update = await request.put(`/api/dogs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      data: { weight: '62lb', notes: 'loves tennis balls' }
    });
    expect(update.status()).toBe(200);

    const afterUpdate = await request.get('/api/dogs', {
      headers: { authorization: `Bearer ${token}` }
    });
    const list2 = await afterUpdate.json();
    const updated = list2.find(d => d.id === id);
    expect(updated.weight).toBe('62lb');
    expect(updated.notes).toBe('loves tennis balls');
    // Breed should be preserved via COALESCE
    expect(updated.breed).toBe('Lab');

    const del = await request.delete(`/api/dogs/${id}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.status()).toBe(200);

    const list3 = await request.get('/api/dogs', {
      headers: { authorization: `Bearer ${token}` }
    });
    expect((await list3.json()).length).toBe(1);
  });

  test('customer cannot touch another customer\'s dogs', async ({ request }) => {
    const a = await registerCustomer(request, { email: 'owner-a@test.local', dog_name: 'A' });
    const b = await registerCustomer(request, { email: 'owner-b@test.local', dog_name: 'B' });

    const aDogs = await request.get('/api/dogs', {
      headers: { authorization: `Bearer ${a.token}` }
    });
    const aDogId = (await aDogs.json())[0].id;

    const update = await request.put(`/api/dogs/${aDogId}`, {
      headers: { authorization: `Bearer ${b.token}` },
      data: { name: 'Hacked' }
    });
    expect(update.status()).toBe(404);

    const del = await request.delete(`/api/dogs/${aDogId}`, {
      headers: { authorization: `Bearer ${b.token}` }
    });
    expect(del.status()).toBe(404);
  });

  test('rejects empty dog name', async ({ request }) => {
    const { token } = await registerCustomer(request);
    const res = await request.post('/api/dogs', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: '   ' }
    });
    expect(res.status()).toBe(400);
  });
});
