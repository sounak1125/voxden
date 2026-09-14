# site/

The Voxden marketing site at [voxden.app](https://voxden.app): plain HTML and
CSS, no framework, no build step. Everything in this folder is published as-is.

- `index.html` and the other pages — one file per page, served at clean URLs
  (`pricing.html` answers `/pricing`).
- `assets/site.css`, `assets/site.js` — the whole site's styling and behaviour.
- `assets/changelog.css` — the few rules only the changelog needs.
- `changelog.html` — generated, not hand-edited. See below.
- `_headers`, `_redirects` — Cloudflare Pages configuration.
- `robots.txt`, `sitemap.xml` — keep the sitemap in step when a page is added.

## Preview

```
node scripts/preview-site.js
```

Serves this folder on <http://127.0.0.1:4174/> the way Pages does: clean URLs,
`index.html` at `/`, no caching. Set `PORT` to use another port.

## Rebuild the changelog

```
node scripts/build-changelog.js
```

Reads every markdown file in `release-notes/` and rewrites `site/changelog.html`,
newest version first. The version comes from the notes (a `Version:` line, the
filename, or the "Voxden 2.1.2 ..." sentence); release dates live in the
`RELEASE_DATES` table at the top of the script, or in a `Released:` line at the
top of a note. Run it after every release-notes change and commit the result.

The page's `<head>`, nav and footer are copied out of `index.html` at build
time, so a nav change on the home page reaches the changelog on the next build.

## Deploy

Cloudflare Pages, connected to the repo:

- Build command: none
- Build output directory: `site`
- Root directory: repository root

Pushing to `main` publishes. `_headers` and `_redirects` are read by Pages and
are not served as pages themselves.
