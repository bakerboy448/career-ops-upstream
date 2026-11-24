/**
 * now-summary.mjs — the order of the "look at this now" list on Today, and the
 * "new since your last visit" baseline. Pure, so the order is testable.
 */

/**
 * @typedef {object} NowFacts
 * @property {number} followupsDue    follow-ups due or overdue; 0 when that source failed
 * @property {number} applyReady      Apply call in the report and a tailored CV on disk
 * @property {number} awaiting        scored roles with no decision (status Evaluated)
 * @property {number} newFound        roles a scan found since the baseline, not scored yet
 * @property {number} newScored       roles scored since the baseline
 */

/**
 * The list in the order to act on it: work with a deadline, then work that is
 * ready to finish, then decisions, then what arrived. A row with a count of 0
 * is dropped, so an empty list means nothing needs the reader.
 *
 * A role whose report says Apply but has no tailored CV is not its own row. It
 * is still undecided, and a report can say Apply below the score line, so it
 * must not outrank the best-scored role. The decide row names it instead.
 *
 * @param {NowFacts} facts
 * @returns {{kind: "followups" | "apply-ready" | "decide" | "new", count: number}[]}
 */
export function nowItems(facts) {
  const n = (value) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);
  const fresh = n(facts.newFound) + n(facts.newScored);
  return [
    { kind: /** @type {const} */ ("followups"), count: n(facts.followupsDue) },
    { kind: /** @type {const} */ ("apply-ready"), count: n(facts.applyReady) },
    { kind: /** @type {const} */ ("decide"), count: n(facts.awaiting) },
    { kind: /** @type {const} */ ("new"), count: fresh },
  ].filter((item) => item.count > 0);
}

export const LAST_VISIT_STORAGE_KEY = "career-ops:today-last-visit";

/** A return after this long starts a new visit. A reload inside it does not. */
export const VISIT_GAP_MS = 4 * 3_600_000;

const isoOrNull = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);

/**
 * Read the stored visit record and decide what "since your last visit" means
 * for this page load.
 *
 * `baseline` is the start of the previous visit. It stays fixed while the
 * reader reloads during one visit, so the new items do not vanish on the first
 * reload. After `VISIT_GAP_MS` away, the current visit becomes the baseline.
 * A first visit, or a record that does not parse, has no baseline.
 *
 * @param {string | null | undefined} raw  stored JSON, or null
 * @param {number} now  epoch ms
 * @returns {{baseline: string | null, store: string}}  `store` is the JSON to write back
 */
export function resolveLastVisit(raw, now) {
  let baseline = null;
  let current = null;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      baseline = isoOrNull(parsed.baseline);
      current = isoOrNull(parsed.current);
    }
  } catch {
    // An unreadable record is a first visit.
  }
  const nowIso = new Date(now).toISOString();
  if (current && now - Date.parse(current) > VISIT_GAP_MS) {
    baseline = current;
    current = nowIso;
  } else if (!current) {
    current = nowIso;
  }
  return { baseline, store: JSON.stringify({ baseline, current }) };
}

/**
 * Calendar day (YYYY-MM-DD) of an instant in the reader's own time zone. The
 * ledgers store days, not instants, so "since" compares days.
 *
 * @param {number | string} instant  epoch ms or ISO
 * @param {(ms: number) => {y: number, m: number, d: number}} [parts]  injected for tests
 */
export function localDay(instant, parts = defaultParts) {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) return "";
  const { y, m, d } = parts(ms);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function defaultParts(ms) {
  const date = new Date(ms);
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/**
 * Items dated on or after `sinceDay`. The baseline day itself is included: a
 * role stamped that day may have arrived after the visit, and the ledgers do
 * not say which. The label names the day, so the count reads as "since Nov 15".
 *
 * @param {Record<string, number> | null | undefined} byDay  count per YYYY-MM-DD
 * @param {string} sinceDay  YYYY-MM-DD
 */
export function countSince(byDay, sinceDay) {
  if (!byDay || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDay)) return 0;
  let total = 0;
  for (const [day, count] of Object.entries(byDay)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= sinceDay && Number.isFinite(count) && count > 0) total += Math.trunc(count);
  }
  return total;
}

/**
 * Count per calendar day, for the days from `floorDay` on.
 *
 * @param {(string | null | undefined)[]} days
 * @param {string} floorDay  YYYY-MM-DD; older days are dropped
 * @returns {Record<string, number>}
 */
export function tallyDays(days, floorDay) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const day of Array.isArray(days) ? days : []) {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < floorDay) continue;
    out[day] = (out[day] ?? 0) + 1;
  }
  return out;
}
