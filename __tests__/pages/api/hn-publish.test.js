/** @jest-environment node */

import handler from '@/pages/api/cron/hn-publish'
import { runHnPublisher } from '@/lib/hn-publisher/service'

jest.mock('@/lib/hn-publisher/service', () => ({
  runHnPublisher: jest.fn()
}))

function responseMock() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader: jest.fn((name, value) => {
      res.headers[name] = value
    }),
    status: jest.fn(code => {
      res.statusCode = code
      return res
    }),
    json: jest.fn(body => {
      res.body = body
      return res
    })
  }
  return res
}

describe('GET /api/cron/hn-publish', () => {
  const secret = 'a-secure-cron-secret'

  beforeEach(() => {
    process.env.CRON_SECRET = secret
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  test('rejects a missing or incorrect bearer token', async () => {
    const res = responseMock()
    await handler({ method: 'GET', headers: {}, query: {} }, res)
    expect(res.statusCode).toBe(401)
    expect(runHnPublisher).not.toHaveBeenCalled()
  })

  test('passes protected dry-run requests to the publisher', async () => {
    runHnPublisher.mockResolvedValue({
      status: 'skipped',
      reason: 'dry_run',
      hnItemId: '123'
    })
    const res = responseMock()
    await handler(
      {
        method: 'GET',
        headers: { authorization: `Bearer ${secret}` },
        query: { dryRun: '1' }
      },
      res
    )
    expect(runHnPublisher).toHaveBeenCalledWith({ dryRun: true })
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ reason: 'dry_run' })
  })

  test('rejects non-GET methods', async () => {
    const res = responseMock()
    await handler({ method: 'POST', headers: {}, query: {} }, res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.Allow).toBe('GET')
  })
})
