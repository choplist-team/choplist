import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler, notFound } from '../src/middleware/error-handler.js';
import { ORDER_STATUSES, isOrderStatus } from '../src/models/order.js';
import { splitStatusFilter, statusFilterSchema } from '../src/orders/status-filter.js';

// No database in this file: the parser is pure, and the HTTP checks use a tiny
// Express app with the real error handler.

describe('ORDER_STATUSES', () => {
  it('has exactly these five spellings (the frontend and the docs rely on them)', () => {
    expect([...ORDER_STATUSES]).toEqual(['pending', 'paid', 'out_for_delivery', 'delivered', 'cancelled']);
  });

  it('isOrderStatus accepts them and nothing else', () => {
    for (const status of ORDER_STATUSES) expect(isOrderStatus(status)).toBe(true);
    for (const wrong of ['all', 'out-for-delivery', 'PAID', 'Paid', '', ' paid', 'refunded']) {
      expect(isOrderStatus(wrong)).toBe(false);
    }
  });
});

describe('splitStatusFilter', () => {
  it.each<[string, string | string[] | undefined, string[]]>([
    ['missing', undefined, []],
    ['empty string', '', []],
    ['only commas and spaces', ' , ,, ', []],
    ['one value', 'paid', ['paid']],
    ['comma list', 'paid,out_for_delivery', ['paid', 'out_for_delivery']],
    ['spaces around items', ' paid , delivered ', ['paid', 'delivered']],
    ['repeated parameter (an array)', ['paid', 'delivered'], ['paid', 'delivered']],
    ['array whose items hold commas', ['paid,delivered', 'cancelled'], ['paid', 'delivered', 'cancelled']],
    ['duplicates are removed, order kept', 'paid,pending,paid', ['paid', 'pending']],
    ['an empty item in a list', 'paid,,delivered', ['paid', 'delivered']],
  ])('%s', (_name, input, expected) => {
    expect(splitStatusFilter(input)).toEqual(expected);
  });
});

describe('statusFilterSchema', () => {
  const parse = (value: unknown) => statusFilterSchema.safeParse(value);

  it('missing or empty means no filter (undefined)', () => {
    for (const value of [undefined, '', ',', [], ['']]) {
      const r = parse(value);
      expect(r.success && r.data).toBeUndefined();
      expect(r.success).toBe(true);
    }
  });

  it('accepts every valid status on its own', () => {
    for (const status of ORDER_STATUSES) {
      const r = parse(status);
      expect(r.success && r.data).toEqual([status]);
    }
  });

  it('accepts a comma list, a repeated parameter and a mix of both', () => {
    expect(parse('paid,out_for_delivery').data).toEqual(['paid', 'out_for_delivery']);
    expect(parse(['paid', 'delivered']).data).toEqual(['paid', 'delivered']);
    expect(parse(['paid,out_for_delivery', 'delivered']).data).toEqual(['paid', 'out_for_delivery', 'delivered']);
  });

  it.each(['all', 'out-for-delivery', 'PAID', 'refunded', 'paid;delivered'])('rejects %j and names it', (bad) => {
    const r = parse(bad);
    expect(r.success).toBe(false);
    const message = r.error?.issues.map((i) => i.message).join('; ') ?? '';
    expect(message).toContain(`"${bad}" is not a valid status`);
    expect(message).toContain('pending, paid, out_for_delivery, delivered, cancelled');
  });

  it('one bad value among good ones rejects the whole filter', () => {
    expect(parse('paid,all').success).toBe(false);
    expect(parse(['paid', 'out-for-delivery']).success).toBe(false);
  });

  it('reports every bad value, not just the first', () => {
    const r = parse('all,nope');
    expect(r.error?.issues).toHaveLength(2);
  });

  it('rejects things that are not text (e.g. a nested object)', () => {
    expect(parse({ a: 'paid' }).success).toBe(false);
    expect(parse(5).success).toBe(false);
  });
});

// The same schema inside a real Express app, using Express's own query parsing
// and the project's real error handler: this is what the frontend receives.
describe('GET ?status= over HTTP (no database)', () => {
  const app = express();
  app.get('/orders', (req, res) => {
    const { status } = z.object({ status: statusFilterSchema }).parse(req.query);
    res.json({ filter: status ?? null });
  });
  app.use(notFound);
  app.use(errorHandler);

  it.each([
    ['/orders', null],
    ['/orders?status=', null],
    ['/orders?status=out_for_delivery', ['out_for_delivery']],
    ['/orders?status=delivered', ['delivered']],
    ['/orders?status=paid,out_for_delivery', ['paid', 'out_for_delivery']],
    ['/orders?status=paid&status=delivered', ['paid', 'delivered']],
    ['/orders?status=paid,delivered&status=cancelled', ['paid', 'delivered', 'cancelled']],
    ['/orders?status=%20paid%20,%20delivered%20', ['paid', 'delivered']],
  ])('%s -> %j', async (url, filter) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ filter });
  });

  it('"all" is a 400 VALIDATION_ERROR in the usual error shape', async () => {
    const res = await request(app).get('/orders?status=all');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'status: "all" is not a valid status. Use one or more of: pending, paid, out_for_delivery, delivered, cancelled',
      },
    });
  });

  it('the hyphenated spelling is a 400, so a frontend typo cannot pass silently', async () => {
    const res = await request(app).get('/orders?status=out-for-delivery');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('"out-for-delivery"');
  });

  it('a bad value in a repeated parameter is a 400 too', async () => {
    expect((await request(app).get('/orders?status=paid&status=all')).status).toBe(400);
  });
});
