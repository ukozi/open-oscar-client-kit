import { describe, expect, it } from 'vitest';
import type { PatchOp } from '../../../src/model/patch.js';
import { applyOps, diffState } from '../../../src/model/patch.js';

type State = {
  session: { state: string; screenName: string | null };
  groups: { id: number; buddies: { itemId: number; screenName: string }[] }[];
  conversations: Record<string, { id: string; lines: { id: string; text: string; status: string }[]; unread: number }>;
  rooms: Record<string, { state: string; occupants: string[] }>;
};
type Conversation = State['conversations'][string];
type Line = Conversation['lines'][number];
type Room = State['rooms'][string];

function line(id: string, text: string): Line {
  return { id, text, status: 'pending' };
}

function conversation(screenName: string, lines: Line[]): Conversation {
  return { id: `im:${screenName}`, lines, unread: 0 };
}

function base(): State {
  return {
    session: { state: 'online', screenName: 'Me' },
    groups: [{ id: 1, buddies: [{ itemId: 10, screenName: 'bob' }, { itemId: 11, screenName: 'carol' }] }],
    conversations: { 'im:bob': conversation('bob', [line('m1', 'one'), line('m2', 'two')]) },
    rooms: {},
  };
}

function bobOf(state: State): Conversation {
  const found = state.conversations['im:bob'];
  if (found === undefined) throw new Error('the state has no conversation im:bob');
  return found;
}

function withBob(state: State, change: (bob: Conversation) => Conversation): State {
  return { ...state, conversations: { ...state.conversations, 'im:bob': change(bobOf(state)) } };
}

describe('diffState', () => {
  it('says nothing when nothing changed', () => {
    const s = base();
    expect(diffState(s, s)).toEqual([]);
    expect(diffState(s, structuredClone(s))).toEqual([]);
  });

  it('appends a message as one append op', () => {
    const prev = base();
    const m3 = line('m3', 'three');
    const next = withBob(prev, (bob) => ({ ...bob, lines: [...bob.lines, m3] }));
    expect(diffState(prev, next)).toEqual([{ op: 'append', path: ['conversations', 'im:bob', 'lines'], items: [m3] }]);
  });

  it('edits a status in place', () => {
    const prev = base();
    const next = withBob(prev, (bob) => ({ ...bob, lines: bob.lines.map((l, i) => (i === 1 ? { ...l, status: 'sent' } : l)) }));
    expect(diffState(prev, next)).toEqual([{ op: 'set', path: ['conversations', 'im:bob', 'lines', 1, 'status'], value: 'sent' }]);
  });

  it('deletes a conversation that is gone', () => {
    const prev = base();
    const next = { ...prev, conversations: {} };
    expect(diffState(prev, next)).toEqual([{ op: 'delete', path: ['conversations', 'im:bob'] }]);
  });

  it('replaces an array that shrank or was reordered', () => {
    const prev = base();
    const group = prev.groups[0];
    if (group === undefined) throw new Error('the state has no group');
    const carol = group.buddies.slice(1);
    const next = { ...prev, groups: [{ ...group, buddies: carol }] };
    expect(diffState(prev, next)).toEqual([{ op: 'set', path: ['groups', 0, 'buddies'], value: carol }]);
  });

  it('sets a key that did not exist', () => {
    const prev = base();
    const carol = conversation('carol', []);
    const grown = withBob(prev, (bob) => ({ ...bob, lines: bob.lines.map((l, i) => (i === 0 ? { ...l, retriedAs: 'm9' } : l)) }));
    const next = { ...grown, conversations: { ...grown.conversations, 'im:carol': carol } };
    const ops = diffState(prev, next);
    expect(ops).toContainEqual({ op: 'set', path: ['conversations', 'im:carol'], value: carol });
    expect(ops).toContainEqual({ op: 'set', path: ['conversations', 'im:bob', 'lines', 0, 'retriedAs'], value: 'm9' });
    expect(applyOps(prev, ops)).toStrictEqual(next);
  });

  it("a room conversation's roster and state travel as patches and arrive equal", () => {
    const id = 'room:5:chimr-lobby';
    const talk: Conversation = { id, lines: [line('r1', 'one')], unread: 0 };
    const room: Room = { state: 'joined', occupants: ['Alice', 'Bob'] };
    const start = base();
    const prev: State = { ...start, conversations: { ...start.conversations, [id]: talk }, rooms: { [id]: room } };
    const r2 = line('r2', 'two');
    const next: State = {
      ...prev,
      conversations: { ...prev.conversations, [id]: { ...talk, lines: [...talk.lines, r2] } },
      rooms: { [id]: { ...room, state: 'rejoining', occupants: [...room.occupants, 'Carol'] } },
    };
    const ops = diffState(prev, next);
    expect(applyOps(prev, ops)).toStrictEqual(next);
    expect(ops).toContainEqual({ op: 'append', path: ['rooms', id, 'occupants'], items: ['Carol'] });
    expect(ops).toContainEqual({ op: 'append', path: ['conversations', id, 'lines'], items: [r2] });
    expect(ops).toContainEqual({ op: 'set', path: ['rooms', id, 'state'], value: 'rejoining' });
    expect(ops).toHaveLength(3);   // neither array travels whole
  });
});

type Transition = (state: State, random: (below: number) => number) => State;

const SESSION_STATES = ['offline', 'connecting', 'online', 'reconnecting'];
const STATUSES = ['pending', 'sent', 'failed'];
const NAMES = ['bob', 'carol', 'dave', 'erin'];

function pick<T>(items: readonly T[], random: (below: number) => number): T | undefined {
  return items[random(items.length)];
}

function changeConversation(state: State, id: string, change: (conversation: Conversation) => Conversation): State {
  const found = state.conversations[id];
  return found === undefined ? state : { ...state, conversations: { ...state.conversations, [id]: change(found) } };
}

const transitions: Record<string, Transition> = {
  appendLine: (state, random) => {
    const id = pick(Object.keys(state.conversations), random);
    if (id === undefined) return state;
    return changeConversation(state, id, (c) => ({ ...c, lines: [...c.lines, line(`g${random(1_000_000)}`, 'generated')] }));
  },
  changeStatus: (state, random) => {
    const id = pick(Object.keys(state.conversations), random);
    if (id === undefined) return state;
    return changeConversation(state, id, (c) => {
      const at = random(c.lines.length);
      const status = pick(STATUSES, random) ?? 'pending';
      return { ...c, lines: c.lines.map((l, i) => (i === at ? { ...l, status } : l)) };
    });
  },
  respellBuddy: (state, random) => {
    const groupAt = random(state.groups.length);
    const buddyAt = random(state.groups[groupAt]?.buddies.length ?? 0);
    const groups = state.groups.map((group, g) => g !== groupAt ? group : {
      ...group,
      buddies: group.buddies.map((b, i) => (i === buddyAt ? { ...b, screenName: b.screenName === b.screenName.toUpperCase() ? b.screenName.toLowerCase() : b.screenName.toUpperCase() } : b)),
    });
    return { ...state, groups };
  },
  addOrRemoveBuddy: (state, random) => {
    const [group, ...rest] = state.groups;
    if (group === undefined) return state;
    const buddies = group.buddies.length > 0 && random(2) === 0
      ? group.buddies.filter((_buddy, i) => i !== random(group.buddies.length))
      : [...group.buddies, { itemId: random(1_000_000), screenName: pick(NAMES, random) ?? 'bob' }];
    return { ...state, groups: [{ ...group, buddies }, ...rest] };
  },
  changeUnread: (state, random) => {
    const id = pick(Object.keys(state.conversations), random);
    if (id === undefined) return state;
    return changeConversation(state, id, (c) => ({ ...c, unread: random(50) }));
  },
  addOrDeleteConversation: (state, random) => {
    const name = pick(NAMES, random) ?? 'bob';
    const id = `im:${name}`;
    if (state.conversations[id] === undefined) return { ...state, conversations: { ...state.conversations, [id]: conversation(name, []) } };
    const { [id]: _gone, ...rest } = state.conversations;
    return { ...state, conversations: rest };
  },
  changeSessionState: (state, random) => ({ ...state, session: { ...state.session, state: pick(SESSION_STATES, random) ?? 'offline' } }),
  signOnOrOff: (state) => ({ ...state, session: { ...state.session, screenName: state.session.screenName === null ? 'Me' : null } }),
  addOrDeleteRoom: (state, random) => {
    const id = `room:5:${pick(NAMES, random) ?? 'bob'}`;
    if (state.rooms[id] === undefined) return { ...state, rooms: { ...state.rooms, [id]: { state: 'joining', occupants: [] } } };
    const { [id]: _gone, ...rest } = state.rooms;
    return { ...state, rooms: rest };
  },
  joinOrLeave: (state, random) => {
    const id = pick(Object.keys(state.rooms), random);
    const room = id === undefined ? undefined : state.rooms[id];
    if (id === undefined || room === undefined) return state;
    const occupants = room.occupants.length > 0 && random(2) === 0 ? room.occupants.slice(1) : [...room.occupants, pick(NAMES, random) ?? 'bob'];
    return { ...state, rooms: { ...state.rooms, [id]: { ...room, occupants } } };
  },
};

describe('applyOps', () => {
  it('applying the difference gives the next state, for generated transitions', () => {
    let seed = 1;
    const random = (below: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;   // a 32-bit linear congruential generator
      return below === 0 ? 0 : Math.floor((seed / 0x1_0000_0000) * below);
    };
    const kinds = Object.keys(transitions);
    const changed = new Set<string>();
    let prev = base();
    for (let step = 0; step < 300; step++) {
      const kind = pick(kinds, random) ?? '';
      const next = transitions[kind]?.(prev, random) ?? prev;
      const ops = diffState(prev, next);
      if (ops.length > 0) changed.add(kind);
      expect(applyOps(prev, ops)).toStrictEqual(next);
      prev = next;
    }
    expect([...changed].sort()).toEqual([...kinds].sort());   // every kind of transition produced a difference at least once
  });

  it('keeps what an op does not touch identical', () => {
    const prev = base();
    const m3 = line('m3', 'three');
    const result = applyOps(prev, [{ op: 'append', path: ['conversations', 'im:bob', 'lines'], items: [m3] }]);
    expect(bobOf(result).lines).toEqual([...bobOf(prev).lines, m3]);
    expect(result.groups).toBe(prev.groups);
    expect(bobOf(result).lines[0]).toBe(bobOf(prev).lines[0]);
    expect(bobOf(prev).lines).toHaveLength(2);   // it does not change the state it was given
  });

  const misfits: [string, PatchOp][] = [
    ['an append under a missing parent', { op: 'append', path: ['conversations', 'im:nobody', 'lines'], items: [] }],
    ['a set under a missing parent', { op: 'set', path: ['conversations', 'im:nobody', 'unread'], value: 1 }],
    ['a delete of a missing key', { op: 'delete', path: ['conversations', 'im:nobody'] }],
    ['an append to something that is not an array', { op: 'append', path: ['session', 'state'], items: ['x'] }],
  ];
  it.each(misfits)('refuses an op that does not fit: %s', (_label, op) => {
    const s = base();
    expect(() => applyOps(s, [op])).toThrow('patch does not fit the state');
  });
});
