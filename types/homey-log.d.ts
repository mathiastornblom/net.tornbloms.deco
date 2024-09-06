declare module 'homey-log' {
  export class Log {
    constructor(options: { homey: any });
    captureMessage(message: string, context?: object): void;
    captureException(exception: Error, context?: object): void;
  }
}
