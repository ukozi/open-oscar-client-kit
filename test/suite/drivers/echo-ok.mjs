import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
  const { id, op } = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ id, ok: true })}\n`);
  if (op === 'exit') process.exit(0);
}
