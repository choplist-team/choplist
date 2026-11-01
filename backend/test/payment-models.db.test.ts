import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderModel, orderPaymentMethod } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel, sellerFeeMode, sellerPaidOrderCount, sellerPaymentsReady } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';

const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Acct' };
const orderBase = {
  menuId: new Types.ObjectId(),
  customer: { name: 'Ada', phone: '+2348031234567' },
  delivery: { area: 'Yaba', address: '12 Close', day: '2026-11-05' },
  lines: [{ itemId: new Types.ObjectId(), name: 'Jollof', unitPrice: 7500, qty: 1 }],
  total: 7500,
};

const paymentFields = (over: Record<string, unknown> = {}) => ({
  orderId: new Types.ObjectId(),
  orderRef: 'CL-AAAAA',
  sellerId: new Types.ObjectId(),
  reference: `cl_${new Types.ObjectId().toHexString()}`,
  amountKobo: 771_600,
  transactionChargeKobo: 21_600,
  platformFeeKobo: 0,
  paystackFeeKobo: 21_574,
  bearer: 'account',
  subaccountCode: 'ACCT_test123',
  ...over,
});

// Loosely typed on purpose: several tests pass invalid values to prove the model refuses them.
const makePayment = (over: Record<string, unknown> = {}) => PaymentModel.create(paymentFields(over) as never);

describe.skipIf(!testDbUri)('payment fields and the Payment collection on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('paymentmodels');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await Promise.all([SellerModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({})]);
  });

  describe('a new seller', () => {
    it('defaults: customer pays fees, no paid orders, payments not ready, no subaccount', async () => {
      const seller = await SellerModel.create({ clerkUserId: 'u1', businessName: 'A', slug: 'a-kitchen', phone: '+2348031234567', payment });
      expect(seller.feeMode).toBe('customer');
      expect(seller.paidOrderCount).toBe(0);
      expect(seller.paymentsReady).toBe(false);
      expect(seller.paystackSubaccountCode).toBeUndefined();
    });

    it('refuses a feeMode other than customer or seller, and a negative paid-order count', async () => {
      const base = { clerkUserId: 'u2', businessName: 'B', slug: 'b-kitchen', phone: '+2348031234567', payment };
      await expect(SellerModel.create({ ...base, feeMode: 'free' as never })).rejects.toThrow(/feeMode/);
      await expect(SellerModel.create({ ...base, paidOrderCount: -1 })).rejects.toThrow(/paidOrderCount/);
    });
  });

  describe('a seller saved before these fields existed (no defaults in the database)', () => {
    it('reads as customer-pays, zero paid orders, not ready, even through lean()', async () => {
      // Inserted straight into the collection, as an old document would be.
      const { insertedId } = await SellerModel.collection.insertOne({
        clerkUserId: 'old1', businessName: 'Old', slug: 'old-kitchen', phone: '+2348031234567', payment, status: 'active',
      });
      const raw = await SellerModel.findById(insertedId).lean();
      expect(raw).not.toHaveProperty('feeMode');
      expect(sellerFeeMode(raw!)).toBe('customer');
      expect(sellerPaidOrderCount(raw!)).toBe(0);
      expect(sellerPaymentsReady(raw!)).toBe(false);
    });

    it('counts paid orders correctly with $inc even though the field was never there', async () => {
      const { insertedId } = await SellerModel.collection.insertOne({
        clerkUserId: 'old2', businessName: 'Old', slug: 'old2-kitchen', phone: '+2348031234567', payment,
      });
      // 25 payments confirmed at the same moment: every one must count.
      await Promise.all(Array.from({ length: 25 }, () => SellerModel.updateOne({ _id: insertedId }, { $inc: { paidOrderCount: 1 } })));
      const after = await SellerModel.findById(insertedId).lean();
      expect(after!.paidOrderCount).toBe(25);
    });

    it('is only "ready" with the flag AND a subaccount code', () => {
      expect(sellerPaymentsReady({ paymentsReady: true, paystackSubaccountCode: 'ACCT_x' })).toBe(true);
      expect(sellerPaymentsReady({ paymentsReady: true })).toBe(false);
      expect(sellerPaymentsReady({ paymentsReady: false, paystackSubaccountCode: 'ACCT_x' })).toBe(false);
    });
  });

  describe('orders', () => {
    it('a new order defaults to a bank transfer with no service fee and no fee snapshot', async () => {
      const order = await OrderModel.create({ ...orderBase, ref: 'CL-AAAAB', sellerId: new Types.ObjectId() });
      expect(order.paymentMethod).toBe('transfer');
      expect(order.serviceFee).toBe(0);
      expect(order.platformFeeBps).toBeUndefined();
      expect(order.platformFeeKobo).toBeUndefined();
      expect(order.paystackFeeKobo).toBeUndefined();
    });

    it('an order from before Paystack (no paymentMethod stored) is a transfer', async () => {
      const { insertedId } = await OrderModel.collection.insertOne({ ...orderBase, ref: 'CL-AAAAC', sellerId: new Types.ObjectId(), status: 'paid' });
      const raw = await OrderModel.findById(insertedId).lean();
      expect(raw).not.toHaveProperty('paymentMethod');
      expect(orderPaymentMethod(raw!)).toBe('transfer');
    });

    it('stores the fee snapshot and the Paystack method', async () => {
      const order = await OrderModel.create({
        ...orderBase, ref: 'CL-AAAAD', sellerId: new Types.ObjectId(),
        paymentMethod: 'paystack', serviceFee: 445, platformFeeBps: 300, platformFeeKobo: 22_500, paystackFeeKobo: 21_918,
      });
      const saved = await OrderModel.findById(order._id).lean();
      expect(saved).toMatchObject({ paymentMethod: 'paystack', serviceFee: 445, platformFeeBps: 300, platformFeeKobo: 22_500, paystackFeeKobo: 21_918 });
      expect(orderPaymentMethod(saved!)).toBe('paystack');
    });

    it('refuses a fractional service fee, a fractional kobo figure and an unknown method', async () => {
      const base = { ...orderBase, sellerId: new Types.ObjectId() };
      await expect(OrderModel.create({ ...base, ref: 'CL-AAAAE', serviceFee: 10.5 })).rejects.toThrow(/serviceFee/);
      await expect(OrderModel.create({ ...base, ref: 'CL-AAAAF', platformFeeKobo: 100.5 })).rejects.toThrow(/platformFeeKobo/);
      await expect(OrderModel.create({ ...base, ref: 'CL-AAAAG', paymentMethod: 'cash' as never })).rejects.toThrow(/paymentMethod/);
    });

    it('total still means the menu items only: a service fee does not enter it', async () => {
      const order = await OrderModel.create({ ...orderBase, ref: 'CL-AAAAH', sellerId: new Types.ObjectId(), serviceFee: 445 });
      expect(order.total).toBe(7500);
    });
  });

  describe('Payment', () => {
    it('saves with the defaults and rejects fractional or negative kobo', async () => {
      const saved = await makePayment();
      expect(saved.status).toBe('initialized');
      expect(saved.currency).toBe('NGN');
      await expect(makePayment({ amountKobo: 100.5 })).rejects.toThrow(/amountKobo/);
      await expect(makePayment({ amountKobo: -1 })).rejects.toThrow(/amountKobo/);
    });

    it('refuses an unknown status, bearer or currency', async () => {
      await expect(makePayment({ status: 'done' })).rejects.toThrow(/status/);
      await expect(makePayment({ bearer: 'customer' })).rejects.toThrow(/bearer/);
      await expect(makePayment({ currency: 'USD' })).rejects.toThrow(/currency/);
    });

    it('the reference is unique: the same one can never be saved twice', async () => {
      await makePayment({ reference: 'cl_dup' });
      await expect(makePayment({ reference: 'cl_dup' })).rejects.toMatchObject({ code: 11000 });
    });

    it('an order can have many failed or initialized attempts', async () => {
      const orderId = new Types.ObjectId();
      await makePayment({ orderId, status: 'failed' });
      await makePayment({ orderId, status: 'failed' });
      await makePayment({ orderId, status: 'initialized' });
      expect(await PaymentModel.countDocuments({ orderId })).toBe(3);
    });

    it('but only ONE succeeded payment per order, enforced by the database', async () => {
      const orderId = new Types.ObjectId();
      await makePayment({ orderId, status: 'succeeded', paidAt: new Date() });
      await expect(makePayment({ orderId, status: 'succeeded', paidAt: new Date() })).rejects.toMatchObject({ code: 11000 });
      // ...while a different order is unaffected, and so is another failed attempt.
      await makePayment({ status: 'succeeded', paidAt: new Date() });
      await makePayment({ orderId, status: 'failed' });
    });

    it('two attempts racing to become the succeeded one: exactly one wins', async () => {
      const orderId = new Types.ObjectId();
      const a = await makePayment({ orderId });
      const b = await makePayment({ orderId });
      const results = await Promise.allSettled(
        [a, b].map((p) => PaymentModel.updateOne({ _id: p._id }, { $set: { status: 'succeeded', paidAt: new Date() } })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await PaymentModel.countDocuments({ orderId, status: 'succeeded' })).toBe(1);
    });

    it('has the indexes the queries rely on (built from db.ts, not left to autoIndex)', async () => {
      const indexes = await PaymentModel.collection.indexes();
      const byKey = (key: Record<string, number>) => indexes.find((i) => JSON.stringify(i.key) === JSON.stringify(key) && !i.partialFilterExpression);
      expect(indexes.find((i) => i.key.reference === 1)?.unique).toBe(true);
      expect(byKey({ orderId: 1, createdAt: -1 })).toBeDefined();
      expect(byKey({ sellerId: 1, status: 1, paidAt: -1 })).toBeDefined();
      expect(byKey({ status: 1, paidAt: -1 })).toBeDefined();
      const guard = indexes.find((i) => i.partialFilterExpression);
      expect(guard).toMatchObject({ unique: true, key: { orderId: 1 }, partialFilterExpression: { status: 'succeeded' } });
    });
  });

  it('connection sanity: this file used its own test database', () => {
    expect(mongoose.connection.name).toBe('paymentmodels_test');
  });
});
