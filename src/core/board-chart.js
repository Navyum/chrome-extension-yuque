import { stripHtml } from './board-text.js';

/**
 * Yuque board -> ECharts reconstruction for chart-like whiteboards.
 *
 * Mermaid is poor at numeric charts such as radar charts and progress ratio
 * boards. This module keeps those chart-specific heuristics out of the general
 * Mermaid converter and returns plain ECharts option code.
 */

export function renderBoardToECharts(body, helpers = {}) {
  if (!Array.isArray(body) || !body.length) return '';
  const model = createChartModel(body);

  if (looksLikeProgressRatio(model)) return renderProgressRatioECharts(model);
  if (looksLikeRadar(model)) return renderRadarECharts(model, helpers);
  return '';
}

function createChartModel(body) {
  const elements = [];
  function walk(list, parent = null) {
    if (!Array.isArray(list)) return;
    list.forEach(el => {
      const item = { ...el, __parent: parent };
      elements.push(item);
      if (el.children) walk(el.children, item);
      if (Array.isArray(el.contain) && el.contain[0] && typeof el.contain[0] === 'object') {
        walk(el.contain, item);
      }
    });
  }
  walk(body);
  return {
    body,
    elements,
    texts: elements.filter(el => el.type === 'text' && textOf(el)),
    pens: elements.filter(el => (el.type === 'pen' || el.type === 'freehand') && Array.isArray(el.points)),
    geometries: elements.filter(el => el.type === 'geometry'),
  };
}

function looksLikeRadar(model) {
  const filledPolygons = model.pens.filter(isFilledPolygon).length;
  const labels = inferRadarLabels(model, model.pens.filter(isFilledPolygon));
  return filledPolygons >= 1 && labels.length >= 3;
}

function looksLikeProgressRatio(model) {
  return progressBarGroups(model).length >= 2 && percentTexts(model).length >= 2;
}

function renderRadarECharts(model, helpers) {
  const filled = model.pens.filter(isFilledPolygon);
  const labels = inferRadarLabels(model, filled);
  if (!filled.length || labels.length < 3) return '';

  const clusters = clusterRadarLabels(labels, filled.length > 1 ? filled : labels);
  const radarConfigs = clusters.map((cluster, radarIndex) => buildRadarConfig(cluster, filled, radarIndex)).filter(Boolean);
  if (!radarConfigs.length) return '';

  const legends = inferLegendNames(model, Math.max(...radarConfigs.map(item => item.series.length)));
  const option = {
    tooltip: {},
    legend: { bottom: 0, data: legends },
    radar: radarConfigs.map((item, index) => ({
      center: radarConfigs.length > 1 ? [`${25 + index * 50}%`, '52%'] : ['58%', '52%'],
      radius: radarConfigs.length > 1 ? '58%' : '70%',
      indicator: item.indicators,
      splitNumber: 5,
    })),
    series: radarConfigs.flatMap((item, radarIndex) => item.series.map((series, seriesIndex) => ({
      name: legends[seriesIndex] || `系列${seriesIndex + 1}`,
      type: 'radar',
      radarIndex,
      areaStyle: { opacity: 0.24 },
      data: [{ value: series.values, name: legends[seriesIndex] || `系列${seriesIndex + 1}` }],
    }))),
  };

  return `option = ${JSON.stringify(option, null, 2)};`;
}

function buildRadarConfig(labels, filledPolygons, radarIndex) {
  const center = averagePoint(labels);
  const orderedLabels = labels
    .map(item => ({ ...item, angle: Math.atan2(item.y - center.y, item.x - center.x) }))
    .sort((a, b) => normalizeAngle(a.angle + Math.PI / 2) - normalizeAngle(b.angle + Math.PI / 2));
  const localPolygons = filledPolygons.filter(poly => polygonBelongsToLabels(poly, labels));
  if (!localPolygons.length) return null;

  const maxRadius = Math.max(
    ...localPolygons.flatMap(poly => poly.points.map(point => distance(center, point))),
    1
  ) / 0.8;
  const max = 5;
  const indicators = orderedLabels.map(label => ({ name: label.text, max }));
  const series = localPolygons.map(poly => ({
    values: orderedLabels.map(label => {
      const point = nearestPointOnAngle(poly.points, center, label.angle);
      return Math.max(0, Math.min(max, Math.round(distance(center, point) / maxRadius * max * 10) / 10));
    }),
  }));
  return { indicators, series, radarIndex };
}

function renderProgressRatioECharts(model) {
  const values = percentTexts(model).map(item => item.value);
  if (!values.length) return '';
  const names = inferProgressNames(model, values.length);

  const option = {
    tooltip: { formatter: '{b}: {c}%' },
    grid: { left: 90, right: 110, top: 24, bottom: 24 },
    xAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    yAxis: { type: 'category', inverse: true, data: names },
    series: [{
      type: 'bar',
      data: values,
      barWidth: 22,
      label: { show: true, position: 'right', formatter: '{c}%' },
      itemStyle: { borderRadius: 6 },
    }],
  };
  return `option = ${JSON.stringify(option, null, 2)};`;
}

function inferRadarLabels(model, filledPolygons) {
  if (!filledPolygons.length) return [];
  const textLabels = model.texts
    .map(el => ({ text: textOf(el), x: el.x || 0, y: el.y || 0 }))
    .filter(item => item.text && !isChartScaleLabel(item.text) && !isChartLegendLabel(item.text))
    .filter(item => !/%/.test(item.text));

  const result = [];
  filledPolygons.forEach(poly => {
    const center = averagePoint(poly.points);
    const maxRadius = Math.max(...poly.points.map(point => distance(center, point)), 1);
    textLabels
      .filter(item => {
        const d = distance(center, item);
        // Radar dimension labels sit around each polygon perimeter. Detecting
        // by distance keeps this independent from example words such as
        // "维度" or "类别" while still excluding titles and legends.
        return d >= maxRadius * 0.65 && d <= maxRadius * 2.35;
      })
      .forEach(item => {
        if (!result.some(existing => existing.text === item.text && Math.hypot(existing.x - item.x, existing.y - item.y) < 6)) {
          result.push(item);
        }
      });
  });
  return result;
}

function progressBarGroups(model) {
  return model.elements.filter(el => {
    const children = el.children || [];
    const rounded = children.filter(child => child.type === 'geometry' && child.shape === 'rounded-rect');
    const label = children.some(child => /(\d{1,3})%/.test(textOf(child)));
    return el.type === 'group' && rounded.length >= 2 && label;
  });
}

function percentTexts(model) {
  return model.texts
    .map(el => {
      const match = textOf(el).match(/(\d{1,3})%/);
      return match ? { el, value: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .filter(item => item.value >= 0 && item.value <= 100)
    .sort((a, b) => (a.el.y || 0) - (b.el.y || 0) || (a.el.x || 0) - (b.el.x || 0));
}

function inferProgressNames(model, count) {
  const rowLabels = model.geometries
    .filter(el => el.shape === 'rect' && textOf(el) && (el.width || 0) >= 60 && (el.height || 0) >= 40)
    .sort((a, b) => (a.y || 0) - (b.y || 0))
    .map(el => textOf(el))
    .slice(0, count);
  return Array.from({ length: count }, (_, index) => rowLabels[index] || `项目${index + 1}`);
}

function isChartScaleLabel(text) {
  return /^-?\d+(?:\.\d+)?$/.test(text) || /^-?\d+(?:\.\d+)?%$/.test(text);
}

function isChartLegendLabel(text) {
  return /^[A-Za-z]$/.test(text) || /^系列\s*\d+$/i.test(text);
}

function clusterRadarLabels(labels) {
  const sorted = labels.slice().sort((a, b) => a.x - b.x);
  const counts = new Map();
  sorted.forEach(label => counts.set(label.text, (counts.get(label.text) || 0) + 1));
  const duplicatedLabels = [...counts.values()].filter(count => count > 1).length;
  if (sorted.length < 10 || duplicatedLabels < 3) return [sorted];
  if (sorted.length % 2 === 0) {
    const half = sorted.length / 2;
    return [sorted.slice(0, half), sorted.slice(half)].filter(group => group.length >= 3);
  }
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push({ index: i, gap: sorted[i].x - sorted[i - 1].x });
  }
  const largest = gaps.sort((a, b) => b.gap - a.gap)[0];
  if (!largest || largest.gap < 120) return [sorted];
  return [sorted.slice(0, largest.index), sorted.slice(largest.index)].filter(group => group.length >= 3);
}

function inferLegendNames(model, count) {
  const names = model.texts.map(el => textOf(el)).filter(text => /^[A-Z]$|^系列/.test(text));
  return Array.from({ length: count }, (_, index) => names[index] || `系列${index + 1}`);
}

function polygonBelongsToLabels(poly, labels) {
  const bbox = pointsBBox(poly.points);
  const labelBox = pointsBBox(labels);
  return bbox.x <= labelBox.x + labelBox.width
    && bbox.x + bbox.width >= labelBox.x
    && bbox.y <= labelBox.y + labelBox.height
    && bbox.y + bbox.height >= labelBox.y;
}

function nearestPointOnAngle(points, center, angle) {
  let best = points[0];
  let bestDiff = Infinity;
  points.forEach(point => {
    const diff = Math.abs(angleDelta(Math.atan2(point[1] - center.y, point[0] - center.x), angle));
    if (diff < bestDiff) {
      best = point;
      bestDiff = diff;
    }
  });
  return best;
}

function isFilledPolygon(el) {
  if (!Array.isArray(el.points) || el.points.length < 3 || !el.fill?.color) return false;
  return !/^#f[0-9a-f]{5}$/i.test(el.fill.color);
}

function textOf(el) {
  return normalizeText(stripHtml(el?.html || el?.text || el?.name || ''));
}

function normalizeText(text = '') {
  return String(text).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function averagePoint(points) {
  const sum = points.reduce((acc, point) => {
    acc.x += point.x ?? point[0];
    acc.y += point.y ?? point[1];
    return acc;
  }, { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function distance(center, point) {
  const x = point.x ?? point[0];
  const y = point.y ?? point[1];
  return Math.hypot(x - center.x, y - center.y);
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

function angleDelta(a, b) {
  const diff = normalizeAngle(a - b);
  return diff > Math.PI ? Math.PI * 2 - diff : diff;
}

function pointsBBox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach(point => {
    const x = point.x ?? point[0];
    const y = point.y ?? point[1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function bboxCenter(bbox) {
  return { x: (bbox?.x || 0) + (bbox?.width || 0) / 2, y: (bbox?.y || 0) + (bbox?.height || 0) / 2 };
}
