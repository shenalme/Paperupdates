#!/usr/bin/env python3
"""Daily updater: search many scholarly sources, merge/dedupe, keep history in data/papers.json.

Sources: OpenAlex, Crossref, PubMed, Europe PMC (includes bioRxiv/medRxiv preprints), arXiv,
Semantic Scholar, DOAJ. A source that fails or rate-limits is skipped, never fatal.
"""
import datetime as dt, hashlib, json, os, re, ssl, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

DATA = Path(__file__).parent / "data" / "papers.json"
MAILTO = os.environ.get("OPENALEX_MAILTO", "")  # optional contact for polite-pool APIs
TODAY = dt.date.today().isoformat()
SINCE = (dt.date.today() - dt.timedelta(days=45)).isoformat()

QUERIES = [
    "neurocinematics",
    "neurocinematic film viewing brain",
    "cinematic neuroscience movie viewing",
    "predicting audience engagement film neural",
    "predicting movie success brain activity",
    "inter-subject correlation movie",
    "neural synchrony audience engagement",
    "physiological synchrony audience film",
    "EEG trailer box office prediction",
    "eye tracking film viewing attention",
]

FILM = re.compile(r"film|movie|cinema|trailer|naturalistic (stimul|viewing)|video")
SCIENCE = re.compile(r"neur|brain|eeg|\bmeg\b|fmri|physiolog|synchron|engagement|eye[- ]track|gaze|attention|"
                     r"inter-?subject|box[- ]office|audience|heart rate|cardiac|predict")
STRONG = re.compile(r"neurocinema|film|movie|cinema|trailer")
EXCLUDE = re.compile(r"legal|shakespeare|literary|theatre|theater")
TAGS = {
    "fMRI": r"fmri|hemodynamic|\bbold\b",
    "EEG/MEG": r"\beeg\b|\bmeg\b|electroenceph",
    "Eye tracking": r"eye[- ]track|gaze|eye movement",
    "Physiological": r"heart|cardiac|skin conductance|physiolog",
    "Synchrony/ISC": r"inter-?subject|synchron",
    "Prediction/ML": r"predict|machine learning|neural network|forecast|regression",
    "Box office": r"box[- ]office|revenue|commercial success",
}
PRED = ("predict", "box", "success", "revenue", "engagement", "preference", "recommend", "forecast")


# ---------- http helpers ----------
def _ctx():
    p = "/etc/ssl/cert.pem"
    return ssl.create_default_context(cafile=p) if os.path.exists(p) else ssl.create_default_context()


def http(url, retries=2):
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "neurocinematics-tracker (research list)"})
            with urllib.request.urlopen(req, timeout=20, context=_ctx()) as r:
                return r.read()
        except Exception as e:
            if i == retries:
                raise
            time.sleep(15 if "429" in str(e) else 3)


def jget(url):
    return json.loads(http(url))


def clean(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def rec(source, title, authors, date, venue, cites, doi, url, abstract):
    date = date or ""
    return {"source": source, "title": clean(title), "authors": [a for a in authors if a],
            "date": date, "year": int(date[:4]) if date[:4].isdigit() else None, "venue": clean(venue),
            "cites": cites or 0, "doi": (doi or "").lower().replace("https://doi.org/", ""),
            "url": url or "", "abstract": clean(abstract)}


# ---------- sources ----------
def openalex(q):
    out = []
    for extra in ({"sort": "relevance_score:desc", "per-page": 40},
                  {"sort": "publication_date:desc", "per-page": 25, "filter": f"from_publication_date:{SINCE}"}):
        p = {"search": q, **extra}
        if MAILTO: p["mailto"] = MAILTO
        for w in jget("https://api.openalex.org/works?" + urllib.parse.urlencode(p))["results"]:
            inv = w.get("abstract_inverted_index") or {}
            ab = " ".join(t for _, t in sorted((pos, t) for t, ps in inv.items() for pos in ps))
            loc = (w.get("primary_location") or {}).get("source") or {}
            out.append(rec("OpenAlex", w.get("title"), [a["author"]["display_name"] for a in w.get("authorships", [])],
                           w.get("publication_date"), loc.get("display_name"), w.get("cited_by_count"),
                           w.get("doi"), w.get("doi") or w["id"], ab))
    return out


def crossref(q):
    out = []
    for extra in ({"sort": "relevance"}, {"sort": "published", "order": "desc", "filter": f"from-pub-date:{SINCE}"}):
        p = {"query.bibliographic": q, "rows": 30, **extra}
        if MAILTO: p["mailto"] = MAILTO
        for w in jget("https://api.crossref.org/works?" + urllib.parse.urlencode(p))["message"]["items"]:
            dp = ((w.get("issued") or {}).get("date-parts") or [[None]])[0]
            date = "-".join(f"{x:02d}" if i else str(x) for i, x in enumerate(dp) if x) if dp and dp[0] else ""
            out.append(rec("Crossref", (w.get("title") or [""])[0],
                           [f"{a.get('given','')} {a.get('family','')}".strip() for a in w.get("author", [])],
                           date, (w.get("container-title") or [""])[0], w.get("is-referenced-by-count"),
                           w.get("DOI"), w.get("URL"), w.get("abstract")))
    return out


def pubmed(q):
    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
    ids = jget(base + "esearch.fcgi?" + urllib.parse.urlencode(
        {"db": "pubmed", "term": q, "retmax": 40, "retmode": "json", "sort": "date"}))["esearchresult"]["idlist"]
    if not ids:
        return []
    root = ET.fromstring(http(base + "efetch.fcgi?" + urllib.parse.urlencode(
        {"db": "pubmed", "id": ",".join(ids), "retmode": "xml"})))
    out = []
    for art in root.iter("PubmedArticle"):
        a = art.find(".//Article")
        pmid = art.findtext(".//PMID")
        doi = next((e.text for e in art.iter("ArticleId") if e.get("IdType") == "doi"), "")
        y = art.findtext(".//JournalIssue/PubDate/Year") or (art.findtext(".//PubDate/MedlineDate") or "")[:4]
        auth = [f"{x.findtext('ForeName','')} {x.findtext('LastName','')}".strip() for x in a.iter("Author")]
        ab = " ".join("".join(t.itertext()) for t in a.iter("AbstractText"))
        out.append(rec("PubMed", "".join(a.find("ArticleTitle").itertext()), auth, y, a.findtext(".//Journal/Title"),
                       0, doi, f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/", ab))
    return out


def europepmc(q):
    d = jget("https://www.ebi.ac.uk/europepmc/webservices/rest/search?" + urllib.parse.urlencode(
        {"query": q, "format": "json", "resultType": "core", "pageSize": 40, "sort": "P_PDATE_D desc"}))
    out = []
    for w in d["resultList"]["result"]:
        doi = w.get("doi") or ""
        url = f"https://doi.org/{doi}" if doi else f"https://europepmc.org/article/{w.get('source')}/{w.get('id')}"
        src = "Europe PMC" + (" (preprint)" if w.get("source") == "PPR" else "")
        out.append(rec(src, w.get("title"), (w.get("authorString") or "").rstrip(".").split(", "),
                       w.get("firstPublicationDate"), w.get("journalTitle") or (w.get("bookOrReportDetails") or {}).get("publisher"),
                       w.get("citedByCount"), doi, url, w.get("abstractText")))
    return out


def arxiv(q):
    ns = {"a": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(http("https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {"search_query": f'all:"{q}"', "max_results": 30, "sortBy": "submittedDate", "sortOrder": "descending"})))
    out = []
    for e in root.findall("a:entry", ns):
        doi = e.findtext("{http://arxiv.org/schemas/atom}doi") or ""
        out.append(rec("arXiv", e.findtext("a:title", "", ns), [a.findtext("a:name", "", ns) for a in e.findall("a:author", ns)],
                       (e.findtext("a:published", "", ns) or "")[:10], "arXiv", 0, doi,
                       e.findtext("a:id", "", ns), e.findtext("a:summary", "", ns)))
    return out


def semanticscholar(q):
    d = jget("https://api.semanticscholar.org/graph/v1/paper/search?" + urllib.parse.urlencode(
        {"query": q, "limit": 40, "fields": "title,abstract,year,authors,venue,citationCount,externalIds,publicationDate,url"}))
    return [rec("Semantic Scholar", w.get("title"), [a["name"] for a in w.get("authors", [])], w.get("publicationDate") or str(w.get("year") or ""),
                w.get("venue"), w.get("citationCount"), (w.get("externalIds") or {}).get("DOI"), w.get("url"), w.get("abstract"))
            for w in d.get("data", [])]


def doaj(q):
    d = jget("https://doaj.org/api/search/articles/" + urllib.parse.quote(q) + "?pageSize=30")
    out = []
    for w in d.get("results", []):
        b = w["bibjson"]
        doi = next((i["id"] for i in b.get("identifier", []) if i["type"] == "doi"), "")
        link = next((l["url"] for l in b.get("link", [])), "")
        m = str(b.get("month") or "1")
        m = m.zfill(2) if m.isdigit() else {n: f"{i:02d}" for i, n in enumerate(
            "January February March April May June July August September October November December".split(), 1)}.get(m, "01")
        d0 = f"{b.get('year','')}-{m}-01" if b.get("year") else ""
        out.append(rec("DOAJ", b.get("title"), [a.get("name") for a in b.get("author", [])], d0,
                       (b.get("journal") or {}).get("title"), 0, doi, link, b.get("abstract")))
    return out


SOURCES = [("OpenAlex", openalex), ("Crossref", crossref), ("PubMed", pubmed), ("Europe PMC", europepmc),
           ("arXiv", arxiv), ("Semantic Scholar", semanticscholar), ("DOAJ", doaj)]


# ---------- merge ----------
def norm(t):
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


def key(r):
    return "doi:" + r["doi"] if r["doi"] else "t:" + norm(r["title"])


def pid(k):
    return hashlib.sha1(k.encode()).hexdigest()[:12]


def relevant(r):
    text = (r["title"] + " " + r["abstract"]).lower()
    return bool(r["title"] and FILM.search(text) and SCIENCE.search(text) and STRONG.search(text)
                and not EXCLUDE.search(r["title"].lower()))


def to_paper(r):
    text = (r["title"] + " " + r["abstract"]).lower()
    ab = r["abstract"]
    return {
        "id": pid(key(r)), "title": r["title"],
        "authors": ", ".join(r["authors"][:4]) + (" et al." if len(r["authors"]) > 4 else ""),
        "year": r["year"], "date": r["date"], "venue": r["venue"], "cites": r["cites"],
        "link": f"https://doi.org/{r['doi']}" if r["doi"] else r["url"],
        "topic": "Predictive modeling & engagement" if any(p in r["title"].lower() for p in PRED)
                 else "Neurocinematics & film neuroscience",
        "tags": [t for t, rx in TAGS.items() if re.search(rx, text)],
        "sources": [r["source"].split(" (")[0] + (" preprint" if "preprint" in r["source"] else "")],
        "snippet": (ab[:380] + "…") if len(ab) > 380 else ab,
    }


def main():
    old = json.loads(DATA.read_text()) if DATA.exists() else {"papers": [], "runs": []}
    papers = {p["id"]: p for p in old["papers"]}
    # The first two days seed the list (sources may be rate-limited on day one), so nothing in them counts as "new"
    first_run = len({r["date"] for r in old["runs"] if r["date"] != TODAY}) < 2
    stats = {}
    for name, fn in SOURCES:
        n_ok = n_fail = 0
        for q in QUERIES:
            try:
                recs = fn(q)
            except Exception as e:
                n_fail += 1
                print(f"[{name}] '{q}' failed: {str(e)[:80]}")
                if name in ("Semantic Scholar", "arXiv") and n_fail >= 2:
                    break  # rate-limited or unreachable: skip the rest, try again tomorrow
                continue
            n_ok += 1
            for r in recs:
                if not relevant(r):
                    continue
                p = to_paper(r)
                if p["id"] in papers:
                    cur = papers[p["id"]]
                    cur["cites"] = max(cur.get("cites") or 0, p["cites"] or 0)
                    cur["sources"] = sorted(set(cur["sources"]) | set(p["sources"]))
                    cur["tags"] = sorted(set(cur["tags"]) | set(p["tags"]))
                    if len(p["snippet"]) > len(cur.get("snippet", "")): cur["snippet"] = p["snippet"]
                    if not cur.get("venue"): cur["venue"] = p["venue"]
                else:
                    p["first_seen"] = TODAY
                    p["baseline"] = first_run
                    papers[p["id"]] = p
            time.sleep(3 if name in ('arXiv', 'Semantic Scholar') else 1)
        stats[name] = {"ok": n_ok, "failed": n_fail}
        print(f"[{name}] {n_ok} ok, {n_fail} failed")
    added = sum(1 for p in papers.values() if p["first_seen"] == TODAY and not first_run)
    prev = [r for r in old["runs"] if r["date"] != TODAY]
    runs = prev + [{"date": TODAY, "added": added, "total": len(papers), "baseline": first_run, "sources": stats}]
    out = {"updated": TODAY, "runs": runs[-365:],
           "source_counts": {s: sum(1 for p in papers.values() if s in p["sources"]) for s in
                             sorted({s for p in papers.values() for s in p["sources"]})},
           "papers": sorted(papers.values(), key=lambda p: -(p.get("cites") or 0))}
    DATA.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{TODAY}: +{added} new, {len(papers)} total, by source: {out['source_counts']}")


if __name__ == "__main__":
    main()
