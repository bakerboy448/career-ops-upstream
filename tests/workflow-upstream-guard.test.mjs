// tests/workflow-upstream-guard.test.mjs: the project's own maintenance jobs
// run only in career-ops-hq/career-ops.
//
// update-system.mjs ships .github/ to every install (lib/update-manifest.mjs),
// so a fork, or an install pushed to a repo of its own, carries every workflow.
// There a scheduled job has no queue to work and no project secrets: the
// every-30-minutes CI approver alone starts 48 jobs a day, and each fails or
// does nothing (#4616). Release jobs fail on every push to main without the
// release app's secrets. Each such job carries the repository guard that
// readme-badges.yml already uses.
//
// CodeQL is the exception: it also runs on pull requests, and a fork that
// enables Actions should keep its code scanning.
//
// Run:  node --test tests/workflow-upstream-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { ROOT } from './helpers.mjs';

const DIR = join(ROOT, '.github/workflows');
const GUARD = "github.repository == 'career-ops-hq/career-ops'";
const EXEMPT = new Set(['codeql.yml']);
const ALWAYS_GUARDED = new Set(['release.yml']);

const workflows = readdirSync(DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((file) => {
    const wf = load(readFileSync(join(DIR, file), 'utf8'));
    // js-yaml reads a bare `on:` key as the boolean true.
    const on = wf.on ?? wf[true] ?? {};
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
    return { file, wf, triggers };
  });

const guarded = workflows.filter(
  ({ file, triggers }) => !EXEMPT.has(file) && (ALWAYS_GUARDED.has(file) || triggers.includes('schedule')),
);

test('finds the scheduled workflows', () => {
  assert.ok(guarded.some(({ file }) => file === 'ci-approve.yml'), 'ci-approve.yml must be in scope');
});

for (const { file, wf } of guarded) {
  test(`${file}: every job runs only in the upstream repository`, () => {
    for (const [id, job] of Object.entries(wf.jobs)) {
      assert.ok(String(job.if ?? '').includes(GUARD), `${file} job "${id}" needs: if: ${GUARD}`);
    }
  });
}
