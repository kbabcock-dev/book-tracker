import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { neon } from '@neondatabase/serverless';

const app = new Hono();

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Cloudflare Workers' maximum

// ---------- Database ----------

let schemaReady = null;

async function ensureSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username))`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`;
  await sql`CREATE TABLE IF NOT EXISTS books (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    isbn TEXT,
    pages INTEGER,
    rating INTEGER CHECK (rating BETWEEN 0 AND 5),
    start_date DATE,
    end_date DATE,
    notes TEXT,
    cover_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS books_user_idx ON books (user_id)`;
}

app.use('/api/*', async (c, next) => {
  if (!c.env.DATABASE_URL) {
    return c.json({ error: 'DATABASE_URL is not configured on the Worker.' }, 500);
  }
  const sql = neon(c.env.DATABASE_URL);
  c.set('sql', sql);
  if (!schemaReady) {
    schemaReady = ensureSchema(sql).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

// ---------- Crypto helpers ----------

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function createSession(c, userId) {
  const sql = c.get('sql');
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at)
            VALUES (${tokenHash}, ${userId}, now() + ${SESSION_DAYS + ' days'}::interval)`;
  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

// ---------- Auth middleware ----------

async function requireUser(c, next) {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Please log in.' }, 401);
  const sql = c.get('sql');
  const rows = await sql`
    SELECT u.id, u.username FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${await sha256(token)} AND s.expires_at > now()`;
  if (!rows.length) {
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'Your session has expired. Please log in again.' }, 401);
  }
  c.set('user', rows[0]);
  await next();
}

// ---------- Auth routes ----------

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;

app.post('/api/signup', async (c) => {
  const sql = c.get('sql');
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: 'Username must be 3–30 characters: letters, numbers, dots, dashes or underscores.' }, 400);
  }
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters.' }, 400);

  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(password, salt);
  try {
    const rows = await sql`INSERT INTO users (username, password_hash, salt)
                           VALUES (${username}, ${hash}, ${salt}) RETURNING id, username`;
    await createSession(c, rows[0].id);
    return c.json({ user: rows[0] });
  } catch (err) {
    if (err?.code === '23505') return c.json({ error: 'That username is taken.' }, 409);
    throw err;
  }
});

app.post('/api/login', async (c) => {
  const sql = c.get('sql');
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  const rows = await sql`SELECT id, username, password_hash, salt FROM users WHERE lower(username) = lower(${username})`;
  const user = rows[0];
  // Hash even when the user is missing so response time doesn't reveal which usernames exist
  const attempt = await hashPassword(password, user?.salt ?? '00'.repeat(16));
  if (!user || !timingSafeEqual(attempt, user.password_hash)) {
    return c.json({ error: 'Incorrect username or password.' }, 401);
  }
  await createSession(c, user.id);
  return c.json({ user: { id: user.id, username: user.username } });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, 'session');
  if (token) {
    const sql = c.get('sql');
    await sql`DELETE FROM sessions WHERE token_hash = ${await sha256(token)}`;
  }
  deleteCookie(c, 'session', { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', requireUser, (c) => c.json({ user: c.get('user') }));

// ---------- Books ----------

const BOOK_COLUMNS = `id, title, author, isbn, pages, rating,
  to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(end_date, 'YYYY-MM-DD') AS end_date,
  notes, cover_url`;

const PUBLIC_BOOK_COLUMNS = BOOK_COLUMNS.replace('notes, ', '');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBook(body) {
  const title = String(body.title ?? '').trim();
  const author = String(body.author ?? '').trim();
  if (!title) return { error: 'Title is required.' };
  if (!author) return { error: 'Author is required.' };
  if (title.length > 300 || author.length > 300) return { error: 'Title and author must be under 300 characters.' };

  const blank = (v) => v === undefined || v === null || v === '';

  let pages = null;
  if (!blank(body.pages)) {
    pages = Number(body.pages);
    if (!Number.isInteger(pages) || pages < 1 || pages > 100000) return { error: 'Pages must be a whole number above 0.' };
  }

  let rating = null;
  if (!blank(body.rating)) {
    rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) return { error: 'Rating must be between 0 and 5.' };
  }

  const dates = {};
  for (const key of ['start_date', 'end_date']) {
    const v = body[key];
    if (blank(v)) dates[key] = null;
    else if (DATE_RE.test(v) && !Number.isNaN(Date.parse(v))) dates[key] = v;
    else return { error: 'Dates must look like YYYY-MM-DD.' };
  }
  if (dates.start_date && dates.end_date && dates.end_date < dates.start_date) {
    return { error: 'The end date can’t be before the start date.' };
  }

  const isbn = blank(body.isbn) ? null : String(body.isbn).replace(/[^0-9X]/gi, '').slice(0, 13) || null;
  const notes = blank(body.notes) ? null : String(body.notes).slice(0, 5000);
  let cover_url = blank(body.cover_url) ? null : String(body.cover_url).slice(0, 1000);
  if (cover_url && !/^https:\/\//i.test(cover_url)) cover_url = null;

  return { book: { title, author, isbn, pages, rating, notes, cover_url, ...dates } };
}

// Newest first by end date, falling back to start date; undated books go last
const ORDER = `ORDER BY COALESCE(end_date, start_date) DESC NULLS LAST, created_at DESC`;

app.get('/api/books', requireUser, async (c) => {
  const sql = c.get('sql');
  const rows = await sql.query(
    `SELECT ${BOOK_COLUMNS} FROM books WHERE user_id = $1 ${ORDER}`,
    [c.get('user').id]
  );
  return c.json({ books: rows });
});

app.get('/api/books/:id', requireUser, async (c) => {
  const sql = c.get('sql');
  const rows = await sql.query(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = $1 AND user_id = $2`, [
    Number(c.req.param('id')),
    c.get('user').id,
  ]);
  if (!rows.length) return c.json({ error: 'Book not found.' }, 404);
  return c.json({ book: rows[0] });
});

app.post('/api/books', requireUser, async (c) => {
  const sql = c.get('sql');
  const { book, error } = parseBook(await c.req.json().catch(() => ({})));
  if (error) return c.json({ error }, 400);
  const rows = await sql.query(
    `INSERT INTO books (user_id, title, author, isbn, pages, rating, start_date, end_date, notes, cover_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${BOOK_COLUMNS}`,
    [c.get('user').id, book.title, book.author, book.isbn, book.pages, book.rating, book.start_date, book.end_date, book.notes, book.cover_url]
  );
  return c.json({ book: rows[0] }, 201);
});

app.put('/api/books/:id', requireUser, async (c) => {
  const sql = c.get('sql');
  const { book, error } = parseBook(await c.req.json().catch(() => ({})));
  if (error) return c.json({ error }, 400);
  const rows = await sql.query(
    `UPDATE books SET title=$3, author=$4, isbn=$5, pages=$6, rating=$7, start_date=$8, end_date=$9, notes=$10, cover_url=$11
     WHERE id=$1 AND user_id=$2 RETURNING ${BOOK_COLUMNS}`,
    [Number(c.req.param('id')), c.get('user').id, book.title, book.author, book.isbn, book.pages, book.rating, book.start_date, book.end_date, book.notes, book.cover_url]
  );
  if (!rows.length) return c.json({ error: 'Book not found.' }, 404);
  return c.json({ book: rows[0] });
});

app.delete('/api/books/:id', requireUser, async (c) => {
  const sql = c.get('sql');
  const rows = await sql`DELETE FROM books WHERE id = ${Number(c.req.param('id'))} AND user_id = ${c.get('user').id} RETURNING id`;
  if (!rows.length) return c.json({ error: 'Book not found.' }, 404);
  return c.json({ ok: true });
});

// ---------- Reading stats ----------

// Counts finished books (those with an end date), the same rule the leaderboard uses.
// The browser sends its own "today" so periods follow the reader's local date, not the server's.
app.get('/api/stats', requireUser, async (c) => {
  const sql = c.get('sql');
  const userId = c.get('user').id;
  const given = c.req.query('today');
  const today = given && DATE_RE.test(given) && !Number.isNaN(Date.parse(given)) ? given : new Date().toISOString().slice(0, 10);

  const periods = await sql.query(
    `SELECT
       COUNT(*) FILTER (WHERE end_date > ($2::date - INTERVAL '6 months')::date AND end_date <= $2::date)::int AS six_books,
       COALESCE(SUM(pages) FILTER (WHERE end_date > ($2::date - INTERVAL '6 months')::date AND end_date <= $2::date), 0)::int AS six_pages,
       COUNT(*) FILTER (WHERE end_date > ($2::date - INTERVAL '12 months')::date AND end_date <= $2::date)::int AS year_books,
       COALESCE(SUM(pages) FILTER (WHERE end_date > ($2::date - INTERVAL '12 months')::date AND end_date <= $2::date), 0)::int AS year_pages,
       COUNT(*) FILTER (WHERE end_date >= date_trunc('year', $2::date)::date AND end_date <= $2::date)::int AS ytd_books,
       COALESCE(SUM(pages) FILTER (WHERE end_date >= date_trunc('year', $2::date)::date AND end_date <= $2::date), 0)::int AS ytd_pages
     FROM books WHERE user_id = $1 AND end_date IS NOT NULL`,
    [userId, today]
  );

  const years = await sql.query(
    `SELECT EXTRACT(YEAR FROM end_date)::int AS year, COUNT(*)::int AS books, COALESCE(SUM(pages), 0)::int AS pages
     FROM books WHERE user_id = $1 AND end_date IS NOT NULL
     GROUP BY 1 ORDER BY 1 DESC`,
    [userId]
  );

  const p = periods[0];
  return c.json({
    today,
    last6: { books: p.six_books, pages: p.six_pages },
    lastYear: { books: p.year_books, pages: p.year_pages },
    ytd: { books: p.ytd_books, pages: p.ytd_pages },
    allTime: {
      books: years.reduce((n, y) => n + y.books, 0),
      pages: years.reduce((n, y) => n + y.pages, 0),
      byYear: years,
    },
  });
});

// ---------- Leaderboard & other readers ----------

app.get('/api/leaderboard', requireUser, async (c) => {
  const sql = c.get('sql');
  const sort = c.req.query('sort') === 'pages' ? 'pages' : 'books';
  const tiebreak = sort === 'books' ? 'pages' : 'books';
  const rows = await sql.query(
    `SELECT u.id, u.username, COUNT(b.id)::int AS books, COALESCE(SUM(b.pages), 0)::int AS pages
     FROM users u JOIN books b ON b.user_id = u.id AND b.end_date IS NOT NULL
     GROUP BY u.id, u.username
     ORDER BY ${sort} DESC, ${tiebreak} DESC, lower(u.username)
     LIMIT 100`
  );
  return c.json({ sort, leaders: rows });
});

// Another reader's finished books (same rule as the leaderboard). Their private notes are left out.
app.get('/api/users/:id', requireUser, async (c) => {
  const sql = c.get('sql');
  const id = Number(c.req.param('id'));
  const users = await sql`SELECT id, username FROM users WHERE id = ${id}`;
  if (!users.length) return c.json({ error: 'Reader not found.' }, 404);
  const rows = await sql.query(
    `SELECT ${PUBLIC_BOOK_COLUMNS} FROM books WHERE user_id = $1 AND end_date IS NOT NULL ${ORDER}`,
    [id]
  );
  return c.json({ user: users[0], books: rows });
});

// ---------- ISBN lookup (Open Library, then Google Books) ----------

const ISBN_RE = /^(\d{9}[\dX]|\d{13})$/;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'BookTracker/1.0' }, cf: { cacheTtl: 86400 } });
  if (!res.ok) throw new Error(`Lookup failed: ${res.status}`);
  return res.json();
}

async function lookupIsbn(isbn) {
  let found = null;
  try {
    const data = await fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const d = data[`ISBN:${isbn}`];
    if (d) {
      found = {
        title: d.subtitle ? `${d.title}: ${d.subtitle}` : d.title,
        author: (d.authors || []).map((a) => a.name).join(', '),
        pages: d.number_of_pages || null,
        cover_url: d.cover?.medium || d.cover?.large || null,
      };
    }
  } catch (err) {
    console.error('Open Library lookup failed', err);
  }

  // Fill any gaps (or find the book at all) using Google Books
  if (!found || !found.author || !found.cover_url || !found.pages) {
    try {
      const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      const v = data.items?.[0]?.volumeInfo;
      if (v) {
        const thumb = (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:');
        found = {
          title: found?.title || (v.subtitle ? `${v.title}: ${v.subtitle}` : v.title),
          author: found?.author || (v.authors || []).join(', '),
          pages: found?.pages || v.pageCount || null,
          cover_url: found?.cover_url || thumb || null,
        };
      }
    } catch (err) {
      console.error('Google Books lookup failed', err);
    }
  }
  return found ? { isbn, ...found } : null;
}

app.get('/api/lookup/:isbn', requireUser, async (c) => {
  const isbn = c.req.param('isbn').replace(/[^0-9X]/gi, '').toUpperCase();
  if (!ISBN_RE.test(isbn)) return c.json({ error: 'That doesn’t look like an ISBN.' }, 400);
  const result = await lookupIsbn(isbn);
  if (!result) return c.json({ error: 'No book found for that barcode. You can enter the details by hand.' }, 404);
  return c.json({ book: result });
});

export default app;
