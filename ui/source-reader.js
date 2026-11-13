'use strict';

(() => {
  const MAX_SEARCH_MATCHES = 20000;

  const languages = {
    javascript: {
      keywords: 'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield',
      line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], template: true,
    },
    python: {
      keywords: 'False None True and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try type while with yield',
      line: '#', quotes: ['"', "'"], tripleQuotes: true,
    },
    c: {
      keywords: 'alignas alignof auto bool break case char class const constexpr continue decltype default delete do double else enum explicit extern false float for friend if inline int long mutable namespace new noexcept nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while',
      line: '//', block: ['/*', '*/'], quotes: ['"', "'"],
    },
    csharp: {
      keywords: 'abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event false finally fixed float for foreach get if in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sealed set short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile where while yield',
      line: '//', block: ['/*', '*/'], quotes: ['"', "'"],
    },
    java: {
      keywords: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for if implements import instanceof int interface long native new null package private protected public record return sealed short static strictfp super switch synchronized this throw throws transient true try var void volatile while yield',
      line: '//', block: ['/*', '*/'], quotes: ['"', "'"], tripleQuotes: true,
    },
    go: {
      keywords: 'any bool break byte case chan const continue default defer else error fallthrough false for func go goto if import interface map nil package range return rune select string struct switch true type var',
      line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], template: true,
    },
    rust: {
      keywords: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
      line: '//', block: ['/*', '*/'], quotes: ['"'],
    },
    ruby: {
      keywords: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
      line: '#', quotes: ['"', "'"],
    },
    shell: {
      keywords: 'begin break case continue do done echo else elseif end esac exit export fi for foreach function if in local read return set then trap until while',
      line: '#', quotes: ['"', "'", '`'],
    },
    config: {
      keywords: 'false null true yes no on off',
      line: '#', quotes: ['"', "'"], property: true,
    },
    json: {
      keywords: 'false null true',
      line: '//', block: ['/*', '*/'], quotes: ['"'], property: true,
    },
    sql: {
      keywords: 'all alter and as asc between by case create cross delete desc distinct drop else end exists false from full group having in inner insert into is join left like limit not null on or order outer primary right select set table then true union unique update values view when where with',
      line: '--', block: ['/*', '*/'], quotes: ['"', "'", '`'], ignoreKeywordCase: true,
    },
    markup: {
      block: ['<!--', '-->'], quotes: ['"', "'"], tag: true,
    },
    css: {
      block: ['/*', '*/'], quotes: ['"', "'"], property: true,
    },
  };

  const extensions = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'javascript', tsx: 'javascript', mts: 'javascript', cts: 'javascript',
    py: 'python', pyw: 'python', c: 'c', cpp: 'c', cc: 'c', cxx: 'c', h: 'c', hpp: 'c', cs: 'csharp', java: 'java', kt: 'java', kts: 'java',
    go: 'go', rs: 'rust', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell', psm1: 'shell', cmd: 'shell', bat: 'shell',
    yaml: 'config', yml: 'config', toml: 'config', ini: 'config', conf: 'config', json: 'json', jsonc: 'json', sql: 'sql',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', css: 'css', scss: 'css', less: 'css',
  };

  function escapeExpression(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function lexerFor(path) {
    const name = path.split('/').at(-1).toLowerCase();
    const language = languages[extensions[name.split('.').at(-1)] || (name === 'dockerfile' ? 'shell' : '')];
    if (!language) return line => [{ text: line }];

    const { block, line: comment, quotes = [] } = language;
    const keywords = new Set((language.keywords || '').split(' '));
    const triples = language.tripleQuotes ? ['"""', "'''"] : [];
    const symbols = [block?.[0], comment, ...triples, ...quotes].filter(Boolean).map(escapeExpression);
    if (language.tag) symbols.push('<\\/?[A-Za-z][\\w:-]*');
    symbols.push(language.tag || language.property ? '[A-Za-z_$][\\w$-]*' : '[A-Za-z_$][\\w$]*',
      '(?:0[xX][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)');
    const pattern = new RegExp(symbols.join('|'), 'g');
    let multiline;

    function stringEnd(text, delimiter, start) {
      for (let i = start; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text.startsWith(delimiter, i)) return i + delimiter.length;
      }
      return -1;
    }

    return line => {
      const tokens = [];
      let cursor = 0;
      if (multiline) {
        const finish = multiline.kind === 'comment'
          ? line.indexOf(multiline.end) : stringEnd(line, multiline.end, 0);
        if (finish < 0) return [{ text: line, kind: multiline.kind }];
        cursor = finish + (multiline.kind === 'comment' ? multiline.end.length : 0);
        tokens.push({ text: line.slice(0, cursor), kind: multiline.kind });
        multiline = undefined;
      }
      pattern.lastIndex = cursor;
      let match;
      while ((match = pattern.exec(line))) {
        const token = match[0];
        const start = match.index;
        let kind;
        let end = pattern.lastIndex;
        if (start > cursor) tokens.push({ text: line.slice(cursor, start) });
        if (token === comment) {
          kind = 'comment';
          end = line.length;
        } else if (block && token === block[0]) {
          kind = 'comment';
          const close = line.indexOf(block[1], end);
          if (close < 0) {
            multiline = { kind, end: block[1] };
            end = line.length;
          } else end = close + block[1].length;
        } else if (quotes.includes(token) || triples.includes(token)) {
          kind = 'string';
          const close = stringEnd(line, token, end);
          if (close < 0) {
            if (triples.includes(token) || (language.template && token === '`')) multiline = { kind, end: token };
            end = line.length;
          } else {
            end = close;
            if (language.property && /^\s*:/.test(line.slice(end))) kind = 'property';
          }
        } else if (token.startsWith('<')) kind = 'tag';
        else if (/^\d/.test(token)) kind = 'number';
        else if (keywords.has(language.ignoreKeywordCase ? token.toLowerCase() : token)) kind = 'keyword';
        else if ((language.tag || language.property) && /^\s*[:=]/.test(line.slice(end))) kind = 'property';
        else if (/^\s*\(/.test(line.slice(end))) kind = 'function';
        tokens.push({ text: line.slice(start, end), kind });
        cursor = end;
        pattern.lastIndex = end;
      }
      if (cursor < line.length) tokens.push({ text: line.slice(cursor) });
      return tokens;
    };
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function action(label, title, handler) {
    const button = node('button', 'button subtle source-action', label);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', handler);
    return button;
  }

  class SourceReader {
    constructor(body) {
      this.body = body;
      this.rows = [];
      this.matches = [];
      this.activeMatch = -1;
      this.truncated = false;
      this.searchButton = action('查找', '查找源码（Ctrl+F）', () => this.showTool('find'));
      this.searchButton.hidden = true;
      this.searchButton.id = 'source-find';
      body.parentElement.querySelector('.diff-heading').insertBefore(this.searchButton, document.getElementById('source-toggle'));

      this.tools = node('div', 'source-tools');
      this.tools.hidden = true;
      body.before(this.tools);
      this.find = node('div', 'source-find-bar');
      this.query = node('input', 'source-input');
      this.query.type = 'search';
      this.query.placeholder = '查找源码';
      this.query.maxLength = 512;
      this.query.setAttribute('aria-label', '查找源码');
      this.query.spellcheck = false;
      this.counter = node('span', 'source-find-count');
      this.counter.setAttribute('role', 'status');
      this.previous = action('↑', '上一个匹配（Shift+Enter）', () => this.moveMatch(-1));
      this.next = action('↓', '下一个匹配（Enter）', () => this.moveMatch(1));
      this.find.append(this.query, this.counter, this.previous, this.next,
        action('行号', '跳到指定行（Ctrl+G）', () => this.showTool('goto')));
      this.goto = node('div', 'source-goto-bar');
      this.line = node('input', 'source-input');
      this.line.type = 'text';
      this.line.inputMode = 'numeric';
      this.line.placeholder = '跳到行号';
      this.line.maxLength = 6;
      this.line.setAttribute('aria-label', '跳到行号');
      this.lineMessage = node('span', 'source-find-count');
      this.lineMessage.setAttribute('role', 'status');
      this.goto.append(this.line, this.lineMessage, action('跳转', '跳到指定行', () => this.submitLine()));
      this.tools.append(this.find, this.goto, action('×', '关闭查找或行号框（Esc）', () => this.hideTool()));
      this.query.addEventListener('input', () => this.search());
      this.query.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.moveMatch(event.shiftKey ? -1 : 1);
        }
      });
      this.line.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submitLine();
        }
      });
      document.addEventListener('keydown', event => {
        if (!this.rows.length || event.defaultPrevented || event.target.closest?.('dialog')) return;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'f' || key === 'g')) {
          event.preventDefault();
          this.showTool(key === 'f' ? 'find' : 'goto');
        } else if (key === 'escape' && !this.tools.hidden) {
          event.preventDefault();
          this.hideTool();
        }
      });
    }

    clear() {
      this.rows = [];
      this.matches = [];
      this.activeMatch = -1;
      this.searchButton.hidden = true;
      this.tools.hidden = true;
    }

    render(source, path) {
      const table = node('div', 'diff-table source-table');
      const lines = source.text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.at(-1) === '' && lines.length > 1) lines.pop();
      this.truncated = source.truncated;
      const tokenize = lexerFor(path);
      this.rows = lines.map((text, index) => {
        const row = node('div', 'diff-row source-row');
        row.dataset.line = String(index + 1);
        const number = node('span', 'line-number source-gutter', String(index + 1));
        number.setAttribute('aria-hidden', 'true');
        const code = node('span', 'line-code');
        row.append(number, code);
        table.append(row);
        const tokens = text.length <= 20000 ? tokenize(text) : [{ text }];
        const info = { row, code, text, tokens };
        this.paint(info);
        return info;
      });
      this.searchButton.hidden = false;
      this.body.replaceChildren(table);
      if (this.truncated) this.body.append(node('p', 'diff-notice', '仅显示文件开头。查找和跳转限于已加载的行。'));
      this.body.scrollTop = 0;
      this.body.scrollLeft = 0;
    }

    paint(info, match) {
      const contents = document.createDocumentFragment();
      let offset = 0;
      for (const token of info.tokens) {
        const span = token.kind ? node('span', `syntax-${token.kind}`) : contents;
        const from = match ? Math.max(0, match.column - offset) : 0;
        const to = match ? Math.min(token.text.length, match.column + match.length - offset) : 0;
        if (to > from) {
          span.append(token.text.slice(0, from), node('mark', 'source-match', token.text.slice(from, to)), token.text.slice(to));
        } else span.append(token.text);
        if (token.kind) contents.append(span);
        offset += token.text.length;
      }
      info.code.replaceChildren(contents);
    }

    showTool(tool) {
      this.tools.hidden = false;
      this.find.hidden = tool !== 'find';
      this.goto.hidden = tool !== 'goto';
      if (tool === 'find') {
        this.query.focus();
        this.query.select();
        this.search();
      } else {
        this.lineMessage.textContent = `1–${this.rows.length}`;
        this.line.focus();
        this.line.select();
      }
    }

    hideTool() {
      this.tools.hidden = true;
      this.clearMatch();
      this.body.focus({ preventScroll: true });
    }

    clearMatch() {
      const previous = this.matches[this.activeMatch];
      if (previous) this.paint(this.rows[previous.index]);
      this.activeMatch = -1;
    }

    search() {
      this.clearMatch();
      this.matches = [];
      this.searchLimited = false;
      const query = this.query.value;
      if (query) {
        const pattern = new RegExp(escapeExpression(query), 'giu');
        outer: for (const [index, item] of this.rows.entries()) {
          for (const match of item.text.matchAll(pattern)) {
            if (this.matches.length === MAX_SEARCH_MATCHES) {
              this.searchLimited = true;
              break outer;
            }
            this.matches.push({ index, column: match.index, length: match[0].length });
          }
        }
      }
      this.previous.disabled = this.next.disabled = !this.matches.length;
      if (this.matches.length) this.moveMatch(1);
      else this.counter.textContent = query ? '无匹配' : '';
    }

    moveMatch(step) {
      if (!this.matches.length) return;
      const current = this.activeMatch;
      this.clearMatch();
      this.activeMatch = (current < 0 && step < 0 ? this.matches.length - 1 : (current + step + this.matches.length) % this.matches.length);
      const match = this.matches[this.activeMatch];
      const info = this.rows[match.index];
      this.paint(info, match);
      info.code.querySelector('.source-match')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      this.counter.textContent = `${this.activeMatch + 1}/${this.matches.length}${this.searchLimited ? '+' : ''}`;
    }

    submitLine() {
      const value = this.line.value.trim();
      const number = /^\d+$/.test(value) ? Number(value) : 0;
      if (number < 1 || number > this.rows.length) {
        this.lineMessage.textContent = this.truncated && number > this.rows.length ? '该行未加载' : '行号无效';
        return;
      }
      this.body.querySelector('.located')?.classList.remove('located');
      const row = this.rows[number - 1].row;
      row.classList.add('located');
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      this.hideTool();
    }
  }

  window.SourceReader = SourceReader;
})();
