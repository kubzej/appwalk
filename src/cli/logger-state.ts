import { Logger } from '../logging/logger.js';

export let appLogger = new Logger('normal');

export function setAppLogger(logger: Logger): void {
  appLogger = logger;
}
