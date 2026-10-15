import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const KEYWORDS_PATH = path.join(ROOT, 'config', 'keywords.json');
const EXCLUDE_PATH = path.join(ROOT, 'config', 'exclude-keywords.json');
const CATALOG_PATH = path.join(ROOT, 'data', 'videos.json');
const RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1_000, 2_000];

const DEFAULT_KEYWORDS = {
  language: 'en',
  lookbackHours: 72,
  minDurationSeconds: 1_800,
  maxResultsPerQuery: 50,
  queries: [],
};

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
  return /\b(?:drama|movie|film|episode|series|story|full\s+length)\b/u.test(haystack);
}

export function isEligibleVideo(info, { minDurationSeconds = 1_800 } = {}, excludeConfig = {}) {
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
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      lastError = new Error(`YouTube API error ${response.status}: ${message}`);
      if (!retryable) throw lastError;
    } catch (error) {
      lastError = error;
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

async function searchByKeyword(keyword, { apiKey, publishedAfter, maxResults, fetchImpl, sleepFn }) {
  const url = apiUrl('search', {
    part: 'snippet',
    type: 'video',
    order: 'date',
    videoDuration: 'long',
    publishedAfter,
    maxResults,
    q: keyword,
  }, apiKey);
  const data = await fetchJson(url, { fetchImpl, sleepFn });
  return (data.items || [])
    .filter(item => item.id?.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      matchedKeyword: keyword,
      searchTitle: decodeHtmlEntities(item.snippet?.title),
      searchChannelTitle: decodeHtmlEntities(item.snippet?.channelTitle),
    }));
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
  };
  const queries = unique(keywordConfig.queries || []);
  if (!queries.length) throw new Error('No YouTube search queries configured');

  const publishedAfter = new Date(new Date(now).getTime() - criteria.lookbackHours * 3_600_000).toISOString();
  const discovered = new Map();
  for (const keyword of queries) {
    const results = await searchByKeyword(keyword, {
      apiKey,
      publishedAfter,
      maxResults: Math.min(Math.max(Number(keywordConfig.maxResultsPerQuery) || 50, 1), 50),
      fetchImpl,
      sleepFn,
    });
    for (const result of results) {
      const previous = discovered.get(result.videoId) || { videoId: result.videoId, keywords: [] };
      previous.keywords = mergeKeywords(previous.keywords, [result.matchedKeyword]);
      discovered.set(result.videoId, previous);
    }
  }

  const existingVideos = Array.isArray(existingCatalog.videos) ? existingCatalog.videos : [];
  const existingById = new Map(existingVideos.filter(video => video?.videoId).map(video => [video.videoId, video]));
  const allIds = unique([...existingById.keys(), ...discovered.keys()]);
  const infoMap = await getVideoInfo(allIds, { apiKey, fetchImpl, sleepFn });
  const nextVideos = [];

  for (const [videoId, existing] of existingById) {
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

  nextVideos.sort((left, right) => {
    if (left.status !== right.status) return left.status === 'available' ? -1 : 1;
    return String(right.publishedAt || '').localeCompare(String(left.publishedAt || ''));
  });

  const oldVideos = JSON.stringify(existingVideos);
  const newVideos = JSON.stringify(nextVideos);
  return {
    generatedAt: oldVideos === newVideos && existingCatalog.generatedAt ? existingCatalog.generatedAt : nowIso,
    criteria,
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

async function writeCatalogAtomically(catalog) {
  const temporaryPath = `${CATALOG_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, CATALOG_PATH);
}

export async function main() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const [keywordConfig, excludeConfig, existingCatalog] = await Promise.all([
    readJson(KEYWORDS_PATH, DEFAULT_KEYWORDS),
    readJson(EXCLUDE_PATH, {}),
    readJson(CATALOG_PATH, { videos: [] }),
  ]);
  const catalog = await buildCatalog({ apiKey, keywordConfig, excludeConfig, existingCatalog });
  const available = catalog.videos.filter(video => video.status === 'available').length;
  const unavailable = catalog.videos.length - available;
  console.log(`Catalog: ${available} available, ${unavailable} unavailable`);

  if (process.env.DRY_RUN === '1') {
    console.log('DRY_RUN=1: catalog was not written');
    return catalog;
  }
  await writeCatalogAtomically(catalog);
  return catalog;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
