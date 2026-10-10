/**
 * Minimal parser for TOON (the indentation-based "key: value" format Magnific MCP returns instead of JSON).
 * Handles: `key: value`, `key:` + nested block, `key[N]: a,b,c` inline arrays,
 * `key[N]:` + `- item` lists (scalars or objects), and `key[N]{a,b}:` + `x,y` tabular rows.
 */
type Val = string | number | boolean | null | Val[] | { [k: string]: Val };

function scalar(raw: string): Val {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Splits "a,\"b,c\",d" on commas outside quotes. */
function splitRow(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of raw) {
    if (ch === '"') q = !q;
    if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

interface Line {
  indent: number;
  text: string;
}

const KEY_RE = /^([A-Za-z0-9_$.\-"]+?)(?:\[(\d+)\])?(?:\{([^}]*)\})?:(?:\s(.*))?$/;

function parseBlock(lines: Line[], start: number, indent: number): [Record<string, Val>, number] {
  const obj: Record<string, Val> = {};
  let i = start;
  while (i < lines.length && lines[i].indent >= indent) {
    const { text } = lines[i];
    const m = text.match(KEY_RE);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1].replace(/^"|"$/g, "");
    const [, , count, cols, rest] = m;
    i++;
    const childIndent = i < lines.length ? lines[i].indent : -1;
    const hasChildren = childIndent > indent;
    if (cols !== undefined) {
      const names = cols.split(",");
      const rows: Val[] = [];
      while (i < lines.length && lines[i].indent > indent) {
        const vals = splitRow(lines[i].text);
        rows.push(Object.fromEntries(names.map((n, j) => [n, scalar(vals[j] ?? "")])));
        i++;
      }
      obj[key] = rows;
    } else if (count !== undefined && rest !== undefined && rest.trim() !== "") {
      obj[key] = splitRow(rest).map(scalar);
    } else if (count !== undefined && hasChildren) {
      const items: Val[] = [];
      while (i < lines.length && lines[i].indent >= childIndent) {
        const ln = lines[i];
        if (ln.indent === childIndent && ln.text.startsWith("- ")) {
          const body = ln.text.slice(2);
          if (KEY_RE.test(body)) {
            // "- key: v" starts an object whose other keys sit at childIndent + 2.
            const sub: Line[] = [{ indent: childIndent + 2, text: body }];
            let j = i + 1;
            while (j < lines.length && lines[j].indent > childIndent) sub.push(lines[j++]);
            items.push(parseBlock(sub, 0, childIndent + 2)[0]);
            i = j;
          } else {
            items.push(scalar(body));
            i++;
          }
        } else i++;
      }
      obj[key] = items;
    } else if (hasChildren && (rest === undefined || rest.trim() === "")) {
      const [child, next] = parseBlock(lines, i, childIndent);
      obj[key] = child;
      i = next;
    } else {
      obj[key] = scalar(rest ?? "");
    }
  }
  return [obj, i];
}

export function parseToon(text: string): Record<string, Val> {
  const lines = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  return parseBlock(lines, 0, 0)[0];
}

/** Parses a tool result that may be JSON text, TOON text, or already an object. */
export function parseToolText(result: unknown): unknown {
  const text = typeof result === "string" ? result : typeof (result as { text?: unknown })?.text === "string" ? (result as { text: string }).text : null;
  if (text === null) return result;
  try {
    return JSON.parse(text);
  } catch {
    return parseToon(text);
  }
}
