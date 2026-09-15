# Hero app marks

The twelve SVG marks reuse the brand contours already present in `site/index.html` (the Voxden website app strip). Assets remain local and require no image-generation service or remote requests.

| File | App | Treatment |
| --- | --- | --- |
| gmail.svg | Gmail | Brand-color regions clipped to the existing Gmail silhouette |
| google-docs.svg | Google Docs | Blue body, pale fold, white document lines |
| discord.svg | Discord | Solid Discord blurple |
| notion.svg | Notion | White mark for the dark UI |
| whatsapp.svg | WhatsApp | Solid WhatsApp green |
| cursor.svg | Cursor | White mark for the dark UI |
| claude.svg | Claude | Solid terracotta |
| figma.svg | Figma | Five brand colors using the local mark's outer contours |
| telegram.svg | Telegram | Blue circle with white paper plane |
| chrome.svg | Chrome | Existing four contours filled red, green, yellow, and blue |
| github.svg | GitHub | White mark for the dark UI |
| linear.svg | Linear | Solid Linear violet |

The former outline-only presentation has been removed. Every SVG has a one-unit viewBox inset, a title, and self-contained fills. Figma's interior outline cutouts were removed to restore filled lobes; its outer contours are retained. Gmail color regions, white negative-space backing, and Google Docs' fold color change presentation without changing the source silhouette. Chrome's third subpath is expressed with an equivalent absolute starting coordinate so its subpaths can receive separate colors.

Underlying mark provenance is inherited from the existing website source. This task did not independently revalidate each mark against its owner's latest brand kit. These are decorative familiar-app marks, not integration controls or claims of affiliation. Motion, size, opacity, and interaction belong to the containing UI.
