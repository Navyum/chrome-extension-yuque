/**
 * Shared board measurement helpers.
 *
 * These functions are stable infrastructure used by both pixel SVG rendering
 * and semantic Mermaid reconstruction. Renderer-specific knowledge stays in
 * injected callbacks so this module does not need to import either renderer.
 */

export function createBoardMeasurer({
  resolveElementSize,
  resolveLinePoints,
  lineLabelPoint,
  isStandardRightMindmap,
  isTimelineListMindmap,
  isVerticalMindmap,
  standardRightMindmapLayout,
  measureTimelineListMindmap,
  measureVerticalMindmap,
  measureMindmap,
} = {}) {
  function elementBBox(el, index = {}) {
    if (!el) return null;
    if (el.type === 'line') return lineBBox(el, index);
    if (el.type === 'mindmap') return estimateMindmapBBox(el);
    if ((el.type === 'freehand' || el.type === 'pen') && Array.isArray(el.points)) {
      const points = el.points.map(point => Array.isArray(point) ? point : [point.x, point.y]);
      return pointsBBox(points, el.stroke?.width || el.width || 2);
    }

    const childBoxes = [];
    // Stack children are UML compartments rather than absolute child nodes.
    // Including them in the global bbox creates a fake box at 0,0.
    if (Array.isArray(el.children) && el.type !== 'stack') childBoxes.push(unionBBox(el.children, index));
    if (Array.isArray(el.contain) && el.contain[0] && typeof el.contain[0] === 'object') {
      childBoxes.push(unionBBox(el.contain, index));
    }

    const size = safeResolveElementSize(el);
    const ownBox = Number.isFinite(el.x) && Number.isFinite(el.y) && (size.width || size.height)
      ? rotatedBBox({ x: el.x, y: el.y, width: size.width, height: size.height }, el.rotate)
      : null;
    const merged = mergeBBoxes(ownBox, ...childBoxes);
    if (merged) return expandBBox(merged, Math.max(el.stroke?.width || 0, 2));
    return { x: el.x || 0, y: el.y || 0, width: size.width || 0, height: size.height || 0 };
  }

  function unionBBox(elements, index = {}) {
    const boxes = (elements || []).map(el => elementBBox(el, index)).filter(Boolean);
    return mergeBBoxes(...boxes) || { x: 0, y: 0, width: 1, height: 1 };
  }

  function lineBBox(line, index = {}) {
    const linePoints = typeof resolveLinePoints === 'function'
      ? resolveLinePoints(line, index)
      : {};
    const sp = linePoints?.sp;
    const tp = linePoints?.tp;
    const points = [
      sp,
      ...(line.controlPoints || []).map(cp => [cp.x ?? cp[0], cp.y ?? cp[1]]),
      tp,
    ].filter(Boolean);
    const base = pointsBBox(points, Math.max(line.stroke?.width || 1, 1) + 18);
    if (!base) return null;
    if (!line.html) return base;
    const [lx, ly] = typeof lineLabelPoint === 'function'
      ? lineLabelPoint(line, sp || points[0], tp || points[points.length - 1])
      : [(base.x + base.width / 2), (base.y + base.height / 2)];
    return mergeBBoxes(base, { x: lx - 60, y: ly - 24, width: 120, height: 48 });
  }

  function estimateMindmapBBox(root) {
    let layout;
    if (typeof isStandardRightMindmap === 'function' && isStandardRightMindmap(root)) {
      layout = standardRightMindmapLayout?.(root);
    } else if (typeof isTimelineListMindmap === 'function' && isTimelineListMindmap(root)) {
      layout = measureTimelineListMindmap?.(root);
    } else if (typeof isVerticalMindmap === 'function' && isVerticalMindmap(root)) {
      layout = measureVerticalMindmap?.(root);
    } else {
      layout = measureMindmap?.(root);
    }
    return expandBBox(layout?.bbox || { x: root.x || 0, y: root.y || 0, width: 1, height: 1 }, 12);
  }

  function safeResolveElementSize(el) {
    const size = typeof resolveElementSize === 'function' ? resolveElementSize(el) : null;
    return {
      width: Number.isFinite(size?.width) ? size.width : Number.isFinite(el?.width) ? el.width : 0,
      height: Number.isFinite(size?.height) ? size.height : Number.isFinite(el?.height) ? el.height : 0,
    };
  }

  return {
    elementBBox,
    unionBBox,
    lineBBox,
    estimateMindmapBBox,
    normalizeBBox,
    mergeBBoxes,
    expandBBox,
    rotatedBBox,
    pointsBBox,
    indexElements,
  };
}

export function normalizeBBox(bbox) {
  if (!bbox) return null;
  const { x, y, width, height } = bbox;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

export function mergeBBoxes(...boxes) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const bbox of valid) {
    minX = Math.min(minX, bbox.x);
    minY = Math.min(minY, bbox.y);
    maxX = Math.max(maxX, bbox.x + bbox.width);
    maxY = Math.max(maxY, bbox.y + bbox.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function expandBBox(bbox, amount) {
  if (!bbox) return null;
  return {
    x: bbox.x - amount,
    y: bbox.y - amount,
    width: bbox.width + amount * 2,
    height: bbox.height + amount * 2,
  };
}

export function rotatedBBox(bbox, rotate) {
  if (!rotate) return bbox;
  const rad = rotate * Math.PI / 180;
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const corners = [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x + bbox.width, bbox.y + bbox.height],
    [bbox.x, bbox.y + bbox.height],
  ].map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [
      cx + dx * Math.cos(rad) - dy * Math.sin(rad),
      cy + dx * Math.sin(rad) + dy * Math.cos(rad),
    ];
  });
  return pointsBBox(corners, 0);
}

export function pointsBBox(points, padding = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return null;
  return expandBBox({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, padding);
}

export function indexElements(elements, index = {}) {
  if (!Array.isArray(elements)) return index;
  for (const el of elements) {
    if (el.id) index[el.id] = el;
    if (el.children) indexElements(el.children, index);
    if (el.contain) indexElements(el.contain, index);
  }
  return index;
}
