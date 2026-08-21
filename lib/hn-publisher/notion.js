import { PublisherError } from './errors'

const NOTION_API_BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2025-09-03'
const RICH_TEXT_LIMIT = 1900

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function parseResponse(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { message: text.slice(0, 500) }
  }
}

export function createNotionClient({ token, fetchImpl = fetch }) {
  async function request(path, options = {}) {
    const attempts = options.attempts || 4
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response
      try {
        response = await fetchImpl(`${NOTION_API_BASE}${path}`, {
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Notion-Version': NOTION_VERSION
          },
          body: options.body ? JSON.stringify(options.body) : undefined
        })
      } catch (error) {
        if (attempt < attempts) {
          await delay(400 * 2 ** (attempt - 1))
          continue
        }
        throw new PublisherError(
          'notion_request_failed',
          'Notion API request failed',
          { cause: error }
        )
      }

      const payload = await parseResponse(response)
      if (response.ok) return payload

      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt < attempts) {
        const retryAfter = Number(response.headers.get('retry-after') || 0)
        await delay(
          retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** (attempt - 1)
        )
        continue
      }

      const code =
        response.status === 401 || response.status === 403
          ? 'notion_auth_failed'
          : response.status === 429
            ? 'notion_rate_limited'
            : 'notion_request_failed'
      throw new PublisherError(
        code,
        `Notion returned HTTP ${response.status}${
          payload?.message ? `: ${payload.message}` : ''
        }`,
        { status: response.status, retryable }
      )
    }
    throw new PublisherError(
      'notion_request_failed',
      'Notion API request failed'
    )
  }

  return { request }
}

const REQUIRED_PROPERTIES = {
  type: ['select'],
  status: ['select', 'status'],
  title: ['title'],
  summary: ['rich_text'],
  slug: ['rich_text'],
  category: ['select'],
  date: ['date'],
  tags: ['multi_select']
}

function assertSelectOption(property, value, fieldName) {
  const options = property[property.type]?.options || []
  if (!options.some(option => option.name === value)) {
    throw new PublisherError(
      'notion_schema_mismatch',
      `Notion property "${fieldName}" does not contain required option "${value}"`
    )
  }
}

export function validateNotionSchema(properties) {
  for (const [name, acceptedTypes] of Object.entries(REQUIRED_PROPERTIES)) {
    const property = properties?.[name]
    if (!property || !acceptedTypes.includes(property.type)) {
      throw new PublisherError(
        'notion_schema_mismatch',
        `Notion property "${name}" must have type ${acceptedTypes.join(' or ')}`
      )
    }
  }
  assertSelectOption(properties.type, 'Post', 'type')
  assertSelectOption(properties.status, 'Published', 'status')
  assertSelectOption(properties.category, '新闻', 'category')
  return properties
}

export async function discoverNotionDataSource(client, databaseId) {
  const database = await client.request(`/databases/${databaseId}`)
  const dataSources = database?.data_sources
  if (!Array.isArray(dataSources) || dataSources.length === 0) {
    throw new PublisherError(
      'notion_data_source_missing',
      'The Notion database has no accessible data source'
    )
  }
  if (dataSources.length !== 1) {
    throw new PublisherError(
      'notion_multiple_data_sources',
      'The Notion database contains multiple data sources; configure a unique target before publishing'
    )
  }
  const dataSourceId = dataSources[0]?.id
  if (!dataSourceId) {
    throw new PublisherError(
      'notion_data_source_missing',
      'Notion did not return a data source ID'
    )
  }
  const dataSource = await client.request(`/data_sources/${dataSourceId}`)
  return {
    id: dataSourceId,
    properties: validateNotionSchema(dataSource?.properties)
  }
}

export async function notionSlugExists(client, dataSourceId, slug) {
  const result = await client.request(`/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: {
      page_size: 1,
      filter: {
        property: 'slug',
        rich_text: { equals: slug }
      }
    }
  })
  return Array.isArray(result?.results) && result.results.length > 0
}

function splitRichTextContent(text) {
  const chunks = []
  let remaining = String(text || '')
  while (remaining.length > RICH_TEXT_LIMIT) {
    let splitAt = -1
    for (const marker of ['\n', '。', '！', '？', '. ', ' ']) {
      splitAt = Math.max(
        splitAt,
        remaining.lastIndexOf(marker, RICH_TEXT_LIMIT)
      )
    }
    if (splitAt < RICH_TEXT_LIMIT * 0.5) splitAt = RICH_TEXT_LIMIT
    else splitAt += 1
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function textObject(text, href, annotations) {
  const richText = {
    type: 'text',
    text: {
      content: text
    }
  }
  if (href && href.length <= 2000) richText.text.link = { url: href }
  if (annotations) {
    richText.annotations = {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default',
      ...annotations
    }
  }
  return richText
}

function segmentsToRichText(segments = []) {
  return segments.flatMap(segment =>
    splitRichTextContent(segment.text).map(chunk =>
      textObject(chunk, segment.href, segment.annotations)
    )
  )
}

function articleBlockToNotion(block) {
  if (block.type === 'divider') {
    return { object: 'block', type: 'divider', divider: {} }
  }
  if (block.type === 'code') {
    return {
      object: 'block',
      type: 'code',
      code: {
        rich_text: splitRichTextContent(block.text).map(text =>
          textObject(text)
        ),
        language: 'plain text'
      }
    }
  }

  const supportedTypes = new Set([
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'quote',
    'bulleted_list_item',
    'numbered_list_item'
  ])
  const type = supportedTypes.has(block.type) ? block.type : 'paragraph'
  return {
    object: 'block',
    type,
    [type]: { rich_text: segmentsToRichText(block.segments) }
  }
}

function selectValue(property, name) {
  if (property.type === 'status') return { status: { name } }
  return { select: { name } }
}

function singaporeDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function attributionBlocks(story, article) {
  return [
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          textObject('本文由晨枫博客自动翻译。原文：', undefined, {
            bold: true
          }),
          textObject(article.sourceTitle || story.title, article.sourceUrl),
          textObject(' · '),
          textObject('Hacker News 讨论', story.discussionUrl),
          textObject('。机器翻译仅供参考。')
        ]
      }
    },
    { object: 'block', type: 'divider', divider: {} }
  ]
}

export function buildNotionPagePayload({
  dataSourceId,
  schema,
  story,
  article,
  translation,
  now
}) {
  const children = [
    ...attributionBlocks(story, article),
    ...translation.blocks.map(articleBlockToNotion)
  ]
  if (children.length > 100) {
    throw new PublisherError(
      'notion_block_limit_exceeded',
      'Article exceeds the Notion create-page block limit'
    )
  }

  return {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    icon: { type: 'emoji', emoji: '📰' },
    properties: {
      type: selectValue(schema.type, 'Post'),
      status: selectValue(schema.status, 'Published'),
      title: { title: [textObject(translation.title)] },
      summary: { rich_text: [textObject(translation.summary)] },
      slug: { rich_text: [textObject(story.slug)] },
      category: selectValue(schema.category, '新闻'),
      date: { date: { start: singaporeDate(now) } },
      tags: {
        multi_select: [{ name: 'Hacker News' }, { name: '翻译' }]
      }
    },
    children
  }
}

export async function createNotionArticle(client, input) {
  const payload = buildNotionPagePayload(input)
  const result = await client.request('/pages', {
    method: 'POST',
    body: payload
  })
  if (!result?.id) {
    throw new PublisherError(
      'notion_invalid_create_response',
      'Notion created a page but did not return its ID'
    )
  }
  return { id: result.id, url: result.url }
}
