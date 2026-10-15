import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const KEYWORDS_PATH = path.join(ROOT, 'config', 'keywords.json');
const EXCLUDE_PATH = path.join(ROOT, 'config', 'exclude-keywords.json');
const RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1_000, 2_000];
const DEFAULT_AI_KEYWORDS = [
  'artificial intelligence',
  'intelligence artificielle',
  'inteligencia artificial',
  'inteligência artificial',
  'künstliche intelligenz',
  'yapay zeka',
  'kecerdasan buatan',
  '人工智能',
  '人工知能',
  '인공지능',
  'कृत्रिम बुद्धिमत्ता',
  'robot',
  'robotics',
  'robotic',
  'android',
  'cyborg',
  'ai',
];

const DEFAULT_KEYWORDS = {
  lookbackHours: 2_160,
  minDurationSeconds: 1_800,
  maxResultsPerQuery: 50,
  pagesPerQuery: 2,
  searchBudgetPerRun: 95,
  queries: [],
  aiKeywords: DEFAULT_AI_KEYWORDS,
};

export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

function isQuotaExceededError(error) {
  return error instanceof QuotaExceededError || error?.name === 'QuotaExceededError';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseDurationSeconds(isoDuration) {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(isoDuration || '');
  if (!match) return null;
  return (
    (Number(match[1]) || 0) * 86_400 +
    (Number(match[2]) || 0) * 3_600 +
    (Number(match[3]) || 0) * 60 +
    (Number(match[4]) || 0)
  );
}

export function decodeHtmlEntities(value = '') {
  const entities = {
    '&amp;': '&',
    '&apos;': "'",
    '&gt;': '>',
    '&lt;': '<',
    '&quot;': '"',
    '&#39;': "'",
  };
  return String(value)
    .replace(/&amp;|&apos;|&gt;|&lt;|&quot;|&#39;/g, entity => entities[entity])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

export function buildVideoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compilePatterns(patterns = []) {
  return patterns.flatMap(pattern => {
    try {
      return [new RegExp(pattern, 'iu')];
    } catch (error) {
      console.warn(`Ignoring invalid exclusion pattern: ${pattern}`, error.message);
      return [];
    }
  });
}

export function isExcludedVideo({ title, description, channelTitle }, excludeConfig = {}) {
  const haystack = normalize(`${title} ${description} ${channelTitle}`);
  const keywords = (excludeConfig.keywords || []).map(normalize).filter(Boolean);
  if (keywords.some(keyword => haystack.includes(keyword))) return true;
  return compilePatterns(excludeConfig.patterns).some(pattern => pattern.test(haystack));
}

function isVertical(info) {
  const width = Number(info?.player?.embedWidth);
  const height = Number(info?.player?.embedHeight);
  return width > 0 && height > width;
}

function isLive(info) {
  const state = info?.snippet?.liveBroadcastContent;
  return state === 'live' || state === 'upcoming';
}

function hasDramaSignal({ title, description, channelTitle }) {
  const haystack = normalize(`${title} ${description} ${channelTitle}`);
  return /(?:\b(?:drama|movie|film|episode|series|story|full\s+length)\b|영화|드라마|エイガ|映画|电影|影片|फिल्म|फ़िल्म|película|filme|film|film completa|film complet)/iu.test(haystack);
}

function hasAiSignal({ title, description, channelTitle }, aiKeywords = DEFAULT_AI_KEYWORDS) {
  const haystack = normalize(`${title} ${description} ${channelTitle}`);
  return aiKeywords.some(keyword => {
    const normalizedKeyword = normalize(keyword);
    if (!normalizedKeyword) return false;
    if (/^[\p{L}\p{N} ]+$/u.test(normalizedKeyword) && normalizedKeyword.includes(' ')) {
      return haystack.includes(normalizedKeyword);
    }
    if (/^[a-z0-9]+$/u.test(normalizedKeyword)) {
      return new RegExp(`\\b${normalizedKeyword.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'iu').test(haystack);
    }
    return haystack.includes(normalizedKeyword);
  });
}

export function isEligibleVideo(info, { minDurationSeconds = 1_800, aiKeywords = DEFAULT_AI_KEYWORDS } = {}, excludeConfig = {}) {
  if (!info?.id) return false;
  const metadata = {
    title: info.snippet?.title,
    description: info.snippet?.description,
    channelTitle: info.snippet?.channelTitle,
  };
  const durationSeconds = parseDurationSeconds(info.contentDetails?.duration);
  return Boolean(
    info.status?.privacyStatus === 'public' &&
    !isLive(info) &&
    !isVertical(info) &&
    durationSeconds != null &&
    durationSeconds >= minDurationSeconds &&
    hasDramaSignal(metadata) &&
    hasAiSignal(metadata, aiKeywords) &&
    !isExcludedVideo(metadata, excludeConfig)
  );
}

async function fetchJson(url, { fetchImpl = fetch, sleepFn = sleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      const body = await response.text();
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = { error: { message: body } };
      }
      if (response.ok) return payload;

      const message = payload?.error?.message || `HTTP ${response.status}`;
      const quotaExceeded = /quota exceeded|quotaexceeded|daily limit/iu.test(message) ||
        (payload?.error?.errors || []).some(item => /quota/iu.test(item.reason || '') || /daily/iu.test(item.reason || ''));
      if (quotaExceeded) throw new QuotaExceededError(`YouTube API quota exhausted: ${message}`);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      lastError = new Error(`YouTube API error ${response.status}: ${message}`);
      if (!retryable) throw lastError;
    } catch (error) {
      lastError = error;
      if (isQuotaExceededError(error)) throw error;
      if (error.message?.startsWith('YouTube API error') && !/HTTP (408|429|5\d\d)/u.test(error.message)) {
        throw error;
      }
    }
    if (attempt < RETRIES - 1) await sleepFn(RETRY_DELAYS_MS[attempt]);
  }
  throw lastError;
}

function apiUrl(endpoint, params, apiKey) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function searchByKeyword(keyword, { apiKey, publishedAfter, maxResults, regionCode, language, pageToken, fetchImpl, sleepFn }) {
  const url = apiUrl('search', {
    part: 'snippet',
    type: 'video',
    order: 'date',
    videoDuration: 'long',
    publishedAfter,
    maxResults,
    q: keyword,
    regionCode,
    relevanceLanguage: language,
    pageToken,
  }, apiKey);
  const data = await fetchJson(url, { fetchImpl, sleepFn });
  return {
    nextPageToken: data.nextPageToken || null,
    results: (data.items || [])
      .filter(item => item.id?.videoId)
      .map(item => ({
        videoId: item.id.videoId,
        matchedKeyword: keyword,
        searchTitle: decodeHtmlEntities(item.snippet?.title),
        searchChannelTitle: decodeHtmlEntities(item.snippet?.channelTitle),
      })),
  };
}

async function getVideoInfo(videoIds, { apiKey, fetchImpl, sleepFn }) {
  const info = new Map();
  for (let index = 0; index < videoIds.length; index += 50) {
    const ids = videoIds.slice(index, index + 50);
    if (!ids.length) continue;
    const url = apiUrl('videos', {
      part: 'snippet,contentDetails,status,player',
      maxHeight: 720,
      id: ids.join(','),
    }, apiKey);
    const data = await fetchJson(url, { fetchImpl, sleepFn });
    for (const item of data.items || []) info.set(item.id, item);
  }
  return info;
}

function metadataFromInfo(info) {
  const snippet = info.snippet || {};
  const durationSeconds = parseDurationSeconds(info.contentDetails?.duration);
  return {
    videoId: info.id,
    url: buildVideoUrl(info.id),
    title: decodeHtmlEntities(snippet.title),
    description: decodeHtmlEntities(snippet.description),
    channelId: snippet.channelId || null,
    channelTitle: decodeHtmlEntities(snippet.channelTitle),
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
    publishedAt: snippet.publishedAt || null,
    durationSeconds,
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function mergeKeywords(existingKeywords, discoveredKeywords) {
  return unique([...(existingKeywords || []), ...(discoveredKeywords || [])]).sort();
}

function unavailableRecord(existing, now) {
  if (existing.status === 'unavailable') return existing;
  return {
    ...existing,
    status: 'unavailable',
    lastVerifiedAt: now,
    unavailableAt: now,
  };
}

function availableRecord(existing, info, keywords, now, criteria, excludeConfig) {
  if (!isEligibleVideo(info, criteria, excludeConfig)) return unavailableRecord(existing, now);
  const metadata = metadataFromInfo(info);
  const next = {
    ...existing,
    ...metadata,
    matchedKeywords: mergeKeywords(existing.matchedKeywords, keywords),
    status: 'available',
    lastVerifiedAt: now,
    unavailableAt: null,
  };
  if (existing.status !== 'available') next.lastSeenAt = now;
  return next;
}

export async function buildCatalog({
  existingCatalog = { videos: [] },
  keywordConfig = DEFAULT_KEYWORDS,
  excludeConfig = {},
  apiKey,
  maxSearchCalls = null,
  now = new Date(),
  fetchImpl = fetch,
  sleepFn = sleep,
} = {}) {
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is required');
  const nowIso = new Date(now).toISOString();
  const criteria = {
    minDurationSeconds: Number(keywordConfig.minDurationSeconds) || 1_800,
    lookbackHours: Number(keywordConfig.lookbackHours) || 72,
    language: keywordConfig.language || 'en',
    countryCode: keywordConfig.code || 'global',
    regionCode: keywordConfig.regionCode || null,
    aiOnly: true,
  };
  const aiKeywords = keywordConfig.aiKeywords?.length ? keywordConfig.aiKeywords : DEFAULT_AI_KEYWORDS;
  criteria.aiKeywords = aiKeywords;
  const queries = unique(keywordConfig.queries || []);
  if (!queries.length) throw new Error('No YouTube search queries configured');

  const publishedAfter = new Date(new Date(now).getTime() - criteria.lookbackHours * 3_600_000).toISOString();
  const discovered = new Map();
  const pagesPerQuery = Math.min(Math.max(Number(keywordConfig.pagesPerQuery) || 1, 1), 10);
  const searchCallLimit = maxSearchCalls == null
    ? queries.length * pagesPerQuery
    : Math.max(Math.min(Number(maxSearchCalls) || 0, queries.length * pagesPerQuery), 0);
  const nextPageTokens = new Map();
  let searchCallsUsed = 0;
  let quotaExceeded = false;

  // Fetch page 1 for every query before fetching page 2. This keeps discovery broad
  // when the global daily search budget is smaller than queries * pages.
  searchLoop:
  for (let pageIndex = 0; pageIndex < pagesPerQuery && searchCallsUsed < searchCallLimit; pageIndex += 1) {
    for (const keyword of queries) {
      if (searchCallsUsed >= searchCallLimit) break;
      const pageToken = pageIndex === 0 ? undefined : nextPageTokens.get(keyword);
      if (pageIndex > 0 && !pageToken) continue;

      let response;
      try {
        response = await searchByKeyword(keyword, {
          apiKey,
          publishedAfter,
          maxResults: Math.min(Math.max(Number(keywordConfig.maxResultsPerQuery) || 50, 1), 50),
          regionCode: keywordConfig.regionCode,
          language: keywordConfig.language,
          pageToken,
          fetchImpl,
          sleepFn,
        });
      } catch (error) {
        if (!isQuotaExceededError(error)) throw error;
        quotaExceeded = true;
        console.warn(`${keywordConfig.code || 'global'}: YouTube search quota exhausted; saving partial results and stopping discovery.`);
        break searchLoop;
      }
      searchCallsUsed += 1;
      if (response.nextPageToken) nextPageTokens.set(keyword, response.nextPageToken);
      for (const result of response.results) {
        const previous = discovered.get(result.videoId) || { videoId: result.videoId, keywords: [] };
        previous.keywords = mergeKeywords(previous.keywords, [result.matchedKeyword]);
        discovered.set(result.videoId, previous);
      }
    }
  }

  const existingVideos = Array.isArray(existingCatalog.videos) ? existingCatalog.videos : [];
  // Keep the first occurrence of every existing ID. This lets us preserve the
  // catalog's append-only order while preventing legacy duplicate rows from
  // being copied forward.
  const existingById = new Map();
  for (const video of existingVideos) {
    if (video?.videoId && !existingById.has(video.videoId)) existingById.set(video.videoId, video);
  }
  const allIds = unique([...existingById.keys(), ...discovered.keys()]);
  let infoMap;
  try {
    infoMap = await getVideoInfo(allIds, { apiKey, fetchImpl, sleepFn });
  } catch (error) {
    if (!isQuotaExceededError(error)) throw error;
    console.warn(`${keywordConfig.code || 'global'}: YouTube metadata quota exhausted; keeping the existing catalog unchanged.`);
    return {
      ...existingCatalog,
      criteria,
      runStatus: 'partial_quota',
    };
  }
  const nextVideos = [];
  const copiedExistingIds = new Set();

  // Update records in their original order. Existing records are never
  // replaced by the newly discovered list; only their metadata/status changes.
  for (const existing of existingVideos) {
    if (!existing?.videoId) {
      // Preserve legacy/non-video records rather than deleting unknown data.
      nextVideos.push(existing);
      continue;
    }
    if (copiedExistingIds.has(existing.videoId)) continue;
    copiedExistingIds.add(existing.videoId);

    const videoId = existing.videoId;
    const info = infoMap.get(videoId);
    if (!info) {
      nextVideos.push(unavailableRecord(existing, nowIso));
      continue;
    }
    const found = discovered.get(videoId);
    const keywords = found?.keywords || existing.matchedKeywords || [];
    const next = availableRecord(existing, info, keywords, nowIso, criteria, excludeConfig);
    if (next.status === 'available' && !found && existing.status === 'available') {
      // Avoid a daily commit solely because an unchanged item was re-verified.
      next.lastVerifiedAt = existing.lastVerifiedAt || nowIso;
    }
    nextVideos.push(next);
  }

  for (const [videoId, found] of discovered) {
    if (existingById.has(videoId)) continue;
    const info = infoMap.get(videoId);
    if (!info || !isEligibleVideo(info, criteria, excludeConfig)) continue;
    const metadata = metadataFromInfo(info);
    nextVideos.push({
      ...metadata,
      matchedKeywords: found.keywords,
      status: 'available',
      discoveredAt: nowIso,
      lastSeenAt: nowIso,
      lastVerifiedAt: nowIso,
      unavailableAt: null,
    });
  }

  const oldVideos = JSON.stringify(existingVideos);
  const newVideos = JSON.stringify(nextVideos);
  return {
    generatedAt: oldVideos === newVideos && existingCatalog.generatedAt ? existingCatalog.generatedAt : nowIso,
    criteria,
    runStatus: quotaExceeded ? 'partial_quota' : 'complete',
    videos: nextVideos,
  };
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeCatalogAtomically(catalog, catalogPath) {
  await mkdir(path.dirname(catalogPath), { recursive: true });
  const temporaryPath = `${catalogPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, catalogPath);
}

function countryCatalogPath(code) {
  if (!/^[a-z0-9-]+$/u.test(code)) throw new Error(`Invalid country code: ${code}`);
  return path.join(ROOT, 'data', code, 'videos.json');
}

function getCountryConfigs(config) {
  if (Array.isArray(config.countries) && config.countries.length) {
    return config.countries.map(country => ({
      ...config,
      ...country,
      queries: country.queries || [],
    }));
  }
  return [{ ...config, code: config.code || 'global' }];
}

export async function main() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const [keywordConfig, excludeConfig] = await Promise.all([
    readJson(KEYWORDS_PATH, DEFAULT_KEYWORDS),
    readJson(EXCLUDE_PATH, {}),
  ]);
  const countryConfigs = getCountryConfigs(keywordConfig);
  const outputs = [];
  const totalSearchBudget = Math.max(Math.min(Number(keywordConfig.searchBudgetPerRun) || 95, 100), 1);
  const baseBudget = Math.floor(totalSearchBudget / countryConfigs.length);
  const extraBudget = totalSearchBudget % countryConfigs.length;

  for (const [index, countryConfig] of countryConfigs.entries()) {
    const catalogPath = countryCatalogPath(countryConfig.code);
    const existingCatalog = await readJson(catalogPath, { videos: [] });
    const countrySearchBudget = baseBudget + (index < extraBudget ? 1 : 0);
    const catalog = await buildCatalog({
      apiKey,
      keywordConfig: countryConfig,
      excludeConfig,
      existingCatalog,
      maxSearchCalls: countrySearchBudget,
    });
    const available = catalog.videos.filter(video => video.status === 'available').length;
    const unavailable = catalog.videos.length - available;
    console.log(`${countryConfig.code}: ${available} available, ${unavailable} unavailable (${countrySearchBudget} search-call budget, ${catalog.runStatus})`);
    outputs.push({ catalog, catalogPath });
    if (catalog.runStatus === 'partial_quota') {
      console.warn(`Stopping after ${countryConfig.code}; remaining countries will keep their previous catalogs until quota resets.`);
      break;
    }
  }

  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN=1: catalogs were not written');
    return outputs.map(output => output.catalog);
  }
  for (const output of outputs) await writeCatalogAtomically(output.catalog, output.catalogPath);
  return outputs.map(output => output.catalog);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
