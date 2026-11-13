'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { placePanel, placeTab, findTabAnchor } = require('../lib/companion-layout.cjs');
const area = [{ x: 0, y: 0, width: 1920, height: 1040 }];
const host = { x: 100, y: 100, width: 900, height: 700 };
const panel = { width: 400, height: 500 };

test('auto size aligns both ends, regardless of a legacy saved offset', () => {
  const placed = placePanel(panel, host, area, { edge: 'right', inside: false, offset: 85 }, true);
  assert.deepEqual(placed.bounds, { x: 1000, y: 100, width: 400, height: 700 });
});

test('outside preference survives maximized inside fallback and returns on restore', () => {
  const anchor = { edge: 'right', inside: false, offset: 0 };
  const maximized = { ...area[0] };
  assert.equal(placePanel(panel, maximized, area, anchor, true).anchor.inside, true);
  assert.equal(anchor.inside, false);
  assert.equal(placePanel(panel, host, area, anchor, true).anchor.inside, false);
});

test('same-edge inside fallback wins over jumping to a different outside edge', () => {
  const shifted = { ...host, x: 1000 };
  const placed = placePanel(panel, shifted, area, { edge: 'right', inside: false, offset: 20 }, true);
  assert.equal(placed.anchor.edge, 'right');
  assert.equal(placed.anchor.inside, true);
});

test('capsule follows host moves and width changes, keeps offset and stays visible', () => {
  const anchor = { edge: 'right', offset: 160 };
  assert.deepEqual(placeTab(host, area, anchor), {
    bounds: { x: 1000, y: 260, width: 48, height: 48 }, edge: 'right', inside: false,
  });
  const resized = { x: 200, y: 140, width: 1720, height: 180 };
  const placed = placeTab(resized, area, anchor);
  assert.deepEqual(placed.bounds, { x: 1872, y: 260, width: 48, height: 48 });
  assert.equal(placed.inside, true);
  assert.equal(anchor.offset, 160);
  assert.equal(placeTab(host, area, anchor).bounds.y, 260);
});

test('free ball snaps only near a usable edge, including a negative-coordinate display', () => {
  const areas = [{ x: -1600, y: -200, width: 1600, height: 1000 }, ...area];
  const target = { x: -900, y: 0, width: 900, height: 600 };
  const bounds = { x: 14, y: 120, width: 48, height: 48 };
  assert.deepEqual(findTabAnchor(bounds, target, areas), { edge: 'right', offset: 120 });
  assert.equal(findTabAnchor({ ...bounds, x: 250 }, target, areas), null);
  assert.equal(placeTab(target, areas, { edge: 'right', offset: 120 }).bounds.x, 0);
});

test('a ball dropped against an inside edge reattaches even when outside space exists', () => {
  assert.deepEqual(findTabAnchor({ x: 952, y: 260, width: 48, height: 48 }, host, area), { edge: 'right', offset: 160 });
});
