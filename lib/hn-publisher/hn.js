import { parseHTML } from 'linkedom'
import { SourceError } from './errors'
import { fetchPublicText } from './http'

export const HN_ACTIVE_URL = 'https://news.ycombinator.com/active'
const HN_ITEM_API = 'https://hacker-news.firebaseio.com/v0/item'

export function parseActiveStories(html, limit = 10) {
  const { document } = parseHTML(html)
  const stories = []
  for (const row of document.querySelectorAll('tr.athing')) {
    const id = row.getAttribute('id')?.trim()
    const anchor = row.querySelector('.titleline > a')
    const title = anchor?.textContent?.trim()
    const href = anchor?.getAttribute('href')
    if (!id || !/^\d+$/.test(id) || !title || !href) continue

    const url = new URL(href, HN_ACTIVE_URL).href
    const isSelfPost =
      new URL(url).hostname === 'news.ycombinator.com' &&
      new URL(url).pathname === '/item'
    stories.push({
      id,
      title,
      url,
      isSelfPost,
      discussionUrl: `https://news.ycombinator.com/item?id=${id}`,
      slug: `hn-${id}`
    })
    if (stories.length >= limit) break
  }

  if (stories.length === 0) {
    throw new SourceError(
      'hn_active_parse_failed',
      'No stories were found on Hacker News Active'
    )
  }
  return stories
}

export async function fetchActiveStories(limit = 10, options = {}) {
  const { text } = await fetchPublicText(HN_ACTIVE_URL, {
    ...options,
    maxBytes: 1024 * 1024,
    acceptedContentTypes: ['text/html']
  })
  return parseActiveStories(text, limit)
}

export async function fetchHnItem(itemId, options = {}) {
  const { text } = await fetchPublicText(`${HN_ITEM_API}/${itemId}.json`, {
    ...options,
    maxBytes: 1024 * 1024,
    acceptedContentTypes: ['application/json', 'text/plain']
  })
  let item
  try {
    item = JSON.parse(text)
  } catch (error) {
    throw new SourceError('hn_item_parse_failed', 'HN item JSON is invalid', {
      cause: error
    })
  }
  if (!item || item.deleted || item.dead) {
    throw new SourceError('hn_item_unavailable', 'HN item is unavailable')
  }
  return item
}
