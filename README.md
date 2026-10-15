# DramaList

Daily catalogs of publicly available AI-themed films and long-form drama episodes on YouTube, split by country and language.

The fetcher searches a rolling 90-day window, reads up to two result pages per query, and distributes a 95-call daily search budget across the configured countries. Each country catalog is stored under `data/<country>/videos.json`.

If YouTube reports `quotaExceeded`, the workflow saves all results collected so far, marks the affected catalog with `runStatus: "partial_quota"`, stops the remaining countries, and exits successfully. The next scheduled run continues after the quota resets.

Catalog writes are append-only: existing records are updated by `videoId` without being re-added, while newly discovered videos are appended to the end of the country catalog.

