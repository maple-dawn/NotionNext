import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { SourceError } from './errors'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_MAX_REDIRECTS = 4

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some(Number.isNaN)) return true
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0]
  if (!normalized) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true
  }
  return false
}

export function isPrivateAddress(address) {
  const version = isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  return true
}

export async function assertPublicUrl(rawUrl, { resolveHost = lookup } = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SourceError('invalid_source_url', 'Source URL is invalid')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SourceError(
      'unsupported_source_protocol',
      'Only HTTP and HTTPS source URLs are supported'
    )
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new SourceError(
      'private_source_url',
      'Private source URLs are not allowed'
    )
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new SourceError(
        'private_source_url',
        'Private source URLs are not allowed'
      )
    }
    return url
  }

  let addresses
  try {
    addresses = await resolveHost(hostname, { all: true, verbatim: true })
  } catch (error) {
    throw new SourceError(
      'source_dns_failed',
      'Source hostname cannot be resolved',
      {
        cause: error
      }
    )
  }

  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(item => isPrivateAddress(item.address))
  ) {
    throw new SourceError(
      'private_source_url',
      'Source hostname resolves to a private address'
    )
  }
  return url
}

async function readLimitedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > maxBytes) {
    throw new SourceError('source_too_large', 'Source response is too large')
  }

  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new SourceError('source_too_large', 'Source response is too large')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

export async function fetchPublicText(rawUrl, options = {}) {
  const {
    fetchImpl = fetch,
    resolveHost = lookup,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    acceptedContentTypes = ['text/html', 'application/xhtml+xml']
  } = options

  let currentUrl = await assertPublicUrl(rawUrl, { resolveHost })
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'NotionNext-HN-Publisher/1.0 (+https://www.imaple.tech/)'
        }
      })
    } catch (error) {
      clearTimeout(timeout)
      const code =
        error?.name === 'AbortError' ? 'source_timeout' : 'source_fetch_failed'
      throw new SourceError(code, 'Unable to fetch source article', {
        cause: error
      })
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timeout)
      const location = response.headers.get('location')
      if (!location || redirect === maxRedirects) {
        throw new SourceError(
          'source_redirect_failed',
          'Source redirect could not be followed safely'
        )
      }
      currentUrl = await assertPublicUrl(new URL(location, currentUrl).href, {
        resolveHost
      })
      continue
    }

    if (!response.ok) {
      clearTimeout(timeout)
      throw new SourceError(
        'source_http_error',
        `Source returned HTTP ${response.status}`,
        { status: response.status }
      )
    }

    const contentType = (response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (
      acceptedContentTypes.length > 0 &&
      !acceptedContentTypes.includes(contentType)
    ) {
      clearTimeout(timeout)
      throw new SourceError(
        'unsupported_source_type',
        `Unsupported source content type: ${contentType || 'unknown'}`
      )
    }

    try {
      return {
        text: await readLimitedBody(response, maxBytes),
        finalUrl: currentUrl.href,
        contentType
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new SourceError('source_timeout', 'Source body timed out', {
          cause: error
        })
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new SourceError('source_redirect_failed', 'Too many source redirects')
}
