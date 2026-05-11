import { createBoardMeasurer } from './board-measure.js';

/**
 * Semantic Yuque board -> Mermaid reconstruction.
 *
 * This module is deliberately separate from SVG rendering: Mermaid output is a
 * best-effort structural interpretation and its heuristics evolve independently
 * from pixel-oriented whiteboard rendering.
 */

let renderHelpers = {};

export function renderBoardToMermaid(body, helpers = {}) {
  if (!Array.isArray(body) || !body.length) return '';
  renderHelpers = helpers;
  try {
    return renderBoardMermaid(createBoardModel(body));
  } finally {
    renderHelpers = {};
  }
}

function resolveElementSize(...args) {
  const helper = renderHelpers.resolveElementSize;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function lineLabelPoint(...args) {
  const helper = renderHelpers.lineLabelPoint;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function resolveLinePoints(...args) {
  const helper = renderHelpers.resolveLinePoints;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function isVerticalMindmap(...args) {
  const helper = renderHelpers.isVerticalMindmap;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function isStandardRightMindmap(...args) {
  const helper = renderHelpers.isStandardRightMindmap;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function isTimelineListMindmap(...args) {
  const helper = renderHelpers.isTimelineListMindmap;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function measureTimelineListMindmap(...args) {
  const helper = renderHelpers.measureTimelineListMindmap;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function measureMindmap(...args) {
  const helper = renderHelpers.measureMindmap;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function standardRightMindmapLayout(...args) {
  const helper = renderHelpers.standardRightMindmapLayout;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function measureVerticalMindmap(...args) {
  const helper = renderHelpers.measureVerticalMindmap;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

function stripHtml(...args) {
  const helper = renderHelpers.stripHtml;
  return typeof helper === 'function' ? helper(...args) : undefined;
}

const { elementBBox } = createBoardMeasurer({
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
});

// ── Mermaid export ──

function renderBoardMermaid(model) {
  const kind = detectMermaidKind(model);
  switch (kind) {
    case 'mindmap':
      return renderMermaidMindmap(model.mindmaps[0]);
    case 'multi-mindmap':
      return renderMermaidMultiMindmap(model);
    case 'sequence':
      return renderMermaidSequence(model);
    case 'class':
      return renderMermaidClass(model);
    case 'state':
      return renderMermaidState(model);
    case 'fishbone':
      return renderMermaidFishbone(model);
    case 'strategy':
      return renderMermaidStrategy(model);
    case 'timeline':
      return renderMermaidTimeline(model);
    case 'quadrant':
      return renderMermaidQuadrant(model);
    case 'swimlane':
      return renderMermaidSwimlane(model);
    case 'activity-swimlane':
      return renderMermaidActivitySwimlane(model);
    case 'flowchart':
      return renderMermaidFlowchart(model);
    default:
      return '';
  }
}

function createBoardModel(body) {
  const elements = [];
  const byId = new Map();
  const parentById = new Map();
  const childrenById = new Map();

  // Flatten only visual board elements. Mindmap tree nodes have no geometry
  // type, so keeping them inside their own renderer avoids polluting diagrams.
  function walk(list, parent = null, depth = 0) {
    if (!Array.isArray(list)) return;
    for (const el of list) {
      const item = { ...el, __parent: parent, __depth: depth };
      elements.push(item);
      if (item.id) {
        byId.set(item.id, item);
        if (parent?.id) parentById.set(item.id, parent.id);
      }
      if (parent?.id) {
        const children = childrenById.get(parent.id) || [];
        children.push(item);
        childrenById.set(parent.id, children);
      }
      if (el.type === 'mindmap') continue;
      if (Array.isArray(el.children)) walk(el.children, item, depth + 1);
      if (Array.isArray(el.contain) && el.contain[0] && typeof el.contain[0] === 'object') {
        walk(el.contain, item, depth + 1);
      }
    }
  }

  walk(body);

  const top = elements.filter(el => el.__depth === 0);
  const lines = elements.filter(el => el.type === 'line');
  const geometries = elements.filter(el => el.type === 'geometry');
  const stacks = elements.filter(el => el.type === 'stack');
  const groups = elements.filter(el => el.type === 'group');
  const texts = elements.filter(el => el.type === 'text');
  const mindmaps = top.filter(el => el.type === 'mindmap');
  const swimlanes = top.filter(el => el.type === 'swimlane');
  const connections = new Set();
  lines.forEach(line => {
    if (line.source?.id) connections.add(line.source.id);
    if (line.target?.id) connections.add(line.target.id);
  });

  return { body, top, elements, byId, parentById, childrenById, lines, geometries, stacks, groups, texts, mindmaps, swimlanes, connections };
}

function detectMermaidKind(model) {
  const shapes = new Set(model.geometries.map(el => el.shape).filter(Boolean));
  const topTypes = new Set(model.top.map(el => el.type));

  // Priority is intentionally layered:
  // 1. explicit Yuque element types (mindmap/swimlane/UML shapes),
  // 2. structural templates inferred from shapes, layout and line topology,
  // 3. generic flowchart fallback. Text is only allowed as a weak label source,
  //    never as the sole type discriminator.
  if (looksLikeRadar(model)) return 'none';
  if (model.mindmaps.length === 1 && topTypes.size === 1) return 'mindmap';
  if (model.mindmaps.length > 1 && model.top.every(el => el.type === 'mindmap' || el.type === 'group')) return 'multi-mindmap';
  if (looksLikeSequence(model)) return 'sequence';
  if (looksLikeState(model)) return 'state';
  if (looksLikeActivitySwimlane(model)) return 'activity-swimlane';
  if (looksLikeClass(model)) return 'class';
  if (looksLikeStrategy(model)) return 'strategy';
  if (looksLikeFishbone(model)) return 'fishbone';
  if (looksLikeTimeline(model)) return 'timeline';
  if (looksLikeQuadrant(model)) return 'quadrant';
  if (looksLikeJourney(model) || looksLikePackageOrComponent(model)) return 'none';
  if (model.swimlanes.length && model.lines.length) return 'swimlane';
  if (model.lines.some(line => endpointNodeId(line.source, model) && endpointNodeId(line.target, model))) return 'flowchart';
  if (shapes.has('use-case') || shapes.has('package')) return 'flowchart';
  if (looksLikeVisualTemplate(model)) return 'none';
  return 'none';
}

function looksLikeRadar(model) {
  const circles = model.geometries.filter(el => el.shape === 'circle' || el.shape === 'ellipse').length;
  const penLines = model.elements.filter(el => el.type === 'pen' || el.type === 'freehand').length;
  const standaloneTexts = model.texts.length;
  return penLines >= 5 && circles >= 2 && standaloneTexts >= 5;
}

function looksLikeVisualTemplate(model) {
  const hasImages = model.elements.some(el => el.type === 'image');
  const connectedLines = model.lines.filter(line => endpointNodeId(line.source, model) && endpointNodeId(line.target, model)).length;
  const groupTextCount = model.groups.reduce((sum, group) => sum + collectTextFromElement(group).length, 0);
  const manyUnconnectedBoxes = model.geometries.length >= 12 && connectedLines === 0;
  return (hasImages && model.lines.length === 0 && model.geometries.length > 10) || (manyUnconnectedBoxes && groupTextCount > 8);
}

function looksLikeSequence(model) {
  const shapes = new Set(model.geometries.map(el => el.shape));
  return shapes.has('actor') && shapes.has('object') && shapes.has('activation');
}

function looksLikeClass(model) {
  return model.stacks.length >= 2 && !model.geometries.some(el => el.shape === 'start' || el.shape === 'finish' || el.shape === 'state');
}

function looksLikeState(model) {
  const shapes = new Set(model.geometries.map(el => el.shape));
  return model.stacks.length >= 2 && (shapes.has('start') || shapes.has('finish') || shapes.has('state') || shapes.has('simple-class'));
}

function looksLikeActivitySwimlane(model) {
  const shapes = new Set(model.geometries.map(el => el.shape));
  return activityLaneLabels(model).length >= 2
    && shapes.has('state')
    && shapes.has('object')
    && (shapes.has('start') || shapes.has('finish'));
}

function looksLikeFishbone(model) {
  const arrowCount = model.geometries.filter(el => el.shape === 'arrow-2' || el.shape === 'process-arrow').length;
  return arrowCount >= 4 && model.lines.length >= 8;
}

function looksLikeStrategy(model) {
  return Boolean(buildStrategySpec(model));
}

function looksLikeTimeline(model) {
  const commentCount = model.geometries.filter(el => el.shape === 'comment-2').length;
  const markerCount = model.geometries.filter(el => ['circle', 'ellipse'].includes(el.shape) && isSmallTimelineMarker(el)).length;
  const hasHorizontalAxis = model.geometries.some(el => el.shape === 'rounded-rect' && (el.width || 0) > 300 && (el.height || 0) <= 24)
    || model.lines.some(line => lineAxisOrientation(line) === 'horizontal');
  return commentCount >= 3 && markerCount >= 3 && hasHorizontalAxis;
}

function isSmallTimelineMarker(el) {
  return (el.width || 0) <= 32 && (el.height || 0) <= 32;
}

function looksLikeJourney(model) {
  const rowHeaders = model.geometries.filter(el => el.shape === 'rect' && nodeText(el) && (el.width || 0) <= 100 && (el.height || 0) >= 24);
  const stageArrows = model.geometries.filter(el => ['pentagon-arrow', 'process-arrow'].includes(el.shape) && (el.width || 0) > 120);
  const curveLines = model.lines.filter(line => line.shape === 'curve').length;
  const markers = model.geometries.filter(el => ['circle', 'ellipse'].includes(el.shape)).length;
  return rowHeaders.length >= 4 && stageArrows.length >= 3 && curveLines >= 3 && markers >= 4;
}

function looksLikePackageOrComponent(model) {
  const packageCount = model.geometries.filter(el => el.shape === 'package').length;
  const connectorCount = model.geometries.filter(el => el.shape === 'connector').length;
  const emptyNodeCount = model.geometries.filter(el => !nodeText(el) || nodeText(el) === '节点').length;
  return packageCount >= 4 || (connectorCount >= 4 && emptyNodeCount >= 4);
}

function looksLikeQuadrant(model) {
  return Boolean(buildQuadrantSpec(model));
}

function renderMermaidMindmap(root) {
  const lines = ['mindmap'];

  function appendNode(node, depth, isRoot = false) {
    const text = sanitizeMermaidMindmapText(stripHtml(node.html || node.text || node.name || '节点')) || '节点';
    const prefix = '  '.repeat(depth);
    lines.push(isRoot ? `${prefix}root((${text}))` : `${prefix}${text}`);
    (node.children || []).forEach(child => appendNode(child, depth + 1));
  }

  appendNode(root, 1, true);
  return lines.join('\n');
}

function renderMermaidMultiMindmap(model) {
  const lines = ['flowchart TB'];
  const ids = new Map();
  let seq = 1;

  model.mindmaps.forEach((root, index) => {
    const rootId = `m${seq++}`;
    ids.set(root, rootId);
    const stage = nearestStageLabel(root, model, index);
    lines.push(`  subgraph s${index + 1}["${quoteMermaidEdgeLabel(stage || `阶段 ${index + 1}`)}"]`);
    appendMindmapFlowNode(lines, ids, root, rootId, true, () => `m${seq++}`);
    lines.push('  end');
  });

  return lines.length > 1 ? lines.join('\n') : '';
}

function appendMindmapFlowNode(lines, ids, node, id, isRoot, nextId) {
  const text = normalizeMermaidText(stripHtml(node.html || node.text || node.name || '')) || (isRoot ? '事项' : '节点');
  lines.push(`    ${id}${isRoot ? `(["${quoteMermaidEdgeLabel(text)}"])` : `[${quoteMermaidLabel(text)}]`}`);
  (node.children || []).forEach(child => {
    const childId = nextId();
    ids.set(child, childId);
    appendMindmapFlowNode(lines, ids, child, childId, false, nextId);
    lines.push(`    ${id} --> ${childId}`);
  });
}

function nearestStageLabel(root, model, index) {
  const groups = model.groups
    .map(group => ({ group, text: collectTextFromElement(group).join(' ') }))
    .filter(item => item.text);
  if (!groups.length) return '';
  const rx = root.x || 0;
  let best = null;
  groups.forEach(item => {
    const bbox = elementBBox(item.group);
    const distance = Math.abs((bbox.x + bbox.width / 2) - rx);
    if (!best || distance < best.distance) best = { ...item, distance };
  });
  return best?.text || `阶段 ${index + 1}`;
}

function renderMermaidFlowchart(model) {
  const nodeList = collectFlowNodes(model);
  const nodeIds = new Map();
  const lines = ['flowchart LR'];
  let edgeCount = 0;

  nodeList.forEach((el, index) => {
    const nodeId = `n${index + 1}`;
    nodeIds.set(el.id, nodeId);
    lines.push(`  ${nodeId}${mermaidNodeShape(el)}`);
  });

  model.lines
    .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
    .forEach(line => {
      const sourceId = endpointNodeId(line.source, model, nodeIds);
      const targetId = endpointNodeId(line.target, model, nodeIds);
      if (!sourceId || !targetId || !nodeIds.has(sourceId) || !nodeIds.has(targetId)) return;
      if (sourceId === targetId) return;

      const source = nodeIds.get(sourceId);
      const target = nodeIds.get(targetId);
      const label = inferMermaidLineLabel(line, model);
      const arrow = mermaidArrow(line, label);
      lines.push(`  ${source} ${arrow} ${target}`);
      edgeCount += 1;
    });

  return edgeCount > 0 ? lines.join('\n') : '';
}

function renderMermaidSwimlane(model) {
  const nodeList = collectFlowNodes(model);
  const nodeIds = new Map();
  const laneByNode = assignSwimlaneNodes(model, nodeList);
  const lines = ['flowchart LR'];

  const lanes = [...new Set([...laneByNode.values()])];
  lanes.forEach((lane, laneIndex) => {
    lines.push(`  subgraph lane${laneIndex + 1}["${quoteMermaidEdgeLabel(lane)}"]`);
    nodeList.filter(node => laneByNode.get(node.id) === lane).forEach((node) => {
      const nodeId = nodeIds.get(node.id) || `n${nodeIds.size + 1}`;
      nodeIds.set(node.id, nodeId);
      lines.push(`    ${nodeId}${mermaidNodeShape(node)}`);
    });
    lines.push('  end');
  });

  nodeList.filter(node => !laneByNode.has(node.id)).forEach(node => {
    const nodeId = `n${nodeIds.size + 1}`;
    nodeIds.set(node.id, nodeId);
    lines.push(`  ${nodeId}${mermaidNodeShape(node)}`);
  });

  model.lines.forEach(line => {
    const sourceId = endpointNodeId(line.source, model, nodeIds);
    const targetId = endpointNodeId(line.target, model, nodeIds);
    if (!sourceId || !targetId || !nodeIds.has(sourceId) || !nodeIds.has(targetId)) return;
    if (sourceId === targetId) return;
    lines.push(`  ${nodeIds.get(sourceId)} ${mermaidArrow(line, inferMermaidLineLabel(line, model))} ${nodeIds.get(targetId)}`);
  });

  return lines.length > 1 ? lines.join('\n') : '';
}

function renderMermaidActivitySwimlane(model) {
  const nodeList = model.geometries
    .filter(el => ['start', 'finish', 'state', 'object'].includes(el.shape))
    .filter(el => el.id)
    .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));
  const lanes = activityLaneLabels(model);
  const nodeIds = new Map(nodeList.map((node, index) => [node.id, `n${index + 1}`]));
  const laneByNode = new Map();
  const lines = ['flowchart LR'];

  nodeList.forEach(node => {
    const centerY = (node.y || 0) + (node.height || 0) / 2;
    let best = lanes[0];
    lanes.forEach(lane => {
      if (Math.abs(centerY - lane.centerY) < Math.abs(centerY - best.centerY)) best = lane;
    });
    if (best) laneByNode.set(node.id, best.text);
  });

  lanes.forEach((lane, laneIndex) => {
    lines.push(`  subgraph lane${laneIndex + 1}["${quoteMermaidEdgeLabel(lane.text)}"]`);
    nodeList.filter(node => laneByNode.get(node.id) === lane.text).forEach(node => {
      lines.push(`    ${nodeIds.get(node.id)}${activityNodeShape(node)}`);
    });
    lines.push('  end');
  });

  model.lines
    .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
    .forEach(line => {
      const sourceId = endpointNodeId(line.source, model, nodeIds);
      const targetId = endpointNodeId(line.target, model, nodeIds);
      if (!sourceId || !targetId || !nodeIds.has(sourceId) || !nodeIds.has(targetId) || sourceId === targetId) return;
      lines.push(`  ${nodeIds.get(sourceId)} ${mermaidArrow(line, inferMermaidLineLabel(line, model))} ${nodeIds.get(targetId)}`);
    });

  return lines.length > 1 ? lines.join('\n') : '';
}

function activityLaneLabels(model) {
  return model.geometries
    .filter(el => el.shape === 'rect' && nodeText(el) && !model.connections.has(el.id))
    .filter(el => (el.width || 0) <= 180 && (el.height || 0) <= 50)
    .map(el => ({ text: nodeText(el), centerY: (el.y || 0) + (el.height || 0) / 2 }))
    .sort((a, b) => a.centerY - b.centerY);
}

function activityNodeShape(el) {
  const text = mermaidNodeText(el).replace(/^:\s*/, '');
  if (el.shape === 'start') return '(( ))';
  if (el.shape === 'finish') return '((( )))';
  if (el.shape === 'object') return `[/${quoteMermaidLabel(text)}/]`;
  return `[${quoteMermaidLabel(text)}]`;
}

function assignSwimlaneNodes(model, nodeList) {
  const result = new Map();
  const swimlane = model.swimlanes[0];
  if (!swimlane) return result;

  const laneTitles = (swimlane.children || []).map(child => normalizeMermaidText(stripHtml(child.html || '')) || `泳道 ${child.nth + 1}`);
  const { x, width } = elementBBox(swimlane);
  const split = [0, ...(swimlane.widths || []), 1];
  nodeList.forEach(node => {
    const bbox = elementBBox(node);
    const centerRatio = width ? ((bbox.x + bbox.width / 2) - x) / width : 0;
    const laneIndex = Math.max(0, split.findIndex((value, index) => centerRatio >= value && centerRatio <= (split[index + 1] ?? 1)));
    result.set(node.id, laneTitles[laneIndex] || `泳道 ${laneIndex + 1}`);
  });
  return result;
}

function renderMermaidSequence(model) {
  const participants = model.geometries
    .filter(el => el.shape === 'actor' || el.shape === 'object' || el.shape === 'activation')
    .sort((a, b) => (a.x || 0) - (b.x || 0));
  const unique = [];
  participants.forEach(el => {
    const label = cleanSequenceParticipantLabel(nodeText(el));
    if (label && !unique.some(item => item.label === label)) unique.push({ el, label });
  });
  if (unique.length < 2) return '';

  const idByElement = new Map();
  unique.forEach((item, index) => {
    const id = `p${index + 1}`;
    idByElement.set(item.el.id, id);
  });

  const lines = ['sequenceDiagram'];
  unique.forEach((item, index) => {
    const keyword = item.el.shape === 'actor' ? 'actor' : 'participant';
    lines.push(`  ${keyword} p${index + 1} as ${quoteSequenceLabel(item.label)}`);
  });

  model.lines
    .filter(line => line.source?.id && line.target?.id)
    .sort((a, b) => midpointY(a, model) - midpointY(b, model))
    .forEach(line => {
      const source = nearestSequenceParticipant(line.source.id, model, idByElement);
      const target = nearestSequenceParticipant(line.target.id, model, idByElement);
      if (!source || !target || source === target) return;
      const label = inferMermaidLineLabel(line, model) || '消息';
      const arrow = line.stroke?.style === 'dash' ? '-->>' : '->>';
      lines.push(`  ${source}${arrow}${target}: ${quoteSequenceLabel(label)}`);
    });

  return lines.length > unique.length + 1 ? lines.join('\n') : '';
}

function renderMermaidClass(model) {
  const stacks = model.stacks.filter(stack => stack.id);
  if (!stacks.length) return '';
  const ids = new Map();
  const lines = ['classDiagram'];

  stacks.forEach((stack, index) => {
    const className = `C${index + 1}`;
    ids.set(stack.id, className);
    lines.push(`  class ${className}["${quoteSequenceLabel(stackLabel(stack) || `Class ${index + 1}`)}"] {`);
    stackRows(stack).slice(1).forEach(row => {
      if (row) lines.push(`    ${sanitizeClassMember(row)}`);
    });
    lines.push('  }');
  });

  model.lines.forEach(line => {
    const source = endpointNodeId(line.source, model, ids);
    const target = endpointNodeId(line.target, model, ids);
    if (!source || !target || !ids.has(source) || !ids.has(target)) return;
    if (source === target) return;
    const arrow = line.stroke?.style === 'dash' ? '..>' : '--|>';
    const label = inferMermaidLineLabel(line, model);
    lines.push(`  ${ids.get(source)} ${arrow} ${ids.get(target)}${label ? ` : ${quoteClassRelationLabel(label)}` : ''}`);
  });

  return lines.length > 1 ? lines.join('\n') : '';
}

function renderMermaidState(model) {
  const nodes = collectFlowNodes(model).filter(el => el.type === 'stack' || ['start', 'finish', 'state'].includes(el.shape));
  const ids = new Map();
  const lines = ['stateDiagram-v2'];
  nodes.forEach((node, index) => {
    const label = node.shape === 'start' ? '[*]' : node.shape === 'finish' ? '[*]' : `S${index + 1}`;
    ids.set(node.id, label);
    if (label !== '[*]') lines.push(`  state "${quoteSequenceLabel(nodeText(node) || stackLabel(node) || label)}" as ${label}`);
  });
  model.lines.forEach(line => {
    const source = endpointNodeId(line.source, model, ids);
    const target = endpointNodeId(line.target, model, ids);
    if (!source || !target || !ids.has(source) || !ids.has(target)) return;
    if (source === target) return;
    const label = inferMermaidLineLabel(line, model);
    lines.push(`  ${ids.get(source)} --> ${ids.get(target)}${label ? ` : ${quoteSequenceLabel(label)}` : ''}`);
  });
  return lines.length > 1 ? lines.join('\n') : '';
}

function renderMermaidFishbone(model) {
  const root = model.geometries.find(el => el.shape === 'arrow-2') || model.geometries[0];
  const factors = model.geometries
    .filter(el => el.shape === 'process-arrow')
    .sort((a, b) => naturalTextOrder(nodeText(a), nodeText(b)) || (a.y || 0) - (b.y || 0));
  if (!root || !factors.length) return '';

  const lines = ['mindmap', `  root((${sanitizeMermaidMindmapText(nodeText(root) || '为什么')}))`];
  factors.forEach(factor => {
    const factorText = sanitizeMermaidMindmapText(nodeText(factor) || '因素');
    lines.push(`    ${factorText}`);
    collectFishboneDetailTexts(factor, model).forEach(detail => {
      lines.push(`      ${sanitizeMermaidMindmapText(detail)}`);
    });
  });
  return lines.join('\n');
}

function renderMermaidStrategy(model) {
  const spec = buildStrategySpec(model);
  if (!spec) return '';

  const title = model.texts.map(el => nodeText(el)).find(Boolean) || '策略分解';
  const lines = ['mindmap', `  root((${sanitizeMermaidMindmapText(title)}))`];
  spec.groups.forEach((group, index) => {
    lines.push(`    ${sanitizeMermaidMindmapText(nodeText(group.parent) || `分支 ${index + 1}`)}`);
    group.children.forEach((child, childIndex) => {
      lines.push(`      ${sanitizeMermaidMindmapText(nodeText(child) || `行动 ${childIndex + 1}`)}`);
    });
  });
  return lines.join('\n');
}

function buildStrategySpec(model) {
  const roundedNodes = model.geometries
    .filter(el => el.shape === 'rounded-rect' && nodeText(el))
    .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));
  if (roundedNodes.length < 6) return null;

  const straightSourceByNode = new Map();
  model.lines
    .filter(line => line.shape === 'straight' && line.source?.id)
    .forEach(line => {
      const lines = straightSourceByNode.get(line.source.id) || [];
      lines.push(line);
      straightSourceByNode.set(line.source.id, lines);
    });

  const nodeIds = new Set(roundedNodes.map(el => el.id));
  const connectedNodes = roundedNodes.filter(el => straightSourceByNode.has(el.id));
  if (connectedNodes.length < roundedNodes.length * 0.6) return null;

  const parentNodes = connectedNodes.filter(el => isStrategyParentConnector(straightSourceByNode.get(el.id)?.[0]));
  const childNodes = connectedNodes.filter(el => nodeIds.has(el.id) && !parentNodes.includes(el));
  if (parentNodes.length < 2 || childNodes.length < parentNodes.length) return null;

  const groups = parentNodes
    .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))
    .map(parent => ({
      parent,
      children: childNodes
        .filter(child => belongsToStrategyParent(child, parent, parentNodes))
        .sort((a, b) => naturalTextOrder(nodeText(a), nodeText(b)) || (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0)),
    }))
    .filter(group => group.children.length);

  const assignedChildCount = groups.reduce((sum, group) => sum + group.children.length, 0);
  const decorativeArrowCount = model.geometries.filter(el => ['pentagon-arrow', 'process-arrow'].includes(el.shape)).length;
  if (groups.length < 2 || assignedChildCount < 4 || decorativeArrowCount < 1) return null;
  return { groups };
}

function isStrategyParentConnector(line) {
  const connection = line?.source?.connection;
  if (connection === 'S' || connection === 'N') return true;
  return Array.isArray(connection) && Math.abs((connection[0] ?? 0) - 0.5) <= 0.15;
}

function belongsToStrategyParent(child, parent, allParents) {
  const childCenter = bboxCenter(elementBBox(child));
  const parentCenter = bboxCenter(elementBBox(parent));
  const verticalDirection = childCenter.y >= parentCenter.y ? 1 : -1;
  const candidateParents = allParents
    .filter(item => {
      const center = bboxCenter(elementBBox(item));
      return ((childCenter.y >= center.y ? 1 : -1) === verticalDirection)
        && Math.abs(childCenter.x - center.x) <= 240
        && Math.abs(childCenter.y - center.y) <= 260;
    })
    .map(item => ({
      item,
      distance: Math.abs(childCenter.x - bboxCenter(elementBBox(item)).x) * 1.4
        + Math.abs(childCenter.y - bboxCenter(elementBBox(item)).y),
    }))
    .sort((a, b) => a.distance - b.distance);
  return candidateParents[0]?.item === parent;
}

function renderMermaidTimeline(model) {
  const rawEvents = model.groups
    .map(group => {
      const title = timelineGroupTitle(group);
      const texts = collectTextFromElement(group).filter(text => text !== title);
      const detail = texts[0] || '';
      const bbox = elementBBox(group);
      return { title, detail, bbox };
    })
    .filter(item => item.title || item.detail)
    .sort((a, b) => (a.bbox.x - b.bbox.x) || (a.bbox.y - b.bbox.y));
  const eventGroups = dedupeTimelineEvents(rawEvents);
  if (!eventGroups.length) return '';

  const yearLabels = model.texts
    .map(el => ({ text: nodeText(el), bbox: elementBBox(el) }))
    .filter(item => /\b20\d{2}\b/.test(item.text))
    .sort((a, b) => a.bbox.x - b.bbox.x);

  const lines = ['timeline', '  title 时间轴'];
  eventGroups.forEach((event, index) => {
    const year = nearestTimelineYear(event.bbox, yearLabels) || `阶段 ${index + 1}`;
    lines.push(`  ${quoteSequenceLabel(year)} : ${quoteSequenceLabel(event.title || `事件 ${index + 1}`)}`);
    if (event.detail) lines.push(`    : ${quoteSequenceLabel(event.detail)}`);
  });
  return lines.join('\n');
}

function timelineGroupTitle(group) {
  const children = [];
  (function walk(node) {
    children.push(node);
    (node.children || []).forEach(walk);
  })(group);
  const header = children
    .filter(el => el.shape === 'rounded-rect' && nodeText(el))
    .sort((a, b) => (elementBBox(a).y - elementBBox(b).y) || (elementBBox(a).height - elementBBox(b).height))[0];
  return nodeText(header) || collectTextFromElement(group)[0] || '';
}

function renderMermaidQuadrant(model) {
  const spec = buildQuadrantSpec(model);
  if (!spec) return '';

  const { quadrants, cards, area, axis } = spec;
  const orderedQuadrants = orderQuadrantsForMermaid(quadrants);
  const lines = [
    'quadrantChart',
    `  x-axis ${quoteQuadrantText(axis.xLow)} --> ${quoteQuadrantText(axis.xHigh)}`,
    `  y-axis ${quoteQuadrantText(axis.yLow)} --> ${quoteQuadrantText(axis.yHigh)}`,
  ];

  orderedQuadrants.forEach((quadrant, index) => {
    lines.push(`  quadrant-${index + 1} ${quoteQuadrantText(nodeText(quadrant))}`);
  });

  cards.forEach((card, index) => {
    const point = quadrantPoint(card, area);
    const label = quoteQuadrantText(nodeText(card) || `事项 ${index + 1}`);
    lines.push(`  ${label}: [${formatQuadrantValue(point.x)}, ${formatQuadrantValue(point.y)}]`);
  });

  return lines.join('\n');
}

function buildQuadrantSpec(model) {
  const lines = model.lines.filter(line => line.shape === 'straight');
  const hasHorizontalAxis = lines.some(line => lineAxisOrientation(line) === 'horizontal');
  const hasVerticalAxis = lines.some(line => lineAxisOrientation(line) === 'vertical');
  if (!hasHorizontalAxis || !hasVerticalAxis) return null;

  const rects = model.geometries
    .filter(el => el.shape === 'rect' && nodeText(el))
    .map(el => ({ el, bbox: elementBBox(el), area: rectArea(elementBBox(el)) }))
    .filter(item => item.area > 0);

  // Quadrant boards are built from four large background rectangles plus
  // smaller card-like rectangles. Detect the backgrounds by relative area
  // instead of fixed labels so other four-quadrant templates remain supported.
  const sortedByArea = rects.slice().sort((a, b) => b.area - a.area);
  const quadrants = sortedByArea
    .slice(0, 4)
    .filter(item => item.area >= (sortedByArea[0]?.area || 0) * 0.55)
    .map(item => item.el);
  if (quadrants.length !== 4 || !formsTwoByTwoGrid(quadrants)) return null;

  const quadrantIds = new Set(quadrants.map(el => el.id));
  const area = unionElementBBoxes(quadrants);
  const cards = rects
    .filter(item => !quadrantIds.has(item.el.id))
    .filter(item => pointInsideBBox(bboxCenter(item.bbox), area))
    .map(item => item.el)
    .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));

  return { quadrants, cards, area, axis: inferQuadrantAxisLabels(model, area) };
}

function orderQuadrantsForMermaid(quadrants) {
  const sorted = quadrants
    .map(el => ({ el, center: bboxCenter(elementBBox(el)) }))
    .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x);
  const top = sorted.slice(0, 2).sort((a, b) => a.center.x - b.center.x);
  const bottom = sorted.slice(2).sort((a, b) => a.center.x - b.center.x);
  // Mermaid quadrant numbering is fixed: 1=top-right, 2=top-left,
  // 3=bottom-left, 4=bottom-right. Keep this mapping independent from Yuque's
  // element z-order so labels land in the intended visual quadrant.
  return [top[1]?.el, top[0]?.el, bottom[0]?.el, bottom[1]?.el].filter(Boolean);
}

function inferQuadrantAxisLabels(model, area) {
  const labels = model.texts
    .map(el => ({ text: nodeText(el), center: bboxCenter(elementBBox(el)) }))
    .filter(item => item.text);
  const midX = area.x + area.width / 2;
  const midY = area.y + area.height / 2;
  // Axis labels in Yuque templates often sit almost flush with the quadrant
  // background. Keep the outside threshold small and use proximity to the
  // visual center line for disambiguation.
  const outside = Math.max(2, Math.min(area.width, area.height) * 0.01);
  const nearMidY = item => Math.abs(item.center.y - midY) <= area.height * 0.42;
  const nearMidX = item => Math.abs(item.center.x - midX) <= area.width * 0.42;

  return {
    xLow: nearestAxisLabel(labels.filter(item => item.center.x < area.x - outside && nearMidY(item)), { x: area.x, y: midY }) || 'Low X',
    xHigh: nearestAxisLabel(labels.filter(item => item.center.x > area.x + area.width + outside && nearMidY(item)), { x: area.x + area.width, y: midY }) || 'High X',
    yLow: nearestAxisLabel(labels.filter(item => item.center.y > area.y + area.height + outside && nearMidX(item)), { x: midX, y: area.y + area.height }) || 'Low Y',
    yHigh: nearestAxisLabel(labels.filter(item => item.center.y < area.y - outside && nearMidX(item)), { x: midX, y: area.y }) || 'High Y',
  };
}

function nearestAxisLabel(labels, point) {
  const best = labels
    .map(item => ({ ...item, distance: Math.hypot(item.center.x - point.x, item.center.y - point.y) }))
    .sort((a, b) => a.distance - b.distance)[0];
  return best?.text || '';
}

function formsTwoByTwoGrid(quadrants) {
  const centers = quadrants.map(el => bboxCenter(elementBBox(el)));
  const xs = clusterNumbers(centers.map(point => point.x), 0.2);
  const ys = clusterNumbers(centers.map(point => point.y), 0.2);
  return xs.length === 2 && ys.length === 2;
}

function lineAxisOrientation(line) {
  const points = resolveLinePoints(line, {}) || {};
  const sp = points.sp || line.source?.connection;
  const tp = points.tp || line.target?.connection;
  if (!Array.isArray(sp) || !Array.isArray(tp)) return '';
  const dx = Math.abs(tp[0] - sp[0]);
  const dy = Math.abs(tp[1] - sp[1]);
  if (dx > dy * 3) return 'horizontal';
  if (dy > dx * 3) return 'vertical';
  return '';
}

function quadrantPoint(el, area) {
  const center = bboxCenter(elementBBox(el));
  return {
    x: clamp01((center.x - area.x) / area.width),
    y: clamp01(1 - ((center.y - area.y) / area.height)),
  };
}

function quoteQuadrantText(text = '') {
  // Mermaid's quadrant lexer accepts quoted Unicode labels reliably, while
  // unquoted Chinese labels fail in current Mermaid 10 rendering.
  const clean = normalizeMermaidText(text).replace(/[:[\]]/g, ' ').trim() || ' ';
  return quoteMermaidLabel(clean);
}

function formatQuadrantValue(value) {
  return String(Math.round(value * 100) / 100);
}

function rectArea(bbox) {
  return Math.max(0, bbox?.width || 0) * Math.max(0, bbox?.height || 0);
}

function bboxCenter(bbox) {
  return { x: (bbox?.x || 0) + (bbox?.width || 0) / 2, y: (bbox?.y || 0) + (bbox?.height || 0) / 2 };
}

function pointInsideBBox(point, bbox) {
  return point.x >= bbox.x && point.x <= bbox.x + bbox.width && point.y >= bbox.y && point.y <= bbox.y + bbox.height;
}

function unionElementBBoxes(elements) {
  const boxes = elements.map(el => elementBBox(el)).filter(Boolean);
  return boxes.reduce((acc, bbox) => acc ? {
    x: Math.min(acc.x, bbox.x),
    y: Math.min(acc.y, bbox.y),
    width: Math.max(acc.x + acc.width, bbox.x + bbox.width) - Math.min(acc.x, bbox.x),
    height: Math.max(acc.y + acc.height, bbox.y + bbox.height) - Math.min(acc.y, bbox.y),
  } : { ...bbox }, null) || { x: 0, y: 0, width: 1, height: 1 };
}

function clusterNumbers(values, toleranceRatio) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return [];
  const span = Math.max(sorted[sorted.length - 1] - sorted[0], 1);
  const tolerance = span * toleranceRatio;
  const clusters = [];
  sorted.forEach(value => {
    const current = clusters[clusters.length - 1];
    if (!current || Math.abs(value - current[current.length - 1]) > tolerance) {
      clusters.push([value]);
    } else {
      current.push(value);
    }
  });
  return clusters;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function collectFlowNodes(model) {
  const connected = model.connections;
  const connectedGroups = model.groups.filter(group => {
    const children = model.childrenById.get(group.id) || [];
    return children.some(child => connected.has(child.id)) && collectTextFromElement(group).length;
  });
  const candidates = [...model.geometries, ...model.stacks, ...connectedGroups]
    .filter(el => el.id)
    .filter(el => {
      const text = nodeText(el) || stackLabel(el);
      if (text) return true;
      return connected.has(el.id) && !isDecorativeShape(el);
    });

  // Keep semantic children that are line endpoints, but do not expose empty
  // background rectangles and decorative arrows as Mermaid nodes.
  return candidates
    .filter(el => !isBackgroundContainer(el, model) && !isDecorativeShape(el))
    .sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));
}

function isDecorativeShape(el) {
  return ['arrow-1', 'arrow-2', 'process-arrow', 'pentagon-arrow'].includes(el.shape);
}

function isBackgroundContainer(el, model) {
  if (nodeText(el) || stackLabel(el)) return false;
  const bbox = elementBBox(el);
  const children = model.elements.filter(item => item !== el && item.x >= bbox.x && item.y >= bbox.y && item.x <= bbox.x + bbox.width && item.y <= bbox.y + bbox.height);
  return children.length >= 3 && ['rect', 'rounded-rect', 'simple-class'].includes(el.shape);
}

function endpointNodeId(endpoint, model, nodeIds = null) {
  if (!endpoint?.id) {
    return Array.isArray(endpoint?.connection) && nodeIds
      ? nearestNodeId(endpoint.connection, model, nodeIds)
      : '';
  }
  let id = endpoint.id;
  while (id) {
    if (!nodeIds || nodeIds.has(id)) {
      const el = model.byId.get(id);
      if (el && (el.type === 'geometry' || el.type === 'stack' || el.type === 'group')) return id;
    }
    id = model.parentById.get(id);
  }
  return '';
}

function nearestNodeId(point, model, nodeIds) {
  let best = null;
  for (const id of nodeIds.keys()) {
    const el = model.byId.get(id);
    if (!el) continue;
    const bbox = elementBBox(el);
    const distance = Math.hypot((bbox.x + bbox.width / 2) - point[0], (bbox.y + bbox.height / 2) - point[1]);
    if (!best || distance < best.distance) best = { id, distance };
  }
  return best && best.distance < 160 ? best.id : '';
}

function inferMermaidLineLabel(line, model) {
  const ownLabel = normalizeMermaidText(stripHtml(line.html || ''));
  if (ownLabel) return ownLabel;
  const textLabels = model.texts.filter(el => el.html);
  if (!textLabels.length) return '';

  const source = model.byId.get(line.source?.id);
  const target = model.byId.get(line.target?.id);
  if (!source || !target) return '';

  const sp = mermaidEndpointPoint(line.source, source);
  const tp = mermaidEndpointPoint(line.target, target);
  if (!sp || !tp) return '';

  const midX = (sp.x + tp.x) / 2;
  const midY = (sp.y + tp.y) / 2;
  let best = null;

  textLabels.forEach(label => {
    const text = normalizeMermaidText(stripHtml(label.html || ''));
    if (!text) return;
    const x = label.x || 0;
    const y = label.y || 0;
    const distance = Math.hypot(x - midX, y - midY);
    if (!best || distance < best.distance) best = { text, distance };
  });

  return best && best.distance < 90 ? best.text : '';
}

function mermaidEndpointPoint(endpoint, el) {
  if (!endpoint || !el) return null;
  const x = el.x || 0;
  const y = el.y || 0;
  const w = el.width || 0;
  const h = el.height || 0;
  switch (endpoint.connection) {
    case 'N': return { x: x + w / 2, y };
    case 'S': return { x: x + w / 2, y: y + h };
    case 'E': return { x: x + w, y: y + h / 2 };
    case 'W': return { x, y: y + h / 2 };
    default: return { x: x + w / 2, y: y + h / 2 };
  }
}

function mermaidNodeShape(el) {
  const text = mermaidNodeText(el);
  switch (el.shape) {
    case 'start-end':
      return `([${quoteMermaidLabel(text)}])`;
    case 'decision':
      return `{${quoteMermaidLabel(text)}}`;
    case 'use-case':
      return `((${quoteMermaidLabel(text)}))`;
    case 'actor':
      return `[${quoteMermaidLabel(text)}]`;
    case 'package':
      return `[${quoteMermaidLabel(text)}]`;
    case 'document':
    case 'multi-document':
      return `[/${quoteMermaidLabel(text)}/]`;
    case 'note':
      return `["${quoteMermaidEdgeLabel(text)}"]`;
    case 'text':
      return `[${quoteMermaidLabel(text)}]`;
    default:
      return `[${quoteMermaidLabel(text)}]`;
  }
}

function mermaidNodeText(el) {
  const text = nodeText(el) || stackLabel(el);
  if (text) return text;
  switch (el?.shape) {
    case 'start':
    case 'start-end':
      return '开始';
    case 'finish':
      return '结束';
    case 'decision':
      return '判断';
    case 'connector':
      return '连接点';
    default:
      return '节点';
  }
}

function mermaidArrow(line, label) {
  const isDashed = line.stroke?.style === 'dash';
  const cleanLabel = label && label !== '\u200b' ? quoteMermaidEdgeLabel(label) : '';
  if (isDashed && cleanLabel) return `-. "${cleanLabel}" .->`;
  if (isDashed) return '-.->';
  if (cleanLabel) return `-- "${cleanLabel}" -->`;
  return '-->';
}

function normalizeMermaidText(text = '') {
  return String(text)
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteMermaidLabel(text = '') {
  return `"${String(text).replace(/"/g, '\\"')}"`;
}

function quoteMermaidEdgeLabel(text = '') {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function sanitizeMermaidMindmapText(text = '') {
  return normalizeMermaidText(text)
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nodeText(el) {
  if (!el) return '';
  if (el.type === 'group') return collectTextFromElement(el).slice(0, 4).join(' ');
  return rawNodeText(el);
}

function collectTextFromElement(el) {
  const result = [];
  function walk(node) {
    const text = rawNodeText(node);
    if (text) result.push(text);
    (node.children || []).forEach(walk);
  }
  walk(el);
  return result;
}

function rawNodeText(el) {
  return normalizeMermaidText(stripHtml(el?.html || el?.text || el?.name || ''));
}

function stackRows(stack) {
  return (stack.children || [])
    .slice()
    .sort((a, b) => (a.nth || 0) - (b.nth || 0))
    .map(child => normalizeMermaidText(stripHtml(child.html || '')))
    .filter(Boolean);
}

function stackLabel(stack) {
  return stackRows(stack)[0] || '';
}

function safeMermaidIdentifier(text, fallback) {
  const ascii = String(text || '')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^(\p{N})/u, '_$1')
    .replace(/^_+|_+$/g, '');
  return ascii || fallback;
}

function sanitizeClassMember(text) {
  return quoteSequenceLabel(text).replace(/[{}]/g, '');
}

function quoteSequenceLabel(text = '') {
  return String(text).replace(/\r?\n/g, ' ').replace(/"/g, '\\"').trim();
}

function quoteClassRelationLabel(text = '') {
  // Mermaid classDiagram treats <<...>> as stereotype syntax in relation
  // labels. Unicode guillemets preserve the visible label as plain text.
  return quoteSequenceLabel(text).replace(/<</g, '﹤﹤').replace(/>>/g, '﹥﹥');
}

function cleanSequenceParticipantLabel(text = '') {
  return normalizeMermaidText(text).replace(/^:\s*/, '');
}

function nearestSequenceParticipant(id, model, idByElement) {
  let current = id;
  while (current) {
    if (idByElement.has(current)) return idByElement.get(current);
    current = model.parentById.get(current);
  }

  const el = model.byId.get(id);
  if (!el) return '';
  const eb = elementBBox(el);
  let best = null;
  for (const [participantId, mermaidId] of idByElement) {
    const candidate = model.byId.get(participantId);
    const cb = elementBBox(candidate);
    const distance = Math.abs((cb.x + cb.width / 2) - (eb.x + eb.width / 2));
    if (!best || distance < best.distance) best = { mermaidId, distance };
  }
  return best?.mermaidId || '';
}

function midpointY(line, model) {
  const source = model.byId.get(line.source?.id);
  const target = model.byId.get(line.target?.id);
  const sy = source ? elementBBox(source).y : 0;
  const ty = target ? elementBBox(target).y : sy;
  return (sy + ty) / 2;
}

function collectNearbyDetailTexts(factor, model) {
  const fb = elementBBox(factor);
  const center = { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 };
  return model.groups
    .map(group => {
      const gb = elementBBox(group);
      const text = collectTextFromElement(group).join(' ');
      return { text, distance: Math.hypot((gb.x + gb.width / 2) - center.x, (gb.y + gb.height / 2) - center.y) };
    })
    .filter(item => item.text && item.distance < 220)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .map(item => item.text);
}

function collectFishboneDetailTexts(factor, model) {
  const factorNo = (nodeText(factor).match(/(\d+)/) || [])[1];
  const numbered = model.texts
    .map(el => nodeText(el))
    .filter(text => factorNo && new RegExp(`细节原因\\s*${factorNo}\\.`).test(text))
    .sort(naturalTextOrder);
  return numbered.length ? numbered : collectNearbyDetailTexts(factor, model);
}

function naturalTextOrder(a = '', b = '') {
  const ax = String(a).match(/\d+/g)?.map(Number) || [];
  const bx = String(b).match(/\d+/g)?.map(Number) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i += 1) {
    const diff = (ax[i] || 0) - (bx[i] || 0);
    if (diff) return diff;
  }
  return String(a).localeCompare(String(b), 'zh-Hans-CN');
}

function nearestTimelineYear(eventBBox, yearLabels) {
  if (!yearLabels.length) return '';
  const centerX = eventBBox.x + eventBBox.width / 2;
  let best = null;
  yearLabels.forEach(label => {
    const distance = Math.abs((label.bbox.x + label.bbox.width / 2) - centerX);
    if (!best || distance < best.distance) best = { text: label.text, distance };
  });
  return best?.text || '';
}

function dedupeTimelineEvents(events) {
  const byTitle = new Map();
  events.forEach(event => {
    const key = event.title || event.detail;
    const existing = byTitle.get(key);
    if (!existing || (!existing.detail && event.detail)) byTitle.set(key, event);
  });
  return [...byTitle.values()].sort((a, b) => (a.bbox.x - b.bbox.x) || (a.bbox.y - b.bbox.y));
}

function disambiguateDuplicateLabel(label, existingLines) {
  const used = existingLines
    .map(line => (line.match(/^  ([^:]+):/) || [])[1])
    .filter(Boolean);
  if (!used.includes(label)) return label;
  let index = 2;
  while (used.includes(`${label} ${index}`)) index += 1;
  return `${label} ${index}`;
}
