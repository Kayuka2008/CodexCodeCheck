'use strict';

const edges = ['left', 'right', 'top', 'bottom'];
const minimumEdgeOverlap = 64;
const maxOverhang = 72;
const minimumPanelSize = { width: 360, height: 300 };

function dockAxes({ edge, inside }) {
  const vertical = edge === 'left' || edge === 'right';
  const firstEdge = edge === 'left' || edge === 'top';
  return {
    vertical,
    firstEdge,
    growsPositive: firstEdge === inside,
    normalAxis: vertical ? 'x' : 'y',
    parallelAxis: vertical ? 'y' : 'x',
    normalSize: vertical ? 'width' : 'height',
    parallelSize: vertical ? 'height' : 'width',
  };
}

function canOverhang(anchor, vertical) {
  return vertical && !anchor.inside && anchor.allowOverhang === true;
}

function placeDock(panel, target, workAreas, anchor) {
  const { vertical, firstEdge, growsPositive, normalAxis, parallelAxis, normalSize, parallelSize } = dockAxes(anchor);
  const overhang = canOverhang(anchor, vertical) ? Math.min(maxOverhang, Math.floor(panel.width / 5)) : 0;
  const contact = target[normalAxis] + (firstEdge ? 0 : target[normalSize]);
  const panelNormalStart = contact - (growsPositive ? 0 : panel[normalSize]);
  const panelNormalEnd = panelNormalStart + panel[normalSize];
  const desiredParallelStart = target[parallelAxis] + anchor.offset;
  const overlap = Math.min(minimumEdgeOverlap, target[parallelSize], panel[parallelSize]);
  const targetMinimum = target[parallelAxis] + overlap - panel[parallelSize];
  const targetMaximum = target[parallelAxis] + target[parallelSize] - overlap;

  let closest = null;
  let closestShift = Infinity;
  for (const area of workAreas) {
    const lowerLimit = area[normalAxis] - (growsPositive ? 0 : overhang);
    const upperLimit = area[normalAxis] + area[normalSize] + (growsPositive ? overhang : 0);
    if (panelNormalStart < lowerLimit || panelNormalEnd > upperLimit) continue;
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

function fitDockSize(panel, target, workAreas, anchor) {
  const { vertical, firstEdge, growsPositive, normalAxis, parallelAxis, normalSize, parallelSize } = dockAxes(anchor);
  const contact = target[normalAxis] + (firstEdge ? 0 : target[normalSize]);
  const preferredStart = target[parallelAxis] + anchor.offset;
  let best = null;
  let bestShift = Infinity;

  for (const area of workAreas) {
    const areaNormalEnd = area[normalAxis] + area[normalSize];
    if (contact < area[normalAxis] || contact > areaNormalEnd) continue;

    let available = growsPositive ? areaNormalEnd - contact : contact - area[normalAxis];
    if (anchor.inside) available = Math.min(available, target[normalSize]);
    if (canOverhang(anchor, vertical)) {
      // Leave at least four fifths of the fitted panel width on screen.
      available = Math.min(available + maxOverhang, Math.floor(available * 5 / 4));
    }
    const fittedNormal = Math.min(panel[normalSize], available);
    if (fittedNormal < minimumPanelSize[normalSize]) continue;

    const visibleStart = Math.max(target[parallelAxis], area[parallelAxis]);
    const visibleEnd = Math.min(target[parallelAxis] + target[parallelSize], area[parallelAxis] + area[parallelSize]);
    const latestStart = visibleEnd - minimumPanelSize[parallelSize];
    if (visibleStart > latestStart) continue;

    const parallelStart = Math.max(visibleStart, Math.min(preferredStart, latestStart));
    const normalStart = contact - (growsPositive ? 0 : fittedNormal);
    const fittedParallel = visibleEnd - parallelStart;
    const shift = Math.abs(parallelStart - preferredStart);
    if (shift < bestShift) {
      best = {
        x: vertical ? normalStart : parallelStart,
        y: vertical ? parallelStart : normalStart,
        width: vertical ? fittedNormal : fittedParallel,
        height: vertical ? fittedParallel : fittedNormal,
      };
      bestShift = shift;
    }
  }
  return best;
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
  const overlappingAreas = workAreas.filter(area => panel.y < area.y + area.height && bottom > area.y);
  const leftClippedAreas = overlappingAreas.filter(area => panel.x < area.x && right > area.x && right <= area.x + area.width);
  const rightClippedAreas = overlappingAreas.filter(area => {
    const areaRight = area.x + area.width;
    return panel.x >= area.x && panel.x < areaRight && right > areaRight;
  });
  if (leftClippedAreas.length) consider('left', false, leftClippedAreas, true);
  if (rightClippedAreas.length) consider('right', false, rightClippedAreas, true);
  return closest;
}

module.exports = { findDockAnchor, placeDock, fitDockSize };
