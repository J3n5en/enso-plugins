/**
 * Incremental file readers and derived-board cache for the Swarm Board sidecar.
 *
 * Keeps board.jsonl and transcript.jsonl reads O(delta) across polls via
 * byte-offset tailing verified by inode, head, and tail anchors. Large
 * transcripts (> 256 KB) cold-start with an expanding EOF tail-read whenever
 * the newest step carries a numeric `step_index`, avoiding multi-gigabyte
 * full-file reads on startup. Derived board state (processed messages,
 * @mention edges, per-member post stats, channels, and screenshot frames) is
 * cached across transcript-only ticks and incrementally appended on
 * single-channel boards.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { channelOf, channelRegistry, controlOf, MAIN, mentionsOf } from './channels.mjs';

const ANCHOR_CHECK_BYTES = 64;
const TRANSCRIPT_TAIL_LINES = 1024;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_TAIL_BYTES = 2 * 1024 * 1024;

let nextEpoch = 0;

export function statOf(path) {
  try {
    const s = statSync(path);
    return { mtime: s.mtimeMs, size: s.size, ino: s.ino };
  } catch {
    return { mtime: 0, size: -1, ino: 0 };
  }
}

// Mirrors board.parse: skip blank and unparseable lines.
function parseBoard(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m && typeof m === 'object') out.push(m);
    } catch {
      // A torn final line is picked up on the next read.
    }
  }
  return out;
}

function readExact(fd, length, position) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const n = readSync(fd, buf, total, length - total, position + total);
    if (n <= 0) return null;
    total += n;
  }
  return buf;
}

function nextTailAnchor(prevAnchor, slice, completeLen) {
  if (completeLen >= ANCHOR_CHECK_BYTES) {
    return Buffer.from(slice.subarray(completeLen - ANCHOR_CHECK_BYTES, completeLen));
  }
  const keep = Buffer.concat([prevAnchor, slice.subarray(0, completeLen)]);
  return Buffer.from(keep.subarray(Math.max(0, keep.length - ANCHOR_CHECK_BYTES)));
}

function nextHeadAnchor(prevHead, slice, completeLen) {
  if (prevHead.length >= ANCHOR_CHECK_BYTES || completeLen <= 0) return prevHead;
  const keep = Buffer.concat([prevHead, slice.subarray(0, completeLen)]);
  return Buffer.from(keep.subarray(0, Math.min(ANCHOR_CHECK_BYTES, keep.length)));
}

// Verifies inode, head anchor, tail anchor, and any previously seen un-newlined
// remainder before reading appended bytes past hit.readOffset. Returns null if
// the file was truncated, replaced, or rewritten so the caller falls back to a
// full read.
function readAppendedTail(path, hit) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const fs = fstatSync(fd);
    if (fs.ino !== hit.ino || fs.size < hit.size || hit.readOffset > fs.size) return null;
    if (hit.headAnchor.length > 0) {
      const head = readExact(fd, hit.headAnchor.length, 0);
      if (!head || !head.equals(hit.headAnchor)) return null;
    }
    if (hit.anchor.length > 0) {
      const tail = readExact(fd, hit.anchor.length, hit.readOffset - hit.anchor.length);
      if (!tail || !tail.equals(hit.anchor)) return null;
    }
    const slice = readExact(fd, fs.size - hit.readOffset, hit.readOffset);
    if (!slice) return null;
    // Detect in-place mutation of an un-newlined trailing line.
    if (hit.rem.length > 0 && (slice.length < hit.rem.length || !slice.subarray(0, hit.rem.length).equals(hit.rem))) {
      return null;
    }
    const lastNl = slice.lastIndexOf(0x0a);
    let readOffset = hit.readOffset;
    let anchor = hit.anchor;
    let headAnchor = hit.headAnchor;
    let completeBuf = null;
    if (lastNl >= 0) {
      const completeLen = lastNl + 1;
      completeBuf = slice.subarray(0, completeLen);
      readOffset = hit.readOffset + completeLen;
      anchor = nextTailAnchor(hit.anchor, slice, completeLen);
      headAnchor = nextHeadAnchor(hit.headAnchor, slice, completeLen);
    }
    const remBuf = Buffer.from(slice.subarray(lastNl + 1));
    return { size: fs.size, mtime: fs.mtimeMs, ino: fs.ino, readOffset, anchor, headAnchor, completeBuf, remBuf };
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

// Decodes each non-empty line directly from `buf` so cached tail lines are
// standalone strings rather than V8 SlicedStrings pinning a full-file string.
function nonEmptyLines(buf) {
  const out = [];
  for (let pos = 0; pos < buf.length;) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl < 0 ? buf.length : nl;
    if (end > pos) {
      const line = buf.toString('utf-8', pos, end);
      if (line.trim()) out.push(line);
    }
    pos = end + 1;
  }
  return out;
}

function touchCache(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function putCache(cache, key, entry, limit) {
  touchCache(cache, key, entry);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
  return entry;
}

function probeFile(cache, path, maxAppendBytes = Infinity) {
  const s = statOf(path);
  if (s.size < 0) {
    cache.delete(path);
    return { status: 'missing', s };
  }
  const hit = cache.get(path);
  if (hit && hit.size === s.size && hit.mtime === s.mtime && hit.ino === s.ino) {
    return { status: 'hit', s, hit: touchCache(cache, path, hit) };
  }
  if (hit && hit.readOffset > 0 && s.size >= hit.size && s.ino === hit.ino && s.size - hit.readOffset <= maxAppendBytes) {
    const delta = readAppendedTail(path, hit);
    if (delta) return { status: 'append', s, hit, delta };
  }
  return { status: 'miss', s, hit };
}

function readFullFile(path) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const fs = fstatSync(fd);
    const buf = readExact(fd, fs.size, 0);
    if (!buf) return null;
    const lastNl = buf.lastIndexOf(0x0a);
    const readOffset = lastNl >= 0 ? lastNl + 1 : 0;
    return {
      size: fs.size, mtime: fs.mtimeMs, ino: fs.ino, readOffset,
      anchor: Buffer.from(buf.subarray(Math.max(0, readOffset - ANCHOR_CHECK_BYTES), readOffset)),
      headAnchor: Buffer.from(buf.subarray(0, Math.min(ANCHOR_CHECK_BYTES, readOffset))),
      completeBuf: lastNl >= 0 ? buf.subarray(0, lastNl + 1) : null,
      remBuf: Buffer.from(buf.subarray(lastNl + 1)),
    };
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

const boardFileCache = new Map(); // path -> cached board state

// Reads and parses an append-only board.jsonl incrementally from the last
// newline offset, falling back to a full read (and bumping `epoch`) if the
// file shrank, changed inode, or its anchor/prefix bytes changed.
export function readBoardCached(path) {
  const p = probeFile(boardFileCache, path);
  if (p.status === 'missing') return { msgs: [], epoch: 0, ...p.s };
  if (p.status === 'hit') return { msgs: p.hit.msgs, epoch: p.hit.epoch, ...p.s };
  const isAppend = p.status === 'append';
  const chunk = isAppend ? p.delta : readFullFile(path);
  if (!chunk) {
    boardFileCache.delete(path);
    return { msgs: [], epoch: 0, ...p.s };
  }
  const added = chunk.completeBuf ? parseBoard(chunk.completeBuf.toString('utf-8')) : [];
  const base = isAppend ? p.hit.completeMsgs : [];
  const completeMsgs = added.length ? base.concat(added) : base;
  const remMsgs = chunk.remBuf.length ? parseBoard(chunk.remBuf.toString('utf-8')) : [];
  const msgs = remMsgs.length ? completeMsgs.concat(remMsgs) : completeMsgs;
  // Bump epoch if a previously parsed un-newlined trailing line was completed or extended.
  const epoch = isAppend && p.hit.msgs.length === p.hit.completeMsgs.length ? p.hit.epoch : ++nextEpoch;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = chunk;
  putCache(boardFileCache, path, { size, mtime, ino, readOffset, anchor, headAnchor, rem, completeMsgs, msgs, epoch }, 256);
  return { msgs, epoch, mtime, size, ino };
}

// Extracts total complete-line step count from the newest parseable step in
// `lines` if it carries a finite non-negative `step_index`. Returns
// `{ok: false, missingIndex: true}` when a parseable step lacks `step_index`
// (or its index is smaller than the tail window), signaling callers to skip
// further window doubling and fall back to a full read immediately.
function inferStepCountFromTail(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try {
      step = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!step || typeof step !== 'object') continue;
    if (!Number.isFinite(step.step_index) || step.step_index < 0) {
      return { ok: false, missingIndex: true };
    }
    const inferred = Math.floor(step.step_index) + 1 + (lines.length - 1 - i);
    if (inferred < lines.length) return { ok: false, missingIndex: true };
    return { ok: true, count: inferred };
  }
  return { ok: false, missingIndex: false };
}

// Cold-start EOF tail-read for large transcripts (> TRANSCRIPT_TAIL_BYTES).
// Doubles the trailing window up to TRANSCRIPT_MAX_TAIL_BYTES if the newest
// turn boundary is not yet inside the window. Returns null whenever step_index
// is absent or the window is exhausted so the caller falls back cleanly to a
// full readFileSync.
function readTranscriptTailFromEOF(path, summarizeLines) {
  let fd = -1;
  try {
    fd = openSync(path, 'r');
    const fs = fstatSync(fd);
    if (fs.size <= TRANSCRIPT_TAIL_BYTES) return null;
    for (let windowBytes = TRANSCRIPT_TAIL_BYTES; windowBytes < fs.size && windowBytes <= TRANSCRIPT_MAX_TAIL_BYTES; windowBytes *= 2) {
      const startPos = fs.size - windowBytes;
      const buf = readExact(fd, windowBytes, startPos);
      if (!buf) return null;
      const firstNl = buf.indexOf(0x0a);
      if (firstNl < 0) continue; // Single trailing line larger than windowBytes.
      const tailBuf = buf.subarray(firstNl + 1);
      const lastNl = tailBuf.lastIndexOf(0x0a);
      if (lastNl < 0) continue; // No complete line after discarded partial line.
      const completeBuf = tailBuf.subarray(0, lastNl + 1);
      const remBuf = tailBuf.subarray(lastNl + 1);
      const completeLines = nonEmptyLines(completeBuf);
      if (!completeLines.length) continue;
      const rem = remBuf.toString('utf-8');
      const hasRem = Boolean(rem.trim());
      const workLines = hasRem ? completeLines.concat([rem]) : completeLines;
      const inferred = inferStepCountFromTail(workLines);
      if (!inferred.ok) {
        if (inferred.missingIndex) return null;
        continue;
      }
      const totalLines = inferred.count;
      const completeCount = totalLines - (hasRem ? 1 : 0);
      const summary = summarizeLines(workLines, totalLines, fs.mtimeMs, true);
      if (!summary) continue;

      const readOffset = startPos + firstNl + 1 + lastNl + 1;
      const inBufEnd = firstNl + 1 + lastNl + 1;
      const anchor = inBufEnd >= ANCHOR_CHECK_BYTES
        ? Buffer.from(buf.subarray(inBufEnd - ANCHOR_CHECK_BYTES, inBufEnd))
        : readExact(fd, Math.min(ANCHOR_CHECK_BYTES, readOffset), Math.max(0, readOffset - ANCHOR_CHECK_BYTES));
      const headAnchor = readExact(fd, Math.min(ANCHOR_CHECK_BYTES, readOffset), 0);
      if (!anchor || !headAnchor) return null;
      return {
        key: `${fs.mtimeMs}:${fs.size}:${fs.ino}`, size: fs.size, mtime: fs.mtimeMs, ino: fs.ino,
        readOffset, anchor, headAnchor, rem: Buffer.from(remBuf), completeCount,
        tailLines: completeLines.slice(-TRANSCRIPT_TAIL_LINES), isPartial: true, summary,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
}

const transcriptCache = new Map(); // path -> entry
export const NO_TRANSCRIPT = { key: '-', summary: null };

function applyTranscriptAppend(path, hit, app, summarizeLines) {
  let { completeCount, tailLines, isPartial } = hit;
  if (app.completeBuf) {
    const added = nonEmptyLines(app.completeBuf);
    if (added.length) {
      completeCount += added.length;
      tailLines = tailLines.concat(added);
      if (tailLines.length > TRANSCRIPT_TAIL_LINES) {
        tailLines = tailLines.slice(-TRANSCRIPT_TAIL_LINES);
        isPartial = true;
      }
    }
  }
  const remText = app.remBuf.toString('utf-8');
  const hasRem = Boolean(remText.trim());
  const workLines = hasRem ? tailLines.concat([remText]) : tailLines;
  const summary = summarizeLines(workLines, completeCount + (hasRem ? 1 : 0), app.mtime, isPartial);
  if (!summary) return null;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = app;
  return putCache(transcriptCache, path, {
    key: `${mtime}:${size}:${ino}`, size, mtime, ino, readOffset, anchor, headAnchor, rem,
    completeCount, tailLines, isPartial, summary,
  }, 500);
}

// Incrementally reads and summarizes a member's transcript.jsonl:
//   1. Exact mtime+size+inode cache hit -> O(1)
//   2. Small append (<= TRANSCRIPT_TAIL_BYTES) past readOffset -> O(delta)
//   3. Cold start or large append (> TRANSCRIPT_TAIL_BYTES) -> EOF tail-read
//   4. Missing step_index on large append -> incremental append, else full read
export function readTranscriptCached(path, summarizeLines) {
  const p = probeFile(transcriptCache, path, TRANSCRIPT_TAIL_BYTES);
  if (p.status === 'missing') return NO_TRANSCRIPT;
  if (p.status === 'hit') return p.hit;
  if (p.status === 'append') {
    const updated = applyTranscriptAppend(path, p.hit, p.delta, summarizeLines);
    if (updated) return updated;
  }
  if (p.s.size > TRANSCRIPT_TAIL_BYTES) {
    const tailed = readTranscriptTailFromEOF(path, summarizeLines);
    if (tailed) return putCache(transcriptCache, path, tailed, 500);
  }
  if (p.status === 'miss' && p.hit?.readOffset > 0 && p.s.size >= p.hit.size &&
      p.s.ino === p.hit.ino && p.s.size - p.hit.readOffset > TRANSCRIPT_TAIL_BYTES) {
    const delta = readAppendedTail(path, p.hit);
    if (delta) {
      const updated = applyTranscriptAppend(path, p.hit, delta, summarizeLines);
      if (updated) return updated;
    }
  }
  const full = readFullFile(path);
  if (!full) {
    transcriptCache.delete(path);
    return NO_TRANSCRIPT;
  }
  const completeLines = full.completeBuf ? nonEmptyLines(full.completeBuf) : [];
  const remText = full.remBuf.toString('utf-8');
  const allLines = remText.trim() ? completeLines.concat([remText]) : completeLines;
  const summary = summarizeLines(allLines, allLines.length, full.mtime, false);
  const isPartial = completeLines.length > TRANSCRIPT_TAIL_LINES;
  const tailLines = isPartial ? completeLines.slice(-TRANSCRIPT_TAIL_LINES) : completeLines;
  const { size, mtime, ino, readOffset, anchor, headAnchor, remBuf: rem } = full;
  return putCache(transcriptCache, path, {
    key: `${mtime}:${size}:${ino}`, size, mtime, ino, readOffset, anchor, headAnchor, rem,
    completeCount: completeLines.length, tailLines, isPartial, summary,
  }, 500);
}

function processMessageSlice(roster, names, msgs, startIdx, byChannel, posts, edges, { isRoleWorker, boardTimeMs }) {
  const out = [];
  for (let i = startIdx; i < msgs.length; i++) {
    const m = msgs[i];
    const seq = Number(m.seq) || 0;
    const agent = String(m.agent ?? '');
    const text = String(m.text ?? '');
    const time = m.time || '';
    const ts = boardTimeMs(time);
    const channel = channelOf(m);
    const control = controlOf(m);
    const chanFields = { ...(channel !== MAIN ? { channel } : {}), ...(control ? { control } : {}) };
    // A channel change is a system line, not a post: no mentions, no counts.
    if (control) {
      out.push({ seq, agent, text, time, ts, mentions: [], all: false, ...chanFields });
      continue;
    }
    const { mentions, all } = mentionsOf(text, names);
    // channel_mentions: the active channels it addresses; via_channel: the
    // members they call on that it does not name.
    const ch = byChannel ? byChannel(i, text) : null;
    const viaChannel = ch ? ch.members.filter((n) => n !== agent && !mentions.includes(n)) : [];
    const chanMentionFields = ch?.channels.length ? { channel_mentions: ch.channels, via_channel: viaChannel } : {};
    const p = posts.get(agent) || { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null };
    posts.set(agent, { posts: p.posts + 1, lastPostSeq: seq, lastPostTime: time, lastPostTs: ts });
    if (!isRoleWorker(agent, roster.members[agent])) {
      const direct = new Set([...mentions, ...viaChannel]);
      const targets = new Set(all ? names : mentions);
      for (const n of direct) targets.add(n);
      targets.delete(agent);
      for (const to of targets) {
        if (isRoleWorker(to, roster.members[to])) continue;
        const key = `${agent}\0${to}`;
        const e = edges.get(key) || { from: agent, to, count: 0, direct: 0, viaAll: 0 };
        e.count++;
        if (direct.has(to)) e.direct++;
        else e.viaAll++;
        edges.set(key, e);
      }
    }
    out.push({ seq, agent, text, time, ts, mentions, all, ...chanFields, ...chanMentionFields });
  }
  return out;
}

const PINNED_TEXT_CAP = 2048;
const ROLE_NAME_RE = /^(?:narrator|monitor)(?:-\d+)?$/;
const BRIEF_MENTION_RE = /^@([\w-]+)/;
const STALL_TAG_RE = /\[stall\]/i;

export function parsePositiveInt(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function createTailSummary(leadName) {
  return {
    leadName,
    nonControlCount: 0,
    firstPostTs: null,
    firstTeamIdx: -1,
    firstBriefIdx: new Map(),   // targetName -> first coordinator @target message index
    lastTeamMsgIdx: new Map(),  // agentName -> latest non-role, non-control message index
    lastMonStallIdx: -1,
    posters: new Set(),
    channelCounts: new Map(),
    monotonicSeqs: true,
    lastSeq: -Infinity,
  };
}

const cloneTailSummary = (prev) => ({
  ...prev,
  firstBriefIdx: new Map(prev.firstBriefIdx),
  lastTeamMsgIdx: new Map(prev.lastTeamMsgIdx),
  posters: new Set(prev.posters),
  channelCounts: new Map(prev.channelCounts),
});

function updateTailSummary(summary, messages, startIdx, roster, { roleOf, isRoleWorker }) {
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i];
    if (m.seq <= summary.lastSeq) summary.monotonicSeqs = false;
    summary.lastSeq = m.seq;
    if (m.agent) summary.posters.add(m.agent);
    const ch = m.channel || MAIN;
    summary.channelCounts.set(ch, (summary.channelCounts.get(ch) || 0) + 1);
    if (m.control) continue;
    summary.nonControlCount++;
    if (summary.firstPostTs === null && Number.isFinite(m.ts)) summary.firstPostTs = m.ts;
    const member = roster.members[m.agent];
    if (roleOf(m.agent, member) === 'monitor' && STALL_TAG_RE.test(m.text)) summary.lastMonStallIdx = i;
    if (isRoleWorker(m.agent, member)) continue;
    if (summary.firstTeamIdx < 0) summary.firstTeamIdx = i;
    summary.lastTeamMsgIdx.set(m.agent, i);
    if (m.agent === summary.leadName) {
      const bm = BRIEF_MENTION_RE.exec(m.text);
      if (bm && !summary.firstBriefIdx.has(bm[1])) summary.firstBriefIdx.set(bm[1], i);
    }
  }
  return summary;
}

// First index in monotonic `messages` with `seq >= targetSeq` (or `messages.length`).
function lowerBoundSeq(messages, targetSeq) {
  let lo = 0, hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].seq < targetSeq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findSeqIndex(messages, summary, targetSeq) {
  if (!messages.length || targetSeq <= 0) return -1;
  if (summary?.monotonicSeqs) {
    const idx = lowerBoundSeq(messages, targetSeq);
    return messages[idx]?.seq === targetSeq ? idx : -1;
  }
  return messages.findIndex((m) => m.seq === targetSeq);
}

function lowerBoundNum(nums, target) {
  let lo = 0, hi = nums.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nums[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Finds `member`'s first visible unread post inside the omitted `[0, endOffset)`
// prefix (0 if none), so tailed clients avoid false "New" dividers on tail[0].
export function findFirstUnreadSeq(snap, member, unseenList, endOffset = snap.messages.length) {
  const messages = snap.messages;
  const limit = Math.min(endOffset, messages.length);
  const me = member && limit > 0 ? snap.members.find((m) => m.name === member) : null;
  if (!me) return 0;
  const cursor = Number(me.last_read_seq) || 0;
  const monotonic = Boolean(snap._summary?.monotonicSeqs);
  const start = monotonic && cursor > 0 ? lowerBoundSeq(messages, Math.floor(cursor) + 1) : 0;
  if (start >= limit) return 0;
  const hasUnseen = Boolean(unseenList?.length);
  let uIdx = monotonic && hasUnseen ? lowerBoundNum(unseenList, messages[start].seq) : 0;
  let unseen = null;
  for (let i = start; i < limit; i++) {
    const m = messages[i];
    if (m.control || m.seq <= cursor || m.agent === member) continue;
    if (hasUnseen) {
      if (monotonic) {
        while (uIdx < unseenList.length && unseenList[uIdx] < m.seq) uIdx++;
        if (unseenList[uIdx] === m.seq) { uIdx++; continue; }
      } else {
        unseen ||= new Set(unseenList);
        if (unseen.has(m.seq)) continue;
      }
    }
    return m.seq;
  }
  return 0;
}

// Pins omitted wakeup posts for currently-working team members in one reverse pass.
function pinActiveWakeups(all, summary, members, addIdx) {
  const roleByName = new Map(members.map((m) => [m.name, Boolean(m.roleWorker || m.narrator)]));
  const isHiveRole = (n) => Boolean(roleByName.get(n)) || ROLE_NAME_RE.test(n);
  const hiveKey = (n) => (n === summary.leadName ? 'coordinator' : n);
  const pending = new Map(); // hiveKey -> wakeFrom
  for (const m of members) {
    if (m.killed || m.status !== 'working' || isHiveRole(m.name)) continue;
    const lpIdx = summary.lastTeamMsgIdx.get(m.name) ?? -1;
    const wakeFrom = Math.max(0, Number(m.wait_since) || 0, lpIdx >= 0 ? all[lpIdx].seq : 0);
    const key = hiveKey(m.name);
    pending.set(key, pending.has(key) ? Math.min(pending.get(key), wakeFrom) : wakeFrom);
  }
  if (!pending.size) return;
  let minWake = Math.min(...pending.values());
  const claim = (key, seq, from, idx) => {
    const wakeFrom = pending.get(key);
    if (wakeFrom === undefined || key === from || seq <= wakeFrom) return;
    addIdx(idx);
    pending.delete(key);
    if (wakeFrom === minWake && pending.size) minWake = Math.min(...pending.values());
  };
  for (let i = all.length - 1; i >= 0 && pending.size; i--) {
    const q = all[i];
    if (summary.monotonicSeqs && q.seq <= minWake) break;
    if (q.control || q.seq <= minWake) continue;
    const from = hiveKey(q.agent);
    if (q.all && !isHiveRole(q.agent)) {
      for (const key of [...pending.keys()]) claim(key, q.seq, from, i);
      continue;
    }
    for (const t of q.mentions || []) claim(hiveKey(t), q.seq, from, i);
    for (const t of q.via_channel || []) claim(hiveKey(t), q.seq, from, i);
  }
}

// Sorted unique message seqs cited by narrator `view.json` attention items or jump actions.
export function narratorRefSeqs(attention) {
  if (!Array.isArray(attention) || !attention.length) return [];
  const seqs = new Set();
  for (const item of attention) {
    if (!item || typeof item !== 'object') continue;
    const seqRef = Array.isArray(item.refs) ? item.refs.find((r) => r?.seq) : null;
    const refSeq = seqRef ? parsePositiveInt(seqRef.seq) : 0;
    if (refSeq > 0) seqs.add(refSeq);
    for (const act of Array.isArray(item.actions) ? item.actions : []) {
      const target = act?.type === 'board_post' ? parsePositiveInt(act.target) : 0;
      if (target > 0) seqs.add(target);
    }
  }
  return [...seqs].sort((a, b) => a - b);
}

// Key of narrator attention seqs that fall inside the omitted `[0, endOffset)` prefix.
export function prefixViewKey(snap, endOffset) {
  const refs = snap._viewRefs;
  const all = snap.messages;
  if (!refs?.length || endOffset <= 0 || endOffset >= all.length) return '';
  const summary = snap._summary;
  const limit = summary?.monotonicSeqs ? lowerBoundNum(refs, all[endOffset].seq) : refs.length;
  const out = [];
  for (let i = 0; i < limit; i++) {
    const idx = findSeqIndex(all, summary, refs[i]);
    if (idx >= 0 && idx < endOffset) out.push(refs[i]);
  }
  return out.join(',');
}

// Pins omitted posts cited by narrator `view.json` attention items or jump actions.
function pinNarratorRefs(all, summary, snap, addIdx) {
  const refs = snap._viewRefs ?? narratorRefSeqs(snap.view?.json?.attention);
  for (const seq of refs) addIdx(findSeqIndex(all, summary, seq));
}

// Builds the compact pinned summary posts from `[0, startOffset)` so Overview,
// Members, and Hive stay in parity with a full load (and across `view.json` edits).
export function buildPinnedMessages(snap, startOffset) {
  const all = snap.messages;
  const summary = snap._summary;
  if (!summary || startOffset <= 0) return [];
  const pinnedIdx = new Set();
  const addIdx = (idx) => { if (idx >= 0 && idx < startOffset) pinnedIdx.add(idx); };
  addIdx(summary.firstTeamIdx);
  addIdx(summary.lastMonStallIdx);
  for (const idx of summary.firstBriefIdx.values()) addIdx(idx);
  for (const idx of summary.lastTeamMsgIdx.values()) addIdx(idx);
  pinActiveWakeups(all, summary, snap.members, addIdx);
  pinNarratorRefs(all, summary, snap, addIdx);
  return [...pinnedIdx].sort((a, b) => a - b).map((idx) => {
    const msg = all[idx];
    return idx === summary.lastMonStallIdx || msg.text.length <= PINNED_TEXT_CAP
      ? msg : { ...msg, text: msg.text.slice(0, PINNED_TEXT_CAP) };
  });
}

// Builds the opt-in `?tail=<N>` fields when `snap.messages.length > tailCount`,
// keeping the newest `tailCount` posts plus compact pinned summary posts so
// Overview, Members, Hive, filters, channels, and Board match a full load.
export function buildTailFields(snap, tailCount) {
  const all = snap.messages;
  const summary = snap._summary;
  const startOffset = all.length - tailCount;
  if (!summary || tailCount <= 0 || startOffset <= 0) return null;
  const tail = all.slice(startOffset);
  const pinnedMessages = buildPinnedMessages(snap, startOffset);
  const knownPosters = new Set(snap.members.map((m) => m.name));
  for (const m of tail) if (m.agent) knownPosters.add(m.agent);
  const extraPosters = [...summary.posters].filter((name) => !knownPosters.has(name));

  return {
    messages: tail,
    messagesOffset: startOffset,
    totalMessages: all.length,
    nonControlCount: summary.nonControlCount,
    ...(summary.firstPostTs !== null ? { firstPostTs: summary.firstPostTs } : {}),
    ...(pinnedMessages.length ? { pinnedMessages } : {}),
    ...(extraPosters.length ? { extraPosters } : {}),
    ...(snap.channels?.length ? { channelCounts: Object.fromEntries(summary.channelCounts) } : {}),
  };
}

// Slices an older `[start, before)` message range for `GET /api/swarm/messages`,
// failing closed with `{ stale: true }` if `rosterKey` or `beforeSeq` mismatches.
export function sliceEarlierMessages(board, query) {
  const rosterKey = board.rosterToken;
  const before = parsePositiveInt(query.before);
  const beforeSeq = parsePositiveInt(query.beforeSeq);
  const limit = parsePositiveInt(query.limit);
  const fromSeq = parsePositiveInt(query.fromSeq);
  const all = board.messages;
  if (!query.rosterKey || query.rosterKey !== rosterKey ||
      before <= 0 || before >= all.length || all[before]?.seq !== beforeSeq) {
    return { stale: true, rosterKey };
  }
  let start = 0;
  if (fromSeq > 0) {
    const idx = findSeqIndex(all, board.summary, fromSeq);
    if (idx < 0 || idx >= before) return { notFound: true, rosterKey };
    const step = limit > 0 ? limit : 200;
    start = Math.max(0, before - Math.ceil((before - idx) / step) * step);
  } else if (limit > 0) {
    start = Math.max(0, before - limit);
  }
  return { rosterKey, offset: start, before, totalMessages: all.length, messages: all.slice(start, before) };
}

// Derived board state (processed messages, @mention edges, per-member post
// stats, channel registry, posted screenshot frames, and tail-load summary),
// cached across polls where only member transcripts or read cursors changed,
// and updated incrementally on single-channel message appends.
const derivedBoardCache = new Map(); // cacheId -> entry
export function computeDerivedBoard(cacheId, boardKey, boardEpoch, roster, names, msgs, remote, helpers) {
  const { roleOf, isRoleWorker, boardTimeMs, channelAddressees, appendPostedFrames, maxPostedFrames } = helpers;
  const rosterKey = names.map((n) => {
    const m = roster.members[n];
    return `${n}\x1f${roleOf(n, m)}\x1f${isRoleWorker(n, m) ? 1 : 0}\x1f${Array.isArray(m.channels) ? JSON.stringify(m.channels) : ''}`;
  }).join('\x1e');
  const fullKey = `${boardKey}\0${boardEpoch}\0${rosterKey}`;
  const prev = derivedBoardCache.get(cacheId);
  if (prev && prev.fullKey === fullKey && prev.messages.length === msgs.length) {
    return touchCache(derivedBoardCache, cacheId, prev);
  }

  // Incremental append fast-path for single-channel boards with unchanged roster.
  const sameShape = prev && prev.boardEpoch === boardEpoch && prev.rosterKey === rosterKey;
  const tail = sameShape && !prev.channels.length && !remote?.channels?.length && msgs.length > prev.messages.length
    ? msgs.slice(prev.messages.length) : null;
  let channels, posts, edges, messages, frameMap, summary;
  if (tail?.every((m) => channelOf(m) === MAIN && !controlOf(m) && !String(m.text ?? '').includes('@#'))) {
    channels = prev.channels;
    posts = new Map(prev.posts);
    edges = new Map();
    for (const [k, e] of prev.edges) edges.set(k, { ...e });
    messages = prev.messages.concat(processMessageSlice(roster, names, msgs, prev.messages.length, null, posts, edges, { isRoleWorker, boardTimeMs }));
    frameMap = new Map(prev.frameMap);
    appendPostedFrames?.(frameMap, roster, tail);
    summary = updateTailSummary(cloneTailSummary(prev.summary), messages, prev.messages.length, roster, { roleOf, isRoleWorker });
  } else {
    posts = new Map();
    edges = new Map(); // "from\0to" -> edge
    // Channels exist only once a member created one; until then every new
    // field below is left out, so a one-channel swarm's snapshot is unchanged.
    channels = remote?.channels || channelRegistry(msgs);
    // "@#channel" calls on the members whose set as of the message holds the
    // channel (or "*"), while it is active then (channels.mjs mentionsIn).
    const byChannel = channelAddressees(roster, names, msgs, channels);
    messages = processMessageSlice(roster, names, msgs, 0, byChannel, posts, edges, { isRoleWorker, boardTimeMs });
    frameMap = new Map();
    appendPostedFrames?.(frameMap, roster, msgs);
    const leadName = names.find((n) => roleOf(n, roster.members[n]) === 'coordinator') || 'coordinator';
    summary = updateTailSummary(createTailSummary(leadName), messages, 0, roster, { roleOf, isRoleWorker });
  }
  // Compact opaque token binding boardEpoch and exact roster shape.
  const rosterToken = sameShape ? prev.rosterToken : `${boardEpoch}:${createHash('sha256').update(rosterKey).digest('hex').slice(0, 32)}`;
  const entry = {
    fullKey, boardEpoch, rosterKey, rosterToken,
    channels, messages, posts, edges, edgeList: [...edges.values()],
    frameMap, posted: appendPostedFrames ? [...frameMap.values()].slice(-maxPostedFrames) : [],
    summary,
  };
  return putCache(derivedBoardCache, cacheId, entry, 64);
}
