import { createInterface } from 'node:readline';

// Writes one event in two chunks, then replies.
for await (const line of createInterface({ input: process.stdin })) {
  const { id } = JSON.parse(line);
  process.stdout.write('{"event":"im","from":"Al');
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.stdout.write('ice","text":"hi"}\n');
  process.stdout.write(`${JSON.stringify({ id, ok: true })}\n`);
}
