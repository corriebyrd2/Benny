// Dog-document security: authorisation, content validation, safe delivery,
// duplicate handling, deletion and the audit trail.
//
// These are veterinary records tied to an identifiable person and animal. The
// endpoint previously accepted ANY file type, stored it under the client's own
// extension, recorded the client-declared Content-Type, and echoed that type
// back on download.

const { test, expect } = require('@playwright/test');
const { resetAll, registerCustomer, loginAdmin, safeBody, TINY_PDF, TINY_PNG } = require('./utils');

async function firstDogId(request, token) {
  const res = await request.get('/api/dogs', { headers: { authorization: `Bearer ${token}` } });
  return (await res.json())[0].id;
}

async function upload(request, token, dogId, { name, mimeType, buffer }) {
  return request.post(`/api/dogs/${dogId}/documents`, {
    headers: { authorization: `Bearer ${token}` },
    multipart: { document: { name, mimeType, buffer } }
  });
}

test.describe('content validation', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('accepts the document types the policy lists', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);

    const pdf = await upload(request, token, dogId,
      { name: 'rabies.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    expect(pdf.status(), await safeBody(pdf)).toBe(201);
    expect((await pdf.json()).document.mime_type).toBe('application/pdf');

    const png = await upload(request, token, dogId,
      { name: 'card.png', mimeType: 'image/png', buffer: TINY_PNG });
    expect(png.status(), await safeBody(png)).toBe(201);
    expect((await png.json()).document.mime_type).toBe('image/png');
  });

  test('rejects executables, HTML, SVG and plain text', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);

    const cases = [
      ['payload.exe', 'application/octet-stream', Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03])],
      ['payload.elf', 'application/octet-stream', Buffer.from([0x7F, 0x45, 0x4C, 0x46, 1, 1, 1, 0])],
      ['page.html', 'text/html', Buffer.from('<html><script>alert(1)</script></html>')],
      ['icon.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
      ['notes.txt', 'text/plain', Buffer.from('rabies: current')],
      ['archive.zip', 'application/zip', Buffer.from([0x50, 0x4B, 0x03, 0x04])]
    ];

    for (const [name, mimeType, buffer] of cases) {
      const res = await upload(request, token, dogId, { name, mimeType, buffer });
      expect(res.status(), `${name} should be rejected`).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
  });

  test('a lying Content-Type does not get a file admitted', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);

    // HTML claiming to be a PDF, with a .pdf name. Only the bytes matter.
    const res = await upload(request, token, dogId, {
      name: 'totally-a.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('<html><script>alert(document.cookie)</script></html>')
    });
    expect(res.status()).toBe(400);
  });

  test('a polyglot that is both a JPEG and HTML is rejected', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);

    const polyglot = Buffer.concat([
      Buffer.from([0xFF, 0xD8, 0xFF]),
      Buffer.from('<script>alert(1)</script>'.repeat(4))
    ]);
    const res = await upload(request, token, dogId,
      { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: polyglot });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/markup/i);
  });

  test('an oversized file is refused', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);

    // 11 MB against a 10 MB limit, with a valid PDF header so the size check is
    // what rejects it rather than the type check.
    const big = Buffer.concat([TINY_PDF, Buffer.alloc(11 * 1024 * 1024, 0x20)]);
    const res = await upload(request, token, dogId,
      { name: 'huge.pdf', mimeType: 'application/pdf', buffer: big });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('an empty file is refused', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);
    const res = await upload(request, token, dogId,
      { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) });
    expect(res.status()).toBe(400);
  });
});

test.describe('storage and delivery', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a path-traversal filename cannot escape the storage directory', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);

    const res = await upload(request, token, dogId, {
      name: '../../../../etc/passwd.pdf',
      mimeType: 'application/pdf',
      buffer: TINY_PDF
    });
    expect(res.status(), await safeBody(res)).toBe(201);
    const doc = (await res.json()).document;
    // The stored name is server-generated; the display name is sanitised.
    expect(doc.original_name).not.toContain('..');
    expect(doc.original_name).not.toContain('/');
  });

  test('downloads are served as attachments with the detected type', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);
    const created = await upload(request, token, dogId,
      { name: 'rabies.pdf', mimeType: 'text/html', buffer: TINY_PDF });
    const docId = (await created.json()).document.id;

    const res = await request.get(`/api/dogs/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.status()).toBe(200);
    const headers = res.headers();
    // The uploader claimed text/html; the bytes say PDF, and the bytes win.
    expect(headers['content-type']).toContain('application/pdf');
    expect(headers['content-type']).not.toContain('text/html');
    expect(headers['content-disposition']).toContain('attachment');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['cache-control']).toContain('no-store');
  });

  test('uploaded documents are not reachable through the public static mount', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);
    const created = await upload(request, token, dogId,
      { name: 'private.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    expect(created.status()).toBe(201);

    // Documents live outside the /uploads web root entirely.
    for (const guess of [
      '/uploads/private.pdf',
      '/uploads/dog-doc-1.pdf',
      '/dog-documents/private.pdf'
    ]) {
      expect((await request.get(guess)).status(), `${guess} must not be served`).toBe(404);
    }
  });
});

test.describe('authorisation', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('a customer cannot download, delete or upload against another customer', async ({ request }) => {
    const a = await registerCustomer(request, { email: 'doc-a@test.local', dog_name: 'ADog' });
    const b = await registerCustomer(request, { email: 'doc-b@test.local', dog_name: 'BDog' });
    const aDog = await firstDogId(request, a.token);
    const bDog = await firstDogId(request, b.token);

    const created = await upload(request, a.token, aDog,
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    const docId = (await created.json()).document.id;

    // B cannot read A's document by guessing the id.
    const read = await request.get(`/api/dogs/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${b.token}` }
    });
    expect(read.status()).toBe(404);

    // B cannot delete it.
    const del = await request.delete(`/api/dogs/documents/${docId}`, {
      headers: { authorization: `Bearer ${b.token}` }
    });
    expect(del.status()).toBe(404);

    // B cannot attach a document to A's dog.
    const cross = await upload(request, b.token, aDog,
      { name: 'b.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    expect(cross.status()).toBe(404);

    // A's document is still there and still A's.
    const still = await request.get(`/api/dogs/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${a.token}` }
    });
    expect(still.status()).toBe(200);
    expect(bDog).not.toBe(aDog);
  });

  test('unauthenticated and admin-token requests are handled correctly', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);
    const created = await upload(request, token, dogId,
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    const docId = (await created.json()).document.id;

    // No token at all.
    expect((await request.get(`/api/dogs/documents/${docId}/download`)).status()).toBe(401);
    expect((await request.get(`/api/dogs/admin/documents/${docId}/download`)).status()).toBe(401);

    // A customer token must not reach the admin download route.
    const asCustomer = await request.get(`/api/dogs/admin/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(asCustomer.status()).toBe(403);

    // An admin token may.
    const adminToken = await loginAdmin(request);
    const asAdmin = await request.get(`/api/dogs/admin/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    expect(asAdmin.status()).toBe(200);
  });

  test('a deleted document 404s rather than serving stale bytes', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);
    const created = await upload(request, token, dogId,
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    const docId = (await created.json()).document.id;

    expect((await request.delete(`/api/dogs/documents/${docId}`, {
      headers: { authorization: `Bearer ${token}` }
    })).status()).toBe(200);

    expect((await request.get(`/api/dogs/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${token}` }
    })).status()).toBe(404);

    const adminToken = await loginAdmin(request);
    expect((await request.get(`/api/dogs/admin/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })).status()).toBe(404);
  });
});

test.describe('duplicates and lifecycle', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('submitting the same file twice does not create a second copy', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Fixture' });
    const dogId = await firstDogId(request, token);

    const first = await upload(request, token, dogId,
      { name: 'rabies.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    expect(first.status()).toBe(201);

    // The double-click case.
    const second = await upload(request, token, dogId,
      { name: 'rabies.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    expect(second.status()).toBe(200);
    expect((await second.json()).duplicate).toBe(true);

    // Same bytes under a different name is still the same document.
    const renamed = await upload(request, token, dogId,
      { name: 'rabies-copy.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    expect((await renamed.json()).duplicate).toBe(true);

    const dogs = await (await request.get('/api/dogs', {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    expect(dogs.find(d => d.id === dogId).documents).toHaveLength(1);
  });

  test('the same file may be attached to a different dog', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'First' });
    const dogId = await firstDogId(request, token);

    const created = await request.post('/api/dogs', {
      headers: { authorization: `Bearer ${token}` },
      data: { name: 'Second' }
    });
    const secondDogId = (await created.json()).id;

    expect((await upload(request, token, dogId,
      { name: 'shared.pdf', mimeType: 'application/pdf', buffer: TINY_PDF })).status()).toBe(201);
    expect((await upload(request, token, secondDogId,
      { name: 'shared.pdf', mimeType: 'application/pdf', buffer: TINY_PDF })).status()).toBe(201);
  });

  test('deleting a dog removes its documents', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Temporary' });
    const dogId = await firstDogId(request, token);
    const created = await upload(request, token, dogId,
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    const docId = (await created.json()).document.id;

    const del = await request.delete(`/api/dogs/${dogId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(del.status()).toBe(200);
    expect((await del.json()).documents_deleted).toBe(1);

    // The bytes are gone too, not just the row — an orphaned veterinary record
    // sitting on disk is a retention problem.
    const adminToken = await loginAdmin(request);
    expect((await request.get(`/api/dogs/admin/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })).status()).toBe(404);
  });
});

test.describe('audit trail', () => {
  test.beforeEach(async ({ request }) => { await resetAll(request); });

  test('upload, download and delete are all recorded', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Audited' });
    const dogId = await firstDogId(request, token);

    const created = await upload(request, token, dogId,
      { name: 'a.pdf', mimeType: 'application/pdf', buffer: TINY_PDF });
    const docId = (await created.json()).document.id;

    await request.get(`/api/dogs/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const adminToken = await loginAdmin(request);
    await request.get(`/api/dogs/admin/documents/${docId}/download`, {
      headers: { authorization: `Bearer ${adminToken}` }
    });
    await request.delete(`/api/dogs/documents/${docId}`, {
      headers: { authorization: `Bearer ${token}` }
    });

    // Read the trail back through the admin document-events endpoint.
    const events = await (await request.get(`/api/dogs/admin/documents/${docId}/events`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })).json();

    const kinds = events.map(e => e.event);
    expect(kinds).toContain('upload');
    expect(kinds).toContain('download');
    expect(kinds).toContain('delete');
    // Both a customer download and an admin download are distinguishable.
    expect(events.filter(e => e.event === 'download' && e.actor_type === 'customer')).toHaveLength(1);
    expect(events.filter(e => e.event === 'download' && e.actor_type === 'admin')).toHaveLength(1);
  });

  test('a rejected upload is recorded too', async ({ request }) => {
    const { token } = await registerCustomer(request, { dog_name: 'Audited' });
    const dogId = await firstDogId(request, token);

    await upload(request, token, dogId,
      { name: 'bad.html', mimeType: 'text/html', buffer: Buffer.from('<html>x</html>') });

    const adminToken = await loginAdmin(request);
    const events = await (await request.get(`/api/dogs/admin/dogs/${dogId}/document-events`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })).json();
    expect(events.some(e => e.event === 'upload_rejected')).toBe(true);
  });
});
