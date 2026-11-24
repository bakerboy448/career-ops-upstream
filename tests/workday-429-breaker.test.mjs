// tests/workday-429-breaker.test.mjs — the Workday provider stops every Workday
// request for the run once HTTP 429s span WORKDAY_BREAKER_HOSTS distinct tenant
// hosts with no success in between. A Cloudflare challenge does not count.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import workday, {
  resetWorkdayRetryBudgets,
  WORKDAY_BREAKER_HOSTS,
  workdayBreakerOpen,
  workdayTenantKey,
} from '../providers/workday.mjs';

const entry = (host) => ({
  name: host,
  api: `https://${host}.wd1.myworkdayjobs.com/wday/cxs/${host}/Ext/jobs`,
  careers_url: `https://${host}.wd1.myworkdayjobs.com/Ext`,
});

function make429({ retryAfter = '5', cfMitigated } = {}) {
  const err = new Error('HTTP 429 Too Many Requests');
  err.status = 429;
  err.retryAfter = retryAfter;
  if (cfMitigated) err.cfMitigated = cfMitigated;
  return err;
}

function makeCtx(handler) {
  const calls = [];
  return {
    calls,
    ctx: {
      sleep: async () => {},
      fetchJson: async (url, opts) => {
        calls.push(new URL(url).host);
        return handler(new URL(url).host, opts);
      },
    },
  };
}

let logs;
const realError = console.error;
const realLog = console.log;
beforeEach(() => {
  resetWorkdayRetryBudgets();
  logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  console.log = () => {};
});
afterEach(() => {
  console.error = realError;
  console.log = realLog;
  resetWorkdayRetryBudgets();
});

async function scan(ctx, host) {
  try {
    return await workday.fetch(entry(host), ctx);
  } catch (err) {
    return err;
  }
}

test('the breaker threshold defaults to 3 distinct tenant hosts', () => {
  assert.equal(WORKDAY_BREAKER_HOSTS, 3);
});

test('the tenant key is the CXS host', () => {
  assert.equal(workdayTenantKey('https://Acme.wd5.myworkdayjobs.com/wday/cxs/acme/Ext/jobs'), 'acme.wd5.myworkdayjobs.com');
});

test('a 429 runs the slower 429 ladder: seven attempts before it gives up', async () => {
  const { ctx, calls } = makeCtx(() => { throw make429(); });
  await scan(ctx, 'alpha');
  assert.equal(calls.length, 7);
});

test('429s on 3 distinct hosts open the breaker and later tenants make no request', async () => {
  const { ctx, calls } = makeCtx(() => { throw make429(); });
  for (const h of ['alpha', 'bravo', 'charlie']) await scan(ctx, h);
  assert.equal(workdayBreakerOpen(), true);
  const before = calls.length;
  const err = await scan(ctx, 'delta');
  assert.equal(calls.length, before, 'no request after the breaker opens');
  assert.ok(err instanceof Error);
  assert.equal(logs.filter((l) => l.includes('circuit breaker open')).length, 1, 'one breaker line');
});

test('a success between 429s resets the streak', async () => {
  const ok = { total: 0, jobPostings: [] };
  const { ctx } = makeCtx((host) => {
    if (host.startsWith('charlie.')) return ok;
    throw make429();
  });
  for (const h of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) await scan(ctx, h);
  assert.equal(workdayBreakerOpen(), false);
});

test('repeated 429s on one host do not open the breaker', async () => {
  const { ctx } = makeCtx(() => { throw make429(); });
  for (let i = 0; i < 3; i++) await scan(ctx, 'alpha');
  assert.equal(workdayBreakerOpen(), false);
});

test('a Cloudflare challenge is not retried and does not count toward the breaker', async () => {
  const { ctx, calls } = makeCtx(() => { throw make429({ cfMitigated: 'challenge' }); });
  for (const h of ['alpha', 'bravo', 'charlie', 'delta']) await scan(ctx, h);
  assert.equal(workdayBreakerOpen(), false);
  assert.equal(calls.length, 4, 'one request per tenant, no retry');
});

test('Retry-After is logged once per host', async () => {
  const { ctx } = makeCtx(() => { throw make429({ retryAfter: '17' }); });
  await scan(ctx, 'alpha');
  await scan(ctx, 'alpha');
  const lines = logs.filter((l) => l.includes('Retry-After'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /alpha\.wd1\.myworkdayjobs\.com/);
  assert.match(lines[0], /Retry-After 17/);
});

test('requests to one tenant never overlap', async () => {
  let active = 0;
  let peak = 0;
  const { ctx } = makeCtx(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    return { total: 0, jobPostings: [] };
  });
  await Promise.all([scan(ctx, 'alpha'), scan(ctx, 'alpha'), scan(ctx, 'alpha')]);
  assert.equal(peak, 1);
});
