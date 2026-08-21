/** @jest-environment node */

import { SourceError } from '@/lib/hn-publisher/errors'
import {
  compactArticleBlocks,
  extractStory,
  htmlToArticleBlocks
} from '@/lib/hn-publisher/extract'
import { parseActiveStories } from '@/lib/hn-publisher/hn'
import { assertPublicUrl, isPrivateAddress } from '@/lib/hn-publisher/http'
import { requestGeminiJson, translateArticle } from '@/lib/hn-publisher/gemini'
import {
  buildNotionPagePayload,
  discoverNotionDataSource,
  notionSlugExists,
  validateNotionSchema
} from '@/lib/hn-publisher/notion'
import { runHnPublisher } from '@/lib/hn-publisher/service'

function notionSchema() {
  return {
    type: {
      type: 'select',
      select: { options: [{ name: 'Post' }] }
    },
    status: {
      type: 'select',
      select: { options: [{ name: 'Published' }] }
    },
    title: { type: 'title', title: {} },
    summary: { type: 'rich_text', rich_text: {} },
    slug: { type: 'rich_text', rich_text: {} },
    category: {
      type: 'select',
      select: { options: [{ name: '新闻' }] }
    },
    date: { type: 'date', date: {} },
    tags: { type: 'multi_select', multi_select: { options: [] } }
  }
}

const story = {
  id: '123',
  title: 'Original title',
  url: 'https://example.com/post',
  discussionUrl: 'https://news.ycombinator.com/item?id=123',
  slug: 'hn-123',
  isSelfPost: false
}

describe('Hacker News publisher', () => {
  test('parses Active stories in page order', () => {
    const html = `
      <table>
        <tr class="athing" id="123"><td class="title"><span class="titleline"><a href="https://example.com/one">One</a></span></td></tr>
        <tr class="athing" id="124"><td class="title"><span class="titleline"><a href="item?id=124">Ask HN</a></span></td></tr>
      </table>`
    expect(parseActiveStories(html, 10)).toEqual([
      expect.objectContaining({ id: '123', title: 'One', isSelfPost: false }),
      expect.objectContaining({ id: '124', title: 'Ask HN', isSelfPost: true })
    ])
  })

  test('rejects private source addresses and accepts a public DNS result', async () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('192.168.1.10')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    await expect(
      assertPublicUrl('http://127.0.0.1/test')
    ).rejects.toMatchObject({
      code: 'private_source_url'
    })
    await expect(
      assertPublicUrl('https://example.com/story', {
        resolveHost: () =>
          Promise.resolve([{ address: '93.184.216.34', family: 4 }])
      })
    ).resolves.toMatchObject({ hostname: 'example.com' })
  })

  test('converts readable HTML while removing images and preserving links and code', () => {
    const blocks = htmlToArticleBlocks(
      `<h2>Heading</h2><p>Hello <a href="/docs">documentation</a>.</p><img src="x.jpg"><pre>const value = 1</pre>`,
      'https://example.com/post'
    )
    expect(blocks.map(block => block.type)).toEqual([
      'heading_2',
      'paragraph',
      'code'
    ])
    expect(blocks[1].segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'documentation',
          href: 'https://example.com/docs'
        })
      ])
    )
    expect(blocks[2].text).toBe('const value = 1')
  })

  test('extracts a complete article through the bounded public fetcher', async () => {
    const paragraph =
      'A reliable extraction test needs enough natural language for Readability. '.repeat(
        30
      )
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        `<html><head><title>Readable story</title></head><body><article><h1>Readable story</h1><p>${paragraph}</p><img src="cover.jpg"></article></body></html>`,
        {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        }
      )
    )
    const article = await extractStory(story, {
      maxCharacters: 50000,
      maxBlocks: 100,
      fetchOptions: {
        fetchImpl,
        resolveHost: () =>
          Promise.resolve([{ address: '93.184.216.34', family: 4 }])
      }
    })
    expect(article.sourceTitle).toBe('Readable story')
    expect(article.characterCount).toBeGreaterThan(500)
    expect(article.blocks.some(block => block.type === 'paragraph')).toBe(true)
    expect(JSON.stringify(article.blocks)).not.toContain('cover.jpg')
  })

  test('compacts adjacent paragraphs without dropping their text', () => {
    const blocks = ['one', 'two', 'three'].map((text, index) => ({
      id: `block-${index}`,
      type: 'paragraph',
      segments: [{ text }]
    }))
    const compacted = compactArticleBlocks(blocks, 2)
    expect(compacted).toHaveLength(2)
    expect(
      compacted
        .flatMap(block => block.segments)
        .map(item => item.text)
        .join('')
    ).toContain('one\n\ntwo')
  })

  test('accepts strict Gemini JSON and rejects malformed output', async () => {
    const successFetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"translations":[]}' }]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    await expect(
      requestGeminiJson('translate', {
        apiKey: 'key',
        model: 'model',
        fetchImpl: successFetch,
        attempts: 1
      })
    ).resolves.toEqual({ translations: [] })

    const malformedFetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'not-json' }] } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    await expect(
      requestGeminiJson('translate', {
        apiKey: 'key',
        model: 'model',
        fetchImpl: malformedFetch,
        attempts: 1
      })
    ).rejects.toMatchObject({ code: 'gemini_invalid_json' })
  })

  test('uses the full bounded article text to generate an AI summary title', async () => {
    const marker = 'CONTENT_AFTER_THE_OLD_EXCERPT_LIMIT'
    const article = {
      sourceTitle: 'Original title',
      blocks: [
        {
          id: 'code-1',
          type: 'code',
          text: `${'a'.repeat(13000)}${marker}`
        }
      ]
    }
    const fetchImpl = jest.fn((_url, options) => {
      const request = JSON.parse(options.body)
      expect(request.contents[0].parts[0].text).toContain(marker)
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      title: 'GitHub扩容失误引发近八小时故障',
                      summary: '中文摘要。'
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    await expect(
      translateArticle(article, story, {
        apiKey: 'key',
        model: 'model',
        fetchImpl,
        attempts: 1
      })
    ).resolves.toMatchObject({
      title: 'GitHub扩容失误引发近八小时故障',
      summary: '中文摘要。'
    })
  })

  test.each([
    { title: '', caseName: 'empty' },
    { title: '第一行\n第二行', caseName: 'multiline' },
    { title: '标'.repeat(61), caseName: 'long' }
  ])('rejects a $caseName Gemini title', async ({ title }) => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: JSON.stringify({ title, summary: '中文摘要。' }) }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    await expect(
      translateArticle(
        {
          sourceTitle: 'Original title',
          blocks: [{ id: 'code-1', type: 'code', text: 'const value = 1' }]
        },
        story,
        { apiKey: 'key', model: 'model', fetchImpl, attempts: 1 }
      )
    ).rejects.toMatchObject({ code: 'gemini_invalid_metadata' })
  })

  test('validates and discovers exactly one Notion data source', async () => {
    expect(validateNotionSchema(notionSchema())).toEqual(notionSchema())
    const request = jest
      .fn()
      .mockResolvedValueOnce({ data_sources: [{ id: 'source-1' }] })
      .mockResolvedValueOnce({ properties: notionSchema() })
    await expect(
      discoverNotionDataSource({ request }, 'database-1')
    ).resolves.toMatchObject({ id: 'source-1' })
    expect(request).toHaveBeenNthCalledWith(1, '/databases/database-1')
    expect(request).toHaveBeenNthCalledWith(2, '/data_sources/source-1')
  })

  test('queries Notion by deterministic slug', async () => {
    const request = jest.fn().mockResolvedValue({ results: [{ id: 'page-1' }] })
    await expect(
      notionSlugExists({ request }, 'source-1', 'hn-123')
    ).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('/data_sources/source-1/query', {
      method: 'POST',
      body: {
        page_size: 1,
        filter: { property: 'slug', rich_text: { equals: 'hn-123' } }
      }
    })
  })

  test('builds a published NotionNext page with translated content only', () => {
    const payload = buildNotionPagePayload({
      dataSourceId: 'source-1',
      schema: notionSchema(),
      story,
      article: {
        sourceTitle: 'Original title',
        sourceUrl: story.url
      },
      translation: {
        title: 'AI总结标题',
        summary: '中文摘要。',
        blocks: [
          {
            id: 'block-1',
            type: 'paragraph',
            segments: [{ text: '中文正文。' }]
          }
        ]
      },
      now: new Date('2026-08-21T01:00:00Z')
    })
    expect(payload.parent).toEqual({
      type: 'data_source_id',
      data_source_id: 'source-1'
    })
    expect(payload.properties.status).toEqual({ select: { name: 'Published' } })
    expect(payload.properties.slug.rich_text[0].text.content).toBe('hn-123')
    expect(payload.properties.date.date.start).toBe('2026-08-21')
    expect(payload.properties.title.title[0].text.content).toBe('AI总结标题')
    expect(payload.children).toHaveLength(1)
    const children = JSON.stringify(payload.children)
    expect(children).toContain('中文正文。')
    expect(children).not.toContain('本文由晨枫博客自动翻译')
    expect(children).not.toContain('机器翻译仅供参考')
    expect(children).not.toContain(story.url)
    expect(children).not.toContain(story.discussionUrl)
    expect(children).not.toContain('image')
  })

  test('allows exactly 100 Notion content blocks and rejects 101', () => {
    const buildPayload = count =>
      buildNotionPagePayload({
        dataSourceId: 'source-1',
        schema: notionSchema(),
        story,
        translation: {
          title: 'AI总结标题',
          summary: '中文摘要。',
          blocks: Array.from({ length: count }, (_, index) => ({
            id: `block-${index}`,
            type: 'paragraph',
            segments: [{ text: `正文${index}` }]
          }))
        }
      })

    expect(buildPayload(100).children).toHaveLength(100)
    expect(() => buildPayload(101)).toThrow(
      'Article exceeds the Notion create-page block limit'
    )
  })

  test('falls back after a source error and dry-run never writes to Notion', async () => {
    const secondStory = { ...story, id: '124', slug: 'hn-124' }
    const createNotionArticle = jest.fn()
    const extractStory = jest
      .fn()
      .mockRejectedValueOnce(new SourceError('source_paywalled', 'paywalled'))
      .mockResolvedValueOnce({
        sourceTitle: 'Second',
        sourceUrl: secondStory.url,
        characterCount: 1000,
        blocks: [
          { id: 'block-1', type: 'paragraph', segments: [{ text: 'Body' }] }
        ]
      })
    const result = await runHnPublisher({
      dryRun: true,
      runId: 'run-1',
      config: {
        notionToken: 'notion',
        notionDatabaseId: 'database',
        geminiApiKey: 'gemini',
        geminiModel: 'model',
        maxCandidates: 10,
        maxSourceCharacters: 50000,
        maxNotionBlocks: 100,
        siteUrl: 'https://www.imaple.tech'
      },
      dependencies: {
        createNotionClient: () => ({ request: jest.fn() }),
        discoverNotionDataSource: () =>
          Promise.resolve({
            id: 'source-1',
            properties: notionSchema()
          }),
        fetchActiveStories: () => Promise.resolve([story, secondStory]),
        notionSlugExists: () => Promise.resolve(false),
        extractStory,
        translateArticle: article =>
          Promise.resolve({
            title: '标题',
            summary: '摘要',
            blocks: article.blocks,
            durationMs: 12
          }),
        createNotionArticle
      }
    })
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'dry_run',
      hnItemId: '124'
    })
    expect(extractStory).toHaveBeenCalledTimes(2)
    expect(createNotionArticle).not.toHaveBeenCalled()
  })
})
