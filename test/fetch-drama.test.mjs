import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCatalog,
  buildVideoUrl,
  decodeHtmlEntities,
  isEligibleVideo,
  isExcludedVideo,
  parseDurationSeconds,
} from '../scripts/fetch-drama.mjs';

function videoInfo({
  id = 'video-1',
  title = 'AI English Full Drama Movie',
  description = 'A complete AI English drama film story.',
  duration = 'PT30M',
  privacyStatus = 'public',
  liveBroadcastContent = 'none',
  width = 1280,
  height = 720,
} = {}) {
  return {
    id,
    snippet: {
      title,
      description,
      channelId: 'channel-1',
      channelTitle: 'Drama Channel',
      publishedAt: '2026-10-15T00:00:00Z',
      liveBroadcastContent,
      thumbnails: { high: { url: `https://img.youtube.com/${id}/hqdefault.jpg` } },
    },
    contentDetails: { duration },
    status: { privacyStatus },
    player: { embedWidth: width, embedHeight: height },
  };
}

test('parses ISO-8601 durations including days', () => {
  assert.equal(parseDurationSeconds('PT30M'), 1800);
  assert.equal(parseDurationSeconds('PT1H2M3S'), 3723);
  assert.equal(parseDurationSeconds('P1DT1H'), 90000);
  assert.equal(parseDurationSeconds('invalid'), null);
});

test('decodes HTML entities and encodes YouTube URLs', () => {
  assert.equal(decodeHtmlEntities('A &amp; B &#39;test&#39; &#x1F525;'), "A & B 'test' 🔥");
  assert.equal(buildVideoUrl('id with spaces'), 'https://www.youtube.com/watch?v=id%20with%20spaces');
});

test('accepts exactly 30 minutes and rejects shorter, live, vertical, private and excluded videos', () => {
  const excludeConfig = { keywords: ['trailer'], patterns: ['(?:^|\\s)#?shorts(?:\\s|$)'] };
  assert.equal(isEligibleVideo(videoInfo({ duration: 'PT30M' }), { minDurationSeconds: 1800 }, excludeConfig), true);
  assert.equal(isEligibleVideo(videoInfo({ title: 'English Full Drama Movie', description: 'A complete English drama film story.' }), { minDurationSeconds: 1800 }, excludeConfig), false);
  assert.equal(isEligibleVideo(videoInfo({ duration: 'PT29M59S' }), { minDurationSeconds: 1800 }, excludeConfig), false);
  assert.equal(isEligibleVideo(videoInfo({ liveBroadcastContent: 'live' }), {}, excludeConfig), false);
  assert.equal(isEligibleVideo(videoInfo({ width: 720, height: 1280 }), {}, excludeConfig), false);
  assert.equal(isEligibleVideo(videoInfo({ privacyStatus: 'private' }), {}, excludeConfig), false);
  assert.equal(isEligibleVideo(videoInfo({ title: 'English Full Drama Movie Trailer' }), {}, excludeConfig), false);
  assert.equal(isEligibleVideo(videoInfo({ title: 'English Full Drama Movie #shorts' }), {}, excludeConfig), false);
});

test('matches exclusions against title, description and channel', () => {
  const config = { keywords: ['reaction'], patterns: ['\\brecap\\b'] };
  assert.equal(isExcludedVideo({ title: 'A film', description: 'Movie recap', channelTitle: 'Channel' }, config), true);
  assert.equal(isExcludedVideo({ title: 'A full drama movie', description: 'Original story', channelTitle: 'Channel' }, config), false);
});

test('deduplicates results, marks unavailable videos and restores recovered videos', async () => {
  const calls = [];
  const responses = {
    'english full drama movie': [
      { id: { videoId: 'new-1' }, snippet: { title: 'New AI &amp; Drama', channelTitle: 'Channel' } },
      { id: { videoId: 'recovered' }, snippet: { title: 'AI Recovered', channelTitle: 'Channel' } },
    ],
    'english drama full movie': [
      { id: { videoId: 'new-1' }, snippet: { title: 'AI Duplicate', channelTitle: 'Channel' } },
      { id: { videoId: 'trailer' }, snippet: { title: 'AI Drama Trailer', channelTitle: 'Channel' } },
    ],
  };
  const details = new Map([
    ['new-1', videoInfo({ id: 'new-1', title: 'New & Drama AI', duration: 'PT45M' })],
    ['recovered', videoInfo({ id: 'recovered', title: 'AI Recovered Full Drama', duration: 'PT35M' })],
    ['trailer', videoInfo({ id: 'trailer', title: 'AI Drama Trailer', duration: 'PT45M' })],
  ]);
  const fetchImpl = async url => {
    calls.push(String(url));
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/search')) {
      return new Response(JSON.stringify({ items: responses[parsed.searchParams.get('q')] || [] }), { status: 200 });
    }
    const items = parsed.searchParams.get('id').split(',').flatMap(id => details.get(id) || []);
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
  const now = new Date('2026-10-15T00:00:00Z');
  const result = await buildCatalog({
    apiKey: 'test-key',
    now,
    fetchImpl,
    sleepFn: async () => {},
    keywordConfig: {
      language: 'en',
      regionCode: 'US',
      lookbackHours: 2160,
      minDurationSeconds: 1800,
      queries: Object.keys(responses),
    },
    excludeConfig: { keywords: ['trailer'], patterns: [] },
    existingCatalog: {
      generatedAt: '2026-10-14T00:00:00.000Z',
      videos: [
        {
          videoId: 'old',
          title: 'Old Drama',
          status: 'available',
          matchedKeywords: [],
          discoveredAt: '2026-10-10T00:00:00Z',
        },
        {
          videoId: 'recovered',
          title: 'Old Recovered',
          status: 'unavailable',
          matchedKeywords: ['old query'],
          discoveredAt: '2026-10-10T00:00:00Z',
          unavailableAt: '2026-10-14T00:00:00Z',
        },
      ],
    },
  });

  assert.equal(calls.filter(call => call.includes('/search?')).length, 2);
  const firstSearch = new URL(calls.find(call => call.includes('/search?')));
  assert.equal(firstSearch.searchParams.get('regionCode'), 'US');
  assert.equal(firstSearch.searchParams.get('relevanceLanguage'), 'en');
  assert.equal(new Date(now).getTime() - new Date(firstSearch.searchParams.get('publishedAfter')).getTime(), 2160 * 3_600_000);
  assert.equal(result.videos.filter(video => video.videoId === 'new-1').length, 1);
  assert.deepEqual(result.videos.find(video => video.videoId === 'new-1').matchedKeywords, [...Object.keys(responses)].sort());
  assert.equal(result.videos.find(video => video.videoId === 'old').status, 'unavailable');
  assert.equal(result.videos.find(video => video.videoId === 'recovered').status, 'available');
  assert.equal(result.videos.some(video => video.videoId === 'trailer'), false);
  assert.equal(result.videos.every(video => video.videoId !== 'new-1' || video.durationSeconds >= 1800), true);
  assert.deepEqual(result.videos.map(video => video.videoId), ['old', 'recovered', 'new-1']);
});

test('updates existing IDs in place and appends only genuinely new videos', async () => {
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/search')) {
      return new Response(JSON.stringify({
        items: [
          { id: { videoId: 'existing' }, snippet: { title: 'Updated AI Drama' } },
          { id: { videoId: 'new-video' }, snippet: { title: 'New AI Drama' } },
        ],
      }), { status: 200 });
    }
    const ids = parsed.searchParams.get('id').split(',');
    return new Response(JSON.stringify({
      items: ids
        .filter(id => id !== 'untouched')
        .map(id => videoInfo({ id, title: `AI Drama ${id}`, duration: 'PT40M' })),
    }), { status: 200 });
  };

  const result = await buildCatalog({
    apiKey: 'test-key',
    now: new Date('2026-10-15T00:00:00Z'),
    fetchImpl,
    sleepFn: async () => {},
    keywordConfig: {
      language: 'en',
      regionCode: 'US',
      queries: ['AI drama movie'],
      minDurationSeconds: 1800,
    },
    existingCatalog: {
      generatedAt: '2026-10-14T00:00:00.000Z',
      videos: [
        { videoId: 'existing', title: 'Old title', status: 'available', matchedKeywords: ['old query'] },
        { videoId: 'untouched', title: 'Keep this record', status: 'unavailable', matchedKeywords: [] },
      ],
    },
  });

  assert.deepEqual(result.videos.map(video => video.videoId), ['existing', 'untouched', 'new-video']);
  assert.equal(result.videos.filter(video => video.videoId === 'existing').length, 1);
  assert.equal(result.videos.find(video => video.videoId === 'existing').title, 'AI Drama existing');
  assert.equal(result.videos.find(video => video.videoId === 'untouched').status, 'unavailable');
  assert.deepEqual(result.videos.find(video => video.videoId === 'existing').matchedKeywords, ['AI drama movie', 'old query']);
});

test('retries transient YouTube API failures', async () => {
  let attempts = 0;
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/search')) {
      attempts += 1;
      if (attempts < 3) return new Response('{"error":{"message":"busy"}}', { status: 429 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };

  const result = await buildCatalog({
    apiKey: 'test-key',
    now: new Date('2026-10-15T00:00:00Z'),
    fetchImpl,
    sleepFn: async () => {},
    keywordConfig: { queries: ['english drama full movie'], minDurationSeconds: 1800, lookbackHours: 72 },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(result.videos, []);
});

test('paginates search results when a second page is available', async () => {
  const searchUrls = [];
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/search')) {
      searchUrls.push(parsed);
      const secondPage = parsed.searchParams.get('pageToken') === 'page-2';
      const id = secondPage ? 'page-two' : 'page-one';
      return new Response(JSON.stringify({
        items: [{ id: { videoId: id }, snippet: { title: `AI Drama ${id}`, channelTitle: 'Channel' } }],
        ...(secondPage ? {} : { nextPageToken: 'page-2' }),
      }), { status: 200 });
    }
    const ids = new URL(url).searchParams.get('id').split(',');
    return new Response(JSON.stringify({
      items: ids.map(id => videoInfo({ id, title: `AI Drama ${id}`, duration: 'PT40M' })),
    }), { status: 200 });
  };

  const result = await buildCatalog({
    apiKey: 'test-key',
    now: new Date('2026-10-15T00:00:00Z'),
    fetchImpl,
    sleepFn: async () => {},
    keywordConfig: {
      language: 'en',
      regionCode: 'US',
      queries: ['artificial intelligence drama movie'],
      pagesPerQuery: 2,
      minDurationSeconds: 1800,
    },
  });

  assert.equal(searchUrls.length, 2);
  assert.equal(searchUrls[1].searchParams.get('pageToken'), 'page-2');
  assert.deepEqual(result.videos.map(video => video.videoId).sort(), ['page-one', 'page-two']);
});

test('saves partial results and stops cleanly when search quota is exhausted', async () => {
  let searchCalls = 0;
  const fetchImpl = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/search')) {
      searchCalls += 1;
      if (searchCalls === 1) {
        return new Response(JSON.stringify({
          items: [{ id: { videoId: 'partial-1' }, snippet: { title: 'AI Drama Partial', channelTitle: 'Channel' } }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: {
          message: 'Quota exceeded for quota metric Search Queries',
          errors: [{ reason: 'quotaExceeded' }],
        },
      }), { status: 429 });
    }
    return new Response(JSON.stringify({
      items: [videoInfo({ id: 'partial-1', title: 'AI Drama Partial', duration: 'PT40M' })],
    }), { status: 200 });
  };

  const result = await buildCatalog({
    apiKey: 'test-key',
    now: new Date('2026-10-15T00:00:00Z'),
    fetchImpl,
    sleepFn: async () => { throw new Error('quota errors must not be retried'); },
    keywordConfig: {
      language: 'en',
      regionCode: 'US',
      queries: ['AI drama movie', 'AI robot movie'],
      pagesPerQuery: 1,
      minDurationSeconds: 1800,
    },
  });

  assert.equal(searchCalls, 2);
  assert.equal(result.runStatus, 'partial_quota');
  assert.deepEqual(result.videos.map(video => video.videoId), ['partial-1']);
});
