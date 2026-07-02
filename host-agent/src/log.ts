const PREFIX = '[host-agent]';

export function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn(PREFIX, ...args);
}

export function err(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(PREFIX, ...args);
}
