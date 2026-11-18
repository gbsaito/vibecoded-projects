// Minimal Valve VDF (KeyValues) parser: objects of string->string / string->object.
export type VdfValue = string | VdfNode;
export interface VdfNode {
  [key: string]: VdfValue;
}

/** Parse a VDF document (root object) into a nested object. */
export function parseVdf(src: string): VdfNode {
  let i = 0;
  const len = src.length;

  function skipWs(): void {
    while (i < len && /\s/.test(src[i]!)) i++;
  }

  function expect(ch: string): void {
    if (src[i] !== ch) {
      throw new Error(`VDF: expected '${ch}' at ${i}, got '${src.slice(i, i + 12)}'`);
    }
    i++;
  }

  function readString(): string {
    expect('"');
    let out = "";
    while (i < len && src[i] !== '"') {
      if (src[i] === "\\" && i + 1 < len) {
        out += src[i + 1]!;
        i += 2;
        continue;
      }
      out += src[i]!;
      i++;
    }
    if (i >= len) throw new Error("VDF: unterminated string");
    i++; // closing quote
    return out;
  }

  function parseObject(): VdfNode {
    expect("{");
    const obj: VdfNode = {};
    for (;;) {
      skipWs();
      if (i >= len) throw new Error("VDF: unexpected end of input inside object");
      if (src[i] === "}") {
        i++;
        return obj;
      }
      const key = readString();
      skipWs();
      const value: VdfValue = src[i] === "{" ? parseObject() : readString();
      obj[key] = value;
    }
  }

  const root: VdfNode = {};
  for (;;) {
    skipWs();
    if (i >= len) break;
    if (src[i] === "}") throw new Error("VDF: unexpected '}' at document root");
    const key = readString();
    skipWs();
    const value: VdfValue = src[i] === "{" ? parseObject() : readString();
    root[key] = value;
  }
  return root;
}

/** Read and parse a VDF file; returns null on any failure (missing/invalid). */
export async function parseVdfFile(path: string): Promise<VdfNode | null> {
  try {
    const text = await Bun.file(path).text();
    return parseVdf(text);
  } catch {
    return null;
  }
}
