# DramaList

Daily catalog of publicly available English drama films and long-form drama episodes on YouTube.

## How it works

The GitHub Actions workflow runs every day at approximately 07:00 Vietnam time. It searches YouTube using the queries in [`config/keywords.json`](config/keywords.json), validates the results with YouTube Data API v3, and writes the deduplicated catalog to [`data/videos.json`](data/videos.json).

The catalog keeps videos that are no longer public with `status: "unavailable"` so its history is not lost. No video is downloaded, hosted, or re-encoded; each item links to the original YouTube video.

The default filter keeps public, non-live, non-vertical videos that are at least 30 minutes long. Trailer, teaser, review, recap, reaction, compilation, playlist, music, interview, and Shorts-like results are excluded through [`config/exclude-keywords.json`](config/exclude-keywords.json).

## Setup

1. Enable YouTube Data API v3 in Google Cloud Console and create an API key.
2. Add the key to the GitHub repository as an Actions secret named `YOUTUBE_API_KEY`.
3. Run **Actions → Fetch YouTube drama catalog → Run workflow** for the first manual fetch.

Scheduled workflows run from the repository's default branch. GitHub may delay scheduled jobs, so the fetcher searches a rolling 72-hour window and deduplicates by `videoId`.

## Local development

Requires Node.js 22 or newer.

```bash
npm test
YOUTUBE_API_KEY="your-key" npm run fetch
```

To exercise the command without writing the catalog, use `DRY_RUN=1`. The test suite uses mocked API responses and does not need a real YouTube key.

## Catalog fields

Each video contains its YouTube ID and URL, title, description, channel metadata, thumbnail, publication time, duration in seconds, matched search keywords, availability status, and discovery/verification timestamps.
