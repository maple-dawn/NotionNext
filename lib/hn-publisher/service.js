import { randomUUID } from 'node:crypto'
import { getPublisherConfig, logEvent } from './config'
import { SourceError } from './errors'
import { extractStory } from './extract'
import { translateArticle } from './gemini'
import { fetchActiveStories } from './hn'
import {
  createNotionArticle,
  createNotionClient,
  discoverNotionDataSource,
  notionSlugExists
} from './notion'

const defaultDependencies = {
  fetchActiveStories,
  extractStory,
  translateArticle,
  createNotionClient,
  discoverNotionDataSource,
  notionSlugExists,
  createNotionArticle
}

export async function runHnPublisher(options = {}) {
  const config = options.config || getPublisherConfig()
  const dependencies = { ...defaultDependencies, ...options.dependencies }
  const runId = options.runId || randomUUID()
  const dryRun = Boolean(options.dryRun)
  logEvent('run_started', { runId, dryRun })

  const notion = dependencies.createNotionClient({
    token: config.notionToken
  })
  const dataSource = await dependencies.discoverNotionDataSource(
    notion,
    config.notionDatabaseId
  )
  const stories = await dependencies.fetchActiveStories(config.maxCandidates)

  for (const [index, story] of stories.entries()) {
    const candidateFields = {
      runId,
      rank: index + 1,
      hnItemId: story.id,
      slug: story.slug
    }
    if (
      await dependencies.notionSlugExists(notion, dataSource.id, story.slug)
    ) {
      logEvent('candidate_skipped', {
        ...candidateFields,
        reason: 'duplicate_slug'
      })
      continue
    }

    let article
    try {
      article = await dependencies.extractStory(story, {
        maxCharacters: config.maxSourceCharacters,
        maxBlocks: config.maxNotionBlocks
      })
    } catch (error) {
      if (error instanceof SourceError) {
        logEvent('candidate_skipped', {
          ...candidateFields,
          reason: error.code
        })
        continue
      }
      throw error
    }

    const translation = await dependencies.translateArticle(article, story, {
      apiKey: config.geminiApiKey,
      model: config.geminiModel
    })
    logEvent('translation_completed', {
      ...candidateFields,
      sourceCharacters: article.characterCount,
      blocks: article.blocks.length,
      durationMs: translation.durationMs
    })

    if (dryRun) {
      const result = {
        status: 'skipped',
        reason: 'dry_run',
        runId,
        hnItemId: story.id,
        slug: story.slug,
        sourceUrl: article.sourceUrl,
        translationDurationMs: translation.durationMs
      }
      logEvent('run_completed', result)
      return result
    }

    // Narrow the duplicate race between initial candidate selection and creation.
    if (
      await dependencies.notionSlugExists(notion, dataSource.id, story.slug)
    ) {
      logEvent('candidate_skipped', {
        ...candidateFields,
        reason: 'duplicate_slug_before_create'
      })
      continue
    }

    const page = await dependencies.createNotionArticle(notion, {
      dataSourceId: dataSource.id,
      schema: dataSource.properties,
      story,
      article,
      translation
    })
    const result = {
      status: 'published',
      runId,
      hnItemId: story.id,
      slug: story.slug,
      notionPageId: page.id,
      articleUrl: new URL(`/article/${story.slug}`, config.siteUrl).href
    }
    logEvent('run_completed', result)
    return result
  }

  const result = {
    status: 'skipped',
    reason: 'no_eligible_story',
    runId,
    checkedCandidates: stories.length
  }
  logEvent('run_completed', result)
  return result
}
