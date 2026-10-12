# Neurocinematics Research Tracker

A static site that lists papers on neurocinematics and predictive modeling of cinematic engagement.
A GitHub Action searches OpenAlex, Crossref, PubMed, Europe PMC (includes bioRxiv/medRxiv preprints), arXiv, Semantic Scholar and DOAJ every day, merges duplicates, and updates `data/papers.json`. Each paper keeps the date it was first seen, which powers the **New this week** and **History** tabs.

## Publish it (5 minutes)
1. Create a new **public** GitHub repo (e.g. `neurocinematics-tracker`).
2. Upload everything in this folder. Include the hidden `.github` folder. Dragging the folder onto the GitHub upload page works.
3. **Settings → Pages →** Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. **Settings → Actions → General →** Workflow permissions: *Read and write permissions* → Save.
5. **Actions** tab → *Daily update* → **Run workflow** once to test.

Your site: `https://<your-username>.github.io/<repo-name>/`

## Notes on sources
- A source that rate-limits or times out is skipped for that day and retried the next day. arXiv and Semantic Scholar throttle often; this is normal.
- OpenAlex gives a limited free daily quota. A daily run uses a small part of it. If you run `update.py` many times in one day while testing, you can hit the limit.
- The first two daily runs are treated as the baseline, so nothing in them is flagged "new".

## Customize
- Edit `QUERIES` in `update.py` to add or remove search topics.
- Edit the `FILM` / `SCIENCE` patterns in `update.py` to loosen or tighten what counts as relevant.
- Change the schedule in `.github/workflows/daily.yml` (cron, UTC).
- Optional: set a repo secret `OPENALEX_MAILTO` and pass it as an env var in the workflow to use OpenAlex's polite pool.

## Run locally
    python3 update.py
    python3 -m http.server 8000   # then open http://localhost:8000
