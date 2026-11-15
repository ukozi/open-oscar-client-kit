import { isPlainObject } from './plain.js';

export type IdleReportChoice = 5 | 10 | 15 | 30 | 'never';
export type AutoAwayChoice = 5 | 10 | 15 | 30 | 60;
/** `autoAwayMessage`: null is the default text. */
export type IdleSettings = { reportAfterMinutes: IdleReportChoice; autoAway: boolean; autoAwayAfterMinutes: AutoAwayChoice; autoAwayMessage: string | null };

export const IDLE_REPORT_CHOICES: readonly IdleReportChoice[] = [5, 10, 15, 30, 'never'];
export const AUTO_AWAY_CHOICES: readonly AutoAwayChoice[] = [5, 10, 15, 30, 60];
export const DEFAULT_IDLE_SETTINGS: IdleSettings = { reportAfterMinutes: 10, autoAway: false, autoAwayAfterMinutes: 15, autoAwayMessage: null };

const KEYS: readonly string[] = ['reportAfterMinutes', 'autoAway', 'autoAwayAfterMinutes', 'autoAwayMessage'] satisfies (keyof IdleSettings)[];
const REPORT_CHOICES: readonly unknown[] = IDLE_REPORT_CHOICES;
const AWAY_CHOICES: readonly unknown[] = AUTO_AWAY_CHOICES;

const isReportChoice = (value: unknown): value is IdleReportChoice => REPORT_CHOICES.includes(value);
const isAwayChoice = (value: unknown): value is AutoAwayChoice => AWAY_CHOICES.includes(value);
const isAwayMessage = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value !== '' && value === value.trim());

export function parseIdleSettings(value: unknown): IdleSettings {
  const from = isPlainObject(value) ? value : {};
  const { reportAfterMinutes, autoAway, autoAwayAfterMinutes, autoAwayMessage } = from;
  return {
    reportAfterMinutes: isReportChoice(reportAfterMinutes) ? reportAfterMinutes : DEFAULT_IDLE_SETTINGS.reportAfterMinutes,
    autoAway: typeof autoAway === 'boolean' ? autoAway : DEFAULT_IDLE_SETTINGS.autoAway,
    autoAwayAfterMinutes: isAwayChoice(autoAwayAfterMinutes) ? autoAwayAfterMinutes : DEFAULT_IDLE_SETTINGS.autoAwayAfterMinutes,
    autoAwayMessage: isAwayMessage(autoAwayMessage) ? autoAwayMessage : DEFAULT_IDLE_SETTINGS.autoAwayMessage,
  };
}

export function isIdleSettings(value: unknown): value is IdleSettings {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(value, key))) return false;
  const { reportAfterMinutes, autoAway, autoAwayAfterMinutes, autoAwayMessage } = value;
  return isReportChoice(reportAfterMinutes) && typeof autoAway === 'boolean' && isAwayChoice(autoAwayAfterMinutes) && isAwayMessage(autoAwayMessage);
}

export function idleAfterSeconds(settings: IdleSettings): number | null {
  return settings.reportAfterMinutes === 'never' ? null : settings.reportAfterMinutes * 60;
}
