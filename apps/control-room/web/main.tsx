import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "@fontsource/barlow-semi-condensed/latin-500.css";
import "@fontsource/barlow-semi-condensed/latin-600.css";
import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-500.css";
import "@fontsource/barlow/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import { runState } from "../src/shared/summary.ts";
import { WORKFLOW_LABEL } from "../src/shared/pipeline.ts";
import { runsList, start, STATIC, useStore } from "./data.ts";
import { ago, link } from "./ui.tsx";
import { Live, Overview, Replay } from "./views.tsx";

type Route = { view: "live"; id?: string } | { view: "overview" } | { view: "replay"; id: string };
function route(): Route {
  if (STATIC) return { view: "replay", id: STATIC.run };
  const p = location.pathname;
  let m = /^\/runs\/([^/]+)/.exec(p);
  if (m) return { view: "replay", id: decodeURIComponent(m[1]) };
  m = /^\/live\/([^/]+)/.exec(p);
  if (m) return { view: "live", id: decodeURIComponent(m[1]) };
  if (p.startsWith("/overview")) return { view: "overview" };
  return { view: "live" };
}

function RunPicker({ current }: { current?: string }) {
  const runs = runsList().slice(0, 40);
  if (!runs.length) return null;
  const label = (r: (typeof runs)[number]) =>
    `${r.info.case ? `${r.info.case}, ` : ""}${WORKFLOW_LABEL[r.info.workflow ?? ""] ?? r.info.workflow ?? r.id}${runState(r) === "running" ? " (running)" : `, ${ago(r.summary.updated)}`}`;
  return (
    <label class="picker">
      <span class="sr">Run</span>
      <select value={current ?? ""} onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; link(v ? `/live/${encodeURIComponent(v)}` : "/")(new MouseEvent("click")); }}>
        <option value="">Latest running</option>
        {runs.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
      </select>
    </label>
  );
}

function App() {
  const [r, setR] = useState(route());
  const s = useStore();
  useEffect(() => {
    start();
    const on = () => setR(route());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  useEffect(() => {
    document.title = r.view === "overview" ? "Overview · Control room" : r.view === "replay" ? `Replay ${r.id} · Control room` : "Live · Control room";
  }, [r]);
  return (
    <div class={`app view-${r.view}`}>
      <header class="bar">
        <a class="brand" href={STATIC ? undefined : "/"} onClick={STATIC ? undefined : link("/")}>
          <span class="strip" aria-hidden="true" /><span class="label">Control room</span>
        </a>
        {!STATIC && (
          <nav>
            <a href="/" onClick={link("/")} aria-current={r.view === "live" ? "page" : undefined}>Live</a>
            <a href="/overview" onClick={link("/overview")} aria-current={r.view === "overview" ? "page" : undefined}>Overview</a>
            {r.view === "replay" && <a aria-current="page">Replay</a>}
          </nav>
        )}
        {STATIC && <span class="static-note">Replay of run {STATIC.run}</span>}
        <div class="bar-right">
          {r.view === "live" && <RunPicker current={r.id} />}
          {!STATIC && <span class={`conn ${s.connected ? "on" : "off"}`} title={s.connected ? "Receiving events" : "No connection to the server"}>{s.connected ? "Connected" : "Offline"}</span>}
        </div>
      </header>
      <main>
        {r.view === "live" && <Live id={r.id} />}
        {r.view === "overview" && <Overview />}
        {r.view === "replay" && <Replay id={r.id} />}
      </main>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
