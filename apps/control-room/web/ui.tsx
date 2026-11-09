// Building blocks shared by the live and replay views.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { PHASES, fmtDuration, fmtUsd, type Item, type Narrator, type Page } from "../src/shared/narrate.ts";
import type { Node } from "../src/shared/pipeline.ts";
import type { CatalogCase } from "./data.ts";

// ---------- formatting ----------
export function rel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
export const clock = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "");
export const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
export function ago(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${day(iso)}, ${clock(iso)}`;
}
export { fmtDuration, fmtUsd };

export function useNow(active = true, every = 1000) {
  const [now, set] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

export function link(path: string) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  };
}

// ---------- pipeline ----------
export function Pipeline({ nodes }: { nodes: Node[] }) {
  const current = nodes.reduce((acc, n, i) => (n.state ? i : acc), -1);
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // On narrow screens the line scrolls: keep the stage being worked on in view.
    const ol = ref.current, li = ol?.children[current] as HTMLElement | undefined;
    if (ol && li && ol.scrollWidth > ol.clientWidth) ol.scrollLeft = li.offsetLeft - ol.offsetLeft - ol.clientWidth / 3;
  }, [current]);
  return (
    <ol class="pipeline" aria-label="Case journey" ref={ref}>
      {nodes.map((n, i) => {
        const st = n.state?.status;
        const cls = st === "fail" ? "fail" : st === "warn" ? "warn" : st === "start" ? "live" : st ? "done" : "todo";
        const nextDone = nodes.slice(i + 1).some((x) => x.state);
        return (
          <li class={`node ${cls} ${i === current ? "current" : ""} ${nextDone ? "passed" : ""}`} key={n.key}>
            <span class="rail" aria-hidden="true" />
            <span class="dot" aria-hidden="true" />
            <span class="label">{n.label}</span>
            <span class="when">
              {st === "start" ? "running" : st === "fail" ? "failed" : st === "warn" ? "warnings" : st ? clock(n.state?.ts) : ""}
            </span>
            {n.state?.title && n.state.title !== n.label && <span class="note">{n.state.title}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- counters ----------
export function Counters({ elapsed, steps, cost, turns }: { elapsed: number; steps: number; cost?: number; turns?: number }) {
  return (
    <dl class="counters">
      <div><dt>Time</dt><dd>{rel(elapsed)}</dd></div>
      <div><dt>Steps</dt><dd>{steps}</dd></div>
      <div><dt>Cost</dt><dd>{cost != null ? fmtUsd(cost) : turns != null ? "—" : "…"}</dd></div>
    </dl>
  );
}

// ---------- feed ----------
function Report({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) =>
      p.startsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : p);
  return (
    <div class="report">
      {text.split(/\n{2,}/).flatMap((block, i) => {
        // A block can mix a lead-in line with list items: group consecutive "- " lines.
        const out: ComponentChildren[] = [];
        let list: string[] = [];
        const flushList = (k: string) => { if (list.length) out.push(<ul key={k}>{list.map((l, j) => <li key={j}>{inline(l)}</li>)}</ul>); list = []; };
        block.split("\n").forEach((l, j) => {
          if (/^\s*([-*]|\d+\.) /.test(l)) list.push(l.replace(/^\s*([-*]|\d+\.) /, ""));
          else if (list.length && /^\s{2,}\S/.test(l)) list[list.length - 1] += ` ${l.trim()}`;
          else { flushList(`${i}u${j}`); if (l.trim()) out.push(/^#+\s/.test(l) ? <h4 key={`${i}h${j}`}>{inline(l.replace(/^#+\s*/, ""))}</h4> : <p key={`${i}p${j}`}>{inline(l)}</p>); }
        });
        flushList(`${i}u`);
        return out;
      })}
    </div>
  );
}

function rawOf(it: Item): string {
  const parts: string[] = [];
  if (it.tool) parts.push(`${it.tool}\n${JSON.stringify(it.raw?.input ?? {}, null, 2)}`);
  if (it.raw?.result) parts.push(`${it.raw.error ? "— error —" : "— result —"}\n${it.raw.result.slice(0, 4000)}`);
  return parts.join("\n\n");
}

function Mark({ it }: { it: Item }) {
  const s = it.status;
  if (s === "running") return <span class="mark run" title="In progress" />;
  if (it.tone === "fail" || s === "fail") return <span class="mark fail" title="Failed">✕</span>;
  if (it.tone === "warn" || s === "warn") return <span class="mark warn" title="Warning">!</span>;
  if (it.tone === "ok") return <span class="mark ok" title="Verified">✓</span>;
  return <span class="mark" />;
}

export function Feed({ narrator, t0, playhead, onSeek, live }: { narrator: Narrator; t0: number; playhead?: number; onSeek?: (t: number) => void; live?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const items = narrator.items;
  const currentIdx = playhead == null ? -1 : items.reduce((acc, it, i) => (it.t <= playhead ? i : acc), -1);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (live && stick.current) el.scrollTop = el.scrollHeight;
    if (playhead != null && currentIdx >= 0) {
      const row = el.querySelector<HTMLElement>(`[data-i="${currentIdx}"]`);
      if (row) {
        const top = row.offsetTop - el.offsetTop;
        if (top < el.scrollTop + 40 || top > el.scrollTop + el.clientHeight - 80) el.scrollTo({ top: top - el.clientHeight / 3, behavior: "smooth" });
      }
    }
  }, [items.length, narrator.version, currentIdx]);

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  let phase: string | undefined;
  return (
    <div class="feed" ref={box} onScroll={(e) => { const el = e.currentTarget as HTMLElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
      {!items.length && <p class="empty">The agent has not started yet. Its steps appear here as it takes them.</p>}
      <ol>
        {items.map((it, i) => {
          const header = it.phase !== phase ? (phase = it.phase) : null;
          const future = playhead != null && it.t > playhead;
          const cls = `it ${it.kind} tone-${it.tone} ${it.sub ? "sub" : ""} ${i === currentIdx ? "now" : ""} ${future ? "future" : ""} ${onSeek ? "seekable" : ""}`;
          return [
            header && <li class="phase" key={`ph-${i}`}><span>{PHASES[it.phase]}</span><time>{rel(it.t - t0)}</time></li>,
            <li class={cls} key={it.id} data-i={i} onClick={() => (onSeek ? onSeek(it.t) : it.kind !== "report" && toggle(it.id))}>
              <time>{rel(it.t - t0)}</time>
              <Mark it={it} />
              <div class="body">
                {it.sub && it.sub !== items[i - 1]?.sub && <p class="who">{it.sub}</p>}
                {it.kind === "report" ? <Report text={it.text} /> : <p class="txt">{it.text}</p>}
                {it.detail && <p class="det">{it.detail}</p>}
                {open.has(it.id) && <pre class="raw">{rawOf(it)}</pre>}
              </div>
              {(it.tool || it.raw?.result) && it.kind !== "report" && (
                <button class="rawbtn" aria-expanded={open.has(it.id)} title="Show the original call" onClick={(e) => { e.stopPropagation(); toggle(it.id); }}>
                  {"{ }"}
                </button>
              )}
            </li>,
          ];
        })}
      </ol>
    </div>
  );
}

// ---------- business steps ----------
export type StepMap = Record<string, { status: string; ts: string; screenshot?: string; detail?: string }>;
export function Steps({ c, steps }: { c?: CatalogCase; steps: StepMap }) {
  const caseSteps = c?.steps ?? [];
  const extra = Object.keys(steps).filter((k) => !/^\d+$/.test(k) && !caseSteps.some((p) => p === k || p.startsWith(k)));
  if (!caseSteps.length && !extra.length) return null;
  const stateOf = (i: number, text: string) => steps[String(i + 1)] ?? steps[text] ?? Object.entries(steps).find(([k]) => !/^\d+$/.test(k) && text.startsWith(k))?.[1];
  return (
    <section class="steps" aria-label="Case steps">
      <h2>Case steps</h2>
      <ol>
        {caseSteps.map((p, i) => {
          const s = stateOf(i, p)?.status;
          const cls = s === "ok" ? "ok" : s === "fail" ? "fail" : s === "start" ? "live" : "todo";
          return (
            <li class={cls} key={i}>
              <span class="n">{s === "ok" ? "✓" : s === "fail" ? "✕" : i + 1}</span>
              <span class="t">{p}</span>
            </li>
          );
        })}
        {extra.map((k) => (
          <li class={steps[k].status === "ok" ? "ok" : steps[k].status === "fail" ? "fail" : "todo"} key={k}>
            <span class="n">{steps[k].status === "ok" ? "✓" : steps[k].status === "fail" ? "✕" : "·"}</span>
            <span class="t">{k}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- screen ----------
export function Placeholder({ page, action, note }: { page?: Page; action?: string; note?: string }) {
  return (
    <div class="placeholder">
      <div class="ph-sys">{page?.system ?? "No screen"}</div>
      {page?.title && <div class="ph-title">{page.title}</div>}
      {page?.path && <div class="ph-path">{page.path}</div>}
      {action && <div class="ph-action"><span>Agent's last step</span>{action}</div>}
      {note && <div class="ph-note">{note}</div>}
    </div>
  );
}

export function Vnc({ url, fallback }: { url: string; fallback: ComponentChildren }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "on" | "off">("connecting");
  useEffect(() => {
    let rfb: any;
    let dead = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = async () => {
      const { default: RFB } = await import("@novnc/novnc");
      if (dead || !host.current) return;
      setState("connecting");
      rfb = new RFB(host.current, url, { shared: true });
      rfb.viewOnly = true;
      rfb.scaleViewport = true;
      rfb.background = "#000";
      rfb.addEventListener("connect", () => setState("on"));
      rfb.addEventListener("disconnect", () => { setState("off"); if (!dead) retry = setTimeout(connect, 5000); });
    };
    connect().catch(() => setState("off"));
    return () => { dead = true; clearTimeout(retry); try { rfb?.disconnect(); } catch {} };
  }, [url]);
  return (
    <div class="vnc">
      <div class="vnc-canvas" ref={host} style={{ visibility: state === "on" ? "visible" : "hidden" }} />
      {state !== "on" && <div class="vnc-fallback">{fallback}</div>}
      <span class={`signal ${state}`}>{state === "on" ? "Live" : state === "connecting" ? "Connecting to the screen…" : "No signal from the screen"}</span>
    </div>
  );
}

export function Chip({ children, kind }: { children: ComponentChildren; kind?: string }) {
  return <span class={`chip ${kind ?? ""}`}>{children}</span>;
}
