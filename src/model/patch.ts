export type PatchPath = readonly (string | number)[];
export type PatchOp =
  | { op: 'set'; path: PatchPath; value: unknown }
  | { op: 'delete'; path: PatchPath }
  | { op: 'append'; path: PatchPath; items: readonly unknown[] };
export type StatePatch = { seq: number; at: number; ops: PatchOp[] };
export type Snapshot<S> = { seq: number; at: number; state: S };

type Plain = Record<string, unknown>;
type Container = Plain | readonly unknown[];

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diff(prev: unknown, next: unknown, path: PatchPath, ops: PatchOp[]): void {
  if (Object.is(prev, next)) return;
  if (isPlain(prev) && isPlain(next)) {
    for (const key of Object.keys(prev)) {
      if (!Object.hasOwn(next, key)) ops.push({ op: 'delete', path: [...path, key] });
    }
    for (const key of Object.keys(next)) {
      if (Object.hasOwn(prev, key)) diff(prev[key], next[key], [...path, key], ops);
      else ops.push({ op: 'set', path: [...path, key], value: next[key] });
    }
    return;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (next.length > prev.length && prev.every((item, i) => item === next[i])) {
      ops.push({ op: 'append', path, items: next.slice(prev.length) });
      return;
    }
    if (next.length === prev.length) {
      for (let i = 0; i < next.length; i++) diff(prev[i], next[i], [...path, i], ops);
      return;
    }
  }
  ops.push({ op: 'set', path, value: next });
}

export function diffState<S extends object>(prev: S, next: S): PatchOp[] {
  const ops: PatchOp[] = [];
  diff(prev, next, [], ops);
  return ops;
}

function misfit(): never {
  throw new Error('patch does not fit the state');
}

function holds(container: Container, segment: string | number): boolean {
  if (Array.isArray(container)) return typeof segment === 'number' && Number.isInteger(segment) && segment >= 0 && segment < container.length;
  return typeof segment === 'string' && Object.hasOwn(container, segment);
}

function child(container: Container, segment: string | number): unknown {
  return (container as Plain)[segment];
}

function withChild(container: Container, segment: string | number, value: unknown): Container {
  if (Array.isArray(container)) {
    const copy = [...container];
    copy[segment as number] = value;
    return copy;
  }
  return { ...container, [segment]: value };
}

function applyAt(container: unknown, op: PatchOp, depth: number): Container {
  if (!isPlain(container) && !Array.isArray(container)) misfit();
  const segment = op.path[depth];
  if (segment === undefined) misfit();
  if (depth < op.path.length - 1) {
    if (!holds(container, segment)) misfit();
    return withChild(container, segment, applyAt(child(container, segment), op, depth + 1));
  }
  if (op.op === 'set') {
    const fits = Array.isArray(container)
      ? holds(container, segment) || segment === container.length
      : typeof segment === 'string';
    if (!fits) misfit();
    return withChild(container, segment, op.value);
  }
  if (!holds(container, segment)) misfit();
  if (op.op === 'append') {
    const target = child(container, segment);
    if (!Array.isArray(target)) misfit();
    return withChild(container, segment, [...target, ...op.items]);
  }
  if (Array.isArray(container)) misfit();   // an array never loses an item by `delete`: `diffState` replaces the array
  const { [segment]: _gone, ...rest } = container;
  return rest;
}

/** This copies only the objects and arrays on an op's path; an op that does not fit throws. */
export function applyOps<S extends object>(state: S, ops: readonly PatchOp[]): S {
  let result = state as Container;
  for (const op of ops) result = applyAt(result, op, 0);
  return result as S;
}
