'use strict';

const edges = ['left', 'right', 'top', 'bottom'];
const minimumEdgeOverlap = 64;

function placeDock(panel, target, workAreas, anchor) {
  const { edge, inside, offset } = anchor;
  const overhang = edge === 'left' && !inside && anchor.allowOverhang === true
    ? Math.min(72, Math.floor(panel.width * 0.20)) : 0;
  const vertical = edge === 'left' || edge === 'right';
  const firstEdge = edge === 'left' || edge === 'top';
  const normalAxis = vertical ? 'x' : 'y';
  const parallelAxis = vertical ? 'y' : 'x';
  const normalSize = vertical ? 'width' : 'height';
  const parallelSize = vertical ? 'height' : 'width';

  const contact = target[normalAxis] + (firstEdge ? 0 : target[normalSize]);
  const panelNormalStart = contact - (firstEdge === inside ? 0 : panel[normalSize]);
  const panelNormalEnd = panelNormalStart + panel[normalSize];
  const desiredParallelStart = target[parallelAxis] + offset;
  const overlap = Math.min(minimumEdgeOverlap, target[parallelSize], panel[parallelSize]);
  const targetMinimum = target[parallelAxis] + overlap - panel[parallelSize];
  const targetMaximum = target[parallelAxis] + target[parallelSize] - overlap;

  let closest = null;
  let closestShift = Infinity;
  for (const area of workAreas) {
    if (panelNormalStart < area[normalAxis] - overhang || panelNormalEnd > area[normalAxis] + area[normalSize]) continue;
    const minimum = Math.max(targetMinimum, area[parallelAxis]);
    const maximum = Math.min(targetMaximum, area[parallelAxis] + area[parallelSize] - panel[parallelSize]);
    if (minimum > maximum) continue;
    const parallelStart = Math.max(minimum, Math.min(desiredParallelStart, maximum));
    const shift = Math.abs(parallelStart - desiredParallelStart);
    if (shift < closestShift) {
      closest = {
        x: vertical ? panelNormalStart : parallelStart,
        y: vertical ? parallelStart : panelNormalStart,
        width: panel.width,
        height: panel.height,
      };
      closestShift = shift;
    }
  }
  return closest;
}

function findDockAnchor(panel, target, workAreas, maxDistance = 48) {
  let closest = null;
  let closestDistance = Infinity;

  function consider(edge, inside, areas, allowOverhang) {
    const parallelAxis = edge === 'left' || edge === 'right' ? 'y' : 'x';
    const offset = panel[parallelAxis] - target[parallelAxis];
    const anchor = { edge, inside, offset };
    if (allowOverhang) anchor.allowOverhang = true;
    const bounds = placeDock(panel, target, areas, anchor);
    if (!bounds) return;
    const distance = Math.hypot(bounds.x - panel.x, bounds.y - panel.y);
    if (distance <= maxDistance && distance < closestDistance) {
      closest = { ...anchor, offset: bounds[parallelAxis] - target[parallelAxis] };
      closestDistance = distance;
    }
  }

  for (const edge of edges) {
    for (const inside of [false, true]) {
      consider(edge, inside, workAreas, false);
    }
  }

  const right = panel.x + panel.width;
  const bottom = panel.y + panel.height;
  const leftClippedAreas = workAreas.filter(area => panel.x < area.x && right > area.x &&
    right <= area.x + area.width && panel.y < area.y + area.height && bottom > area.y);
  if (leftClippedAreas.length) consider('left', false, leftClippedAreas, true);
  return closest;
}

module.exports = { findDockAnchor, placeDock };
