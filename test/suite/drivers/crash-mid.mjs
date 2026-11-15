import { createInterface } from 'node:readline';

// Accepts signOn, then exits before it reports online.
for await (const line of createInterface({ input: process.stdin })) {
  const { id } = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ id, ok: true })}\n`, () => setTimeout(() => process.exit(3), 100));
}
