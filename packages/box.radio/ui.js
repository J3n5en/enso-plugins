(() => {
  const enso = window.enso;
  if (enso?.theme) document.documentElement.dataset.theme = enso.theme;

  const $ = (id) => document.getElementById(id);
  const call = (method, args = {}) => enso.call(method, args);

  const state = {
    tab: 'hot',
    q: '',
    list: [],
    loading: false,
    error: '',
    currentId: '',
    currentName: '',
    playing: false,
    mime: '',
    favorites: [],
    book: {},
    lastId: '',
    covers: {},
    coverFail: {},
    toastTimer: 0,
    busy: false,
    regionId: 'gd',
    regions: [],
    chipsOpen: false,
    hotList: null,
    catLists: {},
  };

  let playSeq = 0;
  let loadSeq = 0;

  let media = {
    ms: null,
    sb: null,
    looping: false,
    objectUrl: '',
  };

  const playback = {
    ctx: null,
    gain: null,
    makeup: null,
    compressor: null,
    source: null,
  };

  const MAKEUP = 10 ** (10 / 20);

  function trace(msg) {
    call('trace', { msg: String(msg) }).catch(() => {});
  }

  function userVolume() {
    return Number($('vol').value) / 100;
  }

  function connectGraph() {
    const ctx = playback.ctx;
    playback.compressor = ctx.createDynamicsCompressor();
    playback.compressor.threshold.value = -24;
    playback.compressor.knee.value = 12;
    playback.compressor.ratio.value = 4;
    playback.compressor.attack.value = 0.003;
    playback.compressor.release.value = 0.25;
    playback.makeup = ctx.createGain();
    playback.makeup.gain.value = MAKEUP;
    playback.gain = ctx.createGain();
    playback.gain.gain.value = userVolume();
    playback.compressor.connect(playback.makeup);
    playback.makeup.connect(playback.gain);
    playback.gain.connect(ctx.destination);
  }

  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      if (!playback.ctx) {
        playback.ctx = new AC();
        connectGraph();
      }
      if (!playback.source) {
        playback.source = playback.ctx.createMediaElementSource($('audio'));
        playback.source.connect(playback.compressor);
        $('audio').volume = 1;
      }
      playback.ctx.resume();
    } catch (err) {
      trace(`unlockAudio ${err?.message || err}`);
    }
  }

  const storage = {
    get(key, fallback) {
      try {
        const raw = enso.storage.get(key);
        return raw == null || raw === '' ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      enso.storage.set(key, JSON.stringify(value));
    },
  };

  state.favorites = Array.isArray(storage.get('favorites', []))
    ? storage.get('favorites', []).filter((x) => typeof x === 'string').slice(0, 100)
    : [];
  state.book =
    storage.get('stationBook', {}) && typeof storage.get('stationBook', {}) === 'object'
      ? storage.get('stationBook', {})
      : {};
  state.lastId = typeof storage.get('lastId', '') === 'string' ? storage.get('lastId', '') : '';
  const savedRegion = storage.get('regionId', 'gd');
  state.regionId = typeof savedRegion === 'string' && savedRegion ? savedRegion : 'gd';
  const vol0 = Number(storage.get('volume', 0.8));
  const volume = Number.isFinite(vol0) ? Math.min(1, Math.max(0, vol0)) : 0.8;
  $('vol').value = String(Math.round(volume * 100));
  $('audio').volume = volume;

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2200);
  }

  function skipToFrame(u8) {
    for (let i = 0; i < u8.length - 1; i++) {
      if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
        return i === 0 ? u8 : u8.subarray(i);
      }
    }
    return u8;
  }

  function saveFav() {
    storage.set('favorites', state.favorites);
    storage.set('stationBook', state.book);
  }

  function glyph(name) {
    const ch = String(name || '').trim().charAt(0);
    return ch || '?';
  }

  function skipToFrame(u8) {
    for (let i = 0; i < u8.length - 1; i++) {
      if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
        return i === 0 ? u8 : u8.subarray(i);
      }
    }
    return u8;
  }

  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function cutOnFrame(u8, target) {
    const end = Math.min(u8.length - 2, target);
    const from = Math.max(1, end - 2048);
    for (let i = end; i >= from; i--) {
      if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) return i;
    }
    return target;
  }

  function displayed() {
    if (state.tab === 'fav' && !state.q) {
      return state.favorites.map((id) => state.book[id]).filter(Boolean);
    }
    return state.list;
  }

  function renderEmpty() {
    const el = $('empty');
    const rows = displayed();
    if (state.loading && !rows.length) {
      el.hidden = false;
      el.textContent = '加载中…';
      $('list').innerHTML = '';
      return true;
    }
    if (state.error && !rows.length) {
      el.hidden = false;
      el.innerHTML = '';
      el.append(state.error, document.createElement('br'));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '重试';
      btn.onclick = () => load();
      el.append(btn);
      $('list').innerHTML = '';
      return true;
    }
    if (!rows.length) {
      el.hidden = false;
      el.textContent =
        state.tab === 'fav' && !state.q
          ? '还没有收藏的电台'
          : state.tab === 'cat'
            ? '这个地区暂时没有可列出的电台'
            : '没有找到电台';
      $('list').innerHTML = '';
      return true;
    }
    el.hidden = true;
    el.textContent = '';
    return false;
  }

  function renderChips() {
    const bar = $('regionBar');
    const el = $('chips');
    if (state.tab !== 'cat' || state.q) {
      bar.hidden = true;
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const current = state.regions.find((r) => r.id === state.regionId) || state.regions[0];
    bar.hidden = false;
    $('regionCurrent').textContent = current ? current.label : '广东';
    $('regionToggle').classList.toggle('open', state.chipsOpen);
    $('regionToggle').textContent = state.chipsOpen ? '▴' : '▾';
    if (!state.chipsOpen) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = '';
    for (const r of state.regions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = r.label;
      btn.className = r.id === state.regionId ? 'on' : '';
      btn.addEventListener('click', () => {
        state.chipsOpen = false;
        if (state.regionId === r.id) {
          render();
          return;
        }
        state.regionId = r.id;
        storage.set('regionId', r.id);
        load();
      });
      el.append(btn);
    }
  }

  function render() {
    $('tab-hot').classList.toggle('on', state.tab === 'hot');
    $('tab-cat').classList.toggle('on', state.tab === 'cat');
    $('tab-fav').classList.toggle('on', state.tab === 'fav');
    renderChips();
    if (renderEmpty()) {
      renderPlayer();
      return;
    }
    const ul = $('list');
    ul.innerHTML = '';
    for (const s of displayed()) {
      const row = document.createElement('div');
      const isCurrent = s.id === state.currentId;
      const isPlaying = isCurrent && state.playing;
      row.className =
        'row' + (isPlaying ? ' playing' : isCurrent ? ' current' : '') + (s.playable ? '' : ' dead');
      row.dataset.id = s.id;

      const av = document.createElement('div');
      av.className = 'av';
      if (state.covers[s.id]) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = state.covers[s.id];
        av.append(img);
      } else {
        av.textContent = glyph(s.name);
      }
      if (s.playable) {
        const badge = document.createElement('span');
        badge.className = 'av-badge';
        badge.setAttribute('aria-hidden', 'true');
        const play = document.createElement('span');
        play.className = 'av-play';
        const pause = document.createElement('span');
        pause.className = 'av-pause';
        pause.append(document.createElement('span'), document.createElement('span'));
        const eq = document.createElement('span');
        eq.className = 'av-eq';
        eq.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
        badge.append(play, pause, eq);
        av.append(badge);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.name;
      const sub = document.createElement('div');
      sub.className = 'sub';
      const bits = [
        s.country,
        s.votes ? `热度 ${s.votes}` : '',
        Array.isArray(s.aliases) && s.aliases.length ? s.aliases.join(' / ') : '',
        s.bitrate ? `${s.bitrate}kbps` : '',
        s.playable ? s.codec : '暂不支持',
      ]
        .filter(Boolean)
        .join(' · ');
      sub.textContent = bits;
      meta.append(name, sub);

      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'star' + (state.favorites.includes(s.id) ? ' on' : '');
      star.textContent = state.favorites.includes(s.id) ? '★' : '☆';
      star.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleFav(s);
      });

      row.append(av, meta, star);
      if (s.playable) {
        av.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onRow(s);
        });
        name.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onRow(s);
        });
      }
      ul.append(row);
    }
    renderPlayer();
    queueCovers();
  }

  function renderPlayer() {
    const now = $('now');
    const toggle = $('toggle');
    const id = state.currentId || state.lastId;
    const name =
      state.currentName || (id && state.book[id] && state.book[id].name) || '';
    const footAv = $('footAv');
    footAv.replaceChildren();
    if (id && name) {
      footAv.hidden = false;
      if (state.covers[id]) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = state.covers[id];
        footAv.append(img);
      } else {
        footAv.textContent = glyph(name);
      }
    } else {
      footAv.hidden = true;
    }
    const key = `${id || ''}|${name}|${state.playing ? '1' : '0'}`;
    if (now.dataset.track !== key) {
      now.dataset.track = key;
      now.classList.remove('marquee', 'live');
      now.style.animationDuration = '';
      now.replaceChildren();
      if (!name) {
        now.textContent = '未在播放';
      } else {
        if (state.playing) now.classList.add('live');
        const a = document.createElement('span');
        a.textContent = name;
        now.append(a);
        requestAnimationFrame(() => {
          const wrap = now.parentElement;
          const reduce =
            typeof matchMedia === 'function' &&
            matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (!wrap || reduce || a.offsetWidth <= wrap.clientWidth) return;
          now.append(a.cloneNode(true));
          now.classList.add('marquee');
          now.style.animationDuration = `${Math.max(8, a.offsetWidth / 28)}s`;
        });
      }
    } else if (name) {
      now.classList.toggle('live', state.playing);
    }
    if (state.playing) {
      toggle.classList.add('is-playing');
      toggle.setAttribute('aria-label', '暂停');
    } else {
      toggle.classList.remove('is-playing');
      toggle.setAttribute('aria-label', '播放');
    }
    toggle.disabled = !state.currentId && !state.lastId;
  }

  function toggleFav(s) {
    const i = state.favorites.indexOf(s.id);
    if (i >= 0) state.favorites.splice(i, 1);
    else {
      state.favorites.unshift(s.id);
      state.favorites = state.favorites.slice(0, 100);
      state.book[s.id] = s;
    }
    saveFav();
    render();
  }

  let coverBusy = 0;
  function queueCovers() {
    for (const s of displayed()) {
      if (state.covers[s.id] || state.coverFail[s.id]) continue;
      if (coverBusy >= 2) return;
      coverBusy += 1;
      state.coverFail[s.id] = true;
      call('cover', { id: s.id, url: s.favicon || '' })
        .then((res) => {
          if (res?.ok && res.dataUrl) {
            state.covers[s.id] = res.dataUrl;
            delete state.coverFail[s.id];
            render();
          }
        })
        .catch(() => {})
        .finally(() => {
          coverBusy -= 1;
          queueCovers();
        });
    }
  }

  function tearMedia() {
    media.looping = false;
    const audio = $('audio');
    try {
      audio.pause();
    } catch {
      /* ignore */
    }
    if (media.objectUrl) {
      URL.revokeObjectURL(media.objectUrl);
      media.objectUrl = '';
    }
    media.ms = null;
    media.sb = null;
    audio.removeAttribute('src');
  }

  async function stopAll() {
    media.looping = false;
    tearMedia();
    try {
      await call('stop', {});
    } catch {
      /* ignore */
    }
    state.playing = false;
    render();
  }

  async function loopChunks(id) {
    const audio = $('audio');
    let lastCall = 0;
    let started = false;
    const sbLive = (sb) =>
      media.looping && state.currentId === id && media.sb === sb && media.ms?.readyState === 'open';
    while (media.looping && state.currentId === id) {
      const gap = 200 - (Date.now() - lastCall);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      lastCall = Date.now();
      let res;
      try {
        res = await call('chunk', { id });
      } catch (err) {
        const msg = String(err?.message || err);
        trace(`chunk throw ${msg}`);
        if (/频繁|熔断|RATE_LIMIT|CIRCUIT/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        toast('直播中断，点击重试');
        await stopAll();
        return;
      }
      if (!media.looping || state.currentId !== id) return;
      if (!res?.ok) {
        if (res?.reason === 'stale') return;
        trace(`chunk not ok ${res?.reason || ''}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (res.eof) {
        trace(`chunk eof ${res.error || ''}`);
        toast(res.error || '直播中断，点击重试');
        await stopAll();
        return;
      }
      if (res.empty) {
        continue;
      }
      if (!res.mp3) continue;
      const buf = Uint8Array.from(atob(res.mp3), (c) => c.charCodeAt(0));
      const sb = media.sb;
      if (!sbLive(sb)) return;
      try {
        if (sb.updating) {
          await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
        }
        if (!sbLive(sb)) return;
        if (sb.buffered.length) {
          const start = sb.buffered.start(0);
          const end = sb.buffered.end(sb.buffered.length - 1);
          if (end - start > 30 && audio.currentTime - start > 12) {
            sb.remove(start, Math.max(start, audio.currentTime - 8));
            await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
          }
        }
        if (!sbLive(sb)) return;
        sb.appendBuffer(buf);
        await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
      } catch {
        if (!sbLive(sb)) return;
        try {
          const aligned = skipToFrame(buf);
          if (!aligned.length) throw new Error('bad frame');
          if (sb.updating) {
            await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
          }
          if (!sbLive(sb)) return;
          sb.appendBuffer(aligned);
          await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
        } catch {
          if (!sbLive(sb)) return;
          toast('无法播放此电台');
          await stopAll();
          return;
        }
      }
      if (!started && sbLive(sb)) {
        started = true;
        audio.play().catch((err) => {
          trace(`audio.play ${err?.message || err}`);
        });
      }
    }
  }

  async function startPlay(station) {
    if (state.busy) return;
    state.busy = true;
    unlockAudio();
    const seq = ++playSeq;
    try {
    await stopAll();
    unlockAudio();
    if (seq !== playSeq) return;
    state.currentName = station.name;
    let res;
    try {
      res = await call('open', { id: station.id });
    } catch {
      trace('open throw');
      if (seq === playSeq) toast('无法播放此电台');
      return;
    }
    if (seq !== playSeq) return;
    if (res?.reason === 'unsupported') {
      if (seq === playSeq) toast('此台是 HLS，当前版本还不支持');
      return;
    }
    if (!res?.ok) {
      trace(`open fail ${res?.error || ''}`);
      if (seq === playSeq) toast(res?.error || '无法播放此电台');
      return;
    }
    state.currentId = station.id;
    state.currentName = res.name || station.name;
    state.lastId = station.id;
    storage.set('lastId', station.id);
    state.book[station.id] = station;
    saveFav();
    const audio = $('audio');
    const ms = new MediaSource();
    media.ms = ms;
    media.objectUrl = URL.createObjectURL(ms);
    audio.src = media.objectUrl;
    await new Promise((resolve, reject) => {
      ms.addEventListener(
        'sourceopen',
        () => {
          try {
            const sb = ms.addSourceBuffer(res.mime || 'audio/mpeg');
            media.sb = sb;
            resolve();
          } catch (err) {
            reject(err);
          }
        },
        { once: true },
      );
    }).catch(async () => {
      trace('sourceopen fail');
      if (seq === playSeq) {
        toast('无法播放此电台');
        await stopAll();
      }
    });
    if (seq !== playSeq) return;
    if (!media.sb) return;
    media.looping = true;
    state.playing = true;
    render();
    loopChunks(station.id);
    } finally {
      if (seq === playSeq) state.busy = false;
    }
  }

  async function onRow(s) {
    if (state.busy) return;
    unlockAudio();
    if (!s.playable) {
      toast('此台是 HLS，当前版本还不支持');
      return;
    }
    if (state.currentId === s.id && state.playing) {
      await stopAll();
      render();
      return;
    }
    if (state.currentId === s.id && !state.playing) {
      await startPlay(s);
      return;
    }
    await startPlay(s);
  }

  async function load() {
    const seq = ++loadSeq;
    const reqTab = state.tab;
    const reqRegion = state.regionId;
    const reqQ = state.q;
    const searching = Boolean(reqQ);
    const stillThis = () =>
      seq === loadSeq &&
      state.tab === reqTab &&
      state.regionId === reqRegion &&
      state.q === reqQ;

    if (!searching && reqTab === 'fav') {
      state.loading = false;
      state.error = '';
      render();
      return;
    }

    let cached = null;
    if (!searching && reqTab === 'hot') cached = state.hotList;
    if (!searching && reqTab === 'cat') cached = state.catLists[reqRegion];
    const useCache = Array.isArray(cached) && cached.length > 0;
    if (useCache) {
      state.list = cached;
      state.loading = false;
      state.error = '';
      render();
    } else {
      state.list = [];
      state.loading = true;
      state.error = '';
      render();
    }

    try {
      let res;
      if (searching) {
        res = await call('search', { q: reqQ });
      } else if (reqTab === 'cat') {
        if (!state.regions.length) {
          const meta = await call('regions', {});
          if (meta?.ok && Array.isArray(meta.regions)) {
            state.regions = meta.regions;
            if (!state.regions.some((r) => r.id === reqRegion)) {
              state.regionId = meta.defaultId || 'gd';
            }
          }
        }
        res = await call('byRegion', { id: reqRegion });
      } else {
        res = await call('discover', {});
      }
      if (seq !== loadSeq) return;
      if (!res?.ok) {
        if (stillThis() && !useCache) {
          state.list = [];
          state.error = res?.error || '电台目录暂时连不上，请稍后重试';
        }
      } else {
        const stations = res.stations || [];
        for (const s of stations) state.book[s.id] = s;
        saveFav();
        if (!searching && reqTab === 'hot') state.hotList = stations;
        if (!searching && reqTab === 'cat') state.catLists[reqRegion] = stations;
        if (stillThis()) {
          state.list = stations;
          state.error = '';
        }
      }
    } catch {
      if (seq !== loadSeq) return;
      if (stillThis() && !useCache) {
        state.list = [];
        state.error = '电台目录暂时连不上，请稍后重试';
      }
    } finally {
      if (stillThis()) {
        state.loading = false;
        render();
      }
    }
  }

  $('tab-hot').onclick = () => {
    state.tab = 'hot';
    if (state.q) {
      $('q').value = '';
      state.q = '';
    }
    load();
  };
  $('tab-cat').onclick = () => {
    state.tab = 'cat';
    state.chipsOpen = false;
    if (state.q) {
      $('q').value = '';
      state.q = '';
    }
    load();
  };
  $('tab-fav').onclick = () => {
    state.tab = 'fav';
    state.chipsOpen = false;
    render();
  };

  const toggleChips = () => {
    if (state.tab !== 'cat') return;
    state.chipsOpen = !state.chipsOpen;
    render();
  };
  $('regionToggle').onclick = toggleChips;
  $('regionCurrent').onclick = toggleChips;

  let t = 0;
  $('q').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = $('q').value.trim();
      state.tab = 'hot';
      if (!state.q) load();
      else load();
    }, 300);
  });

  $('toggle').onclick = async () => {
    if (state.busy) return;
    unlockAudio();
    if (state.playing) {
      await stopAll();
      render();
      return;
    }
    const id = state.currentId || state.lastId;
    const s = (id && state.book[id]) || displayed().find((x) => x.id === id);
    if (s) await startPlay(s);
  };
  $('vol').addEventListener('input', () => {
    const v = Number($('vol').value) / 100;
    if (playback.source) {
      $('audio').volume = 1;
      if (playback.gain) playback.gain.gain.value = v;
    } else {
      $('audio').volume = v;
    }
    storage.set('volume', v);
  });

  window.addEventListener('pagehide', () => {
    media.looping = false;
    call('stop', {}).catch(() => {});
  });

  load();
})();
