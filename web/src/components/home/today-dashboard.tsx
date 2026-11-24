"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, ChevronRight, CircleHelp, Sparkles, ArrowRight, Undo2, X } from "lucide-react";
import { instrumentSerif } from "@/lib/fonts";
import type { Application, InboxJob } from "@/lib/career-ops";
import type { DiscoveredOffer } from "@/lib/explore";
import { DiscoveryCard } from "@/components/explore/discovery-card";
import { FollowUpCard, type FollowUp } from "@/components/home/follow-up-card";
import { DecisionCard } from "@/components/home/decision-card";
import type { CardReason } from "@/lib/machine-summary.mjs";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { LinkedInPaste } from "@/components/linkedin-paste";
import { FollowupsDueSectionSkeleton } from "@/components/page-loading-skeletons";
import { scoreNum } from "@/lib/format";
import { undoStatus } from "@/lib/pipeline-status.mjs";
import { pickAwaitingDecision, groupAwaiting, pickApplyNext, includeApplyTarget } from "@/lib/home/awaiting.mjs";
import { selectDueFollowups } from "@/lib/core/followup-view.mjs";
import { companyPresentation } from "@/lib/company-presentation.mjs";
import { ApplyNext } from "@/components/apply-next";
import { resolveHeroState, mayClaimAllClear, missingSourceLabel, displayCounts } from "@/lib/home/hero-state.mjs";
import { homeFollowupRemainder } from "@/lib/home/followups-shown.mjs";
import { LAST_VISIT_STORAGE_KEY, countSince, localDay, nowItems, resolveLastVisit } from "@/lib/home/now-summary.mjs";

export type NowFacts = {
  applyReady: number;
  applyNeedsCv: number;
  topReady: { n: string; company: string; score: string } | null;
  awaiting: number;
  best: { company: string; score: string } | null;
  foundByDay: Record<string, number>;
  scoredByDay: Record<string, number>;
  /** YYYY-MM-DD seven days before the request, the window used before a last visit is known. */
  weekAgoDay: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The retention "Today": a dual-loop action queue (the maintainer's
// "N new matches this week · M follow-ups due"). SUPPLY loop = fresh free-scan
// matches (zero tokens, /api/whats-new); DEMAND loop = follow-ups due
// (/api/followups). Each item one-tap actionable. Home stays a VIEW over the
// canonical files — every action dispatches a real registry action / route.
export function TodayDashboard({
  applications,
  reasons,
  legitimacy,
  inbox,
  applyFacts = {},
  applyDay,
  nowFacts,
}: {
  applications: Application[];
  reasons: Record<string, CardReason>;
  /** Block-G legitimacy per report number, read by the page from each report. */
  legitimacy: Record<string, string>;
  inbox: Pick<InboxJob, "url" | "done">[];
  inBetween: boolean;
  applyFacts?: Record<string, { pdfOnDisk: boolean; postingUrl: string }>;
  /** Server calendar day. Apply next does not read the browser clock. */
  applyDay: string;
  /** Server-read counts behind the "look at this now" list. */
  nowFacts?: NowFacts;
}) {
  const [followups, setFollowups] = useState<FollowUp[]>([]);
  const [overdue, setOverdue] = useState(0);
  const [followupsLoading, setFollowupsLoading] = useState(true);
  const [followupsError, setFollowupsError] = useState(false);
  const [followupsEnabled, setFollowupsEnabled] = useState(true);
  const [upcoming, setUpcoming] = useState<FollowUp[]>([]);
  const [fresh, setFresh] = useState<DiscoveredOffer[]>([]);
  const [freshCount, setFreshCount] = useState(0);
  const [freshLoading, setFreshLoading] = useState(true);
  const [freshError, setFreshError] = useState(false);
  const [decisionUndo, setDecisionUndo] = useState<{ n: string; label: string; busy?: boolean; error?: string } | null>(null);
  const requestGeneration = useRef(0);
  const router = useRouter();
  const dateLabel = useMemo(() => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }), []);
  // "New since your last visit". Read after mount: the server has no storage,
  // so the first paint uses the 7-day window and the baseline replaces it.
  const [sinceDay, setSinceDay] = useState<string | null>(null);
  useEffect(() => {
    try {
      const visit = resolveLastVisit(window.localStorage.getItem(LAST_VISIT_STORAGE_KEY), Date.now());
      if (visit.baseline) setSinceDay(localDay(visit.baseline));
      window.localStorage.setItem(LAST_VISIT_STORAGE_KEY, visit.store);
    } catch {
      // Blocked storage: the 7-day window stays.
    }
  }, []);

  const refetch = useCallback(() => {
    const generation = ++requestGeneration.current;
    const isLatest = () => generation === requestGeneration.current;
    setFollowupsLoading(true);
    setFollowupsError(false);
    fetch("/api/followups")
      .then((r) => {
        if (!r.ok) throw new Error("Follow-ups request failed");
        return r.json();
      })
      .then((d) => {
        if (!isLatest()) return;
        // The cadence route reports engine failures as HTTP 200 with
        // available:false; that is unavailable, not an empty action queue.
        if (d.available === false) throw new Error("Follow-ups unavailable");
        // /api/followups already filters to urgency 'urgent'/'overdue' — due
        // now, never 'waiting'/'cold' (#86). Both count toward "due"; a
        // missing metadata.overdue must read as 0 due, never as "every entry
        // is overdue" (the old `?? d.entries?.length` fallback).
        setFollowups(Array.isArray(d.entries) ? d.entries : []);
        setOverdue((d.metadata?.overdue ?? 0) + (d.metadata?.urgent ?? 0));
        setFollowupsEnabled(d.followupsEnabled !== false);
        setUpcoming(Array.isArray(d.upcoming) ? d.upcoming : []);
      })
      .catch(() => { if (isLatest()) setFollowupsError(true); })
      .finally(() => { if (isLatest()) setFollowupsLoading(false); });
    setFreshLoading(true);
    setFreshError(false);
    fetch("/api/whats-new")
      .then((r) => {
        if (!r.ok) throw new Error("Fresh matches request failed");
        return r.json();
      })
      .then((d) => {
        if (!isLatest()) return;
        const offers = Array.isArray(d.offers) ? d.offers : [];
        const count = Number(d.count);
        setFresh(offers);
        setFreshCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : offers.length);
      })
      .catch(() => { if (isLatest()) setFreshError(true); })
      .finally(() => { if (isLatest()) setFreshLoading(false); });
  }, []);

  useEffect(() => {
    refetch();
    // A worker (evaluate/pdf) just wrote a real tracker row — refresh the server
    // snapshot (applications/inbox props) + the client loops so the freshly-scored
    // role appears in "Awaiting your decision" without a manual reload.
    const onDone = () => {
      router.refresh();
      refetch();
    };
    window.addEventListener("co-job-done", onDone);
    return () => {
      window.removeEventListener("co-job-done", onDone);
      requestGeneration.current += 1;
    };
  }, [refetch, router]);

  // A Skip or Applied click removes its card on refresh, so the undo lives here.
  useEffect(() => {
    if (!decisionUndo || decisionUndo.busy || decisionUndo.error) return;
    const t = setTimeout(() => setDecisionUndo((current) => (current === decisionUndo ? null : current)), 5000);
    return () => clearTimeout(t);
  }, [decisionUndo]);

  const undoDecision = async (notice: { n: string; label: string }) => {
    setDecisionUndo({ ...notice, busy: true });
    try {
      await undoStatus(notice.n);
      setDecisionUndo(null);
      router.refresh();
    } catch (cause) {
      setDecisionUndo({ ...notice, error: cause instanceof Error ? cause.message : "Could not undo. Please try again." });
    }
  };

  // Awaiting decision: scored (Evaluated) but no terminal status yet. The
  // ordering lives in lib/home/awaiting.mjs so it can be tested — see the file
  // for why "first six in the array" was a bug waiting for #3529.
  const ranked = useMemo(() => pickAwaitingDecision(applications, scoreNum), [applications]);
  const applyTarget = useMemo(
    () => pickApplyNext(
      applications,
      scoreNum,
      (row) => reasons[row.n]?.decision ?? "",
      (row) => legitimacy[row.n],
      applyDay,
    ),
    [applications, reasons, legitimacy, applyDay],
  );
  const awaiting = useMemo(() => includeApplyTarget(ranked, applyTarget), [ranked, applyTarget]);
  // With the legitimacy, a flagged posting is grouped as the report page
  // labels it (#5300).
  const awaitingGroups = useMemo(() => groupAwaiting(awaiting, (a) => legitimacy[a.n]), [awaiting, legitimacy]);

  const newThisWeek = freshCount;
  const dataLoading = followupsLoading || freshLoading;
  const dataError = followupsError || freshError;
  // Derived from the flags refetch() already maintains — no second fetch loop
  // and no second source of truth. The only thing added is the distinction
  // dataError cannot make: a failure with known work still has a queue to show.
  const heroState = resolveHeroState({
    followupsLoading,
    freshLoading,
    followupsError,
    freshError,
    overdue,
    newThisWeek,
    awaitingCount: awaiting.length,
  });
  const allClear = mayClaimAllClear(heroState);
  const missingSources = missingSourceLabel({ followupsError, freshError });
  // Printed instead of the raw state: refetch() leaves the previous count in
  // place when a source fails, so `overdue` can still hold a number from before
  // the outage. See displayCounts().
  const shown = displayCounts({ followupsError, freshError, overdue, newThisWeek });
  const followupRest = homeFollowupRemainder(followups.length, overdue);
  const inboxUrls = useMemo(() => new Set(inbox.map((j) => j.url)), [inbox]);
  const dueFollowups = useMemo(
    () => selectDueFollowups(followups, Math.max(followups.length, 1)),
    [followups],
  );

  // The 7-day floor comes from the server so both renders count the same days.
  const newSince = sinceDay ?? nowFacts?.weekAgoDay ?? "";
  const newFound = countSince(nowFacts?.foundByDay, newSince);
  const newScored = countSince(nowFacts?.scoredByDay, newSince);
  const sinceLabel = sinceDay
    ? `since ${new Date(`${sinceDay}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, your last visit`
    : "in the last 7 days";
  const lookNow = nowItems({
    followupsDue: shown.overdue,
    applyReady: nowFacts?.applyReady ?? 0,
    awaiting: nowFacts?.awaiting ?? awaiting.length,
    newFound,
    newScored,
  });
  const lead = lookNow[0] ?? null;
  const nowRow = (item: (typeof lookNow)[number]) => {
    switch (item.kind) {
      case "followups":
        return { label: "Follow-ups due", detail: "Nudge these applications", href: "/followups" };
      case "apply-ready":
        return {
          label: "Ready to apply",
          detail: nowFacts?.topReady ? `Start with ${nowFacts.topReady.company}, ${nowFacts.topReady.score}` : "Report says Apply and the tailored CV is on disk",
          href: nowFacts?.topReady ? `/pipeline/${nowFacts.topReady.n}` : "#decide",
        };
      case "decide":
        return {
          label: "Scored, waiting for your decision",
          detail: [
            nowFacts?.best ? `Best: ${nowFacts.best.company}, ${nowFacts.best.score}` : "Review, skip, or mark applied",
            nowFacts && nowFacts.applyNeedsCv > 0 ? `${nowFacts.applyNeedsCv} marked Apply still ${nowFacts.applyNeedsCv === 1 ? "needs" : "need"} a tailored CV` : "",
          ].filter(Boolean).join(" · "),
          href: "/pipeline?tab=EVALUATED&sort=score",
        };
      default:
        return {
          label: `New ${sinceLabel}`,
          detail: [newFound > 0 ? `${newFound} found, not scored yet` : "", newScored > 0 ? `${newScored} scored` : ""].filter(Boolean).join(" · "),
          href: "/pipeline",
        };
    }
  };
  const leadHeadline = lead
    ? lead.kind === "followups"
      ? `${plural(lead.count, "follow-up is", "follow-ups are")} due`
      : lead.kind === "apply-ready"
        ? `${plural(lead.count, "role is", "roles are")} ready to apply`
        : lead.kind === "decide"
          ? `${plural(lead.count, "scored role needs", "scored roles need")} your decision`
          : `${plural(lead.count, "new role", "new roles")} ${sinceDay ? "since your last visit" : "this week"}`
    : null;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 max-sm:pb-24">
      <section className="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-9 max-sm:px-4 max-sm:py-6 md:px-10 md:py-10">
        <div>
          <h1 className={`${instrumentSerif.className} text-balance text-4xl leading-[1.05] text-landing max-sm:text-[2rem] md:text-5xl`}>
            {leadHeadline ? (
              leadHeadline
            ) : heroState === "loading" ? (
              <>Your career queue is loading.</>
            ) : heroState === "unavailable" ? (
              <>Some updates are unavailable.</>
            ) : allClear ? (
              <>You&apos;re all caught up.</>
            ) : (
              <>Your queue is waiting.</>
            )}
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted">
            <span className="tabular-nums">{dateLabel}</span>
            {" · "}
            {heroState === "unavailable"
              ? "We couldn't load all of today's updates. Try again."
              : heroState === "queue-partial"
                ? `${missingSources} could not be read, so this may be missing work. What loaded is below.`
                : lead
                  ? "Work down this list. The first row is the next thing to do."
                  : allClear
                    ? "Nothing needs you. The scan state is below, so you can see it ran."
                    : followupsEnabled
                      ? "Your action queue for today — discovery and follow-ups, in one place."
                      : "Your action queue for today, in one place."}
          </p>

          {lookNow.length > 0 && (
            <ol aria-label="Look at this now" className="mt-5 max-w-2xl divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {lookNow.map((item, index) => {
                const row = nowRow(item);
                return (
                  <li key={item.kind}>
                    <Link
                      href={row.href}
                      className={
                        "group flex min-h-[56px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover " +
                        (index === 0 ? "bg-brand-soft/60" : "")
                      }
                    >
                      <span className={"w-10 shrink-0 text-right text-xl font-semibold tabular-nums " + (index === 0 ? "text-brand-text" : "text-foreground")}>
                        {item.count}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">{row.label}</span>
                        {row.detail && <span className="block text-[13px] sm:truncate text-muted">{row.detail}</span>}
                      </span>
                      {index === 0 && <span className="shrink-0 rounded-full bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground max-sm:hidden">Start here</span>}
                      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-brand-text" />
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="mt-5 flex flex-wrap gap-2.5">
            <Link
              href="/explore"
              className={
                "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition max-sm:min-h-[44px] " +
                (lead ? "border border-border text-foreground hover:border-brand/40 hover:text-brand-text" : "bg-brand text-brand-foreground hover:bg-brand-200")
              }
            >
              Find new roles <ArrowRight className="size-4" />
            </Link>
            <Link href="/pipeline" className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand-text max-sm:min-h-[44px]">
              Open pipeline
            </Link>
          </div>
          <QuickEvaluate />
        </div>
      </section>

      {dataError && !dataLoading && (
        <div role="alert" className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-5 py-4 text-sm text-muted">
          <p>{missingSources} could not be loaded.</p>
          <button type="button" onClick={refetch} className="font-medium text-brand-text hover:underline">Retry updates</button>
        </div>
      )}

      {/* A. Follow-ups due (demand loop) */}
      {followupsLoading ? (
        <FollowupsDueSectionSkeleton />
      ) : followupsError ? (
        null
      ) : dueFollowups.length > 0 ? (
        <Section icon={Bell} title="Follow-ups due" hint="Keep your applications alive — a nudge beats silence">
          <div className="grid gap-2.5">
            {dueFollowups.map((f) => (
              // Refetch (not a local decrement) so the parent's followups/upcoming
              // stay in sync with the server. Logging the LAST due item must flip this
              // section over to "Upcoming" instead of leaving it empty.
              <FollowUpCard key={`${f.num}-${f.company}`} followup={f} onLogged={refetch} />
            ))}
          </div>
          {followupRest.hidden > 0 && (
            <Link href="/followups" className="mt-3 inline-flex items-center text-sm text-muted transition hover:text-brand-text max-sm:min-h-[44px]">
              See all {followupRest.total} {followupRest.total === 1 ? "follow-up" : "follow-ups"}
            </Link>
          )}
        </Section>
      ) : null}

      {!followupsLoading && !followupsError && upcoming.length > 0 && (
        <Section icon={Bell} title="Upcoming" hint="Not due yet">
          <ul className="grid gap-2">
            {upcoming.map((item) => (
              <li key={`${item.num ?? item.company}-${item.nextFollowupDate ?? ""}`}>
                <Link
                  href={item.num != null ? `/pipeline/${item.num}` : "/followups"}
                  className="text-sm text-muted hover:text-brand-text"
                >
                  <span className="font-medium text-foreground">{item.company}</span>
                  {item.role ? <span> · {item.role}</span> : null}
                  {item.nextFollowupDate ? <span className="text-faint"> · {item.nextFollowupDate}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* B. Awaiting your decision */}
      {awaiting.length > 0 && (
        <Section id="decide" icon={CircleHelp} title="Awaiting your decision" hint="Best score first">
          {applyTarget && (
            <ApplyNext
              n={applyTarget.n}
              company={companyPresentation(applyTarget).label}
              score={applyTarget.score}
              pdfOnDisk={applyFacts[applyTarget.n]?.pdfOnDisk ?? false}
              postingUrl={applyFacts[applyTarget.n]?.postingUrl ?? ""}
            />
          )}
          {awaitingGroups.map(([label, group]) => (
            <div key={label} className="mb-3">
              <h3 className="mb-2 text-xs font-medium text-faint">{label}</h3>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {group.map((a) => (
                  <DecisionCard
                    key={a.n}
                    app={a}
                    reason={reasons[a.n]}
                    onDecided={(status) => {
                      const company = companyPresentation(a).label;
                      setDecisionUndo({ n: a.n, label: status === "Applied" ? `Marked ${company} applied` : `Skipped ${company}` });
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* C. Fresh matches this week (supply loop) */}
      {!freshError && fresh.length > 0 && (
        <Section icon={Sparkles} title="Fresh matches this week" hint="Found by your free scans · 0 tokens">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {fresh.slice(0, 6).map((o) => (
              <DiscoveryCard key={o.url} offer={o} inPipeline={inboxUrls.has(o.url)} />
            ))}
          </div>
          {fresh.length > 6 && (
            <Link href="/explore?view=fresh" className="mt-3 inline-flex items-center text-sm text-muted transition hover:text-brand-text max-sm:min-h-[44px]">
              See all {freshCount} →
            </Link>
          )}
        </Section>
      )}

      {allClear && upcoming.length === 0 && (
        <div className="mt-8 rounded-2xl border border-border bg-surface/30 px-6 py-10 text-center">
          <Sparkles className="mx-auto size-6 text-brand-text" />
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Nothing needs you right now. Run a <Link href="/explore" className="text-brand-text hover:underline">free scan</Link> to surface this week&apos;s roles, or check your <Link href="/pipeline" className="text-brand-text hover:underline">pipeline</Link>.
          </p>
        </div>
      )}

      <LinkedInPaste />

      {decisionUndo && (
        <div className="fixed inset-x-0 bottom-32 z-40 flex justify-center px-4 sm:bottom-6">
          <div className="inline-flex max-w-full flex-wrap items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-2 text-sm shadow-lg">
            <div className="min-w-0 flex-1 break-words">
              <span className="text-muted" role="status">{decisionUndo.label}</span>
              {decisionUndo.error && <p role="alert" className="text-red-700 dark:text-red-400">{decisionUndo.error}</p>}
            </div>
            <button type="button" onClick={() => void undoDecision(decisionUndo)} disabled={decisionUndo.busy} aria-busy={Boolean(decisionUndo.busy)} className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-text disabled:opacity-50 max-sm:min-h-[44px]">
              <Undo2 className="size-3.5" /> {decisionUndo.busy ? "Undoing…" : decisionUndo.error ? "Retry undo" : "Undo"}
            </button>
            {decisionUndo.error && (
              <button type="button" onClick={() => setDecisionUndo(null)} aria-label="Dismiss" className="inline-flex shrink-0 items-center text-faint hover:text-muted max-sm:min-h-[44px] max-sm:min-w-[44px] max-sm:justify-center">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ id, icon: Icon, title, hint, children }: { id?: string; icon: React.ComponentType<{ className?: string }>; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-20">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-brand-text" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
        <span className="text-xs text-faint">· {hint}</span>
      </div>
      {children}
    </section>
  );
}
