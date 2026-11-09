// Narration: turns a Claude Code stream-json run into short, plain lines an operations reader can follow,
// keeping the raw call for engineers. Pure and incremental: push() lines as they arrive; a tool line
// is refined when its result comes back (real UI label, pass/fail, errors).
import { shellWords, splitShell } from "./shell.ts";

export type Phase = "explore" | "write" | "test" | "report";
export const PHASES: Record<Phase, string> = { explore: "Explore", write: "Write", test: "Test", report: "Report" };
const ORDER: Phase[] = ["explore", "write", "test", "report"];
export type Tone = "normal" | "quiet" | "warn" | "ok" | "fail";

export interface Page { system: string; url?: string; path?: string; title?: string }
export interface Item {
  id: string;
  t: number;
  phase: Phase;
  kind: "tool" | "text" | "subagent" | "result" | "report" | "note";
  text: string;
  detail?: string;
  tone: Tone;
  status?: "running" | "ok" | "fail" | "warn";
  sub?: string;
  tool?: string;
  raw?: { input?: unknown; result?: string; error?: boolean };
  page?: Page;
}
export interface Totals { steps: number; turns?: number; durationMs?: number; costUsd?: number; isError?: boolean; model?: string; startedAt?: number; endedAt?: number }

// ---------- small helpers ----------
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const q = (s: string) => `“${clip(String(s).trim(), 60)}”`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const lines = (s: unknown) => (typeof s === "string" && s.length ? s.replace(/\n$/, "").split("\n").length : 0);
export function joinList(parts: string[], max = 4): string {
  const list = [...new Set(parts.filter(Boolean))];
  if (list.length > max) return `${list.slice(0, max - 1).join(", ")} and ${list.length - max + 1} more`;
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}
/** Joins clauses that may already contain "and": "a, b, and c" keeps them readable. */
function joinTop(parts: string[], max = 4): string {
  const list = [...new Set(parts.filter(Boolean))].slice(0, max);
  if (list.length > 1 && list.some((p) => / and /.test(p))) return `${list.slice(0, -1).join(", ")}, and ${list.at(-1)}`;
  return joinList(list, max);
}
export function firstSentence(text: string, n = 140): string {
  const t = text.replace(/\s+/g, " ").replace(/[*_`#>]/g, "").trim();
  const m = /^(.+?[.!?:])(\s|$)/.exec(t);
  return clip(m ? m[1] : t, n);
}
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}
export const fmtUsd = (v: number) => `US$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const KEYS: Record<string, string> = { Enter: "Enter", Return: "Enter", Escape: "Esc", Down: "Down arrow", ArrowDown: "Down arrow", Up: "Up arrow", ArrowUp: "Up arrow", Tab: "Tab", BackSpace: "Backspace", Backspace: "Backspace", space: "Space" };
const keyName = (k: string) => KEYS[k] ?? k;

// ---------- systems, paths ----------
export type Hosts = Record<string, string>; // "127.0.0.1:41234" -> "MES"
const SYS_NAME: Record<string, string> = { ERP: "the ERP", "New ERP": "the new ERP", MES: "the MES", L2: "the L2 client", n8n: "n8n", "Control room": "the control room" };
export function systemOf(url: string, hosts: Hosts = {}): string | undefined {
  if (/\$\{?ERP_URL/.test(url)) return "ERP";
  if (/\$\{?MES_URL/.test(url)) return "MES";
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (hosts[u.host]) return hosts[u.host];
  if (u.port === "18069" || /(^|\.)erp(\.|$)/.test(u.hostname) || u.port === "8069") return u.port === "18070" ? "New ERP" : "ERP";
  if (u.port === "18070") return "New ERP";
  if (u.port === "13000" || /(^|[.-])mes([.-]|$)/.test(u.hostname)) return "MES";
  if (u.port === "15678" || u.port === "5678") return "n8n";
  if (u.port === "17000") return "Control room";
  return undefined;
}
const sysName = (s: string | undefined, url: string) => (s ? SYS_NAME[s] ?? s : (() => { try { return new URL(url).host; } catch { return url; } })());

export function describePath(p: string, cwd = ""): string {
  let r = p.trim();
  if (cwd && r.startsWith(cwd + "/")) r = r.slice(cwd.length + 1);
  r = r.replace(/^\.\//, "");
  let m: RegExpExecArray | null;
  if ((m = /^catalog\/cases\/([A-Z]+-\d+)\.ya?ml$/.exec(r))) return `case ${m[1]}`;
  if (r === "catalog/cases" || r === "catalog/cases/*" || r === "catalog") return "the case catalog";
  if ((m = /^docs\/drafts\/cases\/([A-Z]+-\d+)/.exec(r))) return `the draft of case ${m[1]}`;
  if (/^apps\/mes(\/|$)/.test(r)) return /^apps\/mes\/?$/.test(r) ? "the MES source" : `the MES source (${base(r)})`;
  if (/^apps\/l2-desktop(\/|$)/.test(r)) return /[*]|^apps\/l2-desktop\/?$/.test(r) ? "the L2 client source" : `the L2 client source (${base(r)})`;
  if (/^lab\/compose\.ya?ml$/.test(r)) return "the lab configuration";
  if (/^lab(\/|$)/.test(r)) return "the lab";
  if (/^tests\/(e2e|desktop)\/support(\/|$)/.test(r)) return /support\/?$/.test(r) ? "the test support code" : `the test support code (${base(r)})`;
  if (/^tests\/e2e\/seed\.spec\.ts$/.test(r)) return "the tests' starting point (seed)";
  if (/^specs\/README/.test(r)) return "the test plan guide";
  if (/^specs\/.+\.md$/.test(r)) return `the test plan ${r}`;
  if (/^evidence\//.test(r)) return `the evidence ${base(r)}`;
  if (/\.claude\/settings/.test(r)) return "the agent's permission settings";
  if (/(^|\/)package\.json$/.test(r)) return "the dependencies (package.json)";
  if (/playwright\.config/.test(r)) return "the Playwright configuration";
  if (r.startsWith("/")) return base(r);
  return r;
}
const relPath = (p: string, cwd: string) => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p);
const isTestFile = (rel: string) => /(^|\/)tests\//.test(rel) && !/\/support\//.test(rel);
const caseIn = (s: string) => /\b(cp)-?(\d{3})\b/i.exec(s)?.slice(1).join("-").toUpperCase();

// ---------- Playwright locators ----------
const NAMED = /getBy(Role|Text|Label|Placeholder|Title|AltText|TestId)\(\s*(['"`])((?:\\.|(?!\2).)*)\2(?:\s*,\s*\{[^}]*?name:\s*(?:(['"`])((?:\\.|(?!\4).)*)\4|\/((?:\\.|[^/])*)\/))?/g;
function wrapLabel(role: string | undefined, name: string): string {
  const n = name.replace(/\\(.)/g, "$1").replace(/^\^|\$$/g, "");
  if (role === "row") return `the row ${q(n)}`;
  if (role === "cell") return `the cell ${q(n)}`;
  return q(n);
}
/** Human label of the element a Playwright locator/selector points at. */
export function locatorLabel(code: string | undefined): string | undefined {
  if (!code) return undefined;
  for (const m of code.matchAll(NAMED)) {
    if (m[1] === "Role") {
      const name = m[5] ?? m[6];
      if (name) return wrapLabel(m[3], name);
      continue;
    }
    return q(m[3]);
  }
  let m = /role=(\w+)\[name=(?:"([^"]*)"|'([^']*)'|\/([^/]*)\/)/.exec(code);
  if (m) return wrapLabel(m[1], m[2] ?? m[3] ?? m[4]);
  m = /\[(?:title|aria-label|placeholder|name)=["']([^"']+)["']\]/.exec(code);
  if (m) return q(m[1]);
  m = /(?:^|['"])(?:text|title)=["']?([^"'\]]+)/.exec(code);
  if (m) return q(m[1]);
  return undefined;
}
const ranCode = (text: string) => /### Ran Playwright code\s*```\w*\n([\s\S]*?)```/.exec(text)?.[1].trim();

// ---------- tests ----------
export function testOutcome(text: string): { passed: number; failed: number } | null {
  const sum = (re: RegExp) => [...text.matchAll(re)].reduce((a, m) => a + Number(m[1]), 0);
  const pw = { passed: sum(/(\d+) passed/g), failed: sum(/(\d+) failed/g) + sum(/(\d+) flaky/g) };
  const nd = { passed: sum(/ℹ pass (\d+)/g), failed: sum(/ℹ fail (\d+)/g) };
  const r = { passed: pw.passed + nd.passed, failed: pw.failed + nd.failed };
  if (r.passed + r.failed > 0) return r;
  const ok = (text.match(/^\s*✔/gm) ?? []).length;
  const ko = (text.match(/^\s*(✖|\d+\) )/gm) ?? []).length;
  return ok + ko ? { passed: ok, failed: ko } : null;
}
const outcomeText = (o: { passed: number; failed: number }) =>
  o.failed ? `${o.failed} of ${o.passed + o.failed} failed` : `passed (${o.passed}/${o.passed})`;

export function explainError(text: string): string {
  if (/requires? approval|require approval|permission|can't be checked before it runs/i.test(text)) return "No permission: the command did not run";
  const m = /(?:^|Error:\s*)"(.+)" does not match any elements/m.exec(text) ?? /'([^']+)' does not match any elements/.exec(text);
  if (m) return `Cannot find ${locatorLabel(m[1]) ?? "the element"} on screen`;
  if (/does not match any elements|strict mode violation/.test(text)) return "Cannot find the element on screen";
  if (/Timeout \d+ms exceeded|TimeoutError|timed out/i.test(text)) return "Timed out waiting";
  if (/Unknown engine|Invalid selector/i.test(text)) return "Invalid selector";
  if (/ENOENT|No such file|does not exist/i.test(text)) return "File not found";
  const code = /^Exit code (\d+)/m.exec(text)?.[1];
  if (code) return code === "127" ? "A program is missing from the environment (exit code 127)" : `The command failed (exit code ${code})`;
  const first = text.split("\n").map((l) => l.replace(/^#+\s*/, "").replace(/^Error:\s*/, "").trim()).find((l) => l && l !== "Error");
  return first ? `Error: ${clip(first, 100)}` : "Error";
}

// ---------- Bash ----------
interface BashOut { text: string; phase?: Phase; test?: boolean; desktop?: boolean; window?: string }

function curlPhrase(words: string[], vars: Record<string, string>): { key: string; text: string; sys?: string } | null {
  const sub = (w: string) => {
    let s = w.replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g, (all, a, def, b) => {
      const v = a ?? b;
      return vars[v] ?? (v === "MES_URL" ? "http://mes.local" : v === "ERP_URL" ? "http://erp.local" : def ?? all);
    });
    // Command substitutions are unknown values: an id, a timestamp.
    for (let i = 0; i < 5 && /\$\([^()]*\)/.test(s); i++) s = s.replace(/\$\([^()]*\)/g, "x");
    return s;
  };
  const url = words.map(sub).find((w) => /^https?:\/\//.test(w) || /\$\{?(ERP|MES)_URL/.test(w));
  if (!url) return null;
  const ws = words.join(" ");
  const method = /(?:-X\s*|--request\s+)(POST|PUT|PATCH|DELETE)/.exec(ws)?.[1] ?? (/(^|\s)(-d|--data\S*|-F)(\s|$)/.test(ws) ? "POST" : "GET");
  const health = /-o\s+\/dev\/null/.test(ws) && /http_code/.test(ws);
  const sys = systemOf(url);
  let path = "";
  try { const u = new URL(url.replace(/\$\{?(\w+)\}?/g, "x")); path = decodeURIComponent(u.pathname + u.search); } catch { path = url; }
  const name = sysName(sys, url);
  if (health && method === "GET") return { key: "health", text: name, sys };
  if (sys === "MES") {
    if (method === "GET") {
      let m = /^\/api\/coils\/([^/?]+)/.exec(path);
      if (m) return { key: "GET/api/coils/x", text: `queries the MES: ${/^\w*x\w*$/.test(m[1]) ? "test coil" : `coil ${m[1]}`}` };
      if (/^\/api\/coils/.test(path)) return { key: `${method}${path}`, text: `queries the MES: ${/HOLD/.test(path) ? "held coils" : "coils"}` };
      m = /^\/api\/grades\/([^/?]+)/.exec(path);
      if (m) return { key: path, text: `queries the MES: grade ${m[1]}` };
      m = /^\/api\/orders\/([^/?]+)/.exec(path);
      if (m) return { key: "GET/api/orders/x", text: `queries the MES: ${/^\w*x\w*$/.test(m[1]) ? "test order" : `order ${m[1]}`}` };
      if (/^\/api\/orders/.test(path)) return { key: "GET/api/orders", text: "queries the MES: orders" };
      if (/^\/health/.test(path)) return { key: "health", text: name, sys };
      m = /^\/orders\/(\w+)/.exec(path);
      if (m) return { key: path, text: `opens order ${m[1]} in the MES` };
      return { key: path, text: path === "/" ? "queries the MES" : `queries the MES: ${path}` };
    }
    if (/^\/api\/orders\/?$/.test(path)) return { key: "POST/api/orders", text: "creates a test order in the MES" };
    if (/^\/orders\/[^/]+\/coils/.test(path)) return { key: "POST coils", text: "registers a test coil in the MES" };
    if (/^\/api\/coils\/[^/]+\/quality/.test(path)) return { key: "POST quality", text: "changes a coil's quality status in the MES" };
    if (/\/complete$/.test(path)) return { key: "complete", text: "completes an order in the MES" };
    return { key: `${method}${path}`, text: `sends data to the MES (${path})` };
  }
  if (sys === "ERP" || sys === "New ERP") {
    if (/\/(json|xml)rpc|\/web\/dataset/.test(path)) return { key: "erp-rpc", text: `queries ${name} through its API` };
    if (/\/web\/login/.test(path)) return { key: "health", text: name, sys };
    return { key: path, text: `queries ${name}: ${path}` };
  }
  return { key: url, text: `queries ${name}${path && path !== "/" ? path : ""}` };
}

/** agent-desktop's arguments (directly, inside docker exec or through tools/l2). `refs` maps element refs
 *  (@s…:e1) to the names earlier find/snapshot results gave them. */
function desktopPhrase(words: string[], refs: Record<string, string> = {}): { text: string; window?: string } | null {
  const SUBS = new Set(["click", "double-click", "right-click", "type", "find", "snapshot", "wait", "screenshot", "list-windows", "close-app", "focus", "press", "key", "select", "scroll", "launch", "open"]);
  const args = words.slice(1);
  const si = args.findIndex((w) => SUBS.has(w));
  const sub = si >= 0 ? args[si] : args.find((w) => !w.startsWith("-"));
  const rest = si >= 0 ? args.slice(si + 1) : [];
  const flag = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  const refWord = rest.find((w) => w.startsWith("$("));
  let name = flag("--name");
  if (!name && refWord) { const inner = shellWords(refWord.slice(2, -1)); name = flag.call(null, "--name") ?? (inner.includes("--name") ? inner[inner.indexOf("--name") + 1] : inner[2] ?? inner[1]); }
  const positional = rest.filter((w, i) => !w.startsWith("-") && !(i > 0 && rest[i - 1].startsWith("--") && !["--headed"].includes(rest[i - 1])));
  const ref = positional.find((w) => w.startsWith("@"));
  if (!name && ref) name = refs[ref];
  switch (sub) {
    case "click": return { text: `clicks ${name ? q(name) : "a control"}` };
    case "double-click": return { text: `double-clicks ${name ? q(name) : "a control"}` };
    case "right-click": return { text: `opens the context menu of ${name ? q(name) : "a control"}` };
    case "type": {
      const text = positional.filter((w) => w !== refWord && w !== ref).at(-1);
      return { text: `types ${text ? q(text) : "text"}${name ? ` in ${q(name)}` : ""}` };
    }
    case "find": return { text: `looks for ${name ? q(name) : "a control"}` };
    case "snapshot": return { text: "reads the Level 2 screen" };
    case "wait": { const w = flag("--window"); return { text: w ? `waits for the window ${q(w)}` : "waits for the application", window: w }; }
    case "screenshot": return { text: "takes a screenshot" };
    case "list-windows": return { text: "checks the open windows" };
    case "close-app": return { text: "closes the Level 2 client" };
    case "focus": return { text: `focuses ${name ? q(name) : "a control"}` };
    case "press": case "key": return { text: `presses ${keyName(positional.at(-1) ?? "")}` };
    case "select": return { text: `selects ${q(positional.at(-1) ?? "")}` };
    case "scroll": return { text: "scrolls the view" };
    default: return { text: `uses the desktop (${sub ?? "?"})` };
  }
}

/** Calls to the tests/desktop support layer inside `node -e` scripts. */
function desktopHelperPhrases(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/\b\w+\.(type|click|selectOnlyRow|screenshot|texts|window)\(([^)]*)\)/g)) {
    const a = [...m[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]);
    if (m[1] === "type") out.push(`types ${q(a[2] ?? "")} in ${q(a[1] ?? "")}`);
    else if (m[1] === "click") out.push(`clicks ${q(a[1] ?? a[0] ?? "")}`);
    else if (m[1] === "selectOnlyRow") out.push(`selects the row in ${q(a[0] ?? "the table")}`);
    else if (m[1] === "screenshot") out.push("takes a screenshot");
    else if (m[1] === "texts") out.push("reads the Level 2 screen");
    else if (m[1] === "window" && a[0]) out.push(`checks the window ${q(a[0])}`);
  }
  return out;
}

/** xdotool arguments: typing, keys, or closing windows. */
function xdotoolPhrase(args: string[]): string {
  const positional = args.filter((w) => !w.startsWith("-"));
  if (args[0] === "type") return `types ${q(positional.at(-1) ?? "")}`;
  if (args[0] === "key") return `presses ${keyName(positional.at(-1) ?? "")}`;
  if (args.includes("windowkill") || args.includes("windowclose")) return "closes the Level 2 windows";
  if (args.some((w) => /click/.test(w))) return "clicks on the screen";
  return "uses the keyboard";
}

const ERP_READS = new Set(["search_read", "read", "search", "search_count", "name_search", "read_group"]);

/** `env`/`printenv`, a generic command, … : the agent's own one-line description reads better. */
const thirdPerson = (s: string) => s.replace(/^([A-Z][a-z]+)\b/, (v) => (/[^s]s$/.test(v) ? v : /(s|sh|ch|x|z)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`));

export function narrateBash(command: string, cwd = "", refs: Record<string, string> = {}): BashOut {
  const slots: string[] = [];
  const reads: string[] = [], lists: string[] = [], greps: string[] = [], healths: string[] = [], erp: string[] = [], mes: string[] = [];
  const desk: string[] = [];
  let window: string | undefined;
  let test: { runs: number; label: string } | null = null;
  const vars: Record<string, string> = {};
  const seen = new Set<string>();
  const slot = (k: string, text?: string) => { if (!seen.has(k)) { seen.add(k); slots.push(text ?? k); } };
  const mesQuery = (text: string) => { const m = /^queries the MES: (.+)$/.exec(text); if (m) { mes.push(m[1]); slot("MES"); } return !!m; };

  const walk = (cmd: string, loop: number) => {
    for (const seg of splitShell(cmd)) {
      if (seg.piped) continue;
      let words = shellWords(seg.text);
      while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) {
        const [k, ...v] = words[0].split("=");
        vars[k] = v.join("=").replace(/\$\{?(\w+)\}?/g, (a, x) => vars[x] ?? a);
        words = words.slice(1);
      }
      while (["do", "then", "else", "time", "command", "exec", "!"].includes(words[0])) words = words.slice(1);
      if (!words.length) continue;
      const w0 = words[0];
      if (w0 === "for") { const i = words.indexOf("in"); loop = i >= 0 ? Math.max(1, words.length - i - 1) : loop; continue; }
      if (w0.startsWith("(")) { walk(seg.text.replace(/^\(\s*/, "").replace(/\)\s*&?\s*$/, ""), loop); continue; }
      if (/^\w+\(\)/.test(w0) || /^\w+\(\)\s*\{/.test(seg.text)) continue;
      if (["done", "fi", "echo", "sleep", "cd", "source", ".", "export", "true", "false", "printf", "set", "wait", "pkill", "kill", "exit", "mkdir", "rm", "jq", "sort", "uniq", "cut", "tee", "xargs", "test", "[", "}", "{"].includes(w0)) continue;
      words = words.filter((w, i) => !/^\d*[<>]/.test(w) && !/^\d*[<>]+&?$/.test(words[i - 1] ?? ""));
      const rest = words.slice(1);
      const positional = rest.filter((w) => !w.startsWith("-") && !/^\d+(,\d+)?p?$/.test(w) && !w.startsWith("$("));
      switch (w0) {
        case "docker": {
          if (rest[0] === "exec") {
            const iShell = rest.findIndex((w) => w === "-lc" || w === "-c");
            const ct = rest.slice(1).find((w) => !w.startsWith("-")) ?? "";
            if (iShell >= 0 && rest[iShell + 1]) walk(rest[iShell + 1], loop);
            else slot(`exec ${ct}`, `runs a command in ${ct}`);
          } else if (rest[0] === "ps") slot("docker ps", "checks the lab containers");
          else if (rest[0] === "logs") slot("docker logs", `reads ${/mes/.test(rest.join(" ")) ? "the MES logs" : /erp/.test(rest.join(" ")) ? "the ERP logs" : "a container's logs"}`);
          else if (rest[0] === "cp") slot("docker cp", /\.png|\.jpg/.test(rest.join(" ")) ? "copies the desktop screenshot" : "copies a file from the container");
          else slot(`docker ${rest[0]}`, `uses docker (${rest[0]})`);
          break;
        }
        case "npx": case "pnpm": case "yarn": {
          const i = words.indexOf("playwright");
          if (i >= 0 && words[i + 1] === "test") {
            const ws = words.join(" ");
            const rep = Number(/--repeat-each[= ](\d+)/.exec(ws)?.[1] ?? 1);
            const id = caseIn(ws);
            test = { runs: (test?.runs ?? 0) + loop * rep, label: id ? `the ${id} test` : "the end-to-end tests" };
          } else slot(`npx ${rest[0]}`, `runs ${rest[0]}`);
          break;
        }
        case "node": {
          if (rest.includes("--test")) {
            const files = positional.map((w) => w.replace(/\$\{?(\w+)\}?/g, (a, x) => vars[x] ?? a));
            if (files.length && !files.some((f) => /(^|\/)tests\//.test(f))) { slot(`node ${files[0]}`, `runs ${base(files[0])}`); break; }
            const ws = files.length ? files.join(" ") : words.join(" ");
            const id = caseIn(ws);
            test = { runs: (test?.runs ?? 0) + loop, label: id ? `the ${id} test` : /desktop/.test(ws) ? "the desktop tests" : "the tests" };
            break;
          }
          const ie = rest.findIndex((w) => w === "-e" || w === "--eval");
          if (ie >= 0) {
            const ph = desktopHelperPhrases(rest[ie + 1] ?? "");
            if (ph.length) { desk.push(...ph); slot("DESK"); } else slot("node -e", "runs a Node script");
            break;
          }
          const script = positional[0] ?? "";
          if (/guard-heal/.test(script)) slot("guard", "runs the heal guard (guard-heal)");
          else if (/emit\.mjs/.test(script)) break;
          else slot(`node ${script}`, `runs ${base(script)}`);
          break;
        }
        case "agent-desktop": { const p = desktopPhrase(words, refs); if (p) { desk.push(p.text); window ??= p.window; slot("DESK"); } break; }
        case "xdotool": desk.push(xdotoolPhrase(rest)); slot("DESK"); break;
        case "tools/l2": case "./tools/l2": {
          // The repo's wrapper around the run's desktop: launch, keys (xdotool) or agent-desktop arguments.
          if (!rest.length) { slot("tools/l2", "reads how to use the Level 2 client tool"); break; }
          if (rest[0] === "launch") desk.push("starts the Level 2 client");
          else if (rest[0] === "keys") desk.push(xdotoolPhrase(rest.slice(1)));
          else { const p = desktopPhrase(words, refs); if (p) { desk.push(p.text); window ??= p.window; } }
          slot("DESK");
          break;
        }
        case "tools/api": case "./tools/api": {
          // The documented interfaces of the systems under test: tools/api mes <METHOD> <path> [body] | erp <model> <method> …
          if (rest[0] === "mes" && rest[2]) {
            const p = curlPhrase(["-X", rest[1].toUpperCase(), `http://mes.local${rest[2]}`, ...(rest[3] ? ["--data", "body"] : [])], vars);
            if (p && !mesQuery(p.text)) slot(p.key === "health" ? "mes health" : p.key, p.key === "health" ? "checks that the MES responds" : p.text);
          } else if (rest[0] === "erp" && rest[2]) {
            const [, model, method] = rest;
            if (ERP_READS.has(method)) { erp.push(model); slot("ERP"); }
            else if (method === "fields_get") slot(`fields ${model}`, `reads the fields of ${model} in the ERP`);
            else if (method === "create") slot(`create ${model}`, `creates a ${model} record in the ERP`);
            else if (method === "write") slot(`write ${model}`, `updates a ${model} record in the ERP`);
            else slot(`${model} ${method}`, `calls ${method} on ${model} in the ERP`);
          } else slot("tools/api", "reads how to use the API tool");
          break;
        }
        case "env": case "printenv": slot("env", "checks the environment variables"); break;
        case "java": if (/L2Client/.test(seg.text)) { desk.push("starts the Level 2 client"); slot("DESK"); } else slot("java", "starts a Java application"); break;
        case "ffmpeg": if (/x11grab/.test(seg.text)) { desk.push("captures the screen"); slot("DESK"); } else slot("ffmpeg", "processes a video"); break;
        case "curl": case "wget": {
          const p = curlPhrase(rest, vars);
          if (!p) slot("curl", "makes a web request");
          else if (p.key === "health") { healths.push(p.text); slot("HEALTH"); }
          else if (!mesQuery(p.text)) slot(p.key, p.text);
          break;
        }
        case "git": {
          const sub = rest[0];
          if (["diff", "status", "log", "show"].includes(sub)) slot("git", "reviews the changes in git");
          else if (sub === "fetch") slot("git fetch", "fetches the base branch");
          else if (sub === "checkout" && rest.includes("--")) slot("git checkout", `discards its change to ${rest[rest.indexOf("--") + 1] ?? "a file"}`);
          else slot(`git ${sub}`, `uses git (${sub})`);
          break;
        }
        case "cat": case "sed": case "head": case "tail": case "nl": case "wc": case "less": case "more": {
          const target = /(?:^|\s)>{1,2}\s*([^\s&|;]+)/.exec(seg.text)?.[1];
          if (target && w0 === "cat") { slot(`write ${target}`, `writes ${base(target)}`); break; }
          const files = positional.filter((w) => !/^s\//.test(w));
          if (!files.length) break;
          reads.push(...files.map((f) => describePath(f, cwd)));
          slot("READ");
          break;
        }
        case "ls": case "find": case "tree": {
          lists.push(...(positional.length ? positional.map((f) => describePath(f, cwd)) : ["the repository"]));
          slot("LIST");
          break;
        }
        case "grep": case "rg": {
          const pat = positional[0] ?? "";
          const where = positional.slice(1).map((f) => describePath(f, cwd));
          greps.push(/[\\|()^$[\]]/.test(pat) || pat.length > 40 ? (where.length ? `in ${joinList(where, 2)}` : "in the code") : `${q(pat)}${where.length ? ` in ${joinList(where, 2)}` : ""}`);
          slot("GREP");
          break;
        }
        case "bash": case "sh": if (positional[0]) slot(`sh ${positional[0]}`, `runs the script ${base(positional[0])}`); break;
        case "unzip": slot("unzip", "opens the Playwright report"); break;
        default: slot(w0, `runs ${q(w0)}`);
      }
    }
  };
  walk(command, 1);

  if (test) {
    const t = test as { runs: number; label: string };
    return { text: `Runs ${t.label}${t.runs > 1 ? ` ×${t.runs}` : ""}`, phase: "test", test: true };
  }
  const render = (s: string) => {
    if (s === "READ") return `reads ${joinList(reads, 3)}`;
    if (s === "LIST") return `lists ${joinList(lists, 3)}`;
    if (s === "GREP") return `searches ${joinList(greps, 2)}`;
    if (s === "HEALTH") { const h = [...new Set(healths)]; return `checks that ${joinList(h)} ${h.length > 1 ? "respond" : "responds"}`; }
    if (s === "MES") return `queries the MES: ${joinList(mes, 3)}`;
    if (s === "ERP") return `queries the ERP: ${joinList(erp, 3)}`;
    if (s === "DESK") { const d = joinList(desk, 6); return /Level 2/.test(d) ? d : `${d} in the Level 2 client`; }
    return s;
  };
  const text = slots.map(render);
  if (desk.length) return { text: cap(joinTop(text)), phase: "explore", desktop: true, window };
  return { text: text.length ? cap(joinTop(text)) : "Runs a command" };
}

// ---------- tool calls ----------
interface ToolOut { text: string; phase?: Phase; tone?: Tone; kind?: Item["kind"]; test?: boolean; desktop?: boolean; window?: string; tpl?: (label: string) => string }
const SUBAGENTS: Record<string, string> = {
  "playwright-test-generator": "generator",
  "playwright-test-planner": "planner",
  "playwright-test-healer": "healer",
  Explore: "explorer",
  "general-purpose": "helper",
  Plan: "planner",
};
const SUBAGENT_TASK: Record<string, string> = {
  generator: "explore the application and write the test",
  planner: "explore the application and plan the test",
  healer: "debug and repair the test",
};
export const subagentLabel = (t: string | undefined) => { const who = SUBAGENTS[t ?? ""] ?? t; return who ? `${cap(who)} subagent` : "Subagent"; };

function browserTool(short: string, input: any, ctx: { hosts: Hosts }): ToolOut {
  const label = locatorLabel(input.target ?? input.selector ?? input.ref) ?? (input.element && !/^[a-z]\d+e\d+$/.test(input.element) ? q(input.element) : undefined);
  const T = (tpl: (l: string) => string, fallback: string, extra: Partial<ToolOut> = { phase: "explore" }): ToolOut => ({ text: tpl(label ?? fallback), tpl, ...extra });
  switch (short) {
    case "browser_navigate": {
      const url = String(input.url ?? "");
      const sys = systemOf(url, ctx.hosts);
      let path = "";
      try { const u = new URL(url); path = u.pathname + u.search; } catch {}
      return { text: `Opens ${sysName(sys, url)}${path && path !== "/" ? ` · ${clip(path, 50)}` : ""}`, phase: "explore" };
    }
    case "browser_navigate_back": return { text: "Goes back to the previous page", phase: "explore" };
    case "browser_click": return T((l) => `${input.doubleClick ? "Double-clicks" : "Clicks"} ${l}`, "an element");
    case "browser_type": case "browser_press_sequentially":
      return T((l) => `Types ${q(input.text ?? "")} in ${l}${input.submit ? " and submits" : ""}`, "a field");
    case "browser_select_option": return T((l) => `Selects ${q([].concat(input.values ?? input.value ?? []).join(", "))} in ${l}`, "a list");
    case "browser_fill_form": {
      const f = (input.fields ?? []) as any[];
      return { text: `Fills ${f.length} ${f.length === 1 ? "field" : "fields"}: ${joinList(f.map((x) => q(x.name ?? x.element ?? "")), 4)}`, phase: "explore" };
    }
    case "browser_press_key": return { text: `Presses ${keyName(String(input.key ?? ""))}`, phase: "explore" };
    case "browser_hover": return T((l) => `Hovers over ${l}`, "an element");
    case "browser_check": return T((l) => `Ticks ${l}`, "a checkbox");
    case "browser_uncheck": return T((l) => `Unticks ${l}`, "a checkbox");
    case "browser_drag": case "browser_drop": case "browser_mouse_drag_xy": return { text: "Drags an element", phase: "explore" };
    case "browser_snapshot": return { text: "Reads the screen", tone: "quiet" };
    case "browser_take_screenshot": return { text: "Takes a screenshot", tone: "quiet" };
    case "browser_wait_for":
      if (input.text) return { text: `Waits for ${q(input.text)} to appear`, phase: "explore" };
      if (input.textGone) return { text: `Waits for ${q(input.textGone)} to disappear`, phase: "explore" };
      return { text: `Waits ${input.time != null ? `${input.time} s` : "a few seconds"}`, tone: "quiet" };
    case "browser_verify_text_visible": return { text: `Checks that ${q(input.text ?? "")} is visible` };
    case "browser_verify_element_visible": return { text: `Checks that ${q(input.accessibleName ?? input.name ?? input.element ?? "the element")} is visible` };
    case "browser_verify_value": return T((l) => `Checks that ${l} is ${q(input.value ?? "")}`, "the field", {});
    case "browser_verify_list_visible": return { text: "Checks the list on screen" };
    case "browser_close": return { text: "Closes the browser", tone: "quiet" };
    case "browser_tabs": return { text: "Switches tab", tone: "quiet" };
    case "browser_handle_dialog": return { text: input.accept === false ? "Dismisses the dialog" : "Accepts the dialog", phase: "explore" };
    case "browser_evaluate": case "browser_run_code_unsafe": return { text: "Runs code in the page" };
    case "browser_console_messages": return { text: "Reviews the browser console", tone: "quiet" };
    case "browser_network_requests": case "browser_network_request": return { text: "Reviews the network requests", tone: "quiet" };
    case "browser_generate_locator": return { text: `Looks for a stable locator for ${label ?? "an element"}`, tone: "quiet" };
    case "browser_resize": return { text: "Resizes the window", tone: "quiet" };
    case "browser_file_upload": return { text: "Uploads a file", phase: "explore" };
    default: return { text: `Uses the browser (${short.replace(/^browser_/, "").replace(/_/g, " ")})` };
  }
}

function describeTool(name: string, input: any, ctx: { cwd: string; phase: Phase; written: Set<string>; hosts: Hosts; refs: Record<string, string> }): ToolOut {
  const short = name.includes("__") ? name.split("__").pop()! : name;
  if (name.startsWith("mcp__") && short.startsWith("browser_")) return browserTool(short, input, ctx);
  switch (short) {
    case "planner_setup_page": return { text: "Opens the browser to plan the test", phase: "explore" };
    case "planner_save_plan": case "planner_submit_plan": return { text: "Saves the test plan", phase: "explore" };
    case "generator_setup_page": return { text: "Opens the browser at the test's starting point", phase: "explore" };
    case "generator_read_log": return { text: "Reviews the steps it took in the browser", phase: "write" };
    case "generator_write_test": {
      const f = String(input.fileName ?? input.file ?? "the test");
      const again = ctx.written.has(f);
      ctx.written.add(f);
      return { text: `${again ? "Rewrites" : "Writes"} ${f} (+${input._code_lines ?? lines(input.code)} lines)`, phase: "write" };
    }
    case "test_list": return { text: "Lists the tests", tone: "quiet" };
    case "test_run": return { text: `Runs ${caseIn(JSON.stringify(input)) ? `the ${caseIn(JSON.stringify(input))} test` : "the test"}`, phase: "test", test: true };
    case "test_debug": return { text: `Debugs ${caseIn(JSON.stringify(input)) ? `the ${caseIn(JSON.stringify(input))} test` : "the test"}`, phase: "test", test: true };
  }
  switch (name) {
    case "Bash": {
      const out = narrateBash(String(input.command ?? ""), ctx.cwd, ctx.refs);
      if (typeof input.description === "string" && input.description.trim() && /^Runs (a command|“[^”]*”)$/.test(out.text)) out.text = clip(thirdPerson(input.description.trim()));
      return out;
    }
    case "Read": {
      const p = String(input.file_path ?? "");
      if (/\.(png|jpe?g|gif|webp)$/i.test(p)) return { text: `Looks at the screenshot ${base(p)}` };
      return { text: `Reads ${describePath(p, ctx.cwd)}` };
    }
    case "Write": {
      const rel = relPath(String(input.file_path ?? ""), ctx.cwd);
      const again = ctx.written.has(rel);
      ctx.written.add(rel);
      const n = input._content_lines ?? lines(input.content);
      if (isTestFile(rel)) return { text: `${again ? "Rewrites" : "Writes"} ${rel} (+${n} lines)`, phase: "write" };
      if (/^specs\//.test(rel)) return { text: `Saves the test plan ${rel}` };
      return { text: `Writes a helper file, ${base(rel)}` };
    }
    case "Edit": case "MultiEdit": {
      const rel = relPath(String(input.file_path ?? ""), ctx.cwd);
      const edits = name === "MultiEdit" ? (input.edits ?? []) : [input];
      const add = edits.reduce((a: number, e: any) => a + lines(e.new_string), 0);
      const del = edits.reduce((a: number, e: any) => a + lines(e.old_string), 0);
      const verb = ctx.phase === "test" ? "Fixes" : "Edits";
      return { text: `${verb} ${isTestFile(rel) ? rel : describePath(rel, ctx.cwd)} (+${add} −${del})`, phase: isTestFile(rel) ? "write" : undefined };
    }
    case "Glob": return { text: `Looks for files ${q(input.pattern ?? "")}`, tone: "quiet" };
    case "Grep": return { text: `Searches the code for ${q(input.pattern ?? "")}`, tone: "quiet" };
    case "LS": return { text: `Lists ${describePath(String(input.path ?? "."), ctx.cwd)}`, tone: "quiet" };
    case "Agent": case "Task": {
      const who = SUBAGENTS[input.subagent_type] ?? input.subagent_type ?? "";
      const task = SUBAGENT_TASK[who] ?? (input.description ? q(input.description) : "a task");
      return { text: `Delegates to the ${who} subagent: ${task}`, kind: "subagent" };
    }
    case "TodoWrite": return { text: "Updates its task list", tone: "quiet" };
    case "Skill": return { text: `Loads the skill ${q(input.skill ?? input.command ?? "")}`, tone: "quiet" };
    case "ToolSearch": return { text: "Loads the tools it needs", tone: "quiet" };
    case "WebFetch": { let h = ""; try { h = new URL(input.url).host; } catch {} return { text: `Fetches ${h || "a web page"}` }; }
    case "WebSearch": return { text: `Searches the web for ${q(input.query ?? "")}` };
  }
  if (name.startsWith("mcp__")) { const [, server, tool] = name.split("__"); return { text: `Uses ${server}: ${tool?.replace(/_/g, " ")}` }; }
  return { text: `Uses the tool ${name}` };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
  return "";
}

// ---------- the narrator ----------
export class Narrator {
  items: Item[] = [];
  totals: Totals = { steps: 0 };
  phase: Phase = "explore";
  page?: Page;
  version = 0;
  private cwd = "";
  private written = new Set<string>();
  private byTool = new Map<string, Item>();
  private subOf = new Map<string, string>(); // Agent tool_use id -> label
  private hosts: Hosts;
  private refs: Record<string, string> = {}; // desktop element ref (@s…:e1) -> its name, from find/snapshot output
  private n = 0;
  private lastT = 0;

  constructor(opts: { hosts?: Hosts } = {}) { this.hosts = opts.hosts ?? {}; }

  private rel(s: string) { return this.cwd ? s.replaceAll(this.cwd + "/", "") : s; }
  private advance(p?: Phase) { if (p && ORDER.indexOf(p) > ORDER.indexOf(this.phase)) this.phase = p; }
  private add(it: Omit<Item, "phase"> & { phase?: Phase }): Item {
    const item = { ...it, phase: it.phase ?? this.phase } as Item;
    this.items.push(item);
    return item;
  }

  /** Feed one stream-json line. `ts` (ms, the event time) wins over the line's own timestamp so the
   *  narration shares one clock with stage events and recordings. */
  push(line: any, ts?: number): void {
    if (!line || typeof line !== "object") return;
    const t = ts ?? ((line.timestamp && Date.parse(line.timestamp)) || this.lastT || Date.now());
    this.lastT = t;
    this.totals.startedAt ??= t;
    this.version++;
    const sub = line.parent_tool_use_id ? this.subOf.get(line.parent_tool_use_id) ?? subagentLabel(line.subagent_type) : undefined;

    if (line.type === "system") {
      if (line.subtype === "init") {
        this.cwd = line.cwd ?? "";
        this.totals.model = line.model;
        this.add({ id: `init:${this.n++}`, t, kind: "note", text: `Agent starts${line.model ? ` with ${line.model}` : ""}`, tone: "quiet" });
      } else if (line.subtype === "task_notification") {
        const it = this.byTool.get(line.tool_use_id);
        if (it && line.summary) it.detail = firstSentence(this.rel(String(line.summary)), 160);
        if (it && line.status && line.status !== "completed") { it.status = "warn"; it.tone = "warn"; }
      }
      return;
    }

    if (line.type === "assistant") {
      const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
      blocks.forEach((b: any, i: number) => {
        if (b?.type === "text" && b.text?.trim()) {
          this.add({ id: `${line.uuid ?? this.n++}:${i}`, t, kind: "text", text: `Reasoning: ${firstSentence(b.text)}`, tone: "quiet", sub, raw: { result: b.text } });
        } else if (b?.type === "tool_use") {
          const d = describeTool(b.name, b.input ?? {}, { cwd: this.cwd, phase: this.phase, written: this.written, hosts: this.hosts, refs: this.refs });
          this.advance(d.phase);
          if (d.desktop) this.page = { system: "L2", title: d.window ?? this.page?.title ?? "Level 2 client (desktop)" };
          const it = this.add({ id: b.id ?? `${line.uuid}:${i}`, t, kind: d.kind ?? "tool", text: d.text, tone: d.tone ?? "normal", status: "running", sub, tool: b.name, raw: { input: b.input }, page: this.page });
          if (d.test) (it as any)._test = true;
          if (d.tpl) (it as any)._tpl = d.tpl;
          if (b.name === "Agent" || b.name === "Task") this.subOf.set(it.id, subagentLabel(b.input?.subagent_type));
          this.byTool.set(it.id, it);
          this.totals.steps++;
        }
      });
      return;
    }

    if (line.type === "user") {
      const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
      for (const b of blocks) if (b?.type === "tool_result") this.result(b, t);
      return;
    }

    if (line.type === "result") {
      Object.assign(this.totals, {
        turns: line.num_turns, durationMs: line.duration_ms, costUsd: line.total_cost_usd,
        isError: !!line.is_error || (line.subtype && line.subtype !== "success"), endedAt: t,
      });
      // The agent's closing message is its report.
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (it.sub) continue;
        if (it.kind !== "text") break;
        it.kind = "report"; it.phase = "report"; it.tone = "normal"; it.text = it.raw?.result ?? it.text;
      }
      if (typeof line.result === "string" && !this.items.some((i) => i.kind === "report")) {
        this.add({ id: `report:${this.n++}`, t, kind: "report", phase: "report", text: line.result, tone: "normal" });
      }
      this.phase = "report";
      const bits = [line.num_turns != null ? `${line.num_turns} turns` : "", line.total_cost_usd != null ? fmtUsd(line.total_cost_usd) : ""].filter(Boolean);
      this.add({
        id: `result:${this.n++}`, t, kind: "result", phase: "report",
        text: `Finishes${line.duration_ms != null ? ` in ${fmtDuration(line.duration_ms)}` : ""}${bits.length ? `: ${bits.join(", ")}` : ""}`,
        tone: this.totals.isError ? "fail" : "normal", status: this.totals.isError ? "fail" : "ok", raw: { input: { subtype: line.subtype, is_error: line.is_error } },
      });
    }
  }

  private result(b: any, t: number) {
    const it = this.byTool.get(b.tool_use_id);
    if (!it) return;
    const text = resultText(b.content);
    it.raw = { ...it.raw, result: text, error: !!b.is_error };
    (it as any).doneAt = t;
    if (b.is_error) {
      it.status = "warn"; it.tone = "warn"; it.detail = explainError(text);
      return;
    }
    it.status = "ok";
    if (text.includes('"ref_id"')) {
      for (const [o] of text.matchAll(/\{[^{}]*\}/g)) {
        const ref = /"ref_id"\s*:\s*"([^"]+)"/.exec(o)?.[1];
        const name = /"name"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(o)?.[1];
        if (ref && name) this.refs[ref] = name.replace(/\\(.)/g, "$1");
      }
    }
    // Real UI label from the code Playwright actually ran.
    const label = locatorLabel(ranCode(text));
    const tpl = (it as any)._tpl as ((l: string) => string) | undefined;
    if (label && tpl) it.text = tpl(label);
    const url = /- Page URL: (\S+)/.exec(text)?.[1];
    if (url) {
      const title = /- Page Title: (.+)/.exec(text)?.[1]?.trim();
      let path: string | undefined;
      try { const u = new URL(url); path = u.pathname + u.search; } catch {}
      this.page = { system: systemOf(url, this.hosts) ?? "Web", url, path, title };
      it.page = this.page;
    }
    if ((it as any)._test) {
      const o = testOutcome(text);
      if (o) {
        it.detail = outcomeText(o);
        it.status = o.failed ? "fail" : "ok";
        it.tone = o.failed ? "fail" : "ok";
      }
    }
    if (it.kind === "subagent" && !it.detail && text) it.detail = firstSentence(this.rel(text).replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ""), 160);
  }
}

/** Convenience for tests and exports: narrate a whole list of lines. */
export function narrateAll(lines: { data: any; ts?: number }[], opts?: { hosts?: Hosts }): Narrator {
  const n = new Narrator(opts);
  for (const l of lines) n.push(l.data, l.ts);
  return n;
}
