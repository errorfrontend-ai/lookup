const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How long ago something happened, in words people use: "just now", "5 min ago", "2 hours ago",
 * "yesterday", "3 days ago", and after two weeks the date. `now` is passed in so it can be tested.
 */
export function formatRelativeTime(isoText: string, now: Date = new Date()): string {
  const then = new Date(isoText);
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < MINUTE_SECONDS) return 'just now';
  if (seconds < HOUR_SECONDS) return `${Math.floor(seconds / MINUTE_SECONDS)} min ago`;
  if (seconds < DAY_SECONDS) {
    const hours = Math.floor(seconds / HOUR_SECONDS);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(seconds / DAY_SECONDS);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const sameYear = then.getUTCFullYear() === now.getUTCFullYear();
  return `${then.getUTCDate()} ${MONTH_ABBREVIATIONS[then.getUTCMonth()]}${sameYear ? '' : ` ${then.getUTCFullYear()}`}`;
}
