import { PublisherError } from './errors'
import { getBlockText } from './extract'

const GEMINI_BATCH_CHARACTERS = 10000
const GEMINI_TIMEOUT_MS = 20000

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++
        results[index] = await mapper(items[index], index)
      }
    }
  )
  await Promise.all(workers)
  return results
}

function parseJsonText(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch (error) {
    throw new PublisherError(
      'gemini_invalid_json',
      'Gemini returned invalid JSON',
      { cause: error }
    )
  }
}

function geminiErrorCode(status) {
  if (status === 401 || status === 403) return 'gemini_auth_failed'
  if (status === 429) return 'gemini_rate_limited'
  return 'gemini_request_failed'
}

export async function requestGeminiJson(
  prompt,
  { apiKey, model, fetchImpl = fetch, attempts = 3 }
) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1
          }
        })
      })
    } catch (error) {
      clearTimeout(timeout)
      if (attempt < attempts) {
        await delay(500 * 2 ** (attempt - 1))
        continue
      }
      throw new PublisherError(
        error?.name === 'AbortError'
          ? 'gemini_timeout'
          : 'gemini_request_failed',
        'Gemini request failed',
        { cause: error }
      )
    }
    clearTimeout(timeout)

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt < attempts) {
        const retryAfter = Number(response.headers.get('retry-after') || 0)
        await delay(
          retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1)
        )
        continue
      }
      throw new PublisherError(
        geminiErrorCode(response.status),
        `Gemini returned HTTP ${response.status}`,
        { status: response.status, retryable }
      )
    }

    const payload = await response.json()
    const output = payload?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
    if (!output) {
      const blockReason = payload?.promptFeedback?.blockReason
      throw new PublisherError(
        blockReason ? 'gemini_content_blocked' : 'gemini_empty_response',
        blockReason
          ? `Gemini blocked the translation request: ${blockReason}`
          : 'Gemini returned an empty response'
      )
    }
    return parseJsonText(output)
  }

  throw new PublisherError('gemini_request_failed', 'Gemini request failed')
}

function buildTranslationItems(blocks) {
  const items = []
  for (const block of blocks) {
    if (!block.segments || ['code', 'divider'].includes(block.type)) continue
    block.segments.forEach((segment, segmentIndex) => {
      if (!segment.text.trim()) return
      items.push({
        id: `${block.id}:${segmentIndex}`,
        text: segment.text
      })
    })
  }
  return items
}

function splitBatches(items) {
  const batches = []
  let current = []
  let currentLength = 0
  for (const item of items) {
    if (
      current.length > 0 &&
      currentLength + item.text.length > GEMINI_BATCH_CHARACTERS
    ) {
      batches.push(current)
      current = []
      currentLength = 0
    }
    current.push(item)
    currentLength += item.text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function translationPrompt(items) {
  return [
    '你是一名专业的英译中编辑。将 JSON 数组中每个 text 字段完整、忠实地翻译为简体中文。',
    '不要摘要、删减、扩写或添加说明。保留 URL、代码、产品名、公司名和无法可靠翻译的专有名词。',
    '必须返回严格 JSON：{"translations":[{"id":"原ID","text":"中文译文"}]}。',
    '每个输入 id 必须且只能出现一次，顺序保持一致。',
    JSON.stringify(items)
  ].join('\n')
}

function validateTranslationBatch(batch, result) {
  if (!Array.isArray(result?.translations)) {
    throw new PublisherError(
      'gemini_invalid_structure',
      'Gemini translation response has an invalid structure'
    )
  }
  if (result.translations.length !== batch.length) {
    throw new PublisherError(
      'gemini_incomplete_translation',
      'Gemini omitted one or more translation segments'
    )
  }
  const translated = new Map()
  batch.forEach((item, index) => {
    const output = result.translations[index]
    if (
      output?.id !== item.id ||
      typeof output.text !== 'string' ||
      !output.text
    ) {
      throw new PublisherError(
        'gemini_invalid_structure',
        'Gemini changed translation segment identifiers or returned empty text'
      )
    }
    translated.set(item.id, output.text)
  })
  return translated
}

async function translateMetadata(article, story, geminiOptions) {
  const excerpt = article.blocks.map(getBlockText).join('\n').slice(0, 12000)
  const prompt = [
    '根据以下英文文章生成博客元数据。',
    '返回严格 JSON：{"title":"忠实自然的简体中文标题","summary":"2到3句简体中文摘要"}。',
    '标题不要添加“HN译文”等前缀，不要使用 Markdown。摘要不得声称读过未提供的内容。',
    `原始标题：${article.sourceTitle || story.title}`,
    `正文节选：${excerpt}`
  ].join('\n')
  const result = await requestGeminiJson(prompt, geminiOptions)
  if (
    typeof result?.title !== 'string' ||
    !result.title.trim() ||
    typeof result?.summary !== 'string' ||
    !result.summary.trim()
  ) {
    throw new PublisherError(
      'gemini_invalid_metadata',
      'Gemini returned invalid article metadata'
    )
  }
  return {
    title: result.title.trim().slice(0, 500),
    summary: result.summary.trim().slice(0, 1900)
  }
}

export async function translateArticle(article, story, options) {
  const startedAt = Date.now()
  const metadataPromise = translateMetadata(article, story, options)
  const items = buildTranslationItems(article.blocks)
  const batches = splitBatches(items)
  const batchMapsPromise = mapWithConcurrency(batches, 2, async batch => {
    const result = await requestGeminiJson(translationPrompt(batch), options)
    return validateTranslationBatch(batch, result)
  })
  const [metadata, batchMaps] = await Promise.all([
    metadataPromise,
    batchMapsPromise
  ])
  const translations = new Map()
  for (const batchMap of batchMaps) {
    for (const [id, text] of batchMap) translations.set(id, text)
  }

  const blocks = article.blocks.map(block => ({
    ...block,
    segments: block.segments?.map((segment, segmentIndex) => {
      if (!segment.text.trim()) return { ...segment }
      const translated = translations.get(`${block.id}:${segmentIndex}`)
      if (typeof translated !== 'string') {
        throw new PublisherError(
          'gemini_incomplete_translation',
          'A translated segment is missing from the final article'
        )
      }
      return { ...segment, text: translated }
    })
  }))

  return {
    ...metadata,
    blocks,
    durationMs: Date.now() - startedAt
  }
}
