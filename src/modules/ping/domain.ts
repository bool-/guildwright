import { joinSafe, md, sanitizeStored, type SafeMarkdown } from '#core/text';

/** What `/ping` answers. A constant, so the command and its test cannot drift apart. */
export const PONG = md`✅ Pong.`;

/** `42s`, `5m`, `3h 12m`, `2d 0h 5m`: seconds only under a minute, never a bare `0`. */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `✅ Pong. Up for 3h 12m`. */
export function pongWithUptime(uptimeMs: number): SafeMarkdown {
  return joinSafe([PONG, md`Up for`, sanitizeStored(formatUptime(uptimeMs))], ' ');
}
