import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { QaEvent } from "../src/shared/contract.ts";
import { applyEvent, emptySummary, journeyOf, recordingStart, runState, type Run } from "../src/shared/summary.ts";
import { pipelineFor, WORKFLOW_LABEL } from "../src/shared/pipeline.ts";
import { PHASES, type Narrator } from "../src/shared/narrate.ts";
import { caseOf, fileUrl, narration, runEvents, runsList, STATIC, useStore, type CatalogCase } from "./data.ts";
import { ago, clock, Chip, Counters, day, Feed, fmtDuration, fmtUsd, link, Pipeline, Placeholder, rel, Steps, useNow, Vnc, type StepMap } from "./ui.tsx";

const IMG = /\.(png|jpe?g|webp|gif)$/i;
const VID = /\.(mp4|webm)$/i;

/** The run whose screen and agent we show for a journey: the latest one that does real work. */
function screenRun(journey: Run[]): Run {
  const working = journey.filter((r) => r.info.workflow !== "intake" && (r.info.vnc || r.summary.stages.env || r.summary.stages.agent || r.summary.agent));
  return (working.length ? working : journey).reduce((a, b) => ((b.summary.started ?? "") > (a.summary.started ?? "") ? b : a));
}

function journeyTitle(run: Run, c?: CatalogCase) {
  if (c) return c.title;
  if (run.info.title) return String(run.info.title);
  const wf = WORKFLOW_LABEL[run.info.workflow ?? ""] ?? "Run";
  if (run.info.workflow === "regression") return `${wf} on ${run.info.target === "erp-new" ? "the migrated ERP" : "the ERP"}${run.info.mode === "migration" ? ", with data comparison" : ""}`;
  return `${wf} ${run.id}`;
}

function Head({ run, journey, c }: { run: Run; journey: Run[]; c?: CatalogCase }) {
  const pr = run.info.pr ?? journey.find((r) => r.info.pr)?.info.pr;
  const repo = run.info.repo ?? journey.find((r) => r.info.repo)?.info.repo;
  const caseId = run.info.case ?? journey.find((r) => r.info.case)?.info.case;
  // What the agent was allowed to know about each system (policy/agent-access.yaml), from the author run.
  const access = (run.info.access ?? journey.find((r) => r.info.access)?.info.access);
  const fromScratch = !!(run.info.from_scratch ?? journey.find((r) => r.info.from_scratch)?.info.from_scratch);
  return (
    <header class="run-head">
      <div class="kicker">
        {(c?.id ?? caseId) && <span class="case-id">{c?.id ?? caseId}</span>}
        {c?.process && <span>{c.process}</span>}
        {access
          ? Object.entries(access).map(([s, a]) => (
              <Chip key={s} kind={a === "source access" ? "sys code" : "sys box"}>
                <span title={a === "source access" ? "The agent can read this system's source code (built in-house)" : "Commercial system: the agent uses only its screens and documented API"}>
                  {s} · {a}
                </span>
              </Chip>
            ))
          : c?.chips.map((s) => <Chip key={s} kind="sys">{s}</Chip>)}
        {fromScratch && (
          <Chip kind="sys box">
            <span title="The agent had no existing tests to learn from: only the case and the screens">no prior tests</span>
          </Chip>
        )}
        {pr && (repo ? <a href={`https://github.com/${repo}/pull/${pr}`} target="_blank" rel="noreferrer">PR #{pr}</a> : <span>PR #{pr}</span>)}
        <span class="dim">{WORKFLOW_LABEL[run.info.workflow ?? ""] ?? run.info.workflow ?? "Run"}{run.info.skill ? ` with ${run.info.skill}` : ""}</span>
        <span class="dim">{day(run.summary.started)} {clock(run.summary.started)}</span>
      </div>
      <h1>{journeyTitle(run, c)}</h1>
      <Pipeline nodes={pipelineFor(journey)} />
    </header>
  );
}

function images(run: Run, upTo = Infinity) {
  return Object.entries(run.summary.files)
    .filter(([n, f]) => IMG.test(n) && Date.parse(f.ts) <= upTo)
    .sort((a, b) => a[1].ts.localeCompare(b[1].ts));
}
function video(run: Run) {
  const vids = Object.entries(run.summary.files).filter(([n]) => VID.test(n));
  return vids.find(([n]) => /^screen\./.test(n)) ?? vids[0];
}

function lastAction(n: Narrator, upTo = Infinity) {
  for (let i = n.items.length - 1; i >= 0; i--) {
    const it = n.items[i];
    if (it.t <= upTo && (it.kind === "tool" || it.kind === "subagent") && it.tone !== "quiet") return it;
  }
  return undefined;
}
function pageAt(n: Narrator, upTo = Infinity) {
  for (let i = n.items.length - 1; i >= 0; i--) if (n.items[i].t <= upTo && n.items[i].page) return n.items[i].page;
  return undefined;
}

function Still({ run, n, upTo, note }: { run: Run; n?: Narrator; upTo?: number; note?: string }) {
  const img = images(run, upTo).at(-1);
  if (img) return <img class="still" src={fileUrl(img[1].url)} alt={`Screenshot ${img[0]}`} />;
  const act = n && lastAction(n, upTo);
  return <Placeholder page={n && pageAt(n, upTo)} action={act?.text} note={note} />;
}

function RunLayout(p: { head: ComponentChildren; screen: ComponentChildren; under?: ComponentChildren; counters: ComponentChildren; feed: ComponentChildren; steps: ComponentChildren }) {
  return (
    <div class="run-view">
      {p.head}
      <section class="screen-col">
        <div class="screen">{p.screen}</div>
        {p.under}
      </section>
      <aside class="feed-col" aria-label="What the agent is doing">
        <div class="feed-head"><h2>Agent</h2>{p.counters}</div>
        {p.feed}
      </aside>
      <div class="steps-row">{p.steps}</div>
    </div>
  );
}

function Empty({ children }: { children: ComponentChildren }) {
  return <div class="empty-view">{children}</div>;
}

// ---------- Live ----------
export function Live({ id }: { id?: string }) {
  const s = useStore();
  const now = useNow();
  const runs = runsList();
  const focus = (id && s.runs.get(id)) ||
    runs.find((r) => runState(r, now) === "running" && (r.info.vnc || r.summary.stages.agent)) ||
    runs.find((r) => runState(r, now) === "running") || runs[0];
  if (!s.loaded) return <Empty><p>Loading…</p></Empty>;
  if (!focus) return <Empty><h1>No runs yet</h1><p>When n8n, CI or an agent sends events to <code>/api/events</code>, the journey appears here live.</p></Empty>;
  const journey = journeyOf(focus, runs);
  const run = screenRun(journey);
  const c = caseOf(run.info.case ?? focus.info.case);
  const events = runEvents(run.id) ?? [];
  const n = narration(run.id, events);
  const t0 = n.totals.startedAt ?? (Date.parse(run.summary.started ?? "") || now);
  const ended = n.totals.endedAt ?? (run.summary.ended ? Date.parse(run.summary.ended) : undefined);
  const running = runState(run, now) === "running";
  // The agent's own figure once it has finished; the wall clock while it works.
  const elapsed = n.totals.durationMs ?? ((ended ?? (running ? now : Date.parse(run.summary.updated ?? "") || now)) - t0);
  const still = <Still run={run} n={n} />;
  return (
    <RunLayout
      head={<Head run={run} journey={journey} c={c} />}
      screen={run.info.vnc && running ? <Vnc url={String(run.info.vnc)} fallback={still} /> : still}
      under={
        <div class="screen-foot">
          <span class={`state ${runState(run, now)}`}>{running ? "Running" : run.summary.verdict === "fail" ? "Finished: failed" : run.summary.verdict === "ok" ? "Finished: passed" : "Paused"}</span>
          {!running && events.length > 0 && <a href={`/runs/${encodeURIComponent(run.id)}`} onClick={link(`/runs/${encodeURIComponent(run.id)}`)}>Open the replay</a>}
          {run.info.novnc && running && <a href={String(run.info.novnc)} target="_blank" rel="noreferrer">Open the screen in a new window</a>}
        </div>
      }
      counters={<Counters elapsed={elapsed} steps={n.totals.steps} cost={n.totals.costUsd ?? run.summary.agent?.costUsd} turns={n.totals.turns} />}
      feed={<Feed narrator={n} t0={t0} live />}
      steps={<Steps c={c} steps={run.summary.steps as StepMap} />}
    />
  );
}

// ---------- Replay ----------
function foldUpTo(run: Run, events: QaEvent[], t: number): Run {
  const r: Run = { id: run.id, info: { ...run.info }, summary: emptySummary() };
  for (const e of events) if (Date.parse(e.ts) <= t) applyEvent(r, e);
  return r;
}

export function Replay({ id }: { id: string }) {
  const s = useStore();
  const run = s.runs.get(id);
  const events = runEvents(id);
  if (!s.loaded || (!events && run)) return <Empty><p>Loading the run…</p></Empty>;
  if (!run || !events) return <Empty><h1>Run {id} not found</h1><p><a href="/overview" onClick={link("/overview")}>Back to the overview</a></p></Empty>;
  return <ReplayInner run={run} events={events} />;
}

const SPEEDS = [1, 2, 4, 8, 16];
function ReplayInner({ run, events }: { run: Run; events: QaEvent[] }) {
  const s = useStore();
  const n = narration(run.id, events);
  const times = events.map((e) => Date.parse(e.ts));
  const t0 = Math.min(...times, n.totals.startedAt ?? Infinity);
  const t1 = Math.max(...times, n.totals.endedAt ?? 0, t0 + 1000);
  const vid = video(run);
  const vStart = Date.parse(recordingStart(run) ?? "") || t0;
  const [ph, setPh] = useState(t0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(vid ? 1 : 4);
  const [vDur, setVDur] = useState(0);
  const vRef = useRef<HTMLVideoElement>(null);
  const phRef = useRef(ph);
  phRef.current = ph;

  useEffect(() => {
    if (!playing) { vRef.current?.pause(); return; }
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      let next = phRef.current + dt * speed;
      const v = vRef.current;
      const inVideo = v && vDur && next >= vStart && next <= vStart + vDur * 1000;
      if (v && inVideo) {
        v.playbackRate = Math.min(speed, 16);
        if (v.paused) v.play().catch(() => {});
        const want = (next - vStart) / 1000;
        if (Math.abs(v.currentTime - want) > 0.4) v.currentTime = want;
        else next = vStart + v.currentTime * 1000;
      } else if (v && !v.paused) v.pause();
      if (next >= t1) { next = t1; setPlaying(false); }
      setPh(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, vDur]);

  const seek = (t: number) => {
    const v = Math.max(t0, Math.min(t1, t));
    setPh(v);
    const el = vRef.current;
    if (el && vDur) el.currentTime = Math.max(0, Math.min(vDur, (v - vStart) / 1000));
  };

  const atPh = useMemo(() => foldUpTo(run, events, ph), [run.id, events.length, Math.floor(ph / 250)]);
  const others = journeyOf(run, runsList()).filter((r) => r.id !== run.id);
  const c = caseOf(run.info.case);
  const inVideo = vid && vDur > 0 && ph >= vStart && ph <= vStart + vDur * 1000;
  const doneItems = n.items.filter((i) => i.t <= ph);
  const marks = useMemo(() => {
    const out: { t: number; cls: string; title: string }[] = [];
    let phase: string | undefined;
    for (const it of n.items) {
      if (it.phase !== phase) { phase = it.phase; out.push({ t: it.t, cls: "phz", title: PHASES[it.phase] }); }
      if (it.tone === "fail" || it.tone === "ok") out.push({ t: it.t, cls: it.tone, title: it.text });
    }
    for (const e of events) if (e.kind === "stage" && e.status !== "start") out.push({ t: Date.parse(e.ts), cls: e.status === "fail" ? "fail" : "stage", title: `${e.stage}: ${e.status}` });
    return out;
  }, [n.version, events.length]);
  const pct = (t: number) => `${((t - t0) / (t1 - t0)) * 100}%`;

  return (
    <RunLayout
      head={<Head run={atPh} journey={[...others, atPh]} c={c} />}
      screen={
        <>
          {vid && (
            <video ref={vRef} class="video" src={fileUrl(vid[1].url)} muted playsInline preload="auto"
              style={{ visibility: inVideo ? "visible" : "hidden" }}
              onLoadedMetadata={(e) => setVDur((e.currentTarget as HTMLVideoElement).duration || 0)} />
          )}
          {!inVideo && <div class="still-wrap"><Still run={run} n={n} upTo={ph} note={vid ? (ph < vStart ? "The screen recording starts later" : "The screen recording has ended") : undefined} /></div>}
        </>
      }
      under={
        <div class="scrubber">
          <button class="play" onClick={() => { if (ph >= t1) seek(t0); setPlaying(!playing); }} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
              : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2v11.6a.6.6 0 0 0 .9.5l9.2-5.8a.6.6 0 0 0 0-1L4.9 1.7a.6.6 0 0 0-.9.5z" /></svg>}
          </button>
          <div class="track">
            {vid && vDur > 0 && <span class="vband" style={{ left: pct(vStart), width: `calc(${pct(vStart + vDur * 1000)} - ${pct(vStart)})` }} title="Screen recording" />}
            {marks.map((m, i) => <span key={i} class={`tick ${m.cls}`} style={{ left: pct(m.t) }} title={m.title} />)}
            <span class="fill" style={{ width: pct(ph) }} />
            <input type="range" min={t0} max={t1} step={100} value={ph} aria-label="Position in the run" onInput={(e) => seek(Number((e.currentTarget as HTMLInputElement).value))} />
          </div>
          <span class="tc">{rel(ph - t0)} <span class="dim">/ {rel(t1 - t0)}</span></span>
          <select value={speed} aria-label="Speed" onChange={(e) => setSpeed(Number((e.currentTarget as HTMLSelectElement).value))}>
            {SPEEDS.map((x) => <option key={x} value={x}>{x}×</option>)}
          </select>
        </div>
      }
      counters={<Counters elapsed={n.totals.endedAt && ph >= n.totals.endedAt && n.totals.durationMs ? n.totals.durationMs : Math.min(ph, n.totals.endedAt ?? t1) - (n.totals.startedAt ?? t0)}steps={doneItems.filter((i) => i.kind === "tool" || i.kind === "subagent").length}
        cost={n.totals.endedAt && ph >= n.totals.endedAt ? n.totals.costUsd : undefined} turns={n.totals.endedAt && ph >= n.totals.endedAt ? n.totals.turns : undefined} />}
      feed={<Feed narrator={n} t0={n.totals.startedAt ?? t0} playhead={ph} onSeek={seek} />}
      steps={<Steps c={c ?? (STATIC ? s.catalog[0] : undefined)} steps={atPh.summary.steps as StepMap} />}
    />
  );
}

// ---------- Overview ----------
type CaseStatus = "automated" | "running" | "pending" | "failed";
const STATUS_ORDER: CaseStatus[] = ["running", "failed", "pending", "automated"];

export function Overview() {
  const s = useStore();
  const now = useNow(true, 15_000);
  const runs = runsList();
  const byCase = new Map<string, Run[]>();
  for (const r of runs) if (r.info.case) byCase.set(r.info.case, [...(byCase.get(r.info.case) ?? []), r]);

  const rows = s.catalog.map((c) => {
    const rs = byCase.get(c.id) ?? [];
    const live = rs.some((r) => runState(r, now) === "running");
    const last = rs.find((r) => r.summary.verdict !== "running" || r.summary.ended);
    const status: CaseStatus = live ? "running" : last?.summary.verdict === "fail" ? "failed" : c.tests.length ? "automated" : "pending";
    return { c, rs, status, last: rs[0] };
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.c.process ?? "No process", [...(groups.get(r.c.process ?? "No process") ?? []), r]);

  const authored = runs.filter((r) => r.summary.agent && (r.info.workflow === "author" || /author/.test(String(r.info.skill ?? ""))));
  const costs = authored.map((r) => r.summary.agent!.costUsd).filter((x): x is number => typeof x === "number");
  const durs = authored.map((r) => r.summary.agent!.durationMs).filter((x): x is number => typeof x === "number");
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  const avgCost = avg(costs), avgDur = avg(durs);
  const inCatalog = s.catalog.filter((c) => !c.draft).length;
  const automated = s.catalog.filter((c) => c.tests.length).length;
  const pending = rows.filter((r) => !r.c.tests.length).length;

  return (
    <div class="overview">
      <section class="ledger" aria-label="Figures">
        <div class="fig"><span class="v">{inCatalog}</span><span class="k">cases in the catalog{s.catalog.length > inCatalog ? `, plus ${s.catalog.length - inCatalog} in draft` : ""}</span></div>
        <div class="fig"><span class="v ok">{automated}</span><span class="k">automated, with a test</span></div>
        <div class="fig"><span class="v">{avgCost != null ? fmtUsd(avgCost) : "—"}</span><span class="k">average agent cost per case</span></div>
        <div class="fig"><span class="v">{avgDur != null ? fmtDuration(avgDur) : "—"}</span><span class="k">average authoring time</span></div>
        {pending > 0 && avgCost != null && avgDur != null && (
          <p class="projection">
            Automating {pending === 1 ? "the pending case" : `the ${pending} pending cases`} would cost about <strong>{fmtUsd(avgCost * pending)}</strong> in agent usage and
            {" "}<strong>{fmtDuration(avgDur * pending)}</strong> of machine time, plus one person's review per case.
          </p>
        )}
      </section>

      <section class="catalog" aria-label="Case catalog">
        <h2>Case catalog</h2>
        {!s.catalog.length && <p class="dim">No cases in the mounted catalog (CATALOG_DIR).</p>}
        {[...groups.entries()].map(([process, list]) => (
          <div class="group" key={process}>
            <h3>{process}</h3>
            <ul>
              {list.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.c.id.localeCompare(b.c.id)).map(({ c, status, last }) => {
                const href = last ? (status === "running" ? `/live/${encodeURIComponent(last.id)}` : `/runs/${encodeURIComponent(last.id)}`) : undefined;
                return (
                  <li class={`case st-${status}`} key={c.id}>
                    <span class="cid">{c.id}</span>
                    <span class="ctitle">{c.title}{c.draft && <em> (draft)</em>}</span>
                    <span class="csys">{c.chips.map((x) => <Chip key={x} kind="sys">{x}</Chip>)}</span>
                    <span class="cstatus"><span class={`pill ${status}`}>{status}</span></span>
                    <span class="clast">{href ? <a href={href} onClick={link(href)}>{status === "running" ? "Watch live" : `Last run ${ago(last!.summary.updated, now)}`}</a> : <span class="dim">No runs</span>}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <section class="recent" aria-label="Recent runs">
        <h2>Recent runs</h2>
        {!runs.length && <p class="dim">No runs recorded yet.</p>}
        <table>
          <thead><tr><th>Run</th><th>Case</th><th>Result</th><th class="hide-sm">Started</th><th class="num">Duration</th><th class="num hide-sm">Cost</th></tr></thead>
          <tbody>
            {runs.slice(0, 25).map((r) => {
              const st = runState(r, now);
              const href = st === "running" ? `/live/${encodeURIComponent(r.id)}` : `/runs/${encodeURIComponent(r.id)}`;
              const dur = r.summary.agent?.durationMs ?? (r.summary.started && (r.summary.ended || r.summary.updated) ? Date.parse(r.summary.ended ?? r.summary.updated!) - Date.parse(r.summary.started) : undefined);
              return (
                <tr key={r.id}>
                  <td><a href={href} onClick={link(href)}>{WORKFLOW_LABEL[r.info.workflow ?? ""] ?? r.info.workflow ?? "Run"}</a> <span class="dim mono">{r.id}</span></td>
                  <td>{r.info.case ?? <span class="dim">—</span>}</td>
                  <td><span class={`pill v-${st === "ok" && !r.summary.stages.prove ? "done" : st}`}>{{ running: "running", ok: r.summary.stages.prove ? "passed" : "done", fail: "failed", warn: r.summary.resultTitle === "Cancelled" ? "cancelled" : "warnings", idle: "idle" }[st]}</span></td>
                  <td class="hide-sm">{ago(r.summary.started, now)}</td>
                  <td class="num">{dur != null ? fmtDuration(dur) : "—"}</td>
                  <td class="num hide-sm">{r.summary.agent?.costUsd != null ? fmtUsd(r.summary.agent.costUsd) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
