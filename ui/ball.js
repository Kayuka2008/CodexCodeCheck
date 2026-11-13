'use strict';

(() => {
  const api = window.desk;
  const brand = document.getElementById('window-brand');
  const collapseButton = document.getElementById('window-collapse');
  const ball = document.getElementById('floating-ball');
  const code = document.getElementById('diff-body');
  let collapsed = false;
  let pending = false;
  let focusBeforeCollapse;
  let savedScroll;
  let drag;
  let moveFrame;
  let ignoreDragClick = false;

  function describeBall() {
    const attached = document.body.dataset.ballAttached === 'true';
    const activity = ball.classList.contains('has-activity') ? ' · 有新修改' : '';
    ball.title = (attached ? '单击展开 · 沿边拖动 · 向外拖开可脱离' : '单击展开 · 拖回 Codex 边缘可吸附') + activity;
    ball.setAttribute('aria-label', `展开代码预览${activity}`);
  }

  function update({ collapsed: next }) {
    if (collapsed === next) return;
    collapsed = next;
    if (next) {
      focusBeforeCollapse = document.activeElement;
      savedScroll = [...document.querySelectorAll('.tree-list, .file-list, .diff-body, .review-body')]
        .map(element => [element, element.scrollLeft, element.scrollTop]);
      const dialog = document.getElementById('settings-dialog');
      if (dialog.open) dialog.close();
      document.body.classList.remove('panel-restoring');
    }
    document.body.classList.toggle('ball-collapsed', next);
    ball.hidden = !next;
    if (next) {
      if (document.hasFocus()) ball.focus({ preventScroll: true });
    } else {
      finishBallDrag();
      ball.classList.remove('has-activity');
      document.body.classList.add('panel-restoring');
      for (const [element, left, top] of savedScroll || []) element.scrollTo(left, top);
      if (document.hasFocus()) {
        const previous = focusBeforeCollapse;
        const target = previous?.isConnected && previous !== document.body && previous.getClientRects().length ? previous : code;
        target.focus({ preventScroll: true });
      }
      focusBeforeCollapse = undefined;
      savedScroll = undefined;
    }
    describeBall();
  }

  async function setCollapsed(next) {
    if (pending || next === collapsed) return;
    pending = true;
    try {
      update(await api.setCollapsed(next));
    } catch (error) {
      const status = document.getElementById('status-message');
      status.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      status.title = status.textContent;
      status.classList.add('error');
    } finally {
      pending = false;
    }
  }

  function sendDrag(phase) {
    api.dragBall(phase)?.catch(() => {});
  }

  function startBallDrag(event) {
    if (!collapsed || drag || event.pointerType !== 'mouse' || !event.isPrimary || event.button !== 0) return;
    ball.setPointerCapture(event.pointerId);
    ignoreDragClick = false;
    drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
    sendDrag('start');
  }

  function dragThresholdReached(event) {
    if (drag.moved) return true;
    if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < 5) return false;
    drag.moved = true;
    ball.classList.add('dragging');
    return true;
  }

  function moveBall(event) {
    if (!drag || drag.pointerId !== event.pointerId || !dragThresholdReached(event) || moveFrame !== undefined) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = undefined;
      sendDrag('move');
    });
  }

  function finishBallDrag(event) {
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    const released = event?.type === 'pointerup';
    if (released) dragThresholdReached(event);
    const { pointerId, moved } = drag;
    drag = undefined;
    if (moveFrame !== undefined) cancelAnimationFrame(moveFrame);
    moveFrame = undefined;
    if (moved) {
      // Use the last cursor position even when release beats the queued frame.
      sendDrag('move');
      // Cancellation or capture loss can still synthesize a click on Windows.
      ignoreDragClick = true;
    }
    sendDrag('end');
    ball.classList.remove('dragging');
    if (ball.hasPointerCapture(pointerId)) ball.releasePointerCapture(pointerId);
  }

  brand.addEventListener('dblclick', () => void setCollapsed(true));
  collapseButton.addEventListener('click', () => void setCollapsed(true));
  describeBall();
  ball.addEventListener('pointerdown', startBallDrag);
  ball.addEventListener('pointermove', moveBall);
  ball.addEventListener('pointerup', finishBallDrag);
  ball.addEventListener('pointercancel', finishBallDrag);
  ball.addEventListener('lostpointercapture', finishBallDrag);
  ball.addEventListener('click', event => {
    if (event.detail === 0) void setCollapsed(false);
    else if (ignoreDragClick) ignoreDragClick = false;
    else void setCollapsed(false);
  });
  window.addEventListener('blur', () => finishBallDrag());
  window.addEventListener('focus', () => {
    if (collapsed) ball.focus({ preventScroll: true });
  });
  window.addEventListener('desk-dock-state', ({ detail }) => {
    if (typeof detail.collapsed === 'boolean') update(detail);
    describeBall();
  });
  api.onProjectActivity(() => {
    if (!collapsed) return;
    ball.classList.add('has-activity');
    describeBall();
  });
  api.onRepositoryChanged(() => {
    ball.classList.remove('has-activity');
    describeBall();
  });
  api.onCollapsedChanged(update);
})();
