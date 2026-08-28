/**
 * Simulate untagged template-literal escape processing.
 *
 * The chat webview script lives inside an HTML template literal in
 * ChatWebviewProvider.ts. Tests that extract a fragment of that script and
 * eval it MUST run the text through this decoder first — otherwise they
 * validate the raw source text rather than the code the browser actually
 * runs. The two differ: a template literal collapses `\\s` to `\s` and
 * silently DROPS the backslash of an unrecognized escape like `\s`, which
 * changes regex semantics without any syntax error.
 */
export function decodeTemplate(raw: string): string {
  let out = '';
  let i = 0;
  const escapes: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    '0': '\0',
  };
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '$' && raw[i + 1] === '{') {
      // Interpolation: skip balanced braces, emit a placeholder expression.
      let depth = 1;
      i += 2;
      while (depth > 0 && i < raw.length) {
        if (raw[i] === '{') {
          depth++;
        } else if (raw[i] === '}') {
          depth--;
        }
        i++;
      }
      out += '""';
      continue;
    }
    if (ch === '\\') {
      const nx = raw[i + 1];
      if (nx === 'u') {
        out += '"x"';
        i += 2;
        if (raw[i] === '{') {
          while (i < raw.length && raw[i] !== '}') {
            i++;
          }
          i++;
        } else {
          i += 4;
        }
        continue;
      }
      if (nx === 'x') {
        out += '"x"';
        i += 6;
        continue;
      }
      if (nx === '\\') {
        out += '\\';
        i += 2;
        continue;
      }
      if (nx === '`' || nx === '$') {
        out += nx;
        i += 2;
        continue;
      }
      if (nx === '\n') {
        out += '\n';
        i += 2;
        continue;
      }
      if (escapes[nx] !== undefined) {
        out += escapes[nx];
        i += 2;
        continue;
      }
      // Unrecognized escape: backslash is dropped (e.g. \/ -> /). This is the
      // collapse that breaks regex/string literals written with single backslashes.
      out += nx;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
