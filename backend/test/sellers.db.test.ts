import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });

function profile(overrides: Record<string, unknown> = {}) {
  return {
    businessName: "Mama T's Kitchen",
    phone: '0803 123 4567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Titilayo Adebayo' },
    ...overrides,
  };
}

function putMe(userId: string, body: unknown) {
  return request(app).put('/api/sellers/me').set('Authorization', bearer(userId)).send(body as object);
}

describe.skipIf(!testDbUri)('/api/sellers/me on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('sellers');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('GET is 403 PROFILE_REQUIRED before onboarding', async () => {
    const res = await request(app).get('/api/sellers/me').set('Authorization', bearer('new_user'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROFILE_REQUIRED');
  });

  it('first PUT creates the profile (201) with a generated slug and normalised phone', async () => {
    const res = await putMe('user_a', profile());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      businessName: "Mama T's Kitchen",
      slug: 'mama-ts-kitchen',
      phone: '+2348031234567',
      payment: { accountNumber: '0123456789' },
    });
    expect(res.body.id).toMatch(/^[0-9a-f]{24}$/);
    // Internal fields are not exposed.
    expect(res.body).not.toHaveProperty('clerkUserId');
    expect(res.body).not.toHaveProperty('__v');
  });

  it('GET returns the profile after onboarding', async () => {
    const res = await request(app).get('/api/sellers/me').set('Authorization', bearer('user_a'));
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('mama-ts-kitchen');
  });

  it('a second seller with the same name gets the next free slug', async () => {
    const res = await putMe('user_b', profile());
    expect(res.status).toBe(201);
    expect(res.body.slug).toBe('mama-ts-kitchen-2');
  });

  it('PUT again updates (200) and keeps the slug when none is sent', async () => {
    const res = await putMe('user_a', profile({ businessName: 'Mama T Kitchen & Grills' }));
    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe('Mama T Kitchen & Grills');
    expect(res.body.slug).toBe('mama-ts-kitchen');
    expect(await SellerModel.countDocuments({ clerkUserId: 'user_a' })).toBe(1);
  });

  it("choosing another seller's slug is 409 SLUG_TAKEN", async () => {
    const res = await putMe('user_a', profile({ slug: 'mama-ts-kitchen-2' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_TAKEN');
  });

  it('a seller can change to a free slug (lowercased)', async () => {
    const res = await putMe('user_a', profile({ slug: 'Mama-T-Yaba' }));
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('mama-t-yaba');
  });

  it("isolation: ids smuggled in the body cannot take over another seller's profile", async () => {
    const sellerB = await SellerModel.findOne({ clerkUserId: 'user_b' }).lean();

    const res = await putMe('user_a', {
      ...profile({ businessName: 'Hijacked' }),
      clerkUserId: 'user_b',
      _id: sellerB!._id.toString(),
      sellerId: sellerB!._id.toString(),
    });
    expect(res.status).toBe(200);

    // The change landed on A's own profile; B is untouched.
    const a = await SellerModel.findOne({ clerkUserId: 'user_a' }).lean();
    const b = await SellerModel.findOne({ clerkUserId: 'user_b' }).lean();
    expect(a!.businessName).toBe('Hijacked');
    expect(b!.businessName).toBe("Mama T's Kitchen");
    expect(res.body.id).toBe(a!._id.toString());
  });

  it('choosing a taken link at sign-up is 409 SLUG_TAKEN and creates nothing', async () => {
    const res = await putMe('user_d', profile({ slug: 'mama-t-yaba' }));
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'SLUG_TAKEN', message: 'The link "mama-t-yaba" is taken' });
    expect(await SellerModel.countDocuments({ clerkUserId: 'user_d' })).toBe(0);
  });

  it('when the generated link and all its variants are taken, asks the seller to choose', async () => {
    const taken = ['busy-kitchen', ...Array.from({ length: 19 }, (_, i) => `busy-kitchen-${i + 2}`)];
    await SellerModel.insertMany(
      taken.map((slug, i) => ({ ...profile(), phone: '+2348031234567', clerkUserId: `filler_${i}`, slug })),
    );
    const res = await putMe('user_e', profile({ businessName: 'Busy Kitchen' }));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Could not find a free link for this business name; choose one');
  });

  it('two first-time PUTs from the same user at once create exactly one profile', async () => {
    const results = await Promise.all([putMe('user_c', profile()), putMe('user_c', profile())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await SellerModel.countDocuments({ clerkUserId: 'user_c' })).toBe(1);
  });
});
