import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureJdTexts, formatScanHistoryRow } from '../scan.mjs';
import { SCAN_HISTORY_COLUMNS, parseScanHistoryLine } from '../lib/scan-history-columns.mjs';
import { findCaptureForUrl } from '../jd-capture.mjs';
import { captureName } from '../capture-jd.mjs';

const DESC = 'You will own transaction monitoring rules and tune alert thresholds with the data team. '.repeat(6);

function offer(over = {}) {
  return { url: 'https://boards.greenhouse.io/acme/jobs/777', source: 'greenhouse-api', company: 'Acme', title: 'Senior Analyst', description: DESC, ...over };
}

function tempJds(t) {
  const dir = mkdtempSync(join(tmpdir(), 'co-scan-save-jd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return join(dir, 'jds');
}

test('jd_file is the last scan-history column', () => {
  assert.equal(SCAN_HISTORY_COLUMNS.at(-1), 'jd_file');
  assert.equal(SCAN_HISTORY_COLUMNS.at(-2), 'employment_type');
});

test('the row carries jd_file, and stays empty without a capture', () => {
  const withFile = formatScanHistoryRow({ ...offer(), jdFile: 'jds/x.md' }, '2026-11-20');
  assert.equal(withFile.split('\t').length, SCAN_HISTORY_COLUMNS.length);
  assert.equal(parseScanHistoryLine(withFile).jd_file, 'jds/x.md');
  assert.equal(parseScanHistoryLine(formatScanHistoryRow(offer(), '2026-11-20')).jd_file, '');
});

test('captureJdTexts saves described offers under the capture name and skips the rest', (t) => {
  const jdsDir = tempJds(t);
  const described = offer();
  const bare = offer({ url: 'https://x.example/2', description: undefined });
  const teaser = offer({ url: 'https://x.example/3', description: 'Short teaser.' });
  assert.equal(captureJdTexts([described, bare, teaser], '2026-11-20', jdsDir), 1);

  const expected = captureName({ company: 'Acme', role: 'Senior Analyst', url: described.url, date: '2026-11-20' });
  assert.equal(described.jdFile, `jds/${expected}`);
  assert.equal(bare.jdFile, undefined);
  assert.equal(teaser.jdFile, undefined);
  assert.deepEqual(readdirSync(jdsDir), [expected]);
  assert.equal(findCaptureForUrl(jdsDir, described.url)?.filename, expected);

  const content = readFileSync(join(jdsDir, expected), 'utf8');
  assert.ok(content.includes(DESC.trim()));
  assert.match(content, /Untrusted external content/);
});

test('a URL that already has a capture keeps it', (t) => {
  const jdsDir = tempJds(t);
  captureJdTexts([offer()], '2026-11-20', jdsDir);
  const again = offer({ description: 'A different body. '.repeat(30) });
  assert.equal(captureJdTexts([again], '2026-11-21', jdsDir), 0);
  assert.equal(readdirSync(jdsDir).length, 1);
  assert.match(again.jdFile, /^jds\/2026-11-20_/);
});

test('a symlink at the capture path is never written through', (t) => {
  const jdsDir = tempJds(t);
  captureJdTexts([offer({ url: 'https://x.example/seed' })], '2026-11-20', jdsDir);
  const outside = join(jdsDir, '..', 'outside.txt');
  writeFileSync(outside, 'keep');
  const target = offer({ url: 'https://x.example/9' });
  const name = captureName({ company: 'Acme', role: 'Senior Analyst', url: target.url, date: '2026-11-20' });
  symlinkSync(outside, join(jdsDir, name));
  assert.equal(captureJdTexts([target], '2026-11-20', jdsDir), 0);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
});
