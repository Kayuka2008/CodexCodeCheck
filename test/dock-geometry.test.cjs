'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { findDockAnchor, placeDock, fitDockSize } = require('../lib/dock-geometry.cjs');

const panelSize = { width: 360, height: 300 };
const target = { x: 100, y: 200, width: 800, height: 600 };
const workAreas = [{ x: -1280, y: -800, width: 3200, height: 2400 }];

test('drops near each inside and outside edge snap flush and preserve panel dimensions', () => {
  const cases = [
    { edge: 'left', inside: false, x: -260, y: 320, dx: -11, dy: 0, offset: 120 },
    { edge: 'left', inside: true, x: 100, y: 320, dx: 11, dy: 0, offset: 120 },
    { edge: 'right', inside: false, x: 900, y: 320, dx: 11, dy: 0, offset: 120 },
    { edge: 'right', inside: true, x: 540, y: 320, dx: -11, dy: 0, offset: 120 },
    { edge: 'top', inside: false, x: 310, y: -100, dx: 0, dy: -11, offset: 210 },
    { edge: 'top', inside: true, x: 310, y: 200, dx: 0, dy: 11, offset: 210 },
    { edge: 'bottom', inside: false, x: 310, y: 800, dx: 0, dy: 11, offset: 210 },
    { edge: 'bottom', inside: true, x: 310, y: 500, dx: 0, dy: -11, offset: 210 },
  ];

  for (const { edge, inside, x, y, dx, dy, offset } of cases) {
    const panel = { x: x + dx, y: y + dy, ...panelSize };
    const anchor = findDockAnchor(panel, target, workAreas);
    assert.deepEqual(anchor, { edge, inside, offset });
    assert.deepEqual(placeDock(panel, target, workAreas, anchor), { x, y, ...panelSize });
  }
});

test('a saved edge follows host moves and resizes, and rejects insufficient outside space', () => {
  const area = [{ x: 0, y: 0, width: 1550, height: 1000 }];
  const resized = { x: 80, y: 100, width: 1100, height: 620 };
  const anchor = { edge: 'right', inside: false, offset: 240 };
  assert.deepEqual(placeDock(panelSize, resized, area, anchor), { x: 1180, y: 340, ...panelSize });

  resized.width += 20;
  assert.equal(placeDock(panelSize, resized, area, anchor), null);
  assert.deepEqual(placeDock(panelSize, resized, area, { ...anchor, inside: true }), { x: 840, y: 340, ...panelSize });
});

test('snap distance includes movement along the edge to stay in the work area', () => {
  const area = [{ x: 0, y: 0, width: 1400, height: 900 }];
  const partlyOffscreen = { x: 100, y: -80, width: 600, height: 500 };
  const panel = { x: 707, y: -23, ...panelSize };
  assert.equal(findDockAnchor(panel, partlyOffscreen, area, 24), null);
  const anchor = findDockAnchor(panel, partlyOffscreen, area);
  assert.deepEqual(anchor, { edge: 'right', inside: false, offset: 80 });
  assert.deepEqual(placeDock(panel, partlyOffscreen, area, anchor), { x: 700, y: 0, ...panelSize });
  assert.equal(findDockAnchor({ x: 1200, y: 700, ...panelSize }, partlyOffscreen, area), null);
});

test('an outside anchor can fit a second display while retaining edge overlap', () => {
  const areas = [
    { x: -1280, y: 0, width: 1280, height: 800 },
    { x: 0, y: 0, width: 1440, height: 1000 },
  ];
  const host = { x: -800, y: 100, width: 800, height: 600 };
  const anchor = { edge: 'right', inside: false, offset: 980 };
  assert.deepEqual(placeDock(panelSize, host, areas, anchor), { x: 0, y: 636, ...panelSize });
});

test('an existing left overhang can snap flush within the visible-width limit', () => {
  const areas = [{ x: 0, y: 0, width: 1440, height: 852 }];
  const host = { x: 308, y: 68, width: 1090, height: 760 };
  const panel = { x: -52, y: 93, width: 363, height: 722 };
  const strict = { edge: 'left', inside: false, offset: 25 };
  const allowed = { ...strict, allowOverhang: true };

  assert.deepEqual(findDockAnchor(panel, host, areas), allowed);
  assert.deepEqual(placeDock(panel, host, areas, allowed), { ...panel, x: -55 });
  assert.equal(placeDock(panel, host, areas, strict), null);

  const hostTooFarLeft = { ...host, x: 280 };
  assert.equal(placeDock(panel, hostTooFarLeft, areas, allowed), null);
  assert.equal(findDockAnchor({ ...panel, x: -83 }, hostTooFarLeft, areas), null);
});

test('the overhang flag is only proposed for an already clipped panel on its outer side', () => {
  const areas = [{ x: 0, y: 0, width: 1440, height: 852 }];
  const host = { x: 350, y: 100, width: 700, height: 600 };
  const panel = { x: 0, y: 210, ...panelSize };
  assert.equal(findDockAnchor(panel, host, areas), null);

  const rightHost = { ...host, width: 750 };
  const panelAtRightBoundary = { ...panel, x: areas[0].width - panel.width };
  assert.equal(findDockAnchor(panelAtRightBoundary, rightHost, areas), null);
});

test('right outside overhang snaps within the same bounds as left outside', () => {
  const areas = [{ x: 0, y: 0, width: 1440, height: 852 }];
  const host = { x: 42, y: 68, width: 1090, height: 760 };
  const panel = { x: 1129, y: 93, width: 363, height: 722 };
  const strict = { edge: 'right', inside: false, offset: 25 };
  const allowed = { ...strict, allowOverhang: true };

  assert.deepEqual(findDockAnchor(panel, host, areas), allowed);
  assert.deepEqual(placeDock(panel, host, areas, allowed), { ...panel, x: 1132 });
  assert.equal(placeDock(panel, host, areas, strict), null);

  const hostTooFarRight = { ...host, x: 70 };
  assert.equal(placeDock(panel, hostTooFarRight, areas, allowed), null);
  assert.equal(findDockAnchor({ ...panel, x: 1160 }, hostTooFarRight, areas), null);
});

test('auto size fills the visible Codex edge and preserves the perpendicular size when possible', () => {
  const areas = [{ x: 0, y: 0, width: 1440, height: 852 }];
  const host = { x: 380, y: -20, width: 500, height: 920 };
  const panel = { x: 890, y: 15, width: 425, height: 475 };

  const right = { edge: 'right', inside: false, offset: 36 };
  assert.deepEqual(fitDockSize(panel, host, areas, right), { x: 880, y: 16, width: 425, height: 836 });

  const left = { edge: 'left', inside: false, offset: 0 };
  assert.deepEqual(fitDockSize(panel, host, areas, left), { x: 0, y: 0, width: 380, height: 852 });
  assert.equal(fitDockSize(panel, { ...host, x: 350 }, areas, left), null);

  const leftOverhang = { ...left, allowOverhang: true };
  assert.deepEqual(fitDockSize(panel, { ...host, x: 310 }, areas, leftOverhang), {
    x: -72, y: 0, width: 382, height: 852,
  });
  assert.equal(fitDockSize(panel, { ...host, x: 280 }, areas, leftOverhang), null);
});

test('auto size fills horizontal edges, clamping the saved offset to keep the panel usable', () => {
  const area = [{ x: -700, y: 0, width: 1300, height: 1250 }];
  const host = { x: -750, y: 420, width: 900, height: 420 };
  const panel = { x: 30, y: 839, width: 425, height: 480 };

  assert.deepEqual(fitDockSize(panel, host, area, { edge: 'bottom', inside: false, offset: 400 }), {
    x: -350, y: 840, width: 500, height: 410,
  });
  assert.deepEqual(fitDockSize(panel, host, area, { edge: 'top', inside: true, offset: 700 }), {
    x: -210, y: 420, width: 360, height: 420,
  });
});
