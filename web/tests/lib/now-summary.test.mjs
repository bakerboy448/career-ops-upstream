// Today's "look at this now" list: the order, and what "since your last
// visit" counts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { nowItems, resolveLastVisit, countSince, tallyDays, localDay, VISIT_GAP_MS } from '../../src/lib/home/now-summary.mjs';

const NONE = { followupsDue: 0, applyReady: 0, awaiting: 0, newFound: 0, newScored: 0 };

test('work with a deadline leads, then ready work, then decisions, then arrivals', () => {
  const items = nowItems({ followupsDue: 2, applyReady: 1, awaiting: 47, newFound: 5, newScored: 4 });
  assert.deepEqual(items, [
    { kind: 'followups', count: 2 },
    { kind: 'apply-ready', count: 1 },
    { kind: 'decide', count: 47 },
    { kind: 'new', count: 9 },
  ]);
});

test('a zero row is dropped, so the first row is always real work', () => {
  assert.deepEqual(nowItems({ ...NONE, awaiting: 47, newFound: 12 }).map((i) => i.kind), ['decide', 'new']);
  assert.deepEqual(nowItems(NONE), []);
  assert.deepEqual(nowItems({ ...NONE, awaiting: Number.NaN, applyReady: -1 }), []);
});

const T0 = Date.parse('2026-11-17T12:00:00.000Z');

test('a first visit has no baseline and records the visit', () => {
  const visit = resolveLastVisit(null, T0);
  assert.equal(visit.baseline, null);
  assert.deepEqual(JSON.parse(visit.store), { baseline: null, current: '2026-11-17T12:00:00.000Z' });
});

test('a reload during one visit keeps the same baseline', () => {
  const first = resolveLastVisit(null, T0);
  const reload = resolveLastVisit(first.store, T0 + 10 * 60_000);
  assert.equal(reload.baseline, null);
  assert.equal(reload.store, first.store);
});

test('coming back after the gap makes the previous visit the baseline', () => {
  const first = resolveLastVisit(null, T0);
  const later = resolveLastVisit(first.store, T0 + VISIT_GAP_MS + 1);
  assert.equal(later.baseline, '2026-11-17T12:00:00.000Z');
  const reload = resolveLastVisit(later.store, T0 + VISIT_GAP_MS + 60_000);
  assert.equal(reload.baseline, '2026-11-17T12:00:00.000Z');
});

test('a corrupt record reads as a first visit', () => {
  assert.equal(resolveLastVisit('{not json', T0).baseline, null);
  assert.equal(resolveLastVisit(JSON.stringify({ baseline: 'x', current: 7 }), T0).baseline, null);
});

test('countSince includes the baseline day and ignores bad keys', () => {
  const byDay = { '2026-11-14': 3, '2026-11-15': 2, '2026-11-17': 4, junk: 9, '2026-11-16': -1 };
  assert.equal(countSince(byDay, '2026-11-15'), 6);
  assert.equal(countSince(byDay, '2026-11-18'), 0);
  assert.equal(countSince(byDay, ''), 0);
  assert.equal(countSince(null, '2026-11-15'), 0);
});

test('tallyDays counts per day and drops days before the floor', () => {
  assert.deepEqual(tallyDays(['2026-11-15', '2026-11-15', '2026-09-01', undefined, 'N/A', '2026-11-17'], '2026-10-01'), { '2026-11-15': 2, '2026-11-17': 1 });
});

test('localDay pads the month and day', () => {
  assert.equal(localDay(0, () => ({ y: 2026, m: 3, d: 9 })), '2026-03-09');
  assert.equal(localDay('nope'), '');
});
