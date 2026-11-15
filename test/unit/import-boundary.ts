import { posix } from 'node:path';

export type KitUnit = 'wire' | 'client' | 'model';

export const KIT_UNITS: KitUnit[] = ['wire', 'client', 'model'];

// No unit imports a package.
const RULES: Record<KitUnit, { node: boolean; units: KitUnit[] }> = {
  wire: { node: true, units: ['wire'] },
  client: { node: true, units: ['client', 'wire', 'model'] },
  model: { node: false, units: ['model'] },
};

const WIRE_SPECIFIER = /^(node:[a-z/]+|\.\/[a-z-]+\.js)$/;

type Literal = { value: string; template: boolean };

// A `/` after one of these (or after one of the words below) starts a regular expression, not a division.
const BEFORE_REGEX = '(,=:[!&|?{;+-*%~^>';
const WORD_BEFORE_REGEX = /\b(?:return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await)$/;

// Blanks comments and literal text at the same offsets; `unclosed` means a template or block comment never ended.
function mask(source: string): { code: string; literals: Map<number, Literal>; unclosed: boolean } {
  const out: string[] = source.split('').map((char) => (char === '\n' ? '\n' : ' '));
  const literals = new Map<number, Literal>();
  const templates: number[] = [];
  let lastCode = '';
  let unclosedComment = false;
  let i = 0;
  const keep = (at: number): void => {
    out[at] = source[at] ?? '';
  };
  const templateText = (at: number): number => {
    let j = at;
    while (j < source.length) {
      if (source[j] === '\\') j += 2;
      else if (source[j] === '`') {
        keep(j);
        templates.pop();
        return j + 1;
      } else if (source[j] === '$' && source[j + 1] === '{') return j + 2;
      else j++;
    }
    return j;
  };
  const quoted = (at: number, quote: string): number => {
    let j = at + 1;
    while (j < source.length && source[j] !== quote && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    literals.set(at, { value: source.slice(at + 1, j), template: false });
    keep(at);
    if (source[j] === quote) keep(j);
    return j + 1;
  };
  const regex = (at: number): number => {
    let j = at + 1;
    let inClass = false;
    while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
      if (source[j] === '\\') j++;
      else if (source[j] === '[') inClass = true;
      else if (source[j] === ']') inClass = false;
      j++;
    }
    return j + 1;
  };
  while (i < source.length) {
    const char = source[i] ?? '';
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      unclosedComment = end < 0;
      i = end < 0 ? source.length : end + 2;
    } else if (char === "'" || char === '"') {
      i = quoted(i, char);
      lastCode = char;
    } else if (char === '`') {
      literals.set(i, { value: '', template: true });
      keep(i);
      templates.push(0);
      i = templateText(i + 1);
      lastCode = char;
    } else if (char === '/' && (lastCode === '' || BEFORE_REGEX.includes(lastCode) || WORD_BEFORE_REGEX.test(out.slice(Math.max(0, i - 12), i).join('').trimEnd()))) {
      i = regex(i);
      lastCode = '/';
    } else {
      const depth = templates.at(-1);
      if (char === '}' && depth === 0) {
        i = templateText(i + 1);
        continue;
      }
      if (depth !== undefined && (char === '{' || char === '}')) templates[templates.length - 1] = depth + (char === '{' ? 1 : -1);
      keep(i);
      if (!/\s/.test(char)) lastCode = char;
      i++;
    }
  }
  return { code: out.join(''), literals, unclosed: unclosedComment || templates.length > 0 };
}

// Each ends on the specifier's opening quote; a static clause holds no `=` or bracket, so it stays in one statement.
const STATIC_FROM = /(?:^|[;}])\s*(?:import|export)\b(?!\s*\()([^;=()'"`]*?)\bfrom\s*(?=['"])/gm;
const STATIC_BARE = /(?:^|[;}])\s*import\s*(?=['"])/gm;
const CALL = /\b(?:import|require)\s*\(\s*(?=['"`])/g;

type Scan = { imports: string[]; dynamicSpecifiers: number; unclosed: boolean };

function scan(source: string): Scan {
  const { code, literals, unclosed } = mask(source);
  const imports: string[] = [];
  let dynamicSpecifiers = 0;
  const literalAfter = (match: RegExpMatchArray): Literal | undefined => literals.get((match.index ?? 0) + match[0].length);
  for (const match of code.matchAll(STATIC_FROM)) {
    const literal = literalAfter(match);
    if (literal) imports.push(literal.value);
  }
  for (const match of code.matchAll(STATIC_BARE)) {
    const literal = literalAfter(match);
    if (literal) imports.push(literal.value);
  }
  for (const match of code.matchAll(CALL)) {
    const literal = literalAfter(match);
    if (literal?.template) dynamicSpecifiers++;
    else if (literal) imports.push(literal.value);
  }
  return { imports, dynamicSpecifiers, unclosed };
}

function ruleViolation(unit: KitUnit, file: string, specifier: string): string | undefined {
  const rule = RULES[unit];
  if (specifier.startsWith('node:')) {
    return rule.node ? undefined : `'${specifier}': ${unit} may not import Node built-ins`;
  }
  if (specifier.startsWith('.')) {
    const target = posix.join(posix.dirname(file), specifier);
    const allowed = rule.units.some((u) => target.startsWith(`src/${u}/`));
    return allowed ? undefined : `'${specifier}': ${unit} may not import ${target}`;
  }
  return `'${specifier}': ${unit} may not import this package`;
}

/** Every specifier a file imports, statically or through `import()` and `require()` with a plain string. */
export function specifiers(source: string): string[] {
  return scan(source).imports;
}

/** One violation per offending specifier, per template-literal specifier, and for a file not scanned to its end. */
export function violations(unit: KitUnit, file: string, source: string): string[] {
  const { imports, dynamicSpecifiers, unclosed } = scan(source);
  const found: string[] = Array.from({ length: dynamicSpecifiers }, () => `dynamic specifier: ${unit} must name what it imports in a plain string`);
  if (unclosed) found.push(`unterminated template or comment: ${unit} file could not be scanned to its end`);
  for (const specifier of new Set(imports)) {
    const broken = ruleViolation(unit, file, specifier);
    if (broken !== undefined) found.push(broken);
    else if (unit === 'wire' && !WIRE_SPECIFIER.test(specifier)) found.push(`'${specifier}': wire specifiers must match ${WIRE_SPECIFIER}`);
  }
  return found;
}
