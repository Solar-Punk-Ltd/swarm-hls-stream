/**
 * An `Error`'s `message` and `stack` are non-enumerable, so `JSON.stringify` renders one as `{}` and
 * every handler that passes an error straight to the logger prints nothing an operator can act on.
 */
function renderArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
}

export class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] - ${args.map(renderArg).join(' ')}`;
  }

  log(...args: any[]): void {
    console.log(this.formatMessage('log', ...args));
  }

  info(...args: any[]): void {
    console.info(this.formatMessage('info', ...args));
  }

  warn(...args: any[]): void {
    console.warn(this.formatMessage('warn', ...args));
  }

  error(...args: any[]): void {
    console.error(this.formatMessage('error', ...args));
  }

  debug(...args: any[]): void {
    console.debug(this.formatMessage('debug', ...args));
  }
}
