/**
 * Music Quiz Game — Client-Side Application
 * A multiplayer music quiz game using Socket.IO for real-time communication.
 *
 * Screens are toggled by adding/removing the `.active` class on `.screen` elements.
 * The host creates a room, uploads songs, and controls game flow.
 * Players join via room code, listen to audio clips, and submit guesses.
 */

document.addEventListener('DOMContentLoaded', () => {
  // ─── State ──────────────────────────────────────────────────────────────────
  let socket = null;
  let isHost = false;
  let roomCode = '';
  let playerName = '';
  let songs = [];           // Host's song list: [{id, title, fileName, url, originalName}]
  let currentRound = 0;
  let totalRounds = 0;
  let timerInterval = null;
  let timeRemaining = 0;
  let hasAnswered = false;
  let playerAudio = null;   // Reference to the active <audio> element
  let previewAudioEl = null; // Temporary audio for song previews
  let hostAudio = null;
  let playerAudioEl = null;

  // ─── Utility Functions ──────────────────────────────────────────────────────

  /**
   * Escape HTML special characters to prevent XSS when injecting user content.
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Generate a short, unique-ish identifier for song entries.
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  /**
   * Format a duration in milliseconds into a human-readable string.
   */
  function formatTime(ms) {
    if (ms == null) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  // ─── YouTube & Unified Audio Integration ────────────────────────────────

  let ytPlayer = null;
  let ytReady = false;
  let currentPlayingUrl = null;

  /**
   * Di chuyển phần tử Unified Music Card vào đúng vị trí của màn hình hiện tại
   */
  function mountUnifiedPlayer(mountId) {
    const playerCard = document.getElementById('unified-music-card');
    const targetMount = document.getElementById(mountId);
    if (playerCard && targetMount && playerCard.parentElement !== targetMount) {
      targetMount.appendChild(playerCard);
    }
  }

  /**
   * Trích xuất YouTube ID từ mọi định dạng link (chuẩn, rút gọn, shorts, live, id trần)
   */
  function extractYouTubeId(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    let url = urlStr.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host === 'youtu.be' || host.endsWith('.youtu.be')) {
        const id = u.pathname.replace(/^\//, '').split('/')[0].split('?')[0];
        if (id && id.length === 11) return id;
      }
      if (host.includes('youtube.com')) {
        if (u.searchParams.has('v')) {
          const v = u.searchParams.get('v');
          if (v && v.length >= 11) return v.substring(0, 11);
        }
        const match = u.pathname.match(/\/(?:embed|shorts|live|v)\/([a-zA-Z0-9_-]{11})/);
        if (match) return match[1];
      }
    } catch (e) {}

    const fallbackMatch = url.match(/(?:youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|live\/|watch\?v=|&v=)([a-zA-Z0-9_-]{11})/);
    return fallbackMatch ? fallbackMatch[1] : null;
  }

  function extractYouTubeStartTime(urlStr) {
    if (!urlStr) return 0;
    try {
      const u = new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr);
      const t = u.searchParams.get('t') || u.searchParams.get('start');
      if (t) return parseInt(t, 10) || 0;
    } catch (e) {}
    const m = urlStr.match(/[?&](?:t|start)=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * Bật tiếng và phát âm thanh tối đa (Khắc phục chính sách Autoplay của trình duyệt)
   */
  function forceUnmuteAudio() {
    // 1. Unmute qua đối tượng YT.Player nếu có
    if (ytPlayer) {
      try {
        if (typeof ytPlayer.unMute === 'function') ytPlayer.unMute();
        if (typeof ytPlayer.setVolume === 'function') ytPlayer.setVolume(100);
        if (typeof ytPlayer.playVideo === 'function') ytPlayer.playVideo();
      } catch (e) {
        console.warn('ytPlayer unMute error:', e);
      }
    }

    // 2. Unmute và Play trực tiếp qua postMessage vào iframe
    const iframes = document.querySelectorAll('#yt-player-target iframe, iframe[src*="youtube.com"]');
    iframes.forEach(iframe => {
      if (iframe && iframe.contentWindow) {
        try {
          iframe.contentWindow.postMessage('{"event":"command","func":"unMute","args":""}', '*');
          iframe.contentWindow.postMessage('{"event":"command","func":"setVolume","args":[100]}', '*');
          iframe.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
        } catch (e) {}
      }
    });

    // 3. Audio HTML5
    if (hostAudio) { try { hostAudio.volume = 1.0; hostAudio.play(); } catch (e) {} }
    if (playerAudioEl) { try { playerAudioEl.volume = 1.0; playerAudioEl.play(); } catch (e) {} }

    const btn = document.getElementById('btn-mpc-unmute');
    if (btn) {
      btn.textContent = '🔊 Đã bật âm thanh';
      btn.classList.add('playing');
    }
  }
  window.forceUnmuteAudio = forceUnmuteAudio;

  /**
   * Xử lý lỗi từ YouTube API
   */
  function handleYTError(code) {
    let msg = `Lỗi phát video YouTube (Mã lỗi ${code}).`;
    if (code === 101 || code === 150) {
      msg = '⚠️ Video này bị chủ sở hữu chặn phát nhúng trên web khác (Error 150). Hãy dùng video YouTube khác hoặc nạp bài hát mẫu!';
      const shield = document.getElementById('mpc-shield');
      if (shield) shield.classList.add('revealed');
    } else if (code === 100 || code === 2) {
      msg = '⚠️ Không tìm thấy video YouTube hoặc link không hợp lệ!';
    }
    showToast(msg, 'error', 6000);
  }

  /**
   * Phát video YouTube bằng Iframe chuẩn kết hợp API
   */
  function playYouTubeById(ytId, startSec = 0) {
    const target = document.getElementById('yt-player-target');
    if (!target) return;

    const origin = encodeURIComponent(window.location.origin);

    // Tạo iframe sạch sẽ có tham số autoplay và enablejsapi
    target.innerHTML = `
      <iframe
        id="yt-embed-player"
        width="100%"
        height="190"
        src="https://www.youtube.com/embed/${ytId}?autoplay=1&start=${startSec}&enablejsapi=1&origin=${origin}&playsinline=1&rel=0"
        title="YouTube Music Quiz"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen>
      </iframe>
    `;

    // Nếu YouTube API đã tải, bọc đối tượng YT.Player để quản lý trạng thái
    if (window.YT && window.YT.Player) {
      try {
        ytPlayer = new YT.Player('yt-embed-player', {
          events: {
            onReady: (e) => {
              ytReady = true;
              try {
                e.target.unMute();
                e.target.setVolume(100);
                e.target.playVideo();
              } catch (err) {}
            },
            onError: (e) => {
              handleYTError(e.data);
            },
            onStateChange: (e) => {
              if (e.data === 1) { // Đang phát
                const btn = document.getElementById('btn-mpc-unmute');
                if (btn) btn.classList.add('playing');
              }
            }
          }
        });
      } catch (err) {
        console.warn('Lỗi bọc YT.Player:', err);
      }
    }

    // Tự động thử kích hoạt unMute sau khi iframe load
    setTimeout(() => {
      forceUnmuteAudio();
    }, 700);
  }

  /**
   * Phát nhạc thống nhất (hỗ trợ cả YouTube và file Audio)
   */
  function playTrackAudio(url, mode = 'game') {
    currentPlayingUrl = url;

    const playerCard = document.getElementById('unified-music-card');
    const ytWrapper = document.getElementById('mpc-yt-wrapper');
    const shield = document.getElementById('mpc-shield');
    const unmuteBtn = document.getElementById('btn-mpc-unmute');
    const statusText = document.getElementById('mpc-status-text');
    const statusSub = document.getElementById('mpc-status-sub');
    const stopPrevBtn = document.getElementById('btn-stop-preview');

    if (playerCard) playerCard.style.display = 'block';
    if (shield) shield.classList.remove('revealed');
    if (stopPrevBtn) stopPrevBtn.style.display = (mode === 'preview') ? 'inline-flex' : 'none';

    if (unmuteBtn) {
      unmuteBtn.style.display = 'inline-flex';
      unmuteBtn.textContent = '🔊 Bật tiếng / Nghe ngay';
      unmuteBtn.classList.remove('playing');
    }

    if (mode === 'preview') {
      if (statusText) statusText.textContent = '🎧 Đang nghe thử nhạc...';
      if (statusSub) statusSub.textContent = 'Bấm "Dừng nghe thử" hoặc bắt đầu chơi';
    } else {
      if (statusText) statusText.textContent = '🎵 Đang phát nhạc...';
      if (statusSub) statusSub.textContent = 'Lắng nghe kỹ để đoán tên bài hát';
    }

    if (window.syncU007 && typeof window.syncU007.setPlay === 'function') {
      window.syncU007.setPlay(true);
    }

    const ytId = extractYouTubeId(url);
    if (ytId) {
      // ── Phát YouTube ──
      if (ytWrapper) ytWrapper.style.display = 'block';

      // Dừng audio HTML5
      if (hostAudio) stopAudio(hostAudio);
      if (playerAudioEl) stopAudio(playerAudioEl);

      const startSeconds = extractYouTubeStartTime(url) || 0;
      playYouTubeById(ytId, startSeconds);

    } else {
      // ── Phát file Audio thông thường ──
      if (ytWrapper) ytWrapper.style.display = 'none';
      stopYouTube();

      const activeAudio = isHost ? hostAudio : playerAudioEl;
      if (activeAudio && url) {
        activeAudio.src = url;
        activeAudio.volume = 1.0;
        safePlay(activeAudio);
      }
    }
  }

  function stopYouTube() {
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      try { ytPlayer.stopVideo(); } catch (e) {}
    }
    const target = document.getElementById('yt-player-target');
    if (target) {
      target.innerHTML = '';
    }
    ytPlayer = null;
    ytReady = false;
  }

  function stopAllGameAudio() {
    if (hostAudio) stopAudio(hostAudio);
    if (playerAudioEl) stopAudio(playerAudioEl);
    if (previewAudioEl) previewAudioEl.pause();
    stopYouTube();
    currentPlayingUrl = null;

    if (window.syncU007 && typeof window.syncU007.setPlay === 'function') {
      window.syncU007.setPlay(false);
    }

    const playerCard = document.getElementById('unified-music-card');
    if (playerCard) playerCard.style.display = 'none';
  }

  /**
   * Nghe thử bài hát trong sảnh chờ
   */
  function previewSong(url) {
    if (currentPlayingUrl === url) {
      stopAllGameAudio();
      showToast('Đã dừng nghe thử', 'info');
      return;
    }
    stopAllGameAudio();

    // Gắn widget phát nhạc vào khu vực sảnh chờ
    mountUnifiedPlayer('mount-lobby-player');
    playTrackAudio(url, 'preview');
    showToast('Đang phát nghe thử 🎵', 'info');
  }
  window.previewSong = previewSong;

  /**
   * Xóa bài hát khỏi danh sách của host
   */
  function removeSong(id) {
    songs = songs.filter(s => s.id !== id);
    renderSongList();
    if (socket) {
      socket.emit('update-songs', { songs });
    }
  }
  window.removeSong = removeSong;

  // ─── Toast Notifications ───────────────────────────────────────────────────

  /**
   * Show a transient toast message.
   * @param {string} message  Text to display.
   * @param {'info'|'success'|'error'|'warning'} type  Visual style.
   * @param {number} duration  How long (ms) before auto-dismiss.
   */
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ─── Loading Overlay ──────────────────────────────────────────────────────

  let loadingTimeout = null;

  function showLoading(msg = 'Đang xử lý...') {
    const el = document.getElementById('loading-overlay');
    if (el) {
      const p = el.querySelector('p');
      if (p) p.textContent = msg;
      el.hidden = false;
      el.style.display = 'flex';
    }
    if (loadingTimeout) clearTimeout(loadingTimeout);
    loadingTimeout = setTimeout(() => {
      hideLoading();
    }, 6000);
  }

  function hideLoading() {
    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
      loadingTimeout = null;
    }
    const el = document.getElementById('loading-overlay');
    if (el) {
      el.hidden = true;
      el.style.display = 'none';
    }
  }

  // ─── Screen Navigation ────────────────────────────────────────────────────

  /**
   * Switch the visible screen by id. Clears running timers when navigating
   * away from game screens.
   */
  function showScreen(screenId) {
    // Only clear running timer if navigating AWAY from active game screens
    if (screenId !== 'screen-game-host' && screenId !== 'screen-game-player') {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    document.querySelectorAll('.screen').forEach(screen => {
      screen.classList.remove('active');
    });

    const target = document.getElementById(screenId);
    if (target) {
      target.classList.add('active');
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────────────

  /**
   * Start a countdown timer that updates every second.
   * Adds warning/danger classes when time is running low.
   */
  function startTimer(duration) {
    timeRemaining = duration;
    updateTimerDisplay();
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      timeRemaining--;
      updateTimerDisplay();
      if (timeRemaining <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const displays = document.querySelectorAll('.timer-display');
    displays.forEach(d => {
      d.textContent = timeRemaining;
      d.classList.toggle('warning', timeRemaining <= 10 && timeRemaining > 5);
      d.classList.toggle('danger', timeRemaining <= 5);
    });
    if (window.syncU007 && typeof window.syncU007.setTime === 'function') {
      const dur = (typeof roundDuration !== 'undefined' && roundDuration) ? roundDuration : 30;
      const elapsed = Math.max(0, dur - timeRemaining);
      window.syncU007.setTime(elapsed, dur);
    }
  }

  // ─── Audio Visualizer ─────────────────────────────────────────────────────

  /**
   * Populate the visualizer container with animated bars.
   */
  function createVisualizerBars() {
    const visualizer = document.getElementById('audio-visualizer');
    if (!visualizer) return;
    visualizer.innerHTML = '';
    for (let i = 0; i < 20; i++) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.animationDelay = `${Math.random() * 0.5}s`;
      bar.style.animationDuration = `${0.3 + Math.random() * 0.5}s`;
      visualizer.appendChild(bar);
    }
  }

  /**
   * Sửa lỗi phông chữ tiếng Việt / mojibake (vd: "Biáº¿t" -> "Biết")
   */
  function fixMojibake(str) {
    if (!str) return '';
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 255) return str;
    }
    try {
      const fixed = decodeURIComponent(escape(str));
      if (fixed !== str && !fixed.includes('\uFFFD')) return fixed;
    } catch (e) {}
    return str;
  }

  // ─── Song List Rendering (Host) ───────────────────────────────────────────

  /**
   * Render the host's song list in the lobby. Each song shows its number,
   * title, an optional preview button, and a delete button.
   */
  function renderSongList() {
    const list = document.getElementById('song-list');
    if (!list) return;

    list.innerHTML = songs.map((song, i) => {
      const isYt = !!extractYouTubeId(song.url);
      const cleanTitle = fixMojibake(song.title);
      return `
        <div class="song-item" data-id="${song.id}">
          <span class="song-number">${i + 1}</span>
          <div class="song-info">
            <span class="song-title">${escapeHtml(cleanTitle)}</span>
            <span class="song-badge ${isYt ? 'badge-yt' : 'badge-file'}">
              ${isYt ? '🎥 YouTube' : '🎵 File'}
            </span>
          </div>
          <div class="song-actions">
            ${song.url ? `<button class="btn-icon" onclick="previewSong('${escapeHtml(song.url)}')" title="Nghe thử">▶️</button>` : ''}
            <button class="btn-icon" onclick="removeSong('${song.id}')" title="Xóa">🗑️</button>
          </div>
        </div>
      `;
    }).join('');

    updateStartButton();
  }

  // ─── Player List Rendering ────────────────────────────────────────────────

  /**
   * Update both host and player lobby player lists.
   */
  function renderPlayerLists(players) {
    const hostList = document.getElementById('host-player-list');
    const lobbyList = document.getElementById('lobby-player-list');
    const countEl = document.getElementById('player-count');

    const html = players.map(p =>
      `<span class="player-tag">${escapeHtml(p.name)}</span>`
    ).join('');

    if (hostList) hostList.innerHTML = html;
    if (lobbyList) lobbyList.innerHTML = html;
    if (countEl) countEl.textContent = players.length;

    updateStartButton(players);
  }

  /**
   * Enable the start button only when there are songs AND at least one player.
   */
  function updateStartButton(players) {
    const btn = document.getElementById('btn-start-game');
    if (!btn) return;

    // Grab current player count from UI if not provided
    const playerCount = players
      ? players.length
      : (document.getElementById('host-player-list')?.children.length || 0);

    btn.disabled = !(songs.length > 0 && playerCount > 0);
  }

  // ─── Safe Audio Playback ──────────────────────────────────────────────────

  /**
   * Attempt to play an audio element, catching autoplay restrictions.
   */
  function safePlay(audioEl) {
    if (!audioEl) return;
    const playPromise = audioEl.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        showToast('Nhấn vào màn hình để bật âm thanh 🔊', 'warning', 4000);
        // Set up a one-time click handler to resume playback
        const resumeAudio = () => {
          audioEl.play().catch(() => {});
          document.removeEventListener('click', resumeAudio);
        };
        document.addEventListener('click', resumeAudio);
      });
    }
  }

  /**
   * Stop and reset an audio element.
   */
  function stopAudio(audioEl) {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.currentTime = 0;
    audioEl.removeAttribute('src');
  }

  // ─── File Upload Helper ───────────────────────────────────────────────────

  /**
   * Upload a single audio file to the server, returning the response payload.
   */
  async function uploadFile(file) {
    const formData = new FormData();
    formData.append('audio', file);

    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      throw new Error(`Upload failed: ${res.statusText}`);
    }
    return res.json(); // { fileName, originalName, url }
  }

  /**
   * Process one or more files: upload each, add to song list, notify server.
   */
  async function handleFiles(files) {
    if (!files || files.length === 0) return;
    showLoading();

    for (const file of files) {
      try {
        const data = await uploadFile(file);
        // Ưu tiên tên file gốc từ trình duyệt (chuẩn UTF-8) và khắc phục lỗi mojibake
        const rawName = (file && file.name) ? file.name : (data.originalName || '');
        const cleanName = fixMojibake(rawName);
        const title = cleanName.replace(/\.[^/.]+$/, '').trim();
        songs.push({
          id: generateId(),
          title,
          fileName: data.fileName,
          url: data.url,
          originalName: cleanName,
        });
      } catch (err) {
        showToast(`Lỗi tải lên "${file.name}": ${err.message}`, 'error');
      }
    }

    hideLoading();
    renderSongList();
    socket.emit('update-songs', { songs });
  }

  // ─── QR Code Fetching ─────────────────────────────────────────────────────

  /**
   * Fetch and display the QR code for the given room code.
   */
  async function fetchQRCode(code) {
    try {
      const res = await fetch(`/api/qrcode/${encodeURIComponent(code)}`);
      if (!res.ok) throw new Error('QR fetch failed');
      const data = await res.json();
      const qrImg = document.getElementById('qr-code-img');
      if (qrImg) {
        qrImg.src = data.qrCode;
        qrImg.alt = `QR code for room ${code}`;
      }
      const qrUrl = document.getElementById('qr-join-url');
      if (qrUrl && data.url) {
        qrUrl.textContent = `🔗 Hoặc mở: ${data.url}`;
      }
    } catch (err) {
      console.error('Failed to fetch QR code:', err);
    }
  }

  // ─── Round Results Rendering ──────────────────────────────────────────────

  /**
   * Populate the round results screen with individual answers and the leaderboard.
   */
  function renderRoundResults(data) {
    // Correct answer
    const correctEl = document.getElementById('results-correct-answer');
    if (correctEl) correctEl.textContent = `🎵 Đáp án: ${data.correctAnswer || ''}`;

    // Round indicator
    const roundInfo = document.getElementById('results-round-title') || document.getElementById('results-round-info');
    if (roundInfo) roundInfo.textContent = `Kết quả câu ${data.round} / ${data.totalRounds}`;

    // Results table body
    const tbody = document.getElementById('results-body') || document.getElementById('results-table-body');
    if (tbody) {
      tbody.innerHTML = data.results.map((r, i) => {
        let badgeHtml = '';
        let rowClass = '';

        if (!r.answered) {
          badgeHtml = '<span class="badge badge-no-answer">Không trả lời</span>';
        } else if (r.isFirst && r.correct) {
          badgeHtml = '<span class="badge badge-first">🥇 Nhanh nhất!</span>';
          rowClass = 'correct';
        } else if (r.correct) {
          badgeHtml = '<span class="badge badge-correct">Đúng</span>';
          rowClass = 'correct';
        } else {
          badgeHtml = '<span class="badge badge-wrong">Sai</span>';
          rowClass = 'wrong';
        }

        const answerText = r.answered ? escapeHtml(r.answer) : 'Không trả lời';
        const timeText = r.answered ? formatTime(r.time) : '-';

        return `
          <tr class="${rowClass}">
            <td>${i + 1}</td>
            <td>${escapeHtml(r.name || r.playerName || 'Người chơi')}</td>
            <td>${answerText}</td>
            <td>${badgeHtml}</td>
            <td>${timeText}</td>
            <td>${r.score || 0}</td>
          </tr>
        `;
      }).join('');
    }

    // Leaderboard sidebar
    const lbList = document.getElementById('leaderboard-list') || document.getElementById('results-leaderboard');
    if (lbList) {
      lbList.innerHTML = data.leaderboard.map(p =>
        `<li><span class="lb-name">${escapeHtml(p.name)}</span><span class="lb-score">${p.score} điểm</span></li>`
      ).join('');
    }

    // Show continue button only for host
    const btnContinue = document.getElementById('btn-continue');
    if (btnContinue) {
      btnContinue.style.display = isHost ? '' : 'none';
    }
    const waitingText = document.querySelector('.waiting-text');
    if (waitingText) {
      waitingText.style.display = isHost ? 'none' : '';
    }
  }

  // ─── Game Over Rendering ──────────────────────────────────────────────────

  /**
   * Build the podium (top 3) and full leaderboard for the game-over screen.
   */
  function renderGameOver(data) {
    const { leaderboard, totalRounds: rounds } = data;

    // ── Podium ──
    const podium = document.getElementById('podium-container') || document.getElementById('podium');
    if (podium) {
      const medals = ['🥇', '🥈', '🥉'];
      const podiumClasses = ['second', 'first', 'third'];
      const podiumOrder = [1, 0, 2]; // display order: 2nd, 1st, 3rd

      let html = '';
      podiumOrder.forEach((rank, displayIndex) => {
        if (rank < leaderboard.length) {
          const p = leaderboard[rank];
          const accuracy = p.totalAnswers > 0
            ? ((p.correctAnswers / p.totalAnswers) * 100).toFixed(0)
            : 0;
          const posClass = podiumClasses[displayIndex];
          html += `
            <div class="podium-player ${posClass}">
              <div class="medal">${medals[rank]}</div>
              <div class="podium-name">${escapeHtml(p.name)}</div>
              <div class="podium-score">${p.score} điểm</div>
              <div class="podium-accuracy" style="font-size:0.85rem;color:var(--text-secondary,#a0a0cc)">${accuracy}% đúng</div>
            </div>
          `;
        }
      });
      podium.innerHTML = html;
    }

    // ── Full Leaderboard Table ──
    const tableTbody = document.getElementById('final-leaderboard-body');
    if (tableTbody) {
      tableTbody.innerHTML = leaderboard.map((p, i) => {
        const accuracy = p.totalAnswers > 0
          ? ((p.correctAnswers / p.totalAnswers) * 100).toFixed(0)
          : 0;
        return `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(p.name)}</td>
            <td>${p.score}</td>
            <td>${p.correctAnswers} / ${p.totalAnswers}</td>
            <td>${accuracy}%</td>
            <td>${formatTime(p.fastestTime)}</td>
          </tr>
        `;
      }).join('');
    }

    // Round count display
    const roundsEl = document.getElementById('total-rounds-played');
    if (roundsEl) roundsEl.textContent = rounds || totalRounds;
  }

  // ─── Host Answer Tracker ──────────────────────────────────────────────────

  /**
   * Render the list of players and their answer status during a round (host view).
   */
  function renderAnswerStatus(players, answeredSet) {
    const list = document.getElementById('answer-status-list');
    if (!list) return;

    list.innerHTML = players.map(p => {
      const answered = answeredSet && answeredSet.has(p.id);
      return `
        <div class="answer-status-item ${answered ? 'answered' : 'waiting'}">
          <span>${escapeHtml(p.name)}</span>
          <span>${answered ? '✅' : '⏳'}</span>
        </div>
      `;
    }).join('');
  }

  // ─── Application Initialisation ───────────────────────────────────────────

  function initApp() {
    hideLoading();

    // Connect to the Socket.IO server
    socket = io();

    // Cache audio element references
    hostAudio = document.getElementById('host-audio');
    playerAudioEl = document.getElementById('player-audio');

    // Track players and answered set for host answer status rendering
    let currentPlayers = [];
    let answeredPlayers = new Set();

    // ── URL Parameter: auto-join ──
    const urlParams = new URLSearchParams(window.location.search);
    const joinCode = urlParams.get('join') || urlParams.get('room');
    if (joinCode) {
      const codeInput = document.getElementById('input-room-code');
      if (codeInput) codeInput.value = joinCode.toUpperCase();
      showScreen('screen-player-join');
    }

    // ════════════════════════════════════════════════════════════════════════
    //  BUTTON EVENT LISTENERS
    // ════════════════════════════════════════════════════════════════════════

    // ── Home Screen ──

    const btnCreateRoom = document.getElementById('btn-create-room');
    if (btnCreateRoom) {
      btnCreateRoom.addEventListener('click', () => {
        showLoading();
        socket.emit('create-room', (response) => {
          hideLoading();
          if (response && response.success) {
            isHost = true;
            roomCode = response.roomCode;

            // Display room code in the lobby
            const codeDisplay = document.getElementById('room-code-display');
            if (codeDisplay) codeDisplay.textContent = roomCode;

            // Fetch and prepare QR code
            fetchQRCode(roomCode);

            showScreen('screen-host-lobby');
          } else {
            showToast('Không thể tạo phòng. Thử lại!', 'error');
          }
        });
      });
    }

    const btnJoinRoom = document.getElementById('btn-join-room');
    if (btnJoinRoom) {
      btnJoinRoom.addEventListener('click', () => {
        showScreen('screen-player-join');
      });
    }

    // ── Host Lobby ──

    const btnCopyCode = document.getElementById('btn-copy-code');
    if (btnCopyCode) {
      btnCopyCode.addEventListener('click', () => {
        if (navigator.clipboard && roomCode) {
          navigator.clipboard.writeText(roomCode).then(() => {
            showToast('Đã copy mã phòng!', 'success');
          }).catch(() => {
            showToast('Không thể copy. Hãy copy thủ công.', 'error');
          });
        }
      });
    }

    const btnToggleQr = document.getElementById('btn-toggle-qr');
    if (btnToggleQr) {
      btnToggleQr.addEventListener('click', () => {
        const qrImg = document.getElementById('qr-code-img');
        const qrUrl = document.getElementById('qr-join-url');
        if (qrImg) {
          const isVisible = qrImg.classList.toggle('visible');
          btnToggleQr.textContent = isVisible ? '📱 Ẩn QR' : '📱 Hiện QR';
          if (qrUrl) qrUrl.style.display = isVisible ? 'block' : 'none';
        }
      });
    }

    // ── File Upload (drag & drop + click) ──

    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');

    if (uploadArea && fileInput) {
      // Click to open file picker
      uploadArea.addEventListener('click', () => fileInput.click());

      // Drag events
      uploadArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
      });
      uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
      });
      uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
      });
      uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        const files = e.dataTransfer.files;
        handleFiles(files);
      });

      // File input change
      fileInput.addEventListener('change', () => {
        handleFiles(fileInput.files);
        fileInput.value = ''; // Reset so the same file can be re-selected
      });
    }

    // ── Manual Song Entry & YouTube Auto-fetch ──

    const btnAddManual = document.getElementById('btn-add-manual');
    if (btnAddManual) {
      btnAddManual.addEventListener('click', async () => {
        const titleInput = document.getElementById('manual-song-title') || document.getElementById('input-song-title');
        const urlInput = document.getElementById('manual-song-url') || document.getElementById('input-song-url');
        let title = titleInput ? titleInput.value.trim() : '';
        let url = urlInput ? urlInput.value.trim() : '';

        // Tự động hoán đổi nếu người dùng dán nhầm link vào ô Tên bài hát
        if (!url && extractYouTubeId(title)) {
          url = title;
          title = '';
          if (urlInput) urlInput.value = url;
          if (titleInput) titleInput.value = '';
        }

        if (!title && !url) {
          showToast('Vui lòng nhập tên bài hát hoặc dán link YouTube.', 'warning');
          return;
        }

        // Nếu có link YouTube mà chưa có tên bài hát, tự động lấy tiêu đề từ YouTube
        if (!title && extractYouTubeId(url)) {
          showLoading('Đang nhận diện bài hát từ YouTube...');
          try {
            const res = await fetch(`/api/youtube-info?url=${encodeURIComponent(url)}`);
            const ytData = await res.json();
            if (ytData.success && ytData.title) {
              title = ytData.title;
              showToast(`Đã nhận diện: ${title}`, 'success');
            }
          } catch (e) {
            console.warn('Lỗi lấy tên từ YouTube:', e);
          } finally {
            hideLoading();
          }
        }

        if (!title) {
          showToast('Vui lòng nhập tên bài hát (đáp án đúng).', 'warning');
          return;
        }

        songs.push({
          id: generateId(),
          title,
          fileName: '',
          url: url || '',
          originalName: title,
        });

        if (titleInput) titleInput.value = '';
        if (urlInput) urlInput.value = '';

        renderSongList();
        socket.emit('update-songs', { songs });
        showToast(`Đã thêm bài hát: "${title}"`, 'success');
      });

      // Tự động nhận diện khi người dùng dán link YouTube vào ô URL
      const urlInputEl = document.getElementById('manual-song-url') || document.getElementById('input-song-url');
      if (urlInputEl) {
        urlInputEl.addEventListener('change', async () => {
          const uVal = urlInputEl.value.trim();
          const titleInput = document.getElementById('manual-song-title') || document.getElementById('input-song-title');
          if (uVal && extractYouTubeId(uVal) && (!titleInput || !titleInput.value.trim())) {
            showLoading('Đang nhận diện bài hát từ YouTube...');
            try {
              const res = await fetch(`/api/youtube-info?url=${encodeURIComponent(uVal)}`);
              const ytData = await res.json();
              if (ytData.success && ytData.title && titleInput) {
                titleInput.value = ytData.title;
                showToast(`Đã tự điền tên bài: ${ytData.title}`, 'success');
              }
            } catch (e) {
            } finally {
              hideLoading();
            }
          }
        });
      }
    }

    // ── Add Demo Songs ──

    const btnAddDemo = document.getElementById('btn-add-demo-songs');
    if (btnAddDemo) {
      btnAddDemo.addEventListener('click', () => {
        const demoSongs = [
          {
            id: generateId(),
            title: 'Golden Hour',
            fileName: 'Golden Hour.mp3',
            url: encodeURI('/samples/Golden Hour.mp3'),
            originalName: 'Golden Hour.mp3',
          },
          {
            id: generateId(),
            title: 'Nhẹ Buông',
            fileName: 'Nhẹ Buông.mp3',
            url: encodeURI('/samples/Nhẹ Buông.mp3'),
            originalName: 'Nhẹ Buông.mp3',
          },
          {
            id: generateId(),
            title: 'Chờ Chút',
            fileName: 'chờ chút.mp3',
            url: encodeURI('/samples/chờ chút.mp3'),
            originalName: 'chờ chút.mp3',
          },
        ];

        // Append demo songs avoiding duplicates by title
        demoSongs.forEach(demo => {
          if (!songs.some(s => s.title.toLowerCase() === demo.title.toLowerCase())) {
            songs.push(demo);
          }
        });

        renderSongList();
        socket.emit('update-songs', { songs });
        showToast('Đã thêm 3 bài hát mẫu!', 'success');
      });
    }

    // ── Start Game Button ──

    const btnStartGame = document.getElementById('btn-start-game');
    if (btnStartGame) {
      btnStartGame.addEventListener('click', () => {
        // Kích hoạt quyền phát âm thanh trực tiếp từ click người dùng
        forceUnmuteAudio();

        const durationSelect = document.getElementById('round-duration');
        const duration = durationSelect ? parseInt(durationSelect.value, 10) : 30;

        showLoading();
        socket.emit('start-game', { duration }, (response) => {
          hideLoading();
          if (response && response.success) {
            showScreen('screen-game-host');
            // Auto-trigger first round
            socket.emit('next-round', (roundResp) => {
              if (roundResp && roundResp.gameOver) {
                showScreen('screen-game-over');
              }
            });
          } else {
            showToast(response?.error || 'Không thể bắt đầu trò chơi.', 'error');
          }
        });
      });
    }

    // ── Back from Host Lobby ──

    const btnBackHost = document.getElementById('btn-back-host');
    if (btnBackHost) {
      btnBackHost.addEventListener('click', () => {
        if (confirm('Rời phòng?')) {
          socket.disconnect();
          window.location.reload();
        }
      });
    }

    // ── Player Join Screen ──

    const btnJoinSubmit = document.getElementById('btn-join-submit');
    if (btnJoinSubmit) {
      btnJoinSubmit.addEventListener('click', submitJoin);
    }

    // Auto-uppercase room code as the user types
    const inputRoomCode = document.getElementById('input-room-code');
    if (inputRoomCode) {
      inputRoomCode.addEventListener('input', () => {
        inputRoomCode.value = inputRoomCode.value.toUpperCase();
      });
    }

    // Allow Enter key on the name field to submit join
    const inputPlayerName = document.getElementById('input-player-name');
    if (inputPlayerName) {
      inputPlayerName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitJoin();
      });
    }

    function submitJoin() {
      const code = (document.getElementById('input-room-code')?.value || '').trim().toUpperCase();
      const name = (document.getElementById('input-player-name')?.value || '').trim();

      if (!code) {
        showToast('Vui lòng nhập mã phòng.', 'warning');
        return;
      }
      if (!name) {
        showToast('Vui lòng nhập tên của bạn.', 'warning');
        return;
      }

      showLoading();
      socket.emit('join-room', { roomCode: code, playerName: name }, (response) => {
        hideLoading();
        if (response && response.success) {
          playerName = response.playerName;
          roomCode = response.roomCode;
          isHost = false;

          // Show room code and name in player lobby
          const lobbyCodeEl = document.getElementById('player-room-code') || document.getElementById('lobby-room-code');
          if (lobbyCodeEl) lobbyCodeEl.textContent = roomCode;
          const playerNameEl = document.getElementById('player-name-display');
          if (playerNameEl) playerNameEl.textContent = playerName;

          showScreen('screen-player-lobby');
        } else {
          showToast(response?.error || 'Không thể tham gia phòng.', 'error');
        }
      });
    }

    const btnBackJoin = document.getElementById('btn-back-join');
    if (btnBackJoin) {
      btnBackJoin.addEventListener('click', () => showScreen('screen-home'));
    }

    // ── Host Game Screen Controls ──

    const btnNextRound = document.getElementById('btn-next-round');
    if (btnNextRound) {
      btnNextRound.addEventListener('click', () => {
        forceUnmuteAudio();
        socket.emit('next-round', (response) => {
          if (response && response.gameOver) {
            // Game over will be handled by the game-over event
          }
          // Otherwise the round-start event will fire and update the UI
        });
      });
    }

    const btnEndRound = document.getElementById('btn-end-round');
    if (btnEndRound) {
      btnEndRound.addEventListener('click', () => {
        btnEndRound.disabled = true;
        btnEndRound.textContent = '⏳ Đang kết thúc...';
        socket.emit('end-round');
        setTimeout(() => {
          btnEndRound.disabled = false;
          btnEndRound.textContent = '⏭️ Kết thúc lượt';
        }, 1500);
      });
    }

    // ── Unified Music Player Button Controls ──
    const btnMpcUnmute = document.getElementById('btn-mpc-unmute');
    if (btnMpcUnmute) {
      btnMpcUnmute.addEventListener('click', () => {
        forceUnmuteAudio();
        showToast('🔊 Đã bật âm thanh tối đa!', 'success', 2000);
      });
    }

    const btnToggleYtVideo = document.getElementById('btn-toggle-yt-video');
    if (btnToggleYtVideo) {
      btnToggleYtVideo.addEventListener('click', () => {
        const shield = document.getElementById('mpc-shield');
        if (shield) {
          const isRevealed = shield.classList.toggle('revealed');
          btnToggleYtVideo.textContent = isRevealed
            ? '🛡️ Che màn hình video lại'
            : '👁️ Hiện màn hình video (nếu chưa nghe tiếng)';
        }
      });
    }

    const btnStopPreview = document.getElementById('btn-stop-preview');
    if (btnStopPreview) {
      btnStopPreview.addEventListener('click', () => {
        stopAllGameAudio();
        showToast('Đã dừng nghe thử', 'info');
      });
    }

    // Nút bật tiếng YouTube cũ (hỗ trợ tương thích ngược)
    const btnYtUnmute = document.getElementById('btn-yt-unmute');
    if (btnYtUnmute) {
      btnYtUnmute.addEventListener('click', () => {
        forceUnmuteAudio();
      });
    }

    const btnEndGame = document.getElementById('btn-end-game');
    if (btnEndGame) {
      btnEndGame.addEventListener('click', () => {
        if (confirm('Kết thúc trò chơi?')) {
          // The server should handle the game-over flow
          showScreen('screen-game-over');
        }
      });
    }

    // ── Player Game Screen Controls ──

    const btnSubmitAnswer = document.getElementById('btn-submit-answer');
    const inputAnswer = document.getElementById('input-answer');

    if (btnSubmitAnswer) {
      btnSubmitAnswer.addEventListener('click', submitAnswer);
    }

    if (inputAnswer) {
      inputAnswer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitAnswer();
      });
    }

    function submitAnswer() {
      if (hasAnswered) return;

      const answer = (document.getElementById('input-answer')?.value || '').trim();
      if (!answer) {
        showToast('Nhập câu trả lời!', 'warning');
        return;
      }

      socket.emit('submit-answer', { answer }, (response) => {
        if (!response || !response.success) {
          showToast(response?.error || 'Lỗi gửi câu trả lời.', 'error');
          return;
        }

        hasAnswered = true;

        // Disable input and button
        const inp = document.getElementById('input-answer');
        const btn = document.getElementById('btn-submit-answer');
        if (inp) inp.disabled = true;
        if (btn) btn.disabled = true;

        // Show feedback
        const feedbackEl = document.getElementById('answer-feedback');
        if (feedbackEl) {
          if (response.isFirst && response.correct) {
            feedbackEl.textContent = '🥇 Nhanh nhất! Đúng rồi!';
            feedbackEl.className = 'feedback first';
          } else if (response.correct) {
            feedbackEl.textContent = '✅ Đúng rồi!';
            feedbackEl.className = 'feedback correct';
          } else {
            feedbackEl.textContent = '❌ Sai rồi!';
            feedbackEl.className = 'feedback wrong';
          }
          feedbackEl.hidden = false;
        }
      });
    }

    // ── Round Results Screen ──

    const btnContinue = document.getElementById('btn-continue');
    if (btnContinue) {
      btnContinue.addEventListener('click', () => {
        forceUnmuteAudio();
        socket.emit('next-round', (response) => {
          if (response && response.gameOver) {
            // game-over event will handle showing the final screen
          } else {
            showScreen(isHost ? 'screen-game-host' : 'screen-game-player');
          }
        });
      });
    }

    // ── Game Over Screen ──

    const btnGoHome = document.getElementById('btn-go-home');
    if (btnGoHome) {
      btnGoHome.addEventListener('click', () => {
        window.location.reload();
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SOCKET.IO EVENT HANDLERS
    // ════════════════════════════════════════════════════════════════════════

    // ── Player Joined / Left ──

    socket.on('player-joined', (data) => {
      currentPlayers = data.players || [];
      renderPlayerLists(currentPlayers);
    });

    socket.on('player-left', (data) => {
      currentPlayers = data.players || [];
      renderPlayerLists(currentPlayers);
    });

    // ── Game Started ──

    socket.on('game-started', (data) => {
      totalRounds = data.totalRounds || 0;
      currentRound = 0;
      hasAnswered = false;

      currentPlayers = data.players || [];

      if (!isHost) {
        showScreen('screen-game-player');
      }
    });

    // ── Round Start ──

    socket.on('round-start', (data) => {
      currentRound = data.round;
      totalRounds = data.totalRounds;
      hasAnswered = false;

      // Update round indicators everywhere
      const roundEls = [
        document.getElementById('round-indicator'),
        document.getElementById('player-round-indicator'),
        ...document.querySelectorAll('.round-indicator')
      ].filter(Boolean);
      roundEls.forEach(el => {
        el.textContent = `Câu ${currentRound} / ${totalRounds}`;
      });

      if (isHost) {
        // ── Host view ──
        showScreen('screen-game-host');
        mountUnifiedPlayer('mount-host-player');

        // Toggle round-control buttons
        const nextBtn = document.getElementById('btn-next-round');
        const endBtn = document.getElementById('btn-end-round');
        if (nextBtn) nextBtn.style.display = 'none';
        if (endBtn) {
          endBtn.style.display = '';
          endBtn.disabled = false;
          endBtn.textContent = '⏭️ Kết thúc lượt';
        }

        // Reset answer tracker
        answeredPlayers = new Set();
        renderAnswerStatus(currentPlayers, answeredPlayers);

        const trackerText = document.getElementById('answer-tracker') || document.getElementById('answer-tracker-text');
        if (trackerText) trackerText.textContent = `Đã trả lời: 0 / ${currentPlayers.length}`;

      } else {
        // ── Player view ──
        showScreen('screen-game-player');
        mountUnifiedPlayer('mount-player-player');

        // Reset answer input
        const inp = document.getElementById('input-answer');
        const btn = document.getElementById('btn-submit-answer');
        if (inp) { inp.value = ''; inp.disabled = false; }
        if (btn) btn.disabled = false;

        // Hide previous feedback
        const feedbackEl = document.getElementById('answer-feedback');
        if (feedbackEl) feedbackEl.hidden = true;

        // Show hint (character count without spaces)
        const hintEl = document.getElementById('hint-display') || document.getElementById('answer-hint');
        if (hintEl && data.hintLength != null) {
          const wordText = data.wordCount ? ` (${data.wordCount} từ)` : '';
          hintEl.textContent = `💡 Gợi ý: ${data.hintLength} chữ cái${wordText} (không tính dấu cách)`;
        }
      }

      // Khởi động đồng hồ đếm ngược SAU KHI đã hiển thị màn hình game
      startTimer(data.duration);

      // Phát nhạc (hỗ trợ cả link YouTube và file audio)
      try {
        playTrackAudio(data.audioUrl, 'game');
      } catch (audioErr) {
        console.warn('Lỗi phát âm thanh:', audioErr);
      }
    });

    // ── Player Answered (host only) ──

    socket.on('player-answered', (data) => {
      if (!isHost) return;

      answeredPlayers.add(data.playerId);
      renderAnswerStatus(currentPlayers, answeredPlayers);

      const trackerText = document.getElementById('answer-tracker') || document.getElementById('answer-tracker-text');
      if (trackerText) {
        trackerText.textContent = `Đã trả lời: ${data.totalAnswered} / ${data.totalPlayers}`;
      }
    });

    // ── Round End ──

    socket.on('round-end', (data) => {
      // Stop timer and audio
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      stopAllGameAudio();

      // Render results and show the results screen
      try {
        renderRoundResults(data);
      } catch (err) {
        console.error('Lỗi hiển thị kết quả vòng:', err);
      }

      showScreen('screen-round-results');
    });

    // ── Game Over ──

    socket.on('game-over', (data) => {
      // Stop any playing audio
      stopAllGameAudio();

      try {
        renderGameOver(data);
      } catch (err) {
        console.error('Lỗi hiển thị kết thúc game:', err);
      }

      showScreen('screen-game-over');
    });

    // ── Room Closed ──

    socket.on('room-closed', (data) => {
      stopAllGameAudio();
      showToast(data.reason || 'Phòng đã bị đóng.', 'warning', 2000);
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    });

    // ── Connection error handling ──

    socket.on('connect_error', () => {
      showToast('Mất kết nối tới server. Đang thử lại...', 'error');
    });

    socket.on('reconnect', () => {
      showToast('Đã kết nối lại!', 'success');
    });
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────
  initApp();
});
