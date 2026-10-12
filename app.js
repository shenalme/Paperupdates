/* Neurocinematics Research Tracker: dashboard, library, history, export. No external dependencies. */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const frame = (ms = 40) => new Promise(r => setTimeout(r, ms));  // timer, not rAF: still fires in background tabs
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: selection just won't persist */ } }
};
const TODAY = new Date();
const daysAgo = d => Math.floor((TODAY - new Date(d + 'T00:00:00')) / 864e5);
const isNew = p => !p.baseline && daysAgo(p.first_seen) <= 7;

const state = {
  data: null, papers: [], byId: new Map(),
  f: blankFilters(), group: 'none', sort: 'cites',
  sel: new Set(store.get('nct.sel', [])), cols: store.get('nct.cols', {}),
  shown: {}, results: []
};
function blankFilters() {
  return { q: '', topics: new Set(), tags: new Set(), sources: new Set(), yMin: '', yMax: '', minCites: 0, newOnly: false, hasAbs: false, selOnly: false, col: '' };
}

/* ------------------------------------------------------------------ announce / toast */
function announce(msg) { const a = $('#announce'); a.textContent = ''; setTimeout(() => a.textContent = msg, 30); }
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false; announce(msg);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 5000);
}

/* ------------------------------------------------------------------ loading screen */
function setStep(n, msg, pct) {
  $$('#loadSteps li').forEach(li => {
    const k = +li.dataset.step;
    li.className = k < n ? 'done' : k === n ? 'active' : '';
  });
  $('#loadMsg').textContent = msg;
  const bar = $('#loadBar');
  if (pct == null) bar.classList.add('indet');
  else { bar.classList.remove('indet'); $('.fill', bar).style.width = pct + '%'; bar.setAttribute('aria-valuenow', Math.round(pct)); }
}
async function load() {
  $('#loadErr').hidden = true;
  setStep(1, 'Downloading the paper library…', null);
  try {
    const res = await fetch('data/papers.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      setStep(1, `Downloading the paper library… ${(got / 1024).toFixed(0)} KB`, total ? Math.min(60, got / total * 60) : null);
    }
    setStep(2, 'Indexing titles, authors and abstracts…', 65); await frame();
    const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    const data = JSON.parse(text);
    state.data = data; state.papers = data.papers;
    state.papers.forEach((p, i) => {
      p.abstract = p.abstract || ''; p.authors = (p.authors || []).filter(a => /[A-Za-z\u00C0-\uFFFF]{2}/.test(a.f)); p.tags = p.tags || []; p.sources = p.sources || [];
      p._h = (p.title + ' ' + p.authors.map(a => a.g + ' ' + a.f).join(' ') + ' ' + p.abstract + ' ' + (p.venue || '')).toLowerCase();
      state.byId.set(p.id, p);
      if (i % 80 === 0) setStep(2, `Indexing titles, authors and abstracts… ${i} of ${state.papers.length}`, 65 + i / state.papers.length * 20);
    });
    state.sel = new Set([...state.sel].filter(id => state.byId.has(id)));
    await frame();
    setStep(3, 'Building the dashboard…', 90); await frame();
    $$('#loadSteps li').forEach(li => li.className = 'done');
    setStep(4, 'Ready', 100);
    $('#footMeta').textContent = `Library of ${data.papers.length} papers. Last updated ${data.updated}.`;
    $('#loader').hidden = true; $('#app').hidden = false;
    route();
  } catch (e) {
    setStep(1, 'The library could not be loaded.', 0);
    const err = $('#loadErr'); err.hidden = false;
    err.innerHTML = `<p><strong>Could not load <code>data/papers.json</code>.</strong> ${esc(e.message)}</p>
      <p>If you opened this file straight from your computer, browsers block the data file. Publish it on GitHub Pages, or run <code>python3 -m http.server</code> in this folder and open <code>http://localhost:8000</code>.</p>
      <button class="btn" type="button" id="retry">Try again</button>`;
    $('#retry').onclick = load;
  }
}

/* ------------------------------------------------------------------ routing */
function parseHash() {
  const h = location.hash.slice(1) || '/dashboard';
  const [path, qs] = h.split('?');
  return { path, params: new URLSearchParams(qs || '') };
}
function route() {
  if (!state.data) return;
  const { path, params } = parseHash();
  const view = ['/dashboard', '/library', '/history'].includes(path) ? path.slice(1) : 'dashboard';
  $$('nav a').forEach(a => a.dataset.nav === view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  const main = $('#main'); main.onclick = main.onchange = null;
  if (view === 'dashboard') renderDashboard(main);
  else if (view === 'history') renderHistory(main);
  else renderLibrary(main, params);
  document.title = ({ dashboard: 'Dashboard', library: 'Library', history: 'History' }[view]) + ' · Neurocinematics Research Tracker';
  main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  updateSelBar();
}
window.addEventListener('hashchange', route);

/* ------------------------------------------------------------------ names & citation helpers */
const initials = g => (g || '').split(/[\s-]+/).filter(Boolean).flatMap(t => /^[A-Z]{2,3}$/.test(t.replace(/\./g, '')) ? t.replace(/\./g, '').split('') : [t[0]])
  .map(c => c.toUpperCase() + '.').join(' ');
const authorShort = (p, n = 4) => {
  if (!p.authors.length) return 'Authors not listed';
  const a = p.authors.slice(0, n).map(x => `${x.f}${x.g ? ' ' + initials(x.g).replace(/[. ]/g, '') : ''}`).join(', ');
  return p.authors.length > n ? `${a}, +${p.authors.length - n} more` : a;
};
const isPreprint = p => p.sources.some(s => /preprint/i.test(s)) || /arxiv|biorxiv|medrxiv|ssrn|research square/i.test(p.venue || '');
const ascii = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '');
const endDot = s => /[.?!]$/.test(s) ? s : s + '.';

function apa(p) {
  const A = p.authors.map(a => `${a.f}${a.g ? ', ' + initials(a.g) : ''}`);
  let au = '';
  if (A.length === 1) au = A[0];
  else if (A.length === 2) au = `${A[0]}, & ${A[1]}`;
  else if (A.length > 20) au = `${A.slice(0, 19).join(', ')}, . . . ${A[A.length - 1]}`;
  else if (A.length) au = `${A.slice(0, -1).join(', ')}, & ${A[A.length - 1]}`;
  const yr = p.year ? `(${p.year}).` : '(n.d.).';
  return [au ? endDot(au) : '', au ? yr : '', endDot(p.title), p.venue ? endDot(p.venue) : '', p.link].filter(Boolean).join(' ');
}
function bibKeys(list) {
  const used = new Map(), keys = new Map();
  for (const p of list) {
    const fam = ascii(p.authors[0]?.f).toLowerCase() || 'anon';
    const w = (p.title.match(/[A-Za-z]{4,}/g) || ['paper']).find(x => !/^(the|with|from|that|this|their|during|using|into|about|between)$/i.test(x)) || 'paper';
    let base = fam + (p.year || '') + w.toLowerCase(), k = base, i = 0;
    while (used.has(k)) k = base + String.fromCharCode(97 + (i++ % 26));
    used.set(k, 1); keys.set(p.id, k);
  }
  return keys;
}
const bibEsc = s => String(s || '').replace(/([&%$#_])/g, '\\$1');
function bibtex(list, withAbs) {
  const keys = bibKeys(list);
  return list.map(p => {
    const pre = isPreprint(p), f = [];
    if (p.authors.length) f.push(['author', p.authors.map(a => `${bibEsc(a.f)}${a.g ? ', ' + bibEsc(a.g) : ''}`).join(' and ')]);
    f.push(['title', '{' + bibEsc(p.title) + '}']);
    if (p.venue) f.push([pre ? 'howpublished' : 'journal', bibEsc(p.venue)]);
    if (p.year) f.push(['year', p.year]);
    const m = /^\d{4}-(\d{2})/.exec(p.date || ''); if (m && p.date.slice(5, 7) !== '01') f.push(['month', +m[1]]);
    const doi = (p.link.match(/doi\.org\/(.+)$/) || [])[1];
    if (doi) f.push(['doi', doi]);
    f.push(['url', p.link]);
    if (pre) f.push(['note', 'Preprint']);
    if (withAbs && p.abstract) f.push(['abstract', bibEsc(p.abstract)]);
    return `@${pre ? 'misc' : 'article'}{${keys.get(p.id)},\n` + f.map(([k, v]) => `  ${k} = {${v}}`).join(',\n') + '\n}';
  }).join('\n\n') + '\n';
}
function ris(list, withAbs) {
  return list.map(p => {
    const L = [`TY  - ${isPreprint(p) ? 'UNPB' : 'JOUR'}`];
    p.authors.forEach(a => L.push(`AU  - ${a.f}${a.g ? ', ' + a.g : ''}`));
    L.push(`TI  - ${p.title}`);
    if (p.venue) L.push(`${isPreprint(p) ? 'PB' : 'JO'}  - ${p.venue}`);
    if (p.year) L.push(`PY  - ${p.year}`);
    if (p.date) L.push(`DA  - ${p.date.replace(/-/g, '/')}`);
    const doi = (p.link.match(/doi\.org\/(.+)$/) || [])[1]; if (doi) L.push(`DO  - ${doi}`);
    L.push(`UR  - ${p.link}`);
    if (withAbs && p.abstract) L.push(`AB  - ${p.abstract}`);
    p.tags.forEach(t => L.push(`KW  - ${t}`));
    L.push('ER  - ', '');
    return L.join('\r\n');
  }).join('\r\n');
}
function csl(list, withAbs) {
  const keys = bibKeys(list);
  return JSON.stringify(list.map(p => {
    const o = { id: keys.get(p.id), type: isPreprint(p) ? 'article' : 'article-journal', title: p.title,
      author: p.authors.map(a => ({ family: a.f, given: a.g })), URL: p.link };
    if (p.year) { const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(p.date || ''); o.issued = { 'date-parts': [d && d[2] + d[3] !== '0101' ? [+d[1], +d[2], +d[3]] : [p.year]] }; }
    if (p.venue) o['container-title'] = p.venue;
    const doi = (p.link.match(/doi\.org\/(.+)$/) || [])[1]; if (doi) o.DOI = doi;
    if (withAbs && p.abstract) o.abstract = p.abstract;
    return o;
  }), null, 2);
}
const csvCell = v => { v = String(v ?? ''); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function csv(list, withAbs) {
  const cols = ['Title', 'Authors', 'Year', 'Published', 'Journal / venue', 'Citations', 'Topic', 'Methods', 'Sources', 'DOI / link', 'First seen'];
  if (withAbs) cols.push('Abstract');
  const rows = list.map(p => {
    const r = [p.title, p.authors.map(a => `${a.f}${a.g ? ', ' + a.g : ''}`).join('; '), p.year, p.date, p.venue, p.cites, p.topic,
      p.tags.join('; '), p.sources.join('; '), p.link, p.first_seen];
    if (withAbs) r.push(p.abstract);
    return r.map(csvCell).join(',');
  });
  return '﻿' + [cols.map(csvCell).join(','), ...rows].join('\r\n') + '\r\n';
}
function abstractsTxt(list) {
  return list.map((p, i) => `${i + 1}. ${p.title}\n${p.authors.map(a => `${a.g} ${a.f}`.trim()).join(', ') || 'Authors not listed'}\n${[p.year, p.venue].filter(Boolean).join('. ')}\n${p.link}\n\n${p.abstract || '[No abstract available from the sources searched]'}\n`)
    .join('\n' + '-'.repeat(72) + '\n\n');
}
function abstractsMd(list) {
  return '# Abstracts\n\n' + list.map(p => `## ${p.title}\n\n*${p.authors.map(a => `${a.g} ${a.f}`.trim()).join(', ') || 'Authors not listed'}*  \n${[p.year, p.venue].filter(Boolean).join('. ')}  \n<${p.link}>\n\n${p.abstract || '_No abstract available from the sources searched._'}\n`).join('\n');
}
const FORMATS = {
  bibtex: { ext: 'bib', mime: 'application/x-bibtex', label: 'BibTeX references', fn: (l, o) => bibtex(l, o.abs), ref: true },
  ris: { ext: 'ris', mime: 'application/x-research-info-systems', label: 'RIS references', fn: (l, o) => ris(l, o.abs), ref: true },
  apa: { ext: 'txt', mime: 'text/plain', label: 'APA reference list', fn: l => [...l].sort((a, b) => (a.authors[0]?.f || a.title).localeCompare(b.authors[0]?.f || b.title)).map(apa).join('\n\n') + '\n' },
  csl: { ext: 'json', mime: 'application/json', label: 'CSL JSON references', fn: (l, o) => csl(l, o.abs), ref: true },
  csv: { ext: 'csv', mime: 'text/csv', label: 'spreadsheet', fn: l => csv(l, false) },
  csvabs: { ext: 'csv', mime: 'text/csv', label: 'spreadsheet with abstracts', fn: l => csv(l, true) },
  abstracts: { ext: 'txt', mime: 'text/plain', label: 'abstracts', fn: abstractsTxt },
  md: { ext: 'md', mime: 'text/markdown', label: 'abstracts (Markdown)', fn: abstractsMd },
  json: { ext: 'json', mime: 'application/json', label: 'full data', fn: l => JSON.stringify(l.map(({ _h, ...r }) => r), null, 2) }
};

/* ------------------------------------------------------------------ filtering, sorting, grouping */
function applyFilters() {
  const f = state.f, toks = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const colIds = f.col ? new Set(state.cols[f.col] || []) : null;
  let r = state.papers.filter(p =>
    (!f.topics.size || f.topics.has(p.topic)) &&
    (!f.tags.size || p.tags.some(t => f.tags.has(t))) &&
    (!f.sources.size || p.sources.some(s => f.sources.has(s))) &&
    (!f.yMin || (p.year && p.year >= +f.yMin)) && (!f.yMax || (p.year && p.year <= +f.yMax)) &&
    (p.cites || 0) >= f.minCites &&
    (!f.newOnly || isNew(p)) && (!f.hasAbs || p.abstract.length > 50) &&
    (!f.selOnly || state.sel.has(p.id)) && (!colIds || colIds.has(p.id)) &&
    toks.every(t => p._h.includes(t)));
  const s = state.sort;
  r.sort(s === 'cites' ? (a, b) => (b.cites || 0) - (a.cites || 0)
    : s === 'date' ? (a, b) => (b.date || '').localeCompare(a.date || '')
    : s === 'seen' ? (a, b) => b.first_seen.localeCompare(a.first_seen) || (b.cites || 0) - (a.cites || 0)
    : (a, b) => a.title.localeCompare(b.title));
  return r;
}
const colsOf = id => Object.keys(state.cols).filter(n => state.cols[n].includes(id));
const GROUPERS = {
  none: null,
  topic: p => [p.topic],
  year: p => [String(p.year || 'Year unknown')],
  method: p => p.tags.length ? p.tags : ['No method tag'],
  source: p => p.sources,
  venue: p => [p.venue || 'Venue unknown'],
  collection: p => { const c = colsOf(p.id); return c.length ? c : ['Not in a collection']; }
};
function buildGroups(list) {
  const g = GROUPERS[state.group];
  if (!g) return [{ label: '', items: list }];
  const m = new Map();
  list.forEach(p => g(p).forEach(k => (m.get(k) || m.set(k, []).get(k)).push(p)));
  const arr = [...m].map(([label, items]) => ({ label, items }));
  arr.sort(state.group === 'year' ? (a, b) => (/^\d/.test(b.label) - /^\d/.test(a.label)) || b.label.localeCompare(a.label) : (a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  return arr;
}

/* ------------------------------------------------------------------ paper card */
function card(p) {
  const sel = state.sel.has(p.id), ab = p.abstract.length > 50;
  return `<article class="paper${sel ? ' is-sel' : ''}" data-id="${p.id}">
    <div class="sel"><input type="checkbox" class="pick" ${sel ? 'checked' : ''} aria-label="Select: ${esc(p.title)}"></div>
    <div class="body">
      <h3><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}<span class="sr"> (opens in a new tab)</span></a></h3>
      <p class="byline">${esc(authorShort(p))} · ${p.year || 'n.d.'}${p.venue ? ' · <em>' + esc(p.venue) + '</em>' : ''} · ${p.cites || 0} citation${p.cites === 1 ? '' : 's'}</p>
      <ul class="badges" aria-label="Details">
        ${isNew(p) ? '<li class="badge new">New</li>' : ''}
        <li class="badge topic">${esc(p.topic)}</li>
        ${p.tags.map(t => `<li class="badge">${esc(t)}</li>`).join('')}
        ${p.sources.map(s => `<li class="badge src"><span class="sr">Source: </span>${esc(s)}</li>`).join('')}
      </ul>
      ${ab ? `<details class="abs"><summary>Abstract</summary><p>${esc(p.abstract)}</p></details>` : '<p class="byline">No abstract available from the sources searched.</p>'}
      <div class="actions"><button class="btn small cite" type="button">Copy APA citation<span class="sr"> for ${esc(p.title)}</span></button></div>
    </div></article>`;
}

/* ------------------------------------------------------------------ library view */
function countBy(fn) { const m = new Map(); state.papers.forEach(p => fn(p).forEach(k => m.set(k, (m.get(k) || 0) + 1))); return m; }
function checkGroup(name, legend, map, set, sortFn) {
  const rows = [...map].sort(sortFn || ((a, b) => b[1] - a[1]));
  return `<fieldset><legend>${legend}</legend>${rows.map(([k, n]) => `<label class="check"><input type="checkbox" data-f="${name}" value="${esc(k)}" ${set.has(k) ? 'checked' : ''}><span>${esc(k)}</span><span class="n">${n}</span></label>`).join('')}</fieldset>`;
}
function renderLibrary(main, params) {
  if ([...params.keys()].length) {
    state.f = blankFilters();
    if (params.get('topic')) state.f.topics.add(params.get('topic'));
    if (params.get('tag')) state.f.tags.add(params.get('tag'));
    if (params.get('source')) state.f.sources.add(params.get('source'));
    if (params.get('year')) { state.f.yMin = state.f.yMax = params.get('year'); }
    if (params.get('q')) state.f.q = params.get('q');
    if (params.get('new')) state.f.newOnly = true;
    if (params.get('col')) state.f.col = params.get('col');
    if (params.get('sort')) state.sort = params.get('sort');
  }
  const years = [...new Set(state.papers.map(p => p.year).filter(Boolean))].sort((a, b) => b - a);
  const yOpts = sel => `<option value="">Any</option>` + years.map(y => `<option ${String(y) === String(sel) ? 'selected' : ''}>${y}</option>`).join('');
  const f = state.f;
  main.innerHTML = `
    <div class="page-head"><h2 style="font-size:1.6rem">Library</h2>
      <p>Search, filter and group papers. Tick papers to select them, then export references, abstracts or data.</p></div>
    <div class="lib">
      <div>
        <button class="btn" id="filterToggle" type="button" aria-expanded="true" aria-controls="filters">Filters</button>
        <form class="filters" id="filters" role="search" aria-label="Filter papers" onsubmit="return false">
          <fieldset><legend>Search</legend><label class="sr" for="q">Search titles, authors and abstracts</label>
            <input type="search" id="q" value="${esc(f.q)}" placeholder="Title, author, abstract…"></fieldset>
          ${checkGroup('topics', 'Topic', countBy(p => [p.topic]), f.topics)}
          ${checkGroup('tags', 'Method or measure', countBy(p => p.tags), f.tags)}
          ${checkGroup('sources', 'Source', countBy(p => p.sources), f.sources)}
          <fieldset><legend>Year published</legend><div class="yr">
            <div><label for="yMin">From</label><select id="yMin">${yOpts(f.yMin)}</select></div>
            <div><label for="yMax">To</label><select id="yMax">${yOpts(f.yMax)}</select></div></div></fieldset>
          <fieldset><legend>Minimum citations</legend><label class="sr" for="minC">Minimum citations</label>
            <select id="minC">${[0, 1, 10, 50, 100].map(v => `<option value="${v}" ${f.minCites === v ? 'selected' : ''}>${v ? v + ' or more' : 'Any'}</option>`).join('')}</select></fieldset>
          <fieldset><legend>Show only</legend>
            <label class="check"><input type="checkbox" id="newOnly" ${f.newOnly ? 'checked' : ''}><span>New in the last 7 days</span></label>
            <label class="check"><input type="checkbox" id="hasAbs" ${f.hasAbs ? 'checked' : ''}><span>Has an abstract</span></label>
            <label class="check"><input type="checkbox" id="selOnly" ${f.selOnly ? 'checked' : ''}><span>My selected papers</span></label></fieldset>
          <fieldset id="colFs"><legend>My collections</legend></fieldset>
          <button class="btn" type="button" id="reset">Reset all filters</button>
        </form>
      </div>
      <section aria-label="Results">
        <div class="toolbar">
          <div class="grow"><div class="count" id="count" aria-live="polite"></div>
            <button class="linkbtn" type="button" id="selAll"></button></div>
          <div><label class="field" for="group">Group by</label><select id="group">
            ${[['none', 'No grouping'], ['topic', 'Topic'], ['year', 'Year'], ['method', 'Method or measure'], ['source', 'Source'], ['venue', 'Journal or venue'], ['collection', 'My collections']]
              .map(([v, l]) => `<option value="${v}" ${state.group === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div><label class="field" for="sort">Sort by</label><select id="sort">
            ${[['cites', 'Most cited'], ['date', 'Newest published'], ['seen', 'Recently added'], ['title', 'Title A–Z']]
              .map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <button class="btn primary" type="button" id="exportAll">Export…</button>
        </div>
        <div id="results"></div>
      </section>
    </div>`;
  renderCollectionsFs();
  const fl = $('#filters');
  if (matchMedia('(max-width:900px)').matches) { fl.classList.add('collapsed'); $('#filterToggle').setAttribute('aria-expanded', 'false'); }
  $('#filterToggle').onclick = e => { const c = fl.classList.toggle('collapsed'); e.currentTarget.setAttribute('aria-expanded', String(!c)); };
  let qt; $('#q').oninput = e => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value; state.shown = {}; renderResults(); }, 180); };
  fl.addEventListener('change', e => {
    const t = e.target, k = t.dataset.f;
    if (k) { t.checked ? f[k].add(t.value) : f[k].delete(t.value); }
    else if (t.id === 'yMin') f.yMin = t.value; else if (t.id === 'yMax') f.yMax = t.value;
    else if (t.id === 'minC') f.minCites = +t.value;
    else if (t.id === 'newOnly') f.newOnly = t.checked; else if (t.id === 'hasAbs') f.hasAbs = t.checked; else if (t.id === 'selOnly') f.selOnly = t.checked;
    else if (t.name === 'col') f.col = t.value;
    state.shown = {}; renderResults();
  });
  fl.addEventListener('click', e => {
    const d = e.target.closest('[data-delcol]'); if (!d) return;
    const n = d.dataset.delcol;
    if (confirm(`Delete the collection "${n}"? The papers stay in the library.`)) { delete state.cols[n]; store.set('nct.cols', state.cols); if (f.col === n) f.col = ''; renderCollectionsFs(); renderResults(); toast(`Collection "${n}" deleted.`); }
  });
  $('#reset').onclick = () => { state.f = blankFilters(); state.group = 'none'; renderLibrary(main, new URLSearchParams()); announce('Filters reset.'); };
  $('#group').onchange = e => { state.group = e.target.value; state.shown = {}; renderResults(); };
  $('#sort').onchange = e => { state.sort = e.target.value; renderResults(); };
  $('#exportAll').onclick = () => openExport();
  $('#selAll').onclick = () => {
    const ids = state.results.map(p => p.id), all = ids.every(id => state.sel.has(id));
    ids.forEach(id => all ? state.sel.delete(id) : state.sel.add(id));
    saveSel(); renderResults(); announce(all ? 'Deselected all results.' : `Selected all ${ids.length} results.`);
  };
  $('#results').addEventListener('change', e => {
    const cb = e.target.closest('.pick'); if (!cb) return;
    const id = cb.closest('.paper').dataset.id;
    cb.checked ? state.sel.add(id) : state.sel.delete(id);
    cb.closest('.paper').classList.toggle('is-sel', cb.checked);
    saveSel(); updateSelAllLabel();
  });
  $('#results').addEventListener('click', e => {
    const more = e.target.closest('[data-more]');
    if (more) { const g = more.dataset.more; state.shown[g] = (state.shown[g] || pageSize()) + 25; const y = scrollY; renderResults(true); scrollTo(0, y); return; }
    const gs = e.target.closest('[data-gsel]');
    if (gs) {
      const grp = state.groups[+gs.dataset.gsel], ids = grp.items.map(p => p.id), all = ids.every(id => state.sel.has(id));
      ids.forEach(id => all ? state.sel.delete(id) : state.sel.add(id));
      saveSel(); renderResults(true); announce(`${all ? 'Deselected' : 'Selected'} ${ids.length} papers in ${grp.label}.`); return;
    }
    const c = e.target.closest('.cite');
    if (c) { const p = state.byId.get(c.closest('.paper').dataset.id); copyText(apa(p)).then(ok => toast(ok ? 'APA citation copied to clipboard.' : 'Copy was blocked by the browser. Use Export instead.')); }
  });
  renderResults();
}
const pageSize = () => state.group === 'none' ? 25 : 8;
function renderCollectionsFs() {
  const fs = $('#colFs'); if (!fs) return;
  const names = Object.keys(state.cols);
  fs.innerHTML = `<legend>My collections</legend>` + (names.length
    ? `<label class="check"><input type="radio" name="col" value="" ${!state.f.col ? 'checked' : ''}><span>All papers</span></label>` +
      names.map(n => `<div style="display:flex;align-items:center"><label class="check" style="flex:1"><input type="radio" name="col" value="${esc(n)}" ${state.f.col === n ? 'checked' : ''}><span>${esc(n)}</span><span class="n">${state.cols[n].length}</span></label>
        <button type="button" class="linkbtn" data-delcol="${esc(n)}" aria-label="Delete collection ${esc(n)}">Delete</button></div>`).join('')
    : '<p class="muted" style="margin:0">None yet. Select papers, then choose “Add to collection”.</p>');
}
function saveSel() { store.set('nct.sel', [...state.sel]); updateSelBar(); }
function updateSelAllLabel() {
  const b = $('#selAll'); if (!b) return;
  const ids = state.results.map(p => p.id), all = ids.length && ids.every(id => state.sel.has(id));
  b.textContent = all ? 'Deselect all results' : `Select all ${ids.length} results`; b.hidden = !ids.length;
}
function renderResults(keepFocus) {
  const list = state.results = applyFilters();
  state.groups = buildGroups(list);
  $('#count').textContent = `${list.length} of ${state.papers.length} papers`;
  updateSelAllLabel();
  const box = $('#results');
  if (!list.length) { box.innerHTML = `<div class="empty"><p><strong>No papers match these filters.</strong></p><p>Try removing a filter or searching different words.</p></div>`; return; }
  box.innerHTML = state.groups.map((g, gi) => {
    const key = g.label || '_', n = state.shown[key] || pageSize(), items = g.items.slice(0, n), left = g.items.length - items.length;
    const head = g.label ? `<header><h2>${esc(g.label)} <span class="muted" style="font-weight:400">(${g.items.length})</span></h2>
      <button class="btn small" type="button" data-gsel="${gi}">${g.items.every(p => state.sel.has(p.id)) ? 'Deselect group' : 'Select group'}<span class="sr"> ${esc(g.label)}</span></button></header>` : '';
    return `<section class="group" ${g.label ? `aria-label="${esc(g.label)}"` : ''}>${head}${items.map(card).join('')}
      ${left > 0 ? `<button class="btn more" type="button" data-more="${esc(key)}">Show ${Math.min(25, left)} more (${left} left)</button>` : ''}</section>`;
  }).join('');
}

/* ------------------------------------------------------------------ selection bar */
function updateSelBar() {
  const n = state.sel.size, bar = $('#selbar');
  bar.hidden = !n || !state.data;
  $('#selCount').textContent = `${n} paper${n === 1 ? '' : 's'} selected`;
}
$('#selClear').onclick = () => { state.sel.clear(); saveSel(); if ($('#results')) renderResults(); announce('Selection cleared.'); };
$('#selExport').onclick = () => openExport('selected');
$('#selCollect').onclick = openCollect;

/* ------------------------------------------------------------------ collections */
function openCollect() {
  const n = state.sel.size; if (!n) return;
  $('#colInfo').textContent = `Add ${n} selected paper${n === 1 ? '' : 's'} to a collection.`;
  $('#colList').innerHTML = Object.keys(state.cols).map(c => `<option value="${esc(c)}">`).join('');
  $('#colName').value = ''; $('#colDlg').showModal(); $('#colName').focus();
}
$('#colSave').onclick = () => {
  const name = $('#colName').value.trim(); if (!name) { $('#colName').focus(); announce('Enter a collection name first.'); return; }
  const set = new Set(state.cols[name] || []); const before = set.size; state.sel.forEach(id => set.add(id));
  state.cols[name] = [...set]; store.set('nct.cols', state.cols);
  $('#colDlg').close(); toast(`Added ${set.size - before} paper${set.size - before === 1 ? '' : 's'} to "${name}".`);
  if ($('#colFs')) { renderCollectionsFs(); renderResults(); }
};
$('#colName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#colSave').click(); } });

/* ------------------------------------------------------------------ export */
let lastExport = null;
function openExport(prefer) {
  const selN = state.sel.size, resN = state.results.length || state.papers.length;
  const hasRes = !!$('#results');
  const scopes = [
    ['selected', `My selected papers (${selN})`, selN > 0],
    ['results', `Papers shown with the current filters (${hasRes ? state.results.length : state.papers.length})`, true],
    ['all', `The entire library (${state.papers.length})`, true]
  ];
  const def = prefer === 'selected' && selN ? 'selected' : selN && !hasRes ? 'selected' : hasRes && state.results.length !== state.papers.length ? 'results' : selN ? 'selected' : 'all';
  $('#exScope').innerHTML = scopes.map(([v, l, ok]) => `<label class="opt" ${ok ? '' : 'style="opacity:.55"'}><input type="radio" name="scope" value="${v}" ${ok ? '' : 'disabled'} ${v === def ? 'checked' : ''}><span>${l}</span></label>`).join('');
  if (!$('input[name=fmt]:checked')) $('input[name=fmt][value=bibtex]').checked = true;
  $('#exProg').hidden = true; lastExport = null; $('#exGo').textContent = 'Download';
  syncExportUi(); $('#exportDlg').showModal();
}
function syncExportUi() { const f = $('input[name=fmt]:checked').value; $('#exAbsWrap').hidden = !FORMATS[f].ref; }
$('#exForm').addEventListener('change', syncExportUi);
function scopeList() {
  const s = $('input[name=scope]:checked').value;
  return s === 'selected' ? state.papers.filter(p => state.sel.has(p.id)) : s === 'results' && $('#results') ? state.results : state.papers;
}
async function buildExport() {
  const fmt = $('input[name=fmt]:checked').value, F = FORMATS[fmt], list = scopeList(), scope = $('input[name=scope]:checked').value;
  const prog = $('#exProg'), bar = $('#exBar'), fill = $('.fill', bar), msg = $('#exMsg');
  prog.hidden = false; $('#exGo').disabled = $('#exCopy').disabled = true;
  const setP = (m, pct) => { msg.textContent = m; fill.style.width = pct + '%'; bar.setAttribute('aria-valuenow', Math.round(pct)); };
  setP(`Preparing ${list.length} papers…`, 15); await frame(80);
  setP(`Formatting ${list.length} papers as ${F.label}…`, 55); await frame(80);
  const text = F.fn(list, { abs: $('#exAbs').checked });
  setP('Creating the file…', 90); await frame(80);
  const name = `neurocinematics-${scope}-${new Date().toISOString().slice(0, 10)}.${F.ext}`;
  lastExport = { text, name, mime: F.mime, count: list.length, label: F.label };
  setP(`Ready: ${list.length} papers as ${F.label}.`, 100);
  $('#exGo').disabled = $('#exCopy').disabled = false;
  return lastExport;
}
function saveBlob(x) {
  const url = URL.createObjectURL(new Blob([x.text], { type: x.mime + ';charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: x.name });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$('#exGo').onclick = async () => {
  if (!scopeList().length) { announce('There are no papers in this scope.'); return; }
  const x = await buildExport(); saveBlob(x);
  $('#exMsg').textContent = `Downloaded ${x.name}: ${x.count} papers as ${x.label}.`; announce($('#exMsg').textContent);
  $('#exGo').textContent = 'Download again';
};
$('#exCopy').onclick = async () => {
  if (!scopeList().length) { announce('There are no papers in this scope.'); return; }
  const x = await buildExport(); const ok = await copyText(x.text);
  $('#exMsg').textContent = ok ? `Copied ${x.count} papers as ${x.label} to the clipboard.` : 'Your browser blocked copying. Use Download instead.'; announce($('#exMsg').textContent);
};
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    try { const ta = Object.assign(document.createElement('textarea'), { value: t }); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; }
  }
}

/* ------------------------------------------------------------------ dashboard */
const linkTo = (k, v) => `#/library?${k}=${encodeURIComponent(v)}`;
function barList(map, key, cls, limit) {
  const rows = [...map].sort((a, b) => b[1] - a[1]).slice(0, limit || 99), max = Math.max(...rows.map(r => r[1]), 1);
  return `<ul class="bars ${cls || ''}">${rows.map(([k, n]) => `<li><a href="${linkTo(key, k)}"><span class="t">${esc(k)}</span><span class="c">${n}</span><span class="bar" aria-hidden="true"><i style="width:${n / max * 100}%"></i></span><span class="sr">View ${n} papers in the library</span></a></li>`).join('')}</ul>`;
}
function yearChart() {
  const m = new Map(); state.papers.forEach(p => { if (p.year) m.set(p.year, (m.get(p.year) || 0) + 1); });
  let ys = [...m.keys()].sort((a, b) => a - b); if (!ys.length) return '<p>No year data.</p>';
  const lo = Math.max(ys[0], 1995), hi = ys[ys.length - 1], rows = [];
  let early = 0; m.forEach((n, y) => { if (y < lo) early += n; });
  for (let y = lo; y <= hi; y++) rows.push([y, m.get(y) || 0]);
  const max = Math.max(...rows.map(r => r[1]), 1), W = 40, H = 190, top = 24, bw = 28, w = rows.length * W + 20;
  const bars = rows.map(([y, n], i) => {
    const h = n / max * (H - top - 30), x = 10 + i * W, yy = H - 30 - h;
    return `<a href="${linkTo('year', y)}" aria-label="${y}: ${n} papers. View in library"><title>${y}: ${n} papers</title>
      <rect class="b" x="${x}" y="${yy}" width="${bw}" height="${Math.max(h, n ? 2 : 0)}" fill="#1f3a68" rx="2"/>
      <rect x="${x - 4}" y="${top}" width="${bw + 8}" height="${H - top}" fill="transparent"/>
      <text x="${x + bw / 2}" y="${yy - 5}" text-anchor="middle" font-size="12" fill="#1a1a1a">${n || ''}</text>
      <text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="12" fill="#4a4f57">${i % 2 === 0 || rows.length < 14 ? String(y).slice(-2).padStart(2, '0') : ''}</text></a>`;
  }).join('');
  return `<div class="chart-scroll" role="region" aria-label="Papers by year published, scrollable" tabindex="0">
    <svg viewBox="0 0 ${w} ${H}" role="group" aria-label="Column chart of papers per year, ${lo} to ${hi}"><line x1="0" y1="${H - 30}" x2="${w}" y2="${H - 30}" stroke="#6b7280"/>${bars}</svg></div>
    <p class="muted" style="margin:4px 0 0">Axis labels show the last two digits of the year. Each column links to that year in the library.${early ? ` ${early} older papers (before ${lo}) are not shown.` : ''}</p>
    <details class="tbl"><summary>View as a table</summary><table class="data"><caption class="sr">Papers per year</caption><thead><tr><th scope="col">Year</th><th scope="col">Papers</th></tr></thead><tbody>${rows.slice().reverse().map(([y, n]) => `<tr><td>${y}</td><td>${n}</td></tr>`).join('')}</tbody></table></details>`;
}
function renderDashboard(main) {
  const P = state.papers, d = state.data;
  const newWeek = P.filter(isNew).length, last12 = P.filter(p => p.date && daysAgo(p.date.slice(0, 10)) <= 365).length;
  const absPct = Math.round(P.filter(p => p.abstract.length > 50).length / P.length * 100);
  const srcMap = countBy(p => p.sources), tagMap = countBy(p => p.tags), topicMap = countBy(p => [p.topic]);
  const venMap = countBy(p => p.venue ? [p.venue] : []);
  const top = [...P].sort((a, b) => (b.cites || 0) - (a.cites || 0)).slice(0, 8);
  const newest = [...P].filter(p => p.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  const runs = [...d.runs].reverse().slice(0, 10), lastRun = d.runs[d.runs.length - 1];
  const li = p => `<li><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}<span class="sr"> (opens in a new tab)</span></a><span class="m">${esc(authorShort(p, 3))} · ${p.year || 'n.d.'} · ${p.cites || 0} citations</span></li>`;
  main.innerHTML = `
    <div class="page-head"><h2 style="font-size:1.6rem">Dashboard</h2>
      <p>An overview of the library. Select any bar or number to see those papers in the library.</p></div>
    <div class="kpis">
      <div class="kpi"><a href="#/library"><span class="v">${P.length}</span><span class="l">Papers in the library</span></a></div>
      <div class="kpi"><a href="#/library?new=1"><span class="v">${newWeek}</span><span class="l">New in the last 7 days</span></a></div>
      <div class="kpi"><span class="v">${last12}</span><span class="l">Published in the last 12 months</span></div>
      <div class="kpi"><span class="v">${absPct}%</span><span class="l">Have an abstract</span></div>
      <div class="kpi"><span class="v">${srcMap.size}</span><span class="l">Sources contributing</span></div>
    </div>
    <div class="grid2">
      <section class="card wide"><h2>Papers by year published</h2>${yearChart()}</section>
      <section class="card"><h2>By method or measure</h2>${barList(tagMap, 'tag', '', 10)}<p class="muted" style="margin:8px 0 0">A paper can have more than one method.</p></section>
      <section class="card"><h2>By topic</h2>${barList(topicMap, 'topic', 'alt2')}<h2 style="margin-top:18px">By source</h2>${barList(srcMap, 'source', 'alt')}<p class="muted" style="margin:8px 0 0">Papers found in several sources count under each.</p></section>
      <section class="card"><h2>Top journals and venues</h2>${barList(venMap, 'q', 'alt3', 8)}</section>
      <section class="card"><h2>Most cited</h2><ol class="toplist">${top.map(li).join('')}</ol></section>
      <section class="card"><h2>Newest publications</h2><ol class="toplist">${newest.map(li).join('')}</ol></section>
      <section class="card"><h2>Daily update status</h2>
        <p style="margin-top:0">Last update: <strong>${esc(d.updated)}</strong>. Some sources limit requests and are skipped for a day, then retried.</p>
        ${lastRun && lastRun.sources ? `<table class="data"><caption class="sr">Source status from the last update</caption><thead><tr><th scope="col">Source</th><th scope="col">Status</th></tr></thead><tbody>${Object.entries(lastRun.sources).map(([s, v]) =>
          `<tr><td>${esc(s)}</td><td><span class="pill ${v.failed ? 'bad' : 'ok'}">${v.failed ? (v.ok ? 'Partly available' : 'Unavailable') : 'OK'}</span> <span class="muted">${v.ok} of ${v.ok + v.failed} searches</span></td></tr>`).join('')}</tbody></table>` : ''}
        <details class="tbl"><summary>Update history</summary><table class="data"><caption class="sr">Recent updates</caption><thead><tr><th scope="col">Date</th><th scope="col">New papers</th><th scope="col">Total</th></tr></thead><tbody>${runs.map(r => `<tr><td>${esc(r.date)}</td><td>${r.baseline ? 'Initial load' : '+' + r.added}</td><td>${r.total}</td></tr>`).join('')}</tbody></table></details>
      </section>
    </div>`;
}

/* ------------------------------------------------------------------ history */
function renderHistory(main) {
  const by = {}; state.papers.filter(p => !p.baseline).forEach(p => (by[p.first_seen] ||= []).push(p));
  const runs = [...state.data.runs].reverse();
  main.innerHTML = `<div class="page-head"><h2 style="font-size:1.6rem">History</h2>
    <p>What each daily update added. The first two days are the initial load, so they are not counted as new.</p></div>
    <div class="history">${runs.map(r => {
      const items = by[r.date] || [], dt = new Date(r.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      return `<section><div class="day"><h2>${esc(dt)}</h2><span class="muted">${r.baseline ? 'Initial load' : '+' + items.length + ' new'} · ${r.total} papers in total</span></div>
        ${items.length ? items.map(card).join('') : `<p class="muted">${r.baseline ? 'The library was first built on this day.' : 'No new papers were found.'}</p>`}</section>`;
    }).join('')}</div>`;
  main.onchange = e => { const cb = e.target.closest('.pick'); if (!cb) return; const id = cb.closest('.paper').dataset.id; cb.checked ? state.sel.add(id) : state.sel.delete(id); cb.closest('.paper').classList.toggle('is-sel', cb.checked); saveSel(); };
  main.onclick = e => { const c = e.target.closest('.cite'); if (c) copyText(apa(state.byId.get(c.closest('.paper').dataset.id))).then(ok => toast(ok ? 'APA citation copied to clipboard.' : 'Copy was blocked by the browser.')); };
}

/* ------------------------------------------------------------------ start */
load();
