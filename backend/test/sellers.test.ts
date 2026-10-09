import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

// Checks that happen before any database call: no MongoDB needed.
const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });

describe('/api/sellers/me without a database', () => {
  it('GET without a token is 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/api/sellers/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } });
  });

  it('PUT without a token is 401 UNAUTHENTICATED', async () => {
    const res = await request(app).put('/api/sellers/me').send({});
    expect(res.status).toBe(401);
  });

  it('PUT with a bad body is 400 VALIDATION_ERROR naming each field', async () => {
    const res = await request(app)
      .put('/api/sellers/me')
      .set('Authorization', bearer('user_a'))
      .send({
        businessName: 'Mama T',
        phone: 8031234567, // a number, as <input type="number"> would send
        payment: { bankName: 'GTBank', accountNumber: '12345', accountName: 'Titi' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/phone: Phone must be text/);
    expect(res.body.error.message).toMatch(/payment\.accountNumber: Account number must be exactly 10 digits/);
  });

  it('PUT with an invalid slug is 400', async () => {
    const res = await request(app)
      .put('/api/sellers/me')
      .set('Authorization', bearer('user_a'))
      .send({
        businessName: 'Mama T',
        slug: 'mama t!',
        phone: '08031234567',
        payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Titi' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^slug:/);
  });
});
