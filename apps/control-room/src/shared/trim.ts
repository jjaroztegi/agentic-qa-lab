// Shrinks one Claude Code stream-json line before it is stored: page snapshots, base64 images,
// thinking signatures and tool inventories are dead weight for narration and for engineers alike.
// Returns null for lines that carry nothing worth showing (heartbeats, token counters).

const DROP_SYSTEM = new Set(["thinking_tokens", "commands_changed", "task_progress", "task_updated"]);
const MAX_RESULT = 4000;
const MAX_INPUT = 20_000;

const clip = (s: string, max = MAX_RESULT) =>
  s.length <= max ? s : `${s.slice(0, max * 0.75)}\n… [${s.length - max} characters trimmed] …\n${s.slice(-max * 0.25)}`;

function trimResultContent(content: unknown): unknown {
  if (typeof content === "string") return clip(content);
  if (!Array.isArray(content)) return content;
  const text = content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  const images = content.filter((b) => b?.type === "image").length;
  const out: unknown[] = [];
  if (text) out.push({ type: "text", text: clip(text) });
  if (images) out.push({ type: "image", omitted: images });
  return out;
}

function trimInput(input: any): any {
  if (!input || typeof input !== "object") return input;
  const out: any = { ...input };
  for (const k of ["content", "code", "new_string", "old_string", "prompt", "command"]) {
    if (typeof out[k] === "string" && out[k].length > MAX_INPUT) {
      out[`_${k}_lines`] = out[k].split("\n").length;
      out[k] = out[k].slice(0, MAX_INPUT);
    }
  }
  return out;
}

export function trimAgentLine(line: any): any | null {
  if (!line || typeof line !== "object") return null;
  if (line.type === "tool_progress" || line.type === "stream_event") return null;
  if (line.type === "system") {
    if (DROP_SYSTEM.has(line.subtype)) return null;
    if (line.subtype === "init") {
      const { type, subtype, session_id, model, cwd, claude_code_version, permissionMode } = line;
      return { type, subtype, session_id, model, cwd, claude_code_version, permissionMode };
    }
    if (line.subtype === "task_started" && typeof line.prompt === "string") return { ...line, prompt: line.prompt.slice(0, 600) };
    return line;
  }
  if (line.type === "assistant" || line.type === "user") {
    const { tool_use_result: _r, wire_tool_inputs: _w, wire_ingest_context: _c, ...rest } = line;
    const content = line.message?.content;
    if (!Array.isArray(content)) return rest;
    const blocks = content
      .map((b: any) => {
        if (b?.type === "thinking" || b?.type === "redacted_thinking") return null;
        if (b?.type === "tool_result") return { ...b, content: trimResultContent(b.content) };
        if (b?.type === "tool_use") return { ...b, input: trimInput(b.input) };
        if (b?.type === "image") return { type: "image", omitted: 1 };
        if (b?.type === "text" && typeof b.text === "string") return { ...b, text: clip(b.text, MAX_INPUT) };
        return b;
      })
      .filter(Boolean);
    if (!blocks.length) return null;
    return { ...rest, message: { ...line.message, content: blocks } };
  }
  return line;
}
