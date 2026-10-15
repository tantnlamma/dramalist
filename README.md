# DramaList

Daily catalogs of publicly available AI-themed films and long-form drama episodes on YouTube, split by country and language.

The fetcher searches a rolling 90-day window, reads up to two result pages per query, and distributes a 95-call daily search budget across the configured countries. Each country catalog is stored under `data/<country>/videos.json`.

