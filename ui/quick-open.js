'use strict';

(() => {
  const byId = id => document.getElementById(id);

  class QuickOpen {
    constructor(openFile) {
      this.openFile = openFile;
      this.dialog = byId('quick-open-dialog');
      this.launcher = byId('quick-open');
      this.input = byId('quick-open-query');
      this.list = byId('quick-open-results');
      this.status = byId('quick-open-status');
      this.entries = [];
      this.index = -1;
      this.revision = 0;
      this.launcher.addEventListener('click', () => this.show());
      byId('quick-open-close').addEventListener('click', () => this.dialog.close());
      this.input.addEventListener('input', () => this.scheduleSearch());
      this.input.addEventListener('keydown', event => this.keydown(event));
      this.list.addEventListener('click', event => {
        const result = event.target.closest('.quick-open-result');
        if (result) this.choose(Number(result.dataset.index));
      });
      this.dialog.addEventListener('close', () => {
        if (this.dialog.open) return;
        clearTimeout(this.timer);
        this.revision++;
        this.input.setAttribute('aria-expanded', 'false');
        this.input.removeAttribute('aria-activedescendant');
      });
      document.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'p') return;
        if (document.querySelector('dialog[open]:not(#quick-open-dialog)') || document.body.classList.contains('ball-collapsed')) return;
        event.preventDefault();
        this.show();
      });
    }

    show() {
      if (this.launcher.disabled) return;
      if (this.dialog.open) {
        this.input.focus();
        this.input.select();
        return;
      }
      this.input.value = '';
      this.dialog.returnValue = '';
      this.dialog.showModal();
      this.input.setAttribute('aria-expanded', 'true');
      this.input.focus();
      this.scheduleSearch(true);
    }

    close(reason) {
      clearTimeout(this.timer);
      this.revision++;
      if (this.dialog.open) this.dialog.close(reason);
    }

    query() {
      const value = this.input.value.trim();
      const suffix = value.match(/:(\d+)$/);
      const line = suffix ? Number(suffix[1]) : null;
      return {
        text: suffix ? value.slice(0, -suffix[0].length).trimEnd() : value,
        line: Number.isSafeInteger(line) && line > 0 ? line : null,
      };
    }

    scheduleSearch(immediate = false) {
      clearTimeout(this.timer);
      const revision = ++this.revision;
      const { text } = this.query();
      this.render([], '正在搜索…');
      if (immediate) void this.search(text, revision);
      else this.timer = setTimeout(() => void this.search(text, revision), 120);
    }

    async search(query, revision) {
      try {
        const { entries, truncated } = await window.desk.searchFiles(query);
        if (!this.dialog.open || revision !== this.revision) return;
        const message = entries.length
          ? truncated ? '结果较多，请继续输入缩小范围。' : ''
          : '没有找到匹配的文件。';
        this.render(entries, message);
      } catch (error) {
        if (!this.dialog.open || revision !== this.revision) return;
        const message = String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        this.render([], message);
      }
    }

    render(entries, message) {
      this.entries = entries;
      this.index = -1;
      this.input.removeAttribute('aria-activedescendant');
      const fragment = document.createDocumentFragment();
      for (const [index, { path }] of entries.entries()) {
        const result = document.createElement('div');
        result.id = `quick-open-result-${index}`;
        result.className = 'quick-open-result';
        result.dataset.index = String(index);
        result.title = path;
        result.setAttribute('role', 'option');
        result.setAttribute('aria-selected', 'false');
        const label = document.createElement('span');
        const slash = path.lastIndexOf('/');
        label.textContent = path.slice(slash + 1);
        result.append(label);
        if (slash !== -1) {
          const directory = document.createElement('span');
          directory.textContent = path.slice(0, slash);
          result.append(directory);
        }
        fragment.append(result);
      }
      this.list.replaceChildren(fragment);
      this.list.scrollTop = 0;
      if (entries.length) this.select(0);
      this.status.textContent = message;
      this.status.hidden = !message;
    }

    select(index) {
      this.list.children[this.index]?.setAttribute('aria-selected', 'false');
      this.index = index;
      const result = this.list.children[index];
      result.setAttribute('aria-selected', 'true');
      this.input.setAttribute('aria-activedescendant', result.id);
      result.scrollIntoView({ block: 'nearest' });
    }

    keydown(event) {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.choose(this.index);
      } else if (this.entries.length && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        const step = event.key === 'ArrowUp' ? -1 : 1;
        this.select((this.index + step + this.entries.length) % this.entries.length);
      }
    }

    choose(index) {
      const result = this.entries[index];
      if (!result) return;
      const { line } = this.query();
      this.close('selected');
      this.openFile(result.path, line);
    }
  }

  window.QuickOpen = QuickOpen;
})();
