'use strict';

// All game state lives here, in the browsers. The server only relays messages between the sockets of a
// room, so everything below is about agreeing on state peer to peer:
//
// * The room (round, revealed, deck, moderator) is shared. Whoever changes it bumps its version and
//   broadcasts it; everyone keeps the highest version, ties going to the earlier change, then the
//   lower clientId, so every browser settles on the same room.
// * Each person's record (name, voted, and the vote itself once revealed) belongs to that person and
//   only they publish it. Its seq is a timestamp, so a reloaded page still outranks its older copies.
// * Before reveal a record says only "voted". On reveal every browser publishes its own value, so a vote
//   never leaves its browser until the moderator reveals.
// * A newcomer says hello; everyone answers with the room and the records they know, so a dropped
//   connection or a reloaded page catches up from whoever is still there.

const DECKS = {
  fib: { label: 'Fibonacci', cards: ['1', '2', '3', '5', '8', '13', '21', '?', '☕'] },
  tshirt: { label: 'T-shirt sizes', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'] },
};
const ROOM_RE = /^\/rooms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const OFFLINE_DROP_MS = 60_000;
const MODERATOR_GRACE_MS = 30_000;
const STATE_WAIT_MS = 2_500;

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const session = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

/* ---------- theme ---------- */

const THEMES = ['system', 'light', 'dark'];
function currentTheme() { return document.documentElement.dataset.theme || 'system'; }
function applyTheme(t) {
  if (t === 'system') { delete document.documentElement.dataset.theme; store.del('est:theme'); }
  else { document.documentElement.dataset.theme = t; store.set('est:theme', t); }
  const btn = $('theme-toggle');
  btn.title = btn.ariaLabel = `Theme: ${t}`;
}
$('theme-toggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
});
applyTheme(currentTheme());

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- routing ---------- */

const match = ROOM_RE.exec(location.pathname.toLowerCase());
if (location.pathname === '/') {
  $('landing').hidden = false;
  $('create-room').addEventListener('click', () => { location.href = `/rooms/${uuid()}`; });
} else if (match) {
  startRoom(match[1]);
} else {
  location.replace('/');
}

/* ---------- room ---------- */

function startRoom(roomId) {
  $('room').hidden = false;
  $('copy-link').hidden = false;
  document.title = 'Estimations room';

  let clientId = store.get('est:clientId');
  if (!clientId) { clientId = uuid(); store.set('est:clientId', clientId); }
  let name = store.get('est:name') || '';
  const joinedAt = Date.now();
  const voteKey = `est:vote:${roomId}`;
  const roomKey = `est:room:${roomId}`;

  let ws = null;
  let connId = null;
  let everConnected = false;
  let backoff = 500;
  let stateTimer = null;
  let room = session.get(roomKey); // survives a reload of this tab only
  let seq = 0;
  let celebrated = null;
  let moderatorMissingSince = null;
  const people = new Map(); // clientId -> record
  const conns = new Map(); // connId -> clientId (null until their hello arrives)
  const offlineSince = new Map(); // clientId -> ms

  function loadVote() {
    try {
      const v = JSON.parse(store.get(voteKey));
      return v && room && v.roundId === room.roundId ? v.value : null;
    } catch { return null; }
  }
  function saveVote(value) {
    if (value == null) store.del(voteKey);
    else store.set(voteKey, JSON.stringify({ roundId: room.roundId, value }));
  }

  // bump: false for a local look at our own record, true when it is about to be sent
  function record(bump = true) {
    const vote = room ? loadVote() : null;
    if (bump) seq = Math.max(Date.now(), seq + 1);
    return {
      clientId,
      name,
      joinedAt,
      roundId: room ? room.roundId : null,
      voted: vote != null,
      vote: room && room.revealed ? vote : null,
      seq,
    };
  }

  function online(cid) {
    if (cid === clientId) return true;
    for (const c of conns.values()) if (c === cid) return true;
    return false;
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function knownRecords() {
    const out = [];
    for (const r of people.values()) {
      if (online(r.clientId) || votedThisRound(r)) out.push(r);
    }
    return out;
  }

  function votedThisRound(r) { return !!room && r.roundId === room.roundId && r.voted; }

  function publishMe() { send({ t: 'me', rec: record() }); }

  /* --- validation: peers are other people's browsers, so nothing they send is trusted blindly --- */

  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  function cleanRecord(r) {
    if (!r || typeof r !== 'object') return null;
    const cid = str(r.clientId, 64);
    if (!cid || num(r.seq) == null) return null;
    return {
      clientId: cid,
      name: (str(r.name, 64) || 'Anonymous').slice(0, 32),
      joinedAt: num(r.joinedAt) ?? Date.now(),
      roundId: str(r.roundId, 64),
      voted: r.voted === true,
      vote: str(r.vote, 8),
      seq: r.seq,
    };
  }

  function cleanRoom(r) {
    if (!r || typeof r !== 'object') return null;
    if (num(r.v) == null || num(r.ts) == null || !str(r.by, 64) || !str(r.roundId, 64) || !str(r.moderator, 64)) return null;
    return { v: r.v, ts: r.ts, by: r.by, roundId: r.roundId, revealed: r.revealed === true, deck: DECKS[r.deck] ? r.deck : 'fib', moderator: r.moderator };
  }

  function newer(a, b) {
    if (!b) return true;
    if (a.v !== b.v) return a.v > b.v;
    if (a.ts !== b.ts) return a.ts < b.ts;
    return a.by < b.by;
  }

  /* --- merging --- */

  function mergeRecord(raw) {
    const r = cleanRecord(raw);
    if (!r || r.clientId === clientId) return;
    const prev = people.get(r.clientId);
    if (!prev || r.seq > prev.seq) people.set(r.clientId, r);
  }

  function mergeRoom(raw) {
    const r = cleanRoom(raw);
    if (r && newer(r, room)) applyRoom(r);
  }

  function applyRoom(r) {
    const prev = room;
    room = r;
    session.set(roomKey, room);
    const newRound = !prev || prev.roundId !== r.roundId;
    if (newRound) {
      if (loadVote() == null) store.del(voteKey);
      celebrated = null;
      // a new round forgets whoever is not here any more
      for (const cid of [...people.keys()]) if (!online(cid)) { people.delete(cid); offlineSince.delete(cid); }
    }
    if (newRound || prev.revealed !== r.revealed) publishMe();
    render();
  }

  function changeRoom(changes) {
    if (!room) return;
    const r = { ...room, ...changes, v: room.v + 1, ts: Date.now(), by: clientId };
    send({ t: 'room', room: r });
    applyRoom(r);
  }

  function initRoom() {
    applyRoom({ v: 1, ts: Date.now(), by: clientId, roundId: uuid(), revealed: false, deck: 'fib', moderator: clientId });
  }

  /* --- connection --- */

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/${roomId}`);
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => {
      connId = null;
      // everyone else is unknown until we are back; their records stay, greyed out
      for (const cid of new Set(conns.values())) if (cid) offlineSince.set(cid, offlineSince.get(cid) ?? Date.now());
      conns.clear();
      $('conn-banner').hidden = false;
      render();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
  }

  function handle(msg) {
    switch (msg.t) {
      case 'welcome': {
        if (typeof msg.from === 'string') break; // only the relay itself sends these
        connId = msg.connId;
        backoff = 500;
        $('conn-banner').hidden = true;
        conns.clear();
        const peers = Array.isArray(msg.peers) ? msg.peers : [];
        for (const p of peers) conns.set(p, null);
        const firstConnect = !everConnected;
        everConnected = true;
        send({ t: 'hello', rec: record(), room, known: knownRecords() });
        clearTimeout(stateTimer);
        if (peers.length === 0) {
          // Alone in the room: whoever opens an empty room runs it. Only on a fresh page load, so that
          // after a server restart the reconnecting browsers do not all grab the role at once.
          if (!room) initRoom();
          else if (firstConnect && room.moderator !== clientId) changeRoom({ moderator: clientId });
        } else if (!room) {
          stateTimer = setTimeout(() => { if (!room) initRoom(); }, STATE_WAIT_MS);
        }
        render();
        break;
      }
      case 'peer-join':
        if (typeof msg.from === 'string') break; // only the relay itself sends these
        conns.set(msg.connId, null);
        break;
      case 'peer-leave': {
        if (typeof msg.from === 'string') break;
        const cid = conns.get(msg.connId);
        conns.delete(msg.connId);
        if (cid && !online(cid)) offlineSince.set(cid, Date.now());
        render();
        break;
      }
      case 'hello':
      case 'state': {
        const rec = cleanRecord(msg.rec);
        if (!rec || typeof msg.from !== 'string') break;
        conns.set(msg.from, rec.clientId);
        offlineSince.delete(rec.clientId);
        mergeRecord(rec);
        if (Array.isArray(msg.known)) msg.known.slice(0, 100).forEach(mergeRecord);
        mergeRoom(msg.room);
        if (msg.t === 'hello') send({ t: 'state', to: msg.from, rec: record(), room, known: knownRecords() });
        render();
        break;
      }
      case 'me': {
        const rec = cleanRecord(msg.rec);
        if (!rec || typeof msg.from !== 'string') break;
        conns.set(msg.from, rec.clientId);
        offlineSince.delete(rec.clientId);
        mergeRecord(rec);
        render();
        break;
      }
      case 'room':
        mergeRoom(msg.room);
        break;
    }
  }

  // Housekeeping once a second: drop people who left, and hand the moderator role on when its holder
  // has been gone for half a minute - to whoever has been in the room the longest.
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [cid, r] of people) {
      if (online(cid)) continue;
      const since = offlineSince.get(cid) ?? now;
      if (!offlineSince.has(cid)) offlineSince.set(cid, now);
      if (now - since > OFFLINE_DROP_MS && !votedThisRound(r)) {
        people.delete(cid);
        offlineSince.delete(cid);
        changed = true;
      }
    }
    if (room && connId && !online(room.moderator)) {
      moderatorMissingSince ??= now;
      if (now - moderatorMissingSince > MODERATOR_GRACE_MS) {
        const candidates = [{ clientId, joinedAt }, ...[...people.values()].filter((r) => online(r.clientId))]
          .sort((a, b) => a.joinedAt - b.joinedAt || (a.clientId < b.clientId ? -1 : 1));
        if (candidates[0].clientId === clientId) changeRoom({ moderator: clientId });
        moderatorMissingSince = null;
      }
    } else {
      moderatorMissingSince = null;
    }
    if (changed) render();
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && name && (!ws || ws.readyState === WebSocket.CLOSED)) { backoff = 500; connect(); }
  });

  /* --- user actions --- */

  function pick(value) {
    if (!room || room.revealed) return;
    saveVote(loadVote() === value ? null : value);
    publishMe();
    render();
  }

  $('reveal').addEventListener('click', () => changeRoom({ revealed: true }));
  $('reset').addEventListener('click', () => {
    store.del(voteKey);
    changeRoom({ revealed: false, roundId: uuid() });
  });
  $('deck-select').addEventListener('change', (e) => {
    store.del(voteKey);
    changeRoom({ deck: e.target.value, revealed: false, roundId: uuid() });
  });

  let armTimer = null;
  $('take-over').addEventListener('click', () => {
    const btn = $('take-over');
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Tap again to confirm';
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    changeRoom({ moderator: clientId });
    toast('You are the moderator now');
  });
  function disarm() {
    clearTimeout(armTimer);
    $('take-over').classList.remove('armed');
    $('take-over').textContent = 'Take over moderator';
  }

  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied');
    } catch {
      prompt('Copy this link', location.href);
    }
  });

  /* --- name dialog --- */

  const dialog = $('name-dialog');
  function askName() {
    $('name-input').value = name;
    dialog.showModal();
    $('name-input').select();
  }
  dialog.addEventListener('cancel', (e) => { if (!name) e.preventDefault(); });
  $('name-form').addEventListener('submit', () => {
    const v = $('name-input').value.trim().slice(0, 32);
    if (!v) return;
    name = v;
    store.set('est:name', name);
    if (!ws) connect();
    else publishMe();
    render();
  });

  /* --- rendering --- */

  const seatEls = new Map();
  let handDeck = null;

  function seatList() {
    const list = [record(false), ...people.values()].map((r) => ({
      ...r,
      online: online(r.clientId),
      voted: votedThisRound(r) || (r.clientId === clientId && r.voted),
      vote: r.clientId === clientId ? loadVote() : (room && r.roundId === room.roundId ? r.vote : null),
    }));
    return list.sort((a, b) => a.joinedAt - b.joinedAt || a.name.localeCompare(b.name));
  }

  function render() {
    if (!room) {
      $('status-line').textContent = connId ? 'Joining the room...' : 'Connecting...';
      return;
    }
    const deck = DECKS[room.deck];
    const isMod = room.moderator === clientId;
    const seats = seatList();
    const voters = seats.filter((s) => s.voted);
    const modSeat = seats.find((s) => s.clientId === room.moderator);

    // controls
    $('reveal').hidden = !isMod || room.revealed;
    $('reveal').disabled = voters.length === 0;
    $('reset').hidden = !isMod;
    $('reset').classList.toggle('primary', room.revealed);
    $('deck-select-wrap').hidden = !isMod;
    $('deck-select').value = room.deck;
    $('take-over').hidden = isMod;
    $('round-label').textContent = `${deck.label}${isMod ? ' - you are the moderator' : modSeat ? ` - moderator: ${modSeat.name}` : ''}`;

    // seats
    const shown = new Set();
    const pending = room.revealed ? voters.filter((s) => s.vote == null) : [];
    const values = voters.map((s) => s.vote).filter((v) => v != null);
    const consensus = room.revealed && pending.length === 0 && voters.length >= 2 && values.every((v) => v === values[0]) && values[0] !== '?';

    for (const s of seats) {
      shown.add(s.clientId);
      let el = seatEls.get(s.clientId);
      if (!el) {
        el = document.createElement('div');
        el.className = 'seat';
        el.innerHTML = '<div class="card"><div class="card-empty"></div><div class="card-inner"><div class="card-face card-back"></div><div class="card-face card-front"></div></div></div><div class="seat-name"><span></span></div><div class="seat-sub"></div>';
        if (s.clientId === clientId) el.querySelector('.seat-name span').addEventListener('click', askName);
        seatEls.set(s.clientId, el);
      }
      const isMe = s.clientId === clientId;
      const face = room.revealed && s.vote != null;
      el.classList.toggle('me', isMe);
      el.classList.toggle('offline', !s.online);
      el.classList.toggle('voted', s.voted);
      el.classList.toggle('shown', face);
      el.classList.toggle('pending', room.revealed && s.voted && s.vote == null);
      el.classList.toggle('match', consensus && face);
      const front = el.querySelector('.card-front');
      if (face) front.textContent = s.vote;
      front.classList.toggle('long', !!s.vote && s.vote.length > 2);
      const nameEl = el.querySelector('.seat-name');
      nameEl.querySelector('span').textContent = s.name || '...';
      nameEl.querySelector('span').title = isMe ? 'Change your name' : s.name;
      let crown = nameEl.querySelector('.crown');
      if (s.clientId === room.moderator && !crown) {
        nameEl.insertAdjacentHTML('afterbegin', '<svg class="crown" viewBox="0 0 24 24" aria-label="Moderator"><path d="M3 7l4 4 5-6 5 6 4-4-2 11H5z"/></svg>');
      } else if (s.clientId !== room.moderator && crown) {
        crown.remove();
      }
      el.querySelector('.seat-sub').textContent = isMe ? 'you' : !s.online ? 'offline' : '';
    }
    for (const [cid, el] of seatEls) if (!shown.has(cid)) { el.remove(); seatEls.delete(cid); }
    const container = $('seats');
    seats.forEach((s, i) => {
      const el = seatEls.get(s.clientId);
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    });

    // status line
    const status = $('status-line');
    if (!room.revealed) {
      status.textContent = voters.length === 0 ? 'Pick a card' : `${voters.length} of ${seats.length} voted`;
    } else if (pending.length) {
      status.textContent = `Waiting for ${pending.map((s) => s.name).join(', ')} to come back`;
    } else if (consensus) {
      status.textContent = 'Everyone agrees!';
    } else {
      status.textContent = 'Cards are on the table';
    }
    if (!isMod && !room.revealed && voters.length) status.textContent += modSeat ? `, waiting for ${modSeat.name} to reveal` : '';

    renderResults(deck, values, consensus);
    renderHand(deck);

    if (consensus && celebrated !== room.roundId) {
      celebrated = room.roundId;
      confetti();
    }
  }

  function renderResults(deck, values, consensus) {
    const box = $('results');
    if (!room.revealed || values.length === 0) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    const ordered = deck.cards.filter((c) => counts.has(c)).concat([...counts.keys()].filter((c) => !deck.cards.includes(c)));
    const max = Math.max(...counts.values());
    const stats = [];
    if (room.deck === 'fib' && !consensus) {
      const nums = values.map(Number).filter((n) => Number.isFinite(n));
      if (nums.length) {
        const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
        stats.push(['Average', Number.isInteger(avg) ? String(avg) : avg.toFixed(1)]);
      }
    }
    const top = ordered.filter((c) => counts.get(c) === max);
    stats.push([consensus ? 'Consensus' : top.length > 1 ? 'Most picked (tie)' : 'Most picked', top.join(' / ')]);

    const frag = document.createDocumentFragment();
    for (const [label, value] of stats) {
      const s = document.createElement('div');
      s.className = 'stat' + (consensus ? ' consensus' : '');
      const b = document.createElement('b'); b.textContent = value;
      const sp = document.createElement('span'); sp.textContent = label;
      s.append(b, sp);
      frag.append(s);
    }
    const bars = document.createElement('div');
    bars.className = 'bars';
    for (const c of ordered) {
      const row = document.createElement('div');
      row.className = 'bar';
      row.innerHTML = '<span></span><div class="bar-track"><div class="bar-fill"></div></div><span class="n"></span>';
      row.children[0].textContent = c;
      row.children[2].textContent = counts.get(c);
      const fill = row.querySelector('.bar-fill');
      requestAnimationFrame(() => { fill.style.width = `${(counts.get(c) / max) * 100}%`; });
      bars.append(row);
    }
    frag.append(bars);
    box.replaceChildren(frag);
  }

  function renderHand(deck) {
    const hand = $('hand');
    if (handDeck !== room.deck) {
      handDeck = room.deck;
      hand.replaceChildren(...deck.cards.map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pick' + (c.length > 2 ? ' long' : '');
        b.setAttribute('role', 'radio');
        b.dataset.value = c;
        b.textContent = c;
        b.ariaLabel = c === '☕' ? 'Coffee break' : c === '?' ? 'Not sure' : c;
        b.addEventListener('click', () => pick(c));
        return b;
      }));
    }
    const mine = loadVote();
    for (const b of hand.children) {
      b.setAttribute('aria-checked', String(b.dataset.value === mine));
      b.disabled = room.revealed;
    }
  }

  /* --- confetti for a unanimous reveal --- */

  function confetti() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#f97316', '#fb923c', '#facc15', '#22c55e', '#38bdf8', '#a78bfa', '#f472b6'];
    const parts = Array.from({ length: 180 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120,
      y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 15 - 5,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const start = performance.now();
    (function frame(t) {
      const age = t - start;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, age - 2200) / 800);
      for (const p of parts) {
        p.vy += 0.42; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.cos(p.r * 2));
        ctx.restore();
      }
      if (age < 3000) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  }

  render();
  if (name) connect();
  else askName();
}
