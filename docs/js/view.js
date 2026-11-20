// Draws the conversation: one block per speaker turn, large text, coloured name chips.

const TURN_GAP_MS = 7000; // the same person after this much silence starts a fresh block
const PARA_CHARS = 380; // long speeches are broken into paragraphs at sentence ends
const STAMP_EVERY_MS = 5 * 60 * 1000; // show the clock time now and then
const COLORS = 8;
const SENTENCE_END = /[.?!…]["”’')\]]*\s*$/;

function clockLabel(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export class TranscriptView {
  /**
   * list: element that receives the turns. scroller: the scrolling element.
   * onWho(speakerId): a name chip was tapped. onPinned(bool): following the latest words or not.
   */
  constructor({ list, scroller, onWho, onPinned }) {
    this.list = list;
    this.scroller = scroller;
    this.onWho = onWho || (() => {});
    this.onPinned = onPinned || (() => {});
    this.pinned = true;
    this.touching = false;
    this._reset();

    scroller.addEventListener('scroll', () => this._checkPinned(), { passive: true });
    scroller.addEventListener('touchstart', () => (this.touching = true), { passive: true });
    const release = () => {
      this.touching = false;
      this._checkPinned();
    };
    scroller.addEventListener('touchend', release, { passive: true });
    scroller.addEventListener('touchcancel', release, { passive: true });

    list.addEventListener('click', (e) => {
      const chip = e.target.closest('.who');
      if (chip && chip.dataset.spk) this.onWho(chip.dataset.spk);
    });
  }

  _reset() {
    this.speakers = new Map();
    this.turns = [];
    this.count = 0;
    this.provisional = [];
    this.tailTurn = null;
    this.lastStamp = 0;
  }

  // ---- people ---------------------------------------------------------------

  addSpeaker() {
    const n = ++this.count;
    const speaker = { id: 's' + n, n, name: '', color: (n - 1) % COLORS };
    this.speakers.set(speaker.id, speaker);
    return speaker;
  }

  nameOf(id) {
    const s = this.speakers.get(id);
    if (!s) return '';
    return s.name || 'Person ' + s.n;
  }

  isNamed(id) {
    const s = this.speakers.get(id);
    return !!(s && s.name);
  }

  /** Give a detected voice a name. Two voices given the same name look like one person. */
  rename(id, name) {
    const s = this.speakers.get(id);
    if (!s) return;
    s.name = (name || '').trim();
    s.color = (s.n - 1) % COLORS;
    if (s.name) {
      const key = s.name.toLowerCase();
      for (const other of this.speakers.values()) {
        if (other !== s && other.name.toLowerCase() === key) {
          s.color = other.color;
          break;
        }
      }
    }
    for (const turn of this.turns) if (turn.spk === id) this._paint(turn.el, s);
    for (const block of this.provisional) {
      if (block.spk === id) {
        this._paint(block.el, s);
        block.el.classList.add('prov');
      }
    }
  }

  /** Two detected voices turned out to be one person: fold the first into the second. */
  mergeSpeakers(fromId, intoId) {
    const from = this.speakers.get(fromId);
    const into = this.speakers.get(intoId);
    if (!from || !into || from === into) return;
    if (!into.name && from.name) {
      into.name = from.name;
      into.color = from.color;
    }
    this.speakers.delete(fromId);
    for (const turn of this.turns) {
      if (turn.spk === fromId) {
        turn.spk = intoId;
        turn.el.firstChild.dataset.spk = intoId;
      }
      if (turn.spk === intoId) this._paint(turn.el, into);
    }
  }

  /** The last few words this person said, to help recognise them when naming. */
  recentWords(id, max = 90) {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.spk !== id) continue;
      const text = t.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      return text.length > max ? '…' + text.slice(text.length - max).replace(/^\S*\s/, '') : text;
    }
    return '';
  }

  get lastSpeaker() {
    const t = this.turns[this.turns.length - 1];
    return t ? t.spk : null;
  }

  get isEmpty() {
    return this.turns.length === 0;
  }

  // ---- words ----------------------------------------------------------------

  /**
   * finals:  [{ spk, text, a, b }]  settled words to add (a/b = audio time in ms)
   * interim: [{ spk | null, text }] words still being worked out; replaces the previous interim
   */
  update(finals, interim) {
    if (finals.length) {
      // Settled words replace whatever was provisional.
      if (this.tailTurn) {
        this.tailTurn.tail.textContent = '';
        this.tailTurn = null;
      }
      this._dropProvisional(0);
      for (const f of finals) this._appendFinal(f);
    }
    this._showInterim(interim);
    this._follow();
  }

  clear() {
    this.list.textContent = '';
    this._reset();
    this.pinned = true;
    this.onPinned(true);
  }

  jumpToLatest() {
    this.pinned = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.onPinned(true);
  }

  /** Call after anything that changes the layout (text size, rotation). */
  refit() {
    this._follow();
  }

  toJSON() {
    return this.turns
      .filter((t) => t.text.trim())
      .map((t) => ({
        who: this.nameOf(t.spk),
        named: this.isNamed(t.spk),
        color: this.speakers.get(t.spk).color,
        text: t.text.trim(),
        at: t.at,
      }));
  }

  /** Put a saved conversation back on screen so it can be carried on (after a restart). */
  restore(saved) {
    const people = new Map();
    for (const item of saved) {
      let id = people.get(item.who);
      if (!id) {
        const speaker = this.addSpeaker();
        if (item.named) speaker.name = item.who;
        if (typeof item.color === 'number') speaker.color = item.color;
        id = speaker.id;
        people.set(item.who, id);
      }
      const turn = this._startTurn(id);
      turn.at = item.at;
      turn.lastB = -1e9; // whatever is said next starts a fresh block
      item.text.split('\n').forEach((part, i) => {
        if (i) this._newParagraph(turn);
        turn.node.appendData(part);
        turn.len += part.length;
        turn.text += part;
      });
    }
    this._follow();
  }

  // ---- internals ------------------------------------------------------------

  _paint(el, speaker) {
    el.className = 'turn c' + speaker.color;
    el.firstChild.textContent = speaker.name || 'Person ' + speaker.n;
  }

  _startTurn(spk) {
    const now = Date.now();
    if (now - this.lastStamp > STAMP_EVERY_MS) {
      const stamp = document.createElement('div');
      stamp.className = 'time';
      stamp.textContent = clockLabel(now);
      this.list.appendChild(stamp);
      this.lastStamp = now;
    }
    const el = document.createElement('section');
    const who = document.createElement('button');
    who.type = 'button';
    who.className = 'who';
    who.dataset.spk = spk;
    el.appendChild(who);
    this._paint(el, this.speakers.get(spk));
    const turn = { spk, el, text: '', at: now, lastB: 0 };
    this._newParagraph(turn);
    this.list.appendChild(el);
    this.turns.push(turn);
    return turn;
  }

  _newParagraph(turn) {
    const p = document.createElement('p');
    turn.node = document.createTextNode('');
    turn.tail = document.createElement('span');
    turn.tail.className = 'i';
    p.appendChild(turn.node);
    p.appendChild(turn.tail);
    turn.el.appendChild(p);
    turn.len = 0;
    if (turn.text) turn.text += '\n';
  }

  _appendFinal({ spk, text, a, b }) {
    let turn = this.turns[this.turns.length - 1];
    if (!turn || turn.spk !== spk || a - turn.lastB > TURN_GAP_MS) {
      turn = this._startTurn(spk);
    } else if (turn.len > PARA_CHARS && SENTENCE_END.test(turn.node.data)) {
      this._newParagraph(turn);
    }
    if (!turn.len) text = text.replace(/^\s+/, '');
    turn.lastB = b;
    if (!text) return;
    turn.node.appendData(text);
    turn.len += text.length;
    turn.text += text;
  }

  _dropProvisional(from) {
    for (const old of this.provisional.splice(from)) old.el.remove();
  }

  _makeProvisional(spk) {
    const speaker = spk ? this.speakers.get(spk) : null;
    const el = document.createElement('section');
    const who = document.createElement('button');
    who.type = 'button';
    who.className = 'who';
    el.appendChild(who);
    if (speaker) {
      who.dataset.spk = speaker.id;
      this._paint(el, speaker);
    } else {
      el.className = 'turn cx';
      who.textContent = '…';
      who.disabled = true;
    }
    el.classList.add('prov');
    const p = document.createElement('p');
    const span = document.createElement('span');
    span.className = 'i';
    p.appendChild(span);
    el.appendChild(p);
    return { el, span, spk: speaker ? speaker.id : null };
  }

  /**
   * Words still being worked out. These arrive several times a second, so blocks already
   * on screen are updated in place rather than rebuilt: a name chip must hold still long
   * enough to be tapped.
   */
  _showInterim(groups) {
    let i = 0;
    const last = this.turns[this.turns.length - 1];
    let tailText = '';
    if (groups.length && last && (groups[0].spk == null || groups[0].spk === last.spk)) {
      tailText = last.len ? groups[0].text : groups[0].text.replace(/^\s+/, '');
      i = 1;
    }
    if (this.tailTurn && this.tailTurn !== last) this.tailTurn.tail.textContent = '';
    this.tailTurn = null;
    if (last) {
      if (last.tail.textContent !== tailText) last.tail.textContent = tailText;
      if (tailText) this.tailTurn = last;
    }

    let n = 0;
    for (; i < groups.length; i++) {
      const text = groups[i].text.replace(/^\s+/, '');
      if (!text) continue;
      const spk = groups[i].spk && this.speakers.has(groups[i].spk) ? groups[i].spk : null;
      let block = this.provisional[n];
      if (!block || block.spk !== spk) {
        this._dropProvisional(n);
        block = this._makeProvisional(spk);
        this.list.appendChild(block.el);
        this.provisional.push(block);
      }
      if (block.span.textContent !== text) block.span.textContent = text;
      n++;
    }
    this._dropProvisional(n);
  }

  _follow() {
    if (this.pinned && !this.touching) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  _checkPinned() {
    const sc = this.scroller;
    const pinned = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
    if (pinned !== this.pinned) {
      this.pinned = pinned;
      this.onPinned(pinned);
    }
  }
}

/** Read-only rendering of a saved conversation. */
export function renderSaved(container, conversation) {
  container.textContent = '';
  for (const turn of conversation.turns) {
    const el = document.createElement('section');
    el.className = 'turn c' + (turn.color || 0);
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = turn.who;
    el.appendChild(who);
    for (const part of turn.text.split('\n')) {
      const p = document.createElement('p');
      p.textContent = part;
      el.appendChild(p);
    }
    container.appendChild(el);
  }
}
