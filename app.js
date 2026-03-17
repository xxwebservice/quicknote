// === QuickNote v2 — Discreet Meeting Recorder + Notes ===

(function () {
  'use strict';

  // --- State ---
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingStartTime = null;
  let timerInterval = null;
  let currentSession = null;
  let sessions = [];

  // --- DOM ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    statusDot: $('#status-dot'),
    timer: $('#timer'),
    menuBtn: $('#menu-btn'),
    menuDropdown: $('#menu-dropdown'),
    menuExport: $('#menu-export'),
    menuHistory: $('#menu-history'),
    startScreen: $('#start-screen'),
    notesScreen: $('#notes-screen'),
    reviewScreen: $('#review-screen'),
    historyScreen: $('#history-screen'),
    meetingTitle: $('#meeting-title'),
    startBtn: $('#start-btn'),
    sessionList: $('#session-list'),
    currentTitle: $('#current-title'),
    notesEntries: $('#notes-entries'),
    emptyHint: $('#empty-hint'),
    noteInput: $('#note-input'),
    sendBtn: $('#send-btn'),
    stopBtn: $('#stop-btn'),       // now in header
    reviewTitle: $('#review-title'),
    reviewDuration: $('#review-duration'),
    reviewCount: $('#review-count'),
    reviewNotes: $('#review-notes'),
    exportBtn: $('#export-btn'),
    newBtn: $('#new-btn'),
    backBtn: $('#back-btn'),
    historyList: $('#history-list'),
  };

  // --- Utility ---
  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function formatTimestamp(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  function sanitizeFilename(name) {
    return (name || 'meeting').replace(/[^\w\u4e00-\u9fff-]/g, '_').substring(0, 50);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(msg, duration = 2000) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  // --- Storage ---
  function loadSessions() {
    try {
      sessions = JSON.parse(localStorage.getItem('quicknote_sessions') || '[]');
    } catch { sessions = []; }
  }

  function saveSessions() {
    localStorage.setItem('quicknote_sessions', JSON.stringify(
      sessions.map(s => ({ id: s.id, title: s.title, startTime: s.startTime, duration: s.duration, notes: s.notes, hasAudio: s.hasAudio || false }))
    ));
  }

  function openAudioDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('quicknote_audio', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('audio', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveAudio(id, blob) {
    const db = await openAudioDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').put({ id, blob, type: blob.type });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAudio(id) {
    const db = await openAudioDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readonly');
      const req = tx.objectStore('audio').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteAudio(id) {
    const db = await openAudioDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readwrite');
      tx.objectStore('audio').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- Screens ---
  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $(`#${id}`).classList.add('active');
    dom.menuDropdown.classList.add('hidden');
  }

  // --- Session List ---
  function renderSessionList(container, showDelete) {
    container.innerHTML = '';
    const sorted = [...sessions].sort((a, b) => b.startTime - a.startTime);
    if (!sorted.length) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:14px;padding:16px 0;">暂无记录</p>';
      return;
    }
    sorted.forEach(s => {
      const card = document.createElement('div');
      card.className = 'session-card';
      card.innerHTML = `
        <div class="session-info">
          <span class="session-name">${escapeHtml(s.title || '未命名会议')}</span>
          <span class="session-meta">${formatDate(s.startTime)} · ${formatTime(s.duration)} · ${s.notes.length}条笔记</span>
        </div>
        <div class="session-actions">
          ${showDelete ? `<button class="delete-btn" data-id="${s.id}">✕</button>` : ''}
          <span class="session-arrow">›</span>
        </div>
      `;
      card.addEventListener('click', e => {
        if (e.target.classList.contains('delete-btn')) { e.stopPropagation(); deleteSession(s.id); return; }
        openReview(s);
      });
      container.appendChild(card);
    });
  }

  function deleteSession(id) {
    if (!confirm('确定删除此记录？')) return;
    sessions = sessions.filter(s => s.id !== id);
    saveSessions();
    deleteAudio(id).catch(() => {});
    renderSessionList(dom.sessionList, false);
    renderSessionList(dom.historyList, true);
  }

  // --- Recording ---
  async function startRecording() {
    const id = generateId();
    currentSession = {
      id,
      title: dom.meetingTitle.value.trim() || `会议 ${formatDate(Date.now())}`,
      startTime: Date.now(),
      duration: 0,
      notes: [],
      hasAudio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
      });

      // Prefer mp4/aac for widest compatibility (opens on iPhone/Windows/Android)
      let mimeType = '';
      for (const mt of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
        if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
      }

      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (audioChunks.length) {
          const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
          await saveAudio(currentSession.id, blob);
          currentSession.hasAudio = true;
        }
        finishRecording();
      };
      mediaRecorder.start(1000);
    } catch (err) {
      console.warn('Mic denied, notes-only mode:', err);
    }

    recordingStartTime = Date.now();
    timerInterval = setInterval(updateTimer, 1000);
    dom.statusDot.classList.remove('hidden');
    dom.timer.classList.remove('hidden');
    dom.stopBtn.classList.remove('hidden');
    dom.currentTitle.textContent = currentSession.title;
    dom.notesEntries.innerHTML = '';
    dom.notesEntries.appendChild(dom.emptyHint);
    dom.emptyHint.classList.remove('hidden');
    dom.noteInput.value = '';
    dom.sendBtn.disabled = true;
    showScreen('notes-screen');
    setTimeout(() => dom.noteInput.focus(), 300);
    requestWakeLock();
  }

  function updateTimer() {
    if (!recordingStartTime) return;
    dom.timer.textContent = formatTime(Date.now() - recordingStartTime);
  }

  function stopRecording() {
    clearInterval(timerInterval);
    timerInterval = null;
    if (currentSession) currentSession.duration = Date.now() - recordingStartTime;
    dom.statusDot.classList.add('hidden');
    dom.timer.classList.add('hidden');
    dom.stopBtn.classList.add('hidden');
    releaseWakeLock();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    } else {
      finishRecording();
    }
  }

  function finishRecording() {
    sessions.push(currentSession);
    saveSessions();
    openReview(currentSession);
    mediaRecorder = null;
    audioChunks = [];
    recordingStartTime = null;
    renderSessionList(dom.sessionList, false);
  }

  // --- Notes ---
  function addNote(text) {
    if (!text.trim() || !currentSession) return;
    const note = { timestamp: Date.now() - recordingStartTime, text: text.trim(), createdAt: Date.now() };
    currentSession.notes.push(note);
    dom.emptyHint.classList.add('hidden');
    renderNoteEntry(note);
    dom.noteInput.value = '';
    dom.sendBtn.disabled = true;
    autoResize();
    dom.notesEntries.scrollTop = dom.notesEntries.scrollHeight;
  }

  function renderNoteEntry(note, prepend = false) {
    const entry = document.createElement('div');
    entry.className = 'note-entry';
    entry.dataset.noteId = note.timestamp;
    entry.innerHTML = `
      <span class="note-timestamp">${formatTimestamp(note.timestamp)}</span>
      <span class="note-text">${escapeHtml(note.text)}</span>
    `;
    // Swipe-to-delete
    setupSwipeDelete(entry, note);
    if (prepend) {
      dom.notesEntries.insertBefore(entry, dom.notesEntries.firstChild);
    } else {
      dom.notesEntries.appendChild(entry);
    }
  }

  function setupSwipeDelete(entry, note) {
    let startX = 0, currentX = 0, swiping = false;
    const threshold = 80;

    entry.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      swiping = true;
    }, { passive: true });

    entry.addEventListener('touchmove', e => {
      if (!swiping) return;
      currentX = e.touches[0].clientX - startX;
      if (currentX < 0) {
        entry.classList.add('swiping');
        entry.style.transform = `translateX(${Math.max(currentX, -120)}px)`;
        entry.style.opacity = Math.max(0.3, 1 + currentX / 120);
      }
    }, { passive: true });

    entry.addEventListener('touchend', () => {
      swiping = false;
      if (currentX < -threshold) {
        entry.classList.add('deleting');
        setTimeout(() => {
          entry.remove();
          if (currentSession) {
            currentSession.notes = currentSession.notes.filter(n => n.timestamp !== note.timestamp);
            if (currentSession.notes.length === 0) {
              dom.emptyHint.classList.remove('hidden');
            }
          }
        }, 200);
      } else {
        entry.classList.remove('swiping');
        entry.style.transform = '';
        entry.style.opacity = '';
      }
      currentX = 0;
    });
  }

  // --- Review ---
  function openReview(session) {
    dom.reviewTitle.textContent = session.title || '未命名会议';
    dom.reviewDuration.textContent = `时长 ${formatTime(session.duration)}`;
    dom.reviewCount.textContent = `${session.notes.length} 条笔记`;
    dom.reviewNotes.innerHTML = '';
    if (!session.notes.length) {
      dom.reviewNotes.innerHTML = '<p style="color:var(--text-muted);font-size:14px;padding:16px 0;">没有笔记</p>';
    }
    session.notes.forEach(n => {
      const entry = document.createElement('div');
      entry.className = 'review-note-entry';
      entry.innerHTML = `
        <span class="review-timestamp">${formatTimestamp(n.timestamp)}</span>
        <span class="review-text">${escapeHtml(n.text)}</span>
      `;
      dom.reviewNotes.appendChild(entry);
    });
    currentSession = session;
    showScreen('review-screen');
  }

  // --- ZIP Export ---
  // Minimal ZIP writer (no compression, store only) — no external deps needed
  function buildZip(files) {
    // files = [{ name, data: Uint8Array }]
    const enc = new TextEncoder();
    const parts = [];
    const centralDir = [];
    let offset = 0;

    function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
    function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }

    function crc32(data) {
      let crc = 0xFFFFFFFF;
      const table = crc32.table || (crc32.table = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
          t[i] = c;
        }
        return t;
      })());
      for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    for (const file of files) {
      const nameBytes = enc.encode(file.name);
      const crc = crc32(file.data);
      const localHeader = concat([
        new Uint8Array([0x50,0x4B,0x03,0x04]), // sig
        u16(20),       // version
        u16(0),        // flags
        u16(0),        // compression (store)
        u16(0), u16(0),// mod time, date
        u32(crc),
        u32(file.data.length),
        u32(file.data.length),
        u16(nameBytes.length),
        u16(0),        // extra len
        nameBytes,
      ]);
      centralDir.push({ nameBytes, crc, size: file.data.length, offset });
      offset += localHeader.length + file.data.length;
      parts.push(localHeader, file.data);
    }

    const cdStart = offset;
    for (let i = 0; i < files.length; i++) {
      const { nameBytes, crc, size, offset: fileOffset } = centralDir[i];
      parts.push(concat([
        new Uint8Array([0x50,0x4B,0x01,0x02]),
        u16(20), u16(20),
        u16(0), u16(0),
        u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0),
        u32(0),
        u32(fileOffset),
        nameBytes,
      ]));
    }
    const cdEnd = offset + parts.slice(files.length).reduce((a, b) => a + b.length, 0);
    const cdSize = cdEnd - cdStart;
    parts.push(concat([
      new Uint8Array([0x50,0x4B,0x05,0x06]),
      u16(0), u16(0),
      u16(files.length), u16(files.length),
      u32(cdSize), u32(cdStart),
      u16(0),
    ]));
    return concat(parts);
  }

  function concat(arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) { out.set(a, pos); pos += a.length; }
    return out;
  }

  async function exportSession() {
    if (!currentSession) return;
    const session = currentSession;
    const prefix = sanitizeFilename(session.title);
    const enc = new TextEncoder();

    // 1. Markdown notes
    let md = `# ${session.title || '未命名会议'}\n\n`;
    md += `- 日期: ${new Date(session.startTime).toLocaleString('zh-CN')}\n`;
    md += `- 时长: ${formatTime(session.duration)}\n`;
    md += `- 笔记数: ${session.notes.length}\n\n`;
    md += `## 笔记（带时间戳）\n\n`;
    session.notes.forEach(n => { md += `**[${formatTimestamp(n.timestamp)}]** ${n.text}\n\n`; });

    // 2. Analysis JSON (instructions for Claude)
    const analysis = JSON.stringify({
      session: { title: session.title, date: new Date(session.startTime).toISOString(), duration: formatTime(session.duration) },
      notes: session.notes.map(n => ({ t: formatTimestamp(n.timestamp), text: n.text })),
      instructions: [
        '1. 将录音转为完整transcript',
        '2. 与笔记按时间戳对齐交叉对比',
        '3. 笔记是记录者认为的重点，transcript是完整上下文',
        '输出: 完整会议纪要 + 重点标注(笔记提到的部分高亮) + 笔记未记但重要的内容'
      ]
    }, null, 2);

    // 3. Build ZIP
    const files = [
      { name: `${prefix}_notes.md`, data: enc.encode(md) },
      { name: `${prefix}_for_claude.json`, data: enc.encode(analysis) },
    ];

    // 4. Add audio if available
    try {
      const audioData = await getAudio(session.id);
      if (audioData && audioData.blob) {
        const buf = await audioData.blob.arrayBuffer();
        const ext = audioData.type.includes('webm') ? 'webm' : audioData.type.includes('mp4') ? 'm4a' : 'ogg';
        files.push({ name: `${prefix}_recording.${ext}`, data: new Uint8Array(buf) });
      }
    } catch (e) { console.warn('No audio:', e); }

    const zip = buildZip(files);
    const blob = new Blob([zip], { type: 'application/zip' });
    downloadBlob(blob, `${prefix}_quicknote.zip`);
    showToast(`已导出 ${files.length} 个文件`);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Auto-resize textarea ---
  function autoResize() {
    const el = dom.noteInput;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  // --- Wake Lock ---
  let wakeLock = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release(); wakeLock = null; } }

  // --- Events ---
  function init() {
    loadSessions();
    renderSessionList(dom.sessionList, false);

    // Start
    dom.startBtn.addEventListener('click', startRecording);
    dom.meetingTitle.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); startRecording(); } });

    // Note input
    dom.noteInput.addEventListener('input', () => {
      autoResize();
      dom.sendBtn.disabled = !dom.noteInput.value.trim();
    });

    dom.noteInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(dom.noteInput.value); }
    });

    dom.sendBtn.addEventListener('click', () => addNote(dom.noteInput.value));

    // Stop — confirm before stopping
    dom.stopBtn.addEventListener('click', () => {
      if (currentSession && currentSession.notes.length === 0) {
        if (!confirm('还没有笔记，确定结束记录？')) return;
      }
      stopRecording();
    });

    // Export
    dom.exportBtn.addEventListener('click', exportSession);

    // New
    dom.newBtn.addEventListener('click', () => {
      currentSession = null;
      dom.meetingTitle.value = '';
      showScreen('start-screen');
      renderSessionList(dom.sessionList, false);
    });

    // Menu
    dom.menuBtn.addEventListener('click', e => { e.stopPropagation(); dom.menuDropdown.classList.toggle('hidden'); });
    document.addEventListener('click', () => dom.menuDropdown.classList.add('hidden'));
    dom.menuExport.addEventListener('click', () => { if (currentSession) exportSession(); });
    dom.menuHistory.addEventListener('click', () => { renderSessionList(dom.historyList, true); showScreen('history-screen'); });
    dom.backBtn.addEventListener('click', () => { showScreen('start-screen'); renderSessionList(dom.sessionList, false); });

    // Re-acquire wake lock on resume
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && mediaRecorder?.state === 'recording') requestWakeLock();
    });
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  init();
})();
