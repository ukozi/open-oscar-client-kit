import { FEEDBAG_DELETE, FEEDBAG_INSERT, FEEDBAG_UPDATE } from '../wire/feedbag.js';
import type { FeedbagItem } from '../wire/feedbag.js';
import type { Logger } from '../wire/types.js';
import { awayBody, awayRecordItem, awayText, chooseAwayItem, compareAwayRecords, followAwayRecord, freeAwayItemId, nextAwayRecord, placeholderAwayRecord, signOnAway } from '../model/away.js';
import type { AwayRecord } from '../model/away.js';
import type { UserInfoSnapshot } from '../model/instances.js';
import type { RichText } from '../model/rich-text.js';
import type { BosLink } from './bos-link.js';
import { OscarError } from './errors.js';
import type { Feedbag } from './feedbag.js';

export type AwayRecordOptions = {
  /** The feedbag item name of the record. */
  name: string;
  /** `own` creates the record and deletes duplicates; `follow` uses one while it exists; `remove` deletes it after client online and creates none. */
  role: 'own' | 'follow' | 'remove';
  /** The source this instance's own changes write. */
  source: 'phone' | 'desktop';
  /** False leaves a newer record unapplied. The default applies every one. */
  accept?: (record: AwayRecord) => boolean;
  /** From 0 to 1: picks the writer and the item id. The default is `Math.random`. */
  random?: () => number;
};

export type AwayRecordsDeps = {
  log: Logger;
  now: () => number;
  feedbag: Feedbag;
  ownAway: () => RichText | null;
  setAway: (link: BosLink, message: RichText | null, limit?: number) => Promise<void>;
  spawn: (task: string, run: () => Promise<unknown>) => void;
  emit: (event: { record: AwayRecord | null; itemId: number | null; applied: boolean }) => void;
};

/** What a sign-on knows before client online; `userInfo` is null below OService 4. */
export type AwaySignOn = { origin: 'start' | 'restore'; held: AwayRecord | null; userInfo: UserInfoSnapshot | null; limits: { awayAndProfileBytes: number } };

type Found = { keep: FeedbagItem; record: AwayRecord | null; duplicates: FeedbagItem[] };

const sameRecord = (a: AwayRecord | null, b: AwayRecord | null): boolean =>
  a === b || (a !== null && b !== null && (Object.keys(a) as (keyof AwayRecord)[]).every((key) => a[key] === b[key]));

function feedbagItem(name: string, itemId: number, record: AwayRecord): FeedbagItem {
  const item = awayRecordItem(name, itemId, record);
  return { ...item, attrs: [...item.attrs] };
}

function failureFields(error: OscarError): Record<string, unknown> {
  const { info } = error;
  return 'code' in info ? { code: info.code } : { kind: info.kind };
}

export class AwayRecords {
  private readonly random: () => number;
  private readonly work: (() => Promise<void>)[] = [];
  private writer = 0;
  private highestSeq = 0;
  private holding: AwayRecord | null = null;
  private itemId: number | null = null;
  private back: AwayRecord | null = null;
  private refused = false;
  private session = 0;
  private running = 0;

  constructor(
    private readonly options: AwayRecordOptions,
    private readonly deps: AwayRecordsDeps,
  ) {
    this.random = options.random ?? Math.random;
  }

  get held(): AwayRecord | null {
    return this.holding;
  }

  beginSession(): void {
    this.writer = Math.floor(this.random() * 2 ** 32) >>> 0;
  }

  reset(): void {
    this.session++;
    this.holding = null;
    this.itemId = null;
    this.back = null;
    this.highestSeq = 0;
    this.refused = false;
  }

  listChanged(link: BosLink): void {
    if (this.role() !== 'remove') this.start(() => this.follow(link));
  }

  preOnline(link: BosLink, ctx: AwaySignOn): Promise<void> {
    return this.serial(() => this.signOn(link, ctx));
  }

  afterOnline(link: BosLink): void {
    this.start(() => this.signedOn(link));
  }

  ownChange(link: BosLink, message: RichText | null, source: string = this.options.source): Promise<void> {
    return this.serial(() => this.change(link, message, source));
  }

  private role(): AwayRecordOptions['role'] {
    return this.refused ? 'remove' : this.options.role;
  }

  private get stale(): boolean {
    return this.running !== this.session;
  }

  private start(task: () => Promise<void>): void {
    this.deps.spawn('away-record', () =>
      this.serial(async () => {
        if (!this.stale) await task();
      }),
    );
  }

  // One piece of record work at a time, each against the list as it then stands; the first starts in the caller's turn.
  private serial(task: () => Promise<void>): Promise<void> {
    const session = this.session;
    return new Promise<void>((resolve, reject) => {
      this.work.push(async () => {
        this.running = session;
        await task().then(resolve, reject);
      });
      if (this.work.length === 1) void this.pump();
    });
  }

  private async pump(): Promise<void> {
    for (let next = this.work[0]; next; next = this.work[0]) {
      await next();
      this.work.shift();
    }
  }

  private stored(): Found | null {
    const found = chooseAwayItem(this.options.name, this.deps.feedbag.items);
    // The kept record has the highest seq of the readable ones.
    if (found?.record) this.highestSeq = Math.max(this.highestSeq, found.record.seq);
    return found;
  }

  private async change(link: BosLink, message: RichText | null, source: string): Promise<void> {
    // Plain text, so every instance writes the same bytes.
    const body = awayBody(awayText(message));
    await this.deps.setAway(link, body);
    const found = this.stored();
    const change = { away: body !== null, text: awayText(body), source };
    const now = this.deps.now();
    if (found?.record && this.role() !== 'remove') {
      const next = nextAwayRecord({ held: this.holding, highestSeq: this.highestSeq, writer: this.writer, change, now });
      await this.write(link, FEEDBAG_UPDATE, found.keep.itemId, next);
      return;
    }
    this.hold(change.away ? nextAwayRecord({ held: this.holding, highestSeq: 0, writer: this.writer, change, now }) : null, null, false);
  }

  private async follow(link: BosLink): Promise<void> {
    const found = this.stored();
    if (!found?.record) return;
    const { keep, record } = found;
    const own = this.deps.ownAway();
    const { verdict, locate } = followAwayRecord({ held: this.holding, own: { away: own !== null, text: awayText(own) }, incoming: record });
    if (verdict === 'answer' && this.holding) await this.write(link, FEEDBAG_UPDATE, keep.itemId, this.holding);
    if (verdict !== 'apply' || this.options.accept?.(record) === false) return;
    if (locate && !(await this.locate(link, locate))) return;
    this.hold(record, keep.itemId, true);
  }

  private async locate(link: BosLink, state: { away: boolean; text: string }, limit?: number): Promise<boolean> {
    try {
      await this.deps.setAway(link, state.away ? [{ text: state.text }] : null, limit);
      return true;
    } catch (error) {
      if (!(error instanceof OscarError)) throw error;
      this.deps.log.warn('the away record could not be applied', failureFields(error));
      return false;
    }
  }

  private async signOn(link: BosLink, ctx: AwaySignOn): Promise<void> {
    this.back = null;
    if (this.role() === 'remove') return;
    const found = this.stored();
    const stored = found?.record ?? null;
    const siblingAway = ctx.userInfo ? ctx.userInfo.instances.some((i) => i.away) : null;
    const plan = signOnAway({ origin: ctx.origin, held: ctx.held, stored, found: found !== null, siblingAway, writer: this.writer, source: this.options.source });
    // `accept` decides here, as it does for a record that comes later. A restore can take a newer stored record, and a start can take the away of another instance.
    // If `accept` refuses, the instance keeps the record that it held.
    const takes = ctx.origin === 'restore' ? ctx.held === null || (stored !== null && compareAwayRecords(stored, ctx.held) > 0) : plan.locate !== null;
    if (found?.record && takes && this.options.accept?.(found.record) === false) {
      if (ctx.origin === 'restore' && ctx.held) this.hold(ctx.held, found.keep.itemId, false);
      return;
    }
    if (plan.locate && !(await this.locate(link, plan.locate, ctx.limits.awayAndProfileBytes))) return;
    // With no stored record, a new placeholder is not held yet: it is held when it is written to the list after client online.
    // Then a record that comes later and is older than the held record gets the held record written over it.
    const hold = stored === null && plan.hold !== ctx.held ? null : plan.hold;
    this.hold(hold, found?.record ? found.keep.itemId : null, hold !== null && hold === stored);
    if (plan.write === 'back') this.back = hold;
  }

  // The server relays nothing to an instance still signing on, so this reads the list again.
  private async signedOn(link: BosLink): Promise<void> {
    try {
      await this.deps.feedbag.reload(link);
    } catch (error) {
      if (!(error instanceof OscarError)) throw error;
      this.deps.log.debug('the feedbag could not be read again', failureFields(error));
    }
    if (this.role() !== 'remove') await this.follow(link);
    await this.writeBack(link);
    await this.settle(link);
  }

  // Only while the away the sign-on found is still held: a newer record followed since stands.
  private async writeBack(link: BosLink): Promise<void> {
    const back = this.back;
    this.back = null;
    if (back === null || back !== this.holding || this.role() === 'remove') return;
    const found = this.stored();
    const change = { away: false, text: '', source: this.options.source };
    const next = nextAwayRecord({ held: back, highestSeq: this.highestSeq, writer: this.writer, change, now: this.deps.now() });
    if (found?.record) await this.write(link, FEEDBAG_UPDATE, found.keep.itemId, next);
    else this.hold(next, null, false);
  }

  private async settle(link: BosLink): Promise<void> {
    const found = this.stored();
    if (this.refused || this.options.role === 'follow') return;
    if (this.options.role === 'remove') {
      if (found) await this.remove(link, [found.keep, ...found.duplicates]);
      return;
    }
    if (!found?.record) {
      const record = this.holding ?? placeholderAwayRecord(this.writer, this.options.source);
      const itemId = found ? found.keep.itemId : freeAwayItemId(this.deps.feedbag.items, this.random);
      if (itemId !== null) await this.write(link, found ? FEEDBAG_UPDATE : FEEDBAG_INSERT, itemId, record);
    }
    if (found && found.duplicates.length > 0 && !this.refused) await this.remove(link, found.duplicates);
  }

  private async write(link: BosLink, subtype: typeof FEEDBAG_INSERT | typeof FEEDBAG_UPDATE, itemId: number, record: AwayRecord): Promise<void> {
    this.hold(record, itemId, false);
    try {
      await this.deps.feedbag.writeItems(link, subtype, [feedbagItem(this.options.name, itemId, record)]);
    } catch (error) {
      if (!(error instanceof OscarError)) throw error;
      if (error.info.kind !== 'refused') {
        this.deps.log.debug('the away record could not be written', failureFields(error));
        return;
      }
      if (this.stale || this.refused) return;
      this.refused = true;
      this.deps.log.warn('the away record was refused', failureFields(error));
      if (subtype === FEEDBAG_INSERT) this.hold(this.holding, null, false);
    }
  }

  private async remove(link: BosLink, items: FeedbagItem[]): Promise<void> {
    try {
      await this.deps.feedbag.writeItems(link, FEEDBAG_DELETE, items);
    } catch (error) {
      if (!(error instanceof OscarError)) throw error;
      this.deps.log.debug('the away record could not be deleted', failureFields(error));
    }
  }

  private hold(record: AwayRecord | null, itemId: number | null, applied: boolean): void {
    if (this.stale || (sameRecord(record, this.holding) && itemId === this.itemId)) return;
    this.holding = record;
    this.itemId = itemId;
    this.deps.emit({ record, itemId, applied });
  }
}
