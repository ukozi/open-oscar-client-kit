import { run } from './base.mjs';

await run({
  async signOn(cmd, open) {
    let last;
    for (let i = 0; i < 5; i++) {
      try {
        return await open(cmd);
      } catch (error) {
        last = error;
      }
    }
    throw last;
  },
});
