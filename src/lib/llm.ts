import { getSettings } from "./settings";

/**
 * OpenAI-compatible chat client. Works with OpenAI, Anthropic's OpenAI-compatible endpoint,
 * OpenRouter, Gemini's OpenAI endpoint, xAI, Groq, Together, Ollama, LM Studio, vLLM...
 * Base URL / key / model come from Settings and can be changed at any time.
 */
export type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class LlmNotConfigured extends Error {
  constructor() {
    super("The AI assistant isn't configured yet. Add an OpenAI-compatible base URL, API key and model in Settings.");
  }
}

export async function llmConfig(agent?: string) {
  const s = await getSettings();
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(s.llmBaseUrl);
  if (!s.llmBaseUrl || (!s.llmApiKey && !isLocal)) return null;
  return {
    baseUrl: s.llmBaseUrl.replace(/\/$/, ""),
    apiKey: s.llmApiKey,
    model: (agent && s.agentModels?.[agent]) || s.llmModel,
  };
}

export async function isLlmConfigured() {
  return !!(await llmConfig());
}

interface ChatOpts {
  agent?: string;
  tools?: ToolDef[];
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

/** One chat completion (streamed when onDelta is given). Returns the assistant message. */
export async function chat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<ChatMessage> {
  const cfg = await llmConfig(opts.agent);
  if (!cfg) throw new LlmNotConfigured();
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.4,
    stream: !!opts.onDelta,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    // Some providers reject response_format; retry once without it.
    if (opts.json && res.status === 400 && /response_format/i.test(text)) return chat(messages, { ...opts, json: false });
    throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
  }

  if (!opts.onDelta) {
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    return { role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls?.length ? msg.tool_calls : undefined };
  }

  // Streaming: accumulate content + tool call deltas.
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const calls: ToolCall[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          opts.onDelta(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          calls[i] ??= { id: tc.id ?? `call_${i}`, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].function.name += tc.function.name;
          if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
        }
      } catch {}
    }
  }
  const tool_calls = calls.filter(Boolean);
  return { role: "assistant", content, tool_calls: tool_calls.length ? tool_calls : undefined };
}

/** Asks for a JSON object and parses it (tolerates code fences / prose around it). */
export async function chatJson<T = unknown>(messages: ChatMessage[], opts: Omit<ChatOpts, "json" | "onDelta"> = {}): Promise<T> {
  const msg = await chat(messages, { ...opts, json: true, temperature: opts.temperature ?? 0.2 });
  const text = typeof msg.content === "string" ? msg.content : "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function testLlm() {
  const msg = await chat([{ role: "user", content: "Reply with the single word: ready" }], { temperature: 0 });
  return typeof msg.content === "string" ? msg.content : "";
}
