# Website images

| File | Used by | Notes |
| --- | --- | --- |
| `icon.png` | Every page: favicon, touch icon and the header and footer brand mark | Brand art. |
| `logo.svg` | The download page's installer card and the home page's closing panel | Brand art. |
| `og.png` | Every page's `og:image` share card | Referenced with a `?v=` cache-buster; bump it when the file changes. |
| `edge-ring.svg` | `site.css`, the closing panel's edge glow | The nine-slice mask for the glow's bloom. |

`icon.png` and `logo.svg` are not produced by any script; see the brand asset
pipeline notes before replacing them.

## Product screenshots

No page shows a product screenshot: the home page draws the app live
(`assets/demo/`). `scripts/capture-site-shots.js` can still capture the
dashboard, sign-in and flow bar from the real app into this folder, but those
files are not referenced by the site, so add them to a page before keeping
them. With `--readme` it writes the README screenshots in `assets/readme/`
instead.
