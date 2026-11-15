export type RichTextRun = {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  color?: string;        // '#rrggbb', lower case
  face?: string;
  size?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  link?: string;         // http, https or mailto address
};
export type RichText = RichTextRun[];

const MAX_RUNS = 512;
const COLOR = /^#[0-9a-f]{6}$/i;
const FACE = /^[\p{L}\p{Nd} -]{1,64}$/u;
const LINK = /^(?:https?|mailto):/i;

function isSize(value: unknown): value is NonNullable<RichTextRun['size']> {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

export function sanitizeRichText(value: unknown): RichText | null {
  if (!Array.isArray(value) || value.length > MAX_RUNS) return null;
  const runs: RichText = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const { text, bold, italic, underline, color, face, size, link } = item as Record<string, unknown>;
    if (typeof text !== 'string') return null;
    if (text === '') continue;
    const run: RichTextRun = { text };
    if (bold === true) run.bold = true;
    if (italic === true) run.italic = true;
    if (underline === true) run.underline = true;
    if (typeof color === 'string' && COLOR.test(color)) run.color = color.toLowerCase();
    if (typeof face === 'string' && FACE.test(face)) run.face = face;
    if (isSize(size)) run.size = size;
    if (typeof link === 'string' && LINK.test(link)) run.link = link;
    runs.push(run);
  }
  return runs;
}
