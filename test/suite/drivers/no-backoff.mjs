import { run, write } from './base.mjs';

// Reports the back-off given as its argument, then reconnects after 50 ms.
const reported = Number(process.argv[2] ?? 50);

await run({
  onDrop(cmd, open, keep) {
    write({ event: 'reconnecting', attempt: 1, inMs: reported });
    setTimeout(() => open(cmd).then((s) => {
      keep(s);
      write({ event: 'online' });
    }), 50);
  },
});
