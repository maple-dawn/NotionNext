import { PublisherError } from './errors'

const NOTION_ID_PATTERN = /^[a-f0-9]{32}$/i

function required(env, name) {
  const value = env[name]?.trim()
  if (!value) {
    throw new PublisherError(
      'missing_configuration',
      `Missing required environment variable: ${name}`
    )
  }
  return value
}

export function getPublisherConfig(env = process.env) {
  const databaseId = required(env, 'NOTION_DATABASE_ID').replace(/-/g, '')
  if (!NOTION_ID_PATTERN.test(databaseId)) {
    throw new PublisherError(
      'invalid_notion_database_id',
      'NOTION_DATABASE_ID must be a 32-character Notion ID'
    )
  }

  const cronSecret = required(env, 'CRON_SECRET')
  if (cronSecret.length < 16) {
    throw new PublisherError(
      'weak_cron_secret',
      'CRON_SECRET must contain at least 16 characters'
    )
  }

  return {
    notionToken: required(env, 'NOTION_API_TOKEN'),
    notionDatabaseId: databaseId,
    geminiApiKey: required(env, 'GEMINI_API_KEY'),
    geminiModel: env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    cronSecret,
    maxCandidates: 10,
    maxSourceCharacters: 50000,
    maxNotionBlocks: 97,
    siteUrl: env.NEXT_PUBLIC_LINK?.trim() || 'https://www.imaple.tech'
  }
}

export function logEvent(event, fields = {}) {
  console.log(
    JSON.stringify({
      scope: 'hn-publisher',
      event,
      timestamp: new Date().toISOString(),
      ...fields
    })
  )
}
