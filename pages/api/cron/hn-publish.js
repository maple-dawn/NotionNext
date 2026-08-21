import { timingSafeEqual } from 'node:crypto'
import { logEvent } from '@/lib/hn-publisher/config'
import { publicError } from '@/lib/hn-publisher/errors'
import { runHnPublisher } from '@/lib/hn-publisher/service'

function authorized(req, secret) {
  const authorization = req.headers.authorization || ''
  const expected = `Bearer ${secret}`
  const actualBuffer = Buffer.from(authorization)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res
      .status(405)
      .json({ status: 'failed', error: 'method_not_allowed' })
  }

  const cronSecret = process.env.CRON_SECRET?.trim()
  if (!cronSecret || cronSecret.length < 16) {
    logEvent('configuration_error', { field: 'CRON_SECRET' })
    return res.status(500).json({
      status: 'failed',
      error: 'server_not_configured'
    })
  }
  if (!authorized(req, cronSecret)) {
    return res.status(401).json({ status: 'failed', error: 'unauthorized' })
  }

  try {
    const result = await runHnPublisher({
      dryRun: req.query.dryRun === '1'
    })
    return res.status(200).json(result)
  } catch (error) {
    const safeError = publicError(error)
    logEvent('run_failed', {
      code: safeError.code,
      kind: safeError.kind,
      message: safeError.message
    })
    return res.status(500).json({
      status: 'failed',
      error: safeError.code,
      message: safeError.message
    })
  }
}
