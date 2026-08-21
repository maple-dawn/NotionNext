import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { SourceError } from './errors'
import { fetchHnItem } from './hn'
import { fetchPublicText } from './http'

const SKIPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'IMG',
  'PICTURE',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'CANVAS',
  'FORM',
  'BUTTON'
])

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
}

function safeLink(href, baseUrl) {
  if (!href) return undefined
  try {
    const url = new URL(href, baseUrl)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function collectSegments(node, baseUrl, inheritedHref) {
  const segments = []
  const append = (text, href) => {
    if (!text) return
    const last = segments.at(-1)
    if (last && last.href === href) {
      last.text += text
    } else {
      segments.push(href ? { text, href } : { text })
    }
  }

  const visit = (current, href) => {
    if (current.nodeType === 3) {
      append(normalizeText(current.nodeValue), href)
      return
    }
    if (current.nodeType !== 1 || SKIPPED_TAGS.has(current.tagName)) return
    if (current.tagName === 'BR') {
      append('\n', href)
      return
    }
    if (['UL', 'OL'].includes(current.tagName) && current !== node) return
    const nextHref =
      current.tagName === 'A'
        ? safeLink(current.getAttribute('href'), baseUrl)
        : href
    for (const child of current.childNodes) visit(child, nextHref)
  }

  visit(node, inheritedHref)
  if (segments.length === 0) return segments
  segments[0].text = segments[0].text.replace(/^\s+/, '')
  segments.at(-1).text = segments.at(-1).text.replace(/\s+$/, '')
  return segments.filter(segment => segment.text.length > 0)
}

function blockText(block) {
  return (
    block.segments?.map(segment => segment.text).join('') || block.text || ''
  )
}

function createBlock(type, node, baseUrl, extra = {}) {
  const segments = collectSegments(node, baseUrl)
  if (!segments.some(segment => segment.text.trim())) return null
  return { type, segments, ...extra }
}

export function htmlToArticleBlocks(html, baseUrl) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  const blocks = []

  const append = block => {
    if (block) blocks.push(block)
  }

  const visit = element => {
    if (
      !element ||
      element.nodeType !== 1 ||
      SKIPPED_TAGS.has(element.tagName)
    ) {
      return
    }
    const tag = element.tagName
    if (/^H[1-6]$/.test(tag)) {
      const level = Math.min(Number(tag.slice(1)), 3)
      append(createBlock(`heading_${level}`, element, baseUrl))
      return
    }
    if (tag === 'P') {
      append(createBlock('paragraph', element, baseUrl))
      return
    }
    if (tag === 'BLOCKQUOTE') {
      append(createBlock('quote', element, baseUrl))
      return
    }
    if (tag === 'PRE') {
      const code = normalizeText(element.textContent).trim()
      if (code) blocks.push({ type: 'code', text: code })
      return
    }
    if (tag === 'HR') {
      blocks.push({ type: 'divider' })
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      const type = tag === 'UL' ? 'bulleted_list_item' : 'numbered_list_item'
      for (const child of element.children) {
        if (child.tagName !== 'LI') continue
        append(createBlock(type, child, baseUrl))
        for (const nested of child.children) {
          if (nested.tagName === 'UL' || nested.tagName === 'OL') visit(nested)
        }
      }
      return
    }
    if (tag === 'TABLE') {
      for (const row of element.querySelectorAll('tr')) {
        const cells = [...row.children]
          .filter(cell => ['TH', 'TD'].includes(cell.tagName))
          .map(cell => cell.textContent.trim())
          .filter(Boolean)
        if (cells.length > 0) {
          blocks.push({
            type: 'paragraph',
            segments: [{ text: cells.join(' | ') }]
          })
        }
      }
      return
    }
    if (tag === 'FIGURE') {
      const caption = element.querySelector('figcaption')
      if (caption) append(createBlock('quote', caption, baseUrl))
      return
    }

    for (const child of element.children) visit(child)
  }

  for (const child of document.body.children) visit(child)
  return blocks.map((block, index) => ({ ...block, id: `block-${index + 1}` }))
}

function articleCharacterCount(blocks) {
  return blocks.reduce((sum, block) => sum + blockText(block).length, 0)
}

function looksPaywalled(text) {
  if (text.length >= 2500) return false
  return [
    /subscribe to (continue|read)/i,
    /sign in to (continue|read)/i,
    /already a subscriber/i,
    /订阅后继续阅读/,
    /登录后继续阅读/
  ].some(pattern => pattern.test(text))
}

export function compactArticleBlocks(blocks, maxBlocks) {
  const compacted = blocks.map(block => ({ ...block }))
  while (compacted.length > maxBlocks) {
    let mergeAt = -1
    for (let index = 0; index < compacted.length - 1; index++) {
      if (
        compacted[index].type === 'paragraph' &&
        compacted[index + 1].type === 'paragraph'
      ) {
        mergeAt = index
        break
      }
    }
    if (mergeAt < 0) {
      throw new SourceError(
        'too_many_article_blocks',
        'Article cannot fit in one Notion page request without losing structure'
      )
    }
    const first = compacted[mergeAt]
    const second = compacted[mergeAt + 1]
    compacted.splice(mergeAt, 2, {
      ...first,
      segments: [
        ...(first.segments || []),
        { text: '\n\n' },
        ...(second.segments || [])
      ]
    })
  }
  return compacted.map((block, index) => ({
    ...block,
    id: `block-${index + 1}`
  }))
}

function validateExtractedArticle(article, options) {
  const { minCharacters, maxCharacters, maxBlocks } = options
  if (!article.blocks.length) {
    throw new SourceError(
      'empty_article',
      'No readable article blocks were found'
    )
  }
  const characterCount = articleCharacterCount(article.blocks)
  const text = article.blocks.map(blockText).join('\n')
  if (characterCount < minCharacters) {
    throw new SourceError('article_too_short', 'Extracted article is too short')
  }
  if (characterCount > maxCharacters) {
    throw new SourceError('article_too_long', 'Extracted article is too long')
  }
  if (looksPaywalled(text)) {
    throw new SourceError('source_paywalled', 'Source appears to be paywalled')
  }
  return {
    ...article,
    characterCount,
    blocks: compactArticleBlocks(article.blocks, maxBlocks)
  }
}

export async function extractStory(story, options = {}) {
  const { maxCharacters = 50000, maxBlocks = 97, fetchOptions = {} } = options

  if (story.isSelfPost) {
    const item = await fetchHnItem(story.id, fetchOptions)
    if (!item.text) {
      throw new SourceError('empty_hn_self_post', 'HN self post has no body')
    }
    return validateExtractedArticle(
      {
        sourceTitle: item.title || story.title,
        sourceUrl: story.discussionUrl,
        blocks: htmlToArticleBlocks(item.text, story.discussionUrl)
      },
      { minCharacters: 120, maxCharacters, maxBlocks }
    )
  }

  const { text: html, finalUrl } = await fetchPublicText(
    story.url,
    fetchOptions
  )
  const { document } = parseHTML(html)
  const parsed = new Readability(document).parse()
  if (!parsed?.content) {
    throw new SourceError(
      'readability_failed',
      'Readable article content was not found'
    )
  }
  return validateExtractedArticle(
    {
      sourceTitle: parsed.title?.trim() || story.title,
      sourceUrl: finalUrl,
      blocks: htmlToArticleBlocks(parsed.content, finalUrl)
    },
    { minCharacters: 500, maxCharacters, maxBlocks }
  )
}

export function getBlockText(block) {
  return blockText(block)
}
