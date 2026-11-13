'use strict';

const { placeDock, fitDockSize } = require('./dock-geometry.cjs');
const edges = ['right', 'left', 'top', 'bottom'];
const tabSize = 48;
const clamp = (value, low, high) => Math.max(low, Math.min(value, Math.max(low, high)));

// A fallback is temporary: never replace the user's preferred edge with it.
function placePanel(panel, target, areas, preferred, autoSize) {
  const requested = preferred ?? { edge: 'right', inside: false, offset: 0 };
  const anchors = [requested, { ...requested, inside: !requested.inside },
    ...edges.filter(edge => edge !== requested.edge).flatMap(edge => [
      { edge, inside: false, offset: 0 }, { edge, inside: true, offset: 0 },
    ])];
  for (const anchor of anchors) {
    const effective = autoSize ? { ...anchor, offset: 0 } : anchor;
    const bounds = autoSize ? fitDockSize(panel, target, areas, effective) : placeDock(panel, target, areas, effective);
    if (bounds) return { bounds, anchor: effective };
  }
  return null;
}

function clampWindow(bounds, area) {
  return { ...bounds, x: clamp(bounds.x, area.x, area.x + area.width - bounds.width),
    y: clamp(bounds.y, area.y, area.y + area.height - bounds.height) };
}

function placeTab(target, areas, anchor = { edge: 'right', offset: 72 }) {
  const vertical = anchor.edge === 'left' || anchor.edge === 'right';
  const axis = vertical ? 'y' : 'x';
  const length = vertical ? 'height' : 'width';
  const offset = clamp(anchor.offset, 12, target[length] - tabSize - 12);
  for (const inside of [false, true]) {
    const bounds = placeDock({ width: tabSize, height: tabSize }, target, areas, { edge: anchor.edge, inside, offset });
    if (bounds) return { bounds, edge: anchor.edge, inside };
  }
  // Host can temporarily straddle displays with mismatched work areas.
  const area = areas[0];
  const bounds = { x: target.x, y: target.y, width: tabSize, height: tabSize };
  bounds[axis] += offset;
  if (anchor.edge === 'right') bounds.x += target.width - tabSize;
  if (anchor.edge === 'bottom') bounds.y += target.height - tabSize;
  return { bounds: clampWindow(bounds, area), edge: anchor.edge, inside: true };
}

function findTabAnchor(bounds, target, areas, distance = 24) {
  let best = null;
  let nearest = distance;
  for (const edge of edges) {
    const axis = edge === 'left' || edge === 'right' ? 'y' : 'x';
    const anchor = { edge, offset: bounds[axis] - target[axis] };
    for (const inside of [false, true]) {
      const placed = placeDock({ width: tabSize, height: tabSize }, target, areas, { ...anchor, inside });
      if (!placed) continue;
      const delta = Math.hypot(placed.x - bounds.x, placed.y - bounds.y);
      if (delta <= nearest) { best = anchor; nearest = delta; }
    }
  }
  return best;
}

module.exports = { placePanel, placeTab, findTabAnchor, clampWindow, tabSize };
