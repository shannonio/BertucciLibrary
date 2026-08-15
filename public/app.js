// Bertucci Library — client app.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const KIND_LABELS = {
  book: 'Books',
  boardgame: 'Games',
  curriculum: 'Curriculum',
  material: 'Supplies',
  media: 'Media',
};
const KIND_SHORT = {
  book: 'Book', boardgame: 'Game', curriculum: 'Curric', material: 'Supply', media: 'Media',
};

let health = { claude: false };

function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

// =============================================================== Navigation

function goto(name) {
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('.tab').forEach((t) => {
    const on = t.dataset.goto === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  if (name === 'ask') setTimeout(() => $('#ask-input').focus(), 120);
  history.replaceState(null, '', `#${name}`);
}

$$('.tab').forEach((t) => t.addEventListener('click', () => goto(t.dataset.goto)));

// =============================================================== Library

const state = { q: '', kind: '', offset: 0, total: 0 };
const PAGE = 60;

// Grid suits books and games, where the cover is the identifier. List suits the
// thousands of Drive files, where the filename and folder are. Remembered
// between sessions.
let view = localStorage.getItem('view') === 'list' ? 'list' : 'grid';

const VIEW_ICONS = {
  // Showing a grid icon means "switch to grid", so the icon is the *other* mode.
  grid: '<rect x="4" y="6" width="16" height="2.5" rx="1"/><rect x="4" y="11" width="16" height="2.5" rx="1"/><rect x="4" y="16" width="16" height="2.5" rx="1"/>',
  list: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
};

function applyView() {
  $('#grid').classList.toggle('list', view === 'list');
  // The icon advertises what you'd get by tapping, not the current state.
  $('#view-icon').innerHTML = VIEW_ICONS[view];
  $('#view-icon').setAttribute('fill', 'currentColor');
  $('#view-icon').setAttribute('stroke', 'none');
  $('#view-toggle').title = view === 'grid' ? 'Switch to list view' : 'Switch to grid view';
}

$('#view-toggle').addEventListener('click', () => {
  view = view === 'grid' ? 'list' : 'grid';
  localStorage.setItem('view', view);
  applyView();
  loadLibrary();
});

function coverMarkup(item, { badge = true } = {}) {
  const badgeHtml =
    badge && item.kind && item.kind !== 'book'
      ? `<span class="kind-badge">${esc(KIND_SHORT[item.kind] || item.kind)}</span>`
      : '';

  if (item.cover_url) {
    // A dead or hotlink-blocked URL must not leave an empty box. Carry enough
    // of the item on the element to rebuild the right kind of card in place.
    return `<div class="cover">
      <img src="${esc(item.cover_url)}" alt="" loading="lazy" decoding="async"
           onerror="window.__coverFailed(this)"
           data-kind="${esc(item.kind)}"
           data-title="${esc(item.title)}"
           data-creator="${esc(item.creator || '')}"
           data-genre="${esc(item.genre || '')}"
           data-players="${esc(item.players || '')}"
           data-play="${esc(item.play_time || '')}"
           data-age="${esc(item.age_range || '')}">
      ${badgeHtml}</div>`;
  }
  if (item.kind === 'boardgame') {
    // No badge here — the card already leads with the genre ("WORD GAME"), and
    // the badge sits on top of it.
    return `<div class="cover">${gameFallback(item)}</div>`;
  }
  if (item.kind === 'curriculum' && item.web_url) {
    // Digital files have no cover at all. Show the file type and where it
    // lives, which is what tells them apart on a shelf of PDFs.
    return `<div class="cover">${docFallback(item)}</div>`;
  }
  return `<div class="cover">${fallbackCover(item.title, item.creator)}${badgeHtml}</div>`;
}

/**
 * Stable hue per genre, so all the dice games look related on the shelf and a
 * given game keeps its colour between sessions.
 */
function hueFor(text) {
  let h = 0;
  for (const ch of String(text || 'x')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * Board game box art is copyrighted, so no free database carries it — the
 * cards below stand in. They lead with the things that actually decide whether
 * a game fits an afternoon: who can play, how long, what age.
 */
function gameFallback(item) {
  const hue = hueFor(item.genre || item.title);
  const facts = [
    item.players && `${esc(item.players)} players`,
    item.play_time && esc(item.play_time),
    item.age_range && `Ages ${esc(item.age_range)}`,
  ].filter(Boolean);

  return `<div class="cover-fallback game" style="--gh:${hue}">
    <span class="cf-genre">${esc(item.genre || 'Game')}</span>
    <span class="cf-title">${esc(item.title)}</span>
    <span class="cf-facts">${facts.join('<br>')}</span>
  </div>`;
}

/** Card for a digital file: what kind it is, and which folder it came from. */
function docFallback(item) {
  const folder = String(item.file_path || '').split('/').slice(0, -1).pop() || '';
  return `<div class="cover-fallback doc">
    <span class="cf-genre">${esc(item.genre || 'File')}</span>
    <span class="cf-title">${esc(item.title.replace(/\.[a-z0-9]{2,5}$/i, ''))}</span>
    <span class="cf-facts">${esc(folder)}</span>
  </div>`;
}

function fallbackCover(title, author) {
  return `<div class="cover-fallback">
    <span class="cf-title">${esc(title)}</span>
    <span class="cf-author">${esc(author || '')}</span>
  </div>`;
}

/** Replace a broken image with the card that item would have had anyway. */
window.__coverFailed = (img) => {
  const d = img.dataset;
  const cover = img.closest('.cover');
  if (!cover) return;
  cover.innerHTML =
    d.kind === 'boardgame'
      ? gameFallback({
          title: d.title, genre: d.genre, players: d.players,
          play_time: d.play, age_range: d.age,
        })
      : fallbackCover(d.title, d.creator);
};

/**
 * `onerror` covers a 404, but not a URL that simply never answers — a wrong
 * scheme, a host that black-holes the request, a site that blocks hotlinking by
 * hanging. Those would leave an empty box indefinitely, so give every image a
 * deadline and fall back to the card when it passes.
 *
 * The deadline only applies to remote images. Locally cached covers are
 * `loading="lazy"`, so one below the fold legitimately hasn't started loading
 * yet — treating that as a failure replaced perfectly good covers with
 * fallback cards while scrolling.
 */
function sweepStalledCovers(root = document, ms = 8000) {
  setTimeout(() => {
    for (const img of root.querySelectorAll('.cover img')) {
      if (img.complete && img.naturalWidth > 0) continue;
      const src = img.getAttribute('src') || '';
      if (src.startsWith('/covers/')) continue; // served from disk; let it load
      window.__coverFailed(img);
    }
  }, ms);
}

/**
 * A direct "open the file" link, shown on anything with a URL — mostly Drive
 * curriculum. Saves opening the detail sheet just to reach the file.
 *
 * It's a sibling of the clickable card rather than nested inside it: an <a>
 * inside a <button> is invalid HTML and breaks keyboard navigation.
 */
function openLink(item, { label = false } = {}) {
  if (!item.web_url) return '';
  return `<a class="open-link" href="${esc(item.web_url)}" target="_blank" rel="noopener"
             title="Open in Google Drive" aria-label="Open ${esc(item.title)} in Google Drive">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
    ${label ? '<span>Open</span>' : ''}
  </a>`;
}

/** Secondary line: whatever best identifies this kind of thing at a glance. */
function itemSubtitle(item) {
  if (item.kind === 'boardgame') {
    return [item.players && `${item.players} players`, item.play_time, item.age_range && `ages ${item.age_range}`]
      .filter(Boolean).join(' · ');
  }
  if (item.kind === 'curriculum') {
    // The folder it lives in says far more than a (usually absent) author.
    return String(item.file_path || '').split('/').slice(1, -1).join(' / ');
  }
  return item.creator || '';
}

function itemCard(item) {
  const cls = ['item', item.kind === 'boardgame' ? 'game' : '', view === 'list' ? 'row' : '']
    .filter(Boolean).join(' ');

  if (view === 'list') {
    return `<div class="${cls}">
      <button class="item-hit" data-id="${item.id}">
        ${coverMarkup(item, { badge: false })}
        <span class="row-text">
          <span class="item-title">${esc(item.title)}</span>
          <span class="item-author">${esc(itemSubtitle(item))}</span>
        </span>
        ${item.kind !== 'book' ? `<span class="row-kind">${esc(KIND_SHORT[item.kind] || '')}</span>` : ''}
      </button>
      ${openLink(item)}
    </div>`;
  }

  return `<div class="${cls}">
    <button class="item-hit" data-id="${item.id}">
      ${coverMarkup(item)}
      <span class="item-title">${esc(item.title)}</span>
      <span class="item-author">${esc(itemSubtitle(item))}</span>
    </button>
    ${openLink(item)}
  </div>`;
}

/**
 * Search-as-you-type fires overlapping requests. Rather than dropping calls
 * while one is in flight (which leaves the grid showing a stale query), each
 * call takes a ticket and only the newest one is allowed to touch the DOM.
 */
let libRequestId = 0;

async function loadLibrary({ append = false } = {}) {
  const myId = ++libRequestId;
  const offset = append ? state.offset : 0;

  if (!append) $('#grid').innerHTML = '';
  $('#lib-spinner').hidden = false;
  $('#lib-empty').hidden = true;
  $('#load-more').hidden = true;

  try {
    const params = new URLSearchParams({ limit: PAGE, offset });
    if (state.q) params.set('q', state.q);
    if (state.kind) params.set('kind', state.kind);

    const data = await api(`/api/items?${params}`);
    if (myId !== libRequestId) return; // superseded by a newer keystroke

    state.total = data.total;
    state.offset = offset + data.items.length;

    $('#grid').insertAdjacentHTML('beforeend', data.items.map(itemCard).join(''));
    sweepStalledCovers($('#grid'));

    $('#lib-count').textContent = state.total
      ? `${state.total.toLocaleString()} item${state.total === 1 ? '' : 's'}`
      : '';
    $('#load-more').hidden = state.offset >= state.total;

    if (!state.total) {
      $('#lib-empty').hidden = false;
      $('#lib-empty-sub').textContent = state.q
        ? `No matches for “${state.q}”.`
        : 'Add something from the Add tab to get started.';
    }
  } catch (err) {
    if (myId === libRequestId) toast(err.message);
  } finally {
    if (myId === libRequestId) $('#lib-spinner').hidden = true;
  }
}

// Debounced search-as-you-type.
let searchTimer;
$('#search').addEventListener('input', (e) => {
  state.q = e.target.value.trim();
  $('#search-clear').hidden = !state.q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadLibrary(), 220);
});
$('#search').addEventListener('search', () => {
  state.q = $('#search').value.trim();
  loadLibrary();
});
$('#search-clear').addEventListener('click', () => {
  $('#search').value = '';
  state.q = '';
  $('#search-clear').hidden = true;
  loadLibrary();
});

$('#load-more').addEventListener('click', () => loadLibrary({ append: true }));

$('#grid').addEventListener('click', (e) => {
  // Ignore clicks on the open-in-Drive link, which is a sibling of the hit area.
  if (e.target.closest('.open-link')) return;
  const btn = e.target.closest('.item-hit');
  if (btn) openDetail(Number(btn.dataset.id));
});

async function buildKindChips() {
  const { byKind } = await api('/api/stats');
  const present = byKind.filter((k) => k.n > 0);
  const chips = [
    `<button class="chip" data-kind="" aria-pressed="true">All</button>`,
    ...present.map(
      (k) =>
        `<button class="chip" data-kind="${esc(k.kind)}" aria-pressed="false">${esc(
          KIND_LABELS[k.kind] || k.kind
        )} <span style="opacity:.6">${k.n}</span></button>`
    ),
  ];
  // A single-kind catalog needs no filter row at all.
  $('#kind-chips').innerHTML = present.length > 1 ? chips.join('') : '';
}

$('#kind-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#kind-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
  state.kind = chip.dataset.kind;
  loadLibrary();
});

// =============================================================== Detail sheet

function metaRow(label, value, cls = '') {
  if (!value) return '';
  return `<div class="meta-row"><dt>${esc(label)}</dt><dd class="${cls}">${esc(value)}</dd></div>`;
}

async function openDetail(id) {
  let item;
  try {
    item = await api(`/api/items/${id}`);
  } catch (err) {
    return toast(err.message);
  }

  $('#sheet-body').innerHTML = `
    <div class="detail-head">
      ${coverMarkup(item, { badge: false })}
      <div style="min-width:0">
        <h2 class="detail-title">${esc(item.title)}</h2>
        ${item.creator ? `<p class="detail-author">${esc(item.creator)}</p>` : ''}
        ${item.genre ? `<span class="flag">${esc(item.genre)}</span>` : ''}
      </div>
    </div>

    <dl class="meta-list">
      ${metaRow('Type', KIND_LABELS[item.kind] || item.kind)}
      ${metaRow('ISBN', item.isbn || item.isbn10, 'isbn')}
      ${metaRow('Subjects', item.subject)}
      ${metaRow('Ages', item.age_range)}
      ${metaRow('Players', item.players)}
      ${metaRow('Play time', item.play_time)}
      ${metaRow('Publisher', item.publisher)}
      ${metaRow('Published', item.published)}
      ${metaRow('Pages', item.page_count)}
      ${metaRow('Location', item.location)}
      ${metaRow('In folder', item.file_path)}
      ${metaRow('Notes', item.notes)}
    </dl>

    ${item.summary ? `<p class="detail-summary">${esc(item.summary)}</p>` : ''}

    <div class="detail-actions">
      ${
        item.web_url
          ? `<a class="btn primary" target="_blank" rel="noopener"
               href="${esc(item.web_url)}">Open file</a>`
          : ''
      }
      ${
        item.isbn
          ? `<a class="btn ghost" target="_blank" rel="noopener"
               href="https://openlibrary.org/isbn/${esc(item.isbn)}">Open Library</a>`
          : ''
      }
      ${
        health.imageSearch?.configured
          ? `<button class="btn ghost" data-find-cover="${item.id}">
               ${item.cover_url ? 'Change cover' : 'Find a cover'}
             </button>`
          : ''
      }
      <button class="btn ghost" data-ask-about="${esc(item.title)}">Ask about this</button>
      <button class="btn danger" data-delete="${item.id}">Remove</button>
    </div>`;

  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  $('#sheet-body').scrollTop = 0;
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
}

$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet-backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
});

$('#sheet-body').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delete]');
  if (del) {
    if (!confirm('Remove this item from the library?')) return;
    try {
      await api(`/api/items/${del.dataset.delete}`, { method: 'DELETE' });
      closeSheet();
      toast('Removed');
      loadLibrary();
      buildKindChips();
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  const findBtn = e.target.closest('[data-find-cover]');
  if (findBtn) {
    try {
      const item = await api(`/api/items/${findBtn.dataset.findCover}`);
      closeSheet();
      openPicker(item);
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  const askBtn = e.target.closest('[data-ask-about]');
  if (askBtn) {
    closeSheet();
    goto('ask');
    $('#ask-input').value = `Tell me about "${askBtn.dataset.askAbout}" and suggest a lesson I could build around it.`;
    autosize($('#ask-input'));
  }
});

// =============================================================== Cover picker

const picker = { itemId: null, kind: null, busy: false };

function openPicker(item) {
  if (!health.imageSearch?.configured) {
    return toast(health.imageSearch?.problem || 'Image search is not set up.', 7000);
  }
  picker.itemId = item.id;
  picker.kind = item.kind;
  $('#picker-title').textContent = item.title;
  // Fill the box before searching, so a failed search still leaves something
  // to edit and retry rather than an empty field.
  $('#picker-q').value =
    item.kind === 'boardgame'
      ? `${item.title} board game`
      : [item.title, (item.creator || '').replace(/\s*\([^)]*\)/g, '').split(/[,;]/)[0].trim()]
          .filter(Boolean)
          .join(' ');
  $('#picker-results').innerHTML =
    '<p class="picker-msg">Searching…</p>';
  $('#picker').hidden = false;
  $('#picker-backdrop').hidden = false;
  // Search straight away using a query built from the item, so the common case
  // is one tap rather than typing.
  runPickerSearch({ id: item.id });
}

function closePicker() {
  $('#picker').hidden = true;
  $('#picker-backdrop').hidden = true;
  picker.itemId = null;
}

$('#picker-close').addEventListener('click', closePicker);
$('#picker-backdrop').addEventListener('click', closePicker);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#picker').hidden) closePicker();
});

async function runPickerSearch({ id, q, kind } = {}) {
  const results = $('#picker-results');
  results.innerHTML = '<p class="picker-msg">Searching…</p>';
  $('#picker-go').disabled = true;

  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (id) params.set('id', id);
    if (kind) params.set('kind', kind);

    const data = await api(`/api/image-search?${params}`);
    if (data.query) $('#picker-q').value = data.query;

    if (!data.results.length) {
      // Games have no automatic source — say so plainly and point at the two
      // things that do work, rather than implying the search just failed.
      if (data.searchable === false) {
        const bgg = `https://boardgamegeek.com/geeksearch.php?action=search&objecttype=boardgame&q=${encodeURIComponent(
          $('#picker-title').textContent
        )}`;
        results.innerHTML = `<p class="picker-msg">
          No free catalog carries board game box art.<br>
          <a href="${bgg}" target="_blank" rel="noopener">Find it on BoardGameGeek</a>,
          right-click the box image, copy the address, and paste it above.
        </p>`;
        $('#paste-block').open = true;
      } else {
        results.innerHTML =
          '<p class="picker-msg">No images found. Try different words.</p>';
      }
      return;
    }

    results.innerHTML = data.results
      .map(
        // Not lazy: there are only ten, they're all on screen at once, and
        // deferring them leaves the picker showing empty boxes.
        (r, i) => `<button class="pick" data-i="${i}" title="${esc(r.source || '')}">
          <img src="${esc(r.thumbnail)}" alt="" decoding="async">
        </button>`
      )
      .join('');
    picker.results = data.results;
  } catch (err) {
    results.innerHTML = `<p class="picker-msg err">${esc(err.message)}</p>`;
  } finally {
    $('#picker-go').disabled = false;
  }
}

$('#picker-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#picker-q').value.trim();
  if (q) runPickerSearch({ q, kind: picker.kind });
});

/** Attach a URL — shared by tapping a result and by pasting one. */
async function attachCover(url) {
  if (!picker.itemId) return;
  await api(`/api/items/${picker.itemId}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  closePicker();
  toast('Cover updated');
  refreshLibraryQuietly();
}

$('#paste-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#paste-url').value.trim();
  if (!url || picker.busy) return;

  picker.busy = true;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  try {
    await attachCover(url);
    $('#paste-url').value = '';
  } catch (err) {
    toast(err.message, 6000);
  } finally {
    picker.busy = false;
    btn.disabled = false;
    btn.textContent = 'Use';
  }
});

$('#picker-results').addEventListener('click', async (e) => {
  const btn = e.target.closest('.pick');
  if (!btn || picker.busy) return;

  const chosen = picker.results?.[Number(btn.dataset.i)];
  if (!chosen || !picker.itemId) return;

  picker.busy = true;
  btn.dataset.state = 'saving';

  try {
    // The server downloads the image before saving, so a picture that can't be
    // fetched is rejected here rather than becoming a broken cover later.
    await attachCover(chosen.url);
  } catch (err) {
    toast(err.message, 6000);
    delete btn.dataset.state;
  } finally {
    picker.busy = false;
  }
});

// =============================================================== Ask

const chat = { messages: [], busy: false };

const SUGGESTIONS = [
  'What do we have on insects for a 6-year-old?',
  'Build me a week-long unit on weather using what we own.',
  'Which read-alouds pair well with a study of ancient Egypt?',
  'What poetry do we have?',
];

function renderChatIntro() {
  $('#chat').innerHTML = health.claude
    ? `<div class="chat-intro">
         <h3>Ask about your collection</h3>
         <p>Claude searches your actual catalog before answering, so recommendations
            come from what's on your shelves.</p>
         <div class="suggestions">
           ${SUGGESTIONS.map((s) => `<button class="suggestion">${esc(s)}</button>`).join('')}
         </div>
       </div>`
    : `<div class="msg err">
         <strong>Claude isn't set up yet.</strong><br>
         Create a <code>.env</code> file next to <code>package.json</code> containing
         <code>ANTHROPIC_API_KEY=sk-ant-…</code>, then restart the server.
         Browsing, search, and adding by ISBN all work without it.
       </div>`;
}

$('#chat').addEventListener('click', (e) => {
  const s = e.target.closest('.suggestion');
  if (s) {
    $('#ask-input').value = s.textContent;
    autosize($('#ask-input'));
    $('#ask-form').requestSubmit();
  }
});

$('#chat-reset').addEventListener('click', () => {
  chat.messages = [];
  renderChatIntro();
});

/**
 * Minimal Markdown -> HTML for Claude's replies: paragraphs, lists, bold,
 * italic, inline code. Everything is escaped first, so this can never inject.
 */
function renderMarkdown(src) {
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const out = [];
  let list = null;

  const closeList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const rawLine of String(src).split('\n')) {
    const line = rawLine.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      const h = line.match(/^#{1,4}\s+(.*)$/);
      out.push(h ? `<p><strong>${inline(h[1])}</strong></p>` : `<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
}
$('#ask-input').addEventListener('input', (e) => autosize(e.target));

$('#ask-input').addEventListener('keydown', (e) => {
  // Enter sends on a physical keyboard; Shift+Enter makes a newline. On phones
  // the enterkeyhint="send" key fires the same path.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#ask-form').requestSubmit();
  }
});

$('#ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (chat.busy) return;

  const input = $('#ask-input');
  const text = input.value.trim();
  if (!text) return;
  if (!health.claude) return toast('Add ANTHROPIC_API_KEY to .env first');

  if (!chat.messages.length) $('#chat').innerHTML = '';
  input.value = '';
  autosize(input);

  chat.messages.push({ role: 'user', content: text });
  $('#chat').insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div>`);

  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="what">Thinking…</span>`;
  $('#chat').append(thinking);
  scrollChat();

  chat.busy = true;
  $('#ask-send').disabled = true;

  let bubble = null;
  let acc = '';

  const finish = () => {
    chat.busy = false;
    $('#ask-send').disabled = false;
    thinking.remove();
    if (acc) chat.messages.push({ role: 'assistant', content: acc });
    scrollChat();
  };

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chat.messages }),
    });

    if (!res.ok || !res.body) {
      const e2 = await res.json().catch(() => ({}));
      throw new Error(e2.error || 'Could not reach the assistant.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Server-sent events are delimited by a blank line.
      const frames = buf.split('\n\n');
      buf = frames.pop();

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;

        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }

        if (ev.type === 'status') {
          thinking.querySelector('.what').textContent = ev.status;
        } else if (ev.type === 'text') {
          if (!bubble) {
            thinking.remove();
            bubble = document.createElement('div');
            bubble.className = 'msg bot';
            $('#chat').append(bubble);
          }
          acc += ev.text;
          bubble.innerHTML = renderMarkdown(acc);
          scrollChat();
        } else if (ev.type === 'error') {
          thinking.remove();
          $('#chat').insertAdjacentHTML('beforeend', `<div class="msg err">${esc(ev.error)}</div>`);
          scrollChat();
        }
      }
    }
  } catch (err) {
    thinking.remove();
    $('#chat').insertAdjacentHTML('beforeend', `<div class="msg err">${esc(err.message)}</div>`);
  } finally {
    finish();
  }
});

function scrollChat() {
  const el = $('#chat');
  el.scrollTop = el.scrollHeight;
}

// =============================================================== Add: ISBN

$('#isbn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('#isbn-input').value.trim();
  if (!raw) return;

  const status = $('#isbn-status');
  status.hidden = false;
  status.className = 'status';
  status.textContent = 'Looking it up…';
  $('#isbn-result').innerHTML = '';

  try {
    const meta = await api(`/api/lookup/isbn/${encodeURIComponent(raw)}`);
    status.hidden = true;
    $('#isbn-result').innerHTML = `
      <div class="candidate">
        ${coverMarkup(meta, { badge: false })}
        <div class="cand-body">
          <p class="cand-title">${esc(meta.title)}</p>
          <p class="cand-author">${esc(meta.creator || 'Unknown author')}</p>
          <div class="cand-flags">
            ${meta.isbn ? `<span class="flag">${esc(meta.isbn)}</span>` : ''}
            ${meta.published ? `<span class="flag">${esc(meta.published)}</span>` : ''}
          </div>
        </div>
        <div class="cand-actions">
          <button class="btn primary tiny" id="isbn-save">Add</button>
        </div>
      </div>`;

    $('#isbn-save').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await api('/api/items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'book',
            title: meta.title,
            creator: meta.creator,
            subject: meta.subject,
            summary: meta.summary,
            isbn: meta.isbn,
            isbn10: meta.isbn10,
            cover_url: meta.cover_url,
            publisher: meta.publisher,
            published: meta.published,
            page_count: meta.page_count,
            source: 'isbn',
            enrich_state: 'ok',
          }),
        });
        toast('Added to library');
        $('#isbn-input').value = '';
        $('#isbn-result').innerHTML = '';
        refreshLibraryQuietly();
      } catch (err) {
        toast(err.message);
        ev.target.disabled = false;
      }
    });
  } catch (err) {
    status.className = 'status err';
    status.textContent = err.message;
  }
});

// =============================================================== Add: photo

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = ''; // let the same file be picked again after a retry

  const status = $('#scan-status');
  const results = $('#scan-results');
  results.innerHTML = '';
  status.hidden = false;
  status.className = 'status';
  status.textContent = 'Reading the photo…';

  const preview = URL.createObjectURL(file);
  results.innerHTML = `<img class="scan-preview" src="${preview}" alt="Photo being scanned">`;

  try {
    const form = new FormData();
    form.append('photo', file);
    const res = await fetch('/api/scan', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed.');

    const candidates = data.candidates || [];
    if (!candidates.length) {
      status.className = 'status err';
      status.textContent = 'No book titles were legible in that photo. Try getting closer, with the covers well lit.';
      return;
    }

    status.className = 'status ok';
    status.textContent = `Found ${candidates.length} book${candidates.length === 1 ? '' : 's'}. Review, then add.`;

    results.insertAdjacentHTML('beforeend', candidates.map(candidateRow).join(''));
    results.insertAdjacentHTML(
      'beforeend',
      `<div style="margin-top:16px;display:flex;gap:8px">
         <button class="btn primary" id="scan-add-all">Add all</button>
         <button class="btn ghost" id="scan-clear">Discard</button>
       </div>`
    );

    window.__scanCandidates = candidates;
  } catch (err) {
    status.className = 'status err';
    status.textContent = err.message;
  } finally {
    setTimeout(() => URL.revokeObjectURL(preview), 30000);
  }
});

function candidateRow(c, i) {
  const conf = c.detected.confidence;
  return `<div class="candidate" data-idx="${i}">
    ${coverMarkup(c, { badge: false })}
    <div class="cand-body">
      <p class="cand-title">${esc(c.title)}</p>
      <p class="cand-author">${esc(c.creator || 'Unknown author')}</p>
      <div class="cand-flags">
        ${c.duplicate_of ? `<span class="flag warn">Already owned</span>` : ''}
        ${c.isbn ? `<span class="flag good">Matched</span>` : `<span class="flag warn">No ISBN found</span>`}
        ${conf !== 'high' ? `<span class="flag">${esc(conf)} confidence</span>` : ''}
      </div>
    </div>
    <div class="cand-actions">
      <button class="btn tiny ${c.duplicate_of ? 'ghost' : 'primary'}" data-add="${i}">
        ${c.duplicate_of ? 'Add anyway' : 'Add'}
      </button>
    </div>
  </div>`;
}

async function saveCandidate(c) {
  return api('/api/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'book',
      title: c.title,
      creator: c.creator,
      subject: c.subject,
      summary: c.summary,
      isbn: c.isbn,
      cover_url: c.cover_url,
      publisher: c.publisher,
      published: c.published,
      page_count: c.page_count,
      source: 'photo',
      enrich_state: c.resolved ? 'ok' : 'notfound',
    }),
  });
}

$('#scan-results').addEventListener('click', async (e) => {
  const one = e.target.closest('[data-add]');
  if (one) {
    const c = window.__scanCandidates?.[Number(one.dataset.add)];
    if (!c) return;
    one.disabled = true;
    try {
      await saveCandidate(c);
      one.textContent = 'Added';
      one.classList.remove('primary');
      one.classList.add('ghost');
      refreshLibraryQuietly();
    } catch (err) {
      toast(err.message);
      one.disabled = false;
    }
    return;
  }

  if (e.target.id === 'scan-add-all') {
    e.target.disabled = true;
    const rows = $$('#scan-results [data-add]').filter((b) => !b.disabled);
    let n = 0;
    for (const btn of rows) {
      const c = window.__scanCandidates[Number(btn.dataset.add)];
      try {
        await saveCandidate(c);
        btn.disabled = true;
        btn.textContent = 'Added';
        btn.classList.remove('primary');
        n++;
      } catch { /* keep going; the row stays actionable */ }
    }
    toast(`Added ${n} book${n === 1 ? '' : 's'}`);
    refreshLibraryQuietly();
    return;
  }

  if (e.target.id === 'scan-clear') {
    $('#scan-results').innerHTML = '';
    $('#scan-status').hidden = true;
    window.__scanCandidates = null;
  }
});

// =============================================================== Add: manual

$('#manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#manual-status');
  const title = $('#m-title').value.trim();
  if (!title) return;

  try {
    await api('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: $('#m-kind').value,
        title,
        creator: $('#m-creator').value.trim() || null,
        subject: $('#m-subject').value.trim() || null,
        age_range: $('#m-age').value.trim() || null,
        location: $('#m-location').value.trim() || null,
        notes: $('#m-notes').value.trim() || null,
        source: 'manual',
        enrich_state: 'ok',
      }),
    });
    e.target.reset();
    status.hidden = false;
    status.className = 'status ok';
    status.textContent = 'Added.';
    setTimeout(() => { status.hidden = true; }, 2500);
    refreshLibraryQuietly();
  } catch (err) {
    status.hidden = false;
    status.className = 'status err';
    status.textContent = err.message;
  }
});

function refreshLibraryQuietly() {
  buildKindChips();
  if ($('#view-library').hidden) state.offset = 0;
  else loadLibrary();
}

// =============================================================== Sheet sync

let lastSyncError = null;

function relativeTime(iso) {
  if (!iso) return 'never';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

/** Keep the header pill and the Add-tab card describing the same truth. */
function renderSheetStatus() {
  const sheet = health.sheet;
  const card = $('#sheet-card');
  const headerBtn = $('#sync-btn');

  if (!sheet?.configured) {
    card.hidden = true;
    headerBtn.hidden = true;
    return;
  }

  headerBtn.hidden = false;
  card.hidden = false;
  $('#sheet-open').href = sheet.url || '#';

  // Keep the description short and constant; the error goes in the status
  // line below it, so a long Google message can't swamp the card.
  const pending = sheet.pending || 0;
  const parts = [`Last synced ${relativeTime(sheet.lastPullAt)}.`];
  if (pending) {
    parts.push(`${pending} local change${pending === 1 ? '' : 's'} waiting to upload.`);
  }
  parts.push('Edits in the Sheet win.');
  $('#sheet-sub').textContent = parts.join(' ');

  const status = $('#sheet-status');
  if (lastSyncError) {
    status.hidden = false;
    status.className = 'status err';
    // Google's 403 body repeats itself; lead with the actionable half.
    status.textContent = lastSyncError.split('Original message:')[0].trim();
  } else {
    status.hidden = true;
  }
}

/**
 * Sync is deliberately non-blocking: the app stays fully usable from the local
 * catalog while it runs, so a slow or failing Google call never gates browsing.
 * Drives both the header pill and the Add-tab card.
 */
async function syncWithSheet({ silent = false } = {}) {
  if (!health.sheet?.configured || syncWithSheet._busy) return;
  syncWithSheet._busy = true;

  const headerBtn = $('#sync-btn');
  const cardBtn = $('#sheet-sync-btn');
  const label = $('#sync-label');

  headerBtn.dataset.state = 'busy';
  cardBtn.dataset.state = 'busy';
  cardBtn.disabled = true;
  label.textContent = 'Syncing';

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed.');

    lastSyncError = null;
    const p = data.pulled || {};
    const changed = (p.updated || 0) + (p.inserted || 0) + (p.deleted || 0);
    const pushed = (data.pushed?.appended || 0) + (data.pushed?.updated || 0);

    headerBtn.dataset.state = 'ok';
    label.textContent = 'Synced';
    setTimeout(() => {
      delete headerBtn.dataset.state;
      label.textContent = 'Sync';
    }, 2500);

    if (p.refusedDeletes) {
      toast(
        `The Sheet is missing ${p.refusedDeletes} items, so nothing was deleted. ` +
          `If that was intentional, run: npm run sheet:pull -- --force`,
        8000
      );
    } else if (!silent) {
      toast(changed ? `Synced — ${changed} change(s) from the Sheet` : 'Already up to date');
    }

    // Refresh health so pending count and last-synced time stay honest.
    try { health = await api('/api/health'); } catch { /* keep the old values */ }
    if (changed + pushed) refreshLibraryQuietly();
  } catch (err) {
    lastSyncError = err.message;
    headerBtn.dataset.state = 'error';
    headerBtn.title = err.message;
    label.textContent = 'Retry';
    if (!silent) toast(err.message, 7000);
  } finally {
    syncWithSheet._busy = false;
    cardBtn.disabled = false;
    delete cardBtn.dataset.state;
    renderSheetStatus();
  }
}

$('#sync-btn').addEventListener('click', () => syncWithSheet());
$('#sheet-sync-btn').addEventListener('click', () => syncWithSheet());

// =============================================================== Boot

async function boot() {
  $('#m-kind').innerHTML = Object.entries(KIND_LABELS)
    .map(([v, l]) => `<option value="${v}">${esc(l.replace(/s$/, ''))}</option>`)
    .join('');

  try {
    health = await api('/api/health');
  } catch { /* offline: keep browsing what the page can still reach */ }

  renderChatIntro();
  applyView();
  await buildKindChips();
  await loadLibrary();

  const hash = location.hash.slice(1);
  goto(['library', 'ask', 'add'].includes(hash) ? hash : 'library');

  renderSheetStatus();

  // Pull on open, after the local catalog is already on screen — the library
  // shows immediately and quietly updates a moment later.
  if (health.sheet?.configured) syncWithSheet({ silent: true });
}

boot();
