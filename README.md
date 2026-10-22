# Book Tracker

Cloudflare Worker (API + static site) with a Neon Postgres database.

- `src/index.js` – API: sign up / log in, books, leaderboard, ISBN lookup
- `public/` – the app (plain HTML/CSS/JS, no build step)
- Tables are created automatically on the first request.

## One-time setup

1. **Neon**: create a project and copy the connection string (it ends in `?sslmode=require`).
2. **GitHub**: push this folder to a new repo.
3. **Cloudflare**: Workers & Pages → Create → Import a repository, pick the repo.
   - Build command: leave blank (or `npm install`)
   - Deploy command: `npx wrangler deploy`
4. In the Worker's **Settings → Variables and Secrets**, add a secret named `DATABASE_URL` with the Neon connection string.

After that, every push to the main branch builds and deploys automatically.

## Local development

    npm install
    cp .dev.vars.example .dev.vars   # then paste your Neon URL
    npm run dev

Camera capture on iPhone needs HTTPS, so test scanning on the deployed workers.dev URL.

## Notes

- Barcode lookup uses Open Library first, then Google Books (no API keys needed).
- Notes are private: other readers see everything about a book except your notes.
- Passwords are hashed with PBKDF2; sessions are HttpOnly cookies that last 30 days.
