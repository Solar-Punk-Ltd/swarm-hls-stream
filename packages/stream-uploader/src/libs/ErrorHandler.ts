import { getErrorMessage } from '../utils/common.js';

import { Logger } from './Logger.js';

export class ErrorHandler {
  private logger = Logger.getInstance();

  private static instance: ErrorHandler;

  private constructor() {}

  public static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  handleError(error: unknown, context?: string): void {
    const errorMessage = getErrorMessage(error);
    const stackTrace = error instanceof Error ? error.stack : null;

    this.logger.error(`Error in ${context || 'unknown context'}: ${errorMessage}`, {
      stack: stackTrace,
    });
  }
}
