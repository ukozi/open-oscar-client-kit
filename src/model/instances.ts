export const MOBILE_CAPABILITY = '09461323-4C7F-11D1-8222-444553540000';

export type InstanceInfo = Readonly<{
  instance: number | null;
  flags: number;
  status: number;
  capabilities: readonly string[] | null;
  externalIp: string | null;
  idleMinutes: number | null;
  signedOnAt: number | null; // ms
  away: boolean;
  invisible: boolean;
  mobile: boolean;
}>;
export type UserInfoSnapshot = Readonly<{
  at: number;
  multiInstance: boolean;
  session: InstanceInfo;
  instances: readonly InstanceInfo[];
  self: InstanceInfo | null;
  selfMatches: number;
}>;

export function otherInstances(snapshot: UserInfoSnapshot): readonly InstanceInfo[] | null {
  const { self } = snapshot;
  if (!snapshot.multiInstance || self === null) return null;
  return snapshot.instances.filter((instance) => instance !== self);
}
