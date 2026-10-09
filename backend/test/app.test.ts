import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import { errorHandler, notFound } from '../src/middleware/error-handler.js';

const FRONTEND = 'http://localhost:5173';
const app = createApp({ allowedOrigins: [FRONTEND] });

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers HEAD (used by uptime monitors)', async () => {
    const res = await request(app).head('/health');
    expect(res.status).toBe(200);
  });

  it('sends helmet security headers and hides X-Powered-By', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS', () => {
  it('allows a listed origin', async () => {
    const res = await request(app).get('/health').set('Origin', FRONTEND);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
  });

  it('gives no permission header to an unlisted origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the preflight the frontend triggers (Authorization + JSON content type)', async () => {
    const res = await request(app)
      .options('/api/sellers/me')
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
  });
});

describe('errors through createApp()', () => {
  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route GET /api/nope not found' } });
  });

  it('returns 400 INVALID_JSON for a malformed body', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('returns 413 PAYLOAD_TOO_LARGE for a body over 20kb', async () => {
    const res = await request(app)
      .post('/api/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(21 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

// A small app with test-only routes, to exercise the error handler with
// errors that real routes will throw in later steps.
describe('errorHandler', () => {
  const testApp = express();
  testApp.get('/app-error', () => {
    throw new AppError(409, 'BAD_REQUEST', 'Something specific');
  });
  testApp.get('/async-app-error', async () => {
    await Promise.resolve();
    throw new AppError(409, 'BAD_REQUEST', 'Thrown after an await');
  });
  testApp.get('/bug', () => {
    throw new Error('connection string mongodb://secret@host leaked');
  });
  testApp.use(notFound);
  testApp.use(errorHandler);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns an AppError into its status and code', async () => {
    const res = await request(testApp).get('/app-error');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'BAD_REQUEST', message: 'Something specific' } });
  });

  it('catches errors from async handlers (Express 5 forwards rejected promises)', async () => {
    const res = await request(testApp).get('/async-app-error');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Thrown after an await');
  });

  it('hides unexpected error details from the client but logs them', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(testApp).get('/bug');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(log).toHaveBeenCalledOnce();
  });
});
