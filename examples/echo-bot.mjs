import { signOn } from 'open-oscar-client-kit';

const host = process.env.OSCAR_HOST ?? '127.0.0.1';
const port = Number(process.env.OSCAR_PORT ?? 5190);
const screenName = process.env.OSCAR_SCREEN_NAME ?? 'Bot';
const password = process.env.OSCAR_PASSWORD ?? 'botpass1';

const session = await signOn({
  screenName,
  password,
  app: 'echo-bot',
  server: { host, port },
});

const status = (buddy) => `${buddy.screenName} is ${buddy.online ? 'online' : 'offline'}${buddy.away ? ', away' : ''}`;

for (const buddy of session.buddies()) console.log(`${buddy.group}: ${status(buddy)}`);

session.on('buddy', (buddy) => console.log(status(buddy)));

session.on('im', async (im) => {
  if (im.autoResponse) return;
  console.log(`${im.from}: ${im.text}`);
  await session.sendIm(im.from, `You said: ${im.text}`);
});
