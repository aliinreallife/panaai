// Pure financial-audit bucket checks: fishy mismatches must surface clearly.
import assert from 'node:assert/strict';
const { evaluateFinancialIntegrity } = await import('../src/lib/financial-audit-checks.ts');
const pass = n => console.log(`PASS ${n}`);

const base = () => ({
  available: 1_000_000,
  reserved: 0,
  allocated: 400_000,
  unallocated: 600_000,
  keySpentTotal: 50_000,
  usageCreditsTotal: 50_000,
  keys: [
    { id: 'k1', name: 'alpha', enabled: true, budget: 500_000, spent: 100_000 },
    { id: 'k2', name: 'beta', enabled: true, budget: null, spent: 0 },
  ],
  lots: [
    { id: 'l1', orderId: 'o1', origin: 'purchase', granted: 1_000_000, remaining: 950_000, reserved: 0, expiresAt: '2099-01-01' },
  ],
  approvedOrders: [{ id: 'o1', reference: 'CR-TEST', credits: 1_000_000 }],
  lotGrantedByOrder: { o1: 1_000_000 },
  usageByKeyName: { alpha: 100_000, beta: 0 },
  // Fix spent totals to match keys
  refunds: [],
  refundReversalByRefundId: {},
  heldReservationTotal: 0,
  lotReservedTotal: 0,
  walletLotIssues: [],
  unbalancedJournalEventIds: [],
  upstream: [],
});

// Align keySpentTotal with keys in clean snapshot
{
  const snap = base();
  snap.keySpentTotal = snap.keys.reduce((a, k) => a + k.spent, 0);
  snap.usageCreditsTotal = snap.keySpentTotal;
  snap.usageByKeyName = { alpha: 100_000, beta: 0 };
  // allocated from key remaining: 500k-100k = 400k — already set
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.equal(r.fishy, false);
  assert.ok(r.buckets.every(b => b.ok || b.severity === 'info'));
  assert.ok(r.identity.softAllocHolds && r.identity.spentEqualsUsage && r.identity.ordersMatchLots);
  pass('clean snapshot: all separated buckets ok');
}

{
  const snap = base();
  snap.keySpentTotal = 50_000;
  snap.usageCreditsTotal = 99_000;
  snap.keys = [{ id: 'k1', name: 'alpha', enabled: true, budget: null, spent: 50_000 }];
  snap.usageByKeyName = { alpha: 99_000 };
  snap.allocated = 0;
  snap.unallocated = 1_000_000;
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, false);
  assert.equal(r.fishy, true);
  assert.ok(r.findings.some(f => f.code === 'spent_vs_usage'));
  assert.ok(r.findings.some(f => f.code === 'key_spent_vs_usage_name'));
  const spend = r.buckets.find(b => b.id === 'spend_ledger');
  assert.equal(spend.ok, false);
  assert.equal(spend.severity, 'error');
  pass('fishy: spent vs usage mismatch fails spend_ledger bucket');
}

{
  const snap = base();
  snap.keySpentTotal = 100_000;
  snap.usageCreditsTotal = 100_000;
  snap.usageByKeyName = { alpha: 100_000 };
  snap.keys = [{ id: 'k1', name: 'alpha', enabled: true, budget: 500_000, spent: 100_000 }];
  snap.allocated = 400_000;
  snap.available = 100_000;
  snap.unallocated = 0; // max(0, 100k-400k)
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, true); // oversubscribe is warn, not error
  assert.equal(r.fishy, true);
  assert.ok(r.findings.some(f => f.code === 'allocation_oversubscribed'));
  const soft = r.buckets.find(b => b.id === 'soft_allocation');
  assert.equal(soft.ok, true);
  assert.equal(soft.severity, 'warn');
  pass('fishy warn: soft allocation oversubscribed is visible without hard fail');
}

{
  const snap = base();
  snap.keySpentTotal = 100_000;
  snap.usageCreditsTotal = 100_000;
  snap.usageByKeyName = { alpha: 100_000 };
  snap.keys = [{ id: 'k1', name: 'alpha', enabled: true, budget: 500_000, spent: 100_000 }];
  snap.allocated = 400_000;
  snap.unallocated = 999; // wrong on purpose
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => f.code === 'unallocated_math' || f.code === 'soft_identity_broken'));
  assert.equal(r.buckets.find(b => b.id === 'soft_allocation').ok, false);
  pass('fishy: broken soft-allocation identity fails soft_allocation bucket');
}

{
  const snap = base();
  snap.keySpentTotal = 0;
  snap.usageCreditsTotal = 0;
  snap.keys = [];
  snap.usageByKeyName = {};
  snap.allocated = 0;
  snap.unallocated = 1_000_000;
  snap.approvedOrders = [{ id: 'o1', reference: 'CR-X', credits: 1_000_000 }];
  snap.lotGrantedByOrder = {}; // missing lot
  snap.lots = [];
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => f.code === 'approved_order_missing_lot'));
  assert.equal(r.buckets.find(b => b.id === 'orders_lots').ok, false);
  pass('fishy: approved order without lot fails orders_lots bucket');
}

{
  const snap = base();
  snap.keySpentTotal = 100_000;
  snap.usageCreditsTotal = 100_000;
  snap.usageByKeyName = { alpha: 100_000 };
  snap.keys = [{ id: 'k1', name: 'alpha', enabled: true, budget: 500_000, spent: 100_000 }];
  snap.allocated = 400_000;
  snap.unallocated = 600_000;
  snap.refunds = [{ id: 'r1', state: 'paid', credits: 10_000, orderId: 'o1' }];
  snap.refundReversalByRefundId = {}; // missing reversal
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => f.code === 'refund_missing_reversal'));
  assert.equal(r.buckets.find(b => b.id === 'refunds').ok, false);
  pass('fishy: paid refund without reversal fails refunds bucket');
}

{
  const snap = base();
  snap.keySpentTotal = 100_000;
  snap.usageCreditsTotal = 100_000;
  snap.usageByKeyName = { alpha: 100_000 };
  snap.keys = [
    { id: 'k1', name: 'alpha', enabled: true, budget: null, spent: 100_000 },
    { id: 'k2', name: 'beta', enabled: true, budget: null, spent: 0 },
  ];
  snap.allocated = 0;
  snap.unallocated = 1_000_000;
  snap.upstream = [
    { id: 'u1', kind: 'shared_uncapped', platformKeyId: null, prefix: 'sk-a', revoked: false },
    { id: 'u2', kind: 'shared_uncapped', platformKeyId: null, prefix: 'sk-b', revoked: false },
  ];
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => f.code === 'upstream_shared_duplicate'));
  assert.equal(r.buckets.find(b => b.id === 'upstream').ok, false);
  pass('fishy: duplicate shared CVC fails upstream bucket');
}

{
  const snap = base();
  snap.keySpentTotal = 100_000;
  snap.usageCreditsTotal = 100_000;
  snap.usageByKeyName = { alpha: 100_000 };
  snap.keys = [{ id: 'k1', name: 'alpha', enabled: true, budget: 500_000, spent: 100_000 }];
  snap.allocated = 400_000;
  snap.unallocated = 600_000;
  snap.heldReservationTotal = 5_000;
  snap.lotReservedTotal = 1_000;
  const r = evaluateFinancialIntegrity(snap);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some(f => f.code === 'held_vs_lot_reserved'));
  assert.equal(r.buckets.find(b => b.id === 'lots').ok, false);
  pass('fishy: held reservations vs lot.reserved mismatch fails lots bucket');
}

console.log('All financial audit bucket checks passed.');
