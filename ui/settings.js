'use strict';

(() => {
  const dialog = document.getElementById('settings-dialog');
  const launcher = document.getElementById('settings-open');
  const close = document.getElementById('settings-close');
  const status = document.getElementById('settings-status');
  const shortcut = document.getElementById('settings-shortcut');
  const controls = {
    launchWithCodex: document.getElementById('setting-launch'),
    autoSize: document.getElementById('setting-auto-size'),
  };
  const edges = [...dialog.querySelectorAll('[data-outside-edge]')];
  let settings;
  let busy = false;

  function render() {
    for (const [key, input] of Object.entries(controls)) {
      input.checked = Boolean(settings?.[key]);
      input.disabled = busy || !settings;
    }
    for (const button of edges) button.disabled = busy;
    if (shortcut) {
      shortcut.textContent = settings?.shortcutAvailable === false ? 'Ctrl+Shift+空格被其他程序占用' : 'Ctrl+Shift+空格 · 展开或收起';
    }
  }

  async function act(action) {
    if (busy) return;
    busy = true;
    status.hidden = true;
    render();
    try { await action(); }
    catch (error) {
      status.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
      status.hidden = false;
    } finally {
      busy = false;
      render();
    }
  }

  launcher.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
    void act(async () => { settings = await window.desk.settings(); });
  });
  close.addEventListener('click', () => dialog.close());
  for (const [key, input] of Object.entries(controls)) {
    input.addEventListener('change', () => {
      const checked = input.checked;
      void act(async () => { settings = await window.desk.setSetting(key, checked); });
    });
  }
  for (const button of edges) {
    button.addEventListener('click', () => void act(async () => {
      await window.desk.setOutsideEdge(button.dataset.outsideEdge, button.dataset.inside === 'true');
      dialog.close();
    }));
  }
})();
