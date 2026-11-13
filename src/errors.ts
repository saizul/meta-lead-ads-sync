/** Base class of every error thrown by this package. */
export class LeadSyncError extends Error {
  /** True when retrying the same request later may succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.retryable = options.retryable ?? false;
  }
}

/** The configuration file is missing, unreadable or invalid. */
export class ConfigError extends LeadSyncError {}

/** A Graph API call failed. Carries Meta's error object when there was one. */
export class GraphApiError extends LeadSyncError {
  readonly status: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly type: string | undefined;
  readonly fbtraceId: string | undefined;

  constructor(
    message: string,
    details: {
      status: number;
      code?: number;
      subcode?: number;
      type?: string;
      fbtraceId?: string;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { retryable: details.retryable, cause: details.cause });
    this.status = details.status;
    this.code = details.code;
    this.subcode = details.subcode;
    this.type = details.type;
    this.fbtraceId = details.fbtraceId;
  }
}

/** A sink could not deliver a lead. */
export class SinkError extends LeadSyncError {
  readonly sink: string;
  readonly status: number | undefined;

  constructor(sink: string, message: string, options: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(`${sink}: ${message}`, options);
    this.sink = sink;
    this.status = options.status;
  }
}

/** Is an HTTP status worth retrying? 408, 425, 429 and 5xx are. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}
