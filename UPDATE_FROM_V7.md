# Hotfix v0.7.1 — demo markers no longer return

This update fixes a backend bootstrap bug.

## What was wrong

Earlier versions recreated starter content whenever **one individual table** was empty. For example, deleting all markers made the next backend restart add the five demo markers again.

## What is fixed

- Starter content is now generated only once for a completely new database.
- Existing worlds are marked as already initialized during the first v0.7.1 startup.
- Deleting every marker, region, timeline event, or overlay now stays deleted after a Railway restart or redeploy.
- Existing cards, maps, uploads, and SQLite data are preserved.

## Railway update

1. Keep the backend Volume mounted at `/app/data`.
2. Replace the repository files with v0.7.1 and push them to GitHub.
3. Redeploy the backend service. The database migration runs automatically.
4. No frontend redeploy is required for this hotfix.

Do **not** delete the Railway Volume or `atlas.db`.
