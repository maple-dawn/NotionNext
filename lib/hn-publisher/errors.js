export class PublisherError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'PublisherError'
    this.code = code
    this.kind = options.kind || 'system'
    this.status = options.status
    this.retryable = Boolean(options.retryable)
    this.cause = options.cause
  }
}

export class SourceError extends PublisherError {
  constructor(code, message, options = {}) {
    super(code, message, { ...options, kind: 'source' })
    this.name = 'SourceError'
  }
}

export function publicError(error) {
  if (error instanceof PublisherError) {
    return {
      code: error.code,
      message: error.message,
      kind: error.kind
    }
  }
  return {
    code: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    kind: 'system'
  }
}
