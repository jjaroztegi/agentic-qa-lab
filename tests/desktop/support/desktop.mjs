// Protected support layer for desktop tests (CODEOWNERS: QA platform).
// Deterministic executor over agent-desktop (OS accessibility tree: AT-SPI / UIA / AX):
// elements are found by role + accessible name on every call (no stale refs, no coordinates).
// Learned limits, Swing via java-atk-wrapper on Linux (agent-desktop 1.2.0), handled here:
//   - JTable rows cannot be selected semantically -> filter to one row, focus table, press Down
//   - JOptionPane dialogs report "offscreen" -> they own keyboard focus; use keys()
//   - AT-SPI bounds are offset by the window frame -> never click by coordinates
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// How to reach the desktop session: a container locally, plain shell on a desktop VM (instabox).
const EXEC = (process.env.DESKTOP_EXEC ?? "docker exec qa-desktop").split(" ").filter(Boolean);
const sh = (cmd) =>
  execFileSync(EXEC[0], [...EXEC.slice(1), "bash", "-lc", `source ~/.desktop-env 2>/dev/null; ${cmd}`], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

function ad(args) {
  const out = JSON.parse(sh(`agent-desktop ${args}`));
  if (!out.ok) throw new Error(`agent-desktop ${args.split(" ")[0]}: ${out.error?.message}`);
  return out.data;
}

export function desktop(app, evidenceDir) {
  mkdirSync(evidenceDir, { recursive: true });
  let shot = 0;
  const ref = (role, name, window) => {
    const d = ad(`find --app ${q(app)} --role ${role} --name ${q(name)} ${window ? `--window-id ${q(window)}` : ""}`);
    if (!d.matches?.length) throw new Error(`Cannot find ${role} "${name}" in ${app}`);
    return d.matches[0].ref_id;
  };
  const api = {
    launch(cmd, title, timeoutMs = 30_000) {
      sh(`(${cmd} > /tmp/app.log 2>&1 &)`);
      ad(`wait --window ${q(title)} --app ${q(app)} --timeout ${timeoutMs}`);
    },
    click: (role, name) => ad(`click ${ref(role, name)}`),
    type: (role, name, text) => ad(`type ${ref(role, name)} ${q(text)}`),
    /** Select the only row left in a table (filter first). */
    selectOnlyRow(table) {
      ad(`--headed focus ${ref("table", table)}`);
      ad(`--headed press Down`);
    },
    /** Keyboard into whatever has focus (modal dialogs). */
    keys(text, then = "Return") {
      sh(`xdotool type --delay 15 ${q(text)}${then ? `; xdotool key ${then}` : ""}`);
    },
    window: (title) => ad(`list-windows`).find((w) => w.title === title),
    waitWindowGone(title, timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs;
      while (api.window(title) && Date.now() < end) sh("sleep 0.3");
      if (api.window(title)) throw new Error(`Window "${title}" is still open`);
    },
    /** All visible texts of the app window, in tree order (table cells included). */
    texts: () => {
      const d = ad(`snapshot --app ${q(app)}`);
      const out = [];
      (function walk(n) {
        if (n?.role === "statictext" && n.name) out.push(n.name);
        (n?.children ?? []).forEach(walk);
      })(d.tree);
      return out;
    },
    screenshot(label) {
      const name = `${String(++shot).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "_")}.png`;
      sh(`ffmpeg -loglevel error -y -f x11grab -video_size 1920x1080 -i $DISPLAY -frames:v 1 /tmp/${name}`);
      writeFileSync(join(evidenceDir, name), execFileSync(EXEC[0], [...EXEC.slice(1), "cat", `/tmp/${name}`]));
    },
    /** Video of the whole display while the test runs. Returns stop(). */
    record(file = "video.mp4") {
      const p = spawn(EXEC[0], [...EXEC.slice(1), "bash", "-lc",
        `source ~/.desktop-env; exec ffmpeg -loglevel error -y -f x11grab -framerate 25 -video_size 1920x1080 -i $DISPLAY -pix_fmt yuv420p /tmp/${file}`]);
      return async () => {
        sh(`pkill -INT -f "ffmpeg.*x11grab.*/tmp/${file}" || true`);
        await new Promise((r) => p.on("exit", r));
        writeFileSync(join(evidenceDir, file), execFileSync(EXEC[0], [...EXEC.slice(1), "cat", `/tmp/${file}`], { maxBuffer: 1 << 30 }));
      };
    },
    close: () => sh(`agent-desktop close-app ${q(app)} >/dev/null 2>&1 || pkill -f '[L]2Client' || true`),
  };
  return api;
}
