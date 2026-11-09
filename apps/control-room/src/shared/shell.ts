// Minimal shell lexer: enough to read what an agent's Bash call does (segments and words),
// not to execute anything. Handles quotes, $( ), ( ), { } groups and heredocs.

export interface Segment { text: string; piped: boolean }

/** Splits a command line into top-level simple commands (; && || | & newline). */
export function splitShell(cmd: string): Segment[] {
  const out: Segment[] = [];
  let cur = "";
  let piped = false;
  let depth = 0; // ( $( {
  let q: '"' | "'" | null = null;
  let heredoc: string | null = null;
  const push = (nextPiped: boolean) => {
    if (cur.trim()) out.push({ text: cur.trim(), piped });
    cur = "";
    piped = nextPiped;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"') { cur += cmd[++i] ?? ""; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "\\") { cur += c + (cmd[++i] ?? ""); continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(cmd.slice(i));
      if (m) { heredoc = m[2]; cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === "(" || (c === "{" && /(^|[\s;)])$/.test(cur.slice(-1) || " "))) { depth++; cur += c; continue; }
    if ((c === ")" || c === "}") && depth > 0) { depth--; cur += c; continue; }
    if (depth > 0) { cur += c; continue; }
    if (c === "\n") {
      push(false);
      if (heredoc) {
        const end = cmd.indexOf(`\n${heredoc}\n`, i);
        const endAlt = cmd.endsWith(`\n${heredoc}`) ? cmd.length - heredoc.length - 1 : -1;
        const stop = end >= 0 ? end : endAlt;
        i = stop >= 0 ? stop + heredoc.length + 1 : cmd.length;
        heredoc = null;
      }
      continue;
    }
    if (c === ";") { push(false); continue; }
    if (c === "&" && cmd[i + 1] === "&") { push(false); i++; continue; }
    if (c === "|" && cmd[i + 1] === "|") { push(false); i++; continue; }
    if (c === "|") { push(true); continue; }
    if (c === "&" && cmd[i + 1] !== ">" && cmd[i - 1] !== ">") { push(false); continue; }
    cur += c;
  }
  push(false);
  return out;
}

/** Splits a simple command into words, removing quotes. $( … ) stays one raw word. */
export function shellWords(seg: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === "\\" && q === '"' && /["\\$`]/.test(seg[i + 1] ?? "")) { cur += seg[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "$" && seg[i + 1] === "(") {
      let d = 0, j = i;
      for (; j < seg.length; j++) {
        if (seg[j] === "(") d++;
        else if (seg[j] === ")" && --d === 0) break;
      }
      cur += seg.slice(i, j + 1);
      has = true;
      i = j;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\") { cur += seg[++i] ?? ""; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur) words.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) words.push(cur);
  return words;
}
