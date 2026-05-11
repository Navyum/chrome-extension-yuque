#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertBoardToECharts, convertBoardToMermaid, convertBoardToSvg } from '../src/core/board-converter.js';

const DEFAULT_MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
const DEFAULT_ECHARTS_CDN = 'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lakeFile || !args.officialMd) {
    printUsage();
    process.exit(1);
  }

  const lakeFile = path.resolve(args.lakeFile);
  const officialMd = path.resolve(args.officialMd);
  const outputDir = path.resolve(args.outputDir || defaultOutputDir(lakeFile));

  const lakeHtml = await fs.readFile(lakeFile, 'utf8');
  const officialMarkdown = await fs.readFile(officialMd, 'utf8');
  const boards = extractBoardCards(lakeHtml);
  const officialImages = extractOfficialImages(officialMarkdown, path.dirname(officialMd));

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outputDir, 'official'), { recursive: true });
  await fs.mkdir(path.join(outputDir, 'local'), { recursive: true });

  const rows = [];
  for (let i = 0; i < boards.length; i += 1) {
    const index = i + 1;
    const board = boards[i];
    const local = `local/白板-${pad(index)}-local.svg`;
    const official = await materializeOfficialImage({
      image: officialImages[i],
      fallbackUrl: board.src,
      outputDir,
      index,
    });

    const { svg } = await convertBoardToSvg(JSON.stringify(board));
    await fs.writeFile(path.join(outputDir, local), svg, 'utf8');

    // Mermaid is preferred for semantic reconstruction. ECharts is only used
    // for chart-like boards that Mermaid cannot render faithfully.
    const mermaid = convertBoardToMermaid(JSON.stringify(board));
    const echarts = mermaid ? '' : convertBoardToECharts(JSON.stringify(board));

    rows.push({
      index,
      id: board.id || '',
      sourceUrl: board.src || '',
      official,
      local,
      mermaid,
      echarts,
    });
  }

  const manifest = rows.map((row) => ({
    index: row.index,
    id: row.id,
    official: row.official,
    local: row.local,
    sourceUrl: row.sourceUrl,
    mermaid: Boolean(row.mermaid),
    echarts: Boolean(row.echarts),
  }));

  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'index.html'), renderHtml(rows, {
    title: `${path.basename(lakeFile, path.extname(lakeFile))}白板对比`,
    mermaidCdn: args.mermaidCdn || DEFAULT_MERMAID_CDN,
    echartsCdn: args.echartsCdn || DEFAULT_ECHARTS_CDN,
  }), 'utf8');
  await fs.writeFile(path.join(outputDir, 'compare.md'), renderMarkdown(rows), 'utf8');

  const stats = {
    boards: rows.length,
    mermaid: rows.filter((row) => row.mermaid).length,
    echarts: rows.filter((row) => row.echarts).length,
    empty: rows.filter((row) => !row.mermaid && !row.echarts).length,
  };

  console.log(JSON.stringify({ outputDir, ...stats }, null, 2));
}

function parseArgs(argv) {
  const result = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      result.outputDir = argv[++i];
    } else if (arg === '--mermaid-cdn') {
      result.mermaidCdn = argv[++i];
    } else if (arg === '--echarts-cdn') {
      result.echartsCdn = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }
  result.lakeFile = positional[0];
  result.officialMd = positional[1];
  if (positional[2]) result.outputDir = positional[2];
  return result;
}

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/board-compare.mjs <lake-file> <official-md> [output-dir]',
    '  node scripts/board-compare.mjs <lake-file> <official-md> --out <output-dir>',
    '',
    'Output:',
    '  index.html     官方导出图 / 本地 SVG / Mermaid 或 ECharts 渲染三列对比页',
    '  compare.md     便于归档的 Markdown 对比文件',
    '  manifest.json  每个白板的转换状态',
    '  official/      从官方 Markdown 抽取或从 lake src 兜底下载的官方图',
    '  local/         本地转换得到的 SVG',
  ].join('\n'));
}

function defaultOutputDir(lakeFile) {
  const dir = path.dirname(lakeFile);
  const name = path.basename(lakeFile, path.extname(lakeFile));
  return path.join(dir, `${name}-白板对比`);
}

function extractBoardCards(html) {
  const cards = [];
  const pattern = /<card\b[^>]*\bname=(["'])board\1[^>]*>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const tag = match[0];
    const value = readHtmlAttr(tag, 'value');
    if (!value) continue;
    const board = parseLakeCardValue(value);
    if (board?.diagramData?.body) cards.push(board);
  }
  return cards;
}

function readHtmlAttr(tag, name) {
  const attrPattern = new RegExp(`\\b${name}=("([^"]*)"|'([^']*)')`, 'i');
  const match = tag.match(attrPattern);
  return match ? decodeHtmlEntities(match[2] || match[3] || '') : '';
}

function parseLakeCardValue(value) {
  const payload = value.startsWith('data:') ? value.slice(5) : value;
  return JSON.parse(decodeURIComponent(payload));
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractOfficialImages(markdown, baseDir) {
  const sectionImages = extractOfficialImagesBySection(markdown, baseDir);
  if (sectionImages.length) return sectionImages;

  const images = [];
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(markdown))) {
    const alt = decodeHtmlEntities(match[1] || '');
    const rawUrl = decodeHtmlEntities(match[2] || '');
    images.push({
      alt,
      rawUrl,
      source: resolveMarkdownImage(rawUrl, baseDir),
    });
  }

  // Generated comparison docs contain both official and local-rendered images.
  // Prefer explicitly official images first so the script can be used both with
  // Yuque's official Markdown export and with a previous comparison artifact.
  const officialImages = images.filter((image) => /官方|official/i.test(`${image.alt} ${image.rawUrl}`));
  if (officialImages.length) return officialImages;

  // Official exports usually label board images as 白板/画板. If those labels
  // are present, restrict matching to them so ordinary document images do not
  // shift the board-image sequence.
  const boardImages = images.filter((image) => /白板|画板|board/i.test(`${image.alt} ${image.rawUrl}`));
  return boardImages.length ? boardImages : images;
}

function extractOfficialImagesBySection(markdown, baseDir) {
  const result = [];
  const sectionPattern = /(?:^|\n)##\s*(?:白板|画板)\s*(\d+)[^\n]*\n([\s\S]*?)(?=\n##\s*(?:白板|画板)\s*\d+|\s*$)/g;
  let match;
  while ((match = sectionPattern.exec(markdown))) {
    const index = Number(match[1]);
    const section = match[2];
    const images = extractImagesFromMarkdown(section, baseDir);
    const official = images.find((image) => /官方|official/i.test(`${image.alt} ${image.rawUrl}`));
    const isComparisonArtifact = /本地转换|本地白板|local\//i.test(section);
    const board = isComparisonArtifact
      ? undefined
      : images.find((image) => /白板|画板|board/i.test(`${image.alt} ${image.rawUrl}`));
    const selected = official || board || (isComparisonArtifact ? undefined : images[0]);
    if (selected && Number.isFinite(index) && index > 0) result[index - 1] = selected;
  }
  return result;
}

function extractImagesFromMarkdown(markdown, baseDir) {
  const images = [];
  const pattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(markdown))) {
    const alt = decodeHtmlEntities(match[1] || '');
    const rawUrl = decodeHtmlEntities(match[2] || '');
    images.push({
      alt,
      rawUrl,
      source: resolveMarkdownImage(rawUrl, baseDir),
    });
  }
  return images;
}

function resolveMarkdownImage(rawUrl, baseDir) {
  if (/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('data:')) return rawUrl;
  if (rawUrl.startsWith('file://')) return fileURLToPath(rawUrl);
  return path.resolve(baseDir, decodeURIComponent(rawUrl));
}

async function materializeOfficialImage({ image, fallbackUrl, outputDir, index }) {
  const source = image?.source || fallbackUrl;
  if (!source) return '';

  try {
    const ext = extensionFromSource(source, '.jpeg');
    const rel = `official/白板-${pad(index)}-official${ext}`;
    const dest = path.join(outputDir, rel);
    if (typeof source === 'string' && source.startsWith('data:')) {
      await writeDataUrl(source, dest);
    } else if (/^https?:\/\//i.test(source)) {
      await downloadFile(source, dest);
    } else {
      await fs.copyFile(source, dest);
    }
    return rel;
  } catch (error) {
    console.warn(`官方图 ${index} 处理失败: ${error.message}`);
    return '';
  }
}

function extensionFromSource(source, fallback) {
  if (source.startsWith('data:')) {
    const mime = source.match(/^data:([^;,]+)/)?.[1] || '';
    return extensionFromMime(mime) || fallback;
  }

  try {
    const pathname = /^https?:\/\//i.test(source) ? new URL(source).pathname : source;
    const ext = path.extname(pathname).toLowerCase();
    return ext || fallback;
  } catch {
    return fallback;
  }
}

function extensionFromMime(mime) {
  const map = {
    'image/jpeg': '.jpeg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return map[mime] || '';
}

async function writeDataUrl(dataUrl, dest) {
  const [, meta = '', data = ''] = dataUrl.match(/^data:([^,]*),(.*)$/) || [];
  const buffer = meta.includes(';base64')
    ? Buffer.from(data, 'base64')
    : Buffer.from(decodeURIComponent(data));
  await fs.writeFile(dest, buffer);
}

async function downloadFile(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(dest, buffer);
}

function renderHtml(rows, options) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
:root { color-scheme: light; --border:#d8dadf; --muted:#6b7280; --bg:#f6f7f9; }
body { margin:0; background:var(--bg); color:#1f2328; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
header { position:sticky; top:0; z-index:10; padding:14px 20px; background:#fff; border-bottom:1px solid var(--border); }
h1 { margin:0 0 4px; font-size:18px; }
.summary { color:var(--muted); font-size:13px; }
.board { margin:18px; padding:14px; background:#fff; border:1px solid var(--border); border-radius:8px; }
.board-header { display:flex; gap:12px; align-items:baseline; margin-bottom:10px; }
.board-header strong { font-size:16px; }
.board-header span { color:var(--muted); }
.grid { display:grid; grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr) minmax(320px, 1.2fr); gap:12px; align-items:start; }
.panel { min-width:0; }
.panel-title { margin-bottom:6px; color:var(--muted); font-size:12px; font-weight:600; }
.frame { min-height:180px; max-height:540px; overflow:auto; border:1px solid var(--border); border-radius:6px; background:#fff; }
.frame img, .frame svg { display:block; max-width:100%; height:auto; margin:auto; }
.empty { padding:24px; color:var(--muted); text-align:center; }
.diagram-frame { padding:10px; }
.diagram-target { min-height:160px; }
.diagram-source-wrap { margin-top:8px; }
.diagram-source-wrap summary { cursor:pointer; color:var(--muted); font-size:12px; }
.diagram-source { max-height:260px; overflow:auto; padding:10px; border:1px solid var(--border); border-radius:6px; background:#f8fafc; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
.diagram-error { white-space:pre-wrap; color:#b3261e; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
@media (max-width: 1100px) { .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(options.title)}</h1>
  <div class="summary">共 ${rows.length} 个白板，Mermaid ${rows.filter((row) => row.mermaid).length} 个，ECharts ${rows.filter((row) => row.echarts).length} 个，无语义转换 ${rows.filter((row) => !row.mermaid && !row.echarts).length} 个。</div>
</header>
${rows.map(renderHtmlRow).join('\n')}
<script src="${escapeAttr(options.mermaidCdn)}"></script>
<script src="${escapeAttr(options.echartsCdn)}"></script>
<script>
(function () {
  function setError(target, message) {
    target.innerHTML = '<div class="diagram-error">' + String(message).replace(/[&<>]/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch];
    }) + '</div>';
  }

  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });
    document.querySelectorAll('.mermaid-source').forEach(function (source, index) {
      var target = document.getElementById(source.dataset.target);
      mermaid.render('rendered-mermaid-' + index, source.textContent)
        .then(function (result) { target.innerHTML = result.svg; })
        .catch(function (error) { setError(target, 'Mermaid 渲染失败：\\n' + (error && error.message ? error.message : error)); });
    });
  } else {
    document.querySelectorAll('.mermaid-target').forEach(function (target) {
      setError(target, 'Mermaid 加载失败，请检查网络或 CDN。');
    });
  }

  if (window.echarts) {
    document.querySelectorAll('.echarts-source').forEach(function (source) {
      var target = document.getElementById(source.dataset.target);
      try {
        var option = new Function('var option;\\n' + source.textContent + '\\nreturn option;')();
        var chart = echarts.init(target);
        chart.setOption(option);
      } catch (error) {
        setError(target, 'ECharts 渲染失败：\\n' + (error && error.message ? error.message : error));
      }
    });
  } else {
    document.querySelectorAll('.echarts-target').forEach(function (target) {
      setError(target, 'ECharts 加载失败，请检查网络或 CDN。');
    });
  }
})();
</script>
</body>
</html>
`;
}

function renderHtmlRow(row) {
  const diagram = row.mermaid
    ? renderDiagramPanel(row, 'Mermaid', 'mermaid', row.mermaid)
    : row.echarts
      ? renderDiagramPanel(row, 'ECharts', 'echarts', row.echarts)
      : '<div class="panel"><div class="panel-title">Mermaid / ECharts 渲染结果</div><div class="frame"><div class="empty">无语义转换</div></div></div>';

  return `<section class="board" id="board-${row.index}">
  <div class="board-header"><strong>白板 ${row.index}</strong><span>ID: ${escapeHtml(row.id || '-')}</span></div>
  <div class="grid">
    <div class="panel"><div class="panel-title">官方导出图</div>${renderImageFrame(row.official, `官方白板 ${row.index}`)}</div>
    <div class="panel"><div class="panel-title">本地转换 SVG</div>${renderImageFrame(row.local, `本地白板 ${row.index}`)}</div>
    ${diagram}
  </div>
</section>`;
}

function renderImageFrame(src, alt) {
  if (!src) return '<div class="frame"><div class="empty">无官方图</div></div>';
  return `<div class="frame"><a href="${escapeAttr(src)}" target="_blank"><img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}"></a></div>`;
}

function renderDiagramPanel(row, title, type, source) {
  const targetId = `diagram-board-${row.index}`;
  return `<div class="panel">
      <div class="panel-title">${title} 渲染结果</div>
      <div class="frame diagram-frame"><div class="diagram-target ${type}-target" id="${targetId}"></div></div>
      <details class="diagram-source-wrap"><summary>${title} 源码</summary><pre class="diagram-source ${type}-source" data-target="${targetId}">${escapeHtml(source)}</pre></details>
    </div>`;
}

function renderMarkdown(rows) {
  return rows.map((row) => {
    const source = row.mermaid
      ? `\`\`\`mermaid\n${row.mermaid}\n\`\`\``
      : row.echarts
        ? `\`\`\`echarts\n${row.echarts}\n\`\`\``
        : '无语义转换';
    return [
      `## 白板 ${row.index}`,
      '',
      `ID: ${row.id || '-'}`,
      '',
      '| 官方导出图 | 本地转换 SVG | Mermaid / ECharts |',
      '| --- | --- | --- |',
      `| ${row.official ? `![官方白板 ${row.index}](${row.official})` : '无官方图'} | ![本地白板 ${row.index}](${row.local}) | ${source.replace(/\n/g, '<br>')} |`,
      '',
    ].join('\n');
  }).join('\n');
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
