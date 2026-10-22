const root = document.getElementById('app');
let me = null;

// ---------- Helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

const fmtDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

function dateText(book) {
  if (book.start_date && book.end_date) return `${fmtDate(book.start_date)} to ${fmtDate(book.end_date)}`;
  if (book.end_date) return `Finished ${fmtDate(book.end_date)}`;
  if (book.start_date) return `Started ${fmtDate(book.start_date)}`;
  return '';
}

function starsHtml(rating) {
  if (rating === null || rating === undefined) return '';
  return `<span class="stars" role="img" aria-label="${rating} out of 5 stars">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>`;
}

const fmtNum = (n) => Number(n).toLocaleString();

// A book without a cover gets a colored tile with its initials, so every row has a "spine"
function coverHtml(book, large = false) {
  let hash = 0;
  for (const ch of book.title || '') hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const initials = (book.title || '?')
    .split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const img = book.cover_url ? `<img src="${esc(book.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  return `<div class="cover${large ? ' large' : ''}" style="background:hsl(${hash} 35% 36%)" aria-hidden="true">${esc(initials)}${img}</div>`;
}

// Remove a cover image that fails to load so the colored tile shows through
document.addEventListener(
  'error',
  (e) => {
    if (e.target instanceof HTMLImageElement && e.target.closest('.cover')) e.target.remove();
  },
  true
);

// Cover APIs sometimes return a tiny 1x1 placeholder for unknown books
document.addEventListener(
  'load',
  (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.closest('.cover') && img.naturalWidth <= 1) img.remove();
  },
  true
);

// ---------- Layout ----------

const ICONS = {
  books: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6v13"/><path d="M12 6v13"/><path d="M21 6v13"/>',
  stats: '<path d="M5 20v-6"/><path d="M12 20V4"/><path d="M19 20V10"/>',
  leaderboard: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10"/><path d="M17 4v8a5 5 0 0 1-10 0V4"/><path d="M5 9a2 2 0 1 0 4 0a2 2 0 1 0-4 0"/><path d="M15 9a2 2 0 1 0 4 0a2 2 0 1 0-4 0"/>',
  account: '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0"/><path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
};
const icon = (name, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function shell(inner, active) {
  const tab = (hash, label, key) =>
    `<a class="tab" href="${hash}"${active === key ? ' aria-current="page"' : ''}>${icon(key)}<span>${label}</span></a>`;
  root.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/"><img class="brand-icon" src="/icon-mark.svg" alt="" width="28" height="28">Book Tracker</a>
      </div>
    </header>
    <main>${inner}</main>
    <nav class="tabbar" aria-label="Main">
      <div class="tabbar-inner">
        ${tab('#/', 'My books', 'books')}
        ${tab('#/stats', 'Stats', 'stats')}
        <a class="tab add" href="#/add"${active === 'add' ? ' aria-current="page"' : ''}>
          <span class="fab">${icon('plus', 26)}</span><span class="sr-only">Add a book</span>
        </a>
        ${tab('#/leaderboard', 'Leaderboard', 'leaderboard')}
        ${tab('#/account', 'Account', 'account')}
      </div>
    </nav>`;
}

function showError(err) {
  if (err.status === 401) {
    me = null;
    return route();
  }
  const main = root.querySelector('main');
  if (main) main.innerHTML = `<p class="message error">${esc(err.message)}</p>`;
}

// ---------- Login / sign up ----------

function renderAuth(mode = 'login') {
  const signup = mode === 'signup';
  root.innerHTML = `
    <section class="auth">
      <img class="auth-icon" src="/icon.svg" alt="" width="72" height="72">
      <h1>Book Tracker</h1>
      <p class="tagline">${signup ? 'Create an account to start your reading log.' : 'Log in to see your reading log.'}</p>
      <form class="panel" id="auth-form">
        <div id="auth-error"></div>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        </div>
        <div class="field">
          <label for="password">Password${signup ? ' <span class="hint">(at least 8 characters)</span>' : ''}</label>
          <input id="password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}">
        </div>
        <button class="btn" type="submit" style="width:100%">${signup ? 'Create account' : 'Log in'}</button>
      </form>
      <p class="switch">
        ${signup ? 'Already have an account?' : 'New here?'}
        <button type="button" id="switch">${signup ? 'Log in' : 'Create an account'}</button>
      </p>
    </section>`;
  document.getElementById('switch').addEventListener('click', () => renderAuth(signup ? 'login' : 'signup'));
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { user } = await api(signup ? '/signup' : '/login', {
        method: 'POST',
        body: { username: e.target.username.value, password: e.target.password.value },
      });
      me = user;
      go('#/');
    } catch (err) {
      document.getElementById('auth-error').innerHTML = `<p class="message error">${esc(err.message)}</p>`;
      btn.disabled = false;
    }
  });
}

// ---------- Book rows ----------

function bookRow(book, { editable }) {
  const meta = [
    starsHtml(book.rating),
    dateText(book) ? `<span>${esc(dateText(book))}</span>` : '',
    book.pages ? `<span>${fmtNum(book.pages)} pages</span>` : '',
  ].filter(Boolean).join('');
  const inner = `
      ${coverHtml(book)}
      <div>
        <h2 class="book-title">${esc(book.title)}</h2>
        <p class="book-author">${esc(book.author)}</p>
        ${meta ? `<div class="book-meta">${meta}</div>` : ''}
        ${book.notes ? `<p class="book-notes">${esc(book.notes)}</p>` : ''}
      </div>
      ${editable ? '<span class="chev" aria-hidden="true">›</span>' : '<span></span>'}`;
  // On your own list the whole row opens the book for editing
  return editable
    ? `<li><a class="book book-link" href="#/edit/${book.id}" aria-label="Edit ${esc(book.title)} by ${esc(book.author)}">${inner}</a></li>`
    : `<li><div class="book">${inner}</div></li>`;
}

function totalsText(books) {
  const pages = books.reduce((sum, b) => sum + (b.pages || 0), 0);
  const bookWord = books.length === 1 ? 'book' : 'books';
  return `${fmtNum(books.length)} ${bookWord}${pages ? ` · ${fmtNum(pages)} pages` : ''}`;
}

// ---------- My books ----------

async function renderMyBooks() {
  shell('<p class="loading">Loading your books…</p>', 'books');
  try {
    const { books } = await api('/books');
    const body = books.length
      ? `<ul class="books">${books.map((b) => bookRow(b, { editable: true })).join('')}</ul>`
      : `<div class="empty panel">
           <h2>Your shelf is empty</h2>
           <p>Add the first book you’ve read. You can scan its barcode or type it in.</p>
           <a class="btn" href="#/add">Add a book</a>
         </div>`;
    shell(
      `<div class="page-head">
         <div><h1>My books</h1><p>${books.length ? totalsText(books) : 'Nothing logged yet'}</p></div>
         <a class="btn" href="#/add">Add a book</a>
       </div>${body}`,
      'books'
    );
  } catch (err) {
    showError(err);
  }
}

// ---------- Stats ----------

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function renderStats() {
  shell('<p class="loading">Loading your stats…</p>', 'stats');
  try {
    const stats = await api(`/stats?today=${localToday()}`);
    const card = (label, s) => `
      <div class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-num">${fmtNum(s.books)}</div>
        <div class="stat-sub">${s.books === 1 ? 'book' : 'books'}${s.pages ? ` · ${fmtNum(s.pages)} pages` : ''}</div>
      </div>`;
    const years = stats.allTime.byYear;
    const max = Math.max(1, ...years.map((y) => y.books));
    const yearRows = years
      .map(
        (y) => `
        <li class="year-row">
          <span class="year-label">${y.year}</span>
          <span class="year-bar" aria-hidden="true"><span style="width:${Math.round((y.books / max) * 100)}%"></span></span>
          <span class="year-count"><strong>${fmtNum(y.books)}</strong> ${y.books === 1 ? 'book' : 'books'}${y.pages ? ` · ${fmtNum(y.pages)} pages` : ''}</span>
        </li>`
      )
      .join('');
    shell(
      `<div class="page-head"><div><h1>Stats</h1><p>Counts finished books only, meaning books with an end date.</p></div></div>
       <div class="stat-grid">
         ${card('Last 6 months', stats.last6)}
         ${card('Last year', stats.lastYear)}
         ${card('Year to date', stats.ytd)}
         ${card('All time', stats.allTime)}
       </div>
       <h2 class="section-title">All time, by year</h2>
       ${years.length
         ? `<ol class="years">${yearRows}</ol>`
         : '<div class="empty panel"><h2>No finished books yet</h2><p>Add an end date to a book and it will show up here.</p></div>'}`,
      'stats'
    );
  } catch (err) {
    showError(err);
  }
}

// ---------- Leaderboard ----------

async function renderLeaderboard(sort = 'books') {
  shell('<p class="loading">Loading the leaderboard…</p>', 'leaderboard');
  try {
    const { leaders } = await api(`/leaderboard?sort=${sort}`);
    const rows = leaders
      .map((u, i) => {
        const primary = sort === 'books' ? u.books : u.pages;
        const primaryLabel = sort === 'books' ? (u.books === 1 ? 'book' : 'books') : 'pages';
        const secondary = sort === 'books' ? `${fmtNum(u.pages)} pages` : `${fmtNum(u.books)} ${u.books === 1 ? 'book' : 'books'}`;
        return `
          <li class="leader${u.id === me.id ? ' me' : ''}">
            <span class="rank">${i + 1}</span>
            <a class="leader-name" href="#/user/${u.id}">${esc(u.username)}</a>
            <span class="leader-stats"><strong>${fmtNum(primary)}</strong><span>${primaryLabel} · ${secondary}</span></span>
          </li>`;
      })
      .join('');
    shell(
      `<div class="page-head"><div><h1>Leaderboard</h1><p>Counts finished books only, meaning books with an end date. Select a name to see what they’ve read.</p></div></div>
       <div class="segmented" role="group" aria-label="Rank by">
         <button type="button" data-sort="books" aria-pressed="${sort === 'books'}">Most books</button>
         <button type="button" data-sort="pages" aria-pressed="${sort === 'pages'}">Most pages</button>
       </div>
       ${leaders.length ? `<ol class="leaders">${rows}</ol>` : '<div class="empty panel"><h2>No finished books yet</h2><p>Add an end date to a book to put yourself on the board.</p></div>'}`,
      'leaderboard'
    );
    root.querySelectorAll('[data-sort]').forEach((btn) =>
      btn.addEventListener('click', () => renderLeaderboard(btn.dataset.sort))
    );
  } catch (err) {
    showError(err);
  }
}

// ---------- Another reader ----------

async function renderUser(id) {
  if (Number(id) === me.id) return go('#/');
  shell('<p class="loading">Loading…</p>', 'leaderboard');
  try {
    const { user, books } = await api(`/users/${id}`);
    shell(
      `<div class="page-head">
         <div><h1>${esc(user.username)}’s books</h1><p>${books.length ? totalsText(books) : 'No finished books yet'}</p></div>
         <a class="btn secondary" href="#/leaderboard">Back to leaderboard</a>
       </div>
       ${books.length ? `<ul class="books">${books.map((b) => bookRow(b, { editable: false })).join('')}</ul>` : '<div class="empty panel"><p>This reader hasn’t finished any books yet.</p></div>'}`,
      'leaderboard'
    );
  } catch (err) {
    showError(err);
  }
}

// ---------- Barcode scanning ----------

// Shrink big phone photos so decoding is quick and reliable
async function toScaledBlob(file, maxSide = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not read that image.'));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeBarcode(file) {
  const blob = await toScaledBlob(file);

  // Built-in detector (Chrome / Android) when available
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
      const found = await detector.detect(await createImageBitmap(blob));
      if (found.length) return found[0].rawValue;
    } catch {
      /* fall through to ZXing */
    }
  }

  // ZXing works on iPhone Safari, which has no BarcodeDetector
  const { BrowserMultiFormatReader } = await import('https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm');
  const url = URL.createObjectURL(blob);
  try {
    const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
    return result.getText();
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- Add / edit a book ----------

async function renderBookForm(id) {
  const editing = Boolean(id);
  shell('<p class="loading">Loading…</p>', editing ? 'books' : 'add');

  let book = { title: '', author: '', pages: '', rating: null, start_date: '', end_date: '', notes: '', isbn: '', cover_url: '' };
  if (editing) {
    try {
      book = { ...book, ...(await api(`/books/${id}`)).book };
    } catch (err) {
      return showError(err);
    }
  }

  const ratingOptions = [['', 'Not rated'], [0, '0 stars'], ...[1, 2, 3, 4, 5].map((n) => [n, `${'★'.repeat(n)} (${n})`])]
    .map(([v, label]) => `<option value="${v}"${String(book.rating ?? '') === String(v) ? ' selected' : ''}>${label}</option>`)
    .join('');

  shell(
    `<div class="page-head"><h1>${editing ? 'Edit book' : 'Add a book'}</h1></div>
     ${editing ? '' : `
     <section class="panel scan-panel" aria-labelledby="scan-title">
       <h2 id="scan-title" style="margin-bottom:.75rem">Fill it in from the barcode</h2>
       <div class="scan-row">
         <label class="btn file-btn">Take or choose a photo
           <input type="file" id="scan-file" accept="image/*" capture="environment" aria-label="Take or choose a photo of the barcode">
         </label>
         <div class="field">
           <label for="isbn-input">Or type the ISBN</label>
           <input id="isbn-input" inputmode="numeric" autocomplete="off" placeholder="978…">
         </div>
         <button type="button" class="btn secondary" id="isbn-go">Look up</button>
       </div>
       <div id="scan-status" style="margin-top:1rem" role="status"></div>
     </section>`}
     <form class="panel" id="book-form" novalidate>
       <div id="form-error"></div>
       <div class="cover-preview" id="cover-preview" ${book.cover_url ? '' : 'hidden'}>
         <div id="cover-slot">${book.cover_url ? coverHtml(book, true) : ''}</div>
         <p>Cover found for this book.</p>
       </div>
       <div class="field" style="margin-top:1rem">
         <label for="title">Title</label>
         <input id="title" name="title" value="${esc(book.title)}" required maxlength="300">
       </div>
       <div class="field">
         <label for="author">Author</label>
         <input id="author" name="author" value="${esc(book.author)}" required maxlength="300">
       </div>
       <div class="grid-2">
         <div class="field"><label for="start_date">Start date <span class="hint">(optional)</span></label>
           <input id="start_date" name="start_date" type="date" value="${esc(book.start_date || '')}"></div>
         <div class="field"><label for="end_date">End date <span class="hint">(optional)</span></label>
           <input id="end_date" name="end_date" type="date" value="${esc(book.end_date || '')}"></div>
         <div class="field"><label for="pages">Pages <span class="hint">(optional)</span></label>
           <input id="pages" name="pages" type="number" inputmode="numeric" min="1" step="1" value="${esc(book.pages ?? '')}"></div>
         <div class="field"><label for="rating">Rating <span class="hint">(optional)</span></label>
           <select id="rating" name="rating">${ratingOptions}</select></div>
       </div>
       <div class="field">
         <label for="notes">Notes <span class="hint">(optional, only you can see these)</span></label>
         <textarea id="notes" name="notes" maxlength="5000">${esc(book.notes || '')}</textarea>
       </div>
       <div class="actions">
         <button class="btn" type="submit">Save</button>
         <a class="btn secondary" href="#/">Cancel</a>
         ${editing ? `<button class="btn danger icon-btn" type="button" id="delete" aria-label="Delete book" title="Delete book">${icon('trash', 22)}</button>` : ''}
       </div>
     </form>`,
    editing ? 'books' : 'add'
  );

  const form = document.getElementById('book-form');
  const setError = (msg) => {
    document.getElementById('form-error').innerHTML = msg ? `<p class="message error">${esc(msg)}</p>` : '';
  };

  // Hidden values that come from a lookup rather than typed fields
  let isbn = book.isbn || '';
  let coverUrl = book.cover_url || '';

  function showCover() {
    const preview = document.getElementById('cover-preview');
    preview.hidden = !coverUrl;
    document.getElementById('cover-slot').innerHTML = coverUrl
      ? coverHtml({ title: form.elements.title.value, cover_url: coverUrl }, true)
      : '';
  }

  async function lookup(code) {
    const status = document.getElementById('scan-status');
    status.innerHTML = '<p class="message info">Looking up that book…</p>';
    try {
      const { book: found } = await api(`/lookup/${encodeURIComponent(code)}`);
      form.elements.title.value = found.title || '';
      form.elements.author.value = found.author || '';
      if (found.pages) form.elements.pages.value = found.pages;
      isbn = found.isbn;
      coverUrl = found.cover_url || '';
      showCover();
      status.innerHTML = '<p class="message info">Found it. Check the details below, then save.</p>';
    } catch (err) {
      if (err.status === 401) return showError(err);
      status.innerHTML = `<p class="message error">${esc(err.message)}</p>`;
    }
  }

  if (!editing) {
    document.getElementById('scan-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const status = document.getElementById('scan-status');
      status.innerHTML = '<p class="message info">Reading the barcode…</p>';
      try {
        const code = await decodeBarcode(file);
        if (!code) {
          status.innerHTML =
            '<p class="message error">Couldn’t read a barcode in that photo. Try again with the barcode filling most of the frame and well lit, or type the ISBN.</p>';
        } else {
          document.getElementById('isbn-input').value = code;
          await lookup(code);
        }
      } catch (err) {
        status.innerHTML = `<p class="message error">${esc(err.message)}</p>`;
      }
      e.target.value = '';
    });
    const go_ = () => {
      const code = document.getElementById('isbn-input').value.trim();
      if (code) lookup(code);
    };
    document.getElementById('isbn-go').addEventListener('click', go_);
    document.getElementById('isbn-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go_(); }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api(editing ? `/books/${id}` : '/books', {
        method: editing ? 'PUT' : 'POST',
        body: {
          title: form.elements.title.value,
          author: form.elements.author.value,
          pages: form.elements.pages.value,
          rating: form.elements.rating.value,
          start_date: form.elements.start_date.value,
          end_date: form.elements.end_date.value,
          notes: form.elements.notes.value,
          isbn,
          cover_url: coverUrl,
        },
      });
      go('#/');
    } catch (err) {
      if (err.status === 401) return showError(err);
      setError(err.message);
      btn.disabled = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  if (editing) {
    document.getElementById('delete').addEventListener('click', async () => {
      if (!confirm(`Delete “${book.title}”? This can’t be undone.`)) return;
      try {
        await api(`/books/${id}`, { method: 'DELETE' });
        go('#/');
      } catch (err) {
        setError(err.message);
      }
    });
  }
}

// ---------- Account ----------

function renderAccount() {
  shell(
    `<div class="page-head"><div><h1>Account</h1></div></div>
     <div class="panel">
       <p style="margin:0 0 1rem">Signed in as <strong>${esc(me.username)}</strong></p>
       <button class="btn secondary" id="logout" type="button">Log out</button>
     </div>`,
    'account'
  );
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    me = null;
    go('#/');
  });
}

// ---------- Router ----------

async function route() {
  if (!me) return renderAuth();
  const [, page, arg] = (location.hash || '#/').split('/');
  window.scrollTo(0, 0);
  switch (page) {
    case 'stats': return renderStats();
    case 'account': return renderAccount();
    case 'leaderboard': return renderLeaderboard();
    case 'user': return renderUser(arg);
    case 'add': return renderBookForm();
    case 'edit': return renderBookForm(arg);
    default: return renderMyBooks();
  }
}

window.addEventListener('hashchange', route);

(async function init() {
  try {
    me = (await api('/me')).user;
  } catch {
    me = null;
  }
  route();
})();
