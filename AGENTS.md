# AGENTS.md

Project instructions for Codex and other coding agents working in this repository.

## Project Overview

YuqueOut is a Chrome Manifest V3 extension for exporting Yuque knowledge bases to Markdown, Word, PDF, Excel, CSV, HTML, PNG, JPG, and SVG. The product promise is local-first export with zero data upload.

Primary surfaces:

- Extension code: `src/`
- Chrome extension manifest and localization: `manifest.json`, `_locales/`
- Static website and blog: `docs/`
- Build config: `webpack.config.js`
- Samples and conversion fixtures: `samples/`, `scripts/`

Do not use emoji in UI copy, docs, commit messages, or generated content for this project unless the user explicitly asks for it.

## Commands

Use these commands from the repository root:

```bash
npm install
npm run build
npm run build:watch
npm run pack
npm run compare:boards
```

Notes:

- `npm run build` outputs to `dist/`.
- `npm run pack` creates `build/chrome-extension-yuque-export.zip`.
- `dist/`, `build/`, `node_modules/`, and `.DS_Store` are ignored and should not be committed.
- `npm test` is currently a placeholder that exits with failure; do not report it as a meaningful test suite.

## Architecture

Manifest V3 entry points:

- `src/background.js`: service worker and main coordinator
- `src/popup.html` + `src/popup.js`: main extension UI
- `src/settings.html` + `src/settings.js`: options page
- `src/content/bubble.js`: Yuque page floating export bubble
- `src/offscreen.js`: Chrome Offscreen API for SVG to Canvas to PNG/JPG conversion

Core modules in `src/core/`:

- `yuque.js`: Yuque API wrapper, Cookie auth, RSA password validation
- `exporter.js`: export scheduler and local/API engine selection
- `lake-converter.js`: Lake HTML to Markdown
- `sheet-converter.js`: Lakesheet conversion to xlsx/csv/md/html
- `board-converter.js`: Lakeboard JSON to SVG
- `downloads.js`: `chrome.downloads` save logic
- `task-controller.js`: pause, resume, retry, and per-file task flow
- `messaging.js`: background to popup messaging
- `state.js`: background state
- `constants.js`: shared constants

Popup UI modules live in `src/ui/` and should stay split by responsibility: DOM helpers, state, actions, messaging, password, i18n, sponsor, rating, constants.

## Engineering Constraints

- Preserve the local-first privacy model. Do not add third-party uploads, telemetry, analytics, or remote processing without explicit user approval.
- Service workers have no browser DOM. Keep DOM parsing in service-worker-compatible code through existing patterns such as `@mixmark-io/domino`.
- Do not break the dual-engine design. Documents and sheets can use local conversion or official API paths depending on permissions and settings.
- Board PNG/JPG export depends on the offscreen document. Keep Canvas work in `src/offscreen.js` or the established offscreen flow.
- When adding user-facing UI text, update both `_locales/zh_CN/messages.json` and `_locales/en/messages.json` when applicable.
- Prefer existing module boundaries and helper functions over new abstractions.
- Avoid unrelated refactors while fixing bugs or adding narrow features.
- Do not overwrite existing image or asset filenames unless the user explicitly asks for replacement. Add a descriptive sibling filename instead.

## Blog And Docs Workflow

The static website lives under `docs/`; blog posts live under `docs/blog/`.

When adding or materially updating a blog post:

- Start by reviewing nearby posts in `docs/blog/` and mirror the existing page shell, navigation, footer, classes, metadata style, answer capsule, table of contents, related links, and CTA patterns.
- Choose one canonical URL per topic. If an old post already owns the search intent, update that page instead of creating a competing duplicate.
- Use practical, search-intent-first slugs such as `yuque-to-notion.html`, `yuque-export-troubleshooting.html`, or `yuque-image-hotlink-fix.html`.
- Update the post HTML with `title`, `description`, `keywords`, canonical URL, OG/Twitter metadata, `BlogPosting` JSON-LD, breadcrumb JSON-LD, and FAQ JSON-LD when there is a visible FAQ section.
- Keep visible FAQ content and FAQ JSON-LD aligned exactly in meaning.
- Preserve original `datePublished` for updated posts and set `dateModified` to the current edit date. If visible article metadata shows an update date, make that distinction clear instead of presenting an old post as newly published.
- Update `docs/blog/index.html`:
  - Add or update the visible article card.
  - Add or update the `Blog` JSON-LD `blogPost` entry.
  - Avoid duplicate cards for the same canonical URL.
- Update `docs/sitemap.xml` with the canonical URL and correct `lastmod`.
- Update `docs/llms.txt` for new important guides, especially migration, troubleshooting, comparison, and answer-capsule content. Also update its `last-updated` date.
- If a post updates an answer that appears in an older post, adjust the older post to point to the newer canonical guide instead of leaving conflicting guidance.
- Use official primary sources for platform capability claims when discussing Obsidian, Notion, Feishu, Yuque, Chrome, or browser APIs.
- Do not overclaim unsupported platform behavior. Prefer practical boundaries and verification checklists.
- For migration tutorials, clearly separate what the source platform exports, what the target platform imports, and what must be manually checked after import.
- For platform-specific claims, cite or link official docs in the article body when possible. If official docs differ by import location or product surface, explain the boundary instead of flattening it into a simple claim.

Blog article quality requirements:

- The first screen should quickly answer the main query. Include a short answer capsule near the top for high-intent searches.
- Use a clear H1 that contains the primary search intent. Do not use multiple H1s.
- Include a table of contents for long posts.
- Include concrete steps, decision tables, checklists, edge cases, and FAQ. Avoid generic marketing paragraphs.
- For tutorials, include realistic failure modes: permissions, images, attachments, large batches, ZIP limits, unsupported rich content, and post-import validation.
- Prefer exact workflow language over vague claims. Example: "导出 Markdown 后导入文件夹" is better than "一键迁移".
- Avoid hard time-saving claims unless they are framed as examples or supported by the article context.
- Use internal links to related YuqueOut guides instead of duplicating large sections.
- If adding a new destination-specific guide, update older broad guides so their answer points to the new canonical page.

Blog images:

- Store project-bound blog images in `docs/images/`.
- Prefer `.webp` for generated or compressed blog assets.
- Update `og:image`, `twitter:image`, JSON-LD `image`, and homepage card image references together.
- Use accurate `width` and `height` attributes for image tags.
- Avoid official product logos in generated illustrations unless the user explicitly asks and usage is appropriate.
- If the user says not to add illustrations yet, do not generate or insert article images until they explicitly ask.
- When generating new blog illustrations, use a Google Material / Google Workspace editorial illustration direction unless the user requests another style. This means "Google-inspired visual language", not copying Google assets:
  - 16:9 landscape blog cover, suitable for homepage cards and social previews.
  - Clean flat vector editorial illustration with generous white or warm off-white negative space.
  - Use a Google-like product palette: blue, red, yellow, and green as the main accents, plus neutral grays and dark navy for outlines or small UI details. Avoid purple-heavy SaaS gradients, cyberpunk colors, dark dashboards, and overly saturated one-color themes.
  - Use simple geometric construction: rounded rectangles, circles, dots, arcs, soft connectors, flat document cards, folders, checkmarks, warning badges, progress bars, and workflow arrows.
  - UI surfaces should feel Material-like: white cards, subtle shadows, thin light-gray strokes, rounded corners, clean hierarchy, and minimal decoration. Do not draw exact Google product screens.
  - Characters should be friendly, simplified, and human: rounded shapes, minimal facial features, slightly oversized hands, natural work posture, optimistic but not cartoonish. Avoid mascot-like fantasy creatures.
  - The composition should be calm, readable at card size, and built around one clear workflow metaphor. Prefer one primary character and one primary process instead of many competing scenes.
  - Use flat colors with very subtle texture or shadow only. Avoid photorealism, 3D renders, heavy grain, dramatic lighting, and cluttered UI text.
  - No readable UI text unless explicitly required. No official app logos, no Google logo, no brand names inside the image, no watermark, and no copied official artwork.
  - The visual metaphor should match the article topic: Obsidian uses vaults, Markdown files, local image assets, backlinks/graph nodes; Notion uses Markdown/ZIP import, nested page blocks, assets and databases; Feishu uses Markdown/Word/ZIP route selection, folders, knowledge-base hierarchy, permission/check icons.
  - A good prompt phrase is: "Google Material-style editorial vector illustration, clean off-white background, Google-like blue/red/yellow/green accents, friendly simplified human character, rounded Material UI cards, generous whitespace, no readable text, no logos, no watermark."
- Use `imagegen` for raster blog cover generation. If a reference image is provided, treat it as style reference only unless the user asks for direct editing.
- Save generated source output into `docs/images/` as a new descriptive `.webp` filename, for example `blog-obsidian-migration.webp`.
- Do not leave project-referenced images only under `$CODEX_HOME/generated_images/`.
- After adding images, verify the files exist and update all metadata and card references in the same change.

## SEO And GEO Guidance

For SEO and generative-engine retrieval:

- Use one clear H1 per page.
- Put the primary search intent in the title, H1, intro answer capsule, and at least one FAQ question.
- Use concrete task language: export, import, migrate, Markdown, ZIP, Word, images, attachments, permissions, retry, troubleshooting.
- Include concise answer capsules near the top for high-intent queries.
- Use internal links to related guides rather than repeating large overlapping sections.
- Keep `docs/llms.txt` accurate and concise. Treat it as a machine-readable source map, not marketing copy.

## Verification

Before finishing code changes, run the narrowest meaningful checks:

```bash
npm run build
git diff --check
```

For blog or docs changes, also validate JSON-LD and local image references. Pass the target HTML files before the heredoc:

```bash
node - docs/blog/index.html docs/blog/yuque-to-notion.html <<'NODE'
const fs = require('fs');
const path = require('path');
const files = process.argv.slice(2);
let ok = true;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  for (const [i, match] of blocks.entries()) {
    try { JSON.parse(match[1]); }
    catch (err) {
      console.error(`${file}: JSON-LD block ${i + 1}: ${err.message}`);
      ok = false;
    }
  }
  for (const [, src] of html.matchAll(/<img[^>]+src="\.\.\/images\/([^"]+)"/g)) {
    const img = path.join('docs/images', src);
    if (!fs.existsSync(img)) {
      console.error(`${file}: missing image ${img}`);
      ok = false;
    }
  }
}
process.exit(ok ? 0 : 1);
NODE
```

Replace the file list with the pages touched by the change.

For board-converter work, run:

```bash
npm run compare:boards
```

## Git And Collaboration

- Check `git status --short` before editing and before final response.
- The worktree may contain user changes. Do not revert changes you did not make.
- Use `rg` or `rg --files` for search.
- Use `apply_patch` for manual file edits.
- Keep commits, pushes, and destructive Git operations for explicit user requests only.
- When reporting completion, include files changed and checks run. If a check was not run, say so.
